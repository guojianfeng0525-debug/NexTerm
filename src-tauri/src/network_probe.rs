//! Network topology & network diagnostics probing (server side).
//!
//! ── 三个不可违反的约束 ──────────────────────────────────────────────────────
//! 1. **只读探测（READ-ONLY）** — 探测脚本只包含查询类命令。绝不允许出现
//!    `>` / `>>` 重定向写文件、包管理命令（apt/yum/apk/dnf）、`iptables -A/-F/-I`、
//!    `firewall-cmd --add-*`、`ufw enable/disable`、`systemctl start/stop`
//!    等任何变更操作。脚本内**不使用 `set -e`**，任何一段失败都不能中断其余段。
//! 2. **零安装（ZERO-INSTALL）** — 只使用系统自带工具（`ip` / `ifconfig` / `ss` /
//!    `netstat` / `iptables` / `nft` / `firewall-cmd` / `ufw` / `hostname` /
//!    `cat` / `grep` / `awk` …），不安装任何 Agent。工具缺失时对应分段标记
//!    `unavailable`，而不是判定为失败。
//! 3. **不保存凭据（NO CREDENTIALS）** — 本模块返回的所有结构均不含 password /
//!    private_key / passphrase / token 等任何认证字段；`raw_excerpt` 一律截断
//!    2000 字符。节点只按 `connectionId` 引用已保存连接。
//!
//! ── 性能约束 ────────────────────────────────────────────────────────────────
//! `ssh_execute_command` 底层的 `SshClient::execute_command` 持有连接读锁，且单条
//! 命令有 30 秒硬超时。因此**严禁**串行调用 N 次。所有分段被拼进一个 shell 脚本
//! 一次 exec，脚本内用 `###NT:<name>###` marker 分段，Rust 侧按 marker 切分后交给
//! 各解析纯函数。
//!
//! ── 范围约束 ────────────────────────────────────────────────────────────────
//! `peers` 段拿到的对端 IP 只用于**标记拓扑关系候选**，本模块从不主动连接它们。
//! 真正的对外 TCP 连通性测试是 `probe_tcp_ports` 的独立手工动作。

use crate::os_detect::OsInfo;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

// ═══════════════════════════════════════════════════════════════════════════
// Data model — field names / JSON keys mirror `src/lib/network/topology-types.ts`
// ═══════════════════════════════════════════════════════════════════════════

/// Outcome of a single probe section: `ok` / `partial` / `failed` / `unavailable`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSection {
    pub status: String,
    pub note: String,
}

