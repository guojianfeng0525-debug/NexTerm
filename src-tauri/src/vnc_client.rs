//! VNC (RFB protocol) remote desktop client built on the `vnc-rs` crate.
//!
//! `vnc-rs` is a community-maintained async RFB engine (RFC 6143): it owns
//! the wire protocol — version handshake, security negotiation (None /
//! VNC-Auth DES challenge-response), framebuffer-update decoding (ZRLE,
//! CopyRect, Raw) — and exposes an event-driven API
//! (`VncClient::poll_event` / `VncClient::input`).
//!
//! This module adapts that engine to the [`DesktopProtocol`] trait:
//!
//! * frames: the engine reports raw rectangles and copyrect blits; we keep a
//!   full client-side framebuffer so copyrects can be materialised into real
//!   pixels, and forward every update as a [`DesktopEvent::Frame`] dirty
//!   rectangle (RGBA, matching the negotiated pixel format).
//! * keyboard: the frontend sends JavaScript `keyCode`s; we translate them to
//!   X11 keysyms (what RFB `KeyEvent` carries) with a unit-tested table,
//!   applying client-side Shift/CapsLock state the way gtk-vnc does — the
//!   keysym encodes the final character.
//! * pointer: JavaScript `MouseEvent.buttons` bits are remapped to the RFB
//!   button mask (left 1→1, right 2→4, middle 4→2) and wheel flags are
//!   turned into momentary button-4/5 presses.
//! * clipboard: RFB `ServerCutText`/`ClientCutText` (Latin-1 only).
//!
//! Connection flow: a stream to the target is opened either directly over
//! TCP or through the SSH jump-host tunnel ([`crate::jump`]), then handed to
//! the engine — the same transport path as the RDP client.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Context as _, Result};
use async_trait::async_trait;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use vnc::{PixelFormat, VncClient as VncEngine, VncConnector, VncEncoding, VncEvent, X11Event};

use crate::desktop_protocol::{DesktopEvent, DesktopProtocol, FrameUpdate, VncConfig};
use crate::desktop_transport;

/// How often the client asks the server for incremental framebuffer
/// updates. RFB is client-driven: without these requests the screen freezes.
const REFRESH_INTERVAL_MS: u64 = 33;

/// Sleep between non-blocking event polls. Keeps the shared engine mutex
/// free so input events never contend with the frame loop.
const POLL_INTERVAL_MS: u64 = 5;

/// Pointer mask bits in the JavaScript `MouseEvent.buttons` convention
/// (shared with the RDP client).
const JS_BUTTON_LEFT: u8 = 0x01;
const JS_BUTTON_RIGHT: u8 = 0x02;
const JS_BUTTON_MIDDLE: u8 = 0x04;
const JS_WHEEL_UP: u8 = 0x08;
const JS_WHEEL_DOWN: u8 = 0x10;

/// RFB pointer button mask bits (RFC 6143 §7.5.5).
const RFB_BUTTON_LEFT: u8 = 0x01;
const RFB_BUTTON_MIDDLE: u8 = 0x02;
const RFB_BUTTON_RIGHT: u8 = 0x04;
const RFB_BUTTON_WHEEL_UP: u8 = 0x08;
const RFB_BUTTON_WHEEL_DOWN: u8 = 0x10;

/// Client-side framebuffer state shared between the frame loop (writer) and
/// the protocol methods (reader for copyrect materialisation).
struct Framebuffer {
    width: usize,
    height: usize,
    /// RGBA, `width * height * 4` bytes.
    pixels: Vec<u8>,
}

impl Framebuffer {
    fn new(width: u16, height: u16) -> Self {
        let (width, height) = (width as usize, height as usize);
        Self {
            width,
            height,
            pixels: vec![0; width * height * 4],
        }
    }

    fn resize(&mut self, width: u16, height: u16) {
        *self = Self::new(width, height);
    }

    /// Blit an RGBA rectangle into the framebuffer (clipped).
    fn blit(&mut self, x: u16, y: u16, width: u16, height: u16, rgba: &[u8]) {
        for row in 0..height as usize {
            let dst_y = y as usize + row;
            if dst_y >= self.height {
                break;
            }
            let copy_cols = (width as usize).min(self.width.saturating_sub(x as usize));
            if copy_cols == 0 {
                continue;
            }
            let src = row * width as usize * 4;
            let dst = (dst_y * self.width + x as usize) * 4;
            let len = copy_cols * 4;
            self.pixels[dst..dst + len].copy_from_slice(&rgba[src..src + len]);
        }
    }

