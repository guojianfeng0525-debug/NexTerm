//! RDP remote desktop client built on the IronRDP crate suite.
//!
//! Connection flow (`connect`):
//! 1. Open a byte stream to the target — either a direct TCP connection or an
//!    SSH jump-host tunnel (`crate::jump::connect_via_jump`, the equivalent of
//!    OpenSSH's `ProxyJump`).
//! 2. Drive the RDP connection sequence with `ironrdp-tokio`'s official
//!    helpers (`connect_begin` → TLS upgrade → `connect_finalize`; X.224
//!    negotiation, NLA/CredSSP authentication and capability exchange), with
//!    the CLIPRDR (clipboard) static channel and the DRDYNVC dynamic-channel
//!    multiplexer (display control) attached up front.
//! 3. Spawn the active-session task that decodes graphics updates into RGBA
//!    dirty rectangles and forwards keyboard/mouse/clipboard events the
//!    other way.
//!
//! The stream type is erased (`Box<dyn AsyncReadWrite>`) so the jump-host
//! `ChannelStream` and `TcpStream` share one code path. Since ironrdp-tokio
//! 0.10, `TokioFramed`'s futures are `Send` for such streams, so the session
//! task runs directly under `tokio::spawn`.

use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use ironrdp::cliprdr;
use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
    OwnedFormatDataResponse,
};
use ironrdp::connector;
use ironrdp::connector::connection_activation::ConnectionActivationState;
use ironrdp::connector::ConnectionResult;
use ironrdp::core::AsAny;
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::input::{MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::session::fast_path;
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStageBuilder, ActiveStageOutput, SessionResult};
use ironrdp_tls as tls;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::desktop_protocol::{DesktopEvent, DesktopProtocol, FrameUpdate, RdpConfig};

/// Bound for the internal event channel. When the WebSocket consumer is
/// slower than the RDP graphics pipeline, delta frames are dropped and a full
/// frame is emitted as soon as the channel has room again (self-healing).
const EVENT_CHANNEL_CAPACITY: usize = 4;

/// Pointer mask bits (JavaScript `MouseEvent.buttons` + wheel flags).
const BUTTON_LEFT: u8 = 0x01;
const BUTTON_RIGHT: u8 = 0x02;
const BUTTON_MIDDLE: u8 = 0x04;
const WHEEL_UP: u8 = 0x08;
const WHEEL_DOWN: u8 = 0x10;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transport (shared with the VNC client — see `desktop_transport.rs`)
// ---------------------------------------------------------------------------

use crate::desktop_transport::{open_stream, BoxedStream};

// ---------------------------------------------------------------------------
// Network client for CredSSP/Kerberos
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Clipboard backend
// ---------------------------------------------------------------------------

/// Events flowing from the CLIPRDR backend to the session loop.
enum CliprdrLoopEvent {
    /// The remote pasted and requests our local clipboard content.
    FormatDataRequest,
    /// The remote clipboard now advertises CF_UNICODETEXT — fetch the text.
    RemoteCopy,
    /// Decoded text from a remote FormatDataResponse (our paste request).
    RemoteText(String),
}

/// Minimal text-only CLIPRDR backend.
///
/// - Local → remote: `set_clipboard` stores the text; when the remote pastes,
///   the server sends a FormatDataRequest which the backend forwards to the
///   session loop, which answers with the stored text.
/// - Remote → local: when the remote clipboard announces CF_UNICODETEXT the
///   backend asks the session loop to pull the text, which is decoded here
///   and surfaced as `RemoteText` → `DesktopEvent::ClipboardText`.
#[derive(Debug)]
struct TextClipboardBackend {
    events: mpsc::UnboundedSender<CliprdrLoopEvent>,
}

impl AsAny for TextClipboardBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl CliprdrBackend for TextClipboardBackend {
    fn temporary_directory(&self) -> &str {
        ""
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
    }

    fn on_ready(&mut self) {}

    fn on_request_format_list(&mut self) {
        // We advertise our clipboard to the remote on demand (set_clipboard).
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        let has_text = available_formats
            .iter()
            .any(|format| format.id == ClipboardFormatId::CF_UNICODETEXT);
        if has_text {
            let _ = self.events.send(CliprdrLoopEvent::RemoteCopy);
        }
    }

    fn on_format_data_request(&mut self, _request: FormatDataRequest) {
        let _ = self.events.send(CliprdrLoopEvent::FormatDataRequest);
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            return;
        }
        if let Some(text) = decode_unicode_text(response.data()) {
            let _ = self.events.send(CliprdrLoopEvent::RemoteText(text));
        }
    }

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {}

    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}

    fn on_process_negotiated_capabilities(&mut self, _capabilities: ClipboardGeneralCapabilityFlags) {}
}