impl ProbeSection {
    pub fn ok() -> Self {
        Self {
            status: "ok".to_string(),
            note: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSections {
    pub hostname: ProbeSection,
    pub os: ProbeSection,
    pub interfaces: ProbeSection,
    pub routes: ProbeSection,
    pub firewall: ProbeSection,
    pub rules: ProbeSection,
    pub ports: ProbeSection,
    pub peers: ProbeSection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedInterface {
    pub iface_name: String,
    pub mac: String,
    pub state: String,
    pub mtu: Option<u32>,
    pub is_loopback: bool,
    pub ipv4_addrs: Vec<String>,
    pub ipv6_addrs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedRoute {
    pub destination: String,
    pub gateway: String,
    pub genmask: String,
    pub flags: String,
    pub metric: Option<u32>,
    pub iface: String,
    /// `default` / `unicast` / `link` / `local` / `unknown`.
    /// Serialized as `routeType` (frontend `ROUTE_AUTO_KEYS` includes it).
    pub route_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedFirewall {
    /// `firewalld` / `ufw` / `iptables` / `nftables` / `pf` / `none` / `unknown`.
    pub fw_type: String,
    pub active: bool,
    pub default_in_policy: String,
    pub default_out_policy: String,
    pub version: String,
    pub zones: Vec<String>,
    /// Degradation note, e.g. "需要 root 权限" — surfaced in the UI, never silent.
    pub detect_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedFirewallRule {
    pub table_name: String,
    pub chain: String,
    pub action: String,
    pub protocol: String,
    pub src: String,
    pub dst: String,
    pub src_port: String,
    pub dst_port: String,
    pub in_iface: String,
    pub out_iface: String,
    pub raw_rule: String,
    /// Stable natural key: hash of the whitespace-normalized rule text.
    pub rule_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedPort {
    pub protocol: String,
    pub port: u16,
    pub listen_addr: String,
    pub state: String,
    pub process_name: String,
    pub pid: Option<u32>,
    pub process_user: String,
}

/// An ESTABLISHED connection observed on the probed server.
///
/// Peer addresses are used ONLY to correlate against already-probed nodes —
/// this module never connects to a peer on its own.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedPeer {
    pub remote_addr: String,
    pub remote_port: Option<u16>,
    pub local_port: Option<u16>,
    pub protocol: String,
    pub process_name: String,
    pub process_pid: Option<u32>,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeData {
    pub hostname: String,
    pub os_name: String,
    pub primary_ip: String,
    pub interfaces: Vec<DetectedInterface>,
    pub routes: Vec<DetectedRoute>,
    pub firewall: Option<DetectedFirewall>,
    pub firewall_rules: Vec<DetectedFirewallRule>,
    pub ports: Vec<DetectedPort>,
    pub peers: Vec<DetectedPeer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub success: bool,
    pub error: Option<String>,
    pub sections: ProbeSections,
    pub data: ProbeData,
    pub probed_at_ms: u64,
    /// Truncated (<= 2000 chars) raw excerpt, for troubleshooting only.
    pub raw_excerpt: Option<String>,
}

/// Pure TCP-layer verdict for one port. This says nothing about whether the
/// server reports the port as listening — the frontend cross-references
/// `net_ports` to reach the user-facing status (see design doc §5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpProbeResult {
    pub port: u16,
    pub status: String,
    pub tcp_ok: bool,
    pub latency_ms: Option<u64>,
    pub error_text: Option<String>,
}

// ═══════════════════════════════════════════════════════════════════════════
// Section splitting
// ═══════════════════════════════════════════════════════════════════════════

/// Every section the probe script emits, in emission order.
const SECTION_KEYS: [&str; 8] = [
    "hostname",
    "os",
    "interfaces",
    "routes",
    "firewall",
    "rules",
    "ports",
    "peers",
];

/// Recognise a `###NT:<name>###` marker line. `"end"` terminates the payload.
fn section_key(line: &str) -> Option<&'static str> {
    let name = line
        .trim()
        .strip_prefix("###NT:")?
        .trim()
        .strip_suffix("###")?;
    match name {
        "end" => Some("__end__"),
        other => SECTION_KEYS.iter().find(|k| **k == other).copied(),
    }
}

/// Split the marker-delimited payload into its sections.
///
/// Content before the first marker is discarded (it can only be shell noise).
/// Unknown markers are ignored so a partially mis-rendered script still yields
/// the sections we do recognise.
pub fn split_sections(raw: &str) -> HashMap<&'static str, String> {
    let mut out: HashMap<&'static str, String> = HashMap::new();
    let mut current: Option<&'static str> = None;
    let mut buf = String::new();

    for line in raw.lines() {
        if let Some(key) = section_key(line) {
            if let Some(prev) = current {
                out.insert(prev, buf.trim().to_string());
            }
            buf = String::new();
            current = if key == "__end__" { None } else { Some(key) };
            continue;
        }
        if current.is_some() {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if let Some(prev) = current {
        out.insert(prev, buf.trim().to_string());
    }
    out
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════

const RAW_EXCERPT_MAX_CHARS: usize = 2000;

fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((idx, _)) => format!("{}...(truncated)", &s[..idx]),
        None => s.to_string(),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A section that never came back at all (script died mid-way).
fn missing_section() -> ProbeSection {
    ProbeSection {
        status: "failed".to_string(),
        note: "未返回该分段数据".to_string(),
    }
}

/// Classify a section from the markers the script emitted.
///
/// `NT_ERROR:` / `NT_UNAVAILABLE:` are explicit signals; an empty body means
/// the command produced nothing; a permission / missing-tool message degrades
/// the section to `partial` so the UI can surface "需要 root 权限" instead of
/// silently swallowing the gap.
fn evaluate_section(raw: &str) -> ProbeSection {
    for line in raw.lines() {
        let t = line.trim();
        if let Some(reason) = t.strip_prefix("NT_ERROR:") {
            return ProbeSection {
                status: "failed".to_string(),
                note: reason.trim().to_string(),
            };
        }
        if let Some(reason) = t.strip_prefix("NT_UNAVAILABLE:") {
            return ProbeSection {
                status: "unavailable".to_string(),
                note: reason.trim().to_string(),
            };
        }
    }
    if raw.trim().is_empty() {
        return ProbeSection {
            status: "failed".to_string(),
            note: "无输出".to_string(),
        };
    }
    let lower = raw.to_lowercase();
    if lower.contains("permission denied") || lower.contains("operation not permitted") {
        return ProbeSection {
            status: "partial".to_string(),
            note: "需要 root 权限".to_string(),
        };
    }
    if lower.contains("command not found") || lower.contains("no such file or directory") {
        return ProbeSection {
            status: "unavailable".to_string(),
            note: "命令不可用".to_string(),
        };
    }
    ProbeSection::ok()
}

/// Downgrade `ok` → `failed` when a section produced no usable rows.
/// (`firewall` opts out: `fw_type: none` is a legitimate empty result.)
fn downgrade_empty(section: ProbeSection, empty: bool) -> ProbeSection {
    if empty && section.status == "ok" {
        ProbeSection {
            status: "failed".to_string(),
            note: "未解析到有效数据".to_string(),
        }
    } else {
        section
    }
}

/// `tcp6` / `tcp4` / `TCP` → `tcp`; anything else is lowercased as-is.
fn normalize_protocol(raw: &str) -> String {
    let p = raw.trim().to_lowercase();
    match p.as_str() {
        "tcp4" | "tcp6" | "tcp" => "tcp".to_string(),
        "udp4" | "udp6" | "udp" => "udp".to_string(),
        other => other.to_string(),
    }
}

/// Uppercase socket-state words emitted by `ss` / `netstat`.
fn is_state_word(token: &str) -> bool {
    matches!(
        token.to_uppercase().as_str(),
        "LISTEN"
            | "LISTENING"
            | "ESTABLISHED"
            | "ESTAB"
            | "UNCONN"
            | "CLOSED"
            | "CLOSE_WAIT"
            | "TIME_WAIT"
            | "SYN_SENT"
            | "SYN_RECV"
            | "FIN_WAIT1"
            | "FIN_WAIT2"
            | "LAST_ACK"
            | "CLOSING"
            | "UNKNOWN"
            | "IDLE"
            | "BOUND"
    )
}

/// Split `host:port` (Linux) or `host.port` (BSD/macOS netstat) into its parts.
///
/// Handles the shapes actually seen in the wild: `0.0.0.0:22`, `[::]:80`,
/// `:::80`, `*:80`, `*.22`, `127.0.0.1.5432`.
fn split_host_port(addr: &str) -> (String, Option<u16>) {
    let a = addr.trim();
    if a.is_empty() {
        return (String::new(), None);
    }
    if let Some((host, port)) = a.rsplit_once(':') {
        if let Ok(p) = port.trim().parse::<u16>() {
            let host = host.trim().trim_matches('[').trim_matches(']');
            return (host.to_string(), Some(p));
        }
    }
    // BSD/macOS `netstat` uses "." as the address/port separator.
    let segs: Vec<&str> = a.split('.').collect();
    if (segs.len() == 2 || segs.len() == 5)
        && segs
            .last()
            .map(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false)
    {
        if let Ok(p) = segs[segs.len() - 1].parse::<u16>() {
            return (segs[..segs.len() - 1].join("."), Some(p));
        }
    }
    (a.to_string(), None)
}

/// `ss` renders the process column as `users:(("sshd",pid=1234,fd=3))`.
/// Returns (process_name, pid, process_user). Without root the whole column is
/// absent — that degrades the section to `partial`, it is not a failure.
fn parse_ss_process(field: &str) -> (String, Option<u32>, String) {
    let mut name = String::new();
    if let Some(start) = field.find("((\"") {
        let rest = &field[start + 3..];
        if let Some(end) = rest.find('"') {
            name = rest[..end].to_string();
        }
    }
    let mut pid = None;
    if let Some(p) = field.find("pid=") {
        let digits: String = field[p + 4..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(n) = digits.parse::<u32>() {
            pid = Some(n);
        }
    }
    (name, pid, String::new())
}

/// `netstat` renders the process column as `1234/sshd`.
fn parse_netstat_process(field: &str) -> (String, Option<u32>, String) {
    match field.split_once('/') {
        Some((pid, name)) => (
            name.trim().to_string(),
            pid.trim().parse::<u32>().ok(),
            String::new(),
        ),
        None if field == "-" => (String::new(), None, String::new()),
        None => (String::new(), None, String::new()),
    }
}

/// Stable hash of the whitespace-normalized rule text. Two probe runs that
/// see the same rule (modulo spacing) must produce the same hash, because the
/// frontend uses it as the `net_firewall_rules` natural key.
fn rule_hash(raw: &str) -> String {
    let normalized: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut hasher = DefaultHasher::new();
    normalized.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn prefix_to_mask(prefix: u8) -> String {
    if prefix == 0 || prefix > 32 {
        return "0.0.0.0".to_string();
    }
    let m: u32 = u32::MAX << (32 - prefix);
    format!(
        "{}.{}.{}.{}",
        (m >> 24) & 0xff,
        (m >> 16) & 0xff,
        (m >> 8) & 0xff,
        m & 0xff
    )
}

fn mask_or_cidr_to_mask(value: &str) -> String {
    let v = value.trim();
    if let Some(p) = v.rsplit_once('/') {
        if let Ok(prefix) = p.1.parse::<u8>() {
            return prefix_to_mask(prefix);
        }
    }
    v.to_string()
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-section parsers
// ═══════════════════════════════════════════════════════════════════════════

/// `hostname` section — first non-marker, non-empty line wins.
pub fn parse_hostname(raw: &str) -> (String, ProbeSection) {
    let section = evaluate_section(raw);
    let mut hostname = String::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("NT_") {
            continue;
        }
        hostname = t.to_string();
        break;
    }
    (
        hostname.clone(),
        downgrade_empty(section, hostname.is_empty()),
    )
}

/// `os` section — `PRETTY_NAME=` / `ID=` from `/etc/os-release`, `sw_vers` on
/// macOS, plus the `uname -sr` kernel line.
pub fn parse_os_name(raw: &str) -> (String, ProbeSection) {
    let section = evaluate_section(raw);
    let mut id = String::new();
    let mut pretty = String::new();
    let mut product = String::new();
    let mut product_version = String::new();
    let mut kernel = String::new();

    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("NT_") {
            continue;
        }
        if let Some(v) = t.strip_prefix("PRETTY_NAME=") {
            pretty = v.trim_matches('"').trim().to_string();
        } else if let Some(v) = t.strip_prefix("ID=") {
            if id.is_empty() {
                id = v.trim_matches('"').trim().to_string();
            }
        } else if let Some(v) = t.strip_prefix("ProductName:") {
            product = v.trim().to_string();
        } else if let Some(v) = t.strip_prefix("ProductVersion:") {
            product_version = v.trim().to_string();
        } else if kernel.is_empty() && !t.contains('=') && !t.starts_with("BuildVersion:") {
            kernel = t.to_string();
        }
    }

    let mut os_name = if !pretty.is_empty() && pretty != "unknown" {
        pretty
    } else if !product.is_empty() {
        if product_version.is_empty() {
            product
        } else {
            format!("{} {}", product, product_version)
        }
    } else if !id.is_empty() && id != "unknown" {
        id
    } else {
        kernel.clone()
    };
    if !kernel.is_empty() && !os_name.contains(&kernel) {
        os_name = format!("{} ({})", os_name, kernel);
    }

    let os_name = os_name.trim().to_string();
    (
        os_name.clone(),
        downgrade_empty(section, os_name.is_empty()),
    )
}

/// `interfaces` section — supports both `ip -o addr` and `ifconfig -a`.
///
/// `ip -o addr` header lines look like:
/// `2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ... state UP ...`
/// `link/ether 52:54:00:12:34:56 brd ...`
/// and its address lines look like:
/// `2: eth0    inet 192.168.1.10/24 brd 192.168.1.255 scope global ...`
pub fn parse_interfaces(raw: &str) -> (Vec<DetectedInterface>, ProbeSection) {
    let section = evaluate_section(raw);
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, DetectedInterface> = HashMap::new();
    let mut format = "";

    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("NT_") {
            continue;
        }

        if let Some(name) = ip_o_addr_iface(t) {
            if format.is_empty() {
                format = "ip";
            }
            let entry = ensure_interface(&mut order, &mut map, &name);
            if t.contains("mtu ") || t.contains("link/") {
                apply_ip_header(entry, t);
            } else {
                apply_ip_addr(entry, t);
            }
            continue;
        }

        if format == "ip" {
            // Stray continuation under an `ip -o` block — nothing to do.
            continue;
        }

        if let Some(name) = ifconfig_iface(t) {
            if format.is_empty() {
                format = "ifconfig";
            }
            let entry = ensure_interface(&mut order, &mut map, &name);
            apply_ifconfig_header(entry, t);
            continue;
        }

        if let Some(name) = legacy_ifconfig_iface(t) {
            if format.is_empty() {
                format = "ifconfig";
            }
            let entry = ensure_interface(&mut order, &mut map, &name);
            entry.is_loopback = entry.is_loopback || t.contains("Loopback");
            continue;
        }

        if let Some(entry) = order.last().and_then(|n| map.get_mut(n)) {
            apply_ifconfig_detail(entry, t);
        }
    }

    let interfaces: Vec<DetectedInterface> = order
        .iter()
        .filter_map(|n| map.remove(n))
        .map(|mut i| {
            i.ipv4_addrs.sort();
            i.ipv4_addrs.dedup();
            i.ipv6_addrs.sort();
            i.ipv6_addrs.dedup();
            i
        })
        .collect();

    (
        interfaces.clone(),
        downgrade_empty(section, interfaces.is_empty()),
    )
}

fn ensure_interface<'a>(
    order: &mut Vec<String>,
    map: &'a mut HashMap<String, DetectedInterface>,
    name: &str,
) -> &'a mut DetectedInterface {
    if !map.contains_key(name) {
        order.push(name.to_string());
        map.insert(
            name.to_string(),
            DetectedInterface {
                iface_name: name.to_string(),
                mac: String::new(),
                state: "UNKNOWN".to_string(),
                mtu: None,
                is_loopback: name == "lo" || name.starts_with("lo"),
                ipv4_addrs: Vec::new(),
                ipv6_addrs: Vec::new(),
            },
        );
    }
    map.get_mut(name).expect("interface inserted above")
}

/// `ip -o addr` lines all start with `<idx>: <name>`; extract `<name>`.
fn ip_o_addr_iface(line: &str) -> Option<String> {
    let (idx, rest) = line.split_once(':')?;
    if idx.trim().is_empty() || !idx.trim().chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let name_token = rest.split_whitespace().next()?;
    if name_token.is_empty() {
        return None;
    }
    // Only plausible when the remainder looks like `ip -o` output.
    let name = name_token
        .trim_end_matches(':')
        .split('@')
        .next()
        .unwrap_or(name_token)
        .to_string();
    if name.is_empty() {
        return None;
    }
    Some(name)
}

/// `ifconfig -a` header lines: `eth0: flags=4163<UP,...>  mtu 1500`
fn ifconfig_iface(line: &str) -> Option<String> {
    let pos = line.find(": flags=")?;
    let name = line[..pos].trim().to_string();
    if name.is_empty() || name.contains(char::is_whitespace) {
        return None;
    }
    Some(name)
}

/// Legacy `ifconfig` header: `eth0      Link encap:Ethernet`
fn legacy_ifconfig_iface(line: &str) -> Option<String> {
    if !line.contains("Link encap:") {
        return None;
    }
    let name = line.split_whitespace().next()?.to_string();
    if name.is_empty() {
        return None;
    }
    Some(name)
}

fn apply_ip_header(entry: &mut DetectedInterface, line: &str) {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    for (i, tk) in tokens.iter().enumerate() {
        match *tk {
            "mtu" => {
                if let Some(v) = tokens.get(i + 1).and_then(|s| s.parse::<u32>().ok()) {
                    entry.mtu = Some(v);
                }
            }
            "state" => {
                if let Some(v) = tokens.get(i + 1) {
                    entry.state = v.to_uppercase();
                }
            }
            _ => {}
        }
    }
    if let Some(p) = line.find("link/ether ") {
        entry.mac = line[p + 11..]
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
    } else if let Some(p) = line.find("link/loopback ") {
        entry.is_loopback = true;
        entry.mac = line[p + 14..]
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
    }
    if line.contains("<LOOPBACK") {
        entry.is_loopback = true;
    }
    if entry.state == "UNKNOWN" {
        if line.contains("<UP") || line.contains(",UP,") || line.contains(",UP>") {
            entry.state = "UP".to_string();
        } else {
            entry.state = "DOWN".to_string();
        }
    }
}

fn apply_ip_addr(entry: &mut DetectedInterface, line: &str) {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    for (i, tk) in tokens.iter().enumerate() {
        if *tk == "inet" || *tk == "inet6" {
            if let Some(addr) = tokens.get(i + 1) {
                let addr = addr.trim();
                if addr.contains('.')
                    && *tk == "inet"
                    && !entry.ipv4_addrs.contains(&addr.to_string())
                {
                    entry.ipv4_addrs.push(addr.to_string());
                } else if addr.contains(':')
                    && *tk == "inet6"
                    && !entry.ipv6_addrs.contains(&addr.to_string())
                {
                    entry.ipv6_addrs.push(addr.to_string());
                }
            }
            return;
        }
    }
}

fn apply_ifconfig_header(entry: &mut DetectedInterface, line: &str) {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    for (i, tk) in tokens.iter().enumerate() {
        if *tk == "mtu" {
            if let Some(v) = tokens.get(i + 1).and_then(|s| s.parse::<u32>().ok()) {
                entry.mtu = Some(v);
            }
        }
    }
    let flags = line
        .split_once("flags=")
        .map(|(_, rest)| rest)
        .unwrap_or("");
    entry.is_loopback = entry.is_loopback || flags.contains("LOOPBACK");
    entry.state = if flags.contains("UP") {
        "UP".to_string()
    } else {
        "DOWN".to_string()
    };
}

fn apply_ifconfig_detail(entry: &mut DetectedInterface, line: &str) {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let Some(first) = tokens.first() else {
        return;
    };
    match *first {
        "inet" => {
            let addr = tokens.get(1).unwrap_or(&"").trim();
            if addr.is_empty() {
                return;
            }
            let value = if let Some(rest) = line.split_once("netmask") {
                // `inet 10.0.0.5  netmask 255.255.255.0  broadcast …`
                let mask = rest.1.split_whitespace().next().unwrap_or("");
                if mask.chars().all(|c| c.is_ascii_digit() || c == '.') && mask.contains('.') {
                    format!("{}/{}", addr, mask_to_prefix(mask))
                } else {
                    addr.to_string()
                }
            } else {
                addr.to_string()
            };
            if !entry.ipv4_addrs.contains(&value) {
                entry.ipv4_addrs.push(value);
            }
        }
        "inet6" => {
            let addr = tokens.get(1).unwrap_or(&"").trim();
            if addr.is_empty() {
                return;
            }
            let value = if let Some(rest) = line.split_once("prefixlen") {
                let len = rest.1.split_whitespace().next().unwrap_or("");
                if !len.is_empty() {
                    format!("{}/{}", addr, len)
                } else {
                    addr.to_string()
                }
            } else {
                addr.to_string()
            };
            if !entry.ipv6_addrs.contains(&value) {
                entry.ipv6_addrs.push(value);
            }
        }
        "ether" => {
            if let Some(v) = tokens.get(1) {
                entry.mac = v.trim().to_string();
            }
        }
        "loop" => entry.is_loopback = true,
        _ => {}
    }
}

fn mask_to_prefix(mask: &str) -> u8 {
    let mut prefix = 0u8;
    for seg in mask.split('.') {
        let octet: u8 = seg.parse::<u8>().unwrap_or(0);
        prefix += octet.count_ones() as u8;
    }
    prefix.min(32)
}

/// `routes` section — supports `ip route` and `netstat -rn` (Linux + BSD/macOS).
pub fn parse_routes(raw: &str) -> (Vec<DetectedRoute>, ProbeSection) {
    let section = evaluate_section(raw);
    let mut routes: Vec<DetectedRoute> = Vec::new();

    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("NT_") {
            continue;
        }
        let tokens: Vec<&str> = t.split_whitespace().collect();
        if tokens.is_empty() {
            continue;
        }
        // Skip `netstat` banners / headers.
        let head = tokens[0].to_lowercase();
        if matches!(
            head.as_str(),
            "kernel" | "destination" | "routing" | "internet:" | "internet6:" | "default"
        ) && !matches!(head.as_str(), "default")
        {
            continue;
        }
        if head == "default" && t.contains("flags=") {
            continue;
        }

        if let Some(route) = parse_ip_route_line(t) {
            routes.push(route);
            continue;
        }
        if let Some(route) = parse_netstat_route_line(&tokens) {
            routes.push(route);
        }
    }

    (routes.clone(), downgrade_empty(section, routes.is_empty()))
}

/// `ip route` line: `default via 192.168.1.1 dev eth0 proto dhcp src … metric 100`
fn parse_ip_route_line(line: &str) -> Option<DetectedRoute> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }
    let known = ["via", "dev", "proto", "scope", "src", "metric"];
    let looks_like_ip_route = tokens.iter().skip(1).any(|t| known.contains(t))
        || (tokens.len() == 1 && tokens[0].contains('/'));
    if !looks_like_ip_route {
        return None;
    }

    let destination = tokens[0].to_string();
    let mut gateway = String::new();
    let mut iface = String::new();
    let mut metric = None;
    let mut flags = String::new();
    let mut scope_link = false;

    let mut i = 1;
    while i < tokens.len() {
        match tokens[i] {
            "via" => {
                if let Some(v) = tokens.get(i + 1) {
                    gateway = v.to_string();
                }
                i += 2;
            }
            "dev" => {
                if let Some(v) = tokens.get(i + 1) {
                    iface = v.to_string();
                }
                i += 2;
            }
            "metric" => {
                if let Some(v) = tokens.get(i + 1).and_then(|s| s.parse::<u32>().ok()) {
                    metric = Some(v);
                }
                i += 2;
            }
            "scope" => {
                if tokens.get(i + 1) == Some(&"link") {
                    scope_link = true;
                }
                i += 2;
            }
            "proto" => {
                if let Some(v) = tokens.get(i + 1) {
                    flags = format!("proto {}", v);
                }
                i += 2;
            }
            _ => i += 1,
        }
    }

    let genmask = if destination == "default" {
        "0.0.0.0".to_string()
    } else {
        mask_or_cidr_to_mask(&destination)
    };
    let route_type = classify_route(&destination, &gateway, &genmask, scope_link);

    Some(DetectedRoute {
        destination,
        gateway,
        genmask,
        flags,
        metric,
        iface,
        route_type,
    })
}

/// `netstat -rn` line, Linux (`Destination Gateway Genmask Flags … Iface`) and
/// BSD/macOS (`Destination Gateway Flags Netif`) layouts.
fn parse_netstat_route_line(tokens: &[&str]) -> Option<DetectedRoute> {
    if tokens.len() < 4 {
        return None;
    }
    let dest = tokens[0];
    if !is_route_destination(dest) {
        return None;
    }

    // Linux layout: dest gateway genmask flags … iface
    if tokens.len() >= 8 && is_ipv4(tokens[1]) && is_ipv4(tokens[2]) && is_flag_word(tokens[3]) {
        let flags = tokens[3].to_string();
        let iface = tokens[tokens.len() - 1].to_string();
        let gateway = tokens[1].to_string();
        let genmask = tokens[2].to_string();
        let route_type = classify_route(dest, &gateway, &genmask, !flags.contains('G'));
        return Some(DetectedRoute {
            destination: dest.to_string(),
            gateway,
            genmask,
            flags,
            metric: None,
            iface,
            route_type,
        });
    }

    // BSD/macOS layout: dest gateway flags iface [expire]
    if tokens.len() >= 4 && is_flag_word(tokens[2]) {
        let gateway = tokens[1].to_string();
        let genmask = if dest == "default" {
            "0.0.0.0".to_string()
        } else if dest.contains('/') {
            mask_or_cidr_to_mask(dest)
        } else {
            "255.255.255.255".to_string()
        };
        let link_only = gateway.starts_with("link#") || gateway == "0.0.0.0";
        let route_type = classify_route(dest, &gateway, &genmask, link_only);
        return Some(DetectedRoute {
            destination: dest.to_string(),
            gateway,
            genmask,
            flags: tokens[2].to_string(),
            metric: None,
            iface: tokens[3].to_string(),
            route_type,
        });
    }

    None
}

fn is_route_destination(token: &str) -> bool {
    if token == "default" || token == "0.0.0.0" {
        return true;
    }
    if token.contains('/') {
        return true;
    }
    is_ipv4(token)
}

fn is_ipv4(token: &str) -> bool {
    let segs: Vec<&str> = token.split('.').collect();
    segs.len() == 4
        && segs
            .iter()
            .all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) && s.len() <= 3)
}

/// `netstat` routing flags always start with `U` (up). BSD/macOS mixes in
/// lowercase markers (`UGSc`, `UHLWIi`), so only require ASCII letters.
fn is_flag_word(token: &str) -> bool {
    !token.is_empty() && token.starts_with('U') && token.chars().all(|c| c.is_ascii_alphabetic())
}

fn classify_route(dest: &str, gateway: &str, genmask: &str, link_only: bool) -> String {
    if dest == "default" || dest == "0.0.0.0" {
        return "default".to_string();
    }
    if genmask == "255.255.255.255" {
        return "local".to_string();
    }
    if link_only || gateway.is_empty() || gateway == "0.0.0.0" {
        return "link".to_string();
    }
    "unicast".to_string()
}

/// `firewall` section — recognises firewalld / ufw / nftables / iptables / pf.
pub fn parse_firewall(raw: &str) -> (DetectedFirewall, ProbeSection) {
    let section = evaluate_section(raw);
    let mut fw = DetectedFirewall {
        fw_type: "unknown".to_string(),
        active: false,
        default_in_policy: String::new(),
        default_out_policy: String::new(),
        version: String::new(),
        zones: Vec::new(),
        detect_note: String::new(),
    };

    let mut in_zones = false;
    let mut in_policy = false;
    let mut raw_line = String::new();

    for line in raw.lines() {
        let t = line.trim_end();
        let tt = t.trim();
        if tt == "FW_ZONES_BEGIN" {
            in_zones = true;
            in_policy = false;
            continue;
        }
        if tt == "FW_ZONES_END" {
            in_zones = false;
            continue;
        }
        if tt == "FW_POLICY_BEGIN" {
            in_policy = true;
            continue;
        }
        if tt == "FW_POLICY_END" {
            in_policy = false;
            continue;
        }
        if in_zones {
            // `firewall-cmd --get-active-zones` 的 zone 名从第 0 列开始，
            // 成员行则会缩进。
            if !t.starts_with(' ')
                && !t.starts_with('\t')
                && !tt.is_empty()
                && !fw.zones.contains(&tt.to_string())
            {
                fw.zones.push(tt.to_string());
            }
            continue;
        }
        if in_policy {
            if let Some(rest) = tt.strip_prefix("-P ") {
                let mut parts = rest.split_whitespace();
                let chain = parts.next().unwrap_or("");
                let policy = parts.next().unwrap_or("").to_uppercase();
                match chain {
                    "INPUT" => fw.default_in_policy = policy,
                    "OUTPUT" => fw.default_out_policy = policy,
                    _ => {}
                }
            }
            continue;
        }
        if tt.is_empty() || tt.starts_with("NT_") {
            continue;
        }
        if let Some(v) = tt.strip_prefix("FW=") {
            fw.fw_type = v.trim().to_string();
        } else if let Some(v) = tt.strip_prefix("FW_STATE=") {
            fw.active = is_fw_active(v);
        } else if let Some(v) = tt.strip_prefix("FW_VERSION=") {
            fw.version = v.trim().to_string();
        } else if let Some(v) = tt.strip_prefix("FW_RAW=") {
            raw_line = v.trim().to_string();
        }
    }

    // Permission errors are a documented degradation, not a failure: keep the
    // section `partial` and tell the UI why (设计文档 §4.3).
    let lower = raw_line.to_lowercase();
    if lower.contains("permission denied") || lower.contains("operation not permitted") {
        fw.detect_note = "需要 root 权限".to_string();
    } else if lower.contains("command not found") {
        fw.detect_note = "命令不可用".to_string();
    }

    let mut section = section;
    if fw.fw_type == "unknown" && section.status == "ok" {
        section = ProbeSection {
            status: "failed".to_string(),
            note: "未识别到防火墙".to_string(),
        };
    } else if !fw.detect_note.is_empty() && section.status == "ok" {
        section = ProbeSection {
            status: "partial".to_string(),
            note: fw.detect_note.clone(),
        };
    }

    (fw, section)
}

fn is_fw_active(state: &str) -> bool {
    let s = state.trim().to_lowercase();
    if s.is_empty() {
        return false;
    }
    if s.contains("not running") || s.contains("inactive") || s.contains("disabled") {
        return false;
    }
    s.contains("running") || s.contains("active") || s.contains("enabled")
}

/// `rules` section — dispatches on the `##RULE_FMT:<backend>##` markers.
///
/// Supported backends: `firewall-cmd --list-all-zones`, `ufw status verbose`,
/// `nft list ruleset`, `iptables -S` (and `pfctl -sr` on BSD/macOS).
pub fn parse_firewall_rules(raw: &str) -> (Vec<DetectedFirewallRule>, ProbeSection) {
    let section = evaluate_section(raw);
    let mut rules: Vec<DetectedFirewallRule> = Vec::new();
    let mut fmt = "";
    let mut zone = String::from("default");
    let mut table = String::new();
    let mut chain = String::new();

    for line in raw.lines() {
        let t = line.trim_end();
        let tt = t.trim();
        if let Some(name) = tt
            .strip_prefix("##RULE_FMT:")
            .and_then(|s| s.strip_suffix("##"))
        {
            fmt = name;
            zone = "default".to_string();
            table = String::new();
            chain = String::new();
            continue;
        }
        if tt.is_empty() || tt.starts_with("NT_") {
            continue;
        }
        match fmt {
            "firewalld" => parse_firewalld_line(t, &mut zone, &mut rules),
            "ufw" => parse_ufw_line(tt, &mut rules),
            "nft" => parse_nft_line(tt, &mut table, &mut chain, &mut rules),
            "iptables" => parse_iptables_line(tt, &mut rules),
            "pf" => parse_pf_line(tt, &mut rules),
            _ => {}
        }
    }

    dedup_rules(&mut rules);
    (rules.clone(), downgrade_empty(section, rules.is_empty()))
}

fn dedup_rules(rules: &mut Vec<DetectedFirewallRule>) {
    let mut seen: Vec<String> = Vec::new();
    rules.retain(|r| {
        if seen.contains(&r.rule_hash) {
            false
        } else {
            seen.push(r.rule_hash.clone());
            true
        }
    });
}

fn push_rule(rules: &mut Vec<DetectedFirewallRule>, mut rule: DetectedFirewallRule) {
    rule.raw_rule = truncate_chars(&rule.raw_rule, 500);
    rule.rule_hash = rule_hash(&format!(
        "{}|{}|{}|{}",
        rule.table_name, rule.chain, rule.action, rule.raw_rule
    ));
    rules.push(rule);
}

fn empty_rule() -> DetectedFirewallRule {
    DetectedFirewallRule {
        table_name: String::new(),
        chain: String::new(),
        action: String::new(),
        protocol: String::new(),
        src: String::new(),
        dst: String::new(),
        src_port: String::new(),
        dst_port: String::new(),
        in_iface: String::new(),
        out_iface: String::new(),
        raw_rule: String::new(),
        rule_hash: String::new(),
    }
}

/// `firewall-cmd --list-all-zones`:
/// ```text
/// public (active)
///   target: default
///   services: ssh dhcpv6-client
///   ports: 8080/tcp 9090/udp
/// ```
fn parse_firewalld_line(line: &str, zone: &mut String, rules: &mut Vec<DetectedFirewallRule>) {
    let t = line.trim();
    let indented = line.starts_with(' ') || line.starts_with('\t');
    if !indented && !t.is_empty() {
        // `public (active)` / `public`
        let name = t.split_whitespace().next().unwrap_or("").to_string();
        if !name.is_empty() {
            *zone = name;
        }
        return;
    }
    let Some((key, value)) = t.split_once(':') else {
        return;
    };
    let key = key.trim();
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    match key {
        "services" | "ports" | "source-ports" | "forward-ports" => {
            for item in value.split_whitespace() {
                let mut rule = empty_rule();
                rule.table_name = "firewalld".to_string();
                rule.chain = zone.clone();
                rule.action = "accept".to_string();
                rule.raw_rule = format!("{}: {}", key, item);
                match key {
                    "services" => rule.dst_port = item.to_string(),
                    "ports" | "source-ports" => {
                        if let Some((p, proto)) = item.split_once('/') {
                            rule.protocol = normalize_protocol(proto);
                            if key == "ports" {
                                rule.dst_port = p.to_string();
                            } else {
                                rule.src_port = p.to_string();
                            }
                        } else {
                            rule.dst_port = item.to_string();
                        }
                    }
                    "forward-ports" => {
                        // port=8080:proto=tcp:toport=80:toaddr=10.0.0.5
                        for kv in item.split(':') {
                            match kv.split_once('=') {
                                Some(("port", v)) => rule.src_port = v.to_string(),
                                Some(("proto", v)) => rule.protocol = normalize_protocol(v),
                                Some(("toport", v)) => rule.dst_port = v.to_string(),
                                Some(("toaddr", v)) => rule.dst = v.to_string(),
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
                push_rule(rules, rule);
            }
        }
        "rich rules" => {
            let mut rule = empty_rule();
            rule.table_name = "firewalld".to_string();
            rule.chain = zone.clone();
            rule.action = "accept".to_string();
            rule.raw_rule = format!("rich rule: {}", value);
            push_rule(rules, rule);
        }
        _ => {}
    }
}

/// `ufw status verbose`:
/// ```text
/// Status: active
/// To                         Action      From
/// --                         ------      ----
/// 22/tcp                     ALLOW IN    Anywhere
/// ```
fn parse_ufw_line(line: &str, rules: &mut Vec<DetectedFirewallRule>) {
    if line.starts_with("Status:")
        || line.starts_with("Logging:")
        || line.starts_with("Default:")
        || line.starts_with("New profiles:")
        || line.is_empty()
    {
        return;
    }
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() < 2 {
        return;
    }
    // Header row `To … Action … From` and its `---` separator.
    if tokens[0].eq_ignore_ascii_case("to") || tokens[0].starts_with("--") {
        return;
    }
    if tokens.iter().any(|t| t.starts_with("------")) {
        return;
    }

    let mut action = String::new();
    let mut from_idx = None;
    for (i, tk) in tokens.iter().enumerate().skip(1) {
        let upper = tk.to_uppercase();
        if matches!(upper.as_str(), "ALLOW" | "DENY" | "REJECT" | "LIMIT") {
            action = upper.to_lowercase();
            let next = tokens.get(i + 1).map(|s| s.to_uppercase());
            from_idx = Some(if matches!(next.as_deref(), Some("IN") | Some("OUT")) {
                i + 2
            } else {
                i + 1
            });
            break;
        }
    }
    let Some(idx) = from_idx else {
        return;
    };

    let to = tokens[0];
    let from = tokens.get(idx).copied().unwrap_or("");

    let mut rule = empty_rule();
    rule.table_name = "ufw".to_string();
    rule.chain = "ufw-user-input".to_string();
    rule.action = action;
    if let Some((p, proto)) = to.split_once('/') {
        rule.dst_port = p.to_string();
        rule.protocol = normalize_protocol(proto);
    } else {
        rule.dst_port = to.to_string();
    }
    if !from.is_empty() && !from.eq_ignore_ascii_case("anywhere") {
        rule.src = from.to_string();
    }
    rule.raw_rule = line.to_string();
    push_rule(rules, rule);
}

/// `nft list ruleset`:
/// ```text
/// table inet filter {
///   chain input {
///     type filter hook input priority 0; policy accept;
///     tcp dport 22 accept
///   }
/// }
/// ```
fn parse_nft_line(
    line: &str,
    table: &mut String,
    chain: &mut String,
    rules: &mut Vec<DetectedFirewallRule>,
) {
    let t = line.trim();
    if t.is_empty() || t == "}" || t == "{" {
        if t == "}" {
            chain.clear();
        }
        return;
    }
    if let Some(rest) = t.strip_prefix("table ") {
        *table = rest.trim_end_matches('{').trim().to_string();
        chain.clear();
        return;
    }
    if let Some(rest) = t.strip_prefix("chain ") {
        *chain = rest.trim_end_matches('{').trim().to_string();
        return;
    }
    if t.starts_with("type ") || t.starts_with("policy ") || t.starts_with("#") {
        return;
    }

    let tokens: Vec<&str> = t.split_whitespace().collect();
    let Some(last) = tokens.last() else {
        return;
    };
    let action = last.to_lowercase();
    if !matches!(
        action.as_str(),
        "accept" | "drop" | "reject" | "queue" | "continue" | "return" | "log"
    ) {
        return;
    }

    let mut rule = empty_rule();
    rule.table_name = table.clone();
    rule.chain = chain.clone();
    rule.action = action;
    if let Some(p) = tokens.first() {
        if matches!(
            *p,
            "tcp" | "udp" | "icmp" | "icmpv6" | "ip" | "ip6" | "sctp"
        ) {
            rule.protocol = p.to_string();
        }
    }
    for (i, tk) in tokens.iter().enumerate() {
        match *tk {
            "dport" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.dst_port = v.to_string();
                }
            }
            "sport" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.src_port = v.to_string();
                }
            }
            "saddr" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.src = v.to_string();
                }
            }
            "daddr" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.dst = v.to_string();
                }
            }
            "iifname" | "iif" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.in_iface = v.trim_matches('"').to_string();
                }
            }
            "oifname" | "oif" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.out_iface = v.trim_matches('"').to_string();
                }
            }
            _ => {}
        }
    }
    rule.raw_rule = t.to_string();
    push_rule(rules, rule);
}

