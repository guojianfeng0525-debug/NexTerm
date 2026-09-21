//! Live network-topology probe tests against real Linux containers.
//!
//! Skipped unless `TOPOLOGY_PROBE_LIVE=1`. Two fixtures (built from
//! `e2e/fixtures/topology-probe/`) form a genuine service dependency:
//!
//! ```text
//!  host (this test) ── hold a TCP connection ──▶ web(debian):8080
//!  web(debian) socat: LISTEN :8080  ── initiate ──▶ db(alpine):6379
//!  db(alpine)  socat: LISTEN :6379  (holds every accept for 10 minutes)
//! ```
//!
//! The same socat process on `web` both listens on 8080 and dials db:6379 —
//! exactly the p1-attribution case (the fd map must resolve the connection
//! inode to the pid whose listener is 8080). `db` runs BusyBox (`find` has no
//! `-printf`) so its fdmap goes through the `ls -l` fallback.
//!
//! ```sh
//! docker build -t nexterm-probe-web:local e2e/fixtures/topology-probe/debian
//! docker build -t nexterm-probe-db:local  e2e/fixtures/topology-probe/alpine
//! TOPOLOGY_PROBE_LIVE=1 \
//!   cargo test --test topology_probe_live -- --ignored --nocapture
//! ```
//!
//! The suite asserts the v2.18.1 port contract end to end:
//! 1. every TCP port row is LISTEN — cross-checked against the kernel's own
//!    listen set via `ss -tln` (independent of the code under test);
//! 2. no ephemeral port leaks into any `ports` / `service_links` field (the
//!    held connection's real source port must never surface);
//! 3. web's outbound service edge is `web:8080 → db:6379` — both endpoints
//!    real listeners, p1 attributed through fd ownership;
//! 4. db's inbound service edge is `web → db:6379` with the peer's source
//!    port dropped (`remotePort: None`), attributed through the BusyBox
//!    `ls -l` fdmap fallback.

use std::time::Duration;

use nexterm_lib::network_probe::run_probe;
use nexterm_lib::os_detect::{detect_os, OsFamily};
use nexterm_lib::ssh::{AuthMethod, SshClient, SshConfig};

const IMAGE_WEB: &str = "nexterm-probe-web:local";
const IMAGE_DB: &str = "nexterm-probe-db:local";
const NET: &str = "nt-probe-net";
const PASS: &str = "probepass";

