use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use tokio::sync::{Mutex, OnceCell};

/// Detected OS family of a remote host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OsFamily {
    /// Debian, Ubuntu, Linux Mint, Pop!_OS, etc.
    Debian,
    /// RHEL, CentOS, Fedora, Rocky, AlmaLinux, Amazon Linux, Oracle Linux
    RedHat,
    /// Alpine Linux (musl-based, BusyBox coreutils)
    Alpine,
    /// openSUSE, SLES
    Suse,
    /// Arch Linux, Manjaro
    Arch,
    /// Generic Linux — has /proc but we couldn't identify the family
    GenericLinux,
    /// macOS / Darwin
    MacOS,
    /// FreeBSD / OpenBSD / NetBSD
    Bsd,
    /// Completely unknown
    Unknown,
}

/// Cached information about a remote host's OS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsInfo {
    pub family: OsFamily,
    /// Raw ID from /etc/os-release (e.g. "ubuntu", "centos", "alpine")
    pub id: String,
    /// Human-readable name (e.g. "Ubuntu 22.04 LTS")
    pub pretty_name: String,
    /// Whether the `ss` command is available (vs only `netstat`)
    pub has_ss: bool,
    /// Whether `top` supports `-bn1` batch mode (BusyBox top uses `-bn1` too but output differs)
    pub has_procps_top: bool,
    /// Whether GNU coreutils are available (vs BusyBox)
    pub has_gnu_coreutils: bool,
}

impl Default for OsInfo {
    fn default() -> Self {
        Self {
            family: OsFamily::Unknown,
            id: String::new(),
            pretty_name: String::new(),
            has_ss: true,
            has_procps_top: true,
            has_gnu_coreutils: true,
        }
    }
}

/// Per-connection OS info cache.
///
/// Uses one `OnceCell` per connection so that concurrent callers share a
/// single in-flight detection rather than each spawning their own.
pub struct OsInfoCache {
    cells: Arc<Mutex<HashMap<String, Arc<OnceCell<OsInfo>>>>>,
}

impl OsInfoCache {
    pub fn new() -> Self {
        Self {
            cells: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Return the cached OS info, running `init` exactly once per connection.
    /// Concurrent callers for the same `connection_id` block until the first
    /// detection completes, then all receive the same cached result.
    pub async fn get_or_init<F, Fut>(&self, connection_id: &str, init: F) -> OsInfo
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = OsInfo>,
    {
        let cell = {
            let mut cells = self.cells.lock().await;
            cells
                .entry(connection_id.to_string())
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };
        cell.get_or_init(init).await.clone()
    }

    /// Remove cached info when a connection is closed.
    pub async fn remove(&self, connection_id: &str) {
        self.cells.lock().await.remove(connection_id);
    }
}

/// Detect the remote OS by running a lightweight probe command over SSH.
///
/// The detection runs a single compound command that reads /etc/os-release,
/// falls back to uname, and probes for tool availability — all in one
/// round-trip to minimise latency.
pub async fn detect_os(client: &crate::ssh::SshClient) -> OsInfo {
    // Single compound command — works on virtually every POSIX system.
    // We collect:
    //   1. ID and PRETTY_NAME from /etc/os-release
    //   2. uname -s as fallback kernel name
    //   3. Probe for ss, procps top, and GNU coreutils
    let probe = r#"
(
  # 1. /etc/os-release (present on all modern distros)
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "ID=${ID:-unknown}"
    echo "PRETTY_NAME=${PRETTY_NAME:-unknown}"
    echo "ID_LIKE=${ID_LIKE:-}"
  else
    echo "ID=unknown"
    echo "PRETTY_NAME=unknown"
    echo "ID_LIKE="
  fi

  # 2. Kernel name
  echo "UNAME=$(uname -s 2>/dev/null || echo unknown)"

  # 3. Tool probes
  command -v ss >/dev/null 2>&1 && echo "HAS_SS=1" || echo "HAS_SS=0"

  # procps-ng top prints "top -" in its version line; BusyBox prints "BusyBox"
  if top -v 2>&1 | head -1 | grep -qi busybox; then
    echo "HAS_PROCPS_TOP=0"
  else
    echo "HAS_PROCPS_TOP=1"
  fi

  # GNU ls supports --version; BusyBox does not
  if ls --version 2>&1 | head -1 | grep -qi 'GNU\|coreutils'; then
    echo "HAS_GNU_COREUTILS=1"
  else
    echo "HAS_GNU_COREUTILS=0"
  fi
)
"#;

    let output = match client.execute_command(probe).await {
        Ok(o) => o,
        Err(_) => return OsInfo::default(),
    };

    let mut id = String::new();
    let mut pretty_name = String::new();
    let mut id_like = String::new();
    let mut uname = String::new();
    let mut has_ss = true;
    let mut has_procps_top = true;
    let mut has_gnu_coreutils = true;

    for line in output.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("ID=") {
            id = val.trim_matches('"').to_lowercase();
        } else if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
            pretty_name = val.trim_matches('"').to_string();
        } else if let Some(val) = line.strip_prefix("ID_LIKE=") {
            id_like = val.trim_matches('"').to_lowercase();
        } else if let Some(val) = line.strip_prefix("UNAME=") {
            uname = val.to_lowercase();
        } else if let Some(val) = line.strip_prefix("HAS_SS=") {
            has_ss = val == "1";
        } else if let Some(val) = line.strip_prefix("HAS_PROCPS_TOP=") {
            has_procps_top = val == "1";
        } else if let Some(val) = line.strip_prefix("HAS_GNU_COREUTILS=") {
            has_gnu_coreutils = val == "1";
        }
    }