/// Decode UTF-16LE clipboard bytes (NUL-terminated) into a Rust string.
fn decode_unicode_text(mut data: &[u8]) -> Option<String> {
    if data.len() < 2 {
        return None;
    }
    // Strip the trailing NUL terminator.
    if data.len().is_multiple_of(2) && data.ends_with(&[0, 0]) {
        data = &data[..data.len() - 2];
    }
    let units: Vec<u16> = data
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

/// Encode text as NUL-terminated UTF-16LE clipboard bytes.
fn encode_unicode_text(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity((text.len() + 1) * 2);
    for unit in text.encode_utf16().chain(std::iter::once(0)) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

// ---------------------------------------------------------------------------
// Input events (frontend → session loop)
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum RdpInput {
    /// Scancode (set-1 code + extended flag), translated from a JS keyCode.
    /// `caps_lock`/`num_lock` carry the client toggle state when the event is
    /// a lock key — Windows hosts track toggles via sync events, not raw
    /// scancodes, so a CapsLock press also emits a synchronize event.
    Key { extended: bool, code: u8, down: bool, caps_lock: Option<bool>, num_lock: Option<bool> },
    /// Pointer state — JS `MouseEvent.buttons` + wheel flags. See
    /// `DesktopProtocol` docs for the bit layout.
    Pointer { x: u16, y: u16, button_mask: u8 },
    /// Local clipboard text changed.
    SetClipboard(String),
    /// Display resize request (display-control channel).
    Resize { width: u16, height: u16 },
    Close,
}

// ---------------------------------------------------------------------------
// Output events (session loop → client)
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum RdpEvent {
    Frame(FrameUpdate),
    ClipboardText(String),
    Resized { width: u16, height: u16 },
    Terminated(String),
}

impl From<RdpEvent> for DesktopEvent {
    fn from(event: RdpEvent) -> Self {
        match event {
            RdpEvent::Frame(frame) => DesktopEvent::Frame(frame),
            RdpEvent::ClipboardText(text) => DesktopEvent::ClipboardText(text),
            RdpEvent::Resized { width, height } => DesktopEvent::Resized { width, height },
            RdpEvent::Terminated(reason) => DesktopEvent::Terminated(reason),
        }
    }
}

// ---------------------------------------------------------------------------
// JS keyCode → PS/2 set-1 scancode mapping
// ---------------------------------------------------------------------------

/// Map a JavaScript `KeyboardEvent.keyCode` to an RDP set-1 scancode
/// (`(extended, code)`). Returns `None` for keys without a direct scancode.
pub fn js_keycode_to_scancode(key_code: u32) -> Option<(bool, u8)> {
    match key_code {
        // Digits (top row): JS keyCode == ASCII; set-1: '1'=0x02 … '9'=0x0A, '0'=0x0B.
        0x31..=0x39 => Some((false, (key_code - 0x31 + 0x02) as u8)),
        0x30 => Some((false, 0x0B)),
        // Letters — US QWERTY scan-code layout (set-1).
        // Q W E R T Y U I O P
        0x51 => Some((false, 0x10)),
        0x57 => Some((false, 0x11)),
        0x45 => Some((false, 0x12)),
        0x52 => Some((false, 0x13)),
        0x54 => Some((false, 0x14)),
        0x59 => Some((false, 0x15)),
        0x55 => Some((false, 0x16)),
        0x49 => Some((false, 0x17)),
        0x4F => Some((false, 0x18)),
        0x50 => Some((false, 0x19)),
        // A S D F G H J K L
        0x41 => Some((false, 0x1E)),
        0x53 => Some((false, 0x1F)),
        0x44 => Some((false, 0x20)),
        0x46 => Some((false, 0x21)),
        0x47 => Some((false, 0x22)),
        0x48 => Some((false, 0x23)),
        0x4A => Some((false, 0x24)),
        0x4B => Some((false, 0x25)),
        0x4C => Some((false, 0x26)),
        // Z X C V B N M
        0x5A => Some((false, 0x2C)),
        0x58 => Some((false, 0x2D)),
        0x43 => Some((false, 0x2E)),
        0x56 => Some((false, 0x2F)),
        0x42 => Some((false, 0x30)),
        0x4E => Some((false, 0x31)),
        0x4D => Some((false, 0x32)),
        0x20 => Some((false, 0x39)), // Space
        0x0D => Some((false, 0x1C)), // Enter
        0x1B => Some((false, 0x01)), // Escape
        0x08 => Some((false, 0x0E)), // Backspace
        0x09 => Some((false, 0x0F)), // Tab
        0x14 => Some((false, 0x3A)), // CapsLock
        0x25 => Some((true, 0x4B)),  // Left
        0x26 => Some((true, 0x48)),  // Up
        0x27 => Some((true, 0x4D)),  // Right
        0x28 => Some((true, 0x50)),  // Down
        0x21 => Some((true, 0x49)),  // PageUp
        0x22 => Some((true, 0x51)),  // PageDown
        0x23 => Some((true, 0x4F)),  // End
        0x24 => Some((true, 0x47)),  // Home
        0x2D => Some((true, 0x52)),  // Insert
        0x2E => Some((true, 0x53)),  // Delete
        0x90 => Some((false, 0x45)), // NumLock
        0x91 => Some((false, 0x46)), // ScrollLock
        // Punctuation (US layout).
        0xBA => Some((false, 0x27)), // ;:
        0xBB => Some((false, 0x0D)), // =+
        0xBC => Some((false, 0x33)), // ,<
        0xBD => Some((false, 0x0C)), // -_
        0xBE => Some((false, 0x34)), // .>
        0xBF => Some((false, 0x35)), // /?
        0xC0 => Some((false, 0x29)), // `~
        0xDB => Some((false, 0x1A)), // [{
        0xDC => Some((false, 0x2B)), // \|
        0xDD => Some((false, 0x1B)), // ]}
        0xDE => Some((false, 0x28)), // '"
        // Numpad.
        0x60 => Some((false, 0x52)), // Numpad 0
        0x61 => Some((false, 0x4F)), // Numpad 1
        0x62 => Some((false, 0x50)), // Numpad 2
        0x63 => Some((false, 0x51)), // Numpad 3
        0x64 => Some((false, 0x4B)), // Numpad 4
        0x65 => Some((false, 0x4C)), // Numpad 5
        0x66 => Some((false, 0x4D)), // Numpad 6
        0x67 => Some((false, 0x47)), // Numpad 7
        0x68 => Some((false, 0x48)), // Numpad 8
        0x69 => Some((false, 0x49)), // Numpad 9
        0x6A => Some((false, 0x37)), // Numpad *
        0x6B => Some((false, 0x4A)), // Numpad -
        0x6D => Some((false, 0x4E)), // Numpad +
        0x6E => Some((false, 0x53)), // Numpad .
        0x6F => Some((true, 0x35)),  // Numpad /
        // Function keys.
        0x70..=0x79 => Some((false, (key_code - 0x70 + 0x3B) as u8)), // F1-F10
        0x7A => Some((false, 0x57)), // F11
        0x7B => Some((false, 0x58)), // F12
        // Modifiers.
        0xA0 => Some((false, 0x2A)), // Left Shift
        0xA1 => Some((false, 0x36)), // Right Shift
        0xA2 => Some((false, 0x1D)), // Left Ctrl
        0xA3 => Some((true, 0x1D)),  // Right Ctrl
        0xA4 => Some((false, 0x38)), // Left Alt
        0xA5 => Some((true, 0x38)),  // Right Alt (AltGr)
        0x5B => Some((true, 0x5B)),  // Left Meta (Windows)
        0x5C => Some((true, 0x5C)),  // Right Meta
        0x5D => Some((true, 0x5D)),  // Context menu
        0x2C => Some((true, 0x37)),  // PrintScreen
        _ => {
            tracing::debug!(key_code, "Unmapped JS keyCode dropped");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// RdpClient
// ---------------------------------------------------------------------------

pub struct RdpClient {
    desktop_width: u16,
    desktop_height: u16,
    connected: bool,
    input_tx: Option<mpsc::UnboundedSender<RdpInput>>,
    event_rx: Arc<Mutex<Option<mpsc::Receiver<RdpEvent>>>>,
    cancel: Option<CancellationToken>,
}

impl RdpClient {
    /// Establish the RDP session and start the active-session task.
    pub async fn connect(config: &RdpConfig) -> Result<Self> {
        if config.host.is_empty() {
            return Err(anyhow::anyhow!("RDP host cannot be empty"));
        }
        if config.username.is_empty() {
            return Err(anyhow::anyhow!(
                "RDP username is required for NLA authentication"
            ));
        }

        let opened = open_stream(&config.host, config.port, config.jump_host.as_ref()).await?;
        let client_addr = opened.client_addr();
        let stream: BoxedStream = opened.stream;
        let mut framed = SendPduFramed::new(stream, bytes::BytesMut::new());

        let connector_config = build_connector_config(config);
        let mut connector = connector::ClientConnector::new(connector_config, client_addr);

        // Attach the CLIPRDR static channel (clipboard sync) and the DRDYNVC
        // multiplexer (display-control resize support) before the connection
        // sequence so the channels are negotiated up front.
        let (cliprdr_events_tx, cliprdr_events_rx) = mpsc::unbounded_channel();
        connector.attach_static_channel(cliprdr::CliprdrClient::new(Box::new(TextClipboardBackend {
            events: cliprdr_events_tx,
        })));
        let display_control =
            DisplayControlClient::new(|_capabilities| Ok::<_, ironrdp::pdu::PduError>(Vec::new()));
        connector
            .attach_static_channel(DrdynvcClient::new().with_dynamic_channel(display_control));

        // X.224 connection request / confirmation (mirrors
        // `ironrdp_async::connect_begin`, driven manually over the
        // provably-Send framing — see `SendPduFramed` docs).
        let mut buf = ironrdp::pdu::WriteBuf::new();
        while !connector.should_perform_security_upgrade() {
            step_sequence(&mut framed, &mut connector, &mut buf)
                .await
                .map_err(|e| anyhow::anyhow!("RDP connection negotiation failed: {e}"))?;
        }

        let (initial_stream, leftover) = framed.into_parts();
        let (tls_stream, tls_cert) = tls::upgrade(initial_stream, &config.host)
            .await
            .map_err(|e| anyhow::anyhow!("RDP TLS upgrade failed: {e}"))?;

        connector.mark_security_upgrade_as_done();

        let mut upgraded_framed = SendPduFramed::new(Box::new(tls_stream) as BoxedStream, leftover);

        let server_public_key = tls::extract_tls_server_public_key(&tls_cert)
            .ok_or_else(|| anyhow::anyhow!("Failed to extract the RDP server public key"))?
            .to_owned();

        // NLA/CredSSP + connection finalization (mirrors
        // `ironrdp_async::connect_finalize` without the Kerberos network
        // client, which is not needed for NTLM authentication).
        let mut buf = ironrdp::pdu::WriteBuf::new();
        if connector.should_perform_credssp() {
            perform_credssp(
                &mut upgraded_framed,
                &mut connector,
                &mut buf,
                config.host.clone().into(),
                server_public_key,
            )
            .await
            .map_err(|e| anyhow::anyhow!("RDP authentication failed: {e}"))?;
        }
        let connection_result: ConnectionResult = loop {
            step_sequence(&mut upgraded_framed, &mut connector, &mut buf)
                .await
                .map_err(|e| anyhow::anyhow!("RDP connection failed: {e}"))?;
            if let connector::ClientConnectorState::Connected { result } = connector.state {
                break result;
            }
        };

        let desktop_width = connection_result.desktop_size.width;
        let desktop_height = connection_result.desktop_size.height;

        let (input_tx, input_rx) = mpsc::unbounded_channel();
        let (event_tx, event_rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let cancel = CancellationToken::new();

        // The session task emits a `Terminated` event on every exit path; a
        // panic closes the event channel, which also ends the consumer loop.
        tokio::spawn(run_session(
            upgraded_framed,
            connection_result,
            input_rx,
            cliprdr_events_rx,
            event_tx,
            cancel.child_token(),
        ));

        tracing::info!(
            "RDP connected to {}:{} ({}x{})",
            config.host,
            config.port,
            desktop_width,
            desktop_height
        );

        Ok(Self {
            desktop_width,
            desktop_height,
            connected: true,
            input_tx: Some(input_tx),
            event_rx: Arc::new(Mutex::new(Some(event_rx))),
            cancel: Some(cancel),
        })
    }

    fn send_input(&self, input: RdpInput) -> Result<()> {
        let tx = self
            .input_tx
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("RDP client is not connected"))?;
        tx.send(input)
            .map_err(|_| anyhow::anyhow!("RDP session has ended"))
    }
}

// ---------------------------------------------------------------------------
// Connector config
// ---------------------------------------------------------------------------

fn build_connector_config(config: &RdpConfig) -> connector::Config {
    connector::Config {
        credentials: connector::Credentials::UsernamePassword {
            username: config.username.clone(),
            password: config.password.clone(),
        },
        domain: config.domain.clone(),
        // Prefer NLA (CredSSP); allow the legacy TLS graphical login as a
        // fallback so servers without NLA still connect.
        enable_tls: true,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize {
            width: config.width,
            height: config.height,
        },
        bitmap: None,
        client_build: 0,
        client_name: "NexTerm".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        #[cfg(target_os = "macos")]
        platform: MajorPlatformType::MACINTOSH,
        #[cfg(target_os = "windows")]
        platform: MajorPlatformType::WINDOWS,
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        platform: MajorPlatformType::UNIX,
        enable_server_pointer: true,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        pointer_software_rendering: false,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        // Keep bulk compression off: the session crate has not wired
        // slow-path decompression yet (see ironrdp-session's TODO).
        compression_type: None,
        multitransport_flags: None,
    }
}

// ---------------------------------------------------------------------------
// Send-safe PDU framing
// ---------------------------------------------------------------------------

/// A PDU framing wrapper over a plain tokio stream half.
///
/// `ironrdp_async::Framed`'s read futures go through a generic-associated-type
/// (`ReadFut<'read>`) whose trait declaration lacks a `Send` bound, so futures
/// holding it cannot be proven `Send` for `tokio::spawn` (rustc higher-ranked
/// lifetime limitation). This wrapper reimplements `read_pdu`/`read_by_hint`
/// (mirroring `ironrdp-async`'s own logic) on top of `tokio::io` extension
/// traits, whose futures are provably `Send` for concrete stream types.
struct SendPduFramed<S> {
    stream: S,
    buf: bytes::BytesMut,
}

impl<S> SendPduFramed<S> {
    fn new(stream: S, leftover: bytes::BytesMut) -> Self {
        Self { stream, buf: leftover }
    }

    /// Splits the wrapper back into the raw stream and the unread buffer.
    fn into_parts(self) -> (S, bytes::BytesMut) {
        (self.stream, self.buf)
    }
}

impl<S> SendPduFramed<S>
where
    S: AsyncRead + Unpin,
{
    fn peek(&self) -> &[u8] {
        &self.buf
    }

    /// Reads from the stream into the internal buffer.
    async fn read_more(&mut self) -> std::io::Result<usize> {
        use tokio::io::AsyncReadExt as _;
        self.stream.read_buf(&mut self.buf).await
    }

    /// Accumulates exactly `length` bytes, keeping the leftover buffered.
    async fn read_exact(&mut self, length: usize) -> std::io::Result<bytes::BytesMut> {
        loop {
            if self.buf.len() >= length {
                return Ok(self.buf.split_to(length));
            }
            self.buf
                .reserve(length.checked_sub(self.buf.len()).expect("length > buf.len()"));
            let len = self.read_more().await?;
            if len == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "not enough bytes",
                ));
            }
        }
    }

    /// Reads a standard RDP PDU frame.
    async fn read_pdu(&mut self) -> std::io::Result<(ironrdp::pdu::Action, bytes::BytesMut)> {
        loop {
            match ironrdp::pdu::find_size(self.peek()) {
                Ok(Some(pdu_info)) => {
                    let frame = self.read_exact(pdu_info.length).await?;
                    return Ok((pdu_info.action, frame));
                }
                Ok(None) => {
                    let len = self.read_more().await?;
                    if len == 0 {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "not enough bytes",
                        ));
                    }
                }
                Err(e) => return Err(std::io::Error::other(e)),
            }
        }
    }

    /// Reads a frame matching the given PDU hint (used by the
    /// deactivation-reactivation sequence).
    async fn read_by_hint(
        &mut self,
        hint: &dyn ironrdp::pdu::PduHint,
    ) -> std::io::Result<bytes::Bytes> {
        loop {
            match hint.find_size(self.peek()).map_err(std::io::Error::other)? {
                Some((matched, length)) => {
                    let bytes = self.read_exact(length).await?.freeze();
                    if matched {
                        return Ok(bytes);
                    }
                    tracing::debug!("Received and lost an unexpected PDU");
                }
                None => {
                    let len = self.read_more().await?;
                    if len == 0 {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "not enough bytes",
                        ));
                    }
                }
            }
        }
    }
}

