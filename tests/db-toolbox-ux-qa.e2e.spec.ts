import { expect, test, type Page } from '@playwright/test';

/**
 * DB toolbox UX enhancement — independent QA re-verification (terminal gate).
 *
 * Re-verifies every issue fixed by the dev-fix commits on
 * `feat/db-toolbox-ux-enhancement`:
 *   1. [P0-1] UPDATE generation with/without a primary key (`6ad88e7`)
 *   2. [P1-UX] generated SQL lands with a collapsed caret, not a whole-doc
 *      selection (`ea159cf` + `editor-flash.ts`)
 *   3. [P1-UX] Ctrl+S saves the current SQL in the editor (`a58d958`)
 *   4. [P2-6] DELETE generation carries the `-- 全表删除` inline warning and
 *      the submenu item is no longer `destructive` (`b66ee9e`)
 *   5. [P1-prod] MySQL/SQLite no longer swallow keys for unhandled combos —
 *      indirectly re-verified through Ctrl+Enter / F5 / Ctrl+N on PostgreSQL
 *      plus the unit suite (MySQL/SQLite navigator entries are hidden on main,
 *      so their menus are unreachable from e2e).
 *   6. [P2-4/P2-5] history view: right-click clear-all + container-level Esc.
 *
 * Same mock-Tauri harness as `tests/db-toolbox-ux.e2e.spec.ts`.
 */

declare global {
  interface Window {
    __pgExecuteCount?: number;
    __pgSchemaRequestCount?: number;
  }
}

/** Mock relations keyed by name → column metadata. */
const RELATIONS: Record<string, { name: string; isPrimaryKey: boolean }[]> = {
  // users: primary key present → UPDATE must generate `WHERE "id" = <id>`.
  users: [
    { name: 'id', isPrimaryKey: true },
    { name: 'name', isPrimaryKey: false },
    { name: 'email', isPrimaryKey: false },
  ],
  // orders: no primary key → UPDATE must fall back to `WHERE 1=1` placeholder.
  orders: [
    { name: 'id', isPrimaryKey: false },
    { name: 'amount', isPrimaryKey: false },
  ],
  // logs: no column metadata at all → generation degrades to SELECT *.
  logs: [],
};

/** Installs the QA PostgreSQL provider mock. */
async function installQaPgMock(page: Page): Promise<void> {
  await page.addInitScript((relations) => {
    Object.assign(window, {
      __pgExecuteCount: 0,
      __pgSchemaRequestCount: 0,
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: { request?: { sql?: string; offset?: number; kind?: string; relation?: string; schema?: string } }) => {
          if (command === 'row_list') return Promise.resolve([]);
          if (command === 'postgres_connect') {
            return Promise.resolve({ serverVersion: '16.0' });
          }
          if (command === 'postgres_catalog_schemas') {
            window.__pgSchemaRequestCount = (window.__pgSchemaRequestCount ?? 0) + 1;
            return Promise.resolve(['public']);
          }
          if (command === 'postgres_catalog_search') {
            return Promise.resolve(
              Object.keys(relations).map((name) => ({
                kind: 'relation',
                schema: 'public',
                name,
                relationKind: 'r',
              })),
            );
          }
          if (command === 'postgres_catalog_objects') {
            const kind = args?.request?.kind;
            const relation = args?.request?.relation;
            if (kind === 'columns' && relation && relations[relation]) {
              return Promise.resolve(
                relations[relation].map((column, index) => ({
                  kind: 'column',
                  schema: 'public',
                  relation,
                  name: column.name,
                  dataType: index === 0 ? 'integer' : 'text',
                  nullable: true,
                  isPrimaryKey: column.isPrimaryKey,
                  ordinal: index,
                })),
              );
            }
            return Promise.resolve([]);
          }
          if (command === 'postgres_table_data') {
            const offset = args?.request?.offset ?? 0;
            return Promise.resolve({
              columns: ['id'],
              rows: [[String(offset + 1)]],
              primaryKeyColumns: ['id'],
              truncated: true,
            });
          }
          if (command === 'postgres_execute') {
            window.__pgExecuteCount = (window.__pgExecuteCount ?? 0) + 1;
            return Promise.resolve({
              columns: ['id', 'name'],
              rows: [['1', 'Alice'], ['2', 'Bob']],
              commandTags: [],
              truncated: false,
            });
          }
          return Promise.resolve(undefined);
        },
      },
    });
  }, RELATIONS);
}

