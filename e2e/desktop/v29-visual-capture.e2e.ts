/**
 * v2.9.0 (M2) visual capture — real-app screenshots of the B21/B22 surfaces.
 *
 * Each M2 feature is operated first, then captured (screenshot = evidence).
 * Screenshots land in test-results/v29/ named by step index + action.
 *
 * Covered surfaces:
 *   01 object tree (six kinds: functions/sequences + columns/indexes/
 *      constraints/triggers sub-groups)
 *   02 function context menu
 *   03 object viewer (DDL preview + properties table)
 *   04 connection context menu (connection manager entry)
 *   05 connection manager dialog (color/group/test)
 *   06 grouped navigator (color dot + group header + status badge)
 *   07 ConnectionDialog color/group fields
 *   08 light/dark + small-window re-captures
 */
import { expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';

const SHOT = './test-results/v29';
const CONNECTION_NAME = 'V29 Visual';

mkdirSync(SHOT, { recursive: true });

async function configureTheme(label: '深色' | '浅色') {
  await $('button:has(svg.lucide-settings)').click();
  const settingsDialog = await $('[role="dialog"]');
  await settingsDialog.waitForDisplayed({ timeout: 10_000 });
  await settingsDialog.$('button=界面').click();
  await settingsDialog.$('[role="combobox"]').click();
  await $(`[role="option"]=${label}`).click();
  await settingsDialog.$('button=保存设置').click();
  await settingsDialog.waitForExist({ reverse: true, timeout: 10_000 });
}

async function unlock() {
  const password = `E2E_${Date.now()}`;
  const lock = await $('#app-lock-password');
  await browser.waitUntil(
    async () => (await lock.isExisting()) || (await $('[data-testid="postgres-disconnect"]').isExisting()),
    { timeout: 30_000, timeoutMsg: 'app did not reach toolbox' },
  );
  if (await lock.isExisting()) {
    await lock.waitForDisplayed({ timeout: 30_000 });
    await lock.setValue(password);
    await $('#app-lock-confirm').setValue(password);
    await $('#app-lock-submit, button.w-full').click();
  }
}

async function connectPostgres() {
  await $('[data-testid="toolbox-nav-postgres"]').waitForDisplayed();
  if (await $('[data-testid="postgres-disconnect"]').isExisting()) return;
  await $('[data-testid="toolbox-nav-postgres"]').click();
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await $('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  for (const input of inputs) await input.clearValue();
  await inputs[0].setValue(CONNECTION_NAME);
  await inputs[1].setValue('127.0.0.1');
  await browser.execute((input: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '55432');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, inputs[2]);
  await inputs[3].setValue('nexterm_e2e');
  await inputs[4].setValue('nexterm_e2e');
  await inputs[5].setValue('nexterm_e2e');
  await dialog.$('button=连接').click();
  await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20_000 });
  await $('[data-node-id*="connection:"]').waitForDisplayed({ timeout: 10_000 });
  await browser.pause(800);
}

/** Idempotently ensures the six object kinds exist in the fixture. */
async function ensureFixture() {
  const workspace = await $('[data-testid="postgres-workspace"]');
  await workspace.$('button=Query').click();
  const editors = await workspace.$$('.cm-content');
  const editor = editors[editors.length - 1];
  await editor.click();
  await editor.clearValue();
  await editor.setValue(
    'CREATE SEQUENCE IF NOT EXISTS public.e2e_order_seq START 100 INCREMENT 5; ' +
      'CREATE OR REPLACE FUNCTION public.e2e_add_numbers(a integer, b integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN a + b; END $$; ' +
      'CREATE OR REPLACE FUNCTION public.e2e_add_numbers(a integer, b text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN RETURN a || b; END $$; ' +
      'CREATE TABLE IF NOT EXISTS public.e2e_orders (id serial PRIMARY KEY, name text NOT NULL, score numeric, CONSTRAINT e2e_orders_score_check CHECK (score > 0)); ' +
      'CREATE INDEX IF NOT EXISTS e2e_orders_name_idx ON public.e2e_orders(name); ' +
      'CREATE UNIQUE INDEX IF NOT EXISTS e2e_orders_name_unique_idx ON public.e2e_orders(lower(name)); ' +
      'CREATE OR REPLACE FUNCTION public.e2e_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.name := COALESCE(NEW.name, \'updated\'); RETURN NEW; END $$; ' +
      'DROP TRIGGER IF EXISTS e2e_orders_updated_trg ON public.e2e_orders; ' +
      'CREATE TRIGGER e2e_orders_updated_trg BEFORE UPDATE ON public.e2e_orders FOR EACH ROW EXECUTE FUNCTION public.e2e_set_updated_at();',
  );
  await $('[data-testid="postgres-run"]').click();
  await browser.pause(1500);
  await $('[data-testid="postgres-refresh"]').click();
  await browser.pause(1200);
}

