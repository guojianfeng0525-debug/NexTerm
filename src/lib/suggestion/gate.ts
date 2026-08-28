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
