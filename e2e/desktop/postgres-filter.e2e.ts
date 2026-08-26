import { expect } from '@wdio/globals';

/**
 * B18 Slice A filter loop (native desktop E2E):
 *   open users table -> right-click a non-NULL cell -> Filter by field value
 *   -> rows shrink and every visible row matches the filtered value
 *   -> clear filter -> row count restored.
 *
 * Requires the live PostgreSQL fixture on 127.0.0.1:55432
 * (nexterm-postgres-visual, database nexterm_e2e, table users).
 *
 * NOTE: the two known spec defects (estimated clear testid + execute closures
 * over WORKSPACE_SELECTOR) were fixed on 2026-08-26 after the QA review
 * (b18-slice-a-qa-report.md §2.2). Remaining E2E blockers are environment
 * only (R9): WDIO desktop runs are unstable in this session's environment.
 * Row-count assertions are relative (N -> fewer -> N) on purpose so
 * leftover grid-edit rows from interrupted runs never flake the spec.
 */

const WORKSPACE_SELECTOR = '[data-testid="postgres-workspace"]';

async function rightClick(element: WebdriverIO.Element) {
  await element.click({ button: 'right' });
}

async function connectPostgres() {
  const password = `E2E_${Date.now()}`;
  await $('#app-lock-password').waitForDisplayed();
  await $('#app-lock-password').setValue(password);
  await $('#app-lock-confirm').setValue(password);
  await $('#app-lock-submit, button.w-full').click();

  const postgresNav = await $('[data-testid="toolbox-nav-postgres"]');
  await postgresNav.waitForDisplayed();
  await postgresNav.click();
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await $('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  for (const input of inputs) await input.clearValue();
  await inputs[0].setValue(`B18 Filter ${Date.now()}`);
  await inputs[1].setValue('127.0.0.1');
  // The port field is a React-controlled input; drive the native value setter
  // so the stored value survives the framework's value tracking.
  await browser.execute((input: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '55432');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, inputs[2]);
  await inputs[3].setValue('nexterm_e2e');
  await inputs[4].setValue('nexterm_e2e');
  await inputs[5].setValue('nexterm_e2e');
  await dialog.$('button=连接').click();
  await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
}

async function openUsersTable() {
  const tablesGroup = await $('[data-node-id*="/group:tables"]');
  if (!(await $('button=users').isExisting())) {
    await tablesGroup.click();
  }
  await $('button=users').waitForDisplayed({ timeout: 15000 });
  // B21: single-click selects, double-click opens the data grid. WebDriver/
  // WebKit does not synthesize a native dblclick, so dispatch it directly.
  await browser.execute((node: HTMLElement) => {
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, await $('button=users'));
  const workspace = await $(WORKSPACE_SELECTOR);
  await workspace.$('tbody tr').waitForDisplayed({ timeout: 15000 });
}

/** All lookups run inside the page so no WebDriver element reference can go
 * stale while React re-renders the grid. Returns counts / text snapshots.
 * NOTE: browser.execute callbacks are serialized — they must not close over
 * outer-scope constants, so the workspace selector is inlined in each body. */
async function rowCount(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-testid="postgres-workspace"] tbody tr').length,
  );
}

/** 1-based index of the column whose header label is `label` (column 1 is the
 * `#` gutter), or null when the column is not rendered. */
async function columnIndexByLabel(label: string): Promise<number | null> {
  return browser.execute((needle: string) => {
    const headers = document.querySelectorAll('[data-testid="postgres-workspace"] thead th');
    for (let i = 0; i < headers.length; i += 1) {
      if ((headers[i].textContent ?? '').trim() === needle) return i + 1;
    }
    return null;
  }, label);
}

/** Text of the cell at 1-based `column` of the first data row. */
async function firstRowCellText(column: number): Promise<string> {
  return browser.execute((col: number) => {
    const row = document.querySelector('[data-testid="postgres-workspace"] tbody tr');
    return row?.querySelector(`td:nth-child(${col})`)?.textContent?.trim() ?? '';
  }, column);
}

/** True when every data row's cell at `column` has the exact text `value`. */
async function allCellsMatch(column: number, value: string): Promise<boolean> {
  return browser.execute(
    (col: number, expected: string) => {
      const rows = document.querySelectorAll('[data-testid="postgres-workspace"] tbody tr');
      if (rows.length === 0) return false;
      for (const row of rows) {
        const text = row.querySelector(`td:nth-child(${col})`)?.textContent?.trim() ?? '';
        if (text !== expected) return false;
      }
      return true;
    },
    column,
    value,
  );
}

describe('PostgreSQL field-value filter (B18 Slice A)', () => {
  before(async () => {
    // switchWindow can occasionally time out on a cold launch; retry before
    // giving up so a slow first render does not fail the whole run.
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await browser.tauri.switchWindow('main');
        return;
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        await browser.pause(3000);
      }
    }
  });

  it('filters by field value, then clears the filter', async function () {
    // Connect + re-query + assert cycles need more headroom than the default
    // 90s mocha timeout on slower CI machines.
    this.timeout(150000);

    await connectPostgres();
    await openUsersTable();

    // The `active` boolean column has a mixed t/f distribution in the
    // fixture, so filtering it both shrinks the grid and gives a verifiable
    // "every visible row matches" invariant.
    const activeColumn = (await columnIndexByLabel('active'))!;
    expect(activeColumn).toBeGreaterThan(0);

    const totalBefore = await rowCount();
    expect(totalBefore).toBeGreaterThan(0);
    const filterValue = await firstRowCellText(activeColumn);
    // PostgreSQL booleans render as `t`/`f` (raw text) or `true`/`false`
    // depending on the result serialization; accept both spellings.
    expect(['t', 'f', 'true', 'false']).toContain(filterValue);

    // --- Filter by field value on the first row's active cell -------------
    const firstCell = await $(
      `${WORKSPACE_SELECTOR} tbody tr:first-child td:nth-child(${activeColumn}) button`,
    );
    await firstCell.waitForDisplayed();
    await rightClick(firstCell);

    const menu = await $('[data-testid="database-result-context-menu"]');
    await menu.waitForDisplayed({ timeout: 10000 });
    const items = await menu.$$('[role="menuitem"]');
    let filterItem: WebdriverIO.Element | undefined;
    for (const item of items) {
      const label = await item.getText();
      if (/Filter by field value|按字段值|字段值/.test(label)) {
        filterItem = item;
        break;
      }
    }
    expect(filterItem).toBeDefined();
    await filterItem!.click();
    await menu.waitForExist({ reverse: true, timeout: 10000 });

    // --- Filter applies: rows shrink and every row matches ----------------
    await browser.waitUntil(
      async () => {
        const count = await rowCount();
        return count > 0 && count < totalBefore && (await allCellsMatch(activeColumn, filterValue));
      },
      { timeout: 15000, timeoutMsg: 'field-value filter did not shrink/matching the grid' },
    );
    expect(await rowCount()).toBeGreaterThan(0);
    expect(await rowCount()).toBeLessThan(totalBefore);

    // --- Clear filter: row count restored ---------------------------------
    const clear = await $('[data-testid="postgres-clear-filter"]');
    await clear.waitForDisplayed({ timeout: 10000 });
    await clear.click();
    await browser.waitUntil(async () => (await rowCount()) === totalBefore, {
      timeout: 15000,
      timeoutMsg: 'clear filter did not restore the full row set',
    });
  });
});