impl<S> SendPduFramed<S>
where
    S: AsyncWrite + Unpin,
{
    /// Writes the whole buffer and flushes.
    async fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        use tokio::io::AsyncWriteExt as _;
        self.stream.write_all(buf).await?;
        self.stream.flush().await
    }
}

/// Drives one step of a connector `Sequence`: reads the next PDU (if the
/// sequence expects input), lets the sequence process it, and writes any
/// produced output. Mirrors `ironrdp_async::single_sequence_step` on top of
/// the provably-Send `SendPduFramed`.
async fn step_sequence<S>(
    framed: &mut SendPduFramed<S>,
    sequence: &mut dyn connector::Sequence,
    buf: &mut ironrdp::pdu::WriteBuf,
) -> connector::ConnectorResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    buf.clear();
    let written = if let Some(hint) = sequence.next_pdu_hint() {
        let pdu = framed
            .read_by_hint(hint)
            .await
            .map_err(|e| connector::custom_err!("read frame by hint", e))?;
        sequence.step(&pdu, buf)?
    } else {
        sequence.step_no_input(buf)?
    };
    if let Some(len) = written.size() {
        framed
            .write_all(&buf[..len])
            .await
            .map_err(|e| connector::custom_err!("write all", e))?;
    }
    Ok(())
}

