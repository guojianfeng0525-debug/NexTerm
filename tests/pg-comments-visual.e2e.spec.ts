import { expect, test, type Page } from '@playwright/test';

/**
 * Visual verification: comment tooltips / bare-name completion / COMMENT ON DDL.
 * Driven by mock Tauri invokes carrying rich comment data, captures
 * screenshots for human review (headed run: NEXTERM_VISUAL=1 npx playwright test
 * tests/pg-comments-visual.e2e.spec.ts --headed --project=chromium).
 */

declare global {
  interface Window {
    __setSearchPathCalls?: { schema: string }[];
    __searchPathSql?: string;
  }
}

const COLUMNS = [
  { name: 'id', dataType: 'integer', comment: '主键，自增 ID', isPrimaryKey: true },
  { name: 'username', dataType: 'varchar(64)', comment: '用户登录名，唯一', isPrimaryKey: false },
  { name: 'email', dataType: 'varchar(255)', comment: "用户邮箱（O'Brien 转义测试）", isPrimaryKey: false },
  { name: 'created_at', dataType: 'timestamptz', comment: '注册时间', isPrimaryKey: false },
];

async function installVisualMock(page: Page) {
  await page.addInitScript((columns) => {
    Object.assign(window, {
      __setSearchPathCalls: [],
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: { request?: Record<string, unknown> }) => {
          const req = args?.request ?? {};
          if (command === 'row_list') return Promise.resolve([]);
          if (command === 'postgres_connect') return Promise.resolve({ serverVersion: '16.0' });
          if (command === 'postgres_catalog_schemas') return Promise.resolve(['public']);
          if (command === 'postgres_catalog_search') {
            // Bare-name relation completion: cross-schema candidates.
            if (req.kind === 'relation') {
              return Promise.resolve([
                { kind: 'relation', schema: 'public', name: 'users', relationKind: 'r', comment: '用户主表' },
                { kind: 'relation', schema: 'sales', name: 'users', relationKind: 'r', comment: '销售域用户快照' },
                { kind: 'relation', schema: 'public', name: 'user_logs', relationKind: 'r', comment: null },
              ]);
            }
            if (req.kind === 'column') {
              return Promise.resolve(
                columns.map((c: { name: string; dataType: string; comment: string }) => ({
                  kind: 'column',
                  schema: 'public',
                  relation: 'users',
                  name: c.name,
                  dataType: c.dataType,
                  comment: c.comment,
                })),
              );
            }
            return Promise.resolve([]);
          }
          if (command === 'postgres_catalog_objects') {
            if (req.kind === 'columns' && req.relation === 'users') {
              return Promise.resolve(
                columns.map((c: { name: string; dataType: string; comment: string; isPrimaryKey: boolean }, i: number) => ({
                  kind: 'column',
                  schema: 'public',
                  relation: 'users',
                  name: c.name,
                  dataType: c.dataType,
                  comment: c.comment,
                  nullable: true,
                  isPrimaryKey: c.isPrimaryKey,
                  ordinal: i,
                })),
              );
            }
            return Promise.resolve([]);
          }
          if (command === 'postgres_set_search_path') {
            window.__setSearchPathCalls?.push({ schema: String(req.schema ?? '') });
            return Promise.resolve(null);
          }
          if (command === 'postgres_table_data') {
            return Promise.resolve({
              columns: columns.map((c: { name: string }) => c.name),
              columnTypes: columns.map((c: { dataType: string }) => c.dataType),
              columnComments: columns.map((c: { comment: string }) => c.comment),
              rows: [['1', 'alice', "o'brien@x.io", '2026-08-01 10:00:00']],
              primaryKeyColumns: ['id'],
              nullableColumns: ['username', 'email', 'created_at'],
              truncated: false,
            });
          }
          if (command === 'postgres_execute') {
            return Promise.resolve({
              columns: ['ok'],
              rows: [['1']],
              commandTags: [],
              truncated: false,
            });
          }
          if (command === 'postgres_object_ddl') {
            window.__searchPathSql = 'ddl-requested';
            return Promise.resolve({ ddl: 'CREATE TABLE public.users (\n    id integer NOT NULL\n);\n\nCOMMENT ON TABLE public.users IS \'用户主表\';\nCOMMENT ON COLUMN public.users.id IS \'主键，自增 ID\';\nCOMMENT ON COLUMN public.users.username IS \'用户登录名，唯一\';' });
          }
          return Promise.resolve(undefined);
        },
      },
    });
  }, COLUMNS);
}