fn live_enabled() -> bool {
    std::env::var("TOPOLOGY_PROBE_LIVE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn image_exists(image: &str) -> bool {
    std::process::Command::new("docker")
        .args(["image", "inspect", image])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn sh(cmd: &str) -> String {
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .output()
        .expect("spawn sh");
    if !out.status.success() {
        panic!(
            "command failed: {cmd}\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct Fixture {
    ip: String,
    host_ssh_port: u16,
    /// Host-side port of the container's listening service (web only).
    host_service_port: u16,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = sh("docker rm -f nt-probe-web nt-probe-db >/dev/null 2>&1 || true");
    }
}

fn container_ip(name: &str) -> String {
    sh(&format!(
        "docker inspect -f '{{{{range .NetworkSettings.Networks}}}}{{{{.IPAddress}}}}{{{{end}}}}' {name}"
    ))
}

fn start_db() -> Fixture {
    sh(&format!(
        "docker rm -f nt-probe-db >/dev/null 2>&1 || true; \
         docker run -d --rm --name nt-probe-db --network {NET} \
           -p 127.0.0.1:19022:22 -p 127.0.0.1:19053:5353/udp {IMAGE_DB}"
    ));
    Fixture { ip: container_ip("nt-probe-db"), host_ssh_port: 19022, host_service_port: 0 }
}

fn start_web(db_ip: &str) -> Fixture {
    sh(&format!(
        "docker rm -f nt-probe-web >/dev/null 2>&1 || true; \
         docker run -d --rm --name nt-probe-web --network {NET} \
           -e DB_ADDR={db_ip} \
           -p 127.0.0.1:18022:22 -p 127.0.0.1:18080:8080 {IMAGE_WEB}"
    ));
    Fixture {
        ip: container_ip("nt-probe-web"),
        host_ssh_port: 18022,
        host_service_port: 18080,
    }
}

async fn wait_port(host: &str, port: u16) {
    for _ in 0..60 {
        if sh(&format!("nc -z -w1 {host} {port} && echo ok || true")).contains("ok") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("port {host}:{port} never became ready");
}

async fn connect_ssh(port: u16) -> (SshClient, nexterm_lib::os_detect::OsInfo) {
    let config = SshConfig {
        host: "127.0.0.1".into(),
        port,
        username: "root".into(),
        auth_method: AuthMethod::Password { password: PASS.into() },
        keepalive_interval: Some(15),
        keepalive_max: Some(3),
        proxy: None,
        jump: None,
        // Fixture host keys are regenerated per image build; the probe
        // pipeline is what's under test here, not host-key TOFU.
        host_key_fingerprint: None,
        host_key_verification: false,
    };
    let mut client = SshClient::new();
    client.connect(&config).await.expect("ssh connect to fixture");
    let os_info = detect_os(&client).await;
    (client, os_info)
}

/// The kernel's own listening TCP ports via `ss -tln` — ground truth that is
/// completely independent of the probe code under test.
async fn truth_listen_ports(client: &SshClient) -> Vec<u16> {
    let out = client
        .execute_command("ss -H -tln | awk '{print $4}' | awk -F: '{print $NF}' | sort -un")
        .await
        .expect("ss -tln");
    out.lines().filter_map(|l| l.trim().parse::<u16>().ok()).collect()
}

/// The ephemeral source port our held connection uses on the host side — the
/// exact value that must NEVER surface as a port in the probe output.
/// lsof NAME column: `127.0.0.1:<src>->127.0.0.1:<dst>` — cut at `->` first.
fn held_connection_source_port(host_port: u16) -> u16 {
    let out = sh(&format!(
        "lsof -nP -iTCP:{host_port} -sTCP:ESTABLISHED | awk 'NR>1 {{print $9}}' | sed 's/->.*//' | awk -F: '{{print $NF}}' | head -1"
    ));
    out.lines().next().and_then(|v| v.trim().parse::<u16>().ok()).unwrap_or(0)
}

#[tokio::test]
#[ignore]
async fn probe_reports_only_real_listening_ports_across_environments() {
    if !live_enabled() || !image_exists(IMAGE_WEB) || !image_exists(IMAGE_DB) {
        eprintln!("skipping: set TOPOLOGY_PROBE_LIVE=1 and build both fixture images (see module docs)");
        return;
    }
    let _ = sh(&format!("docker network rm {NET} >/dev/null 2>&1 || true"));
    sh(&format!("docker network create {NET}"));
    let _net_guard = NetGuard;

    let db = start_db();
    let web = start_web(&db.ip);
    let _fixtures = FixturesGuard;

    wait_port("127.0.0.1", db.host_ssh_port).await;
    wait_port("127.0.0.1", web.host_ssh_port).await;
    wait_port("127.0.0.1", web.host_service_port).await;

    // Hold ONE TCP connection straight through web:8080 → db:6379 so both
    // sides see ESTABLISHED traffic, for the whole test.
    let held = std::net::TcpStream::connect(("127.0.0.1", web.host_service_port))
        .expect("connect web:18080 (socat bridge)");
    // socat's dial to db happens on accept — give it a beat to establish.
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Fire one UDP packet at db:5353 so the kernel tables also hold UDP
    // client sockets whose LOCAL ports are ephemeral — they must never leak
    // into the reported ports.
    let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp.send_to(b"probe", ("127.0.0.1", 19053)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // ── probe web (Debian / GNU find -printf fdmap path) ──
    let (web_client, web_os) = connect_ssh(web.host_ssh_port).await;
    assert_eq!(web_os.family, OsFamily::Debian, "web fixture must classify as Debian");
    let web_probe = run_probe(&web_client, &web_os, false).await;
    assert!(web_probe.success, "web probe failed: {:?}", web_probe.error);

    // ── probe db (Alpine / BusyBox `ls -l` fdmap fallback) ──
    let (db_client, db_os) = connect_ssh(db.host_ssh_port).await;
    assert_eq!(db_os.family, OsFamily::Alpine, "db fixture must classify as Alpine");
    let db_probe = run_probe(&db_client, &db_os, false).await;
    assert!(db_probe.success, "db probe failed: {:?}", db_probe.error);

    // ═══ 1. every TCP port row is LISTEN and matches the kernel truth ═══
    for (client, probe, label, expected) in [
        (&web_client, &web_probe, "web", vec![22u16, 8080]),
        (&db_client, &db_probe, "db", vec![22u16, 6379]),
    ] {
        let truth = truth_listen_ports(client).await;
        for port in &probe.data.ports {
            if port.protocol == "tcp" {
                assert_eq!(
                    port.state, "LISTEN",
                    "{label}: tcp port row must be LISTEN, got {}:{}",
                    port.listen_addr, port.port
                );
                assert!(
                    truth.contains(&port.port),
                    "{label}: probe reported port {} which `ss -tln` does NOT list as listening — ephemeral leak",
                    port.port
                );
            }
        }
        let reported_tcp: Vec<u16> = probe
            .data
            .ports
            .iter()
            .filter(|p| p.protocol == "tcp")
            .map(|p| p.port)
            .collect();
        for want in &expected {
            assert!(
                reported_tcp.contains(want),
                "{label}: expected listener {want} missing from probe ports {reported_tcp:?} (truth {truth:?})"
            );
        }
    }

    // ═══ 2. no ephemeral port leaks into service links ═══
    let src = held_connection_source_port(web.host_service_port);
    if src > 0 {
        for probe in [&web_probe, &db_probe] {
            for link in &probe.data.service_links {
                assert_ne!(
                    link.remote_port, Some(src),
                    "peer ephemeral source port {src} leaked: {link:?}"
                );
                if let Some(p1) = link.local_port {
                    assert_ne!(p1, src, "ephemeral port {src} attributed as p1: {link:?}");
                }
            }
        }
    }

    // ═══ 3. web outbound edge web:8080 → db:6379 (p1 attributed) ═══
    let to_db = web_probe
        .data
        .service_links
        .iter()
        .find(|l| l.direction == "outbound" && l.remote_addr == db.ip && l.remote_port == Some(6379))
        .unwrap_or_else(|| {
            panic!(
                "web must report the db:6379 dependency (db ip {}), links: {:?}",
                db.ip, web_probe.data.service_links
            )
        });
    assert_eq!(
        to_db.local_port, Some(8080),
        "p1 must be socat's own listener 8080 via fd attribution — GNU find path, link: {to_db:?}"
    );
    assert_eq!(to_db.protocol, "tcp");
    assert!(to_db.connections >= 1);
    assert!(
        web_probe.data.peers.iter().any(|p| p.remote_addr == db.ip && p.remote_port == Some(6379)),
        "web peers must include {}:6379", db.ip
    );

    // ═══ 4. db inbound edge web → db:6379, peer source port dropped ═══
    let inbound: Vec<_> = db_probe
        .data
        .service_links
        .iter()
        .filter(|l| l.direction == "inbound" && l.remote_addr == web.ip)
        .collect();    assert!(
        !inbound.is_empty(),
        "db must report inbound edges from web ({}), links: {:?}",
        web.ip,
        db_probe.data.service_links
    );
    for link in &inbound {
        assert_eq!(
            link.remote_port, None,
            "inbound link must drop the peer's ephemeral source port: {link:?}"
        );
    }
    assert!(
        inbound.iter().any(|l| l.local_port == Some(6379)),
        "db must attribute the accept to its own listener 6379 — BusyBox ls-l fdmap path, links: {:?}",
        db_probe.data.service_links
    );

    // ═══ 5. UDP: real bind reported, ephemeral UDP clients never surface ═══
    // The only UDP service in the fixtures is db's socat on 5353; the packet
    // we fired created ephemeral UDP client sockets on the wire. Any UDP port
    // row other than 5353 (or a genuinely bound system service) is a leak.
    let udp_ports: Vec<u16> = db_probe
        .data
        .ports
        .iter()
        .filter(|p| p.protocol == "udp")
        .map(|p| p.port)
        .collect();
    assert!(
        udp_ports.iter().all(|p| *p == 5353),
        "db udp rows must be the bound service only (5353), got {udp_ports:?} — ephemeral UDP leak"
    );
    assert!(
        udp_ports.contains(&5353),
        "db must report the udp 5353 listener, udp rows: {udp_ports:?}"
    );

    // ═══ 6. both environments produced a usable /proc read ═══
    for (probe, label) in [(&web_probe, "web"), (&db_probe, "db")] {
        assert_ne!(
            probe.sections.proc_sockets.status, "unavailable",
            "{label}: /proc socket table must be readable"
        );
    }

    drop(held);
    drop(udp);
    drop(web_client);
    drop(db_client);
}

struct NetGuard;
impl Drop for NetGuard {
    fn drop(&mut self) {
        let _ = sh(&format!("docker network rm {NET} >/dev/null 2>&1 || true"));
    }
}

struct FixturesGuard;
impl Drop for FixturesGuard {
    fn drop(&mut self) {
        let _ = sh("docker rm -f nt-probe-web nt-probe-db >/dev/null 2>&1 || true");
    }
}