/// `iptables -S`:
/// `-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT`
fn parse_iptables_line(line: &str, rules: &mut Vec<DetectedFirewallRule>) {
    let t = line.trim();
    if t.is_empty() || t.starts_with("#") {
        return;
    }
    let tokens: Vec<&str> = t.split_whitespace().collect();
    if tokens.len() < 3 {
        return;
    }
    // `-P CHAIN POLICY` is a chain policy, not a rule; `-N CHAIN` creates one.
    if tokens[0] == "-P" || tokens[0] == "-N" {
        return;
    }
    if tokens[0] != "-A" {
        return;
    }

    let mut rule = empty_rule();
    rule.table_name = "filter".to_string();
    rule.chain = tokens.get(1).unwrap_or(&"").to_string();

    let mut i = 2;
    while i < tokens.len() {
        match tokens[i] {
            "-p" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.protocol = normalize_protocol(v);
                }
                i += 2;
            }
            "-s" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.src = v.to_string();
                }
                i += 2;
            }
            "-d" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.dst = v.to_string();
                }
                i += 2;
            }
            "-i" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.in_iface = v.to_string();
                }
                i += 2;
            }
            "-o" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.out_iface = v.to_string();
                }
                i += 2;
            }
            "--dport" | "--dports" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.dst_port = v.to_string();
                }
                i += 2;
            }
            "--sport" | "--sports" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.src_port = v.to_string();
                }
                i += 2;
            }
            "-j" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.action = v.to_lowercase();
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    if rule.action.is_empty() {
        return;
    }
    rule.raw_rule = t.to_string();
    push_rule(rules, rule);
}