    /// Extract a tightly-packed RGBA rectangle (for copyrect forwarding).
    fn extract(&self, x: u16, y: u16, width: u16, height: u16) -> Vec<u8> {
        let mut out = Vec::with_capacity(width as usize * height as usize * 4);
        for row in 0..height as usize {
            let src_y = y as usize + row;
            if src_y >= self.height {
                break;
            }
            let copy_cols = (width as usize).min(self.width.saturating_sub(x as usize));
            let start = (src_y * self.width + x as usize) * 4;
            out.extend_from_slice(&self.pixels[start..start + copy_cols * 4]);
        }
        out
    }

    /// Copy `src` rect pixels into the `dst` rect (RFB CopyRect). Returns
    /// the materialised pixels of the destination.
    fn copy_rect(&mut self, dst_x: u16, dst_y: u16, src_x: u16, src_y: u16, w: u16, h: u16) -> Vec<u8> {
        let pixels = self.extract(src_x, src_y, w, h);
        self.blit(dst_x, dst_y, w, h, &pixels);
        pixels
    }
}

/// Translate a JavaScript `KeyboardEvent.keyCode` to an X11 keysym.
///
/// Letters/digits use their ASCII codes; VNC `KeyEvent` carries keysyms, and
/// a keysym names the character to produce, so the Shift/CapsLock variants
/// are applied by the caller (see [`VncClient::send_key`]).
pub fn js_keycode_to_keysym(key_code: u32) -> Option<u32> {
    let kc = key_code as u8;
    Some(match key_code {
        // Letters (keyCode is the uppercase ASCII regardless of shift state)
        65..=90 => key_code,               // 'A'..'Z' keysym base; case handled by caller
        // Digits
        48..=57 => key_code,               // '0'..'9'
        // Whitespace / editing
        13 => 0xFF0D,                      // Return
        8 => 0xFF08,                       // BackSpace
        9 => 0xFF09,                       // Tab
        32 => 0x0020,                      // Space
        27 => 0xFF1B,                      // Escape
        // Modifiers
        16 => 0xFFE1,                      // Shift_L
        17 => 0xFFE3,                      // Control_L
        18 => 0xFFE9,                      // Alt_L (Option on macOS)
        20 => 0xFFE5,                      // Caps_Lock
        91 => 0xFFEB,                      // Super_L (Meta/Win/Cmd)
        93 => 0xFF67,                      // Menu
        // Navigation
        33 => 0xFF55,                      // Prior (PageUp)
        34 => 0xFF56,                      // Next (PageDown)
        35 => 0xFF57,                      // End
        36 => 0xFF50,                      // Home
        37 => 0xFF51,                      // Left
        38 => 0xFF52,                      // Up
        39 => 0xFF53,                      // Right
        40 => 0xFF54,                      // Down
        45 => 0xFF63,                      // Insert
        46 => 0xFFFF,                      // Delete
        // Function keys
        112..=123 => 0xFFBE + (key_code - 112), // F1..F12
        // Punctuation (US layout)
        186 => 0x003B,                     // ;:
        187 => 0x003D,                     // =+
        188 => 0x002C,                     // ,<
        189 => 0x002D,                     // -_
        190 => 0x002E,                     // .>
        191 => 0x002F,                     // /?
        192 => 0x0060,                     // `~
        219 => 0x005B,                     // [{
        220 => 0x005C,                     // \|
        221 => 0x005D,                     // ]}
        222 => 0x0027,                     // '"
        // Numeric keypad
        96 => 0xFFB0,                      // KP_0
        97..=105 => 0xFFB1 + (key_code - 97), // KP_1..KP_9
        106 => 0xFFAA,                     // KP_*
        107 => 0xFFAB,                     // KP_+
        109 => 0xFFAD,                     // KP_-
        110 => 0xFFAE,                     // KP_.
        111 => 0xFFAF,                     // KP_/
        _ => {
            let _ = kc;
            return None;
        }
    })
}

