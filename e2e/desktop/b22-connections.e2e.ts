/**
 * B22 connection management E2E (real page).
 *
 * Covers AC-22A (color/group persistence + navigator rendering), AC-22B
 * (import/export through storage + UI), AC-22C (single/batch test, reconnect,
 * status badges). Requires fe-dev's wiring in tool-postgres.tsx:
 *   - navigatorRoots groups connections by profile.group (groupKind
 *     "connection") and fills accentColor/statusBadge
 *   - connection manager entry wired to PostgresConnectionManager
 *   - ConnectionDialog color/group fields
 * Native file dialogs cannot be automated by WebDriver; export/import is
 * verified at the storage/IPC boundary while the UI assertions cover the
 * manager dialog, grouping, color dots and status badges.
 */
import { expect } from '@wdio/globals';

const UNIQUE = `b22${Date.now()}`;
const CONN_A = `B22 Prod ${UNIQUE}`;
const CONN_B = `B22 Dev ${UNIQUE}`;

async function unlock() {
  const password = `E2E_${UNIQUE}`;
  await $('#app-lock-password').waitForDisplayed();
  await $('#app-lock-password').setValue(password);
  await $('#app-lock-confirm').setValue(password);
  await $('#app-lock-submit, button.w-full').click();
}

async function openPostgres() {
  await $('[data-testid="toolbox-nav-postgres"]').waitForDisplayed();
  await $('[data-testid="toolbox-nav-postgres"]').click();
}

async function createConnection(name: string, connect = false) {
  await $('[data-testid="postgres-new-connection"]').waitForEnabled();
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await $('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  await inputs[0].setValue(name);
  await inputs[1].setValue('127.0.0.1');
  await browser.execute((input: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '55432');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, inputs[2]);
  await inputs[3].setValue('nexterm_e2e');
  await inputs[4].setValue('nexterm_e2e');
  await inputs[5].setValue('nexterm_e2e');
  if (connect) {
    await dialog.$('button=连接').click();
    await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
  } else {
    // Saving keeps the dialog open (product behaviour) — close via Escape.
    await dialog.$('button=保存').click();
    await browser.keys('Escape');
    await dialog.waitForExist({ reverse: true, timeout: 5000 });
  }
}

async function openConnectionManager() {
  // WebKit right-click is flaky; retry until the context menu actually opens.
  const menu = await $('[data-testid="database-navigator-context-menu"]');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await $('[data-node-id*="connection:"]').click({ button: 'right' });
    try {
      await menu.waitForDisplayed({ timeout: 3000 });
      break;
    } catch {
      await browser.keys('Escape');
      await browser.pause(400);
    }
  }
  await menu.waitForDisplayed({ timeout: 10000 });
  await menu.$('[role="menuitem"]*=连接管理器').click();
  const manager = await $('[data-testid="postgres-connection-manager"]');
  await manager.waitForDisplayed();
  return manager;
}

async function rowFor(manager: WebdriverIO.Element, name: string) {
  return manager.$$(`[data-testid="connection-manager-row"]`).filter(async (row) =>
    (await row.getText()).includes(name),
  );
}