/** Boots the app, enters the PostgreSQL toolbox and connects through the dialog. */
async function openPostgresWorkspace(page: Page) {
  await page.goto('/');
  const setup = page.getByRole('button', { name: 'Set Password' });
  if (await setup.isVisible()) {
    await page.getByRole('textbox', { name: 'New password' }).fill('e2e-password');
    await page.getByRole('textbox', { name: 'Confirm password' }).fill('e2e-password');
    await setup.click();
  }
  await page.getByTestId('toolbox-nav-postgres').click();
  const workspace = page.getByTestId('postgres-workspace');
  await expect(workspace).toBeVisible();
  await page.getByTestId('postgres-new-connection').click();
  const dialog = page.getByTestId('postgres-connection-dialog');
  const inputs = dialog.locator('input');
  await inputs.nth(0).fill('PG QA Fixture');
  await inputs.nth(1).fill('127.0.0.1');
  await inputs.nth(2).fill('5432');
  await inputs.nth(3).fill('nexterm_e2e');
  await inputs.nth(4).fill('fixture');
  await inputs.nth(5).fill('fixture');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(workspace.getByTestId('postgres-disconnect')).toBeEnabled();
  return workspace;
}

/**
 * Right-clicks a navigator relation and opens the generate-SQL submenu.
 * PostgreSQL uses its own inline submenu (trigger `navigator-generate-sql`,
 * items `navigator-generate-{select,insert,update,delete}`); the shared
 * `navigator-menu-generate-*` ids belong to the SQLite/MySQL component.
 */
async function openGenerateSqlSubmenu(workspace: ReturnType<Page['locator']>, table: string) {
  const page = workspace.page();
  const node = workspace.getByTestId('database-navigator-node').filter({ hasText: table });
  await node.click({ button: 'right' });
  await expect(page.getByTestId('database-navigator-context-menu')).toBeVisible();
  await page.getByTestId('navigator-generate-sql').hover();
  await expect(page.getByTestId('navigator-generate-select')).toBeVisible();
}

/** Reads the DOM selection state of the focused editor. */
async function editorSelectionState(page: Page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return { present: false, collapsed: true, text: '' };
    }
    const range = sel.getRangeAt(0);
    return { present: true, collapsed: range.collapsed, text: range.toString() };
  });
}

/** Clears the query editor and types `sql` through the CodeMirror input path. */
async function typeSql(editor: ReturnType<Page['locator']>, sql: string): Promise<void> {
  const page = editor.page();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(sql);
  await expect(editor).toContainText(sql.slice(0, 20));
}

