/**
 * Host-key TOFU (Trust On First Use) desktop E2E — real SSH server.
 *
 * Security baseline: direct SSH/SFTP connections show an in-app fingerprint
 * confirmation dialog on first connect (application dialog, never
 * window.confirm), persist the accepted fingerprint with the connection, and
 * refuse to connect when the user declines (fail-closed).
 *
 * Runtime dependency: an SSH server reachable at 127.0.0.1:2222 (docker
 * container `nexterm-centos-stream`, user `nexterm`, password
 * `NexTermSSH!2026`). The same fixture backs src-tauri/src/ssh/tests.rs.
 *
 * Covered (visible UI flow):
 *   1. First connect probes the host key, the in-app confirmation dialog
 *      appears with the SHA256 fingerprint; confirming persists the
 *      fingerprint and the SSH terminal connects.
 *   2. Declining the confirmation aborts the connection and keeps the
 *      connection dialog open — nothing connects without trust.
 *
 * The "fingerprint rotated → refuse" path is backend-covered by unit tests
 * (`ssh::Client::check_server_key` in src-tauri/src/ssh/mod.rs and
 * `postgres_ssh_host_key_requires_a_pin_and_rejects_mismatch` in
 * src-tauri/src/postgres.rs) because it requires rewriting a persisted
 * fingerprint behind the frontend connection cache, which the desktop E2E
 * cannot safely mutate through the visible UI.
 *
 * Selector notes (kept here so the next reader does not have to re-derive them):
 * - The SSH connection dialog is opened by App.handleNewTab, which is wired
 *   to the terminal empty-state 新建连接 button (visible only when there are no
 *   tabs; text `serversView.new` = "新建连接") and to the tab-bar "+" add-tab
 *   button (src/components/terminal/group-tab-bar.tsx, a Button with a Plus
 *   icon and classes `p-2 h-8 w-8`). openConnectionDialog tries the empty-state
 *   button first, then falls back to the tab-bar "+".
 * - The Radix TabsTrigger for the authentication tab has span text 认证 (NOT
 *   认证方式; zh-CN.json `connectionDialog.tab.auth`).
 * - Radix TabsTrigger only calls onValueChange on **mousedown**
 *   (`button === 0 && ctrlKey === false`), on **focus** (activationMode is
 *   "automatic" by default) or on Space/Enter keydown — see
 *   node_modules/@radix-ui/react-tabs/dist/index.mjs:121-136. Neither
 *   WebDriver's elementClick nor a bare HTMLElement.click() produces a
 *   mousedown here, so both "succeed" without ever switching the tab and
 *   #password never mounts. activateTab() therefore dispatches the full
 *   pointerdown/mousedown/pointerup/mouseup/click sequence.
 * - WDIO's `text=` / `text*=` selector strategies are not resolved by the
 *   embedded tauri-plugin-wdio-webdriver — `$('text*=SHA256:')` never matches
 *   even though the prompt is on screen. XPath `contains(text(), …)` does, so
 *   the fingerprint prompt is addressed by XPath (SHA256_TEXT).
 * - `button=连接` is ambiguous inside the connection dialog: the tab strip
 *   contains a tab named 连接 and the footer also contains a button 连接.
 *   Scope the footer lookup explicitly via the dialog-footer's data-slot.
 * - `id="save-connection"` is a Radix Switch that is on by default for a new
 *   connection. A blind click would toggle it off and skip persistence.
 * - WDIO's `text=` / `text*=` selector strategies are NOT resolved by the
 *   embedded tauri-plugin-wdio-webdriver: while the fingerprint was on screen,
 *   `$('text*=SHA256:')` and `$('text*=SHA256')` both resolved to an empty set,
 *   whereas the equivalent XPath `//*[contains(text(),"SHA256:")]` matched (see
 *   SHA256_TEXT below). Element-scoped XPath (`dialog.$('xpath=.//...')`) is
 *   mangled by the same driver and must not be used either.
 */
import { expect } from '@wdio/globals';
import { unlockApp, waitForGone, waitForVisible } from './helpers/webkit';

const UNIQUE = `tofu${Date.now()}`;
/** The host-key fingerprint line inside the TOFU dialog.
 *
 *  WDIO's `text=` / `text*=` selector strategies are NOT resolved by the
 *  embedded tauri-plugin-wdio-webdriver (verified: `$('text*=SHA256:')` never
 *  matches, while the equivalent XPath does), so the prompt is addressed by
 *  XPath throughout this spec. */
const SHA256_TEXT = '//*[contains(text(),"SHA256:")]';
const CONNECTION_NAME = `TOFU E2E ${UNIQUE}`;
const SSH_HOST = '127.0.0.1';
const SSH_PORT = '2222';
const SSH_USER = 'nexterm';
const SSH_PASS = 'NexTermSSH!2026';