/// NLA/CredSSP authentication step (mirrors
/// `ironrdp_async::perform_credssp_step`). The Kerberos network client is
/// omitted: NTLM authentication resolves locally without network round-trips.
async fn perform_credssp<S>(
    framed: &mut SendPduFramed<S>,
    connector_handle: &mut connector::ClientConnector,
    buf: &mut ironrdp::pdu::WriteBuf,
    server_name: connector::ServerName,
    server_public_key: Vec<u8>,
) -> connector::ConnectorResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let selected_protocol = match connector_handle.state {
        connector::ClientConnectorState::Credssp { selected_protocol, .. } => selected_protocol,
        _ => {
            return Err(connector::general_err!(
                "invalid connector state for CredSSP sequence"
            ))
        }
    };

    let (mut sequence, mut ts_request) = connector::credssp::CredsspSequence::init(
        connector_handle.config.credentials.clone(),
        connector_handle.config.domain.as_deref(),
        selected_protocol,
        server_name,
        server_public_key,
        // Kerberos is not supported; NLA/NTLM authenticates offline.
        None,
    )?;

    loop {
        let client_state = {
            let mut generator = sequence.process_ts_request(ts_request);
            generator
                .resolve_to_result()
                .map_err(|e| connector::custom_err!("resolve without network client", e))?
        }; // drop generator

        buf.clear();
        let written = sequence.handle_process_result(client_state, buf)?;

        if let Some(response_len) = written.size() {
            framed
                .write_all(&buf[..response_len])
                .await
                .map_err(|e| connector::custom_err!("write all", e))?;
        }

        let Some(next_pdu_hint) = sequence.next_pdu_hint() else {
            break;
        };

        let pdu = framed
            .read_by_hint(next_pdu_hint)
            .await
            .map_err(|e| connector::custom_err!("read frame by hint", e))?;

        if let Some(next_request) = sequence.decode_server_message(&pdu)? {
            ts_request = next_request;
        } else {
            break;
        }
    }

    connector_handle.mark_credssp_as_done();

    Ok(())
}

