use crate::ssh::wrap_stream_command;

#[cfg(test)]
mod ssh_contract_tests {
    use crate::ssh::{AuthMethod, SshClient, SshConfig};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    // Test credentials - Replace with your own test server credentials
    const TEST_HOST: &str = "localhost"; // Replace with your test SSH server
    const TEST_USERNAME: &str = "testuser"; // Replace with your test username
    const TEST_PASSWORD: &str = "testpass"; // Replace with your test password
    const TEST_PORT: u16 = 22;

    fn create_test_config() -> SshConfig {
        SshConfig {
            host: TEST_HOST.to_string(),
            port: TEST_PORT,
            username: TEST_USERNAME.to_string(),
            auth_method: AuthMethod::Password {
                password: TEST_PASSWORD.to_string(),
            },
            keepalive_interval: None,
            keepalive_max: None,
            proxy: None,
            jump: None,
            host_key_fingerprint: None,
            host_key_verification: false,
        }
    }

    // Unit test - doesn't require external SSH server
    #[test]
    fn test_ssh_config_creation() {
        let config = create_test_config();
        assert_eq!(config.host, "localhost");
        assert_eq!(config.port, 22);
        assert_eq!(config.username, "testuser");
    }

    // Note: The following tests are integration tests that require a running SSH server.
    // They are marked as ignored to prevent CI failures.
    // To run these tests locally, start an SSH server and run: cargo test -- --ignored --nocapture

    #[tokio::test]
    #[ignore]
    async fn test_ssh_connection() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;
        let config = create_test_config();

        let result = client_write.connect(&config).await;

        assert!(
            result.is_ok(),
            "SSH connection should succeed: {:?}",
            result.err()
        );

        // Disconnect
        let disconnect_result = client_write.disconnect().await;
        assert!(disconnect_result.is_ok(), "Disconnect should succeed");
    }

    #[tokio::test]
    #[ignore]
    async fn test_execute_command() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;
        let config = create_test_config();

        // Connect
        client_write
            .connect(&config)
            .await
            .expect("Failed to connect");

        // Execute command
        let output = client_write
            .execute_command("echo 'test'")
            .await
            .expect("Failed to execute command");

        assert!(
            output.contains("test"),
            "Command output should contain 'test'"
        );

        // Disconnect
        client_write.disconnect().await.ok();
    }

    #[tokio::test]
    #[ignore]
    async fn test_invalid_credentials() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;

        let config = SshConfig {
            host: TEST_HOST.to_string(),
            port: TEST_PORT,
            username: TEST_USERNAME.to_string(),
            auth_method: AuthMethod::Password {
                password: "wrongpassword".to_string(),
            },
            keepalive_interval: None,
            keepalive_max: None,
            proxy: None,
            jump: None,
            host_key_fingerprint: None,
            host_key_verification: false,
        };

        let result = client_write.connect(&config).await;

        assert!(
            result.is_err(),
            "Connection with invalid password should fail"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn test_get_system_stats() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;
        let config = create_test_config();

        // Connect
        client_write
            .connect(&config)
            .await
            .expect("Failed to connect");

        // Get CPU usage
        let cpu_output = client_write
            .execute_command("top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1")
            .await;
        assert!(cpu_output.is_ok(), "Should get CPU stats");

        // Get memory usage
        let mem_output = client_write
            .execute_command("free | grep Mem | awk '{print ($3/$2) * 100.0}'")
            .await;
        assert!(mem_output.is_ok(), "Should get memory stats");

        // Disconnect
        client_write.disconnect().await.ok();
    }

    #[tokio::test]
    #[ignore]
    async fn test_process_list() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;
        let config = create_test_config();

        // Connect
        client_write
            .connect(&config)
            .await
            .expect("Failed to connect");

        // Get process list
        let output = client_write
            .execute_command("ps aux --sort=-%cpu | head -10")
            .await
            .expect("Failed to get process list");

        assert!(!output.is_empty(), "Process list should not be empty");
        assert!(
            output.contains("PID") || output.contains("USER"),
            "Output should contain process info"
        );

        // Disconnect
        client_write.disconnect().await.ok();
    }
}

