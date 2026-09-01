/**
 * v2.16 SFTP file-list context menu + system-clipboard keyboard path.
 *
 * Covers the two v2.16 changes in `integrated-file-browser.tsx`:
 *   1. Nested-trigger double-menu fix (context-menu.tsx wrapper): right-click
 *      on a file row must open EXACTLY ONE Radix menu (the row menu), and
 *      right-click on empty space must open EXACTLY ONE menu (the container
 *      menu). Before the fix the wrapper's synthetic contextmenu bubbled to
 *      the ancestor empty-area trigger and stacked a second menu.
 *   2. Ctrl+V with an empty system clipboard is a harmless no-op: no error
 *      toast and the UI stays interactive.
 *
 * Real-app flow: connect an SFTP tab to the SSH fixture container
 * (nexterm-centos-stream, 127.0.0.1:2222 — same fixture as host-key-tofu
 * .e2e.ts and src-tauri/src/ssh/tests.rs), then the SFTP file list is the
 * bottom panel of the terminal workspace (IntegratedFileBrowser mounted in
 * App.tsx with id="file-browser"). A real SSH terminal session drives the
 * same activeConnection the file browser reads from, so the spec opens one
 * SSH tab and works in its bottom file-browser panel.
 *
 * Selector notes (so the next reader does not have to re-derive them):
 * - The file list container carries `[data-columns-container]` (set in
 *   integrated-file-browser.tsx); file rows are its direct
 *   `[data-slot="context-menu-trigger"]` children.
 * - Radix portals ContextMenuContent to document.body with
 *   data-slot="context-menu-content" (ui/context-menu.tsx) and role="menu".
 *   This spec opens exactly one SSH tab and asserts a 0-menu baseline
 *   before every right-click, so any menu appearing after a right-click
 *   inside the file list must belong to it. The empty-area menu contains
 *   新建文件/新建文件夹/上传文件夹 (i18n fileBrowser.contextMenu.*), the row
 *   file menu contains 下载/重命名 — asserting the RIGHT menu opened, not
 *   just "a" menu.
 * - Right-click dispatch: WebKit's WebDriver right-click on this component
 *   is flaky (same as b21 specs). We dispatch button=2 mousedown (what the
 *   fixed ContextMenuTrigger wrapper listens to — it synthesizes the
 *   contextmenu itself and stops propagation) followed by the contextmenu
 *   event, both via browser.execute with real coordinates.
 * - `list_files` uses `ls -la` over the SSH exec channel; fixture home only
 *   has dotfiles, so the spec navigates to /etc to guarantee non-dot rows.
 * - Ctrl/Cmd+V keydown goes to document (the keyboard handler is a document
 *   listener); focus the file list first, then dispatch a KeyboardEvent with
 *   metaKey/ctrlKey — same handler path as a physical Cmd+V, without
 *   depending on the embedded driver's modifier-release semantics.
 *
 * Not covered here (documented, intentionally):
 * - Real system-clipboard file injection (Cmd+C in Finder → Cmd+V upload):
 *   the embedded WebDriver cannot put file references on the OS pasteboard.
 *   The read/write plumbing is covered at unit level
 *   (clipboard_files.rs three-platform tests + vitest
 *   integrated-file-browser-keyboard tests) — see task notes.
 * - Upload/download pipeline regression: `download` opens a native save
 *   dialog (tauri-plugin-dialog `save()`) which the driver cannot dismiss;
 *   the transfer queue itself is unit-covered (transfer-queue reducer) and
 *   exercised by file-browser-view specs' local panel. Skipped here.
 *
 * Screenshots: ./test-results/v216-sftp/ named by step index + action
 * (project discipline: screenshot at every key operation). Theme switch has
 * no fileBrowser-specific testid; the settings dialog path used by
 * v29-visual-capture (settings → 界面 → combobox) works for the whole window,
 * so light/dark re-captures ARE taken of the same file list.
 */
import { expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { unlockApp, waitForVisible } from './helpers/webkit';

const SHOT = './test-results/v216-sftp';
const UNIQUE = `sftp${Date.now()}`;

// Fixture: docker nexterm-centos-stream (host-key-tofu.e2e.ts / ssh/tests.rs).
const SSH_HOST = '127.0.0.1';
const SSH_PORT = '2222';
const SSH_USER = 'nexterm';
const SSH_PASS = 'NexTermSSH!2026';

mkdirSync(SHOT, { recursive: true });

/**
 * Unlock the app-lock first-run screen, bypassing WKWebView's flaky
 * setValue/click for the lock form (same belt-and-braces as host-key-tofu).
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

/**
 * Click a control by visible text with the full pointer sequence.
 * Radix TabsTrigger switches on mousedown (not click) and the embedded
 * WebDriver's elementClick emits no mousedown — dispatch by hand
 * (host-key-tofu.e2e.ts "Selector notes").
 * scope 'tab': [role="tab"] in the last dialog; 'footer': button in the
 * last [data-slot="dialog-footer"].
 */
async function clickByText(label: string, scope: 'tab' | 'footer') {
  const result = await browser.execute((text: string, area: string) => {
    let root: Element | null = null;
    if (area === 'tab') {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      root = dialogs[dialogs.length - 1] ?? null;
    } else {
      const footers = document.querySelectorAll('[data-slot="dialog-footer"]');
      root = footers[footers.length - 1] ?? null;
    }
    if (!root) return `no-scope(${area})`;
    const selector = area === 'tab' ? '[role="tab"]' : 'button';
    const target = Array.from(root.querySelectorAll(selector)).find(
      (el) => (el.textContent || '').trim() === text,
    ) as HTMLElement | undefined;
    if (!target) return `not-found(${text})`;
    const rect = target.getBoundingClientRect();
    const init: MouseEventInit = {
      bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1, view: window,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    };
    target.dispatchEvent(new MouseEvent('pointerdown', init));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    target.dispatchEvent(new MouseEvent('pointerup', { ...init, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    target.focus();
    return 'ok';
  }, label, scope);
  if (result !== 'ok') {
    throw new Error(`Could not click "${label}" in scope "${scope}": ${result}`);
  }
}

/** Open the SSH new-connection dialog (empty-state button or tab-bar "+"). */
async function openConnectionDialog() {
  await browser.execute(() => {
    const nav = document.querySelector('[data-testid="toolbox-nav-terminal"]') as HTMLButtonElement | null;
    if (nav && nav.getAttribute('aria-current') !== 'page') nav.click();
  });
  await browser.pause(300);
  const clicked = await browser.execute(() => {
    const isVisible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const buttons = Array.from(document.querySelectorAll('button'));
    const emptyState = buttons.find(
      (b) => (b.textContent || '').trim() === '新建连接' && isVisible(b),
    );
    if (emptyState) { emptyState.click(); return 'empty-state'; }
    const tabAdd = buttons.find(
      (b) => /h-8\b/.test(b.className) && /w-8\b/.test(b.className) && b.querySelector('svg.lucide-plus') && isVisible(b),
    );
    if (tabAdd) { tabAdd.click(); return 'tab-add'; }
    return null;
  });
  if (!clicked) throw new Error('No 新建连接 / tab-bar "+" trigger found in the terminal workspace');
  await $('[role="dialog"]').waitForExist({ timeout: 10_000 });
}

/** Fill the SSH password-auth form (protocol defaults to SSH, port 22). */
async function fillSshForm() {
  await $('#host').setValue(SSH_HOST);
  await browser.execute((input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, await $('#port'), SSH_PORT);
  await $('#username').setValue(SSH_USER);
  await clickByText('认证', 'tab');
  await $('#password').waitForExist({ timeout: 10_000 });
  await $('#password').setValue(SSH_PASS);
}

/**
 * Connect an SSH terminal tab (with the TOFU prompt if this data dir has
 * never trusted the fixture host) and wait for the bottom file-browser
 * panel to mount and list a real remote directory.
 *
 * The bottom panel is visible by default (DEFAULT_LAYOUT.bottomPanelVisible
 * = true in layout-config.ts) whenever an activeConnection exists.
 */
async function connectSshAndOpenFileList() {
  await openConnectionDialog();
  await $('#connection-name').setValue(`SFTP Menu ${UNIQUE}`);
  await fillSshForm();
  await clickByText('连接', 'footer');

  // First connect in a fresh data dir → in-app TOFU prompt with SHA256:.
  // waitUntil (not a one-shot isExisting) so a slow host-key probe cannot
  // race past the check and leave an unanswered prompt blocking the connect.
  const prompt = await $('//*[contains(text(),"SHA256:")]');
  const promptShown = await prompt.waitForExist({ timeout: 8_000 }).then(
    () => true,
    () => false,
  );
  if (promptShown) {
    await browser.execute(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const root = dialogs.find((el) => (el.textContent || '').includes('SHA256:'));
      const btn = Array.from(root?.querySelectorAll('button') ?? []).find(
        (b) => (b.textContent || '').trim() === '确认',
      ) as HTMLElement | undefined;
      btn?.click();
    });
    await browser.waitUntil(async () => !(await prompt.isExisting()), {
      timeout: 10_000,
      timeoutMsg: 'TOFU prompt did not close after 确认',
    });
  }

  // SSH terminal mounts → activeConnection exists → bottom file browser renders.
  await waitForVisible('.xterm', 25_000);
  await waitForVisible('[data-columns-container]', 20_000);
  // First load targets /home (only dotfiles on the fixture); /etc guarantees
  // plain-name rows for the row-menu test. The address input only mounts in
  // edit mode: click the breadcrumb container first, then type into the
  // mounted input and press Enter (handlePathSubmit → navigateTo).
  const typed = await browser.execute(() => {
    const container = document.querySelector('[data-columns-container]');
    const panel = container?.closest('[id="file-browser"]');
    if (!panel) return 'no-panel';
    // Breadcrumb display container (cursor-text div) — clicking it swaps the
    // display for the <input spellCheck={false}>.
    const bar = Array.from(panel.querySelectorAll('div')).find(
      (d) => d.className.includes('cursor-text') && d.getBoundingClientRect().height > 0,
    );
    if (!bar) return 'no-breadcrumb-bar';
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'ok';
  });
  if (typed !== 'ok') throw new Error(`address bar not clickable: ${typed}`);
  await browser.pause(300);
  const input = await browser.execute(() => {
    const container = document.querySelector('[data-columns-container]');
    const panel = container?.closest('[id="file-browser"]');
    const el = panel?.querySelector('input[autocomplete="off"]') as HTMLInputElement | null;
    if (!el) return null;
    el.focus();
    el.select();
    return true;
  });
  if (!input) throw new Error('file browser address input did not mount after click');
  await browser.pause(300);
  // WKWebView browser.keys() typing is unreliable here (same class of flake as
  // the lock form) — diag showed the value stayed empty and Enter re-navigated
  // to the current dir. Inject the path React-style instead: native value
  // setter + input event (onChange → setEditPathValue), then a synthetic
  // Enter keydown (onKeyDown → handlePathSubmit).
  const typedOk = await browser.execute(() => {
    const container = document.querySelector('[data-columns-container]');
    const panel = container?.closest('[id="file-browser"]');
    const el = panel?.querySelector('input[autocomplete="off"]') as HTMLInputElement | null;
    if (!el) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    if (!setter) return 'no-setter';
    setter.call(el, '/etc');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  });
  if (typedOk !== 'ok') throw new Error(`address inject failed: ${typedOk}`);
  // Let React flush the onChange state update before submitting.
  await browser.pause(250);
  await browser.execute(() => {
    const container = document.querySelector('[data-columns-container]');
    const panel = container?.closest('[id="file-browser"]');
    const el = panel?.querySelector('input[autocomplete="off"]') as HTMLInputElement | null;
    el?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
    );
  });
  // Wait until a known /etc entry renders (CentOS Stream always has passwd).
  let listed = false;
  try {
    await browser.waitUntil(async () => await $('//*[contains(text(),"passwd")]').isExisting(), {
      timeout: 20_000,
      timeoutMsg: 'file list did not show /etc entries (passwd)',
    });
    listed = true;
  } catch {
    // Diagnostic capture before rethrow: what does the file panel show?
    await browser.saveScreenshot(`${SHOT}/diag-etc-nav.png`);
    const dump = await browser.execute(() => {
      const container = document.querySelector('[data-columns-container]');
      const rows = container ? container.textContent : 'NO-CONTAINER';
      const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]'))
        .map((t) => t.textContent);
      const addrInputs = Array.from(
        document.querySelectorAll('#file-browser input[autocomplete="off"]'),
      ).map((i) => (i as HTMLInputElement).value);
      return { rows: String(rows).slice(0, 400), toasts, addrInputs };
    });
    const fs = await import('node:fs');
    fs.writeFileSync(`${SHOT}/diag-etc-nav.json`, JSON.stringify(dump, null, 2));
    throw new Error(`file list did not show /etc entries (passwd). diag=${JSON.stringify(dump)}`);
  }
  await browser.pause(600); // let the loading overlay fade (300 ms timer)
  void listed;
}

/**
 * Count currently-open Radix context menus attributable to the file browser.
 *
 * Radix portals ContextMenuContent to document.body, so the count cannot be
 * scoped via the panel subtree. Instead: this spec connects exactly ONE SSH
 * tab and asserts the baseline is 0 before every right-click, so any menu
 * that appears after a right-click inside [id="file-browser"] must belong to
 * it. Counts both data-slot="context-menu-content" and role="menu" — both
 * must agree, otherwise the selector itself is wrong.
 */
async function countOpenMenus(): Promise<{ bySlot: number; byRole: number }> {
  return browser.execute(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      // Portaled nodes can be laid out far below the viewport when a hidden
      // tool workspace also mounts a file browser. Only intersecting nodes are
      // visually open.
      if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) {
        return false;
      }
      const cs = getComputedStyle(el);
      // Radix portals can have geometry before their enter animation paints.
      // Count only a mostly-opaque, renderable menu so screenshot evidence is
      // tied to what the user actually sees.
      return (
        cs.visibility !== 'hidden' &&
        cs.display !== 'none' &&
        Number.parseFloat(cs.opacity) >= 0.9
      );
    };
    const bySlot = Array.from(
      document.querySelectorAll('[data-slot="context-menu-content"]'),
    ).filter(visible).length;
    const byRole = Array.from(document.querySelectorAll('[role="menu"]')).filter(visible).length;
    return { bySlot, byRole };
  });
}

