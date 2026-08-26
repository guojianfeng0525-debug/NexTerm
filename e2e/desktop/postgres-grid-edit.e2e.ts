import { expect } from '@wdio/globals';

/**
 * B17 data-grid edit loop (native desktop E2E):
 *   INSERT  -> edited columns only, PK back-filled, row merges after save
 *   UPDATE  -> PK back-fill makes the merged row editable again
 *   DELETE  -> context-menu + alert confirmation, row removed after save
 * Requires the live PostgreSQL fixture on 127.0.0.1:55432 (nexterm-postgres-visual).
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
  await inputs[0].setValue('B17 Grid Edit');
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
  await $('button=users').click();
  const workspace = await $(WORKSPACE_SELECTOR);
  await workspace.$('tbody tr').waitForDisplayed({ timeout: 15000 });
}

/**
 * Returns the index of the staged INSERT row (its gutter shows `+`), or null.
 * The lookup runs entirely inside the page so no element reference can go
 * stale while the grid re-renders (WebDriver's stale-element retry loop can
 * otherwise spin forever when a cached row is re-created by React).
 */
async function findInsertRowIndex(): Promise<number | null> {
  return browser.execute(() => {
    const rows = document.querySelectorAll('[data-testid="postgres-workspace"] tbody tr');
    for (let i = 0; i < rows.length; i += 1) {
      const gutter = rows[i].querySelector('td:first-child')?.textContent ?? '';
      if (gutter.trim() === '+') return i;
    }
    return null;
  });
}

/** Returns the index of the first row whose text contains `text`, or null. */
async function findRowIndexByText(text: string): Promise<number | null> {
  return browser.execute((needle: string) => {
    const rows = document.querySelectorAll('[data-testid="postgres-workspace"] tbody tr');
    for (let i = 0; i < rows.length; i += 1) {
      if ((rows[i].textContent ?? '').includes(needle)) return i;
    }
    return null;
  }, text);
}

async function rowElement(rowIndex: number) {
  const rows = await $(WORKSPACE_SELECTOR).$$('tbody tr');
  const row = rows[rowIndex];
  if (!row) throw new Error(`table row ${rowIndex} not found`);
  return row;
}

/**
 * Opens the cell editor at `column` (1-based) of row `rowIndex` and commits
 * `value`.
 *
 * WebKit WebDriver's `doubleClick()` command does not reliably synthesize the
 * `dblclick` event React listens for, so the native event is dispatched
 * directly. Typing goes through the rendered `<input>` via `setValue` and is
 * committed with Enter, matching the product's onKeyDown/onBlur flow. The
 * caller then waits until the cell actually shows the committed value.
 */
async function editCellAndCommit(rowIndex: number, column: number, value: string) {
  const row = await rowElement(rowIndex);
  const cell = await row.$(`td:nth-child(${column}) button`);
  await cell.waitForExist();
  await browser.execute((el: HTMLButtonElement) => {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  }, cell);
  const input = await row.$(`td:nth-child(${column}) input`);
  await input.waitForDisplayed({ timeout: 5000 });
  await input.setValue(value);
  await browser.keys('Enter');
  await browser.waitUntil(async () => {
    const text = await row.$(`td:nth-child(${column})`).getText();
    return text.includes(value);
  }, { timeout: 5000, timeoutMsg: `cell did not commit value "${value}"` });
}

describe('PostgreSQL grid edit loop (B17)', () => {
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

  it('inserts, updates, and deletes rows with a transactional save', async function () {
    // The full loop (connect + three save cycles) needs more headroom than the
    // default 90s mocha timeout on slower CI machines.
    this.timeout(150000);

    // Unique per run: a row left behind by an interrupted previous run never
    // collides with the values this run asserts on.
    const insertValue = `e2e_b17i_${Date.now()}`;
    const updateValue = `e2e_b17u_${Date.now()}`;

    await connectPostgres();
    await openUsersTable();

    // --- INSERT: add a row, edit only username, save -----------------------
    await $('[data-testid="postgres-add-record"]').waitForDisplayed({ timeout: 10000 });
    await $('[data-testid="postgres-add-record"]').click();
    await browser.waitUntil(async () => (await findInsertRowIndex()) !== null, {
      timeout: 5000,
      timeoutMsg: 'insert row did not render after Add Record click',
    });
    const insertIndex = (await findInsertRowIndex())!;
    await editCellAndCommit(insertIndex, 3, insertValue);
    await expect($('[data-testid="postgres-save-changes"]')).toBeEnabled();
    await $('[data-testid="postgres-save-changes"]').click();
    // A successful save resets `dirty` and clears pendingInserts, merging the
    // committed row into the grid, so the `+` gutter row disappears.
    await browser.waitUntil(async () => (await findInsertRowIndex()) === null, {
      timeout: 15000,
      timeoutMsg: 'insert row did not merge after saving',
    });
    expect(await findInsertRowIndex()).toBeNull();
    expect(await findRowIndexByText(insertValue)).not.toBeNull();

    // --- UPDATE: the back-filled PK makes the merged row editable ----------
    const mergedIndex = (await findRowIndexByText(insertValue))!;
    await editCellAndCommit(mergedIndex, 3, updateValue);
    await expect($('[data-testid="postgres-save-changes"]')).toBeEnabled();
    await $('[data-testid="postgres-save-changes"]').click();
    // On success the new baseline clears the amber "modified cell" highlight.
    await browser.waitUntil(async () => {
      const row = await rowElement(mergedIndex);
      const cls = (await row.$('td:nth-child(3)').getAttribute('class')) ?? '';
      return !cls.includes('bg-amber-500/10');
    }, { timeout: 15000, timeoutMsg: 'update save did not refresh the baseline' });
    expect(await findRowIndexByText(updateValue)).not.toBeNull();
    expect(await findRowIndexByText(insertValue)).toBeNull();

    // --- DELETE: context menu -> alert confirmation -> save ----------------
    const targetIndex = (await findRowIndexByText(updateValue))!;
    const targetUsernameCell = await (await rowElement(targetIndex)).$('td:nth-child(3) button');
    await rightClick(targetUsernameCell);
    const menu = await $('[data-testid="database-result-context-menu"]');
    await menu.waitForDisplayed();
    const items = await menu.$$('[role="menuitem"]');
    let deleteItem: WebdriverIO.Element | undefined;
    for (const item of items) {
      const label = await item.getText();
      if (label.includes('删除记录')) {
        deleteItem = item;
        break;
      }
    }
    expect(deleteItem).toBeDefined();
    await deleteItem!.click();

    const alert = await $('[role="alertdialog"]');
    await alert.waitForDisplayed();
    await alert.$('button=删除记录').click();
    await alert.waitForExist({ reverse: true });

    await expect($('[data-testid="postgres-save-changes"]')).toBeEnabled();
    await $('[data-testid="postgres-save-changes"]').click();
    // Only a committed DELETE removes the row from the grid.
    await browser.waitUntil(async () => (await findRowIndexByText(updateValue)) === null, {
      timeout: 15000,
      timeoutMsg: 'deleted row did not disappear after saving',
    });
    expect(await findRowIndexByText(updateValue)).toBeNull();
  });
});