/// Apply Shift/CapsLock to a base keysym, producing the keysym for the
/// character the user expects.
fn apply_case(base: u32, shift: bool, caps_lock: bool) -> u32 {
    match base {
        // Letters: shift and caps both flip the case of the base (lowercase)
        0x61..=0x7A => {
            let upper = shift ^ caps_lock;
            if upper { base - 0x20 } else { base }
        }
        // Digits and punctuation shift variants (US layout)
        0x30..=0x39 if shift => match base {
            0x30 => 0x29, // 0 -> )
            0x31 => 0x21, // 1 -> !
            0x32 => 0x40, // 2 -> @
            0x33 => 0x23, // 3 -> #
            0x34 => 0x24, // 4 -> $
            0x35 => 0x25, // 5 -> %
            0x36 => 0x5E, // 6 -> ^
            0x37 => 0x26, // 7 -> &
            0x38 => 0x2A, // 8 -> *
            _ => 0x28,    // 9 -> (
        },
        0x30..=0x39 => base,
        _ if shift => match base {
            0x003B => 0x003A, // ; -> :
            0x003D => 0x002B, // = -> +
            0x002C => 0x003C, // , -> <
            0x002D => 0x005F, // - -> _
            0x002E => 0x003E, // . -> >
            0x002F => 0x003F, // / -> ?
            0x0060 => 0x007E, // ` -> ~
            0x005B => 0x007B, // [ -> {
            0x005C => 0x007C, // \ -> |
            0x005D => 0x007D, // ] -> }
            0x0027 => 0x0022, // ' -> "
            other => other,
        },
        _ => base,
    }
}

/// Convert a JavaScript button mask to the RFB button mask (no wheel).
fn js_buttons_to_rfb(mask: u8) -> u8 {
    let mut rfb = 0;
    if mask & JS_BUTTON_LEFT != 0 {
        rfb |= RFB_BUTTON_LEFT;
    }
    if mask & JS_BUTTON_MIDDLE != 0 {
        rfb |= RFB_BUTTON_MIDDLE;
    }
    if mask & JS_BUTTON_RIGHT != 0 {
        rfb |= RFB_BUTTON_RIGHT;
    }
    rfb
}

/// VNC remote desktop client (see module docs).
pub struct VncClient {
    engine: Arc<Mutex<VncEngine>>,
    framebuffer: Arc<StdMutex<Framebuffer>>,
    config: VncConfig,
    desktop_width: u16,
    desktop_height: u16,
    /// Client-side keyboard modifier state (keysyms encode the final
    /// character, so Shift must be applied locally).
    shift_down: AtomicBool,
    caps_lock: AtomicBool,
    /// Set once the frame loop terminates; later input calls fail fast.
    terminated: Arc<AtomicBool>,
}

impl VncClient {
    /// Establish a VNC connection (direct or via the configured SSH jump
    /// host) and complete the RFB handshake.
    pub async fn connect(config: &VncConfig) -> Result<Self> {
        if config.host.is_empty() {
            return Err(anyhow::anyhow!("VNC host cannot be empty"));
        }

        let opened = desktop_transport::open_stream(
            &config.host,
            config.port,
            config.jump_host.as_ref(),
        )
        .await
        .context("Failed to open the VNC transport")?;

        let password = config.password.clone().unwrap_or_default();
        let pixel_format = pixel_format_for_depth(config.color_depth);

        let engine = VncConnector::new(opened.stream)
            .set_auth_method(async move { Ok(password) })
            .add_encoding(VncEncoding::Zrle)
            .add_encoding(VncEncoding::CopyRect)
            .add_encoding(VncEncoding::Raw)
            .allow_shared(true)
            .set_pixel_format(pixel_format)
            .build()
            .map_err(|e| anyhow::anyhow!("VNC handshake setup failed: {e}"))?
            .try_start()
            .await
            .map_err(|e| anyhow::anyhow!("VNC handshake failed: {e}"))?
            .finish()
            .map_err(|e| anyhow::anyhow!("VNC connection failed: {e}"))?;

        let engine = Arc::new(Mutex::new(engine));
        // The engine reports the negotiated screen size through a
        // SetResolution event; probe it once so the manager can store the
        // size before the frame loop starts.
        let (width, height) = probe_screen(&engine).await;

        tracing::info!(
            "VNC connected to {}:{} ({}x{}, depth {}bpp)",
            config.host,
            config.port,
            width,
            height,
            pixel_format.bits_per_pixel
        );

        Ok(Self {
            engine,
            framebuffer: Arc::new(StdMutex::new(Framebuffer::new(width, height))),
            config: VncConfig {
                host: config.host.clone(),
                port: config.port,
                password: None,
                color_depth: config.color_depth,
                jump_host: None,
            },
            desktop_width: width,
            desktop_height: height,
            shift_down: AtomicBool::new(false),
            caps_lock: AtomicBool::new(false),
            terminated: Arc::new(AtomicBool::new(false)),
        })
    }