/**
 * Unlock the app-lock first-run screen.
 *
 * The shared `unlockApp` helper types with webdriver setValue and clicks the
 * submit button with WebDriver's elementClick. Both are unreliable against the
 * embedded WKWebView: the afterTest screenshot of a failing run showed the lock
 * screen still up with both password fields empty after `unlockApp` had
 * returned. Set the values through the native value setter + an input event
 * (the React-controlled-input pattern, same as #port in fillSshForm) and submit
 * with a direct HTMLElement.click() so the app actually receives the events.
 * The shared helper is left untouched — it backs other specs.
 */
async function unlock() {
  await unlockApp(`E2E_${UNIQUE}`);
  const stillLocked = await $('#app-lock-password').isExisting();
  if (!stillLocked) return;
  await browser.execute((password: string) => {
    const set = (id: string) => {
      const el = document.querySelector(id) as HTMLInputElement | null;
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, password);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#app-lock-password');
    set('#app-lock-confirm');
    const submit = document.querySelector('#app-lock-submit') as HTMLButtonElement | null;
    submit?.click();
  }, `E2E_${UNIQUE}`);
  await browser.waitUntil(async () => !(await $('#app-lock-password').isExisting()), {
    timeout: 20_000,
    timeoutMsg: 'app-lock screen did not go away after unlock',
  });
}

/** Open the SSH New Connection dialog.
 *
 *  First switches to the terminal workspace so the empty-state 新建连接 button
 *  is available on a fresh app (no tabs yet). If the terminal already has
 *  tabs the empty state is hidden, so it falls back to the tab-bar "+" add
 *  button, which is wired to the same App.handleNewTab handler and opens the
 *  same SSH ConnectionDialog. Both clicks are dispatched via
 *  browser.execute to fire a bubbling click that the app's Radix / React event
 *  listeners can react to (WKWebView's WebDriver elementClick is unreliable
 *  for some Radix triggers — see "Selector notes" below). */
async function openConnectionDialog() {
  // Switch to the terminal workspace so the empty-state 新建连接 is in the DOM.
  await browser.execute(() => {
    const nav = document.querySelector('[data-testid="toolbox-nav-terminal"]') as HTMLButtonElement | null;
    if (nav && nav.getAttribute('aria-current') !== 'page') nav.click();
  });
  await browser.pause(300);
  // Click whichever visible trigger is available right now.
  const clicked = await browser.execute(() => {
    const isVisible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const buttons = Array.from(document.querySelectorAll('button'));
    // 1) Terminal empty-state 新建连接 button (no tabs).
    const emptyState = buttons.find(
      (b) => (b.textContent || '').trim() === '新建连接' && isVisible(b),
    );
    if (emptyState) {
      emptyState.click();
      return 'empty-state';
    }
    // 2) Tab-bar "+" add button (has tabs). Identified by the
    //    p-2 h-8 w-8 classes set in group-tab-bar.tsx so we don't grab a
    //    toolbar / toolbox "+" by mistake.
    const tabAdd = buttons.find(
      (b) => /h-8\b/.test(b.className) && /w-8\b/.test(b.className) && b.querySelector('svg.lucide-plus') && isVisible(b),
    );
    if (tabAdd) {
      tabAdd.click();
      return 'tab-add';
    }
    return null;
  });
  if (!clicked) throw new Error('No 新建连接 / tab-bar "+" trigger found in the terminal workspace');
  await $('[role="dialog"]').waitForExist({ timeout: 10_000 });
}

/**
 * Click a control by its visible text, dispatching the full pointer sequence
 * (pointerdown → mousedown → pointerup → mouseup → click).
 *
 * Radix TabsTrigger switches on mousedown / focus, not on a bare click, and
 * WKWebView's WebDriver elementClick does not emit a mousedown either, so the
 * events have to be dispatched by hand (see "Selector notes").
 *
 * Scopes:
 *   'tab'      — [role="tab"] inside the last dialog (connection dialog tabs)
 *   'footer'   — button inside the last [data-slot="dialog-footer"]
 *   'host-key' — button inside the dialog-content that shows the SHA256 prompt
 */
