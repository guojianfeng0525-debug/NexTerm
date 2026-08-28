import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';
import * as suggestionStore from '../lib/suggestion/store';

/**
 * QA — 命令建议弹窗交互优化（hover 与选中分离 + acceptSuggestion 段级替换）。
 *
 * 覆盖：
 *  - P0: hover 只是预览，不再写 selectedIndexRef → Enter 不会因鼠标路过而误选
 *  - ↑/↓ 键盘选中优先于 hover
 *  - 点击候选 → 应用并关窗；mouseLeave → hover 高亮消失
 *  - acceptSuggestion 段级替换：A1（相等仅关窗）/ A2（补尾）/ A3（整段替换）
 *  - 中段光标 token 替换（光标不在行尾时）
 *
 * Mock 模式与 pty-terminal-suggestion-gates.test.tsx 一致，另 mock
 * suggestion engine 的 rankSuggestions，以便直接控制弹窗候选内容。
 */

const rankSuggestionsMock = vi.hoisted(() => vi.fn());

const mocks = vi.hoisted(() => {
  const terminals: Array<any> = [];
  const fitAddons: Array<any> = [];
  const webSockets: Array<any> = [];
  const bufferChangeCallbacks: Array<(buffer: { type?: string }) => void> = [];
  const scrollCallbacks: Array<() => void> = [];
  const textareaListeners: string[] = [];
  const terminalCallbacks = { onWorkingDirectoryChange: vi.fn() };
  // Current terminal line returned by buffer.getLine(cursorY).
  let currentLine = 'root@host:~# ';
  // Cursor column; null → follow the end of the line.
  let cursorXValue: number | null = null;

  function makeTextarea(): HTMLTextAreaElement {
    const el = document.createElement('textarea');
    const origAdd = el.addEventListener.bind(el);
    el.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      textareaListeners.push(type);
      return origAdd(type, listener, options);
    }) as typeof el.addEventListener;
    return el;
  }

  class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    textarea = makeTextarea();
    buffer = {
      active: {
        length: 0,
        cursorY: 0,
        get cursorX() {
          return cursorXValue ?? currentLine.length;
        },
        getLine: vi.fn(() => ({
          translateToString: (_trim?: boolean) => currentLine,
        })),
      },
      onBufferChange: vi.fn((cb: (buffer: { type?: string }) => void) => {
        bufferChangeCallbacks.push(cb);
        return { dispose: vi.fn() };
      }),
    };
    oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
    parser = {
      registerOscHandler: vi.fn((identifier: number, handler: (data: string) => boolean | Promise<boolean>) => {
        this.oscHandlers.set(identifier, handler);
        return { dispose: vi.fn() };
      }),
    };

    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    refresh = vi.fn();
    writeln = vi.fn();
    write = vi.fn((_data: string, callback?: () => void) => callback?.());
    onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
    onLineFeed = vi.fn(() => ({ dispose: vi.fn() }));
    onScroll = vi.fn((cb: () => void) => {
      scrollCallbacks.push(cb);
      return { dispose: vi.fn() };
    });
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    selectAll = vi.fn();
    clear = vi.fn();
    reset = vi.fn();
    dispose = vi.fn();
  }

  class MockWebSocket {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = 3;
    });
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(public url: string) {
      webSockets.push(this);
    }
  }

  const Terminal = vi.fn(function Terminal() {
    const terminal = new MockTerminal();
    terminals.push(terminal);
    return terminal;
  });

  return {
    terminals,
    fitAddons,
    webSockets,
    bufferChangeCallbacks,
    scrollCallbacks,
    textareaListeners,
    terminalCallbacks,
    Terminal,
    MockWebSocket,
    setCurrentLine: (line: string) => {
      currentLine = line;
    },
    setCursorX: (x: number | null) => {
      cursorXValue = x;
    },
    currentLine,
  };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: mocks.Terminal,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function FitAddon() {
    const addon = { fit: vi.fn(), dispose: vi.fn() };
    mocks.fitAddons.push(addon);
    return addon;
  }),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(function WebLinksAddon() {
    return { dispose: vi.fn() };
  }),
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(function WebglAddon() {
    return { dispose: vi.fn(), onContextLoss: vi.fn() };
  }),
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(function SearchAddon() {
    return { findNext: vi.fn(), findPrevious: vi.fn() };
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => (command === 'get_websocket_port' ? 9001 : undefined)),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn().mockResolvedValue(''),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/terminal-config', () => ({
  defaultTerminalTheme: { background: '#000000' },
  terminalThemes: { 'vs-code-dark': { background: '#000000' } },
  loadAppearanceSettings: vi.fn(() => ({
    allowTransparency: false,
    backgroundImage: '',
    opacity: 100,
    theme: 'vs-code-dark',
  })),
  getThemeAwareTerminalOptions: vi.fn(() => ({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: 'monospace',
    fontSize: 14,
    scrollback: 10000,
    theme: {},
  })),
  getThemeAwareTerminalTheme: vi.fn(() => ({ background: '#000000' })),
}));

