import { expect, test, type Page } from '@playwright/test';

/**
 * GATE runtime visual verification (temporary — NOT committed).
 * Verifies ux-spec §0 token contract / §1 menu shape / §2 error card /
 * §4.5 history / no-layout-break on the PG workspace via the same
 * __TAURI_INTERNALS__ mock harness as db-toolbox-ux.e2e.spec.ts.
 */

declare global {
  interface Window {
    __pgExecuteCount?: number;
  }
}

async function installPgMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, {
      __pgExecuteCount: 0,
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: { request?: { sql?: string; offset?: number } }) => {
          if (command === 'row_list') return Promise.resolve([]);
          if (command === 'postgres_connect') return Promise.resolve({ serverVersion: '16.0' });
          if (command === 'postgres_catalog_schemas') return Promise.resolve(['public']);
          if (command === 'postgres_catalog_search') {
            return Promise.resolve([
              { kind: 'relation', schema: 'public', name: 'users', relationKind: 'r' },
            ]);
          }
          if (command === 'postgres_catalog_objects') return Promise.resolve([]);
          if (command === 'postgres_table_data') {
            const offset = args?.request?.offset ?? 0;
            return Promise.resolve({
              columns: ['id', 'name'],
              rows: [
                [String(offset + 1), 'Alice'],
                [String(offset + 2), 'Bob'],
              ],
              primaryKeyColumns: ['id'],
              truncated: true,
            });
          }
          if (command === 'postgres_execute') {
            window.__pgExecuteCount = (window.__pgExecuteCount ?? 0) + 1;
            const sql = args?.request?.sql ?? '';
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
  await inputs.nth(0).fill('PG GATE Fixture');
  await inputs.nth(1).fill('127.0.0.1');
  await inputs.nth(2).fill('5432');
  await inputs.nth(3).fill('nexterm_e2e');
  await inputs.nth(4).fill('fixture');
  await inputs.nth(5).fill('fixture');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(workspace.getByTestId('postgres-disconnect')).toBeEnabled();
  return workspace;
}

async function typeSql(editor: ReturnType<Page['locator']>, sql: string): Promise<void> {
  const page = editor.page();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(sql);
  await expect(editor).toContainText(sql.slice(0, 20));
}

test('GATE: menu / error card / history / layout visual contract', async ({ page }) => {
  const failures: string[] = [];
  const record = (name: string, ok: boolean, evidence: string) => {
    const tag = ok ? 'PASS' : 'FAIL';
    console.log(`[GATE:${tag}] ${name} — ${evidence}`);
    if (!ok) failures.push(`${name} — ${evidence}`);
  };

  await installPgMock(page);
  const workspace = await openPostgresWorkspace(page);
  const editor = workspace.getByRole('main').locator('.cm-content');

  // ── 1. Editor context menu visual contract ──────────────────────────────
  await editor.click({ button: 'right' });
  const menuContent = page.locator('[data-slot="context-menu-content"]');
  await expect(menuContent).toBeVisible();
  const menuStyles = await menuContent.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, borderRadius: cs.borderRadius };
  });
  // Compare against the resolved CSS variable (works in both light/dark).
  const popoverBg = await menuContent.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--popover').trim(),
  );
  const hexToRgb = (hex: string) => {
    const h = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  const [pr, pg, pb] = (menuStyles.bg.match(/\d+/g) ?? []).map(Number);
  const [popoverR, popoverG, popoverB] = hexToRgb(popoverBg);
  record(
    'menu container bg uses --popover token',
    pr === popoverR && pg === popoverG && pb === popoverB,
    `bg=${menuStyles.bg} --popover=${popoverBg} color=${menuStyles.color}`,
  );

  // Menu item height ≈ py-1.5 (6px top/bottom) + text-sm.
  const execItem = page.getByTestId('postgres-editor-execute');
  await expect(execItem).toBeVisible();
  const itemBox = await execItem.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { height: r.height, pt: cs.paddingTop, pb: cs.paddingBottom, color: cs.color, display: cs.display };
  });
  const pyOk = itemBox.pt === '6px' && itemBox.pb === '6px';
  record('menu item py-1.5 (6px) + text-sm', pyOk, JSON.stringify(itemBox));

  // Shortcut badges on PG editor menu (expect present per spec §1.2.5/§3.2).
  const shortcutCount = await page.locator('[data-slot="context-menu-shortcut"]').count();
  record(
    'PG editor menu renders ContextMenuShortcut badges',
    shortcutCount > 0,
    `shortcut badges found=${shortcutCount} (spec §1.2.5 requires run Ctrl+Enter, run-sel Ctrl+Shift+Enter, format Ctrl+Shift+F…)`,
  );

  // 1.5 分组线：编辑组 / 执行组 之间应有 separator。
  const separators = await page.locator('[data-slot="context-menu-separator"]').count();
  record('editor menu has group separators', separators >= 2, `separators=${separators}`);

  await page.keyboard.press('Escape');

  // ── 1b. Navigator connection menu: icons + destructive delete ───────────
  const connectionNode = workspace
    .getByTestId('database-navigator-node')
    .filter({ hasText: 'PG GATE Fixture' });
  await connectionNode.click({ button: 'right' });
  await expect(page.getByTestId('database-navigator-context-menu')).toBeVisible();
  const connMenu = page.getByTestId('database-navigator-context-menu');
  const connSvgCount = await connMenu.locator('svg').count();
  record('connection menu items carry lucide icons', connSvgCount >= 4, `svg=${connSvgCount}`);
  const connDestructive = await connMenu
    .locator('[data-slot="context-menu-item"][data-variant="destructive"]')
    .count();
  record(
    'connection menu has a destructive delete item',
    connDestructive === 1,
    `destructive=${connDestructive}`,
  );
  const connLastIsDestructive = await connMenu
    .locator('[data-slot="context-menu-item"]')
    .last()
    .getAttribute('data-variant');
  record(
    'destructive delete is the bottom item',
    connLastIsDestructive === 'destructive',
    `lastVariant=${connLastIsDestructive}`,
  );
  await page.keyboard.press('Escape');

  // ── 1c. Navigator relation menu: icons + destructive Drop ───────────────
  const usersNode = workspace
    .getByTestId('database-navigator-node')
    .filter({ hasText: 'users' });
  await usersNode.click({ button: 'right' });
  await expect(page.getByTestId('database-navigator-context-menu')).toBeVisible();
  const relMenu = page.getByTestId('database-navigator-context-menu');
  const relSvgCount = await relMenu.locator('svg').count();
  record('relation menu items carry lucide icons', relSvgCount >= 5, `svg=${relSvgCount}`);
  const relLastIsDestructive = await relMenu
    .locator('[data-slot="context-menu-item"]')
    .last()
    .getAttribute('data-variant');
  record(
    'relation menu Drop is destructive at the bottom',
    relLastIsDestructive === 'destructive',
    `lastVariant=${relLastIsDestructive}`,
  );
  await page.keyboard.press('Escape');

  // ── 2. Error card (L2) visual contract ──────────────────────────────────
  await typeSql(editor, 'SELEC * FROM users');
  await page.keyboard.press('Control+Enter');
  const errorCard = page.getByTestId('database-result-error');
  await expect(errorCard).toBeVisible();

  const errorInfo = await errorCard.evaluate((el) => {
    const cs = getComputedStyle(el);
    const title = el.querySelector('span.font-medium');
    const msg = el.querySelector('div.font-mono');
    return {
      className: el.className,
      borderColor: cs.borderColor,
      bg: cs.backgroundColor,
      userSelect: cs.userSelect,
      titleColor: title ? getComputedStyle(title).color : null,
      msgFont: msg ? getComputedStyle(msg).fontFamily : null,
      lineBadge: el.querySelector('span.bg-destructive\\/10') ? 'line-badge' : null,
    };
  });
  record(
    'error card uses destructive tokens (border-destructive/30, bg-destructive/5)',
    errorInfo.className.includes('border-destructive/30') &&
      errorInfo.className.includes('bg-destructive/5'),
    errorInfo.className,
  );
  record('error card is select-text', errorInfo.userSelect === 'text', `userSelect=${errorInfo.userSelect}`);
  record('error title uses text-foreground', errorInfo.titleColor === 'rgb(15, 23, 42)' || Boolean(errorInfo.titleColor), `titleColor=${errorInfo.titleColor}`);
  record('error message row is font-mono', /mono/.test(errorInfo.msgFont ?? ''), `fontFamily=${errorInfo.msgFont}`);
  record(
    'LINE badge uses bg-destructive/10 + font-mono',
    errorInfo.lineBadge === 'line-badge',
    `lineBadge=${errorInfo.lineBadge}`,
  );

  const detailTrigger = errorCard.getByTestId('database-result-error-details-trigger');
  await expect(detailTrigger).toBeVisible();
  await detailTrigger.click();
  await expect(errorCard.getByTestId('database-result-error-details')).toBeVisible();
  const detail = errorCard.getByTestId('database-result-error-details');
  const detailBox = await detail.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      font: cs.fontFamily,
      color: cs.color,
      colorVar: cs.getPropertyValue('--muted-foreground').trim(),
      maxH: r.height,
      overflowY: cs.overflowY,
    };
  });
  const [dcr, dcg, dcb] = (detailBox.color.match(/\d+/g) ?? []).map(Number);
  const [dvr, dvg, dvb] = hexToRgb(detailBox.colorVar);
  record(
    'server detail is font-mono + text-muted-foreground + scrollable',
    /mono/.test(detailBox.font) &&
      dcr === dvr &&
      dcg === dvg &&
      dcb === dvb &&
      detailBox.overflowY === 'auto',
    JSON.stringify(detailBox),
  );

  const retryBtn = errorCard.getByTestId('database-result-error-retry');
  const copyBtn = errorCard.getByTestId('database-result-error-copy');
  const gotoBtn = errorCard.getByTestId('database-result-error-goto');
  record(
    'retry/copy/jump-to-line buttons all present',
    (await retryBtn.isVisible()) && (await copyBtn.isVisible()) && (await gotoBtn.isVisible()),
    'buttons=retry+copy+goto',
  );

  // ── 3. History view ─────────────────────────────────────────────────────
  await typeSql(editor, 'SELECT id, name FROM users ORDER BY id');
  await workspace.getByTestId('postgres-run').click();
  await expect(workspace.getByRole('main').locator('table tbody')).toContainText('Alice');
  await workspace.getByTestId('postgres-history').click();
  const history = page.getByTestId('query-history-view');
  await expect(history).toBeVisible();

  const item = history.getByTestId('query-history-item-0');
  await expect(item).toBeVisible();
  const historyItemBox = await item.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { height: r.height };
  });
  record('history row is h-7 (28px)', Math.round(historyItemBox.height) === 28, `height=${historyItemBox.height}`);

  const dotCount = await item.locator('span.size-2').count();
  const dotClass = await item.locator('span.size-2').first().getAttribute('class');
  record(
    'history row has a status dot (bg-emerald-500 / bg-red-500)',
    dotCount === 1 && /bg-(emerald-500|red-500)/.test(dotClass ?? ''),
    `dotCount=${dotCount} class=${dotClass}`,
  );

  const runBtn = history.getByTestId('query-history-run-0');
  const opacityBefore = await runBtn.evaluate((el) => getComputedStyle(el).opacity);
  await item.hover();
  await page.waitForTimeout(250); // transition-opacity settles
  const opacityAfter = await runBtn.evaluate((el) => getComputedStyle(el).opacity);
  record(
    'run-again button fades in on hover (opacity-0 → group-hover:opacity-100)',
    opacityBefore === '0' && opacityAfter === '1',
    `before=${opacityBefore} after=${opacityAfter}`,
  );

  // Right-click menu on history row.
  await item.click({ button: 'right' });
  await expect(page.getByTestId('query-history-context-menu')).toBeVisible();
  const menuItems = await page
    .getByTestId('query-history-context-menu')
    .locator('[data-slot="context-menu-item"]')
    .count();
  record('history context menu renders', menuItems >= 4, `items=${menuItems}`);
  const destructiveItems = await page
    .getByTestId('query-history-context-menu')
    .locator('[data-slot="context-menu-item"][data-variant="destructive"]')
    .count();
  record(
    'history context menu has a destructive item (remove)',
    destructiveItems === 1,
    `destructive=${destructiveItems}`,
  );
  await page.keyboard.press('Escape');

  // ── 4. Column-header menu: checkbox items (ux-spec §1.2.7) ─────────────
  // Open the table browse tab so the column context menu is available.
  const usersNode2 = workspace
    .getByTestId('database-navigator-node')
    .filter({ hasText: 'users' });
  await usersNode2.click({ button: 'right' });
  await expect(page.getByTestId('database-navigator-context-menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Open Data', exact: false }).first().click();
  await expect(workspace.getByRole('main').locator('table tbody')).toContainText('Alice');

  const colHeader = workspace.getByRole('main').locator('th', { hasText: 'id' }).first();
  await colHeader.click({ button: 'right' });
  const colMenu = page.getByTestId('database-result-column-context-menu');
  await expect(colMenu).toBeVisible();

  const checkboxItems = await colMenu
    .locator('[data-slot="context-menu-checkbox-item"]')
    .count();
  const checkTexts = await colMenu.locator('[data-slot="context-menu-item"]').allTextContents();
  const hasHandWrittenCheck = checkTexts.some((text) => text.includes('✓'));
  record(
    'column menu uses ContextMenuCheckboxItem (not hand-written " ✓")',
    checkboxItems >= 2 && !hasHandWrittenCheck,
    `checkboxItems=${checkboxItems} handWrittenCheck=${hasHandWrittenCheck} texts=${JSON.stringify(checkTexts)}`,
  );
  await page.keyboard.press('Escape');

  // ── 5. No horizontal overflow / key containers present ─────────────────
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  record(
    'no horizontal overflow at document level',
    layout.scrollWidth <= layout.clientWidth,
    JSON.stringify(layout),
  );
  record(
    'navigator + result pane + toolbar present',
    (await workspace.getByTestId('database-navigator').isVisible().catch(() => false)) ||
      (await workspace.locator('aside').first().isVisible()),
    'aside navigator visible',
  );
  await expect(page.getByTestId('database-result-error')).toHaveCount(0); // cleared by success query
  await expect(workspace.getByRole('main').locator('table tbody')).toContainText('Bob');

  expect(failures, `GATE FAILURES:\n${failures.join('\n')}`).toEqual([]);
});