test.describe('DB toolbox UX — QA re-verification', () => {
  test('UPDATE generation: primary-key WHERE when the table has a PK (P0-1)', async ({ page }) => {
    await installQaPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole('main').locator('.cm-content');

    await openGenerateSqlSubmenu(workspace, 'users');
    await page.getByTestId('navigator-generate-update').click();

    await expect(editor).toContainText('UPDATE');
    await expect(editor).toContainText('"public"."users"');
    // Primary key present → WHERE on the PK column (not 1=1).
    await expect(editor).toContainText('WHERE "id" = <id>');
    await expect(editor).not.toContainText('WHERE 1=1');
  });

  test('UPDATE generation: WHERE 1=1 placeholder when the table has no PK (P0-1)', async ({ page }) => {
    await installQaPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole('main').locator('.cm-content');

    await openGenerateSqlSubmenu(workspace, 'orders');
    await page.getByTestId('navigator-generate-update').click();

    await expect(editor).toContainText('UPDATE');
    await expect(editor).toContainText('WHERE 1=1 -- TODO: 补充更新条件');
  });

  test('generated SQL inserts with a collapsed caret at the end, not a whole-doc selection (P1-UX)', async ({ page }) => {
    await installQaPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole('main').locator('.cm-content');

    await openGenerateSqlSubmenu(workspace, 'users');
    await page.getByTestId('navigator-generate-select').click();

    await expect(editor).toContainText('SELECT');
    await expect(editor).toContainText('FROM "public"."users" LIMIT 100;');
    // The caret must be collapsed (anchor === head) with no selected text —
    // the pre-fix defect selected the whole document.
    await expect
      .poll(async () => (await editorSelectionState(page)).collapsed)
      .toBe(true);
    const state = await editorSelectionState(page);
    expect(state.text).toBe('');
  });

  test('Ctrl+S in the editor saves the current SQL to the saved-queries store (P1-UX)', async ({ page }) => {
    await installQaPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole('main').locator('.cm-content');

    // Replace the default editor content with the probe statement so the saved
    // entry is exactly the typed SQL.
    await typeSql(editor, 'SELECT 1 AS qa_save_probe;');

    await page.keyboard.press('Control+s');
    const saved = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter((key) =>
        key.startsWith('nexterm.postgres.savedQueries.'),
      );
      return keys.flatMap((key) => JSON.parse(localStorage.getItem(key) ?? '[]') as { sql?: string }[]);
    });
    expect(saved.some((entry) => entry.sql === 'SELECT 1 AS qa_save_probe;')).toBe(true);
  });

  test('DELETE generation carries the full-table-delete warning and is not destructive (P2-6)', async ({ page }) => {
    await installQaPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole('main').locator('.cm-content');

    await openGenerateSqlSubmenu(workspace, 'users');
    // The DELETE item renders as a plain (non-destructive) menu item.
    const deleteItem = page.getByTestId('navigator-generate-delete');
    await expect(deleteItem).toHaveAttribute('data-variant', 'default');

    await deleteItem.click();
    await expect(editor).toContainText('-- 全表删除');
    await expect(editor).toContainText('DELETE FROM "public"."users";');
  });

  test('generate-SQL submenu exposes SELECT/INSERT/UPDATE/DELETE on PostgreSQL (b66ee9e)', async ({ page }) => {
    await installQaPgMock(page);
    const workspace = await openPostgresWorkspace(page);

    await openGenerateSqlSubmenu(workspace, 'users');
    await expect(page.getByTestId('navigator-generate-select')).toBeVisible();
    await expect(page.getByTestId('navigator-generate-insert')).toBeVisible();
    await expect(page.getByTestId('navigator-generate-update')).toBeVisible();
    await expect(page.getByTestId('navigator-generate-delete')).toBeVisible();
    // No "metadata unavailable" hint on PostgreSQL (columns are mocked).
    await expect(page.getByTestId('navigator-menu-generate-hint')).toHaveCount(0);
  });

  test('shortcuts: Ctrl+Enter executes, F5 refreshes the navigator, Ctrl+N opens a new query (8e73b0d)', async ({ page }) => {
    await installQaPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole('main').locator('.cm-content');

    // Ctrl+Enter executes the editor statement.
    await editor.click();
    await page.keyboard.insertText('SELECT id, name FROM users ORDER BY id');
    const executeBefore = await page.evaluate(() => window.__pgExecuteCount ?? 0);
    await page.keyboard.press('Control+Enter');
    await expect
      .poll(() => page.evaluate(() => window.__pgExecuteCount ?? 0))
      .toBe(executeBefore + 1);

    // F5 on the navigator refreshes the schema list.
    const schemaBefore = await page.evaluate(() => window.__pgSchemaRequestCount ?? 0);
    await workspace.getByTestId('database-navigator-node').filter({ hasText: 'users' }).click();
    await page.keyboard.press('F5');
    await expect
      .poll(() => page.evaluate(() => window.__pgSchemaRequestCount ?? 0))
      .toBeGreaterThan(schemaBefore);

    // The F5 refresh re-renders the navigator and drops focus; re-focus a
    // workspace element before Ctrl+N.
    await workspace.getByTestId('database-navigator-node').filter({ hasText: 'orders' }).click();
    const tabsBefore = await workspace.locator('main nav button').count();
    await page.keyboard.press('Control+n');
    await expect
      .poll(async () => workspace.locator('main nav button').count())
      .toBe(tabsBefore + 1);
  });

  test('history view: right-click clear-all present; Esc closes the panel (P2-4/P2-5)', async ({ page }) => {
    await installQaPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole('main').locator('.cm-content');

    // Produce a history entry.
    await editor.click();
    await page.keyboard.insertText('SELECT id, name FROM users ORDER BY id');
    await workspace.getByTestId('postgres-run').click();
    await expect(workspace.getByRole('main').locator('table tbody')).toContainText('Alice');

    // Open the history panel.
    await workspace.getByTestId('postgres-history').click();
    const history = page.getByTestId('query-history-view');
    await expect(history).toBeVisible();
    await expect(history.getByTestId('query-history-item-0')).toContainText('SELECT id, name FROM users');

    // Right-click menu exposes run / insert-to-editor / copy / remove / clear-all.
    await history.getByTestId('query-history-item-0').click({ button: 'right' });
    const menu = page.getByTestId('query-history-context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('query-history-menu-run')).toBeVisible();
    await expect(menu.getByTestId('query-history-menu-insert')).toBeVisible();
    await expect(menu.getByTestId('query-history-menu-copy')).toBeVisible();
    await expect(menu.getByTestId('query-history-menu-remove')).toBeVisible();
    await expect(menu.getByTestId('query-history-menu-clear')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // Esc inside the panel closes it (container-level, not a global listener).
    await history.getByTestId('query-history-item-0').click();
    await page.keyboard.press('Escape');
    await expect(history).toHaveCount(0);

    // Re-open and clear-all through the right-click menu + confirmation dialog.
    await workspace.getByTestId('postgres-history').click();
    await history.getByTestId('query-history-item-0').click({ button: 'right' });
    await page.getByTestId('query-history-menu-clear').click();
    const dialog = page.getByTestId('query-history-clear-confirm');
    await expect(dialog).toBeVisible();
    await dialog.click();
    await expect(page.getByTestId('query-history-list')).toHaveCount(0);
  });
});