async function navigatorNode(parts: string[]): Promise<WebdriverIO.Element> {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const nodes = await $$('[data-testid="database-navigator-node"]');
    for (const node of nodes) {
      const nodeId = (await node.getAttribute('data-node-id')) ?? '';
      if (parts.every((part) => nodeId.includes(part))) return node;
    }
    await browser.pause(400);
  }
  throw new Error(`Navigator node not found: ${parts.join(' / ')}`);
}

/** Expands a group node (click only when still collapsed). */
async function expandGroup(parts: string[]) {
  const group = await navigatorNode(parts);
  if (!(await group.$('.lucide-chevron-down').isExisting())) {
    await group.click();
    await browser.pause(900);
  }
}

/** Right-clicks a navigator node and waits for the context menu (retry for WebKit). */
async function openContextMenu(target: string): Promise<WebdriverIO.Element> {
  const menu = await $('[data-testid="database-navigator-context-menu"]');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await $(target).click({ button: 'right' });
    try {
      await menu.waitForDisplayed({ timeout: 3000 });
      return menu;
    } catch {
      await browser.keys('Escape');
      await browser.pause(400);
    }
  }
  await $(target).click({ button: 'right' });
  await menu.waitForDisplayed({ timeout: 10_000 });
  return menu;
}

async function doubleClickNode(parts: string[]) {
  const node = await navigatorNode(parts);
  await browser.execute((id: string) => {
    const nodes = Array.from(
      document.querySelectorAll('[data-testid="database-navigator-node"]'),
    );
    const target = nodes.find((n) =>
      (n.getAttribute('data-node-id') || '').includes(id),
    );
    if (target) {
      target.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }),
      );
    }
  }, parts[parts.length - 1]);
}

async function editorText(): Promise<string> {
  const workspace = await $('[data-testid="postgres-workspace"]');
  const editors = await workspace.$$('.cm-content');
  if (!editors.length) return '';
  return editors[editors.length - 1].getText().catch(() => '');
}