    let family = classify_family(&id, &id_like, &uname);

    OsInfo {
        family,
        id,
        pretty_name,
        has_ss,
        has_procps_top,
        has_gnu_coreutils,
    }
}

/// Classify the OS family from the ID, ID_LIKE, and uname fields.
fn classify_family(id: &str, id_like: &str, uname: &str) -> OsFamily {
    // Check ID first (exact match)
    match id {
        "debian" | "ubuntu" | "linuxmint" | "pop" | "elementary" | "zorin" | "kali"
        | "raspbian" | "deepin" | "kylin" => return OsFamily::Debian,

        "rhel" | "centos" | "fedora" | "rocky" | "almalinux" | "ol" | "amzn" | "scientific"
        | "eurolinux" | "anolis" | "openeuler" | "tencentos" | "alinux" => return OsFamily::RedHat,

        "alpine" => return OsFamily::Alpine,

        "opensuse-leap" | "opensuse-tumbleweed" | "sles" | "suse" => return OsFamily::Suse,

        "arch" | "manjaro" | "endeavouros" | "garuda" => return OsFamily::Arch,

        _ => {}
    }

    // Check ID_LIKE for derivative distros
    for token in id_like.split_whitespace() {
        match token {
            "debian" | "ubuntu" => return OsFamily::Debian,
            "rhel" | "fedora" | "centos" => return OsFamily::RedHat,
            "suse" | "opensuse" => return OsFamily::Suse,
            "arch" => return OsFamily::Arch,
            _ => {}
        }
    }

    // Fallback to uname
    match uname {
        "darwin" => OsFamily::MacOS,
        "freebsd" | "openbsd" | "netbsd" => OsFamily::Bsd,
        "linux" => OsFamily::GenericLinux,
        _ => OsFamily::Unknown,
    }
}

// ─── Distro-aware command builders ───────────────────────────────────────────