/** Text of the single currently-open context menu (empty when none). */
async function openMenuText(): Promise<string> {
  return browser.execute(() => {
    const menus = Array.from(
      document.querySelectorAll('[data-slot="context-menu-content"]'),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
    });
    return menus[0]?.textContent ?? '';
  });
}

async function saveOpenMenuScreenshot(name: string, viewportMargin = 8) {
  const path = `${SHOT}/${name}`;
  const menuState = await browser.execute(() => {
    const menu = document.querySelector<HTMLElement>('[data-slot="context-menu-content"]');
    if (!menu) return null;
    const rect = menu.getBoundingClientRect();
    const cs = getComputedStyle(menu);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      boxShadow: cs.boxShadow,
      opacity: cs.opacity,
      visibility: cs.visibility,
      zIndex: cs.zIndex,
    };
  });
  if (
    !menuState ||
    menuState.rect.x < viewportMargin ||
    menuState.rect.y < viewportMargin ||
    menuState.rect.x + menuState.rect.width > menuState.viewport.width - viewportMargin ||
    menuState.rect.y + menuState.rect.height > menuState.viewport.height - viewportMargin ||
    menuState.backgroundColor === 'rgba(0, 0, 0, 0)'
  ) {
    throw new Error(`menu is not visibly painted before screenshot: ${JSON.stringify(menuState)}`);
  }
  // Capture the WebDriver viewport, not the OS foreground window. The geometry
  // guard above proves the menu is painted inside this viewport before capture.
  await browser.saveScreenshot(path);

  // A screenshot must not dismiss the menu. Fail loudly instead of producing
  // another misleading PNG that looks like the baseline file list.
  const afterCapture = await countOpenMenus();
  expect(afterCapture.bySlot).toBe(1);
  expect(afterCapture.byRole).toBe(1);
}

