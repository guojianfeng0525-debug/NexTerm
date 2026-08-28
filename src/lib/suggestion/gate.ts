/**
 * Gate helpers for the terminal command-suggestion popup.
 *
 * The popup must never fire while a full-screen TUI app (vim/less/top/htop/fzf)
 * owns the terminal — suggestions drawn over an alternate screen hide the app's
 * own UI and break editing. We gate the popup on two signals:
 *
 *  1. Alternate screen buffer (DECSET ?1049 / ?47) — entered by virtually every
 *     full-screen TUI. xterm.js exposes this as `buffer.active.type`.
 *  2. Prompt-line context — the typed input must actually appear in the current
 *     line (i.e. the shell is waiting for input on that line). This is a cheap
 *     terminal-side proxy for shell-integration "prompt boundary" semantics and
 *     catches line-editor based apps (mysql/psql keep the normal buffer) plus
 *     any TUI whose key presses never reach the line buffer.
 */

/**
 * True when the terminal is in the alternate screen buffer (full-screen TUI
 * application mode). This is the primary hard gate for the suggestion popup.
 */
export function isAlternateBuffer(type: string | undefined | null): boolean {
  return type === 'alternate';
}

/**
 * True when the current line looks like an interactive prompt line that ends
 * with the user's in-progress input — i.e. the shell is waiting for input at
 * the end of that exact line. Used as a soft gate: if the typed keys never
 * reached the line's end (TUI navigation, line-editor apps consuming keys,
 * mid-line cursor editing), the popup must not fire.
 */
export function isInputInPromptContext(line: string, input: string): boolean {
  const trimmedInput = input.trim();
  if (!trimmedInput) return false;
  if (!line) return false;
  return line.trimEnd().endsWith(trimmedInput);
}

/**
 * True when the data chunk carries the bracketed-paste START marker. xterm
 * wraps pasted text in `\x1b[200~ … \x1b[201~` (when the shell enabled
 * bracketed-paste mode); while it streams in, the text is not interactive
 * typing, so the suggestion popup must not track or fire.
 */
export function isPasteStart(data: string): boolean {
  return data.includes('\x1b[200~');
}

/** True when the data chunk carries the bracketed-paste END marker. */
export function isPasteEnd(data: string): boolean {
  return data.includes('\x1b[201~');
}

/**
 * Normalize the user-configurable suggestion debounce delay (ms). Any
 * non-numeric / negative / NaN value falls back to the default 50 ms.
 */
export function normalizeSuggestionDebounceMs(value: unknown, fallback = 50): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
