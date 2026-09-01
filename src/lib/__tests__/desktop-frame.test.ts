import { describe, it, expect } from 'vitest';
import { parseDesktopFrame, drawFrameUpdate, DESKTOP_FRAME_CMD } from '../desktop-frame';

/** Build a binary desktop frame exactly as the Rust backend encodes it. */
function buildFrame(
  connectionId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  pixel: [number, number, number, number] = [255, 0, 0, 255],
): ArrayBuffer {
  const idBytes = new TextEncoder().encode(connectionId);
  const rgbaLength = width * height * 4;
  const buffer = new ArrayBuffer(3 + idBytes.length + 8 + rgbaLength);
  const view = new DataView(buffer);
  view.setUint8(0, DESKTOP_FRAME_CMD);
  view.setUint16(1, idBytes.length, false);
  new Uint8Array(buffer, 3, idBytes.length).set(idBytes);
  const base = 3 + idBytes.length;
  view.setUint16(base, x, false);
  view.setUint16(base + 2, y, false);
  view.setUint16(base + 4, width, false);
  view.setUint16(base + 6, height, false);
  const rgba = new Uint8Array(buffer, base + 8, rgbaLength);
  for (let i = 0; i < rgbaLength; i += 4) {
    rgba[i] = pixel[0];
    rgba[i + 1] = pixel[1];
    rgba[i + 2] = pixel[2];
    rgba[i + 3] = pixel[3];
  }
  return buffer;
}

describe('parseDesktopFrame', () => {
  it('parses a well-formed frame', () => {
    const buffer = buildFrame('conn-1', 10, 20, 4, 3);
    const frame = parseDesktopFrame(buffer);
    expect(frame).not.toBeNull();
    expect(frame!.connectionId).toBe('conn-1');
    expect(frame!.x).toBe(10);
    expect(frame!.y).toBe(20);
    expect(frame!.width).toBe(4);
    expect(frame!.height).toBe(3);
    expect(frame!.rgba.length).toBe(4 * 3 * 4);
    expect(frame!.rgba[0]).toBe(255);
    expect(frame!.rgba[1]).toBe(0);
    expect(frame!.rgba[2]).toBe(0);
    expect(frame!.rgba[3]).toBe(255);
  });

  it('parses a full-desktop frame at the origin', () => {
    const buffer = buildFrame('a'.repeat(36), 0, 0, 1024, 768, [12, 34, 56, 78]);
    const frame = parseDesktopFrame(buffer);
    expect(frame).not.toBeNull();
    expect(frame!.x).toBe(0);
    expect(frame!.width).toBe(1024);
    expect(frame!.height).toBe(768);
    expect(frame!.rgba.length).toBe(1024 * 768 * 4);
    expect(frame!.rgba[1000]).toBe(12);
  });

  it('rejects a wrong command byte', () => {
    const buffer = buildFrame('conn-1', 0, 0, 1, 1);
    const view = new DataView(buffer);
    view.setUint8(0, 0x01); // PTY output command
    expect(parseDesktopFrame(buffer)).toBeNull();
  });

  it('rejects truncated payloads', () => {
    const buffer = buildFrame('conn-1', 0, 0, 4, 4);
    const truncated = buffer.slice(0, buffer.byteLength - 8);
    expect(parseDesktopFrame(truncated)).toBeNull();
  });

  it('rejects a header shorter than the declared id', () => {
    const buffer = new ArrayBuffer(11);
    const view = new DataView(buffer);
    view.setUint8(0, DESKTOP_FRAME_CMD);
    view.setUint16(1, 100, false); // declares a 100-byte id that is not present
    expect(parseDesktopFrame(buffer)).toBeNull();
  });

  it('rejects a payload that does not match the declared rectangle', () => {
    const buffer = buildFrame('conn-1', 0, 0, 2, 2);
    const view = new DataView(buffer);
    view.setUint16(3 + 'conn-1'.length + 4, 3, false); // widen declared width
    expect(parseDesktopFrame(buffer)).toBeNull();
  });

  it('rejects buffers shorter than the fixed header', () => {
    expect(parseDesktopFrame(new ArrayBuffer(4))).toBeNull();
  });
});

describe('drawFrameUpdate', () => {
  it('blits the frame into the canvas at its dirty rectangle', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // jsdom without the optional `canvas` package has no 2D context;
      // rendering is exercised in the real WKWebView.
      return;
    }
    const frame = parseDesktopFrame(buildFrame('c', 2, 3, 2, 2, [10, 20, 30, 255]))!;
    drawFrameUpdate(ctx, frame);
    const data = ctx.getImageData(2, 3, 1, 1).data;
    expect(Array.from(data)).toEqual([10, 20, 30, 255]);
  });
});