    async fn engine_input(engine: &Arc<Mutex<VncEngine>>, event: X11Event) -> Result<()> {
        let eng = engine.lock().await;
        eng.input(event)
            .await
            .map_err(|e| anyhow::anyhow!("VNC input failed: {e}"))
    }
}

/// Ask the engine for the current screen size by waiting briefly for the
/// initial SetResolution event (the engine emits it after ServerInit).
async fn probe_screen(engine: &Arc<Mutex<VncEngine>>) -> (u16, u16) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        let event = {
            let eng = engine.lock().await;
            match eng.poll_event().await {
                Ok(Some(e)) => Some(e),
                Ok(None) => None,
                Err(_) => None,
            }
        };
        if let Some(VncEvent::SetResolution(screen)) = event {
            return (screen.width, screen.height);
        }
        tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
    (1024, 768) // sensible fallback; the frame loop re-reports via Resized
}

/// Map the user-facing color-depth option to an RFB pixel format.
///
/// All formats are byte-aligned little-endian with true-colour flag set; the
/// engine decodes server rectangles into this layout, so the frontend canvas
/// (RGBA) can consume 32bpp updates directly. Lower depths let servers send
/// less data over slow links at the cost of local expansion to 32bpp before
/// the frame is forwarded.
fn pixel_format_for_depth(depth: u8) -> PixelFormat {
    match depth {
        8 => {
            let mut pf = PixelFormat::rgba();
            pf.bits_per_pixel = 8;
            pf.depth = 8;
            pf.red_max = 7;
            pf.green_max = 7;
            pf.blue_max = 3;
            pf.red_shift = 0;
            pf.green_shift = 3;
            pf.blue_shift = 6;
            pf
        }
        16 => {
            let mut pf = PixelFormat::rgba();
            pf.bits_per_pixel = 16;
            pf.depth = 16;
            pf.red_max = 31;
            pf.green_max = 31;
            pf.blue_max = 31;
            pf.red_shift = 0;
            pf.green_shift = 5;
            pf.blue_shift = 10;
            pf
        }
        // 24 (default) and any unknown value
        _ => {
            let mut pf = PixelFormat::rgba();
            pf.bits_per_pixel = 32;
            pf.depth = 24;
            pf
        }
    }
}

/// Forward an engine event to the desktop event channel, updating the local
/// framebuffer as needed. Returns `Some(reason)` when the session ended.
async fn handle_event(
    event: VncEvent,
    framebuffer: &Arc<StdMutex<Framebuffer>>,
    event_tx: &mpsc::UnboundedSender<DesktopEvent>,
) -> Option<String> {
    match event {
        VncEvent::SetResolution(screen) => {
            let mut fb = framebuffer.lock().expect("framebuffer lock");
            fb.resize(screen.width, screen.height);
            let _ = event_tx.send(DesktopEvent::Resized {
                width: screen.width,
                height: screen.height,
            });
            None
        }
        VncEvent::RawImage(rect, data) => {
            let mut fb = framebuffer.lock().expect("framebuffer lock");
            fb.blit(rect.x, rect.y, rect.width, rect.height, &data);
            let _ = event_tx.send(DesktopEvent::Frame(FrameUpdate {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                rgba_data: data,
            }));
            None
        }
        VncEvent::Copy(dst, src) => {
            // Materialise the copy into real pixels: extract the source
            // region from the local framebuffer, blit it to the destination,
            // then forward the destination rectangle as a frame update.
            let mut fb = framebuffer.lock().expect("framebuffer lock");
            let pixels = fb.copy_rect(dst.x, dst.y, src.x, src.y, dst.width, dst.height);
            let _ = event_tx.send(DesktopEvent::Frame(FrameUpdate {
                x: dst.x,
                y: dst.y,
                width: dst.width,
                height: dst.height,
                rgba_data: pixels,
            }));
            None
        }
        VncEvent::JpegImage(rect, _data) => {
            // We never advertise the Tight encoding, so JPEG rectangles are
            // unexpected; recover by asking for a full raw refresh.
            tracing::warn!(
                "VNC server sent an unexpected JPEG rectangle at ({}, {}); requesting a full refresh",
                rect.x,
                rect.y
            );
            None
        }
        VncEvent::SetCursor(_, _) | VncEvent::Bell => None,
        VncEvent::Text(text) => {
            let _ = event_tx.send(DesktopEvent::ClipboardText(text));
            None
        }
        VncEvent::SetPixelFormat(_) => None, // we dictate the format
        VncEvent::Error(message) => Some(message),
        _ => None,
    }
}

