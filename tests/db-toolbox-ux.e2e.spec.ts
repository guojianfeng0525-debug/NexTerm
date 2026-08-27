import { expect, test, type Page } from '@playwright/test';

/**
 * DB toolbox UX end-to-end integration tests (branch feat/db-toolbox-ux-enhancement).
 *
 * Covers the "investigate a failing SQL" main loop plus the surrounding
 * context-menu / shortcut / history interactions:
 *   1. Navigator table right-click → Generate SQL ▸ SELECT → editor.
 *   2. Ctrl+Enter execute + structured error card (LINE n, jump-to-line, retry).
 *   3. Editor / grid right-click menus reachable.
 *   4. History view: last run shown, run-again re-executes.
 *   5. Shortcut badges on the shared editor menu (conditional: the shared
 *      QueryEditorMenu with badges lives on SQLite/MySQL, whose navigator
 *      entries are hidden by commit fe1d1f2 on main — the test skips with the
 *      reason when that entry is unreachable).
 *
 * The Tauri `invoke` surface is mocked via __TAURI_INTERNALS__ (same harness
 * as the existing postgres/mysql/sqlite workspace specs), so no real database
 * is required. The main link runs on PostgreSQL because it is the only DB
 * toolbox provider with a visible navigator entry today.
 */

declare global {
  interface Window {
    __pgExecuteCount?: number;
  }
}

/** Installs the PostgreSQL provider mock; the default query tab's execute
 *  fails with a real PG-shaped error carrying `LINE 1`. */
async function installPgMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, {
      __pgExecuteCount: 0,
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: { request?: { sql?: string; offset?: number } }) => {
          if (command === 'row_list') return Promise.resolve([]);
          if (command === 'postgres_connect') {
            return Promise.resolve({ serverVersion: '16.0' });
          }
          if (command === 'postgres_catalog_schemas') return Promise.resolve(['public']);
          if (command === 'postgres_catalog_search') {
            return Promise.resolve([{ kind: 'relation', schema: 'public', name: 'users', relationKind: 'r' }]);
          }
          if (command === 'postgres_catalog_objects') return Promise.resolve([]);
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
            const sql = args?.request?.sql ?? '';
            // Word-boundary match: "SELEC" (typo) fails, but valid "SELECT"
            // statements must NOT be treated as errors (SELEC ⊂ SELECT).
            if (/\bSELEC\b/.test(sql)) {
              return Promise.reject(
                new Error(
                  'PostgreSQL query failed: db error: ERROR: syntax error at or near "SELEC"\nLINE 1: SELEC * FROM users\n        ^',
                ),
              );
            }
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
  });
}

/** Installs the SQLite mock (only used by the conditional badge test). */
async function installSqliteMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          if (command === 'row_list') return Promise.resolve([]);
          if (command === 'sqlite_connect') {
            return Promise.resolve({ connectionId: 'sqlite-ux', connected: true });
          }
          if (command === 'sqlite_catalog_objects') {
            return Promise.resolve([{ name: 'users' }]);
          }
          return Promise.resolve(undefined);
        },
      },
    });
  });
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
  await inputs.nth(0).fill('PG UX Fixture');
  await inputs.nth(1).fill('127.0.0.1');
  await inputs.nth(2).fill('5432');
  await inputs.nth(3).fill('nexterm_e2e');
  await inputs.nth(4).fill('fixture');
  await inputs.nth(5).fill('fixture');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(workspace.getByTestId('postgres-disconnect')).toBeEnabled();
  return workspace;
}

/** Clears the query editor and types `sql` through the CodeMirror input path. */
async function typeSql(editor: ReturnType<Page['locator']>, sql: string): Promise<void> {
  const page = editor.page();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(sql);
  await expect(editor).toContainText(sql.slice(0, 20));
}

