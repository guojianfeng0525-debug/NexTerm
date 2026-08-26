import { expect } from '@wdio/globals';

/**
 * B21 navigator object coverage — native desktop E2E against the live PG
 * fixture (127.0.0.1:55432, nexterm_e2e, nexterm-postgres-visual container).
 *
 * Covers: five schema-level groups, table-level sub-groups, double-click
 * viewer for function/sequence/index/constraint/trigger, column open-data,
 * context menus per object kind, and Drop with confirmation.
 *
 * Fixture objects (created idempotently on the container, see team notes):
 *   public.e2e_add_numbers(int,int) + (int,text)   — overloaded functions
 *   public.e2e_order_seq START 100 INCREMENT 5      — sequence
 *   public.e2e_orders (id serial PK, name, score CHECK) + 2 indexes + trigger
 */

async function connectPostgres() {
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
  const postgres = await $('[data-testid="toolbox-nav-postgres"]');
  await postgres.waitForDisplayed();
  if (await $('[data-testid="postgres-disconnect"]').isExisting()) return;
  await postgres.click();
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await $('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  for (const input of inputs) await input.clearValue();
  await inputs[0].setValue('B21 Navigator');
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
  await $('[data-testid="postgres-run"]').waitForEnabled();
}

/** Returns true when a navigator node matching all parts exists. */
async function hasNode(parts: string[]): Promise<boolean> {
  const nodes = await $$('[data-testid="database-navigator-node"]');
  for (const node of nodes) {
    const nodeId = await node.getAttribute('data-node-id');
    if (parts.every((part) => nodeId.includes(part))) return true;
  }
  return false;
}

/** Waits for a node with bounded, single-shot checks and generous pauses. */
async function waitForNode(parts: string[], timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await hasNode(parts)) return;
    await browser.pause(400);
  }
  throw new Error(`Navigator node not found: ${parts.join(' / ')}`);
}

async function navigatorNode(parts: string[]): Promise<WebdriverIO.Element> {
  await waitForNode(parts);
  const nodes = await $$('[data-testid="database-navigator-node"]');
  for (const node of nodes) {
    const nodeId = await node.getAttribute('data-node-id');
    if (parts.every((part) => nodeId.includes(part))) return node;
  }
  throw new Error(`Navigator node not found: ${parts.join(' / ')}`);
}

/** Double-clicks a navigator node via a native dblclick dispatch. */
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

/** Expands a group (click only when it is still collapsed). */
async function expandGroup(groupParts: string[]) {
  const group = await navigatorNode(groupParts);
  if (!(await group.$('.lucide-chevron-down').isExisting())) {
    await group.click();
    await browser.pause(800);
  }
}

async function editorText(): Promise<string> {
  const workspace = await $('[data-testid="postgres-workspace"]');
  const editors = await workspace.$$('.cm-content');
  if (!editors.length) return '';
  return editors[editors.length - 1].getText().catch(() => '');
}

/** Waits until the active editor text includes the expected fragments. */
async function waitForEditorText(fragments: string[], timeoutMs = 20_000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = await editorText();
    if (fragments.every((fragment) => last.includes(fragment))) return;
    await browser.pause(400);
  }
  throw new Error(`Editor text did not include ${fragments.join(', ')} — last text: ${last.slice(0, 120)}`);
}

/** Idempotently (re)creates the B21 fixture objects so the spec is repeatable
 * even after the drop test removed the trigger in a previous run. */
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