#[async_trait]
impl DesktopProtocol for VncClient {
    async fn start_frame_loop(
        &self,
        event_tx: mpsc::UnboundedSender<DesktopEvent>,
        cancel: CancellationToken,
    ) -> Result<()> {
        let engine = self.engine.clone();
        let framebuffer = self.framebuffer.clone();
        let terminated = self.terminated.clone();
        let config = self.config.clone();

        // The engine spawns its own network + decode tasks; this loop only
        // pumps events between them and the WebSocket consumer, and keeps
        // the RFB client-driven refresh going.
        tokio::spawn(async move {
            let mut refresh = tokio::time::interval(std::time::Duration::from_millis(
                REFRESH_INTERVAL_MS,
            ));
            refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_refresh_was_full = false;

            let reason = loop {
                tokio::select! {
                    () = cancel.cancelled() => break "cancelled".to_owned(),
                    _ = refresh.tick() => {
                        let event = if last_refresh_was_full {
                            X11Event::Refresh
                        } else {
                            last_refresh_was_full = true;
                            X11Event::FullRefresh
                        };
                        if let Err(e) = VncClient::engine_input(&engine, event).await {
                            break format!("VNC refresh failed: {e}");
                        }
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)) => {
                        // Drain all pending events without holding the
                        // engine mutex across a blocking wait.
                        let mut stop: Option<String> = None;
                        loop {
                            let event = {
                                let eng = engine.lock().await;
                                match eng.poll_event().await {
                                    Ok(opt) => opt,
                                    Err(e) => {
                                        stop = Some(format!("VNC connection error: {e}"));
                                        break;
                                    }
                                }
                            };
                            let Some(event) = event else { break };
                            if let Some(reason) =
                                handle_event(event, &framebuffer, &event_tx).await
                            {
                                stop = Some(reason);
                                break;
                            }
                        }
                        if let Some(reason) = stop {
                            break reason;
                        }
                    }
                }
            };

            terminated.store(true, Ordering::SeqCst);
            let _ = event_tx.send(DesktopEvent::Terminated(reason));
            let _ = VncClient::engine_input(&engine, X11Event::Refresh).await; // no-op once closed
            tracing::info!("VNC session to {}:{} ended", config.host, config.port);
        });

