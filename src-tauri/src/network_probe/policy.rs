//! One source of truth for mandatory low-impact collection budgets.
//! Only the probe subprocess is limited; existing SSH/services are untouched.
use std::time::Duration;

pub const COOLDOWN: Duration = Duration::from_secs(60);
pub const CLIENT_TIMEOUT: Duration = Duration::from_secs(5);
pub const CHANNEL_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
pub const REMOTE_TIMEOUT_SECONDS: u64 = 3;
pub const KILL_AFTER_SECONDS: u64 = 1;
pub const CPU_SECONDS: u64 = 1;
pub const NICENESS: u8 = 19;
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
pub const LISTENER_ROWS: usize = 1024;
pub const PEER_ROWS: usize = 384;
pub const INTERFACE_ROWS: usize = 128;

/// Require a runtime that can terminate the collector's process group.
/// A caller cannot opt out of resource limits or silently use BusyBox timeout.
pub fn bound_script(body: &str) -> String {
    // Remote termination is required: closing the SSH channel alone does not
    // prove its descendants stopped. Missing budget tools means no collection.
    let bounded = format!("ulimit -t {CPU_SECONDS} || exit 1\n{body}");
    let quoted = bounded.replace('\'', "'\\''");
    format!(
        r#"nt_timeout=
for nt_candidate in timeout gtimeout; do
  if command -v "$nt_candidate" >/dev/null 2>&1; then
    case "$(LC_ALL=C "$nt_candidate" --version 2>/dev/null)" in
      *"GNU coreutils"*) nt_timeout=$nt_candidate; break ;;
    esac
  fi
done
if [ -z "$nt_timeout" ] || ! command -v nice >/dev/null 2>&1; then
  echo '###NT:hostname###'
  echo 'NT_UNAVAILABLE:GNU timeout and nice required for low-impact collection'
  echo '###NT:end###'
  exit 0
fi
exec "$nt_timeout" -k {KILL_AFTER_SECONDS} {REMOTE_TIMEOUT_SECONDS} nice -n {NICENESS} sh -c '{quoted}'"#
    )
}