async function clickByText(label: string, scope: 'tab' | 'footer' | 'host-key') {
  const result = await browser.execute((text: string, area: string) => {
    let root: Element | null = null;
    if (area === 'tab') {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      root = dialogs[dialogs.length - 1] ?? null;
    } else if (area === 'footer') {
      const footers = document.querySelectorAll('[data-slot="dialog-footer"]');
      root = footers[footers.length - 1] ?? null;
    } else {
      root =
        Array.from(document.querySelectorAll('[role="dialog"]')).find((el) =>
          (el.textContent || '').includes('SHA256:'),
        ) ?? null;
    }
    if (!root) return `no-scope(${area})`;

    const selector = area === 'tab' ? '[role="tab"]' : 'button';
    const target = Array.from(root.querySelectorAll(selector)).find(
      (el) => (el.textContent || '').trim() === text,
    ) as HTMLElement | undefined;
    if (!target) return `not-found(${text})`;

    const rect = target.getBoundingClientRect();
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      detail: 1,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    target.dispatchEvent(new MouseEvent('pointerdown', init));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    target.dispatchEvent(new MouseEvent('pointerup', { ...init, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    // Belt and braces: Radix automatic activation also fires on focus.
    target.focus();
    return 'ok';
  }, label, scope);
  if (result !== 'ok') {
    throw new Error(`Could not click "${label}" in scope "${scope}": ${result}`);
  }
}

/** Fill an SSH password-auth form (protocol defaults to SSH, port 22). */
async function fillSshForm() {
  await $('#host').setValue(SSH_HOST);
  // The port input is a controlled React number input — set through the native
  // value setter + an input event (same pattern as postgres-visual.e2e.ts).
  await browser.execute((input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, await $('#port'), SSH_PORT);
  await $('#username').setValue(SSH_USER);

  // The auth content (#password) is only mounted while the 认证 tab is active.
  await clickByText('认证', 'tab');
  await $('#password').waitForExist({ timeout: 10_000 });
  await $('#password').setValue(SSH_PASS);
}

/**
 * Make sure "save as connection" is on. The dialog already defaults it to on
 * for a new connection, so toggle it only when it is off — a blind click would
 * switch it off and leave nothing persisted for the fingerprint assertion.
 */
async function ensureSaveAsConnection() {
  const toggle = await $('#save-connection');
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
  }
}

/**
 * Click the connection dialog's footer 连接 button.
 *
 * `dialog.$('button=连接')` resolves to the 连接 *tab* in the tab strip, which
 * precedes the footer in DOM order — clicking it only re-selects the tab and
 * never starts the connection. Scope the lookup to the dialog footer so the
 * real connect button is the only match.
 */
async function clickConnect() {
  await clickByText('连接', 'footer');
}

/** The in-app host-key confirmation dialog, identified by its fingerprint text. */
async function hostKeyPrompt() {
  return waitForVisible(SHA256_TEXT, 15_000);
}

/** Click a footer button inside the TOFU dialog that shows the fingerprint. */
async function clickPromptButton(label: string) {
  await clickByText(label, 'host-key');
}

describe('Host-key TOFU desktop flow', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
    await unlock();
  });

  it('probes the host key on first connect, confirms it and connects', async () => {
    await openConnectionDialog();

    await $('#connection-name').setValue(CONNECTION_NAME);
    // Persist the connection so the accepted fingerprint can be verified in SQLite.
    await ensureSaveAsConnection();
    await fillSshForm();

    await clickConnect();

    // The in-app TOFU dialog appears with the probed SHA256 fingerprint.
    await hostKeyPrompt();

    // Accept: proceed with the fingerprint and connect.
    await clickPromptButton('确认');

    // The SSH terminal mounts after the trusted fingerprint connects.
    await waitForVisible('.xterm', 25_000);

    // The accepted fingerprint was persisted with the saved connection.
    const rows = await browser.execute(() => {
      const api = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      return api.invoke('row_list', { table: 'connections' }) as Promise<Array<Record<string, unknown>>>;
    });
    const saved = rows.filter((row) => String(row.name).includes(UNIQUE));
    expect(saved.length).toBe(1);
    expect(String(saved[0].host_key_fingerprint)).toMatch(/^SHA256:/);
  });

  it('aborts the connection when the host key is declined (fail-closed)', async () => {
    // The terminal workspace now has a tab from the previous test, so the
    // empty-state button is gone — openConnectionDialog falls back to the
    // tab-bar "+" add-tab button, which routes to the same handler.
    await openConnectionDialog();

    // The name is required — without it handleConnect() rejects the form
    // before the host-key probe ever runs.
    await $('#connection-name').setValue(`${CONNECTION_NAME} decline`);
    await fillSshForm();
    await clickConnect();

    // The same in-app TOFU confirmation appears for this brand-new connection.
    await hostKeyPrompt();
    await clickPromptButton('取消');

    // Declining closes the TOFU prompt but does NOT connect: the connection
    // dialog stays open and no terminal is created for this attempt.
    // waitForGone (not a one-shot isExisting check) so the React state flip
    // that unmounts the prompt is actually awaited.
    await waitForGone(SHA256_TEXT, 10_000);
    await expect($('[role="dialog"]')).toBeExisting();
  });
});