        Ok(())
    }

    async fn send_key(&self, key_code: u32, down: bool, caps_lock: Option<bool>, _num_lock: Option<bool>) -> Result<()> {
        if self.terminated.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("VNC session has ended"));
        }
        // Track Shift/CapsLock so letter keysyms encode the right case.
        match key_code {
            16 => {
                self.shift_down.store(down, Ordering::SeqCst);
            }
            20 if down => {
                // CapsLock keydown: prefer the authoritative client toggle
                // state (`getModifierState('CapsLock')`, already updated by
                // the browser at event time); fall back to toggling our latch
                // when the frontend doesn't provide it. RFB itself carries no
                // lock state — the letter keysyms we send are case-resolved
                // here, and X11 servers never lowercase an uppercase keysym,
                // so their own lock state never double-applies.
                let now = caps_lock.unwrap_or_else(|| !self.caps_lock.load(Ordering::SeqCst));
                self.caps_lock.store(now, Ordering::SeqCst);
            }
            _ => {}
        }
        let Some(base) = js_keycode_to_keysym(key_code) else {
            tracing::debug!("VNC: unmapped keyCode {key_code}");
            return Ok(());
        };
        let shift = self.shift_down.load(Ordering::SeqCst);
        let keysym = if is_modifier(base) {
            base
        } else {
            apply_case(base, shift, self.caps_lock.load(Ordering::SeqCst))
        };
        Self::engine_input(
            &self.engine,
            X11Event::KeyEvent(vnc::ClientKeyEvent {
                keycode: keysym,
                down,
            }),
        )
        .await
    }

    async fn send_pointer(&self, x: u16, y: u16, button_mask: u8) -> Result<()> {
        if self.terminated.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("VNC session has ended"));
        }
        // Wheel flags are momentary: turn each tick into a button press +
        // release pair on the same position.
        if button_mask & (JS_WHEEL_UP | JS_WHEEL_DOWN) != 0 {
            let wheel_button = if button_mask & JS_WHEEL_UP != 0 {
                RFB_BUTTON_WHEEL_UP
            } else {
                RFB_BUTTON_WHEEL_DOWN
            };
            let base = js_buttons_to_rfb(button_mask);
            Self::engine_input(
                &self.engine,
                X11Event::PointerEvent(vnc::ClientMouseEvent {
                    position_x: x,
                    position_y: y,
                    bottons: base | wheel_button,
                }),
            )
            .await?;
            Self::engine_input(
                &self.engine,
                X11Event::PointerEvent(vnc::ClientMouseEvent {
                    position_x: x,
                    position_y: y,
                    bottons: base,
                }),
            )
            .await?;
            return Ok(());
        }

        Self::engine_input(
            &self.engine,
            X11Event::PointerEvent(vnc::ClientMouseEvent {
                position_x: x,
                position_y: y,
                bottons: js_buttons_to_rfb(button_mask),
            }),
        )
        .await
    }

    async fn request_full_frame(&self) -> Result<()> {
        if self.terminated.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("VNC session has ended"));
        }
        Self::engine_input(&self.engine, X11Event::FullRefresh).await
    }

    async fn set_clipboard(&self, text: String) -> Result<()> {
        if self.terminated.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("VNC session has ended"));
        }
        // RFB ClientCutText is Latin-1 only; drop text that can't survive
        // the round-trip instead of corrupting it.
        if text.is_ascii() || text.chars().all(|c| (c as u32) <= 0xFF) {
            Self::engine_input(&self.engine, X11Event::CopyText(text)).await
        } else {
            tracing::debug!("VNC clipboard text is not Latin-1; dropped");
            Ok(())
        }
    }

    fn desktop_size(&self) -> (u16, u16) {
        (self.desktop_width, self.desktop_height)
    }

    async fn resize(&mut self, _width: u16, _height: u16) -> Result<()> {
        // VNC has no server-side resize; the frontend scales the existing
        // framebuffer client-side.
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        let engine = self.engine.lock().await;
        let _ = engine.close().await;
        tracing::info!(
            "VNC disconnected from {}:{}",
            self.config.host,
            self.config.port
        );
        Ok(())
    }
}