// ---------------------------------------------------------------------------
// Active session
// ---------------------------------------------------------------------------

/// Mutable state shared by the session loop.
struct SessionState {
    active_stage: ironrdp::session::ActiveStage,
    /// Rebuilds the Deactivation-Reactivation sequence on server request.
    activation_factory: connector::connection_activation::ConnectionActivationFactory,
    image: DecodedImage,
    width: u16,
    height: u16,
    keyboard: ironrdp::input::Database,
    /// Previous button state (wheel bits masked out) for press/release diffing.
    previous_buttons: u8,
    /// Dropped delta frames; the next GraphicsUpdate sends a full frame.
    dropped_frames: u32,
    /// Local clipboard text awaiting delivery to the remote.
    clipboard_text: String,
}

async fn run_session(
    framed: SendPduFramed<BoxedStream>,
    connection_result: ConnectionResult,
    mut input_rx: mpsc::UnboundedReceiver<RdpInput>,
    mut cliprdr_events_rx: mpsc::UnboundedReceiver<CliprdrLoopEvent>,
    event_tx: mpsc::Sender<RdpEvent>,
    cancel: CancellationToken,
) {
    // Split into read/write halves, each with its own provably-Send framing.
    let (stream, leftover) = framed.into_parts();
    let (read_half, write_half) = tokio::io::split(stream);
    let mut reader = SendPduFramed::new(read_half, leftover);
    let mut writer = SendPduFramed::new(write_half, bytes::BytesMut::new());

    let desktop_size = connection_result.desktop_size;
    // Retain the factory before `connection_result` is consumed by the
    // builder — it drives the Deactivation-Reactivation sequence later.
    let activation_factory = connection_result.activation_factory;
    let mut state = SessionState {
        active_stage: ActiveStageBuilder {
            static_channels: connection_result.static_channels,
            user_channel_id: connection_result.user_channel_id,
            io_channel_id: connection_result.io_channel_id,
            message_channel_id: connection_result.message_channel_id,
            share_id: connection_result.share_id,
            compression_type: connection_result.compression_type,
            enable_server_pointer: connection_result.enable_server_pointer,
            pointer_software_rendering: connection_result.pointer_software_rendering,
        }
        .build(),
        activation_factory,
        image: DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height),
        width: desktop_size.width,
        height: desktop_size.height,
        keyboard: ironrdp::input::Database::new(),
        previous_buttons: 0,
        dropped_frames: 0,
        clipboard_text: String::new(),
    };

    let result = session_loop(
        &mut reader,
        &mut writer,
        &mut state,
        &mut input_rx,
        &mut cliprdr_events_rx,
        &event_tx,
        &cancel,
    )
    .await;
    let reason = match result {
        Ok(()) => "RDP session ended".to_owned(),
        Err(reason) => reason,
    };
    let _ = event_tx.send(RdpEvent::Terminated(reason)).await;
}

/// Copy a dirty rectangle out of the decoded image as *compact* RGBA rows.
///
/// `DecodedImage::data_for_rect` returns a strided slice that includes the
/// gap between the rectangle's right edge and the end of each row; the
/// frontend expects `width × height × 4` tightly-packed bytes.
fn compact_rect(image: &DecodedImage, rect: &ironrdp::pdu::geometry::InclusiveRectangle) -> Vec<u8> {
    use ironrdp::pdu::geometry::Rectangle as _;

    const BPP: usize = 4; // PixelFormat::RgbA32
    let stride = usize::from(image.width()) * BPP;
    let width = usize::from(rect.width()) * BPP;
    let row0 = usize::from(rect.top) * stride + usize::from(rect.left) * BPP;
    let data = image.data();
    let mut out = Vec::with_capacity(width * usize::from(rect.height()));
    for row in 0..usize::from(rect.height()) {
        let start = row0 + row * stride;
        out.extend_from_slice(&data[start..start + width]);
    }
    out
}

