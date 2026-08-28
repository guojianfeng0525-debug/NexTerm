import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';
import * as suggestionStore from '../lib/suggestion/store';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';

/**
 * QA — Slice 2/3 component-level gates.
 *
 * Covers the dismissal/timing system added to PtyTerminal:
 *  - G2 IME composition gate (compositionstart/end on the hidden textarea)
 *  - G3 bracketed-paste gate (onData payload with \x1b[200~ … \x1b[201~)
 *  - G4 focus-loss gate (blur on the hidden textarea)
 *  - G5 scroll gate (term.onScroll)
 *  - debounce value from settings (default 50 ms)
 *  - suggestionTuiGateEnabled=false disables the alternate-buffer hard gate
 *  - recordRejection negative feedback on Escape
 *
 * Mock pattern mirrors pty-terminal-activation.test.tsx (hoisted xterm/WS
 * mocks + real textarea so IME/focus listeners can be exercised).
 */

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

// Suggestion store: keep real scope/connection helpers, spy the feedback fns.
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
// Default implementation returns `fallback` (as the real module does when the
// key is unknown / not hydrated); tests override for specific blobs.
const prefGetMock = vi.hoisted(() => vi.fn((_key: string, fallback: unknown) => fallback));
vi.mock('../lib/preferences', () => ({
  prefGet: prefGetMock,
}));

import { getStatsForScopes, recordRejection } from '../lib/suggestion/store';
import { connectionScope } from '../lib/suggestion/store';

const gitStats = () => [
  { command: 'git status', scope: 'G', use_count: 5, selection_count: 0, rejection_count: 0, last_used: Date.now() },
  { command: 'git commit', scope: 'G', use_count: 3, selection_count: 0, rejection_count: 0, last_used: Date.now() },
  { command: 'git push', scope: 'G', use_count: 2, selection_count: 0, rejection_count: 0, last_used: Date.now() },
];

const getStatsForScopesMock = vi.mocked(getStatsForScopes);
const recordRejectionMock = vi.mocked(recordRejection);

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

function getBufferChangeCallback(): (buffer: { type?: string }) => void {
  return mocks.bufferChangeCallbacks[0];
}

function getScrollCallback(): () => void {
  return mocks.scrollCallbacks[0];
}

function suggestionBar() {
  return document.querySelector('[data-suggestion-bar]');
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
  // WebSocket must be created and opened.
  expect(mocks.webSockets).toHaveLength(1);
}

async function popupForGit() {
  getStatsForScopesMock.mockReturnValue(gitStats());
  mocks.setCurrentLine('root@host:~# git ');
  await typeInput('git ');
  await advance(60); // debounce (default 50ms) + margin
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.terminals.length = 0;
  mocks.fitAddons.length = 0;
  mocks.webSockets.length = 0;
  mocks.bufferChangeCallbacks.length = 0;
  mocks.scrollCallbacks.length = 0;
  mocks.textareaListeners.length = 0;
  mocks.terminalCallbacks.onWorkingDirectoryChange.mockClear();
  mocks.setCurrentLine('root@host:~# ');
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

describe('PtyTerminal suggestion gates (Slice 2/3)', () => {
  it('G2 IME: compositionstart hides the popup and composition blocks tracking', async () => {
    await mountAndConnect();
    await popupForGit();
    expect(suggestionBar()).not.toBeNull();

    const textarea = mocks.terminals[0].textarea;
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    expect(suggestionBar()).toBeNull();

    // During composition, further input must not re-track or re-pop.
    getStatsForScopesMock.mockClear();
    await typeInput('x');
    await advance(100);
    expect(getStatsForScopesMock).not.toHaveBeenCalled();
    expect(suggestionBar()).toBeNull();

    // Composition end resumes tracking. The popup dismissal kept the tracked
    // buffer ('git '), so a real user clears the line before typing again.
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await typeInput('\x7f\x7f\x7f\x7f'); // Backspace ×4 clears the stale buffer
    mocks.setCurrentLine('root@host:~# ');
    await typeInput('git ');
    mocks.setCurrentLine('root@host:~# git ');
    await advance(60);
    expect(suggestionBar()).not.toBeNull();
  });

  it('G3 paste: bracketed-paste payload is never tracked as typed input', async () => {
    await mountAndConnect();
    const onData = getOnData();
    const { recordUse } = await import('../lib/suggestion/store');
    const recordUseMock = vi.mocked(recordUse);

    // Simulate a bracketed paste of a command that IS in the stats.
    await act(async () => {
      onData('\x1b[200~git log\x1b[201~');
    });
    await act(async () => {
      onData('\r'); // Enter — would record the tracked buffer if any
    });
    await advance(100);

    expect(recordUseMock).not.toHaveBeenCalled();
  });

  it('G4 blur: leaving the terminal dismisses the popup', async () => {
    await mountAndConnect();
    await popupForGit();
    expect(suggestionBar()).not.toBeNull();

    await act(async () => {
      fireEvent.blur(mocks.terminals[0].textarea);
    });
    expect(suggestionBar()).toBeNull();
  });

  it('G5 scroll: scrolling the scrollback dismisses the popup', async () => {
    await mountAndConnect();
    await popupForGit();
    expect(suggestionBar()).not.toBeNull();

    await act(async () => {
      getScrollCallback()();
    });
    expect(suggestionBar()).toBeNull();
  });

  it('debounce: uses the configured suggestionDebounceMs (default 50)', async () => {
    await mountAndConnect();
    getStatsForScopesMock.mockReturnValue(gitStats());
    mocks.setCurrentLine('root@host:~# git ');

    await typeInput('git ');
    // Before the 50 ms debounce elapses the popup must stay hidden.
    await advance(20);
    expect(suggestionBar()).toBeNull();
    // After the debounce window it pops.
    await advance(40);
    expect(suggestionBar()).not.toBeNull();
  });

  it('tui-gate toggle: suggestionTuiGateEnabled=false restores pre-Slice-1 behavior', async () => {
    // Configure the TUI hard gate OFF via the settings blob read at mount.
    vi.mocked(prefGetMock).mockImplementation((key: string, fallback: unknown) =>
      key === APP_SETTINGS_STORAGE_KEY ? { suggestionTuiGateEnabled: false } : fallback,
    );
    await mountAndConnect();
    // Enter the alternate screen buffer — the hard gate should NOT tear down
    // tracking when disabled.
    await act(async () => {
      getBufferChangeCallback()({ type: 'alternate' });
    });
    getStatsForScopesMock.mockReturnValue(gitStats());
    mocks.setCurrentLine('root@host:~# git ');
    await typeInput('git ');
    await advance(60);
    // Popup still fires despite alternate buffer (gate disabled).
    expect(suggestionBar()).not.toBeNull();
  });

  it('recordRejection: Escape penalises every visible candidate', async () => {
    await mountAndConnect();
    await popupForGit();
    expect(suggestionBar()).not.toBeNull();
    const expectedScope = connectionScope('connection-1');

    const preventDefault = vi.fn();
    await act(async () => {
      getCustomKeyHandler()({
        type: 'keydown',
        key: 'Escape',
        preventDefault,
      } as unknown as KeyboardEvent);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(recordRejectionMock).toHaveBeenCalledWith('git status', expectedScope);
    expect(recordRejectionMock).toHaveBeenCalledWith('git commit', expectedScope);
    expect(recordRejectionMock).toHaveBeenCalledWith('git push', expectedScope);
    expect(suggestionBar()).toBeNull();
  });
});
