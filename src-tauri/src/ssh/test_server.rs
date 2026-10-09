//! Loopback-only SSH fixture. No shell commands or real server credentials.
use super::{AuthMethod, SshConfig};
use russh::{server, Channel, ChannelId, Pty};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

pub(crate) struct LoopbackSsh {
    pub config: SshConfig,
    pub shells: Arc<AtomicUsize>,
    pub input_bytes: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for LoopbackSsh {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[derive(Clone)]
struct Echo {
    shells: Arc<AtomicUsize>,
    input_bytes: Arc<AtomicUsize>,
}
impl server::Handler for Echo {
    type Error = russh::Error;
    async fn auth_password(&mut self, _: &str, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.shells.fetch_add(1, Ordering::SeqCst);
        session.channel_success(channel)
    }
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.input_bytes.fetch_add(data.len(), Ordering::SeqCst);
        if data == b"fixture-exit" {
            session.data(channel, b"final shell output\r\n".to_vec())?;
            session.eof(channel)?;
            return session.close(channel);
        }
        session.data(channel, data.to_vec())
    }
}

pub(crate) async fn spawn(inactivity_timeout: Duration) -> LoopbackSsh {
    use russh::keys::{
        ssh_key::private::{Ed25519Keypair, KeypairData},
        PrivateKey,
    };
    let key = PrivateKey::new(
        KeypairData::Ed25519(Ed25519Keypair::from_seed(&[42; 32])),
        "loopback-test",
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Arc::new(server::Config {
        keys: vec![key],
        inactivity_timeout: Some(inactivity_timeout),
        auth_rejection_time: Duration::ZERO,
        ..Default::default()
    });
    let shells = Arc::new(AtomicUsize::new(0));
    let input_bytes = Arc::new(AtomicUsize::new(0));
    let handler = Echo {
        shells: shells.clone(),
        input_bytes: input_bytes.clone(),
    };
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let session = server::run_stream(config, stream, handler).await.unwrap();
        let _ = session.await;
    });
    LoopbackSsh {
        config: SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "fixture".into(),
            auth_method: AuthMethod::Password {
                password: "fixture".into(),
            },
            keepalive_interval: Some(5),
            keepalive_max: Some(20),
            proxy: None,
            jump: None,
            host_key_fingerprint: None,
            host_key_verification: false,
        },
        shells,
        input_bytes,
        task,
    }
}