test.describe('DB toolbox UX', () => {
  test('navigator table right-click generates SELECT SQL into the editor', async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);

    const users = workspace.getByTestId('database-navigator-node').filter({ hasText: 'users' });
    await users.click({ button: 'right' });
    await expect(page.getByTestId('database-navigator-context-menu')).toBeVisible();
    await expect(page.getByTestId('navigator-generate-sql')).toBeVisible();

    await page.getByTestId('navigator-generate-sql').hover();
    await expect(page.getByTestId('navigator-generate-select')).toBeVisible();
    await page.getByTestId('navigator-generate-select').click();

    const editor = workspace.getByRole('main').locator('.cm-content');
    await expect(editor).toContainText('SELECT');
    await expect(editor).toContainText('"public"."users"');
    await expect(editor).toContainText('LIMIT 100');
  });

  test('Ctrl+Enter executes and renders the structured error card with LINE n', async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);

    await typeSql(workspace.getByRole('main').locator('.cm-content'), 'SELEC * FROM users');
    const before = await page.evaluate(() => window.__pgExecuteCount ?? 0);
    await page.keyboard.press('Control+Enter');

    const errorCard = page.getByTestId('database-result-error');
    await expect(errorCard).toBeVisible();
    await expect(errorCard).toContainText('syntax error');
    await expect(errorCard).toContainText('Line 1');
    await expect(errorCard.getByTestId('database-result-error-copy')).toBeVisible();
    await expect(errorCard.getByTestId('database-result-error-retry')).toBeVisible();

    // Jump-to-line reveals the offending editor line (selection lands on LINE 1).
    const goto = errorCard.getByTestId('database-result-error-goto');
    await expect(goto).toBeVisible();
    await goto.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) return null;
          const node = selection.getRangeAt(0).startContainer;
          const lineEl =
            node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
          return lineEl instanceof Element ? lineEl.closest('.cm-line')?.textContent ?? null : null;
        }),
      )
      .toContain('SELEC');

    // Retry re-runs the same failing statement.
    await page.getByTestId('database-result-error-retry').click();
    await expect
      .poll(() => page.evaluate(() => window.__pgExecuteCount ?? 0))
      .toBe(before + 2);
    await expect(page.getByTestId('database-result-error')).toBeVisible();
  });

  test('editor and grid context menus are reachable', async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole('main').locator('.cm-content');

    // Editor right-click menu: run / run-selection / format-sql.
    await editor.click({ button: 'right' });
    await expect(page.getByTestId('postgres-editor-execute')).toBeVisible();
    await expect(page.getByTestId('postgres-editor-run-selection')).toBeVisible();
    await expect(page.getByTestId('postgres-editor-format-sql')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('postgres-editor-execute')).toHaveCount(0);

    // Grid cell right-click menu (needs rows, so run a successful query first).
    await typeSql(editor, 'SELECT id, name FROM users ORDER BY id');
    await workspace.getByTestId('postgres-run').click();
    const grid = workspace.getByRole('main').locator('table tbody');
    await expect(grid).toContainText('Alice');
    // Right-click the data cell itself: the inner <button> is intentionally
    // disabled for read-only query results, and Playwright cannot hit disabled
    // elements — the Radix trigger wraps the whole cell.
    await grid.locator('td:has(button)').first().click({ button: 'right' });
    await expect(page.getByTestId('database-result-context-menu')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Copy Cell' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Copy Row' })).toBeVisible();
  });

  test('history view lists the last run and re-executes it', async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);

    await typeSql(workspace.getByRole('main').locator('.cm-content'), 'SELECT id, name FROM users ORDER BY id');
    await workspace.getByTestId('postgres-run').click();
    await expect(workspace.getByRole('main').locator('table tbody')).toContainText('Alice');

    await workspace.getByTestId('postgres-history').click();
    const history = page.getByTestId('query-history-view');
    await expect(history).toBeVisible();
    await expect(history.getByTestId('query-history-item-0')).toContainText(
      'SELECT id, name FROM users ORDER BY id',
    );

    // Run-again dispatches a re-execute through the history event bus.
    const before = await page.evaluate(() => window.__pgExecuteCount ?? 0);
    await history.getByTestId('query-history-item-0').hover();
    await history.getByTestId('query-history-run-0').click();
    await expect
      .poll(() => page.evaluate(() => window.__pgExecuteCount ?? 0))
      .toBe(before + 1);

    // Closing the panel restores the result pane, now showing the re-run output.
    await page.keyboard.press('Escape');
    await expect(history).toHaveCount(0);
    await expect(workspace.getByRole('main').locator('table tbody')).toContainText('Alice');
  });

  test('shared editor menu shows shortcut badges', async ({ page }) => {
    // The badge-bearing shared QueryEditorMenu (Ctrl+Enter / Ctrl+Shift+Enter /
    // Ctrl+Shift+F / Ctrl+/) is wired on the SQLite and MySQL tools. Their
    // navigator entries are hidden on main (commit fe1d1f2 "hide mysql and
    // sqlite navigation"), so this assertion is unreachable from the UI today.
    // Skip with an explicit reason instead of failing; it re-activates as soon
    // as the navigator entries are restored.
    await installSqliteMock(page);
    await page.goto('/');
    // Pass the first-run lock screen (fresh context → no stored password).
    const setup = page.getByRole('button', { name: 'Set Password' });
    if (await setup.isVisible()) {
      await page.getByRole('textbox', { name: 'New password' }).fill('e2e-password');
      await page.getByRole('textbox', { name: 'Confirm password' }).fill('e2e-password');
      await setup.click();
    }
    // Wait for the directory rail (a known-visible entry) before probing for
    // the hidden SQLite one.
    await expect(page.getByTestId('toolbox-nav-postgres')).toBeVisible();
    const hasSqliteNav = await page.getByTestId('toolbox-nav-sqlite').count();
    test.skip(
      hasSqliteNav === 0,
      'SQLite navigator entry is hidden by commit fe1d1f2; shared shortcut badges are unreachable from e2e',
    );

    await page.getByTestId('toolbox-nav-sqlite').click();
    const workspace = page.getByTestId('sqlite-workspace');
    await expect(workspace).toBeVisible();
    await workspace.locator('.cm-content').click({ button: 'right' });
    const badge = page
      .getByTestId('editor-menu-execute')
      .locator('[data-slot="context-menu-shortcut"]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/Ctrl\+Enter|⌘Enter/);
  });
});