#[allow(clippy::too_many_lines)]
async fn session_loop(
    reader: &mut SendPduFramed<tokio::io::ReadHalf<BoxedStream>>,
    writer: &mut SendPduFramed<tokio::io::WriteHalf<BoxedStream>>,
    state: &mut SessionState,
    input_rx: &mut mpsc::UnboundedReceiver<RdpInput>,
    cliprdr_events_rx: &mut mpsc::UnboundedReceiver<CliprdrLoopEvent>,
    event_tx: &mpsc::Sender<RdpEvent>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    loop {
        let (outputs, stop): (Vec<ActiveStageOutput>, bool) = tokio::select! {
            () = cancel.cancelled() => (Vec::new(), true),
            frame = reader.read_pdu() => {
                let (action, payload) = frame.map_err(|e| format!("read frame: {e}"))?;
                let outputs = state
                    .active_stage
                    .process(&mut state.image, action, &payload)
                    .map_err(|e| format!("process frame: {e}"))?;
                (outputs, false)
            }
            input = input_rx.recv() => {
                match input {
                    Some(input) => {
                        let stop = matches!(input, RdpInput::Close);
                        let outputs = handle_input(state, input).map_err(|e| format!("input: {e}"))?;
                        (outputs, stop)
                    }
                    // All senders dropped (disconnect) — release keys and ask
                    // for a graceful shutdown before exiting.
                    None => {
                        let outputs = handle_input(state, RdpInput::Close)
                            .map_err(|e| format!("input: {e}"))?;
                        (outputs, true)
                    }
                }
            }
            cliprdr_event = cliprdr_events_rx.recv() => {
                match cliprdr_event {
                    Some(CliprdrLoopEvent::RemoteText(text)) => {
                        // Remote clipboard text decoded by the backend.
                        let _ = event_tx.try_send(RdpEvent::ClipboardText(text));
                        (Vec::new(), false)
                    }
                    Some(other) => {
                        let outputs = handle_cliprdr_event(state, other)
                            .map_err(|e| format!("clipboard: {e}"))?;
                        (outputs, false)
                    }
                    None => (Vec::new(), false),
                }
            }
        };

        let mut terminated = false;
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => {
                    writer
                        .write_all(&frame)
                        .await
                        .map_err(|e| format!("write response: {e}"))?;
                }
                ActiveStageOutput::GraphicsUpdate(region) => {
                    let width = region.right.saturating_sub(region.left) + 1;
                    let height = region.bottom.saturating_sub(region.top) + 1;
                    // Self-healing: after dropped frames send the whole image
                    // instead of a stale delta.
                    let frame = if state.dropped_frames > 0 {
                        state.dropped_frames = 0;
                        FrameUpdate {
                            x: 0,
                            y: 0,
                            width: state.image.width(),
                            height: state.image.height(),
                            rgba_data: state.image.data().to_vec(),
                        }
                    } else {
                        FrameUpdate {
                            x: region.left,
                            y: region.top,
                            width,
                            height,
                            rgba_data: compact_rect(&state.image, &region),
                        }
                    };
                    match event_tx.try_send(RdpEvent::Frame(frame)) {
                        Ok(()) => {}
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            state.dropped_frames += 1;
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => {
                            return Err("event channel closed".to_owned());
                        }
                    }
                }
                ActiveStageOutput::PointerDefault
                | ActiveStageOutput::PointerHidden
                | ActiveStageOutput::PointerPosition { .. }
                | ActiveStageOutput::PointerBitmap(_) => {
                    // Server-side pointer rendering — nothing to composite.
                }
                ActiveStageOutput::Terminate(_reason) => {
                    terminated = true;
                }
                ActiveStageOutput::DeactivateAll => {
                    reactivate(reader, writer, state, event_tx).await?;
                }
                // UDP multitransport and bandwidth auto-detection are not
                // implemented; like the official client, we log and ignore.
                ActiveStageOutput::MultitransportRequest(_) => {}
                ActiveStageOutput::AutoDetect(_) => {}
            }
        }
        if terminated || stop {
            break;
        }
    }

    Ok(())
}

/// Translate a frontend input event into active-stage outputs.
fn handle_input(state: &mut SessionState, input: RdpInput) -> SessionResult<Vec<ActiveStageOutput>> {
    match input {
        RdpInput::Key { extended, code, down, caps_lock, num_lock } => {
            let scancode = Scancode::from_u8(extended, code);
            let operation = if down {
                Operation::KeyPressed(scancode)
            } else {
                Operation::KeyReleased(scancode)
            };
            let mut events = state.keyboard.apply(std::iter::once(operation));
            // Lock keys: Windows hosts track CapsLock/NumLock toggles through
            // sync events (mstsc behaviour), not raw scancodes. When the
            // frontend supplies the fresh toggle state, mirror it to the host
            // so the remote session can switch letter case.
            if down && (code == 0x3A || code == 0x45) {
                if let (Some(caps), Some(num)) = (caps_lock, num_lock) {
                    let sync = ironrdp::input::synchronize_event(false, num, caps, false);
                    events.push(sync);
                }
            }
            state
                .active_stage
                .process_fastpath_input(&mut state.image, &events)
        }
        RdpInput::Pointer { x, y, button_mask } => {
            // Wheel flags are momentary — handle them and strip them from the
            // persistent button state.
            let mut operations = Vec::new();
            if button_mask & WHEEL_UP != 0 {
                operations.push(Operation::WheelRotations(WheelRotations {
                    is_vertical: true,
                    // Positive rotation = wheel rotated away from the user.
                    rotation_units: 120,
                }));
            }
            if button_mask & WHEEL_DOWN != 0 {
                operations.push(Operation::WheelRotations(WheelRotations {
                    is_vertical: true,
                    rotation_units: -120,
                }));
            }

            let button_state = button_mask & !(WHEEL_UP | WHEEL_DOWN);
            if state.previous_buttons != button_state {
                for (bit, button) in [
                    (BUTTON_LEFT, MouseButton::Left),
                    (BUTTON_RIGHT, MouseButton::Right),
                    (BUTTON_MIDDLE, MouseButton::Middle),
                ] {
                    let was = state.previous_buttons & bit != 0;
                    let now = button_state & bit != 0;
                    if !was && now {
                        operations.push(Operation::MouseButtonPressed(button));
                    } else if was && !now {
                        operations.push(Operation::MouseButtonReleased(button));
                    }
                }
                state.previous_buttons = button_state;
            }
            operations.push(Operation::MouseMove(MousePosition { x, y }));

            let events = state.keyboard.apply(operations);
            state
                .active_stage
                .process_fastpath_input(&mut state.image, &events)
        }
        RdpInput::SetClipboard(text) => {
            // Store the text, then advertise CF_UNICODETEXT so the remote
            // knows a paste is available; data is delivered on request.
            state.clipboard_text = text;
            cliprdr_operation(state, CliprdrOperation::Advertise)
        }
        RdpInput::Resize { width, height } => {
            let (w, h) = ironrdp::displaycontrol::pdu::MonitorLayoutEntry::adjust_display_size(
                u32::from(width),
                u32::from(height),
            );
            match state.active_stage.encode_resize(w, h, Some(100), None) {
                Some(Ok(frame)) => Ok(vec![ActiveStageOutput::ResponseFrame(frame)]),
                Some(Err(e)) => {
                    tracing::warn!("RDP display resize failed: {e}");
                    Ok(Vec::new())
                }
                None => {
                    tracing::debug!("RDP display-control channel unavailable; keeping current size");
                    Ok(Vec::new())
                }
            }
        }
        RdpInput::Close => {
            // Ask the server for a graceful shutdown; the loop exits when the
            // Terminate PDU arrives (or the cancel token fires).
            let events = state.keyboard.release_all();
            let mut outputs = state
                .active_stage
                .process_fastpath_input(&mut state.image, &events)?;
            outputs.extend(state.active_stage.graceful_shutdown()?);
            Ok(outputs)
        }
    }
}