#[cfg(test)]
mod shell_integration_tests {
    use crate::sftp_client::list_sftp_dir;
    use crate::ssh::{
        bash_shell_integration_command, bash_startup_command, fish_startup_command,
        parse_major_minor, shell_kind_from_path, shell_probe_results, sh_single_quote,
        zsh_startup_command, AuthMethod, BashVersion, PtySession, SshClient, SshConfig,
    };
    use std::time::Duration;
    use tokio::time::{timeout, Instant};

    #[test]
    fn parses_major_and_minor_from_bash_probe_results() {
        assert_eq!(parse_major_minor("5.2.37(1)-release"), Some(BashVersion { major: 5, minor: 2 }));
        assert_eq!(parse_major_minor("4.4.20(1)-release"), Some(BashVersion { major: 4, minor: 4 }));
        assert_eq!(parse_major_minor("5.1.0"), Some(BashVersion { major: 5, minor: 1 }));
    }

    #[test]
    fn rejects_missing_or_malformed_bash_probe_results() {
        for text in ["", "five.two", "5", "junk"] {
            assert_eq!(parse_major_minor(text), None, "text: {text:?}");
        }
    }

    #[test]
    fn shell_probe_classifies_shells_and_versions() {
        use crate::ssh::ShellKind::*;
        assert_eq!(
            shell_probe_results("__NEXTERM_SHELL_PROBE__/bin/bash|5.2.37(1)-release"),
            (Bash, Some(BashVersion { major: 5, minor: 2 }))
        );
        assert_eq!(
            shell_probe_results("banner noise\n__NEXTERM_SHELL_PROBE__/usr/bin/zsh|"),
            (Zsh, None)
        );
        assert_eq!(
            shell_probe_results("__NEXTERM_SHELL_PROBE__/usr/bin/fish|"),
            (Fish, None)
        );
        // No marker at all (probe failed / exotic shell): degrade to generic.
        assert_eq!(shell_probe_results("connection closed"), (Generic, None));
    }

    #[test]
    fn shell_kind_matches_login_shell_basenames() {
        use crate::ssh::ShellKind::*;
        assert_eq!(shell_kind_from_path("/bin/bash"), Bash);
        assert_eq!(shell_kind_from_path("/usr/local/bin/bash"), Bash);
        assert_eq!(shell_kind_from_path("/bin/zsh"), Zsh);
        assert_eq!(shell_kind_from_path("/usr/bin/fish"), Fish);
        assert_eq!(shell_kind_from_path("/bin/sh"), Generic);
        assert_eq!(shell_kind_from_path("/bin/tcsh"), Generic);
        assert_eq!(shell_kind_from_path(""), Generic);
    }

    #[test]
    fn single_quote_escaping_covers_posix_and_fish() {
        assert_eq!(sh_single_quote("plain"), "'plain'");
        assert_eq!(sh_single_quote(""), "''");
        assert_eq!(sh_single_quote("it's"), "'it'\\''s'");
        // Embedded payloads stay inside one POSIX/fish-compatible unit.
        assert!(sh_single_quote("a'b'c").starts_with('\''));
        assert!(sh_single_quote("a'b'c").ends_with('\''));
    }