/// `pfctl -sr` — one flat rule per line, best-effort extraction.
fn parse_pf_line(line: &str, rules: &mut Vec<DetectedFirewallRule>) {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return;
    }
    let tokens: Vec<&str> = t.split_whitespace().collect();
    let mut rule = empty_rule();
    rule.table_name = "pf".to_string();
    rule.chain = "pf".to_string();
    let mut has_action = false;
    for (i, tk) in tokens.iter().enumerate() {
        match *tk {
            "pass" | "block" | "drop" => {
                rule.action = if *tk == "block" || *tk == "drop" {
                    "drop".to_string()
                } else {
                    "accept".to_string()
                };
                has_action = true;
            }
            "proto" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.protocol = normalize_protocol(v);
                }
            }
            "from" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.src = v.to_string();
                }
            }
            "to" => {
                if let Some(v) = tokens.get(i + 1) {
                    rule.dst = v.to_string();
                }
            }
            "port" => {
                if let Some(v) = tokens.get(i + 1) {
                    if rule.dst.is_empty() {
                        rule.src_port = v.to_string();
                    } else {
                        rule.dst_port = v.to_string();
                    }
                }
            }
            _ => {}
        }
    }
    if !has_action {
        return;
    }
    rule.raw_rule = t.to_string();
    push_rule(rules, rule);
}