/// Handle a CLIPRDR backend event. `RemoteText` is handled inline in the
/// session loop (it needs the event channel) and never reaches here.
fn handle_cliprdr_event(
    state: &mut SessionState,
    event: CliprdrLoopEvent,
) -> SessionResult<Vec<ActiveStageOutput>> {
    match event {
        CliprdrLoopEvent::FormatDataRequest => {
            let text = state.clipboard_text.clone();
            cliprdr_operation(state, CliprdrOperation::SubmitLocal(text))
        }
        CliprdrLoopEvent::RemoteCopy => cliprdr_operation(state, CliprdrOperation::FetchRemote),
        CliprdrLoopEvent::RemoteText(_) => Ok(Vec::new()),
    }
}

enum CliprdrOperation {
    /// Advertise CF_UNICODETEXT to the remote.
    Advertise,
    /// Answer the remote paste request with the given text.
    SubmitLocal(String),
    /// Request the remote clipboard text.
    FetchRemote,
}

/// Run a CLIPRDR operation against the static channel and encode the
/// resulting messages into a response frame.
fn cliprdr_operation(
    state: &mut SessionState,
    operation: CliprdrOperation,
) -> SessionResult<Vec<ActiveStageOutput>> {
    let messages = {
        let Some(cliprdr_client) = state
            .active_stage
            .get_svc_processor_mut::<cliprdr::CliprdrClient>()
        else {
            return Ok(Vec::new());
        };
        let result = match operation {
            CliprdrOperation::Advertise => cliprdr_client.initiate_copy(&[ClipboardFormat::new(
                ClipboardFormatId::CF_UNICODETEXT,
            )]),
            CliprdrOperation::SubmitLocal(text) => {
                let response = OwnedFormatDataResponse::new_data(encode_unicode_text(&text));
                cliprdr_client.submit_format_data(response)
            }
            CliprdrOperation::FetchRemote => {
                cliprdr_client.initiate_paste(ClipboardFormatId::CF_UNICODETEXT)
            }
        };
        match result {
            Ok(messages) => messages,
            Err(e) => {
                tracing::warn!("CLIPRDR operation failed: {e}");
                return Ok(Vec::new());
            }
        }
    };
    let frame = state.active_stage.process_svc_processor_messages(messages)?;
    if frame.is_empty() {
        Ok(Vec::new())
    } else {
        Ok(vec![ActiveStageOutput::ResponseFrame(frame)])
    }
}

/// Drive the Deactivation-Reactivation sequence and rebuild session state
/// (mirrors the official ironrdp-client crate's handling).
async fn reactivate(
    reader: &mut SendPduFramed<tokio::io::ReadHalf<BoxedStream>>,
    writer: &mut SendPduFramed<tokio::io::WriteHalf<BoxedStream>>,
    state: &mut SessionState,
    event_tx: &mpsc::Sender<RdpEvent>,
) -> Result<(), String> {
    // Manual sequence stepping (instead of `single_sequence_step_read`)
    // keeps the concrete `ConnectionActivationSequence` type in the spawned
    // task's future — passing `&mut dyn Sequence` across an await trips
    // rustc's higher-ranked `Send` check (ironrdp-async's `FramedRead` GAT
    // and `&dyn PduHint` lack Send bounds; see AGENTS.md #14).
    use ironrdp::connector::Sequence as _;
    let mut sequence = state.activation_factory.create();
    let mut buf = ironrdp::pdu::WriteBuf::new();
    loop {
        buf.clear();
        let written = if let Some(hint) = sequence.next_pdu_hint() {
            let pdu = reader
                .read_by_hint(hint)
                .await
                .map_err(|e| format!("read deactivation-reactivation step: {e}"))?;
            sequence
                .step(&pdu, &mut buf)
                .map_err(|e| format!("process deactivation-reactivation step: {e}"))?
        } else {
            sequence
                .step_no_input(&mut buf)
                .map_err(|e| format!("process deactivation-reactivation step: {e}"))?
        };
        if written.size().is_some() {
            writer
                .write_all(buf.filled())
                .await
                .map_err(|e| format!("write deactivation-reactivation step: {e}"))?;
        }
        if let ConnectionActivationState::Finalized {
            desktop_size,
            share_id,
            enable_server_pointer,
            pointer_software_rendering,
        } = sequence.connection_activation_state()
        {
            state.width = desktop_size.width;
            state.height = desktop_size.height;
            state.image =
                DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
            state.active_stage.set_fastpath_processor(
                fast_path::ProcessorBuilder {
                    io_channel_id: sequence.io_channel_id(),
                    user_channel_id: sequence.user_channel_id(),
                    share_id,
                    enable_server_pointer,
                    pointer_software_rendering,
                    bulk_decompressor: None,
                }
                .build(),
            );
            state.active_stage.set_share_id(share_id);
            state.active_stage.set_enable_server_pointer(enable_server_pointer);
            tracing::debug!(width = desktop_size.width, height = desktop_size.height, "RDP reactivated");
            let _ = event_tx
                .try_send(RdpEvent::Resized {
                    width: desktop_size.width,
                    height: desktop_size.height,
                });
            return Ok(());
        }
    }
}