describe('B21 navigator object coverage', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
    await connectPostgres();
    await ensureFixture();
  });

  it('lists Functions and Sequences groups under the schema', async () => {
    await waitForNode(['/group:functions']);
    await waitForNode(['/group:sequences']);
  });

  it('lists user functions with overloads as separate nodes', async () => {
    await expandGroup(['/group:functions']);
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      const nodes = await $$('[data-testid="database-navigator-node"]');
      let count = 0;
      for (const node of nodes) {
        const nodeId = await node.getAttribute('data-node-id');
        if (nodeId.includes('/group:functions/object:e2e_add_numbers')) count += 1;
      }
      if (count === 2) break;
      await browser.pause(500);
    }
    const nodes = await $$('[data-testid="database-navigator-node"]');
    let count = 0;
    for (const node of nodes) {
      const nodeId = await node.getAttribute('data-node-id');
      if (nodeId.includes('/group:functions/object:e2e_add_numbers')) count += 1;
    }
    expect(count).toBe(2);
  });

  it('opens the function viewer on double-click with DDL and signature', async () => {
    await doubleClickNode(['/group:functions/object:e2e_add_numbers']);
    await waitForEditorText(['CREATE OR REPLACE FUNCTION', 'e2e_add_numbers']);
  });

  it('opens the sequence viewer with CREATE SEQUENCE DDL', async () => {
    await expandGroup(['/group:sequences']);
    await doubleClickNode(['/group:sequences/object:e2e_order_seq']);
    await waitForEditorText(['CREATE SEQUENCE', 'START WITH 100', 'INCREMENT BY 5']);
  });

  it('expands a table into Columns/Indexes/Constraints/Triggers sub-groups', async () => {
    await expandGroup(['/group:tables']);
    const table = await navigatorNode(['/group:tables/object:e2e_orders']);
    if (!(await table.$('.lucide-chevron-down').isExisting())) {
      await table.click();
      await browser.pause(800);
    }
    for (const sub of ['columns', 'indexes', 'constraints', 'triggers']) {
      await waitForNode([`/object:e2e_orders/group:${sub}`]);
    }
  });

  it('opens the index viewer with pg_get_indexdef DDL', async () => {
    await expandGroup(['/object:e2e_orders/group:indexes']);
    await doubleClickNode(['/group:indexes/object:e2e_orders_name_idx']);
    await waitForEditorText(['CREATE INDEX', 'e2e_orders_name_idx']);
  });

  it('opens the CHECK constraint viewer', async () => {
    await expandGroup(['/object:e2e_orders/group:constraints']);
    await doubleClickNode(['/group:constraints/object:e2e_orders_score_check']);
    await waitForEditorText(['CHECK']);
  });

  it('opens the trigger viewer with CREATE TRIGGER DDL', async () => {
    await expandGroup(['/object:e2e_orders/group:triggers']);
    await doubleClickNode(['/group:triggers/object:e2e_orders_updated_trg']);
    await waitForEditorText(['CREATE TRIGGER', 'e2e_orders_updated_trg']);
  });

  it('opens the owning table when a column is double-clicked', async () => {
    const users = await navigatorNode(['/group:tables/object:users']);
    if (!(await users.$('.lucide-chevron-down').isExisting())) {
      await users.click();
      await browser.pause(800);
    }
    await expandGroup(['/object:users/group:columns']);
    await doubleClickNode(['/object:users/group:columns/object:username']);
    const workspace = await $('[data-testid="postgres-workspace"]');
    const grid = await workspace.$('table');
    await grid.waitForDisplayed();
    const rowCount = await browser.execute(() => {
      return document.querySelectorAll('tbody tr').length;
    });
    expect(rowCount).toBeGreaterThan(0);
  });

  it('shows the function context menu with Drop Function', async () => {
    const nodes = await $$('[data-testid="database-navigator-node"]');
    let fnNode: WebdriverIO.Element | undefined;
    for (const node of nodes) {
      const nodeId = await node.getAttribute('data-node-id');
      if (nodeId.includes('/group:functions/object:e2e_add_numbers')) {
        fnNode = node;
        break;
      }
    }
    await fnNode!.click({ button: 'right' });
    const menu = await $('[data-testid="database-navigator-context-menu"]');
    await menu.waitForDisplayed();
    const text = await menu.getText();
    expect(text).toContain('生成 DDL');
    expect(text).toContain('删除');
    await browser.keys('Escape');
  });

  it('generates DDL into a query tab from the context menu', async () => {
    await expandGroup(['/group:sequences']);
    const sequence = await navigatorNode(['/group:sequences/object:e2e_order_seq']);
    await sequence.click({ button: 'right' });
    const menu = await $('[data-testid="database-navigator-context-menu"]');
    await menu.waitForDisplayed();
    const item = await menu.$('div[role="menuitem"]*=生成 DDL');
    await item.click();
    await waitForEditorText(['CREATE SEQUENCE', 'e2e_order_seq']);
  });

  it('copies the column name (qualified) from the context menu', async () => {
    const users = await navigatorNode(['/group:tables/object:users']);
    if (!(await users.$('.lucide-chevron-down').isExisting())) {
      await users.click();
      await browser.pause(800);
    }
    await expandGroup(['/object:users/group:columns']);
    const column = await navigatorNode(['/object:users/group:columns/object:username']);
    await column.click({ button: 'right' });
    const menu = await $('[data-testid="database-navigator-context-menu"]');
    await menu.waitForDisplayed();
    const item = await menu.$('div[role="menuitem"]*=复制列名');
    await item.click();
    await browser.pause(400);
    // Read the clipboard through the Tauri plugin (navigator.clipboard is
    // gated in WebKit and returns empty).
    const clipboard = await browser.execute(() => {
      // @ts-expect-error tauri internals
      const invoke = window.__TAURI_INTERNALS__.invoke;
      return invoke('plugin:clipboard-manager|read_text').catch(() => '');
    });
    expect(clipboard).toContain('"public"."users"."username"');
  });

  it('drops a trigger after confirmation and refreshes the tree', async () => {
    // Recreate the fixture trigger idempotently so the spec is repeatable.
    const workspace = await $('[data-testid="postgres-workspace"]');
    await workspace.$('button=Query').click();
    const editors = await workspace.$$('.cm-content');
    const editor = editors[editors.length - 1];
    await editor.click();
    await editor.clearValue();
    await editor.setValue(
      'DROP TRIGGER IF EXISTS e2e_orders_updated_trg ON public.e2e_orders; CREATE TRIGGER e2e_orders_updated_trg BEFORE UPDATE ON public.e2e_orders FOR EACH ROW EXECUTE FUNCTION public.e2e_set_updated_at();',
    );
    await $('[data-testid="postgres-run"]').click();
    await browser.pause(1200);
    await $('[data-testid="postgres-refresh"]').click();
    await browser.pause(1200);

    await expandGroup(['/object:e2e_orders/group:triggers']);
    const trigger = await navigatorNode(['/group:triggers/object:e2e_orders_updated_trg']);
    await trigger.click({ button: 'right' });
    const menu = await $('[data-testid="database-navigator-context-menu"]');
    await menu.waitForDisplayed();
    const dropItem = await menu.$('div[role="menuitem"]*=删除触发器');
    await dropItem.click();
    const confirm = await $('[data-testid="postgres-object-drop-confirm"]');
    await confirm.waitForDisplayed({ timeout: 15_000 });
    const action = await $('[data-testid="postgres-object-drop-confirm-action"]');
    await action.click();
    await confirm.waitForExist({ reverse: true });
    await $('[data-testid="postgres-refresh"]').click();
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      if (!(await hasNode(['/group:triggers/object:e2e_orders_updated_trg']))) return;
      await browser.pause(500);
    }
    throw new Error('trigger still present after drop');
  });
});