/// `ports` section — `ss -tulpnH` and `netstat -tulpn` (incl. BSD/macOS layout).
pub fn parse_ports(raw: &str) -> (Vec<DetectedPort>, ProbeSection) {
    let section = evaluate_section(raw);
    let mut ports: Vec<DetectedPort> = Vec::new();

    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("NT_") {
            continue;
        }
        let tokens: Vec<&str> = t.split_whitespace().collect();
        if tokens.len() < 4 {
            continue;
        }
        let proto = normalize_protocol(tokens[0]);
        if proto != "tcp" && proto != "udp" {
            continue;
        }

        // ss (no header): netid state recv-q send-q local peer [process]
        if tokens.len() >= 5 && is_state_word(tokens[1]) {
            let (addr, port) = split_host_port(tokens[4]);
            let Some(port) = port else { continue };
            let (name, pid, user) = parse_ss_process(t);
            ports.push(DetectedPort {
                protocol: proto,
                port,
                listen_addr: normalize_listen_addr(&addr),
                state: normalize_state(tokens[1]),
                process_name: name,
                pid,
                process_user: user,
            });
            continue;
        }

        // netstat: proto recv-q send-q local foreign [state] [pid/program]
        if let Some(port) = split_host_port(tokens[3]).1 {
            let mut state = String::new();
            let mut proc_field = String::new();
            for tk in tokens.iter().skip(4) {
                if is_state_word(tk) {
                    state = normalize_state(tk);
                } else if tk.contains('/') {
                    proc_field = tk.to_string();
                }
            }
            let (name, pid, user) = parse_netstat_process(&proc_field);
            ports.push(DetectedPort {
                protocol: proto,
                port,
                listen_addr: normalize_listen_addr(&split_host_port(tokens[3]).0),
                state,
                process_name: name,
                pid,
                process_user: user,
            });
        }
    }

    // `ss -p` / `netstat -p` need root. When not a single row carries process
    // info the listening state is still exact, but the data is incomplete —
    // mark the section `partial` so the UI shows the 需要-root badge instead
    // of silently presenting half a picture (设计文档 §4.3).
    let mut section = section;
    if section.status == "ok"
        && !ports.is_empty()
        && ports.iter().all(|p| p.process_name.is_empty())
    {
        section = ProbeSection {
            status: "partial".to_string(),
            note: "无法获取进程信息（可能需要 root 权限）".to_string(),
        };
    }

    (ports.clone(), downgrade_empty(section, ports.is_empty()))
}

fn normalize_listen_addr(addr: &str) -> String {
    match addr {
        "*" => "0.0.0.0".to_string(),
        other => other.to_string(),
    }
}

fn normalize_state(state: &str) -> String {
    match state.to_uppercase().as_str() {
        "ESTAB" => "ESTABLISHED".to_string(),
        "UNCONN" => "UNCONN".to_string(),
        other => other.to_string(),
    }
}

/// `peers` section — ESTABLISHED connections only.
///
/// Supports `ss -tunpH state established` and `netstat -tnp` (Linux +
/// BSD/macOS). Rows whose state is not ESTABLISHED are dropped: they are not
/// evidence of a topology relationship.
pub fn parse_peers(raw: &str) -> (Vec<DetectedPeer>, ProbeSection) {
    let section = evaluate_section(raw);
    let mut peers: Vec<DetectedPeer> = Vec::new();

    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("NT_") {
            continue;
        }
        let tokens: Vec<&str> = t.split_whitespace().collect();
        if tokens.len() < 4 {
            continue;
        }
        let proto = normalize_protocol(tokens[0]);
        if proto != "tcp" && proto != "udp" {
            continue;
        }

        // ss: netid state recv-q send-q local peer [process]
        if tokens.len() >= 6 && is_state_word(tokens[1]) {
            if !is_established(tokens[1]) {
                continue;
            }
            let (remote_addr, remote_port) = split_host_port(tokens[5]);
            let (_, local_port) = split_host_port(tokens[4]);
            let (name, pid, _) = parse_ss_process(t);
            peers.push(DetectedPeer {
                remote_addr,
                remote_port,
                local_port,
                protocol: proto,
                process_name: name,
                process_pid: pid,
                state: normalize_state(tokens[1]),
            });
            continue;
        }

        // netstat: proto recv-q send-q local foreign state [pid/program]
        let mut state = String::new();
        let mut proc_field = String::new();
        for tk in tokens.iter().skip(4) {
            if is_state_word(tk) {
                state = tk.to_string();
            } else if tk.contains('/') {
                proc_field = tk.to_string();
            }
        }
        if !is_established(&state) {
            continue;
        }
        let (remote_addr, remote_port) = split_host_port(tokens[4]);
        let (_, local_port) = split_host_port(tokens[3]);
        let (name, pid, _) = parse_netstat_process(&proc_field);
        peers.push(DetectedPeer {
            remote_addr,
            remote_port,
            local_port,
            protocol: proto,
            process_name: name,
            process_pid: pid,
            state: normalize_state(&state),
        });
    }

    (peers.clone(), downgrade_empty(section, peers.is_empty()))
}

fn is_established(state: &str) -> bool {
    matches!(state.to_uppercase().as_str(), "ESTABLISHED" | "ESTAB")
}

// ═══════════════════════════════════════════════════════════════════════════
// Orchestration
// ═══════════════════════════════════════════════════════════════════════════

/// Build the single read-only probe script for the given host.
///
/// Delegates to [`OsInfo::topology_probe_cmd`] so every command stays
/// distro-aware (see design doc §4.2).
pub fn build_probe_script(os: &OsInfo) -> String {
    os.topology_probe_cmd()
}

/// Pick the node's primary IPv4: the address on the interface that carries the
/// default route, falling back to the first non-loopback IPv4.
pub fn pick_primary_ip(routes: &[DetectedRoute], interfaces: &[DetectedInterface]) -> String {
    let default_iface = routes
        .iter()
        .find(|r| r.destination == "default" || r.destination == "0.0.0.0")
        .map(|r| r.iface.clone())
        .filter(|i| !i.is_empty());

    if let Some(name) = default_iface {
        for iface in interfaces {
            if iface.iface_name == name && !iface.is_loopback {
                if let Some(ip) = iface.ipv4_addrs.first() {
                    return strip_cidr(ip);
                }
            }
        }
    }
    for iface in interfaces {
        if !iface.is_loopback {
            if let Some(ip) = iface.ipv4_addrs.first() {
                return strip_cidr(ip);
            }
        }
    }
    String::new()
}

fn strip_cidr(addr: &str) -> String {
    addr.split('/').next().unwrap_or(addr).trim().to_string()
}

fn empty_probe_data() -> ProbeData {
    ProbeData {
        hostname: String::new(),
        os_name: String::new(),
        primary_ip: String::new(),
        interfaces: Vec::new(),
        routes: Vec::new(),
        firewall: None,
        firewall_rules: Vec::new(),
        ports: Vec::new(),
        peers: Vec::new(),
    }
}

fn failed_sections() -> ProbeSections {
    ProbeSections {
        hostname: missing_section(),
        os: missing_section(),
        interfaces: missing_section(),
        routes: missing_section(),
        firewall: missing_section(),
        rules: missing_section(),
        ports: missing_section(),
        peers: missing_section(),
    }
}