// ---------------------------------------------------------------------------
// DesktopProtocol implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl DesktopProtocol for RdpClient {
    async fn start_frame_loop(
        &self,
        event_tx: mpsc::UnboundedSender<DesktopEvent>,
        cancel: CancellationToken,
    ) -> Result<()> {
        let mut event_rx = self
            .event_rx
            .lock()
            .expect("event channel mutex poisoned")
            .take()
            .ok_or_else(|| anyhow::anyhow!("Desktop event stream already started"))?;

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = cancel.cancelled() => break,
                    event = event_rx.recv() => {
                        let Some(event) = event else { break };
                        if event_tx.send(event.into()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        Ok(())
    }

    async fn send_key(&self, key_code: u32, down: bool, caps_lock: Option<bool>, num_lock: Option<bool>) -> Result<()> {
        let Some((extended, code)) = js_keycode_to_scancode(key_code) else {
            return Ok(());
        };
        self.send_input(RdpInput::Key { extended, code, down, caps_lock, num_lock })
    }

    async fn send_pointer(&self, x: u16, y: u16, button_mask: u8) -> Result<()> {
        self.send_input(RdpInput::Pointer { x, y, button_mask })
    }

    async fn request_full_frame(&self) -> Result<()> {
        // The session loop self-heals with a full frame after any dropped
        // frame; an explicit request is a no-op for RDP.
        Ok(())
    }

    async fn set_clipboard(&self, text: String) -> Result<()> {
        self.send_input(RdpInput::SetClipboard(text))
    }

    fn desktop_size(&self) -> (u16, u16) {
        (self.desktop_width, self.desktop_height)
    }

    async fn resize(&mut self, width: u16, height: u16) -> Result<()> {
        self.send_input(RdpInput::Resize { width, height })?;
        self.desktop_width = width;
        self.desktop_height = height;
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        if self.connected {
            if let Some(tx) = self.input_tx.take() {
                let _ = tx.send(RdpInput::Close);
            }
            if let Some(cancel) = self.cancel.take() {
                cancel.cancel();
            }
            self.connected = false;
            tracing::info!("RDP disconnected");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::pdu::geometry::InclusiveRectangle;

    #[test]
    fn compact_rect_produces_tightly_packed_rows() {
        // 8×2 RGBA image (all zeros). A dirty rect 2..=4 × 0..=1 must pack
        // to exactly 3 × 2 × 4 bytes — a strided slice would be
        // (2 − 1) × 8 × 4 + 3 × 4 = 44 bytes instead.
        let image = DecodedImage::new(PixelFormat::RgbA32, 8, 2);
        let rect = InclusiveRectangle {
            left: 2,
            top: 0,
            right: 4,
            bottom: 1,
        };
        let compact = compact_rect(&image, &rect);
        assert_eq!(compact.len(), 3 * 2 * 4);
        assert_eq!(compact, vec![0u8; 3 * 2 * 4]);
    }

    #[test]
    fn compact_rect_full_width_matches_raw_data() {
        let image = DecodedImage::new(PixelFormat::RgbA32, 4, 3);
        let rect = InclusiveRectangle {
            left: 0,
            top: 0,
            right: 3,
            bottom: 2,
        };
        assert_eq!(compact_rect(&image, &rect), image.data().to_vec());
    }

    #[test]
    fn compact_rect_single_pixel() {
        let image = DecodedImage::new(PixelFormat::RgbA32, 16, 16);
        let rect = InclusiveRectangle {
            left: 7,
            top: 9,
            right: 7,
            bottom: 9,
        };
        assert_eq!(compact_rect(&image, &rect).len(), 4);
    }

    #[test]
    fn letters_and_digits_map_directly() {
        assert_eq!(js_keycode_to_scancode(0x41), Some((false, 0x1E))); // A
        assert_eq!(js_keycode_to_scancode(0x5A), Some((false, 0x2C))); // Z
        assert_eq!(js_keycode_to_scancode(0x51), Some((false, 0x10))); // Q
        assert_eq!(js_keycode_to_scancode(0x50), Some((false, 0x19))); // P
        assert_eq!(js_keycode_to_scancode(0x4C), Some((false, 0x26))); // L
        assert_eq!(js_keycode_to_scancode(0x30), Some((false, 0x0B))); // 0
        assert_eq!(js_keycode_to_scancode(0x31), Some((false, 0x02))); // 1
        assert_eq!(js_keycode_to_scancode(0x39), Some((false, 0x0A))); // 9
    }

    #[test]
    fn navigation_keys_are_extended() {
        assert_eq!(js_keycode_to_scancode(0x25), Some((true, 0x4B))); // Left
        assert_eq!(js_keycode_to_scancode(0x26), Some((true, 0x48))); // Up
        assert_eq!(js_keycode_to_scancode(0x2E), Some((true, 0x53))); // Delete
        assert_eq!(js_keycode_to_scancode(0x23), Some((true, 0x4F))); // End
    }

    #[test]
    fn function_keys_map_correctly() {
        assert_eq!(js_keycode_to_scancode(0x70), Some((false, 0x3B))); // F1
        assert_eq!(js_keycode_to_scancode(0x79), Some((false, 0x44))); // F10
        assert_eq!(js_keycode_to_scancode(0x7A), Some((false, 0x57))); // F11
        assert_eq!(js_keycode_to_scancode(0x7B), Some((false, 0x58))); // F12
    }

    #[test]
    fn numpad_keys_map_correctly() {
        assert_eq!(js_keycode_to_scancode(0x60), Some((false, 0x52))); // Num 0
        assert_eq!(js_keycode_to_scancode(0x61), Some((false, 0x4F))); // Num 1
        assert_eq!(js_keycode_to_scancode(0x69), Some((false, 0x49))); // Num 9
        assert_eq!(js_keycode_to_scancode(0x6F), Some((true, 0x35))); // Num /
    }

    #[test]
    fn punctuation_uses_us_layout_scancodes() {
        assert_eq!(js_keycode_to_scancode(0xBA), Some((false, 0x27))); // ;
        assert_eq!(js_keycode_to_scancode(0xDC), Some((false, 0x2B))); // backslash
        assert_eq!(js_keycode_to_scancode(0xC0), Some((false, 0x29))); // `
    }

    #[test]
    fn unknown_keycodes_are_dropped() {
        assert_eq!(js_keycode_to_scancode(0x00), None);
        assert_eq!(js_keycode_to_scancode(0xE5), None);
    }

    #[test]
    fn unicode_clipboard_roundtrip() {
        let text = "你好 NexTerm\nclipboard";
        let encoded = encode_unicode_text(text);
        assert_eq!(decode_unicode_text(&encoded).as_deref(), Some(text));
        // Trailing NUL is stripped.
        assert!(encoded.ends_with(&[0, 0]));
    }

    #[test]
    fn decode_unicode_handles_odd_and_empty() {
        assert_eq!(decode_unicode_text(&[]), None);
        assert_eq!(decode_unicode_text(&[0x41]), None); // odd length
        assert_eq!(decode_unicode_text(&[0x41, 0x00]), Some("A".to_owned()));
    }
}
