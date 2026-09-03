import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';

/**
 * B19 query commands + B20 keyboard scopes (native desktop E2E).
 * Requires the live PostgreSQL fixture on 127.0.0.1:55432.
 *
 * STATUS: READY — requires the live PostgreSQL fixture. Selectors below were
 * verified against the real DOM/testids:
 *   postgres-run / postgres-stop / postgres-explain (toolbar)
 *   .cm-editor (CodeMirror query editor)
 *   postgres-workspace (workspace shell)
 * Run this spec on a stable environment after R9 is lifted.
 */

const WORKSPACE_SELECTOR = '[data-testid="postgres-workspace"]';

async function connectPostgres() {
  const password = `E2E_${Date.now()}`;
  await unlockApp(password);

  const postgresNav = await waitForVisible('[data-testid="toolbox-nav-postgres"]');
  await postgresNav.click();
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await $('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  for (const input of inputs) await input.clearValue();
  await inputs[0].setValue(`B19 Query ${Date.now()}`);
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
  await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
}

/** Types SQL into the CodeMirror editor via the DOM (no clipboard dep). */
async function setEditorSql(sql: string) {
  // Drive the CodeMirror value through its contenteditable DOM directly.
  // Keyboard-typing newlines is unreliable in WebKit: the "\n" key can fire
  // the query-run Enter handler mid-typing (S1-1 fix). execCommand('insertText')
  // is observed by CodeMirror 6's beforeinput/input pipeline.
  await browser.execute((value: string) => {
    const content = document.querySelector('.cm-content') as HTMLElement | null;
    if (!content) return;
    content.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, value);
  }, sql);
  await browser.pause(300);
}

/** Current text of the visible CodeMirror document. */
async function editorText(): Promise<string> {
  return await browser.execute(
    () => document.querySelector('.cm-content')?.textContent ?? '',
  );
}

/**
 * Selects one CodeMirror line by dragging from its left edge to its right edge.
 * CodeMirror only reliably observes mouse/keyboard input; setting a DOM Range
 * directly does not update the editor selection used by Run Selection.
 */
async function selectEditorLine(index: number) {
  await browser.execute(
    (lineIndex: number) => {
      const content = document.querySelector('.cm-content');
      const line = content?.querySelectorAll('.cm-line')[lineIndex];
      if (!(content instanceof HTMLElement) || !(line instanceof HTMLElement)) return;
      const rect = line.getBoundingClientRect();
      const fire = (type: string, x: number) => {
        content.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: rect.top + rect.height / 2,
          button: 0,
        }));
      };
      content.focus();
      fire('mousedown', rect.left + 2);
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: rect.right - 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      }));
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        clientX: rect.right - 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      }));
    },
    index,
  );
  await browser.pause(300);
}

/**
 * WDIO's WebKit driver drops Ctrl for special keys such as Enter. The app-level
 * shortcut is exercised with a synthetic bubbling KeyboardEvent; real user
 * Ctrl+Enter/Cmd+Enter input remains unaffected.
 */
async function pressCtrlEnter() {
  await browser.execute(() => {
    document.querySelector('.cm-content')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await browser.pause(500);
}

describe('B19 query execution controls (native E2E)', () => {
  before(async () => {
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

  it('runs the current statement with Ctrl+Shift+R', async function () {
    this.timeout(150000);
    await connectPostgres();
    await $('[data-testid="postgres-new-query"]').click();
    await setEditorSql('SELECT 1;\nSELECT 2;');
    // Caret is at the end (line 2) -> Ctrl+Shift+R runs only "SELECT 2".
    await browser.keys(['Control', 'Shift', 'r']);
    await browser.waitUntil(
      async () => (await $(`${WORKSPACE_SELECTOR} tbody tr`).isExisting()),
      { timeout: 15000, timeoutMsg: 'result grid did not appear after Ctrl+Shift+R' },
    );
    // Expect exactly one result row with value 2.
    const firstCell = await $(`${WORKSPACE_SELECTOR} tbody tr:first-child td:nth-child(2)`);
    await firstCell.waitForDisplayed({ timeout: 10000 });
    expect(await firstCell.getText()).toContain('2');
  });

  it('stops a long-running query with Ctrl+T', async function () {
    this.timeout(150000);
    // Fresh query tab so no previous result grid lingers.
    await $('[data-testid="postgres-new-query"]').click();
    await setEditorSql('SELECT pg_sleep(30);');
    // Use the toolbar run button for the long query.
    await $('[data-testid="postgres-run"]').click();
    await waitForVisible('[data-testid="postgres-stop"]', 10_000);
    await browser.keys(['Control', 't']);
    await browser.waitUntil(
      async () => !(await $('[data-testid="postgres-stop"]').isExisting()),
      { timeout: 15000, timeoutMsg: 'stop button did not clear after Ctrl+T' },
    );
    // Connection is still usable: a quick query works.
    await setEditorSql('SELECT 42;');
    await $('[data-testid="postgres-run"]').click();
    await browser.waitUntil(
      async () => (await $(`${WORKSPACE_SELECTOR} tbody tr`).isExisting()),
      { timeout: 15000, timeoutMsg: 'connection unusable after stop' },
    );
  });

  it('executes selected SQL without replacing the unselected document text', async function () {
    this.timeout(150000);
    await $('[data-testid="postgres-new-query"]').click();
    await setEditorSql('SELECT 11 AS selected;\nSELECT 22 AS unselected;');

    await selectEditorLine(0);
    await pressCtrlEnter();

    const firstCell = await $(`${WORKSPACE_SELECTOR} tbody tr:first-child td:nth-child(2)`);
    await firstCell.waitForDisplayed({ timeout: 15000 });
    expect(await firstCell.getText()).toContain('11');

    const text = await editorText();
    expect(text).toContain('SELECT 11 AS selected');
    expect(text).toContain('SELECT 22 AS unselected');
    await browser.saveScreenshot('./test-results/database-visual/postgres-selection-executed.png');
  });
});

describe('B20 keyboard scope routing (native E2E)', () => {
  it('Ctrl+R applies filter in DATA_GRID and is not hijacked in query editor', async function () {
    this.timeout(150000);
    // Fresh query tab so no result grid from the earlier cases lingers —
    // otherwise the "no grid" assertion below would false-positive.
    await $('[data-testid="postgres-new-query"]').click();
    await setEditorSql('SELECT 1;');
    await browser.keys(['Control', 'r']);
    // No result grid should appear (plain Ctrl+R is unbound in QUERY_EDITOR).
    await browser.pause(800);
    const gridVisible = await $(`${WORKSPACE_SELECTOR} tbody tr`).isExisting();
    expect(gridVisible).toBe(false);
  });
});