/// Run the whole topology probe over an existing SSH session.
///
/// Exactly one `execute_command` call — serialising eight commands would hold
/// the connection read lock eight times as long and multiply the 30s
/// per-command timeout exposure. An outer 25s `tokio::time::timeout` bounds
/// the probe below the underlying 30s exec timeout so we can still return a
/// structured (partial) result instead of being killed mid-flight.
///
/// Never panics: every failure is logged and turned into a section status.
pub async fn run_probe(client: &crate::ssh::SshClient, os: &OsInfo) -> ProbeResult {
    let probed_at_ms = now_millis();
    let script = build_probe_script(os);

    let raw = match tokio::time::timeout(
        std::time::Duration::from_secs(25),
        client.execute_command(&script),
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            tracing::warn!("network topology probe failed: {}", e);
            return ProbeResult {
                success: false,
                error: Some(truncate_chars(&e.to_string(), 500)),
                sections: failed_sections(),
                data: empty_probe_data(),
                probed_at_ms,
                raw_excerpt: None,
            };
        }
        Err(_) => {
            tracing::warn!("network topology probe timed out after 25s");
            return ProbeResult {
                success: false,
                error: Some("探测超时（25s）".to_string()),
                sections: failed_sections(),
                data: empty_probe_data(),
                probed_at_ms,
                raw_excerpt: None,
            };
        }
    };

    let sections = split_sections(&raw);
    let excerpt = Some(truncate_chars(&raw, RAW_EXCERPT_MAX_CHARS));

    let (hostname, hostname_section) = match sections.get("hostname") {
        Some(body) => parse_hostname(body),
        None => (String::new(), missing_section()),
    };
    let (os_name, os_section) = match sections.get("os") {
        Some(body) => parse_os_name(body),
        None => (String::new(), missing_section()),
    };
    let (interfaces, interfaces_section) = match sections.get("interfaces") {
        Some(body) => parse_interfaces(body),
        None => (Vec::new(), missing_section()),
    };
    let (routes, routes_section) = match sections.get("routes") {
        Some(body) => parse_routes(body),
        None => (Vec::new(), missing_section()),
    };
    let (firewall, firewall_section) = match sections.get("firewall") {
        Some(body) => parse_firewall(body),
        None => (empty_firewall(), missing_section()),
    };
    let (firewall_rules, rules_section) = match sections.get("rules") {
        Some(body) => parse_firewall_rules(body),
        None => (Vec::new(), missing_section()),
    };
    let (ports, ports_section) = match sections.get("ports") {
        Some(body) => parse_ports(body),
        None => (Vec::new(), missing_section()),
    };
    let (peers, peers_section) = match sections.get("peers") {
        Some(body) => parse_peers(body),
        None => (Vec::new(), missing_section()),
    };

    for (name, section) in [
        ("hostname", &hostname_section),
        ("os", &os_section),
        ("interfaces", &interfaces_section),
        ("routes", &routes_section),
        ("firewall", &firewall_section),
        ("rules", &rules_section),
        ("ports", &ports_section),
        ("peers", &peers_section),
    ] {
        if section.status == "failed" || section.status == "partial" {
            tracing::warn!(
                "network topology section {}: {} ({})",
                name,
                section.status,
                section.note
            );
        }
    }

    let primary_ip = pick_primary_ip(&routes, &interfaces);
    let firewall = if matches!(firewall_section.status.as_str(), "ok" | "partial") {
        Some(firewall)
    } else {
        None
    };

    let all_sections = [
        &hostname_section,
        &os_section,
        &interfaces_section,
        &routes_section,
        &firewall_section,
        &rules_section,
        &ports_section,
        &peers_section,
    ];
    let success = all_sections
        .iter()
        .any(|s| s.status == "ok" || s.status == "partial");

    ProbeResult {
        success,
        error: if success {
            None
        } else {
            Some("所有分段均未采集到数据".to_string())
        },
        sections: ProbeSections {
            hostname: hostname_section,
            os: os_section,
            interfaces: interfaces_section,
            routes: routes_section,
            firewall: firewall_section,
            rules: rules_section,
            ports: ports_section,
            peers: peers_section,
        },
        data: ProbeData {
            hostname,
            os_name,
            primary_ip,
            interfaces,
            routes,
            firewall,
            firewall_rules,
            ports,
            peers,
        },
        probed_at_ms,
        raw_excerpt: excerpt,
    }
}

