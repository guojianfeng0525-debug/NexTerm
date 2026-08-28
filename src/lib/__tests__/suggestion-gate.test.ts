import { describe, expect, it } from 'vitest';
import { isAlternateBuffer, isInputInPromptContext } from '../suggestion/gate';

describe('suggestion TUI gate — alternate buffer', () => {
  it('treats the alternate screen buffer as TUI mode (hard gate)', () => {
    expect(isAlternateBuffer('alternate')).toBe(true);
  });

  it('treats the normal buffer as shell mode (popup allowed)', () => {
    expect(isAlternateBuffer('normal')).toBe(false);
  });

  it('is defensive against missing/undefined buffer type', () => {
    expect(isAlternateBuffer(undefined)).toBe(false);
    expect(isAlternateBuffer(null)).toBe(false);
    expect(isAlternateBuffer('')).toBe(false);
  });
});

describe('suggestion TUI gate — prompt-line context', () => {
  it('allows a popup when the line ends with the typed input (shell waiting)', () => {
    expect(isInputInPromptContext('root@host:~# git ', 'git ')).toBe(true);
    expect(isInputInPromptContext('user@dev:/var/www$ systemctl start', 'systemctl start')).toBe(true);
    expect(isInputInPromptContext('mysql> SELECT ', 'SELECT ')).toBe(true);
  });

  it('blocks a popup when the typed keys never reached the line end (TUI navigation)', () => {
    // vi normal-mode keys, menu navigation etc. never append to the line.
    expect(isInputInPromptContext('', 'j')).toBe(false);
    expect(isInputInPromptContext('root@host:~# ', 'j')).toBe(false);
    // A line whose text happens to contain the key, but does not END with it.
    expect(isInputInPromptContext('function foo() {', 'j')).toBe(false);
    expect(isInputInPromptContext('>  Item 1', 'j')).toBe(false);
  });

  it('blocks popups while editing mid-line (cursor not at line end)', () => {
    expect(isInputInPromptContext('root@host:~# docker ps | grep web', 'docker ps')).toBe(false);
  });

  it('blocks empty / whitespace-only input', () => {
    expect(isInputInPromptContext('root@host:~# ', '')).toBe(false);
    expect(isInputInPromptContext('root@host:~# ', '   ')).toBe(false);
  });

  it('matches a multi-word typed command appearing at the line end', () => {
    expect(isInputInPromptContext('root@host:~# docker ps | grep web', 'grep web')).toBe(true);
  });

  it('does not confuse a partially-typed command with a different one', () => {
    expect(isInputInPromptContext('root@host:~# git ', 'sudo')).toBe(false);
  });

  it('handles multi-byte (CJK) input without splitting', () => {
    expect(isInputInPromptContext('root@host:~# echo 你好', 'echo 你好')).toBe(true);
    expect(isInputInPromptContext('root@host:~# echo ', '你好')).toBe(false);
  });

  it('tolerates trailing whitespace on the line, input is trimmed', () => {
    expect(isInputInPromptContext('root@host:~# git status   ', 'git status')).toBe(true);
    expect(isInputInPromptContext('root@host:~# git status', 'git status  ')).toBe(true);
  });

  it('a bare output line ending with the key is not prompt context by itself', () => {
    // Output that happens to end with the typed key, with no input appended,
    // is not a shell-waiting prompt — the popup stays hidden (conservative).
    expect(isInputInPromptContext('abc', 'abc')).toBe(true); // input truly on line end
    expect(isInputInPromptContext('build completed', 'j')).toBe(false);
  });
});