async function bootAndConnect(page: Page) {
  await page.goto('/');
  // Isolate this visual run from any persisted workspace tabs/state left by
  // previous E2E iterations (tab IDs are deterministic, so stale tabs would
  // shadow newly generated DDL).
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
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
  await expect(dialog).toBeVisible();
  const inputs = dialog.locator('input');
  await inputs.nth(0).fill('Visual Fixture');
  await inputs.nth(1).fill('127.0.0.1');
  await inputs.nth(2).fill('5432');
  await inputs.nth(3).fill('nexterm_visual');
  await inputs.nth(4).fill('visual');
  await inputs.nth(5).fill('visual');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByTestId('postgres-disconnect')).toBeEnabled();
}

test('visual: column comments + bare-name completion + COMMENT ON DDL', async ({ page }) => {
  await installVisualMock(page);
  await bootAndConnect(page);
  const workspace = page.getByTestId('postgres-workspace');

  // 1. search_path sync fired on connect with the selected schema.
  await expect
    .poll(() => page.evaluate(() => window.__setSearchPathCalls?.find((c) => c.schema === 'public') !== undefined))
    .toBe(true);

  // 2. Double-click the table → data grid with comment sub-headers visible.
  const navigator = workspace.locator('aside').first();
  // The relation node ("users" under Tables) is distinct from any column
  // node; scope to the navigator's Tables group via testid order — the
  // relation button is the one carrying data-node-id with "tables" in it.
  const users = navigator.getByRole('button', { name: 'users', exact: true }).first();
  await expect(users).toBeVisible();
  await users.dblclick();
  const grid = workspace.getByRole('main').locator('table');
  await expect(grid).toBeVisible();
  await expect(grid).toContainText('主键，自增 ID');
  await page.screenshot({ path: 'test-results/visual-pg/01-grid-comments.png', fullPage: true });

  // 3. Column header native tooltip carries type + comment.
  const headerCell = grid.locator('th').filter({ hasText: 'username' });
  await expect(headerCell).toHaveAttribute('title', 'varchar(64)\n用户登录名，唯一');
  await headerCell.hover();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/visual-pg/02-header-tooltip.png' });

  // 4. Navigator: expand users → Columns group → the `id` column node tooltip.
  const usersNode = navigator.getByRole('button', { name: 'users', exact: true }).first();
  await usersNode.click(); // single click selects + toggles expansion
  await page.waitForTimeout(300);
  const columnsGroup = navigator.getByRole('button', { name: 'Columns', exact: true }).first();
  if (await columnsGroup.isVisible().catch(() => false)) {
    await columnsGroup.click();
    await page.waitForTimeout(400);
  }
  const idNode = navigator.getByRole('button', { name: 'id', exact: true }).first();
  // Column node may or may not be present depending on lazy-load timing;
  // when present it must carry the comment tooltip (asserted), and the
  // screenshot captures the tree state either way for human review.
  if (await idNode.isVisible().catch(() => false)) {
    await expect(idNode).toHaveAttribute('title', '主键，自增 ID');
    await idNode.hover();
    await page.waitForTimeout(800);
  }
  await page.screenshot({ path: 'test-results/visual-pg/04-navigator-column-tooltip.png', fullPage: true });

  // 5. Bare-name completion: open a fresh query tab, type `FROM us`, capture
  //    the completion list showing cross-schema candidates with comment details.
  await page.getByTestId('postgres-new-query').click();
  const editor = workspace.locator('.cm-content');
  await editor.waitFor({ state: 'visible', timeout: 8000 });
  await editor.click();
  await editor.fill('SELECT * FROM us');
  await page.keyboard.press('ControlOrMeta+Space');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/visual-pg/03-bare-name-completion.png', fullPage: true });

  // 6. Navigator right-click → Generate DDL → assert the opened query tab
  //    contains COMMENT ON TABLE / COLUMN lines.
  await users.click({ button: 'right' });
  await page.waitForTimeout(400);
  const ddlItem = page.getByRole('menuitem', { name: 'Generate DDL' }).first();
  await expect(ddlItem).toBeVisible();
  await ddlItem.click();
  const ddlTab = page.getByRole('button', { name: /users\.ddl/ });
  await expect(ddlTab).toBeVisible();
  await ddlTab.click();
  await page.waitForTimeout(800);
  // The active editor is the first visible .cm-content; later detached/hidden
  // query editor instances may still be in DOM and must not be selected.
  const ddlEditor = page.locator('.cm-content').first();
  await expect(ddlEditor).toContainText('COMMENT ON TABLE');
  await expect(ddlEditor).toContainText('COMMENT ON COLUMN');
  await expect(ddlEditor).toContainText('用户主表');
  await expect(ddlEditor).toContainText('主键，自增 ID');
  await page.screenshot({ path: 'test-results/visual-pg/05-ddl-with-comments.png', fullPage: true });
});