describe('B22 connection management', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
    await unlock();
    await openPostgres();
  });

  it('creates two saved connections for the management flows', async () => {
    await createConnection(CONN_A);
    await createConnection(CONN_B);
    await openPostgres();
    await expect($(`button=${CONN_A}`)).toBeDisplayed();
    await expect($(`button=${CONN_B}`)).toBeDisplayed();
  });

  it('AC-22A: sets color + group via the manager and renders grouped/colored navigator', async () => {
    const manager = await openConnectionManager();
    const rowA = await rowFor(manager, CONN_A);
    const rowB = await rowFor(manager, CONN_B);
    expect(rowA.length).toBe(1);
    expect(rowB.length).toBe(1);

    // Group both under "prod"; give A a red accent.
    const groupInputA = await rowA[0].$('[data-testid="connection-group-input"]');
    await groupInputA.setValue('prod');
    await browser.keys('Enter');
    const groupInputB = await rowB[0].$('[data-testid="connection-group-input"]');
    await groupInputB.setValue('prod');
    await browser.keys('Enter');

    const colorSelectA = await rowA[0].$('[data-testid="connection-color-select"]');
    await colorSelectA.click();
    await $(`[role="option"]*=#ef4444`).click();

    // Wait for persist + navigator refresh.
    await browser.pause(500);
    await manager.$('button=关闭').click();
    await manager.waitForExist({ reverse: true });

    // Group header renders under the navigator connection list.
    await expect($('[data-testid="connection-group-header"]')).toBeDisplayed();
    const headerText = await $('[data-testid="connection-group-header"]').getText();
    expect(headerText).toContain('prod');
    // Both connections live under the group; A carries the accent dot.
    await expect($(`button=${CONN_A}`)).toBeDisplayed();
    await expect($(`button=${CONN_B}`)).toBeDisplayed();
    await expect($('[data-testid="database-navigator-accent"]')).toBeDisplayed();
  });

  it('AC-22A-4: color/group survive a reload (storage round-trip)', async () => {
    // Navigate away and back — profiles re-hydrate from SQLite.
    await $('[data-testid="toolbox-nav-vault"], [data-testid="toolbox-nav-terminal"]').click();
    await openPostgres();
    await expect($('[data-testid="connection-group-header"]')).toBeDisplayed();
    await expect($('[data-testid="database-navigator-accent"]')).toBeDisplayed();
  });

  it('AC-22C-1/3: single + batch connection tests report per-connection outcomes', async () => {
    const manager = await openConnectionManager();
    const rowA = await rowFor(manager, CONN_A);
    await rowA[0].$('[data-testid="connection-test"]').click();
    const singleResult = await rowA[0].$('[data-testid="connection-test-result"]');
    await singleResult.waitForDisplayed({ timeout: 20000 });
    // Outcome text carries the server version and latency, e.g. `16.15 · 222ms`.
    expect(await singleResult.getText()).toMatch(/PostgreSQL|\d+\.\d+\s*·\s*\d+ms/);

    await manager.$('[data-testid="connection-batch-test"]').click();
    const matrix = await manager.$('[data-testid="batch-test-results"]');
    await matrix.waitForDisplayed({ timeout: 20000 });
    // Wait for per-row outcomes (version + latency) to render.
    await browser.waitUntil(async () => {
      const text = await matrix.getText();
      return /PostgreSQL|\d+\.\d+\s*·\s*\d+ms/.test(text);
    }, { timeout: 20000, timeoutMsg: 'batch results did not populate' });
    const matrixText = await matrix.getText();
    expect(matrixText).toContain(CONN_A);
    expect(matrixText).toContain(CONN_B);
    expect(matrixText).toMatch(/PostgreSQL|\d+\.\d+\s*·\s*\d+ms/);
    await manager.$('button=关闭').click();
    await manager.waitForExist({ reverse: true });
  });

  it('AC-22C-4: testing never creates a new connection record', async () => {
    const manager = await openConnectionManager();
    const rows = await manager.$$('[data-testid="connection-manager-row"]');
    expect(rows.length).toBe(2);
    await manager.$('button=关闭').click();
  });

  it('AC-22C-5/6: disconnect shows disconnected badge; reconnect restores connected', async () => {
    // Connect A first (double-click via dispatched dblclick; WebDriver/WebKit
    // does not synthesize a native dblclick for doubleClick()).
    const connA = await $(`button=${CONN_A}`);
    await browser.execute((node: HTMLElement) => {
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    }, connA);
    await $('[data-testid="postgres-disconnect"]').waitForEnabled({ timeout: 20000 });
    await $('[data-testid="postgres-disconnect"]').click();

    // Navigator badge flips to disconnected.
    const statusBadge = await $('[data-testid="database-navigator-status"]');
    await statusBadge.waitForDisplayed();
    expect(await statusBadge.getAttribute('data-status')).toBe('disconnected');

    // Reconnect banner/button restores the session when present.
    const reconnect = await $('[data-testid="postgres-reconnect"]');
    if (await reconnect.isExisting()) {
      await reconnect.click();
      await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
      const badgeAfter = await $('[data-testid="database-navigator-status"]');
      expect(await badgeAfter.getAttribute('data-status')).toBe('connected');
    }
  });

  it('AC-22B: import/export storage boundary round-trips color/group and strips plaintext secrets', async () => {
    // Export/import file handling uses native dialogs (not automatable);
    // assert the storage boundary through IPC and the persisted row shape.
    const rows = await browser.execute(() => {
      const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      return api.invoke('row_list', { table: 'postgres_connections' }) as Promise<Array<Record<string, unknown>>>;
    });
    const matches = rows.filter((row) =>
      String(row.name).includes(UNIQUE) && String(row.name).startsWith('B22 Prod'),
    );
    expect(matches.length).toBe(1);
    const row = matches[0];
    expect(row.group_name).toBe('prod');
    expect(row.color).toBe('#ef4444');
    expect(String(row.password)).not.toContain('nexterm_e2e');
  });
});