/**
 * Right-click (button=2) at an element's center via browser.execute:
 * mousedown first — the fixed ContextMenuTrigger wrapper listens to
 * mousedown, synthesizes the contextmenu, and stops propagation — then the
 * real contextmenu event for Radix's own trigger handling. Genuine
 * contextmenu on an already-open Radix menu is idempotent, so this mirrors
 * a physical right-click exactly (the path the fix normalized).
 */
async function rightClickAt(el: WebdriverIO.Element) {
  await browser.execute((node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    const init: MouseEventInit = {
      bubbles: true, cancelable: true, view: window,
      button: 2, buttons: 2, detail: 1,
      clientX: rect.left + Math.min(rect.width / 2, 40),
      clientY: rect.top + rect.height / 2,
    };
    node.dispatchEvent(new MouseEvent('mousedown', init));
    node.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    node.dispatchEvent(new MouseEvent('contextmenu', init));
  }, el);
}

async function isElementInViewport(el: WebdriverIO.Element): Promise<boolean> {
  return browser.execute((node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth &&
      cs.display !== 'none' &&
      cs.visibility !== 'hidden'
    );
  }, el);
}

/** File row trigger inside the file list (first non-".." file row). */
async function firstFileRow(): Promise<WebdriverIO.Element> {
  return visibleRowByName('passwd');
}

