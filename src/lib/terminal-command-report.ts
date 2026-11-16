/**
 * Streaming extractor for OSC 7777 executed-command reports.
 *
 * The remote shell integration emits the exact command line the user
 * submitted (multi-line, pasted, tab-completed and history-recalled included)
 * as `ESC ] 7777 ; <base64(UTF-8 command)> ST`, where ST is `ESC \` or BEL.
 * This is orders of magnitude more reliable than scraping the xterm buffer:
 * the previous approach (locally replaying the readline buffer from
 * keystrokes) broke on arrow-key history recall (ESC reset the buffer),
 * pastes (gated out), tab completion and soft-wrapped long lines.
 *
 * The extractor runs BEFORE the text reaches xterm.js: the sequence is
 * stripped from the render stream (it would otherwise be invisible but still
 * parsed) and survives chunk boundaries in the WebSocket output stream.
 */

/** Longest command payload we accept; giant pasted scripts are not history. */
const MAX_COMMAND_CHARS = 10_000;
/** OSC payloads arriving without a terminator within this window are junk. */
const MAX_PENDING_CHARS = 64 * 1024;

const OSC_PREFIX = '\x1b]7777;';
const ST_ESC = '\x1b\\';
const ST_BEL = '\x07';

export interface OscCommandExtractor {
  /** Feed one decoded output chunk; returns the text that should be rendered. */
  push(text: string): string;
}

function decodePayload(payload: string): string | null {
  const trimmed = payload.replace(/\s+/g, '');
  if (!trimmed || trimmed.length > MAX_COMMAND_CHARS * 2) return null;
  let binary: string;
  try {
    binary = atob(trimmed);
  } catch {
    return null;
  }
  if (!binary || binary.length > MAX_COMMAND_CHARS) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const command = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // Reject reports that contain control characters — a real shell command
  // line can contain tabs/newlines, but not ESC/backspace garbage from a
  // malformed stream.
  if (!command.trim()) return null;
  // eslint-disable-next-line no-control-regex -- rejecting control bytes is the point of this check
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) return null;
  return command;
}

/**
 * Create an extractor. `onCommand` fires once per complete OSC 7777 report
 * with the decoded command text.
 */
export function createOscCommandExtractor(
  onCommand: (command: string) => void,
): OscCommandExtractor {
  let pending = '';

  /** Longest suffix of `text` that could be the start of `OSC_PREFIX`. */
  const partialPrefixLength = (text: string): number => {
    const checkable = Math.min(text.length, OSC_PREFIX.length - 1);
    for (let len = checkable; len > 0; len -= 1) {
      if (OSC_PREFIX.startsWith(text.slice(text.length - len))) return len;
    }
    return 0;
  };

  return {
    push(text: string): string {
      let combined = pending + text;
      pending = '';
      let out = '';

      for (;;) {
        const start = combined.indexOf(OSC_PREFIX);
        if (start < 0) {
          const keep = partialPrefixLength(combined);
          if (keep > 0) {
            pending = combined.slice(combined.length - keep);
            combined = combined.slice(0, combined.length - keep);
          }
          return out + combined;
        }

        out += combined.slice(0, start);
        const cursor = start + OSC_PREFIX.length;
        let end = -1;
        let terminatorLength = 0;
        // Scan for the terminator without allocating substrings per byte.
        // BEL is a single char and may sit on the very last position of the
        // chunk; the two-char ST needs its second byte present.
        for (let i = cursor; i < combined.length; i += 1) {
          if (combined[i] === ST_BEL) {
            end = i;
            terminatorLength = ST_BEL.length;
            break;
          }
          if (combined[i] === ST_ESC[0] && i + 1 < combined.length && combined[i + 1] === ST_ESC[1]) {
            end = i;
            terminatorLength = ST_ESC.length;
            break;
          }
        }
        if (end < 0) {
          if (cursor > MAX_PENDING_CHARS) {
            // Unterminated junk — drop the whole run and keep scanning.
            combined = combined.slice(cursor);
            continue;
          }
          pending = combined.slice(start);
          return out;
        }

        const command = decodePayload(combined.slice(cursor, end));
        if (command !== null) onCommand(command);
        combined = combined.slice(end + terminatorLength);
      }
    },
  };
}