impl OsInfo {
    /// CPU usage percentage command.
    ///
    /// procps `top` (Debian/RHEL/Arch/SUSE) outputs `%Cpu(s): … id …`
    /// BusyBox `top` (Alpine) outputs `CPU:  X% usr  Y% sys … Z% idle`
    /// macOS uses `top -l1` with a different format.
    /// Fallback: read /proc/stat twice (works everywhere with /proc).
    pub fn cpu_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS => "top -l1 -n0 | awk '/CPU usage/{gsub(/%/,\"\"); print 100-$7}'",
            OsFamily::Alpine if !self.has_procps_top => {
                // BusyBox top: "CPU:   5% usr   2% sys   0% nic  92% idle ..."
                // Run one iteration in batch mode, extract idle%, compute 100-idle
                "top -bn1 2>/dev/null | awk '/^CPU:/{gsub(/%/,\"\"); for(i=1;i<=NF;i++) if($(i+1)==\"idle\") {print 100-$i; exit}}' || cat /proc/stat | awk '/^cpu /{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf \"%.1f\\n\", u*100/t}'"
            }
            _ => {
                // procps top or /proc/stat fallback
                "top -bn1 2>/dev/null | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}' || cat /proc/stat | awk '/^cpu /{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf \"%.1f\\n\", u*100/t}'"
            }
        }
    }

    /// Memory stats command — `free -m` is universal on Linux.
    /// macOS needs vm_stat + sysctl.
    pub fn memory_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS => {
                "vm_stat | awk '/Pages (free|active|inactive|speculative|wired)/{gsub(/\\./,\"\"); sum+=$NF} END{used=sum*4096/1048576; total='\"$(sysctl -n hw.memsize)\"'/1048576; free=total-used; printf \"%d %d %d %d\", total, used, free, free}'"
            }
            _ => {
                "free -m 2>/dev/null | awk 'NR==2{printf \"%s %s %s %s\", $2,$3,$4,$7}' || awk '/MemTotal/{t=$2} /MemFree/{f=$2} /MemAvailable/{a=$2} /Buffers/{b=$2} /^Cached:/{c=$2} END{u=t-f-b-c; printf \"%d %d %d %d\", t/1024, u/1024, f/1024, a/1024}' /proc/meminfo"
            }
        }
    }

    /// Swap stats command.
    pub fn swap_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS => {
                "sysctl vm.swapusage 2>/dev/null | awk '{gsub(/M/,\"\"); printf \"%d %d %d\", $4, $7, $10}' || echo '0 0 0'"
            }
            _ => {
                "free -m 2>/dev/null | awk 'NR==3{printf \"%s %s %s\", $2,$3,$4}' || awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{printf \"%d %d %d\", t/1024, (t-f)/1024, f/1024}' /proc/meminfo"
            }
        }
    }

    /// Root disk in POSIX's stable one-line KiB layout. Parsing happens in Rust
    /// so remote hosts do not need awk, sed, grep, or GNU df extensions.
    pub fn disk_cmd(&self) -> &'static str {
        "LC_ALL=C df -kP / 2>/dev/null"
    }

    /// Uptime command.
    ///
    /// `uptime -p` is a procps extension (not on BusyBox, old CentOS 6, macOS).
    /// Fallback: parse /proc/uptime or plain `uptime` output.
    pub fn uptime_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::Alpine if !self.has_gnu_coreutils => {
                "cat /proc/uptime 2>/dev/null | awk '{d=int($1/86400); h=int($1%86400/3600); m=int($1%3600/60); if(d>0) printf \"up %d day(s), %d:%02d\", d, h, m; else printf \"up %d:%02d\", h, m}' || uptime | sed 's/.*up /up /' | sed 's/,.*//' "
            }
            OsFamily::MacOS => {
                "uptime | sed 's/.*up /up /' | sed 's/,.*//' "
            }
            _ => {
                // Try uptime -p first (procps), fall back to /proc/uptime parsing
                "uptime -p 2>/dev/null || cat /proc/uptime 2>/dev/null | awk '{d=int($1/86400); h=int($1%86400/3600); m=int($1%3600/60); if(d>0) printf \"up %d day(s), %d:%02d\", d, h, m; else printf \"up %d:%02d\", h, m}' || uptime | sed 's/.*up /up /' | sed 's/,.*//' "
            }
        }
    }

    /// Load average command — works everywhere.
    pub fn load_average_cmd(&self) -> &'static str {
        "uptime | awk -F'load average:' '{print $2}' | xargs"
    }

    /// One shell script that emits ALL system stats (cpu / memory / swap /
    /// disk / uptime / cores / load) in one SSH round-trip, each section
    /// prefixed with a unique marker. Cuts per-probe RTT from ~7 commands to 1.
    pub fn all_in_one_stats_cmd(&self) -> String {
        let mut script = String::new();
        script.push_str("echo \"===CPU===\"; ");
        script.push_str(self.cpu_cmd());
        script.push_str("; echo \"===MEM===\"; ");
        script.push_str(self.memory_cmd());
        script.push_str("; echo \"===SWAP===\"; ");
        script.push_str(self.swap_cmd());
        script.push_str("; echo \"===DISK===\"; ");
        script.push_str(self.disk_cmd());
        script.push_str("; echo \"===UPTIME===\"; ");
        script.push_str(self.uptime_cmd());
        script.push_str("; echo \"===CORES===\"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1; ");
        script.push_str("echo \"===LOAD===\"; ");
        script.push_str(self.load_average_cmd());
        script.push_str("; echo \"===END===\"");
        script
    }

    /// Parse the output of [`all_in_one_stats_cmd`] back into its sections.
    /// Returns (cpu, memory, swap, disk, uptime, cores, load).
    pub fn parse_all_in_one_stats(
        &self,
        output: &str,
    ) -> Option<(String, String, String, String, String, u32, String)> {
        let mut cpu = String::new();
        let mut memory = String::new();
        let mut swap = String::new();
        let mut disk = String::new();
        let mut uptime = String::new();
        let mut cores: u32 = 1;
        let mut load = String::new();
        let mut section = "";
        for line in output.lines() {
            let t = line.trim();
            if let Some(name) = t.strip_prefix("===").and_then(|s| s.strip_suffix("===")) {
                section = name;
                continue;
            }
            match section {
                "CPU" => cpu.push_str(t),
                "MEM" => memory.push_str(t),
                "SWAP" => swap.push_str(t),
                "DISK" => disk.push_str(t),
                "UPTIME" => uptime.push_str(t),
                "CORES" => {
                    if let Ok(n) = t.parse::<u32>() {
                        cores = n.max(1);
                    }
                }
                "LOAD" => load.push_str(t),
                _ => {}
            }
        }
        if cpu.is_empty() && memory.is_empty() && disk.is_empty() {
            return None;
        }
        Some((cpu, memory, swap, disk, uptime, cores, load))
    }

    /// Process list command.
    ///
    /// `ps aux --sort` is a GNU/procps extension.
    /// BusyBox `ps` has a completely different output format.
    /// macOS `ps` supports `-r` (sort by CPU) and `-m` (sort by memory).
    pub fn process_cmd(&self, sort_by: &str) -> String {
        match self.family {
            OsFamily::MacOS => {
                let flag = if sort_by == "mem" { "-amx" } else { "-arx" };
                format!("ps {} -o user=,pid=,pcpu=,pmem=,command= | head -50", flag)
            }
            OsFamily::Alpine if !self.has_procps_top => {
                // BusyBox ps doesn't support --sort. Use ps + sort pipeline.
                let sort_col = if sort_by == "mem" { "4" } else { "3" };
                format!(
                    "ps aux 2>/dev/null | head -1; ps aux 2>/dev/null | tail -n +2 | sort -k{} -rn | head -49",
                    sort_col
                )
            }
            _ => {
                // procps ps with --sort (Debian, RHEL, Arch, SUSE, generic Linux)
                let sort_option = if sort_by == "mem" { "-%mem" } else { "-%cpu" };
                format!(
                    "ps aux --sort={} 2>/dev/null | head -50 || {{ ps aux 2>/dev/null | head -1; ps aux 2>/dev/null | tail -n +2 | sort -k{} -rn | head -49; }}",
                    sort_option,
                    if sort_by == "mem" { "4" } else { "3" }
                )
            }
        }
    }

    /// Disk usage details command.
    ///
    /// `df -hT` (show filesystem type) is a GNU extension.
    /// BusyBox and macOS `df` don't support `-T`.
    pub fn disk_usage_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS => {
                // macOS df -h output: Filesystem Size Used Avail Capacity iused ifree %iused Mounted
                "df -h | grep -v 'tmpfs\\|devfs\\|Filesystem\\|map ' | awk '{print $1\"|\"$9\"|\"$2\"|\"$3\"|\"$4\"|\"$5}' | head -10"
            }
            OsFamily::Alpine if !self.has_gnu_coreutils => {
                // BusyBox df: no -T flag. Output: Filesystem Size Used Available Use% Mounted
                "df -h 2>/dev/null | grep -v 'tmpfs\\|devtmpfs\\|Filesystem' | awk '{print $1\"|\"$6\"|\"$2\"|\"$3\"|\"$4\"|\"$5}' | head -10"
            }
            _ => {
                // GNU df -hT: Filesystem Type Size Used Avail Use% Mounted
                "df -hT 2>/dev/null | grep -v 'tmpfs\\|devtmpfs\\|Filesystem' | awk '{print $1\"|\"$7\"|\"$3\"|\"$4\"|\"$5\"|\"$6}' | head -10 || df -h 2>/dev/null | grep -v 'tmpfs\\|devtmpfs\\|Filesystem' | awk '{print $1\"|\"$6\"|\"$2\"|\"$3\"|\"$4\"|\"$5}' | head -10"
            }
        }
    }

    /// Network interface stats — /sys/class/net is Linux-only.
    /// macOS uses `netstat -ibn`.
    pub fn network_stats_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS => {
                r#"netstat -ibn | awk 'NR>1 && $1!="lo" && $4!="" {print $1","$7","$10","$5","$8}'"#
            }
            _ => {
                // /sys/class/net works on all Linux distros (Debian, RHEL, Alpine, etc.)
                r#"
for iface in /sys/class/net/*; do
    name=$(basename $iface)
    if [ "$name" != "lo" ]; then
        rx_bytes=$(cat $iface/statistics/rx_bytes 2>/dev/null || echo 0)
        tx_bytes=$(cat $iface/statistics/tx_bytes 2>/dev/null || echo 0)
        rx_packets=$(cat $iface/statistics/rx_packets 2>/dev/null || echo 0)
        tx_packets=$(cat $iface/statistics/tx_packets 2>/dev/null || echo 0)
        echo "$name,$rx_bytes,$tx_bytes,$rx_packets,$tx_packets"
    fi
done
"#
            }
        }
    }

    /// Network bandwidth sampling command (two reads 1s apart).
    pub fn network_bandwidth_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS => {
                // macOS: use netstat -ibn twice
                r#"
iface_list=$(netstat -ibn | awk 'NR>1 && $1!="lo0" && $4!="" {print $1}' | sort -u)
for iface in $iface_list; do
    vals=$(netstat -ibn | awk -v i="$iface" '$1==i && $4!="" {print $7","$10; exit}')
    echo "$iface,$vals"
done
sleep 1
for iface in $iface_list; do
    vals=$(netstat -ibn | awk -v i="$iface" '$1==i && $4!="" {print $7","$10; exit}')
    echo "$iface,$vals"
done
"#
            }
            _ => {
                // /sys/class/net works on all Linux distros
                r#"
iface_list=""
for iface in /sys/class/net/*; do
    name=$(basename $iface)
    if [ "$name" != "lo" ]; then
        iface_list="$iface_list $name"
    fi
done

for iface in $iface_list; do
    rx1=$(cat /sys/class/net/$iface/statistics/rx_bytes 2>/dev/null || echo 0)
    tx1=$(cat /sys/class/net/$iface/statistics/tx_bytes 2>/dev/null || echo 0)
    echo "$iface,$rx1,$tx1"
done
sleep 1
for iface in $iface_list; do
    rx2=$(cat /sys/class/net/$iface/statistics/rx_bytes 2>/dev/null || echo 0)
    tx2=$(cat /sys/class/net/$iface/statistics/tx_bytes 2>/dev/null || echo 0)
    echo "$iface,$rx2,$tx2"
done
"#
            }
        }
    }

    /// Active network connections command.
    /// Prefers `ss` (modern), falls back to `netstat`.
    pub fn active_connections_cmd(&self) -> &'static str {
        if self.has_ss {
            "ss -tunp 2>/dev/null | tail -n +2 | head -50"
        } else {
            "netstat -tunp 2>/dev/null | tail -n +3 | head -50"
        }
    }

    /// List files command.
    /// GNU ls supports `--time-style=long-iso`; BusyBox and macOS do not.
    pub fn list_files_cmd(&self, path: &str) -> String {
        fn shell_quote(value: &str) -> String {
            format!("'{}'", value.replace('\'', "'\"'\"'"))
        }

        let quoted_path = shell_quote(path);
        if self.has_gnu_coreutils {
            format!("ls -la --time-style=long-iso {}", quoted_path)
        } else {
            // BusyBox / macOS ls — no --time-style, but -la still works
            format!("ls -la {}", quoted_path)
        }
    }

    // ── Network topology probe commands ───────────────────────────────────────
    // 只读探测（READ-ONLY）：下面所有命令都是查询类命令，绝不包含
    //   · `>` / `>>` 重定向写文件
    //   · 包管理命令（apt / yum / apk / …）
    //   · `iptables -A/-F`、`firewall-cmd --add-*`、`systemctl start/stop`
    //     、`ufw enable/disable` 等任何变更操作
    // 零安装（ZERO-INSTALL）：只使用系统自带工具；工具缺失时对应分段输出
    // `NT_UNAVAILABLE:<段名>`，由解析层标记 `unavailable` 而不是判定为失败，
    // 且任一分段失败都不会中断后续分段（脚本内不使用 `set -e`）。

    /// Read the kernel hostname only; never resolve an FQDN through DNS/NSS.
    pub fn hostname_probe_cmd(&self) -> &'static str {
        "{ uname -n 2>/dev/null || echo \"NT_UNAVAILABLE:hostname\"; } | head -n 1"
    }

    /// OS release probe — `/etc/os-release` on Linux, `sw_vers` on macOS.
    pub fn os_release_probe_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS => {
                "{ sw_vers 2>/dev/null; uname -sr 2>/dev/null; } || echo \"NT_UNAVAILABLE:os\""
            }
            OsFamily::Bsd => {
                "{ uname -sr 2>/dev/null; freebsd-version 2>/dev/null; } || echo \"NT_UNAVAILABLE:os\""
            }
            _ => {
                "{ grep -E '^(ID|PRETTY_NAME)=' /etc/os-release 2>/dev/null; uname -sr 2>/dev/null; } || echo \"NT_UNAVAILABLE:os\""
            }
        }
    }

    /// Interface probe — `ip -o addr` on Linux, `ifconfig -a` on BSD/macOS.
    pub fn interfaces_probe_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS | OsFamily::Bsd => {
                "ifconfig -a 2>/dev/null || echo \"NT_UNAVAILABLE:interfaces\""
            }
            _ => {
                "ip -o addr 2>/dev/null || ifconfig -a 2>/dev/null || echo \"NT_UNAVAILABLE:interfaces\""
            }
        }
    }

    /// Scan each local kernel socket table once, emitting listeners first and
    /// then bounded established/other peers. Busy servers cannot push their
    /// listening ports out of a fixed prefix. Every omitted row is marked.
    pub fn proc_sockets_probe_cmd(&self) -> String {
        format!(r#"
echo "NT_PROC_BEGIN"
for spec in "tcp /proc/net/tcp" "tcp6 /proc/net/tcp6" "udp /proc/net/udp" "udp6 /proc/net/udp6"; do
    set -- $spec
    proto=$1
    path=$2
    if [ -r "$path" ]; then
        printf 'NT_PROC_FILE\t%s\t%s\n' "$proto" "$path"
        awk -v proto="$proto" -v max_listeners={listeners} -v max_peers={peers} '
          NR == 1 {{ print; next }}
          {{
            is_listener = (proto == "tcp" ? $4 == "0A" : $4 == "07")
            if (is_listener) {{
              if (++listener_count <= max_listeners) print
              else listener_partial = 1
              next
            }}
            split($3, remote, ":")
            if (remote[2] == "0000" || remote[2] == "") next
            if ($4 == "01") {{
              active_count++
              if (!(remote[1] in seen_remote) && unique_count < max_peers) {{
                seen_remote[remote[1]] = 1
                active_unique[++unique_count] = $0
              }} else if (++extra_count <= max_peers) {{
                active_extra[extra_count] = $0
              }}
            }} else {{
              if (++other_count <= max_peers) other[other_count] = $0
            }}
          }}
          END {{
            emitted = 0
            for (i = 1; i <= unique_count && emitted < max_peers; i++) {{ print active_unique[i]; emitted++ }}
            for (i = 1; i <= extra_count && emitted < max_peers; i++) {{ print active_extra[i]; emitted++ }}
            for (i = 1; i <= other_count && emitted < max_peers; i++) {{ print other[i]; emitted++ }}
            if (listener_partial) print "NT_LISTEN_PARTIAL"
            if (active_count + other_count >= max_peers + 1) print "NT_PEER_PARTIAL"
          }}' "$path" 2>/dev/null || echo "NT_PROC_PARTIAL"
    elif [ "$proto" = tcp ] || [ "$proto" = udp ]; then
        echo "NT_PROC_PARTIAL"
    fi
done
echo "NT_PROC_END"
"#, listeners = crate::network_probe::policy::LISTENER_ROWS, peers = crate::network_probe::policy::PEER_ROWS)
    }

    /// Mandatory low-impact snapshot. Read only metadata, limited interfaces
    /// and limited Linux socket rows. The caller supplies remote runtime limits.
    /// Legacy firewall arguments cannot enable process walks or rule dumps.
    pub fn topology_probe_cmd(&self, _include_firewall: bool) -> String {
        // Low-impact collection is mandatory even for older callers requesting
        // firewall data. No process/fd traversal and no firewall dump is allowed.
        let mut s = String::from("nt_limit() { awk -v n=\"$1\" 'NR<=n {print} NR==n+1 {print \"NT_PARTIAL:sample limit\"; exit}'; }\n");
        s.push_str("echo \"###NT:hostname###\"; ");
        s.push_str(self.hostname_probe_cmd());
        s.push_str("\necho \"###NT:os###\"; ");
        s.push_str(self.os_release_probe_cmd());
        s.push_str("\necho \"###NT:interfaces###\"; { ");
        s.push_str(self.interfaces_probe_cmd());
        s.push_str(&format!("; }} | nt_limit {}\n", crate::network_probe::policy::INTERFACE_ROWS));
        if matches!(self.family, OsFamily::MacOS | OsFamily::Bsd) {
            // netstat's kernel snapshot can itself scale with every socket.
            // Fail closed until a bounded native source is available.
            s.push_str("echo \"###NT:ports###\"; echo \"NT_UNAVAILABLE:bounded socket source unavailable\"\n");
            s.push_str("echo \"###NT:peers###\"; echo \"NT_UNAVAILABLE:bounded socket source unavailable\"\n");
        } else {
            s.push_str("echo \"###NT:proc_sockets###\";\n");
            s.push_str(&self.proc_sockets_probe_cmd());
        }
        s.push_str("echo \"###NT:fdmap###\"; echo \"NT_SKIPPED:low-impact policy\"\n");
        s.push_str("echo \"###NT:end###\"");
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_debian() {
        assert_eq!(classify_family("ubuntu", "", "linux"), OsFamily::Debian);
        assert_eq!(classify_family("debian", "", "linux"), OsFamily::Debian);
        assert_eq!(
            classify_family("linuxmint", "ubuntu debian", "linux"),
            OsFamily::Debian
        );
    }

    #[test]
    fn test_classify_redhat() {
        assert_eq!(classify_family("centos", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("rhel", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("fedora", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("rocky", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("almalinux", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("amzn", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("ol", "", "linux"), OsFamily::RedHat);
    }

    #[test]
    fn test_classify_alpine() {
        assert_eq!(classify_family("alpine", "", "linux"), OsFamily::Alpine);
    }

    #[test]
    fn test_classify_suse() {
        assert_eq!(
            classify_family("opensuse-leap", "", "linux"),
            OsFamily::Suse
        );
        assert_eq!(classify_family("sles", "", "linux"), OsFamily::Suse);
    }

    #[test]
    fn test_classify_arch() {
        assert_eq!(classify_family("arch", "", "linux"), OsFamily::Arch);
        assert_eq!(classify_family("manjaro", "", "linux"), OsFamily::Arch);
    }

    #[test]
    fn test_classify_by_id_like() {
        assert_eq!(
            classify_family("pop", "ubuntu debian", "linux"),
            OsFamily::Debian
        );
        assert_eq!(
            classify_family("eurolinux", "rhel fedora centos", "linux"),
            OsFamily::RedHat
        );
    }

    #[test]
    fn test_classify_macos() {
        assert_eq!(classify_family("unknown", "", "darwin"), OsFamily::MacOS);
    }

    #[test]
    fn test_classify_unknown_linux() {
        assert_eq!(
            classify_family("unknown", "", "linux"),
            OsFamily::GenericLinux
        );
    }

    #[test]
    fn test_process_cmd_fallback() {
        let info = OsInfo {
            family: OsFamily::Alpine,
            has_procps_top: false,
            has_gnu_coreutils: false,
            ..Default::default()
        };
        let cmd = info.process_cmd("cpu");
        assert!(cmd.contains("sort -k3"));
    }

    #[test]
    fn test_disk_usage_cmd_gnu() {
        let info = OsInfo {
            family: OsFamily::Debian,
            has_gnu_coreutils: true,
            ..Default::default()
        };
        let cmd = info.disk_usage_cmd();
        assert!(cmd.contains("df -hT"));
    }

    #[test]
    fn test_disk_usage_cmd_busybox() {
        let info = OsInfo {
            family: OsFamily::Alpine,
            has_gnu_coreutils: false,
            ..Default::default()
        };
        let cmd = info.disk_usage_cmd();
        assert!(!cmd.starts_with("df -hT"));
    }

    #[test]
    fn test_list_files_gnu() {
        let info = OsInfo {
            has_gnu_coreutils: true,
            ..Default::default()
        };
        assert!(info.list_files_cmd("/tmp").contains("--time-style"));
    }

    #[test]
    fn test_list_files_busybox() {
        let info = OsInfo {
            has_gnu_coreutils: false,
            ..Default::default()
        };
        assert!(!info.list_files_cmd("/tmp").contains("--time-style"));
    }

    #[test]
    fn test_list_files_quotes_apostrophes() {
        let info = OsInfo {
            has_gnu_coreutils: true,
            ..Default::default()
        };

        assert_eq!(
            info.list_files_cmd("/tmp/dir's folder"),
            "ls -la --time-style=long-iso '/tmp/dir'\"'\"'s folder'"
        );
    }

    #[test]
    fn test_topology_probe_cmd_section_order() {
        let full = OsInfo::default().topology_probe_cmd(true);
        let order = [
            "###NT:hostname###", "###NT:os###", "###NT:interfaces###",
            "###NT:proc_sockets###", "###NT:fdmap###", "###NT:end###",
        ];
        let mut cursor = 0usize;
        for marker in order {
            let at = full[cursor..]
                .find(marker)
                .unwrap_or_else(|| panic!("missing {marker} after offset {cursor}"));
            cursor += at + marker.len();
        }
        // The routing table is no longer collected at all.
        assert!(!full.contains("###NT:routes###"));
        // Firewall sections are omitted even when a legacy caller requests them.
        let cached = OsInfo::default().topology_probe_cmd(false);
        assert!(!cached.contains("###NT:firewall###"));
        assert!(!cached.contains("###NT:rules###"));
        assert!(cached.contains("###NT:fdmap###"));
    }

    #[test]
    fn test_topology_probe_cmd_is_read_only() {
        // Legacy firewall requests must still produce the low-impact script.
        let script = OsInfo::default().topology_probe_cmd(true);
        // Only inspect executable lines — the header comment deliberately
        // *mentions* the constructs it promises never to use.
        let code: String = script
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n");
        // 只读保证：不得出现任何写文件重定向、包管理或服务变更命令。
        for forbidden in [
            "set -e",
            " > ",
            ">>",
            " | tee",
            "sed -i",
            "chmod ",
            "chown ",
            "kill ",
            "pkill ",
            "reboot",
            "shutdown",
            "mkfs",
            "mount ",
            "umount ",
            "dd ",
            "nc ",
            "/dev/tcp",
            "ping ",
            "traceroute",
            "hostname -f",
            "dig ",
            "nslookup ",
            "curl ",
            "wget ",
            "apt ",
            "yum ",
            "apk ",
            "dnf ",
            "pkg ",
            "iptables -A",
            "iptables -F",
            "iptables -I",
            "iptables -X",
            "iptables -Z",
            "iptables -N",
            "nft add",
            "nft delete",
            "nft insert",
            "nft flush",
            "systemctl start",
            "systemctl stop",
            "systemctl restart",
            "service ",
            "ufw enable",
            "ufw disable",
            "ufw allow",
            "ufw deny",
            "ufw delete",
            "firewall-cmd --add",
            "firewall-cmd --remove",
            "readlink ",
        ] {
            assert!(
                !code.contains(forbidden),
                "probe script must stay read-only, found {forbidden:?}"
            );
        }
    }

    #[test]
    fn test_topology_probe_cmd_uses_whitelist_commands_only() {
        // The v2.18.1 contract: exactly these remote commands, nothing else
        // beyond shell builtins. Anything new must be justified + whitelisted
        // here (and stay read-only, see the test above).
        let script = OsInfo {
            family: OsFamily::Debian,
            ..Default::default()
        }
        .topology_probe_cmd(true);
        for required in [
            "uname -n",
            "ip -o addr",
            "/proc/net/tcp",
            "-v max_listeners=1024",
            "-v max_peers=384",
        ] {
            assert!(script.contains(required), "probe must use {required:?}");
        }
        // The per-fd readlink storm and the routing dump are gone.
        assert!(!script.contains("NT_PROC_PROCESS"));
        assert!(!script.contains("ip route"));
        assert!(!script.contains("for fd in"));
    }

    #[test]
    fn test_topology_probe_cmd_busybox_and_macos_fallbacks() {
        let script = OsInfo {
            family: OsFamily::Alpine,
            has_ss: false,
            has_gnu_coreutils: false,
            ..Default::default()
        }
        .topology_probe_cmd(true);
        assert!(script.contains("/proc/net/tcp"));
        // Even on BusyBox hosts, never fall back to traversing every process.
        assert!(!script.contains("/proc/[0-9]*/fd"));

        let macos = OsInfo {
            family: OsFamily::MacOS,
            ..Default::default()
        }
        .topology_probe_cmd(true);
        assert!(macos.contains("ifconfig -a"));
        assert!(!macos.contains("pfctl"));
        assert!(!macos.contains("netstat"));
        assert!(macos.contains("NT_SKIPPED:low-impact policy"));
    }


}