/** Find a row by name and scroll it into the visible file-list viewport. */
async function visibleRowByName(name: string): Promise<WebdriverIO.Element> {
  const rows = await $$('[data-columns-container] [data-slot="context-menu-trigger"]');
  for (const row of rows) {
    const text = await row.getText();
    if (text?.startsWith(name)) {
      await browser.execute((node: HTMLElement) => {
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
      }, row);
      await browser.pause(150);
      if (await isElementInViewport(row)) return row;
    }
  }
  const candidates = await browser.execute(() => Array.from(
    document.querySelectorAll<HTMLElement>('[data-columns-container] [data-slot="context-menu-trigger"]'),
  )
    .filter((node) => (node.textContent || '').startsWith(name))
    .slice(0, 20)
    .map((node) => {
      const rect = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      return {
        text: node.textContent,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
      };
    }));
  throw new Error(
    `no visible row "${name}" found (${rows.length} triggers total): ${JSON.stringify(candidates)}`,
  );
}

/** The app keeps hidden tool workspaces mounted; choose the visible browser. */
async function visibleColumnsContainer(): Promise<WebdriverIO.Element> {
  const containers = await $$('[data-columns-container]');
  for (const container of containers) {
    if (await isElementInViewport(container)) return container;
  }
  throw new Error(`no visible file list found (${containers.length} containers total)`);
}

/** Wait for the terminal container and canvas to settle on the app theme. */
async function waitForTerminalTheme(light: boolean) {
  try {
    await browser.waitUntil(async () => browser.execute((expectedLight: boolean) => {
      const terminal = document.querySelector<HTMLElement>('.pty-terminal-container');
      if (!terminal) return false;
      const channels = getComputedStyle(terminal).backgroundColor
        .match(/-?\d+(?:\.\d+)?/g)
        ?.map(Number);
      if (!channels || channels.length < 3) return false;
      const [red, green, blue] = channels;
      const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
      return expectedLight ? luminance > 0.5 : luminance <= 0.5;
    }, light), {
      timeout: 10_000,
      timeoutMsg: `terminal did not settle to the ${light ? 'light' : 'dark'} app theme`,
    });
  } catch (error) {
    const state = await browser.execute(() => ({
      rootClass: document.documentElement.className,
      terminals: Array.from(document.querySelectorAll<HTMLElement>('.pty-terminal-container')).map((el) => ({
        inline: el.style.backgroundColor,
        computed: getComputedStyle(el).backgroundColor,
        rect: el.getBoundingClientRect().toJSON(),
      })),
    }));
    throw new Error(`terminal did not settle to the ${light ? 'light' : 'dark'} app theme: ${JSON.stringify(state)}`);
  }
}