fn empty_firewall() -> DetectedFirewall {
    DetectedFirewall {
        fw_type: "unknown".to_string(),
        active: false,
        default_in_policy: String::new(),
        default_out_policy: String::new(),
        version: String::new(),
        zones: Vec::new(),
        detect_note: String::new(),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TCP reachability probing (client side, manual action only)
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_TCP_TIMEOUT_MS: u64 = 1500;
const MAX_TCP_TIMEOUT_MS: u64 = 10_000;
const MAX_PORTS_PER_REQUEST: usize = 200;
const TCP_CONCURRENCY: usize = 32;

/// Pure TCP-layer connectivity test from this client to `host:port`.
///
/// This knows nothing about whether the server reports the port as listening —
/// the frontend cross-references `net_ports` to reach the user-facing verdict
/// (`reachable` / `blocked` / `not_listening` / `unexpected_open`, design
/// doc §5). Here `blocked` simply means "the connect timed out".
async fn probe_one_tcp_port(host: &str, port: u16, timeout: std::time::Duration) -> TcpProbeResult {
    use std::io::ErrorKind;
    use tokio::net::TcpStream;

    let start = std::time::Instant::now();
    match tokio::time::timeout(timeout, TcpStream::connect((host, port))).await {
        Ok(Ok(_)) => TcpProbeResult {
            port,
            status: "reachable".to_string(),
            tcp_ok: true,
            latency_ms: Some(start.elapsed().as_millis() as u64),
            error_text: None,
        },
        Ok(Err(e)) => {
            let status = match e.kind() {
                ErrorKind::ConnectionRefused => "not_listening",
                ErrorKind::TimedOut => "blocked",
                _ => {
                    let msg = e.to_string().to_lowercase();
                    if msg.contains("lookup")
                        || msg.contains("resolve")
                        || msg.contains("name or service not known")
                        || msg.contains("nodename nor servname")
                        || msg.contains("no such host")
                    {
                        "dns_error"
                    } else {
                        "error"
                    }
                }
            };
            tracing::warn!("tcp probe {}:{} -> {} ({})", host, port, status, e);
            TcpProbeResult {
                port,
                status: status.to_string(),
                tcp_ok: false,
                latency_ms: None,
                error_text: Some(truncate_chars(&e.to_string(), 300)),
            }
        }
        Err(_) => TcpProbeResult {
            port,
            status: "blocked".to_string(),
            tcp_ok: false,
            latency_ms: None,
            error_text: Some("连接超时".to_string()),
        },
    }
}

/// Batch TCP connectivity test.
///
/// Arguments are sanitised here (host trimmed, timeout clamped, ports
/// de-duplicated and capped) so a malformed frontend call can never fan out
/// into an unbounded number of outbound connections.
pub async fn probe_tcp_ports(
    host: &str,
    ports: &[u16],
    timeout_ms: Option<u64>,
) -> Vec<TcpProbeResult> {
    let host = host.trim();
    if host.is_empty() {
        return Vec::new();
    }
    let timeout = std::time::Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TCP_TIMEOUT_MS)
            .min(MAX_TCP_TIMEOUT_MS),
    );

    let mut unique: Vec<u16> = Vec::new();
    for port in ports.iter().take(MAX_PORTS_PER_REQUEST) {
        if !unique.contains(port) {
            unique.push(*port);
        }
    }

    let mut results: Vec<TcpProbeResult> = Vec::with_capacity(unique.len());
    for chunk in unique.chunks(TCP_CONCURRENCY) {
        let futs: Vec<_> = chunk
            .iter()
            .map(|port| probe_one_tcp_port(host, *port, timeout))
            .collect();
        results.extend(futures::future::join_all(futs).await);
    }
    results
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── split_sections ─────────────────────────────────────────────────────

    #[test]
    fn splits_all_sections_in_order() {
        let raw = "###NT:hostname###\nweb-01\n###NT:os###\nID=ubuntu\n###NT:interfaces###\n2: eth0\n###NT:routes###\ndefault via 10.0.0.1\n###NT:firewall###\nFW=ufw\n###NT:rules###\n##RULE_FMT:ufw##\n###NT:ports###\ntcp LISTEN\n###NT:peers###\ntcp ESTAB\n###NT:end###";
        let sections = split_sections(raw);
        for key in SECTION_KEYS {
            assert!(sections.contains_key(key), "missing section {key}");
        }
        assert_eq!(sections.get("hostname").map(|s| s.as_str()), Some("web-01"));
        assert_eq!(
            sections.get("routes").map(|s| s.as_str()),
            Some("default via 10.0.0.1")
        );
        assert!(!sections.contains_key("end"));
    }

    #[test]
    fn splits_empty_payload_into_nothing() {
        assert!(split_sections("").is_empty());
        assert!(split_sections("###NT:end###").is_empty());
    }

    #[test]
    fn tolerates_missing_trailing_marker() {
        let sections = split_sections("###NT:hostname###\nhost-a\n###NT:os###\nID=alpine");
        assert_eq!(sections.get("os").map(|s| s.as_str()), Some("ID=alpine"));
    }

    #[test]
    fn ignores_content_before_first_marker() {
        let sections = split_sections("noise line\n###NT:hostname###\nhost-b");
        assert_eq!(sections.get("hostname").map(|s| s.as_str()), Some("host-b"));
    }

    // ── parse_hostname ─────────────────────────────────────────────────────

    #[test]
    fn hostname_normal() {
        let (host, section) = parse_hostname("web-01.example.com");
        assert_eq!(host, "web-01.example.com");
        assert_eq!(section.status, "ok");
    }

    #[test]
    fn hostname_empty_marks_failed() {
        let (host, section) = parse_hostname("");
        assert!(host.is_empty());
        assert_eq!(section.status, "failed");
    }

    #[test]
    fn hostname_unavailable_marker() {
        let (host, section) = parse_hostname("NT_UNAVAILABLE:hostname");
        assert!(host.is_empty());
        assert_eq!(section.status, "unavailable");
    }

    // ── parse_os_name ──────────────────────────────────────────────────────

    #[test]
    fn os_name_from_os_release() {
        let (name, section) =
            parse_os_name("PRETTY_NAME=\"Ubuntu 22.04.3 LTS\"\nID=ubuntu\nLinux 5.15.0-88-generic");
        assert_eq!(name, "Ubuntu 22.04.3 LTS (Linux 5.15.0-88-generic)");
        assert_eq!(section.status, "ok");
    }

    #[test]
    fn os_name_from_macos_sw_vers() {
        let (name, _) = parse_os_name(
            "ProductName:\tmacOS\nProductVersion:\t14.5\nBuildVersion:\t23F79\nDarwin 23.5.0",
        );
        assert!(name.starts_with("macOS 14.5"));
    }

    #[test]
    fn os_name_empty_marks_failed() {
        let (name, section) = parse_os_name("");
        assert!(name.is_empty());
        assert_eq!(section.status, "failed");
    }

    #[test]
    fn os_name_error_marker() {
        let (_, section) = parse_os_name("NT_ERROR:os");
        assert_eq!(section.status, "failed");
    }

    // ── parse_interfaces ───────────────────────────────────────────────────

    const IP_O_ADDR: &str = "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever\n1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000\\    link/ether 52:54:00:12:34:56 brd ff:ff:ff:ff:ff:ff\n2: eth0    inet 192.168.1.10/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever preferred_lft forever\n2: eth0    inet6 fe80::5054:ff:fe12:3456/64 scope link \\       valid_lft forever preferred_lft forever";

    #[test]
    fn interfaces_from_ip_o_addr() {
        let (ifaces, section) = parse_interfaces(IP_O_ADDR);
        assert_eq!(section.status, "ok");
        assert_eq!(ifaces.len(), 2);

        let lo = ifaces.iter().find(|i| i.iface_name == "lo").unwrap();
        assert!(lo.is_loopback);
        assert_eq!(lo.ipv4_addrs, vec!["127.0.0.1/8".to_string()]);

        let eth0 = ifaces.iter().find(|i| i.iface_name == "eth0").unwrap();
        assert_eq!(eth0.mac, "52:54:00:12:34:56");
        assert_eq!(eth0.mtu, Some(1500));
        assert_eq!(eth0.state, "UP");
        assert!(!eth0.is_loopback);
        assert_eq!(eth0.ipv4_addrs, vec!["192.168.1.10/24".to_string()]);
        assert_eq!(
            eth0.ipv6_addrs,
            vec!["fe80::5054:ff:fe12:3456/64".to_string()]
        );
    }

    #[test]
    fn interfaces_from_ifconfig() {
        let raw = "eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet 10.0.0.5  netmask 255.255.255.0  broadcast 10.0.0.255\n        inet6 fe80::5054:ff:fe12:3456  prefixlen 64  scopeid 0x20<link>\n        ether 52:54:00:12:34:56  txqueuelen 1000  (Ethernet)\n\nlo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536\n        inet 127.0.0.1  netmask 255.0.0.0\n        loop  txqueuelen 1000  (Local Loopback)";
        let (ifaces, section) = parse_interfaces(raw);
        assert_eq!(section.status, "ok");
        let eth0 = ifaces.iter().find(|i| i.iface_name == "eth0").unwrap();
        assert_eq!(eth0.mac, "52:54:00:12:34:56");
        assert_eq!(eth0.mtu, Some(1500));
        assert_eq!(eth0.state, "UP");
        assert_eq!(eth0.ipv4_addrs, vec!["10.0.0.5/24".to_string()]);
        assert_eq!(
            eth0.ipv6_addrs,
            vec!["fe80::5054:ff:fe12:3456/64".to_string()]
        );
        let lo = ifaces.iter().find(|i| i.iface_name == "lo").unwrap();
        assert!(lo.is_loopback);
    }

    #[test]
    fn interfaces_empty_marks_failed() {
        let (ifaces, section) = parse_interfaces("");
        assert!(ifaces.is_empty());
        assert_eq!(section.status, "failed");
    }

    #[test]
    fn interfaces_unavailable_marker() {
        let (ifaces, section) = parse_interfaces("NT_UNAVAILABLE:interfaces");
        assert!(ifaces.is_empty());
        assert_eq!(section.status, "unavailable");
    }

    #[test]
    fn interfaces_ignores_garbage() {
        let (ifaces, section) = parse_interfaces("this is not interface output at all");
        assert!(ifaces.is_empty());
        assert_eq!(section.status, "failed");
    }

    // ── parse_routes ───────────────────────────────────────────────────────

    #[test]
    fn routes_from_ip_route() {
        let raw = "default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.10 metric 100 \n10.0.0.0/24 dev eth1 proto kernel scope link src 10.0.0.5 \n172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown ";
        let (routes, section) = parse_routes(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(routes.len(), 3);

        let default = &routes[0];
        assert_eq!(default.destination, "default");
        assert_eq!(default.gateway, "192.168.1.1");
        assert_eq!(default.iface, "eth0");
        assert_eq!(default.metric, Some(100));
        assert_eq!(default.genmask, "0.0.0.0");
        assert_eq!(default.route_type, "default");

        assert_eq!(routes[1].destination, "10.0.0.0/24");
        assert_eq!(routes[1].genmask, "255.255.255.0");
        assert_eq!(routes[1].route_type, "link");
    }

    #[test]
    fn routes_from_netstat_rn_linux() {
        let raw = "Kernel IP routing table\nDestination     Gateway         Genmask         Flags   MSS Window  irtt Iface\n0.0.0.0         192.168.1.1     0.0.0.0         UG        0 0          0 eth0\n10.0.0.0        0.0.0.0         255.255.255.0   U         0 0          0 eth1";
        let (routes, section) = parse_routes(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].destination, "0.0.0.0");
        assert_eq!(routes[0].route_type, "default");
        assert_eq!(routes[0].iface, "eth0");
        assert_eq!(routes[0].flags, "UG");
        assert_eq!(routes[1].destination, "10.0.0.0");
        assert_eq!(routes[1].route_type, "link");
        assert_eq!(routes[1].genmask, "255.255.255.0");
    }

    #[test]
    fn routes_from_netstat_rn_macos() {
        let raw = "Routing tables\nInternet:\nDestination        Gateway            Flags        Netif Expire\ndefault            192.168.1.1        UGSc           en0\n10.0.0.0/24        link#6             UCS            en1";
        let (routes, section) = parse_routes(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].route_type, "default");
        assert_eq!(routes[0].iface, "en0");
        assert_eq!(routes[1].iface, "en1");
        assert_eq!(routes[1].route_type, "link");
    }

    #[test]
    fn routes_empty_marks_failed() {
        let (routes, section) = parse_routes("");
        assert!(routes.is_empty());
        assert_eq!(section.status, "failed");
    }

    #[test]
    fn routes_error_marker() {
        let (_, section) = parse_routes("NT_ERROR:routes");
        assert_eq!(section.status, "failed");
        assert_eq!(section.note, "routes");
    }

    // ── parse_firewall ─────────────────────────────────────────────────────

    #[test]
    fn firewall_firewalld_active() {
        let raw = "FW=firewalld\nFW_STATE=running\nFW_VERSION=1.1.1\nFW_RAW=running\nFW_ZONES_BEGIN\npublic\n  interfaces: eth0\ndmz\n  interfaces: eth1\nFW_ZONES_END\nFW_POLICY_BEGIN\n-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT\nFW_POLICY_END";
        let (fw, section) = parse_firewall(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(fw.fw_type, "firewalld");
        assert!(fw.active);
        assert_eq!(fw.version, "1.1.1");
        assert_eq!(fw.zones, vec!["public".to_string(), "dmz".to_string()]);
        assert_eq!(fw.default_in_policy, "ACCEPT");
        assert_eq!(fw.default_out_policy, "ACCEPT");
    }

    #[test]
    fn firewall_ufw_inactive() {
        let raw = "FW=ufw\nFW_STATE=Status: inactive\nFW_VERSION=ufw 0.36.1\nFW_RAW=Status: inactive\nFW_ZONES_BEGIN\nFW_ZONES_END\nFW_POLICY_BEGIN\nFW_POLICY_END";
        let (fw, section) = parse_firewall(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(fw.fw_type, "ufw");
        assert!(!fw.active);
        assert!(fw.zones.is_empty());
    }

    #[test]
    fn firewall_permission_denied_is_partial() {
        let raw = "FW=iptables\nFW_STATE=not running\nFW_VERSION=iptables v1.8.7\nFW_RAW=iptables: Permission denied (you must be root)\nFW_ZONES_BEGIN\nFW_ZONES_END\nFW_POLICY_BEGIN\nFW_POLICY_END";
        let (fw, section) = parse_firewall(raw);
        assert_eq!(fw.fw_type, "iptables");
        assert_eq!(fw.detect_note, "需要 root 权限");
        assert_eq!(section.status, "partial");
        assert_eq!(section.note, "需要 root 权限");
    }

    #[test]
    fn firewall_none_is_ok_not_failed() {
        let raw = "FW=none\nFW_POLICY_BEGIN\nFW_POLICY_END";
        let (fw, section) = parse_firewall(raw);
        assert_eq!(fw.fw_type, "none");
        assert!(!fw.active);
        assert_eq!(section.status, "ok");
    }

    #[test]
    fn firewall_unknown_marks_failed() {
        let (fw, section) = parse_firewall("");
        assert_eq!(fw.fw_type, "unknown");
        assert_eq!(section.status, "failed");
    }

    // ── parse_firewall_rules ───────────────────────────────────────────────

    #[test]
    fn rules_from_ufw_status_verbose() {
        let raw = "##RULE_FMT:ufw##\nStatus: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW IN    Anywhere\n80/tcp                     ALLOW IN    10.0.0.0/8\n443                        DENY IN     Anywhere";
        let (rules, section) = parse_firewall_rules(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(rules.len(), 3);
        assert_eq!(rules[0].dst_port, "22");
        assert_eq!(rules[0].protocol, "tcp");
        assert_eq!(rules[0].action, "allow");
        assert!(rules[0].src.is_empty());
        assert_eq!(rules[1].src, "10.0.0.0/8");
        assert_eq!(rules[2].action, "deny");
        assert_eq!(rules[2].dst_port, "443");
    }

    #[test]
    fn rules_from_iptables_save() {
        let raw = "##RULE_FMT:iptables##\n-P INPUT ACCEPT\n-N DOCKER\n-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT\n-A INPUT -s 10.0.0.0/8 -j DROP\n-A INPUT -i eth0 -o eth1 -p udp --sport 53 -j ACCEPT";
        let (rules, section) = parse_firewall_rules(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(rules.len(), 3);
        let ssh = rules.iter().find(|r| r.dst_port == "22").unwrap();
        assert_eq!(ssh.protocol, "tcp");
        assert_eq!(ssh.action, "accept");
        assert_eq!(ssh.table_name, "filter");
        assert_eq!(ssh.chain, "INPUT");
        let drop = rules.iter().find(|r| r.action == "drop").unwrap();
        assert_eq!(drop.src, "10.0.0.0/8");
        let dns = rules.iter().find(|r| r.src_port == "53").unwrap();
        assert_eq!(dns.in_iface, "eth0");
        assert_eq!(dns.out_iface, "eth1");
    }

    #[test]
    fn rules_from_nft_ruleset() {
        let raw = "##RULE_FMT:nft##\ntable inet filter {\n\tchain input {\n\t\ttype filter hook input priority 0; policy accept;\n\t\ttcp dport 22 accept\n\t\tiifname \"eth0\" udp sport 53 accept\n\t}\n}";
        let (rules, section) = parse_firewall_rules(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].table_name, "inet filter");
        assert_eq!(rules[0].chain, "input");
        assert_eq!(rules[0].dst_port, "22");
        assert_eq!(rules[0].protocol, "tcp");
        assert_eq!(rules[0].action, "accept");
        assert_eq!(rules[1].in_iface, "eth0");
        assert_eq!(rules[1].src_port, "53");
    }

    #[test]
    fn rules_from_firewalld_list_all_zones() {
        let raw = "##RULE_FMT:firewalld##\npublic (active)\n  target: default\n  icmp-block-inversion: no\n  services: ssh dhcpv6-client\n  ports: 8080/tcp 9090/udp\n  forward-ports: \n  rich rules: \ndmz\n  services: http\n  ports: 3306/tcp";
        let (rules, section) = parse_firewall_rules(raw);
        assert_eq!(section.status, "ok");
        assert!(rules
            .iter()
            .any(|r| r.chain == "public" && r.dst_port == "ssh"));
        assert!(rules
            .iter()
            .any(|r| r.chain == "public" && r.dst_port == "8080" && r.protocol == "tcp"));
        assert!(rules
            .iter()
            .any(|r| r.chain == "public" && r.dst_port == "9090" && r.protocol == "udp"));
        assert!(rules
            .iter()
            .any(|r| r.chain == "dmz" && r.dst_port == "3306"));
    }

    #[test]
    fn rules_hash_is_stable_across_whitespace() {
        let a = rule_hash("-A INPUT -p tcp --dport 22 -j ACCEPT");
        let b = rule_hash("-A  INPUT   -p tcp  --dport 22  -j ACCEPT");
        assert_eq!(a, b);
        assert_ne!(a, rule_hash("-A INPUT -p tcp --dport 80 -j ACCEPT"));
    }

    #[test]
    fn rules_empty_marks_failed() {
        let (rules, section) = parse_firewall_rules("");
        assert!(rules.is_empty());
        assert_eq!(section.status, "failed");
    }

    #[test]
    fn rules_dedupes_identical_rules() {
        let raw = "##RULE_FMT:iptables##\n-A INPUT -p tcp --dport 22 -j ACCEPT\n-A INPUT -p tcp --dport 22 -j ACCEPT";
        let (rules, _) = parse_firewall_rules(raw);
        assert_eq!(rules.len(), 1);
    }

    // ── parse_ports ────────────────────────────────────────────────────────

    #[test]
    fn ports_from_ss_tulpn() {
        let raw = "tcp   LISTEN  0  128  0.0.0.0:22  0.0.0.0:*  users:((\"sshd\",pid=1234,fd=3))\nudp   UNCONN  0  0    0.0.0.0:68  0.0.0.0:*\ntcp   LISTEN  0  511       *:80        *:*  users:((\"nginx\",pid=55,fd=6))";
        let (ports, section) = parse_ports(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(ports.len(), 3);
        let ssh = ports.iter().find(|p| p.port == 22).unwrap();
        assert_eq!(ssh.protocol, "tcp");
        assert_eq!(ssh.listen_addr, "0.0.0.0");
        assert_eq!(ssh.state, "LISTEN");
        assert_eq!(ssh.process_name, "sshd");
        assert_eq!(ssh.pid, Some(1234));
        let nginx = ports.iter().find(|p| p.port == 80).unwrap();
        assert_eq!(nginx.listen_addr, "0.0.0.0");
        assert_eq!(nginx.process_name, "nginx");
        let dhcp = ports.iter().find(|p| p.port == 68).unwrap();
        assert_eq!(dhcp.protocol, "udp");
        assert_eq!(dhcp.state, "UNCONN");
        assert!(dhcp.process_name.is_empty());
    }

    #[test]
    fn ports_from_netstat_tulpn() {
        let raw = "Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name\ntcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1234/sshd\ntcp6       0      0 :::80                   :::*                    LISTEN      5678/nginx\nudp        0      0 0.0.0.0:68              0.0.0.0:*                           4321/dhclient";
        let (ports, section) = parse_ports(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(ports.len(), 3);
        let ssh = ports.iter().find(|p| p.port == 22).unwrap();
        assert_eq!(ssh.protocol, "tcp");
        assert_eq!(ssh.state, "LISTEN");
        assert_eq!(ssh.process_name, "sshd");
        assert_eq!(ssh.pid, Some(1234));
        let nginx = ports
            .iter()
            .find(|p| p.port == 80 && p.listen_addr == "::")
            .unwrap();
        assert_eq!(nginx.process_name, "nginx");
        assert_eq!(ports.iter().find(|p| p.port == 68).unwrap().protocol, "udp");
    }

    #[test]
    fn ports_from_macos_netstat() {
        let raw = "tcp4       0      0  *.22                   *.*                    LISTEN\ntcp4       0      0  127.0.0.1.5432         *.*                    LISTEN";
        let (ports, section) = parse_ports(raw);
        // macOS `netstat -an` exposes no PID column at all → partial.
        assert_eq!(section.status, "partial");
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].listen_addr, "0.0.0.0");
        assert_eq!(ports[0].port, 22);
        assert_eq!(ports[1].listen_addr, "127.0.0.1");
        assert_eq!(ports[1].port, 5432);
    }

    #[test]
    fn ports_without_root_still_reports_state() {
        // `ss -p` without root omits the whole process column; the listening
        // state must still be exact, but the section degrades to `partial`.
        let raw = "tcp   LISTEN  0  128  0.0.0.0:22  0.0.0.0:*";
        let (ports, section) = parse_ports(raw);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].state, "LISTEN");
        assert!(ports[0].process_name.is_empty());
        assert_eq!(ports[0].pid, None);
        assert_eq!(section.status, "partial");
        assert!(section.note.contains("root"));
    }

    #[test]
    fn ports_with_process_info_stays_ok() {
        let raw = "tcp   LISTEN  0  128  0.0.0.0:22  0.0.0.0:*  users:((\"sshd\",pid=1234,fd=3))";
        let (_, section) = parse_ports(raw);
        assert_eq!(section.status, "ok");
    }

    #[test]
    fn ports_empty_marks_failed() {
        let (ports, section) = parse_ports("");
        assert!(ports.is_empty());
        assert_eq!(section.status, "failed");
    }

    #[test]
    fn ports_unavailable_marker() {
        let (ports, section) = parse_ports("NT_UNAVAILABLE:ports");
        assert!(ports.is_empty());
        assert_eq!(section.status, "unavailable");
    }

    // ── parse_peers ────────────────────────────────────────────────────────

    #[test]
    fn peers_from_ss_established() {
        let raw = "tcp   ESTAB  0  0  192.168.1.10:54322  10.0.0.5:5432  users:((\"psql\",pid=99,fd=3))\ntcp   ESTAB  0  0  192.168.1.10:22     203.0.113.9:41000 users:((\"sshd\",pid=12,fd=4))";
        let (peers, section) = parse_peers(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].remote_addr, "10.0.0.5");
        assert_eq!(peers[0].remote_port, Some(5432));
        assert_eq!(peers[0].local_port, Some(54322));
        assert_eq!(peers[0].protocol, "tcp");
        assert_eq!(peers[0].process_name, "psql");
        assert_eq!(peers[0].process_pid, Some(99));
        assert_eq!(peers[0].state, "ESTABLISHED");
    }

    #[test]
    fn peers_from_netstat_tnp() {
        let raw = "Active Internet connections (w/o servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name\ntcp        0      0 192.168.1.10:54322     10.0.0.5:5432           ESTABLISHED 99/psql\ntcp        0      0 192.168.1.10:22        203.0.113.9:41000       TIME_WAIT   -";
        let (peers, section) = parse_peers(raw);
        assert_eq!(section.status, "ok");
        assert_eq!(peers.len(), 1, "non-ESTABLISHED rows must be dropped");
        assert_eq!(peers[0].remote_addr, "10.0.0.5");
        assert_eq!(peers[0].remote_port, Some(5432));
        assert_eq!(peers[0].process_name, "psql");
        assert_eq!(peers[0].process_pid, Some(99));
    }

    #[test]
    fn peers_empty_marks_failed() {
        let (peers, section) = parse_peers("");
        assert!(peers.is_empty());
        assert_eq!(section.status, "failed");
    }

    #[test]
    fn peers_drops_non_established() {
        let raw = "tcp   TIME-WAIT  0  0  192.168.1.10:54322  10.0.0.5:5432";
        let (peers, _) = parse_peers(raw);
        assert!(peers.is_empty());
    }

    // ── helpers ────────────────────────────────────────────────────────────

    #[test]
    fn split_host_port_handles_all_layouts() {
        assert_eq!(
            split_host_port("0.0.0.0:22"),
            ("0.0.0.0".to_string(), Some(22))
        );
        assert_eq!(split_host_port("[::]:80"), ("::".to_string(), Some(80)));
        assert_eq!(split_host_port(":::80"), ("::".to_string(), Some(80)));
        assert_eq!(split_host_port("*:80"), ("*".to_string(), Some(80)));
        assert_eq!(split_host_port("*.22"), ("*".to_string(), Some(22)));
        assert_eq!(
            split_host_port("127.0.0.1.5432"),
            ("127.0.0.1".to_string(), Some(5432))
        );
        assert_eq!(split_host_port("10.0.0.5"), ("10.0.0.5".to_string(), None));
    }

    #[test]
    fn prefix_to_mask_is_correct() {
        assert_eq!(prefix_to_mask(24), "255.255.255.0");
        assert_eq!(prefix_to_mask(32), "255.255.255.255");
        assert_eq!(prefix_to_mask(0), "0.0.0.0");
        assert_eq!(prefix_to_mask(16), "255.255.0.0");
    }

    #[test]
    fn truncate_chars_respects_limit() {
        let long = "a".repeat(2500);
        let out = truncate_chars(&long, 2000);
        assert!(out.len() < 2100);
        assert!(out.ends_with("...(truncated)"));
        assert_eq!(truncate_chars("short", 2000), "short");
    }

    #[test]
    fn pick_primary_ip_prefers_default_route_iface() {
        let routes = vec![
            DetectedRoute {
                destination: "10.0.0.0/24".to_string(),
                gateway: String::new(),
                genmask: "255.255.255.0".to_string(),
                flags: String::new(),
                metric: None,
                iface: "eth1".to_string(),
                route_type: "link".to_string(),
            },
            DetectedRoute {
                destination: "default".to_string(),
                gateway: "192.168.1.1".to_string(),
                genmask: "0.0.0.0".to_string(),
                flags: String::new(),
                metric: Some(100),
                iface: "eth0".to_string(),
                route_type: "default".to_string(),
            },
        ];
        let interfaces = vec![
            DetectedInterface {
                iface_name: "lo".to_string(),
                mac: String::new(),
                state: "UP".to_string(),
                mtu: None,
                is_loopback: true,
                ipv4_addrs: vec!["127.0.0.1/8".to_string()],
                ipv6_addrs: vec![],
            },
            DetectedInterface {
                iface_name: "eth1".to_string(),
                mac: String::new(),
                state: "UP".to_string(),
                mtu: None,
                is_loopback: false,
                ipv4_addrs: vec!["10.0.0.5/24".to_string()],
                ipv6_addrs: vec![],
            },
            DetectedInterface {
                iface_name: "eth0".to_string(),
                mac: String::new(),
                state: "UP".to_string(),
                mtu: None,
                is_loopback: false,
                ipv4_addrs: vec!["192.168.1.10/24".to_string()],
                ipv6_addrs: vec![],
            },
        ];
        assert_eq!(pick_primary_ip(&routes, &interfaces), "192.168.1.10");
    }

    #[test]
    fn pick_primary_ip_falls_back_to_first_non_loopback() {
        let interfaces = vec![DetectedInterface {
            iface_name: "eth5".to_string(),
            mac: String::new(),
            state: "UP".to_string(),
            mtu: None,
            is_loopback: false,
            ipv4_addrs: vec!["172.16.0.9/16".to_string()],
            ipv6_addrs: vec![],
        }];
        assert_eq!(pick_primary_ip(&[], &interfaces), "172.16.0.9");
        assert_eq!(pick_primary_ip(&[], &[]), "");
    }

    #[test]
    fn probe_script_stays_read_only() {
        let script = build_probe_script(&OsInfo::default());
        // Only inspect executable lines — the header comment deliberately
        // *mentions* the constructs it promises never to use.
        let code: String = script
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in [
            "set -e",
            " > ",
            ">>",
            "apt ",
            "yum ",
            "apk ",
            "dnf ",
            "iptables -A",
            "iptables -F",
            "systemctl start",
            "systemctl stop",
            "ufw enable",
            "firewall-cmd --add",
        ] {
            assert!(!code.contains(forbidden), "found forbidden {forbidden:?}");
        }
    }
}
