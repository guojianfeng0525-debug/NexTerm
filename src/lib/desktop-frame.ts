/**
 * Binary desktop framebuffer protocol (frontend side).
 *
 * A desktop frame message is:
 *   [cmd: u8 = 0x03]
 *   [id_len: u16 BE][connection_id bytes]
 *   [x: u16 BE][y: u16 BE][width: u16 BE][height: u16 BE]
 *   [rgba data: width * height * 4 bytes]
 *
 * All integers are big-endian, matching the PTY binary output framing.
 */

/** Command byte identifying a binary desktop framebuffer update. */
export const DESKTOP_FRAME_CMD = 0x03;

export interface DesktopFrameUpdate {
  connectionId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Raw RGBA pixels for the dirty rectangle (width × height × 4 bytes). */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Parse a binary WebSocket message into a desktop frame update.
 * Returns `null` for messages that are not desktop frames (wrong command
 * byte, truncated payload, or mismatched id string).
 */
export function parseDesktopFrame(buffer: ArrayBuffer): DesktopFrameUpdate | null {
  if (buffer.byteLength < 11) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== DESKTOP_FRAME_CMD) return null;

  const idLen = view.getUint16(1, false); // big-endian
  const headerLen = 3 + idLen + 8;
  if (buffer.byteLength < headerLen) return null;

  const idBytes = new Uint8Array(buffer, 3, idLen);
  const connectionId = new TextDecoder().decode(idBytes);

  const x = view.getUint16(3 + idLen, false);
  const y = view.getUint16(3 + idLen + 2, false);
  const width = view.getUint16(3 + idLen + 4, false);
  const height = view.getUint16(3 + idLen + 6, false);

  const rgba = new Uint8ClampedArray(buffer, headerLen, buffer.byteLength - headerLen);
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    // Payload does not match the declared rectangle — reject.
    return null;
  }

  return { connectionId, x, y, width, height, rgba };
}

/**
 * Blit a parsed frame onto a canvas 2D context at its dirty rectangle.
 */
export function drawFrameUpdate(ctx: CanvasRenderingContext2D, frame: DesktopFrameUpdate): void {
  const imageData = ctx.createImageData(frame.width, frame.height);
  imageData.data.set(frame.rgba);
  ctx.putImageData(imageData, frame.x, frame.y);
}