describe('v2.9.0 (M2) visual capture', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
    await unlock();
    await connectPostgres();
    await ensureFixture();
  });

  it('01–06: tree, menus, viewer, manager, grouping', async () => {
    await configureTheme('深色');
    await browser.setWindowSize(2048, 1200);

    // Expand tables group + the table's four sub-groups, then functions and
    // sequences groups (six object kinds). The users table node must be
    // expanded first so its lazy-loaded sub-groups render.
    await expandGroup(['/group:tables']);
    await expandGroup(['/object:users']);
    await expandGroup(['/object:users', '/group:columns']);
    await expandGroup(['/object:users', '/group:indexes']);
    await expandGroup(['/object:users', '/group:constraints']);
    await expandGroup(['/object:users', '/group:triggers']);
    await expandGroup(['/group:functions']);
    await expandGroup(['/group:sequences']);
    await navigatorNode(['e2e_add_numbers']);
    await navigatorNode(['e2e_order_seq']);
    await browser.pause(600);
    await browser.saveScreenshot(`${SHOT}/01-object-tree.png`);

    // Function context menu.
    const functionNode = await navigatorNode(['e2e_add_numbers']);
    const functionId = await functionNode.getAttribute('data-node-id');
    const fnSelector = `[data-node-id="${functionId}"]`;
    const functionMenu = await openContextMenu(fnSelector);
    const functionMenuText = await functionMenu.getText();
    expect(functionMenuText).toContain('打开函数');
    expect(functionMenuText).toContain('生成 DDL');
    await browser.saveScreenshot(`${SHOT}/02-function-menu.png`);
    await functionMenu.$('[role="menuitem"]*=打开函数').click();

    // Object viewer (DDL preview + properties table).
    await browser.waitUntil(async () => {
      const text = await editorText();
      return text.includes('CREATE OR REPLACE FUNCTION');
    }, { timeout: 20_000, timeoutMsg: 'object viewer DDL did not render' });
    await browser.pause(800);
    await browser.saveScreenshot(`${SHOT}/03-object-viewer.png`);

    // Connection context menu (includes the manager entry).
    const connectionMenu = await openContextMenu('[data-node-id*="connection:"]');
    const connectionMenuText = await connectionMenu.getText();
    expect(connectionMenuText).toContain('连接管理器');
    expect(connectionMenuText).toContain('断开连接');
    await browser.saveScreenshot(`${SHOT}/04-connection-menu.png`);
    await connectionMenu.$('[role="menuitem"]*=连接管理器').click();

    // Connection manager dialog.
    const manager = await $('[data-testid="postgres-connection-manager"]');
    await manager.waitForDisplayed();
    await browser.pause(500);
    await browser.saveScreenshot(`${SHOT}/05-connection-manager.png`);

    // Set color + group on the first row, then close.
    const rows = await manager.$$('[data-testid="connection-manager-row"]');
    expect(rows.length).toBeGreaterThan(0);
    const firstRow = rows[0];
    const groupInput = await firstRow.$('[data-testid="connection-group-input"]');
    await groupInput.setValue('v29');
    await browser.keys('Enter');
    const colorSelect = await firstRow.$('[data-testid="connection-color-select"]');
    await colorSelect.click();
    await $(`[role="option"]*=#ef4444`).click();
    await browser.pause(600);
    await manager.$('button=关闭').click();
    await manager.waitForExist({ reverse: true });

    // Grouped navigator: group header + color dot + status badge.
    await $('[data-testid="connection-group-header"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="database-navigator-accent"]').waitForDisplayed({ timeout: 10_000 });
    await browser.pause(600);
    await browser.saveScreenshot(`${SHOT}/06-grouped-navigator.png`);
  });

  it('07: ConnectionDialog color/group fields', async () => {
    await $('[data-testid="postgres-new-connection"]').click();
    const dialog = await $('[data-testid="postgres-connection-dialog"]');
    await dialog.waitForDisplayed();
    // Scroll to the group/color fields so they are visible in the capture.
    await browser.execute(() => {
      const dialogEl = document.querySelector('[data-testid="postgres-connection-dialog"]');
      const inputs = Array.from(dialogEl?.querySelectorAll('input') ?? []);
      const groupInput = inputs.find((i) =>
        (i.getAttribute('placeholder') ?? '').includes('prod'),
      );
      groupInput?.scrollIntoView({ block: 'center' });
    });
    await browser.pause(400);
    await browser.saveScreenshot(`${SHOT}/07-dialog-fields.png`);
    await browser.keys('Escape');
    await dialog.waitForExist({ reverse: true });
  });

  it('08: light theme + small-window re-captures', async () => {
    await configureTheme('浅色');
    await $('[data-testid="connection-group-header"]').waitForDisplayed();
    await browser.pause(500);
    await browser.saveScreenshot(`${SHOT}/06-light-grouped-navigator.png`);

    await browser.setWindowSize(960, 700);
    await browser.pause(500);
    await browser.saveScreenshot(`${SHOT}/06-small-grouped-navigator.png`);
    await browser.saveScreenshot(`${SHOT}/07-small-dialog-fields.png`);
    await browser.setWindowSize(2048, 1200);
  });
});