vi.mock('../components/terminal/terminal-context-menu', () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../components/terminal/terminal-search-bar', () => ({
  TerminalSearchBar: () => null,
}));

vi.mock('../lib/restoration-manager', () => ({
  signalReady: vi.fn(),
}));

vi.mock('../lib/terminal-callbacks-context', () => ({
  useTerminalCallbacks: () => mocks.terminalCallbacks,
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

// Engine: fully mocked so tests control the exact candidate list.
vi.mock('../lib/suggestion/engine', () => ({
  rankSuggestions: rankSuggestionsMock,
}));

// Suggestion store: keep real scope helpers, stub feedback/IO.
vi.mock('../lib/suggestion/store', async (importOriginal) => {
  const actual = await importOriginal<typeof suggestionStore>();
  return {
    ...actual,
    getStatsForScopes: vi.fn(() => []),
    recordUse: vi.fn(),
    recordSelection: vi.fn(),
    recordRejection: vi.fn(),
  };
});

// Preferences: prefGet is the only surface PtyTerminal reads for settings.
const prefGetMock = vi.hoisted(() => vi.fn((_key: string, fallback: unknown) => fallback));
vi.mock('../lib/preferences', () => ({
  prefGet: prefGetMock,
}));

import { getStatsForScopes } from '../lib/suggestion/store';
import { connectionScope } from '../lib/suggestion/store';

const getStatsForScopesMock = vi.mocked(getStatsForScopes);

function renderTerminal(isActive = true) {
  return render(
    <PtyTerminal
      connectionId="connection-1"
      connectionName="SSH Server"
      host="127.0.0.1"
      username="root"
      isActive={isActive}
    />,
  );
}

function getOnData(): (data: string) => void {
  const calls = mocks.terminals[0].onData.mock.calls;
  const cb = calls[calls.length - 1]?.[0];
  expect(cb).toBeDefined();
  return cb;
}

function getCustomKeyHandler(): (event: KeyboardEvent) => boolean {
  const handler = mocks.terminals[0].attachCustomKeyEventHandler.mock.calls[0]?.[0];
  expect(handler).toBeDefined();
  return handler as (event: KeyboardEvent) => boolean;
}

function suggestionBar() {
  return document.querySelector('[data-suggestion-bar]');
}

function suggestionButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-suggestion-bar] button')) as HTMLElement[];
}

function findButton(text: string): HTMLElement {
  const btn = suggestionButtons().find((b) => b.textContent?.includes(text));
  expect(btn).toBeDefined();
  return btn!;
}

/** Feed terminal data (simulates user typing through xterm onData). */
async function typeInput(data: string) {
  await act(async () => {
    getOnData()(data);
  });
}

/** Flush timers (WebSocket connect + debounce). */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mountAndConnect() {
  renderTerminal(true);
  await advance(60);
  expect(mocks.webSockets).toHaveLength(1);
}

/** Show the popup with an exact candidate list for the given input/line. */
async function popupWith(input: string, line: string, candidates: string[]) {
  rankSuggestionsMock.mockReturnValue({
    mode: 'popup',
    candidates: candidates.map((c) => ({ command: c, score: 100, exact: true })),
  });
  mocks.setCurrentLine(line);
  await typeInput(input);
  await advance(60); // debounce (default 50ms) + margin
  expect(suggestionBar()).not.toBeNull();
}

/** Decode the last Input payload sent to the (fake) PTY at/after `startIndex`
 *  send-call index — typeInput() itself forwards every typed char to the PTY,
 *  so assertions must only look at payloads added AFTER a baseline. */
function inputPayloadsSince(startIndex: number): number[] | null {
  const sends = mocks.webSockets[0].send.mock.calls.map((c) => c[0]);
  for (let i = sends.length - 1; i >= startIndex; i--) {
    try {
      const parsed = JSON.parse(String(sends[i]));
      if (parsed.type === 'Input' && Array.isArray(parsed.data)) return parsed.data;
    } catch {
      /* skip non-JSON / non-input frames */
    }
  }
  return null;
}

function sendCount(): number {
  return mocks.webSockets[0].send.mock.calls.length;
}

function decode(bytes: number[]): string {
  return String.fromCharCode(...bytes);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  rankSuggestionsMock.mockReset();
  mocks.terminals.length = 0;
  mocks.fitAddons.length = 0;
  mocks.webSockets.length = 0;
  mocks.bufferChangeCallbacks.length = 0;
  mocks.scrollCallbacks.length = 0;
  mocks.textareaListeners.length = 0;
  mocks.terminalCallbacks.onWorkingDirectoryChange.mockClear();
  mocks.setCurrentLine('root@host:~# ');
  mocks.setCursorX(null);
  getStatsForScopesMock.mockReturnValue([]);

  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });

  vi.stubGlobal('WebSocket', mocks.MockWebSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0)),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => window.clearTimeout(id)));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PtyTerminal suggestion interaction (hover/Enter/click + segment replace)', () => {
  it('P0: hover does NOT pre-select — Enter after hover executes the typed input', async () => {
    await mountAndConnect();
    await popupWith('git ', 'root@host:~# git ', ['git status', 'git commit', 'git push']);
    const buttons = suggestionButtons();
    expect(buttons.length).toBe(3);

    // Hover a candidate: it becomes a *preview* (ring), never the Enter target.
    await act(async () => {
      fireEvent.mouseEnter(buttons[0]);
    });
    expect(buttons[0].className).toContain('ring');
    expect(buttons[0].className).not.toContain('bg-primary');

    const base = sendCount();
    const preventDefault = vi.fn();
    let handled = false;
    await act(async () => {
      handled = getCustomKeyHandler()({
        type: 'keydown',
        key: 'Enter',
        preventDefault,
      } as unknown as KeyboardEvent);
    });

    // Enter passes through → the typed command executes; no replacement sent.
    expect(handled).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(suggestionBar()).toBeNull();
    expect(inputPayloadsSince(base)).toBeNull();
  });

  it('keyboard selection wins over hover: ↑↓ then hover another row, Enter applies the selected row', async () => {
    await mountAndConnect();
    await popupWith('git ', 'root@host:~# git ', ['git status', 'git commit', 'git push']);
    const preventDefault = vi.fn();

    await act(async () => {
      getCustomKeyHandler()({
        type: 'keydown',
        key: 'ArrowDown',
        preventDefault,
      } as unknown as KeyboardEvent);
    });
    expect(preventDefault).toHaveBeenCalled();

    // Hover a DIFFERENT row (git push) — must not override the keyboard pick.
    await act(async () => {
      fireEvent.mouseEnter(suggestionButtons()[2]);
    });

    const base = sendCount();
    let handled = false;
    await act(async () => {
      handled = getCustomKeyHandler()({
        type: 'keydown',
        key: 'Enter',
        preventDefault,
      } as unknown as KeyboardEvent);
    });
    expect(handled).toBe(false); // consumed by the app → accepted
    expect(suggestionBar()).toBeNull();

    // ↓ selected 'git status' → A2 tail for buf 'git ' → 'status '.
    const payload = inputPayloadsSince(base);
    expect(payload).not.toBeNull();
    expect(decode(payload!)).toBe('status ');
  });

  it('click applies the candidate and closes the popup', async () => {
    await mountAndConnect();
    await popupWith('git ', 'root@host:~# git ', ['git status', 'git commit', 'git push']);
    const base = sendCount();

    await act(async () => {
      fireEvent.click(findButton('git commit'));
    });
    expect(suggestionBar()).toBeNull();
    const payload = inputPayloadsSince(base);
    expect(payload).not.toBeNull();
    expect(decode(payload!)).toBe('commit ');
  });

  it('mouse leave clears the hover highlight', async () => {
    await mountAndConnect();
    await popupWith('git ', 'root@host:~# git ', ['git status', 'git commit', 'git push']);
    const button = suggestionButtons()[0];

    await act(async () => {
      fireEvent.mouseEnter(button);
    });
    expect(button.className).toContain('ring');

    await act(async () => {
      fireEvent.mouseLeave(button);
    });
    expect(button.className).not.toContain('ring');
    expect(button.className).not.toContain('bg-primary');
    expect(suggestionBar()).not.toBeNull(); // leave does not close the popup
  });

  it('A1: candidate equals the typed command → just close, send nothing', async () => {
    await mountAndConnect();
    await popupWith('git status', 'root@host:~# git status', ['git status']);
    const base = sendCount();

    await act(async () => {
      fireEvent.click(findButton('git status'));
    });
    expect(suggestionBar()).toBeNull();
    expect(inputPayloadsSince(base)).toBeNull();
  });

  it('A2: `git ` + `git commit` → payload is the missing tail `commit ` (no double space)', async () => {
    await mountAndConnect();
    await popupWith('git ', 'root@host:~# git ', ['git status', 'git commit']);
    const base = sendCount();

    await act(async () => {
      fireEvent.click(findButton('git commit'));
    });
    const payload = inputPayloadsSince(base);
    expect(payload).not.toBeNull();
    expect(decode(payload!)).toBe('commit ');
  });

  it('A3: `git log ` + `git status` → 8 backspaces + `git status ` (whole segment replaced)', async () => {
    await mountAndConnect();
    await popupWith('git log ', 'root@host:~# git log ', ['git status']);
    const base = sendCount();

    await act(async () => {
      fireEvent.click(findButton('git status'));
    });
    const payload = inputPayloadsSince(base);
    expect(payload).not.toBeNull();
    expect(decode(payload!)).toBe('\x7f'.repeat(8) + 'git status ');
  });

  it('mid-line: cursor inside `cat` of `echo hello | cat file` → replace the token, keep the tail', async () => {
    await mountAndConnect();
    const input = 'echo hello | cat file';
    await popupWith(input, `root@host:~# ${input}`, ['cat']);
    // Cursor sits on `t` (between `ca` and ` file`): col 28 in the full line
    // (prompt `root@host:~# ` is 13 chars).
    mocks.setCursorX(28);
    const base = sendCount();

    await act(async () => {
      fireEvent.click(findButton('cat'));
    });
    const payload = inputPayloadsSince(base);
    expect(payload).not.toBeNull();
    expect(decode(payload!)).toBe('\x1b[C'.repeat(1) + '\x7f'.repeat(3) + 'cat');
  });

  it('mid-line: cursor inside `--amend` when candidate equals the line → just move cursor to EOL', async () => {
    await mountAndConnect();
    const input = 'git commit --amend';
    await popupWith(input, `root@host:~# ${input}`, [input]);
    // Cursor after `--am` (on `e`): col 28 in the full line (prompt is 13).
    mocks.setCursorX(28);
    const base = sendCount();

    await act(async () => {
      fireEvent.click(findButton(input));
    });
    const payload = inputPayloadsSince(base);
    expect(payload).not.toBeNull();
    expect(decode(payload!)).toBe('\x1b[C'.repeat(3));
  });

  it('pipeline segment: `ps -ef | gre` + `grep nginx` → A2 tail `p nginx ` keeps the pipe', async () => {
    await mountAndConnect();
    await popupWith('ps -ef | gre', 'root@host:~# ps -ef | gre', ['grep nginx']);
    const base = sendCount();

    await act(async () => {
      fireEvent.click(findButton('grep nginx'));
    });
    const payload = inputPayloadsSince(base);
    expect(payload).not.toBeNull();
    expect(decode(payload!)).toBe('p nginx ');
  });

  it('Esc still clears hover preview and dismisses the popup', async () => {
    await mountAndConnect();
    await popupWith('git ', 'root@host:~# git ', ['git status', 'git commit']);
    const button = suggestionButtons()[0];
    await act(async () => {
      fireEvent.mouseEnter(button);
    });
    expect(button.className).toContain('ring');

    const preventDefault = vi.fn();
    await act(async () => {
      getCustomKeyHandler()({
        type: 'keydown',
        key: 'Escape',
        preventDefault,
      } as unknown as KeyboardEvent);
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(suggestionBar()).toBeNull();
  });
});