/// Whether the keysym is a modifier (modifiers pass through unchanged —
/// their keysym names the key, not a character).
fn is_modifier(keysym: u32) -> bool {
    matches!(keysym, 0xFFE1 | 0xFFE3 | 0xFFE9 | 0xFFE5 | 0xFFEB | 0xFF67)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_lock_resolves_letter_case() {
        // Base 'a' keysym: plain, with Shift, with CapsLock, and both —
        // CapsLock XOR Shift flips the case like gtk-vnc.
        assert_eq!(apply_case(0x61, false, false), 0x61); // a
        assert_eq!(apply_case(0x61, true, false), 0x41);  // A
        assert_eq!(apply_case(0x61, false, true), 0x41);  // A (caps)
        assert_eq!(apply_case(0x61, true, true), 0x61);   // a (shift+caps)
        // Uppercase base passes through unchanged.
        assert_eq!(apply_case(0x41, false, false), 0x41);
    }

    #[test]
    fn js_letter_keysyms_use_lowercase_ascii() {
        // keyCode 'A' key (65) maps to keysym 'a' (0x61) — case is applied
        // separately from Shift state.
        assert_eq!(js_keycode_to_keysym(65), Some(0x41));
        assert_eq!(js_keycode_to_keysym(90), Some(0x5A));
    }

    #[test]
    fn js_digits_and_function_keys_map() {
        assert_eq!(js_keycode_to_keysym(48), Some(0x30)); // '0'
        assert_eq!(js_keycode_to_keysym(57), Some(0x39)); // '9'
        assert_eq!(js_keycode_to_keysym(112), Some(0xFFBE)); // F1
        assert_eq!(js_keycode_to_keysym(123), Some(0xFFC9)); // F12
    }

    #[test]
    fn js_editing_and_navigation_keys_map() {
        assert_eq!(js_keycode_to_keysym(13), Some(0xFF0D)); // Enter
        assert_eq!(js_keycode_to_keysym(8), Some(0xFF08)); // Backspace
        assert_eq!(js_keycode_to_keysym(37), Some(0xFF51)); // Left
        assert_eq!(js_keycode_to_keysym(40), Some(0xFF54)); // Down
        assert_eq!(js_keycode_to_keysym(46), Some(0xFFFF)); // Delete
        assert_eq!(js_keycode_to_keysym(16), Some(0xFFE1)); // Shift
    }

    #[test]
    fn js_unmapped_keys_return_none() {
        assert_eq!(js_keycode_to_keysym(0), None);
        assert_eq!(js_keycode_to_keysym(44), None); // PrintScreen region
        assert_eq!(js_keycode_to_keysym(200), None);
    }

    #[test]
    fn shift_applies_us_symbol_variants() {
        assert_eq!(apply_case(0x61, true, false), 0x41); // a -> A
        assert_eq!(apply_case(0x61, false, false), 0x61); // a -> a
        assert_eq!(apply_case(0x61, false, true), 0x41); // caps a -> A
        assert_eq!(apply_case(0x61, true, true), 0x61); // shift+caps a -> a
        assert_eq!(apply_case(0x31, true, false), 0x21); // 1 -> !
        assert_eq!(apply_case(0x3B, true, false), 0x3A); // ; -> :
        assert_eq!(apply_case(0x30, false, true), 0x30); // caps doesn't affect digits
    }

    #[test]
    fn modifiers_pass_through_unchanged() {
        assert!(is_modifier(0xFFE1)); // Shift_L
        assert!(is_modifier(0xFFE3)); // Control_L
        assert!(!is_modifier(0x61)); // 'a'
    }

    #[test]
    fn js_button_mask_remaps_to_rfb_layout() {
        // JS: left=1, right=2, middle=4 → RFB: left=1, middle=2, right=4
        assert_eq!(js_buttons_to_rfb(0x01), RFB_BUTTON_LEFT);
        assert_eq!(js_buttons_to_rfb(0x02), RFB_BUTTON_RIGHT);
        assert_eq!(js_buttons_to_rfb(0x04), RFB_BUTTON_MIDDLE);
        assert_eq!(js_buttons_to_rfb(0x03), RFB_BUTTON_LEFT | RFB_BUTTON_RIGHT);
        // Wheel flags are not part of the pressed state.
        assert_eq!(js_buttons_to_rfb(0x08), 0);
        assert_eq!(js_buttons_to_rfb(0x10), 0);
    }

    #[test]
    fn framebuffer_blit_extract_and_copyrect() {
        let mut fb = Framebuffer::new(4, 4);
        // Paint a 2x2 red block at (1,1)
        let red = [255u8, 0, 0, 255].repeat(4);
        fb.blit(1, 1, 2, 2, &red);
        assert_eq!(fb.pixels[(1 * 4 + 1) * 4], 255);
        // Copy it to (3,0) — the extract carries the full 2x2 source, the
        // blit clips to the single visible column at x=3.
        let pixels = fb.copy_rect(3, 0, 1, 1, 2, 2);
        assert_eq!(pixels.len(), 2 * 2 * 4);
        assert_eq!(pixels[0], 255);
        // Destination got painted
        assert_eq!(fb.pixels[(0 * 4 + 3) * 4], 255);
    }

    #[test]
    fn framebuffer_resize_resets_pixels() {
        let mut fb = Framebuffer::new(2, 2);
        fb.pixels.fill(0xEE);
        fb.resize(4, 2);
        assert_eq!(fb.pixels.len(), 4 * 2 * 4);
        assert!(fb.pixels.iter().all(|&b| b == 0));
    }

    #[test]
    fn pixel_format_depths_are_byte_aligned() {
        let pf24 = pixel_format_for_depth(24);
        assert_eq!((pf24.bits_per_pixel, pf24.depth), (32, 24));
        let pf16 = pixel_format_for_depth(16);
        assert_eq!(pf16.bits_per_pixel, 16);
        let pf8 = pixel_format_for_depth(8);
        assert_eq!(pf8.bits_per_pixel, 8);
        // Unknown depth falls back to 32bpp true colour
        assert_eq!(pixel_format_for_depth(99).bits_per_pixel, 32);
    }
}