#[cfg(test)]
mod all_in_one_tests {
    use super::*;

    fn linux_os() -> OsInfo {
        OsInfo {
            family: OsFamily::Debian,
            ..Default::default()
        }
    }

    #[test]
    fn script_contains_all_markers() {
        let script = linux_os().all_in_one_stats_cmd();
        for marker in [
            "===CPU===",
            "===MEM===",
            "===SWAP===",
            "===DISK===",
            "===UPTIME===",
            "===CORES===",
            "===LOAD===",
        ] {
            assert!(script.contains(marker), "missing {marker} in script");
        }
    }

    #[test]
    fn parses_realistic_output() {
        let output = "===CPU===\n3.2\n===MEM===\n7865 2048 5817 5120\n===SWAP===\n2048 0 2048\n===DISK===\n98G 12G 81G 13%\n===UPTIME===\nup 3 days, 4:32\n===CORES===\n4\n===LOAD===\n0.15 0.10 0.08\n===END===";
        let os = linux_os();
        let (cpu, mem, swap, disk, uptime, cores, load) =
            os.parse_all_in_one_stats(output).unwrap();
        assert_eq!(cpu, "3.2");
        assert_eq!(mem, "7865 2048 5817 5120");
        assert_eq!(swap, "2048 0 2048");
        assert_eq!(disk, "98G 12G 81G 13%");
        assert_eq!(uptime, "up 3 days, 4:32");
        assert_eq!(cores, 4);
        assert_eq!(load, "0.15 0.10 0.08");
    }

    #[test]
    fn empty_output_is_none() {
        let os = linux_os();
        assert!(os.parse_all_in_one_stats("===END===").is_none());
    }
}