describe('v2.16 SFTP file list: single context menu + clipboard keys', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
    await unlock();
    await connectSshAndOpenFileList();
  });

  it('01 right-click on a file row opens exactly ONE menu (the row menu)', async () => {
    // Baseline: no menu open.
    const before = await countOpenMenus();
    expect(before.bySlot).toBe(0);

    // Right-click a file row; retry like b21 (WebKit flakiness), asserting
    // the count after each attempt so a stacked duplicate fails loudly.
    const row = await firstFileRow();
    let counts = { bySlot: 0, byRole: 0 };
    for (let attempt = 0; attempt < 4 && counts.bySlot === 0; attempt += 1) {
      await rightClickAt(row);
      await browser.pause(500);
      counts = await countOpenMenus();
      if (counts.bySlot === 0) {
        await browser.keys('Escape');
        await browser.pause(300);
      }
    }
    // CORE assertion: exactly one menu — not zero (trigger broken) and not
    // two (nested-trigger double-menu regression).
    expect(counts.bySlot).toBe(1);
    expect(counts.byRole).toBe(1);

    // It is the ROW menu: file actions present, empty-area "new file/folder"
    // actions absent.
    const menuText = await openMenuText();
    expect(menuText).not.toContain('下载目录');
    expect(menuText).not.toContain('打开文件夹');
    expect(menuText).toContain('下载');
    expect(menuText).toContain('在编辑器中打开');
    expect(menuText).toContain('重命名');
    expect(menuText).not.toContain('新建文件');
    expect(menuText).not.toContain('新建文件夹');

    await saveOpenMenuScreenshot('02-row-context-menu-open.png', 64);
    await browser.keys('Escape');
    await browser.waitUntil(async () => (await countOpenMenus()).bySlot === 0, {
      timeoutMsg: 'row menu did not close on Escape',
    });
  });

  it('02 right-click on a directory row shows directory-only actions', async () => {
    const before = await countOpenMenus();
    expect(before.bySlot).toBe(0);

    const row = await visibleRowByName('ssh');
    let counts = { bySlot: 0, byRole: 0 };
    for (let attempt = 0; attempt < 4 && counts.bySlot === 0; attempt += 1) {
      await rightClickAt(row);
      await browser.pause(500);
      counts = await countOpenMenus();
      if (counts.bySlot === 0) {
        await browser.keys('Escape');
        await browser.pause(300);
      }
    }
    expect(counts.bySlot).toBe(1);
    expect(counts.byRole).toBe(1);

    const menuText = await openMenuText();
    expect(menuText).toContain('打开文件夹');
    expect(menuText).toContain('下载目录');
    expect(menuText).toContain('上传');
    expect(menuText).toContain('上传文件夹');
    expect(menuText).not.toContain('在编辑器中打开');
    expect(menuText).not.toContain('新建文件');
    expect(menuText).not.toContain('新建文件夹');

    await saveOpenMenuScreenshot('05-directory-context-menu-open.png');
    await browser.keys('Escape');
    await browser.waitUntil(async () => (await countOpenMenus()).bySlot === 0, {
      timeoutMsg: 'directory menu did not close on Escape',
    });
  });

  it('03 right-click on empty space opens exactly ONE menu (the area menu)', async () => {
    // Baseline again (menus portal to body — see countOpenMenus note).
    const before = await countOpenMenus();
    expect(before.bySlot).toBe(0);

    // Empty space = the columns container itself, below the last row
    // (min-h-full padding area). Click coordinates target the container's
    // bottom padding so the event starts on the container, not on a row.
    const container = await visibleColumnsContainer();
    await browser.execute((node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const init: MouseEventInit = {
        bubbles: true, cancelable: true, view: window,
        button: 2, buttons: 2, detail: 1,
        // Bottom-left padding zone: never over a file row.
        clientX: rect.left + 8,
        // The scrollable container can extend past the WebView viewport. Clamp
        // the synthetic pointer to the actually visible bottom edge.
        clientY: Math.max(
          rect.top + 8,
          Math.min(rect.bottom - 8, window.innerHeight - 8),
        ),
      };
      node.dispatchEvent(new MouseEvent('mousedown', init));
      node.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      node.dispatchEvent(new MouseEvent('contextmenu', init));
    }, container);

    let counts = { bySlot: 0, byRole: 0 };
    for (let attempt = 0; attempt < 4 && counts.bySlot === 0; attempt += 1) {
      await browser.pause(500);
      counts = await countOpenMenus();
      if (counts.bySlot === 0) {
        await browser.execute((node: HTMLElement) => {
          const rect = node.getBoundingClientRect();
          const init: MouseEventInit = {
            bubbles: true, cancelable: true, view: window,
          button: 2, buttons: 2, detail: 1,
            clientX: rect.left + 8,
            clientY: Math.max(
              rect.top + 8,
              Math.min(rect.bottom - 8, window.innerHeight - 8),
            ),
          };
          node.dispatchEvent(new MouseEvent('mousedown', init));
          node.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
          node.dispatchEvent(new MouseEvent('contextmenu', init));
        }, container);
      }
    }
    expect(counts.bySlot).toBe(1);
    expect(counts.byRole).toBe(1);

    // It is the EMPTY-AREA menu: 新建文件/新建文件夹/上传文件夹 present,
    // row-only 下载 absent (上传文件夹 disambiguates from the row menu which
    // has no folder-upload item).
    const menuText = await openMenuText();
    expect(menuText).toContain('新建文件');
    expect(menuText).toContain('新建文件夹');
    expect(menuText).toContain('上传文件夹');
    expect(menuText).not.toContain('下载');
    expect(menuText).not.toContain('重命名');

    await saveOpenMenuScreenshot('03-empty-context-menu-open.png');
    await browser.keys('Escape');
    await browser.waitUntil(async () => (await countOpenMenus()).bySlot === 0, {
      timeoutMsg: 'empty-area menu did not close on Escape',
    });
  });

  it('04 Ctrl/Cmd+V with an empty clipboard is a harmless no-op', async () => {
    // Focus the file list (not an editable target — the document keydown
    // handler ignores events originating from inputs/textarea/contenteditable).
    const container = await visibleColumnsContainer();
    await browser.execute((node: HTMLElement) => { node.focus(); }, container);

    // The host OS clipboard is external test state (it may legitimately hold
    // Finder file references from the user). Stub only this Tauri command to
    // the Rust command's empty-file-list result; all other IPC stays real.
    // The Rust read implementation remains covered by cargo test.
    await browser.execute(() => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__?: {
            invoke: (...args: unknown[]) => Promise<unknown>;
            __e2eOriginalInvoke?: (...args: unknown[]) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!internals) throw new Error('Tauri internals unavailable for clipboard stub');
      internals.__e2eOriginalInvoke = internals.invoke;
      internals.invoke = (...args: unknown[]) => (
        args[0] === 'clipboard_read_files'
          ? Promise.resolve([])
          : internals.__e2eOriginalInvoke!(...args)
      );
    });

    // Dispatch Cmd+V as a real keydown on document.activeElement. The
    // handler is a document-level listener accepting ctrlKey||metaKey; a
    // synthetic KeyboardEvent exercises the exact same path as
    // browser.keys(['Meta','v']) without relying on the embedded driver's
    // modifier-key release semantics (host-key-tofu "Selector notes" flag
    // the same WebKit driver quirk for keys).
    const dispatched = await browser.execute(() => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'v', code: 'KeyV', bubbles: true, cancelable: true,
        metaKey: true, ctrlKey: navigator.platform.includes('Mac'),
      }));
      return true;
    });
    expect(dispatched).toBe(true);
    await browser.pause(800); // toast animation window

    // The virtual clipboard is empty (no copy in this spec) and
    // clipboard_read_files must return [] — no error toast, no crash.
    const errorToasts = await $$('[data-sonner-toast][data-type="error"]');
    expect(errorToasts.length).toBe(0);

    await browser.execute(() => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__?: {
            invoke: (...args: unknown[]) => Promise<unknown>;
            __e2eOriginalInvoke?: (...args: unknown[]) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (internals?.__e2eOriginalInvoke) internals.invoke = internals.__e2eOriginalInvoke;
    });

    // The page is still interactive: open and close the row menu again.
    const row = await firstFileRow();
    let opened = false;
    for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
      await rightClickAt(row);
      await browser.pause(500);
      opened = (await countOpenMenus()).bySlot === 1;
      if (!opened) { await browser.keys('Escape'); await browser.pause(300); }
    }
    expect(opened).toBe(true);
    await browser.keys('Escape');
    await browser.waitUntil(async () => (await countOpenMenus()).bySlot === 0);

    // File list still rendered — the paste path did not unmount anything.
    await expect($('[data-columns-container]')).toBeExisting();
    await browser.saveScreenshot(`${SHOT}/04-after-empty-paste.png`);
  });

  it('05 light/dark theme re-captures of the file list', async () => {
    // Theme switch has no fileBrowser-specific testid, but the global
    // settings dialog (v29-visual-capture configureTheme) restyles the whole
    // window including this panel, so both themes are captured here.
    const configureTheme = async (label: '深色' | '浅色') => {
      await $('button:has(svg.lucide-settings)').click();
      const settingsDialog = await $('[role="dialog"]');
      await settingsDialog.waitForDisplayed({ timeout: 10_000 });
      await settingsDialog.$('button=界面').click();
      await settingsDialog.$('[role="combobox"]').click();
      await $(`[role="option"]=${label}`).click();
      await settingsDialog.$('button=保存设置').click();
      await settingsDialog.waitForExist({ reverse: true, timeout: 10_000 });
      await browser.pause(300); // let the root-class mutation propagate
      await waitForTerminalTheme(label === '浅色');
    };

    await browser.saveScreenshot(`${SHOT}/01-file-list-initial-dark.png`);
    await configureTheme('浅色');
    await waitForVisible('[data-columns-container]');
    await browser.saveScreenshot(`${SHOT}/05-file-list-light.png`);
    // Back to dark for any spec that runs after this one (shared data dir).
    await configureTheme('深色');
    await waitForVisible('[data-columns-container]');
  });
});