    #[test]
    fn zsh_startup_command_structure() {
        let command = zsh_startup_command(Some("/srv/release files"));
        assert!(command.contains("mktemp -d"), "must stage a ZDOTDIR proxy dir");
        assert!(command.contains(r#""$__nexterm_zdot/.zshrc""#), "must write a .zshrc shim");
        assert!(command.contains(".zshenv"));
        assert!(command.contains(".zprofile"));
        assert!(command.contains(".zlogin"));
        assert!(command.contains(r#"precmd_functions+=(__nexterm_report_cwd)"#));
        assert!(command.contains(r#""${SHELL:-/bin/zsh}" -l -i"#));
        assert!(command.contains("/srv/release files"), "default directory must be embedded");
        assert!(command.contains("zshexit_functions+=(__nexterm_cleanup)"));
        // No default directory: no cd, everything else stays.
        let bare = zsh_startup_command(None);
        assert!(!bare.contains("cd --"));
        assert!(bare.contains("precmd_functions+="));
    }

    #[test]
    fn fish_startup_command_structure() {
        let command = fish_startup_command(Some("/srv/release files"));
        assert!(command.contains(r#"exec $__nexterm_shell -i -C"#));
        assert!(command.contains("--on-event fish_prompt"));
        // The ST terminator needs printf to see "\\": fish single quotes
        // collapse "\\\\" to "\\".
        assert!(command.contains(r#"'\033]7;file://%s%s\033\\\\'"#));
        // The init payload sits inside an outer single-quoted string, so the
        // inner quotes around the directory are escaped as '\''.
        assert!(command.contains("cd --"));
        assert!(command.contains("/srv/release files"));
        // cd failure degrades to the login directory — never `or exit`
        // (a vanished pre-disconnect cwd must not kill the restored shell).
        assert!(command.contains("or true"));
        // A directory containing a single quote must survive the double
        // quoting (inner -C payload + outer command string); exact runtime
        // behaviour is verified by the docker live test.
        let bare = fish_startup_command(Some("it's dir"));
        assert!(bare.contains("it") && bare.contains("s dir"));
        assert!(!fish_startup_command(None).contains("cd --"));
    }

    #[test]
    fn all_shells_report_executed_commands_via_osc_7777() {
        // bash: PROMPT_COMMAND must run BOTH hooks, and the command hook
        // reads the executed entry via fc (multi-line + HISTCONTROL-safe).
        for version in [
            BashVersion { major: 4, minor: 4 },
            BashVersion { major: 5, minor: 2 },
        ] {
            let command = String::from_utf8(bash_shell_integration_command(version)).unwrap();
            let has_both_hooks = command.contains("__nexterm_report_cwd __nexterm_report_cmd")
                || command.contains("\\n__nexterm_report_cwd\\n__nexterm_report_cmd");
            assert!(has_both_hooks, "PROMPT_COMMAND must include the command hook: {command:?}");
            assert!(command.contains("builtin history 1"));
            assert!(command.contains("__nexterm_last_no"));
            assert!(command.contains("]7777;"));
            assert!(command.contains("| base64"));
        }

        // zsh: zshaddhistory receives the exact submitted line.
        let zsh = zsh_startup_command(None);
        assert!(zsh.contains("zshaddhistory_functions+=(__nexterm_report_cmd)"));
        assert!(zsh.contains("]7777;"));
        assert!(zsh.contains("| base64"));

        // fish: fish_preexec receives the exact submitted line.
        let fish = fish_startup_command(None);
        assert!(fish.contains("--on-event fish_preexec"));
        assert!(fish.contains("]7777;"));
        assert!(fish.contains("| base64"));
    }

    #[test]
    fn uses_scalar_prompt_command_before_bash_5_1() {
        for version in [
            BashVersion { major: 3, minor: 2 },
            BashVersion { major: 4, minor: 4 },
            BashVersion { major: 5, minor: 0 },
        ] {
            let command = String::from_utf8(bash_shell_integration_command(version)).unwrap();
            assert!(
                command
                    .contains("PROMPT_COMMAND+=$'\\n__nexterm_report_cwd\\n__nexterm_report_cmd'")
            );
            assert!(!command.contains("PROMPT_COMMAND=(\"${PROMPT_COMMAND[@]}\""));
        }
    }

    #[test]
    fn uses_prompt_command_array_from_bash_5_1() {
        for version in [
            BashVersion { major: 5, minor: 1 },
            BashVersion { major: 5, minor: 2 },
            BashVersion { major: 6, minor: 0 },
        ] {
            let command = String::from_utf8(bash_shell_integration_command(version)).unwrap();
            assert!(
                command.contains(
                    "PROMPT_COMMAND=(\"${PROMPT_COMMAND[@]}\" __nexterm_report_cwd __nexterm_report_cmd)"
                )
            );
        }
    }

    #[test]
    fn shell_integration_restores_echo_and_emits_osc_7() {
        for version in [
            BashVersion { major: 4, minor: 4 },
            BashVersion { major: 5, minor: 2 },
        ] {
            let command = bash_shell_integration_command(version);
            assert!(command.starts_with(b" stty echo;"));
            assert!(!command
                .windows(b"history -d".len())
                .any(|window| window == b"history -d"));
            assert!(command
                .windows(b"]7;file://".len())
                .any(|window| window == b"]7;file://"));
            assert!(command.ends_with(b"\n"));
        }
    }

    #[test]
    #[cfg(unix)]
    fn startup_reports_directory_preserves_profile_and_keeps_setup_out_of_history() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let fixture = tempfile::tempdir().unwrap();
        let profile = fixture.path().join("profile");
        let history = fixture.path().join("history");
        let working = fixture.path().join("release files'测试");
        std::fs::create_dir(&working).unwrap();
        std::fs::write(
            &profile,
            format!(
                "HISTFILE='{}'; PROMPT_COMMAND='printf profile-hook'; PS1='fixture> ';",
                history.display()
            ),
        )
        .unwrap();
        let mut command =
            bash_startup_command(BashVersion { major: 3, minor: 2 }, working.to_str());
        command = command
            .replace("${SHELL:-/bin/bash}", "/bin/bash")
            .replace("/etc/profile", profile.to_str().unwrap())
            .replace("~/.bash_profile", "/nonexistent-nexterm-profile")
            .replace("~/.bash_login", "/nonexistent-nexterm-login")
            .replace("~/.profile", "/nonexistent-nexterm-legacy");
        let mut child = Command::new("/bin/bash")
            .arg("--noprofile")
            .arg("--norc")
            .arg("-c")
            .arg(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"printf 'user-command\\n'\nhistory\nexit\n")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stdout.contains("]7;file://"));
        assert!(stdout.contains("release%20files'测试"));
        assert!(stdout.contains("profile-hook"));
        let history = std::fs::read_to_string(history).unwrap();
        assert!(history.contains("user-command"));
        assert!(!history.contains("__nexterm_report_cwd"));
        assert!(!history.contains("--rcfile"));
        assert!(!stderr.contains("syntax error"));
    }

    /// Extract the path from an OSC 7 report: `...file://<host><path>ESC \`.
    /// Hostnames never contain `/`, so the path starts at the first `/`
    /// after `file://`. Returns every reported path in order.
    fn osc7_paths(output: &str) -> Vec<String> {
        let mut paths = Vec::new();
        let mut rest = output;
        while let Some(idx) = rest.find("]7;file://") {
            rest = &rest[idx + "]7;file://".len()..];
            let Some(end) = rest.find('\x1b') else { break };
            let report = &rest[..end];
            if let Some(slash) = report.find('/') {
                paths.push(report[slash..].to_string());
            }
            rest = &rest[end..];
        }
        paths
    }

    /// Percent-escape a path the way the shell hooks do (% first, then the
    /// characters the escapes introduce).
    fn osc7_escape(path: &str) -> String {
        path.replace('%', "%25")
            .replace(' ', "%20")
            .replace('#', "%23")
            .replace('?', "%3F")
    }

    #[test]
    #[cfg(all(unix, target_os = "macos"))]
    fn zsh_startup_reports_directory_preserves_profile_and_cleans_up() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let fixture = tempfile::tempdir().unwrap();
        let tmp_root = fixture.path().join("tmp");
        std::fs::create_dir(&tmp_root).unwrap();
        let history = fixture.path().join("history");
        let working = fixture.path().join("release files'测试");
        std::fs::create_dir(&working).unwrap();
        std::fs::write(
            fixture.path().join(".zshrc"),
            format!(
                "HISTFILE='{}'; SAVEHIST=100; PS1='fixture> '; printf 'profile-hook\\n';",
                history.display()
            ),
        )
        .unwrap();
        let mut command = zsh_startup_command(working.to_str());
        command = command.replace("${SHELL:-/bin/zsh}", "/bin/zsh");
        let mut child = Command::new("/bin/zsh")
            .arg("-c")
            .arg(command)
            .env("HOME", fixture.path())
            .env("TMPDIR", &tmp_root)
            .env("SHELL", "/bin/zsh")
            .env_remove("ZDOTDIR")
            .env_remove("HISTFILE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"printf 'user-command\\n'\nhistory\nexit\n")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("]7;file://"), "OSC 7 sequence missing");
        let reported = osc7_paths(&stdout);
        assert!(
            reported.contains(&osc7_escape(working.to_str().unwrap())),
            "OSC 7 must report the default directory exactly; got {reported:?}"
        );
        assert!(
            !reported.iter().any(|path| path.starts_with("%")),
            "zsh substitutions must not misparse (leading % escape): {reported:?}"
        );
        assert!(stdout.contains("profile-hook"), "user .zshrc must be sourced");
        let history = std::fs::read_to_string(&history).unwrap_or_default();
        assert!(!history.contains("__nexterm_report_cwd"));
        assert!(!history.contains("ZDOTDIR"));
        // The ZDOTDIR staging directory must be removed by the zshexit hook.
        let leftovers: Vec<_> = std::fs::read_dir(&tmp_root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("nexterm-zsh."))
            .collect();
        assert!(leftovers.is_empty(), "ZDOTDIR staging dirs must be cleaned");
    }

    async fn read_until(pty: &PtySession, needle: &[u8]) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut output = Vec::new();
        while !output.windows(needle.len()).any(|window| window == needle) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for PTY output");
            let chunk = timeout(remaining, async { pty.output_rx.lock().await.recv().await })
                .await
                .expect("timed out waiting for PTY output")
                .expect("PTY output channel closed");
            output.extend_from_slice(&chunk);
        }
        output
    }

    async fn send_and_expect_cwd(pty: &PtySession, command: &str, expected_path: &str) {
        let mut input = command.as_bytes().to_vec();
        input.push(b'\n');
        pty.input_tx.send(input).await.expect("send shell command");

        let output = read_until(pty, b"\x1b\\").await;
        assert!(
            String::from_utf8_lossy(&output).contains(expected_path),
            "OSC 7 output should contain {expected_path:?}"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn docker_ssh_reports_cwd_and_lists_sftp_directories() {
        let mut client = SshClient::new();
        client
            .connect(&SshConfig {
                host: std::env::var("NEXTERM_TEST_SSH_HOST")
                    .unwrap_or_else(|_| "nexterm-test-ssh".to_string()),
                port: 22,
                username: "testuser".to_string(),
                auth_method: AuthMethod::Password {
                    password: "testpass".to_string(),
                },
                keepalive_interval: Some(60),
                keepalive_max: Some(3),
                proxy: None,
                jump: None,
                host_key_fingerprint: None,
                host_key_verification: false,
            })
            .await
            .expect("connect to Docker SSH server");

        let pty = client
            .create_pty_session(80, 24, None)
            .await
            .expect("create PTY");
        let initial_output = read_until(&pty, b"\x1b\\").await;
        assert!(
            String::from_utf8_lossy(&initial_output).contains("/home/testuser"),
            "initial OSC 7 should report the login directory"
        );

        send_and_expect_cwd(
            &pty,
            "cd '/srv/release files/子目录'",
            "/srv/release%20files/子目录",
        )
        .await;
        send_and_expect_cwd(&pty, "cd ..", "/srv/release%20files").await;
        send_and_expect_cwd(&pty, "cd '子目录'", "/srv/release%20files/子目录").await;
        send_and_expect_cwd(&pty, "cd -", "/srv/release%20files").await;
        send_and_expect_cwd(&pty, "cd ~", "/home/testuser").await;
        send_and_expect_cwd(
            &pty,
            "pushd '/srv/release files/子目录'",
            "/srv/release%20files/子目录",
        )
        .await;
        send_and_expect_cwd(&pty, "popd", "/home/testuser").await;

        let sftp = client.open_sftp_session().await.expect("open SFTP");
        let root_entries = list_sftp_dir(&sftp, "/srv/release files")
            .await
            .expect("list directory over SFTP");
        assert!(root_entries.iter().any(|entry| entry.name == "子目录"));
        let nested_entries = list_sftp_dir(&sftp, "/srv/release files/子目录")
            .await
            .expect("list nested directory over SFTP");
        assert!(nested_entries
            .iter()
            .any(|entry| entry.name == "report 1.txt"));
    }
}

// ── Key-loading unit tests (no SSH server required) ──────────────────────────

#[cfg(test)]
mod key_loading_tests {
    use crate::ssh::{AuthMethod, SshClient, SshConfig};
    use russh::keys::{decode_secret_key, encode_pkcs8_pem};
    use std::io::Write;
    use tempfile::NamedTempFile;

    /// A fixed, unencrypted Ed25519 OpenSSH private key (generated with
    /// `ssh-keygen -t ed25519 -N ""`). Embedded so the tests do not need an
    /// RNG dependency; PKCS#8 PEM is produced from it for round-trip checks.
    const ED25519_OPENSSH: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCG5iGVmQMQ4cF1/JXqpxi7K1nP/hCodQiHNdsUUOf6rgAAALDuREJ77kRC
ewAAAAtzc2gtZWQyNTUxOQAAACCG5iGVmQMQ4cF1/JXqpxi7K1nP/hCodQiHNdsUUOf6rg
AAAED88KKLVgwOR34Tp2zuywVChVUH7fljjjEEAd4P9buXo4bmIZWZAxDhwXX8leqnGLsr
Wc/+EKh1CIc12xRQ5/quAAAAKmd1b2ppYW5mZW5nQGd1b2ppYW5mZW5nZGVNYWNCb29rLV
Byby5sb2NhbAECAw==
-----END OPENSSH PRIVATE KEY-----
";

    /// Return a fresh Ed25519 key pair's PKCS#8 PEM encoding as a `String` with
    /// Unix (`\n`) line endings.
    fn generate_pem_lf() -> String {
        let key = decode_secret_key(ED25519_OPENSSH, None).expect("embedded key must decode");
        let mut buf = Vec::new();
        encode_pkcs8_pem(&key, &mut buf).expect("PEM encoding must succeed");
        String::from_utf8(buf).expect("PEM is valid UTF-8")
    }

    // ── 1. Baseline: decode from key content with LF line endings ────────────

    #[test]
    fn test_decode_secret_key_with_lf_content() {
        let pem = generate_pem_lf();
        assert!(pem.contains("-----BEGIN"), "Should be a PEM-encoded key");
        let result = decode_secret_key(&pem, None);
        assert!(
            result.is_ok(),
            "decode_secret_key should succeed with LF-only PEM content: {:?}",
            result.err()
        );
    }

    // ── 2. CRLF fix: key content normalised from \r\n to \n must parse OK ───

    #[test]
    fn test_decode_secret_key_after_crlf_normalisation() {
        let pem_lf = generate_pem_lf();
        // Simulate a Windows-created file by converting every \n to \r\n.
        let pem_crlf = pem_lf.replace('\n', "\r\n");

        // Sanity check: raw CRLF content should fail (or at least shows the
        // parser is sensitive to line endings on some platforms — we normalise
        // before calling decode_secret_key so users never hit this).
        // We don't assert failure here because behaviour may vary; what matters
        // is that after normalisation it always succeeds.

        let normalised = pem_crlf.replace("\r\n", "\n");
        let result = decode_secret_key(&normalised, None);
        assert!(
            result.is_ok(),
            "decode_secret_key should succeed after CRLF→LF normalisation: {:?}",
            result.err()
        );
    }

    // ── 3. Bug repro: passing a file *path* string directly fails ────────────
    //    This confirms why the old code was broken on every platform.

    #[test]
    fn test_decode_secret_key_rejects_file_path_string() {
        // A file path is not valid PEM content — decode must fail.
        let fake_path = if cfg!(windows) {
            r"C:\Users\leeec\.ssh\id_rsa"
        } else {
            "/home/user/.ssh/id_rsa"
        };
        let result = decode_secret_key(fake_path, None);
        assert!(
            result.is_err(),
            "decode_secret_key should reject a bare file path string"
        );
    }

    // ── 4. Missing key file returns a clear error ─────────────────────────────

    #[tokio::test]
    async fn test_connect_missing_key_file_returns_error() {
        use crate::ssh::{AuthMethod, SshClient, SshConfig};

        let config = SshConfig {
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: AuthMethod::PublicKey {
                key_path: "/nonexistent/path/id_rsa".to_string(),
                passphrase: None,
            },
            keepalive_interval: None,
            keepalive_max: None,
            proxy: None,
            jump: None,
            host_key_fingerprint: None,
            host_key_verification: false,
        };

        let mut client = SshClient::new();
        let err = client.connect(&config).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("not found")
                || msg.contains("SSH key file")
                || msg.contains("Connection refused"),
            "Error should mention the missing file, got: {msg}"
        );
    }

    // ── 5. Key loaded from a temp file (via read+decode) succeeds ────────────
    //    This mirrors the code path that was fixed: read file → normalise → decode.

    #[test]
    fn test_key_round_trip_via_file() {
        let pem = generate_pem_lf();

        let mut tmp = NamedTempFile::new().expect("tempfile creation must succeed");
        tmp.write_all(pem.as_bytes()).expect("write must succeed");
        tmp.flush().unwrap();

        // Replicate the fixed code path exactly.
        let content = std::fs::read_to_string(tmp.path()).expect("read_to_string must succeed");
        let content = content.replace("\r\n", "\n");
        let result = decode_secret_key(&content, None);
        assert!(
            result.is_ok(),
            "Key round-tripped through a file should decode successfully: {:?}",
            result.err()
        );
    }

    // ── 6. CRLF key written to file still loads correctly after normalisation ─

    #[test]
    fn test_crlf_key_file_round_trip() {
        let pem_crlf = generate_pem_lf().replace('\n', "\r\n");

        let mut tmp = NamedTempFile::new().expect("tempfile creation must succeed");
        tmp.write_all(pem_crlf.as_bytes())
            .expect("write must succeed");
        tmp.flush().unwrap();

        let content = std::fs::read_to_string(tmp.path()).expect("read_to_string must succeed");
        let normalised = content.replace("\r\n", "\n");
        let result = decode_secret_key(&normalised, None);
        assert!(
            result.is_ok(),
            "CRLF key written to file should parse after normalisation: {:?}",
            result.err()
        );
    }

    // ── 7. Tilde expansion: ~\ (Windows) and ~/ (Unix) both expand ───────────

    #[test]
    fn test_tilde_expansion_unix_style() {
        // ~/some/path — the tilde portion must be replaced with the home dir.
        let path = "~/.ssh/id_rsa".to_string();
        let expanded = expand_tilde(&path);
        assert!(
            !expanded.starts_with('~'),
            "Unix-style tilde should be expanded, got: {expanded}"
        );
    }

    #[test]
    fn test_tilde_expansion_windows_style() {
        // ~\some\path — Windows convention.
        let path = r"~\.ssh\id_rsa".to_string();
        let expanded = expand_tilde(&path);
        assert!(
            !expanded.starts_with('~'),
            "Windows-style tilde should be expanded, got: {expanded}"
        );
    }

    #[test]
    fn test_no_tilde_path_unchanged() {
        let path = "/absolute/path/to/key".to_string();
        let expanded = expand_tilde(&path);
        assert_eq!(expanded, path, "Path without tilde should be unchanged");
    }

    /// Replication of the tilde-expansion logic from `SshClient::connect` so it
    /// can be tested independently without constructing a full `SshConfig`.
    fn expand_tilde(key_path: &str) -> String {
        if key_path.starts_with("~/") || key_path.starts_with("~\\") {
            if let Some(home) = dirs::home_dir() {
                let home_str = home.to_string_lossy();
                return key_path.replacen('~', &home_str, 1);
            }
        }
        key_path.to_string()
    }

    #[tokio::test]
    #[ignore = "requires the local Docker OpenSSH fixture on port 22222"]
    async fn docker_pty_survives_parallel_sftp_upload() {
        let config = SshConfig {
            host: "127.0.0.1".to_string(),
            port: 22222,
            username: "test".to_string(),
            auth_method: AuthMethod::Password {
                password: "testpass".to_string(),
            },
            keepalive_interval: None,
            keepalive_max: None,
            proxy: None,
            jump: None,
            host_key_fingerprint: None,
            host_key_verification: false,
        };
        let mut client = SshClient::new();
        client
            .connect(&config)
            .await
            .expect("connect Docker SSH fixture");
        let pty = client
            .create_pty_session(80, 24, None)
            .await
            .expect("start PTY");

        let temp = tempfile::NamedTempFile::new().expect("create upload fixture");
        std::fs::write(temp.path(), vec![b'x'; 8 * 1024 * 1024]).expect("write upload fixture");
        client
            .upload_file(
                temp.path().to_str().expect("UTF-8 temp path"),
                "/home/test/nexterm-transfer-test.bin",
            )
            .await
            .expect("upload while PTY is active");

        pty.input_tx
            .send(b"echo NEXTERM_PTY_STILL_ALIVE\n".to_vec())
            .await
            .expect("write PTY input");
        let output = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let mut seen = Vec::new();
            loop {
                let bytes = pty
                    .output_rx
                    .lock()
                    .await
                    .recv()
                    .await
                    .expect("PTY output before close");
                seen.extend_from_slice(&bytes);
                if String::from_utf8_lossy(&seen).contains("NEXTERM_PTY_STILL_ALIVE") {
                    return seen;
                }
            }
        })
        .await
        .expect("PTY remained responsive after SFTP upload");
        assert!(String::from_utf8_lossy(&output).contains("NEXTERM_PTY_STILL_ALIVE"));
    }
}

// DisconnectReason handling: Error(Disconnect) — the universal mapping for
// a clean end-of-connection (our probe / disconnect()) — must NOT produce a
// warning path; it returns Ok like every other reason.
#[tokio::test]
async fn disconnected_clean_end_is_ok() {
    use russh::client::Handler;
    let mut client = super::Client::new(None, false);
    let reason = russh::client::DisconnectReason::Error(russh::Error::Disconnect);
    let res = client.disconnected(reason).await;
    assert!(res.is_ok(), "clean Disconnect must not fail");
}

#[tokio::test]
async fn disconnected_received_is_ok() {
    use russh::client::Handler;
    let mut client = super::Client::new(None, false);
    let info = russh::client::RemoteDisconnectInfo {
        reason_code: russh::Disconnect::ByApplication,
        message: String::new(),
        lang_tag: String::new(),
    };
    let res = client
        .disconnected(russh::client::DisconnectReason::ReceivedDisconnect(info))
        .await;
    assert!(res.is_ok(), "received disconnect must not fail");
}

#[test]
fn wrap_stream_command_escapes_and_keeps_shape() {
    // Plain command: trap + background + parked read, single-quoted body.
    let wrapped = wrap_stream_command("tail -f /var/log/app.log");
    assert!(wrapped.starts_with("sh -c 'trap \"kill -TERM 0 2>/dev/null\" EXIT HUP TERM; { tail -f /var/log/app.log; kill -TERM $$ 2>/dev/null; } & read _ || true'"),
        "unexpected wrapper: {wrapped}");

    // Embedded single quotes must be escaped, never terminate the outer quote.
    let tricky = wrap_stream_command("journalctl -u 'my service' -f");
    assert!(
        tricky.contains(r"journalctl -u '\''my service'\'' -f"),
        "quote escaping broken: {tricky}"
    );
    // The outer shell string still ends where it should (last ' closes the
    // sh -c argument): count via the parked-read tail anchor.
    assert!(
        tricky.ends_with("read _ || true'"),
        "wrapper tail anchor lost: {tricky}"
    );
}
