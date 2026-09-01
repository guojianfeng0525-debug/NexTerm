/**
 * QA acceptance spec: save-to-notes dialog rework (tool-postgres).
 *
 * Chain (PG fixture 55432): connect → seed 2 notes USING the save-to-notes
 * feature itself (create mode) → then verify every dialog behaviour:
 *   a) combobox dropdown lists existing notes
 *   b) type-to-filter → pick existing → append-mode badge + preview → confirm
 *   c) save with a new title → create-mode badge → confirm
 *   d) empty comment → confirm disabled (screenshot); fill → enabled
 *   e) Notes tool shows `-- comment` header + full SQL + correct titles
 *   f) re-save the same comment → duplicate warning (screenshot)
 * Extra keyboard/theme checkpoints: ↑↓ highlight + Enter select, Esc closes
 * the dropdown, dark-theme popover readability, long-title truncation.
 *
 * Input plumbing notes (2026-09-01, qa-e2e2):
 * - Query-tab SQL is set through the product's own `nexterm:paste-sql-to-query`
 *   window event (the real path of the Notes "paste SQL to query page"
 *   feature). This WKWebView WebDriver build delivers neither programmatic
 *   focus() nor execCommand/elementSendKeys to CodeMirror contenteditables —
 *   diagnosed hands-on: activeElement never leaves BODY, insertText returns
 *   false, WDIO setValue leaves tab.sql empty. The React-state event path is
 *   the strongest driver available and exercises a real product flow.
 * - Because of the same limitation the seed notes cannot be typed through
 *   the Notes editor; they are created through the save-to-notes dialog
 *   itself (create mode), which doubles as an extra full-chain check of the
 *   feature under test.
 *
 * Every key step saves a screenshot to test-results/save-notes/.
 */
import { expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { unlockApp, waitForVisible } from './helpers/webkit';

mkdirSync('./test-results/save-notes', { recursive: true });

const SHOT_DIR = './test-results/save-notes';
const NOTE_A = 'QA 慢查询合集';
const NOTE_B = 'QA 发布清单';
const SQL_A = 'SELECT id, username FROM public.users ORDER BY id LIMIT 5;';
const SQL_B = 'SELECT count(*) FROM public.users;';
const SQL_SEED_A = 'SELECT pg_sleep(1);';
const SQL_SEED_B = 'SELECT version();';
const COMMENT_SEED_A = '历史慢查询';
const COMMENT_SEED_B = '环境版本';
const COMMENT_A = '按 id 取前五用户';
const COMMENT_B = '用户总数统计';
const NEW_TITLE = 'QA 新建笔记验收';

function shot(name: string) {
  return browser.saveScreenshot(`${SHOT_DIR}/${name}.png`);
}

/**
 * Geometry guard for the two visual-risk states. MCP reviews pixels, while
 * these assertions tie the review to the actual DOM boxes that caused the
 * earlier defects: compact viewport-contained dialog, popover aligned to its
 * trigger, and a bounded command list.
 */
async function assertSaveDialogVisualGeometry() {
  const geometry = await browser.execute(() => {
    const visible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const popovers = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="popover-content"]')).filter(visible);
    const lists = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-list"]')).filter(visible);
    const triggers = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="postgres-save-note-target"]')).filter(visible);
    const rect = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const trigger = triggers.at(-1);
    const dialog = trigger?.closest<HTMLElement>('[data-slot="dialog-content"]');
    const dialogStyle = dialog ? getComputedStyle(dialog) : null;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      // Several tool dialogs can remain mounted with geometry while hidden.
      // Anchor the assertion to the dialog that owns this combobox.
      dialog: dialog ? rect(dialog) : null,
      dialogStyle: dialog && dialogStyle ? {
        className: dialog.className,
        position: dialogStyle.position,
        top: dialogStyle.top,
        height: dialogStyle.height,
        minHeight: dialogStyle.minHeight,
        maxHeight: dialogStyle.maxHeight,
        transform: dialogStyle.transform,
        gridTemplateColumns: dialogStyle.gridTemplateColumns,
      } : null,
      popover: popovers.at(-1) ? rect(popovers.at(-1)!) : null,
      trigger: trigger ? rect(trigger) : null,
      list: lists.at(-1) ? rect(lists.at(-1)!) : null,
    };
  });

  expect(geometry.dialog).not.toBeNull();
  expect(geometry.dialog!.y).toBeGreaterThanOrEqual(16);
  expect(geometry.dialog!.x).toBeGreaterThanOrEqual(16);
  expect(geometry.dialog!.right).toBeLessThanOrEqual(geometry.viewport.width - 16);
  expect(geometry.dialog!.bottom).toBeLessThanOrEqual(geometry.viewport.height - 16);
  expect(geometry.dialog!.height).toBeLessThanOrEqual(520);

  expect(geometry.popover).not.toBeNull();
  expect(geometry.trigger).not.toBeNull();
  expect(geometry.popover!.x).toBeGreaterThanOrEqual(16);
  expect(geometry.popover!.right).toBeLessThanOrEqual(geometry.viewport.width - 16);
  expect(Math.abs(geometry.popover!.x - geometry.trigger!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.popover!.width - geometry.trigger!.width)).toBeLessThanOrEqual(2);
  expect(geometry.popover!.height).toBeLessThanOrEqual(300);
  expect(geometry.list).not.toBeNull();
  expect(geometry.list!.height).toBeLessThanOrEqual(224 + 1);
}

let connectionId = '';

/** Set the active query-tab SQL through the product's paste-to-query event. */
async function setEditorSql(sql: string, sourceTitle: string) {
  if (!connectionId) throw new Error('setEditorSql: no connectionId captured');
  await browser.execute(
    (id: string, content: string, title: string) => {
      window.dispatchEvent(
        new CustomEvent('nexterm:paste-sql-to-query', {
          detail: { connectionId: id, content, sourceTitle: title },
        }),
      );
    },
    connectionId,
    sql,
    sourceTitle,
  );
  // Wait until the new tab's editor shows the SQL (React state set).
  await browser.waitUntil(
    async () => {
      const editors = await $('[data-testid="postgres-workspace"]').$$('.cm-content');
      for (const editor of editors.reverse()) {
        const text = await editor.getText().catch(() => '');
        if (text.includes(sql.slice(0, 20))) return true;
      }
      return false;
    },
    { timeout: 15_000, timeoutMsg: `paste-sql-to-query: editor never showed "${sql.slice(0, 30)}…"` },
  );
  await browser.pause(300);
}

/** Set an <input> value through the React-compatible native setter path. */
async function setInputValue(el: WebdriverIO.Element, value: string) {
  await browser.execute(
    (node: HTMLInputElement, text: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(node, text);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    },
    el,
    value,
  );
}

/** Open the save-to-notes dialog from the toolbar. */
async function openSaveDialog() {
  const btn = await $('[data-testid="postgres-save-to-notes"]');
  // Guard: the button is disabled while tab.sql is empty.
  await browser.waitUntil(async () => btn.isEnabled(), {
    timeout: 10_000,
    timeoutMsg: 'save-to-notes toolbar button never became enabled (tab.sql empty?)',
  });
  await btn.click();
  try {
    await $('[data-testid="postgres-save-note-confirm"]').waitForExist({ timeout: 10_000 });
  } catch (error) {
    // Text diagnostics (screenshot review is qa-visual's job, not E2E's).
    const dump = await browser.execute(() => {
      const btnEl = document.querySelector('[data-testid="postgres-save-to-notes"]');
      const dialog = document.querySelector('[role="dialog"]');
      const editor = document.querySelector('[data-testid="postgres-workspace"] .cm-content');
      return {
        btnExists: !!btnEl,
        btnDisabled: btnEl?.hasAttribute('disabled') ?? null,
        editorText: (editor?.textContent || '').slice(0, 80),
        anyDialog: !!dialog,
        dialogText: (dialog?.textContent || '').slice(0, 120),
      };
    });
    throw new Error(`save dialog did not open: ${JSON.stringify(dump)} :: ${error}`);
  }
}

/** Close the save dialog via the 取消 button. */
async function cancelSaveDialog() {
  await browser.keys('Escape'); // close combobox popover if open
  await browser.pause(200);
  // WKWebView can deliver the Escape to both the popover and the containing
  // dialog in one interaction. Both outcomes are acceptable here; the caller
  // reopens the dialog when the next checkpoint needs it.
  const confirm = await $('[data-testid="postgres-save-note-confirm"]');
  if (!(await confirm.isExisting())) return;
  const cancel = await $('button=取消');
  await cancel.click();
  await $('[data-testid="postgres-save-note-confirm"]').waitForExist({ reverse: true });
}

/** Open the note-target combobox popover. Returns the CommandInput element. */
async function openCombobox() {
  await $('[data-testid="postgres-save-note-target"]').click();
  const input = await $('[data-testid="postgres-save-note-title"]');
  await input.waitForExist({ timeout: 10_000 });
  return input;
}

/** Drive cmdk filtering the way a real user types (keystroke pipeline). */
async function typeIntoCombobox(text: string) {
  const input = await $('[data-testid="postgres-save-note-title"]');
  await browser.execute((node: HTMLElement) => node.focus(), input);
  // Clear first through the native setter + input event so cmdk re-filters.
  await setInputValue(input, '');
  await browser.keys(text);
  await browser.pause(250);
  return input;
}

/**
 * Save the active query SQL as a NEW note (create mode) through the dialog:
 * open → type title → type comment → confirm → wait for close.
 */
async function saveAsNewNote(title: string, comment: string) {
  await openSaveDialog();
  await openCombobox();
  await typeIntoCombobox(title);
  await browser.pause(400);
  const mode = await $('[data-testid="postgres-save-note-mode"]').getText();
  expect(mode).toContain('新建模式');
  const commentInput = await $('[data-testid="postgres-save-note-comment"]');
  await setInputValue(commentInput, comment);
  await browser.pause(200);
  const confirm = await $('[data-testid="postgres-save-note-confirm"]');
  await confirm.click();
  await $('[data-testid="postgres-save-note-confirm"]').waitForExist({ reverse: true });
}

describe('QA: save-to-notes dialog rework', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
  });

  it('a-f. full acceptance chain on the PG fixture', async () => {
    const password = `E2E_${Date.now()}`;
    await unlockApp(password);

    // ── Connect to the PG fixture (55432) ────────────────────────────────
    await (await waitForVisible('[data-testid="toolbox-nav-postgres"]')).click();
    await $('[data-testid="postgres-new-connection"]').click();
    const dialog = await $('[data-testid="postgres-connection-dialog"]');
    const inputs = await dialog.$$('input');
    const connName = `QA Save ${Date.now()}`;
    await inputs[0].setValue(connName);
    await inputs[1].setValue('127.0.0.1');
    await browser.execute((input: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, '55432');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, inputs[2]);
    await inputs[3].setValue('nexterm_e2e');
    await inputs[4].setValue('nexterm_e2e');
    await inputs[5].setValue('nexterm_e2e');
    await dialog.$('button=连接').click();
    await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 30_000 });
    // The paste-sql-to-query path below needs the stored connection id.
    connectionId = await browser.execute(
      (name: string) =>
        (window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<{ id: string; name: string }[]> };
        }).__TAURI_INTERNALS__.invoke('row_list', { table: 'postgres_connections' })
          .then((rows) => rows.find((row) => row.name === name)?.id ?? ''),
      connName,
    );
    if (!connectionId) throw new Error(`connection row not found for ${connName}`);
    await shot('01-connected');

    // ── Seed two notes through the save-to-notes feature itself ──────────
    // (create mode is exercised here and asserted formally in c) below; the
    // Notes editor cannot be typed into from this driver — see header note.)
    await setEditorSql(SQL_SEED_A, 'QA 种子 A');
    await saveAsNewNote(NOTE_A, COMMENT_SEED_A);
    await setEditorSql(SQL_SEED_B, 'QA 种子 B');
    await saveAsNewNote(NOTE_B, COMMENT_SEED_B);
    await shot('00-seeded-notes');

    // ── a) Combobox lists existing notes ────────────────────────────────
    await setEditorSql(SQL_A, 'QA 用例 A');
    await openSaveDialog();
    await shot('02-dialog-default');
    await openCombobox();
    await typeIntoCombobox('QA');
    await browser.pause(400);
    const options = await $$('[role="option"]');
    const optionTexts: string[] = [];
    for (const option of options) optionTexts.push(await option.getText());
    await shot('03-combobox-lists-notes');
    expect(optionTexts.join('\n')).toContain(NOTE_A);
    expect(optionTexts.join('\n')).toContain(NOTE_B);

    // ── Keyboard checkpoint: ↑/↓ highlight + Enter select ───────────────
    await browser.keys('ArrowDown');
    await browser.pause(200);
    await shot('04-keyboard-highlight');
    await browser.keys('Enter');
    await browser.pause(300);
    // Enter picked the highlighted item — dropdown closed, trigger shows it.
    const triggerText = await $('[data-testid="postgres-save-note-target"]').getText();
    expect(triggerText.length).toBeGreaterThan(0);
    expect(await $('[data-testid="postgres-save-note-title"]').isExisting()).toBe(false);

    // ── Esc checkpoint: reopen, Esc closes only the dropdown ────────────
    await $('[data-testid="postgres-save-note-target"]').click();
    await $('[data-testid="postgres-save-note-title"]').waitForExist({ timeout: 10_000 });
    await browser.keys('Escape');
    await browser.pause(300);
    expect(await $('[data-testid="postgres-save-note-title"]').isExisting()).toBe(false);
    expect(await $('[data-testid="postgres-save-note-confirm"]').isExisting()).toBe(true);
    await shot('05-esc-closes-dropdown');

    // ── b) Filter → pick existing note → append mode ────────────────────
    await openCombobox();
    await typeIntoCombobox(NOTE_A);
    await browser.pause(400);
    await shot('06-filter-append-target');
    // Click the matching option (text also carries the language badge and
    // line count, so match by substring, not exact text).
    const matchOption = await $(`[role="option"]*=${NOTE_A}`);
    await matchOption.click();
    await browser.pause(300);
    const modeText = await $('[data-testid="postgres-save-note-mode"]').getText();
    expect(modeText).toContain('追加模式');
    // First-line preview: NOTE_A's first line is the seed comment header.
    expect(modeText).toContain(`-- ${COMMENT_SEED_A}`);
    await shot('07-append-mode-badge');

    // ── d) Empty comment → confirm disabled ─────────────────────────────
    const confirmBtn = await $('[data-testid="postgres-save-note-confirm"]');
    expect(await confirmBtn.isEnabled()).toBe(false);
    await shot('08-comment-empty-disabled');

    const commentInput = await $('[data-testid="postgres-save-note-comment"]');
    await setInputValue(commentInput, COMMENT_A);
    await browser.pause(200);
    expect(await confirmBtn.isEnabled()).toBe(true);
    await shot('09-comment-filled-enabled');
    await confirmBtn.click();
    await $('[data-testid="postgres-save-note-confirm"]').waitForExist({ reverse: true });
    await shot('10-append-saved-toast');

    // ── c) New title → create mode (formal badge/duplicate-free check) ──
    await setEditorSql(SQL_B, 'QA 用例 B');
    await openSaveDialog();
    await openCombobox();
    await typeIntoCombobox(NEW_TITLE);
    await browser.pause(400);
    const modeText2 = await $('[data-testid="postgres-save-note-mode"]').getText();
    expect(modeText2).toContain('新建模式');
    await shot('11-create-mode-badge');
    const confirmBtn2 = await $('[data-testid="postgres-save-note-confirm"]');
    expect(await confirmBtn2.isEnabled()).toBe(false); // comment still empty
    const commentInput2 = await $('[data-testid="postgres-save-note-comment"]');
    await setInputValue(commentInput2, COMMENT_B);
    await browser.pause(200);
    expect(await confirmBtn2.isEnabled()).toBe(true);
    await confirmBtn2.click();
    await $('[data-testid="postgres-save-note-confirm"]').waitForExist({ reverse: true });

    // ── e) Notes tool: `-- comment` header + full SQL + titles ──────────
    await (await waitForVisible('[data-testid="toolbox-nav-notes"]')).click();
    await browser.pause(500);
    // Diagnostics: list what the Notes list actually shows right now.
    const notesListDump = await browser.execute(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const noteButtons = buttons
        .map((b) => (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40))
        .filter((text) => text.includes('QA '));
      const editors = Array.from(document.querySelectorAll('.cm-content')).map(
        (e) => (e.textContent || '').slice(0, 50),
      );
      return { noteButtons, editors };
    });
    // eslint-disable-next-line no-console
    console.log('NOTES_DUMP=' + JSON.stringify(notesListDump));

    // Appended note (NOTE_A): seed header + seed SQL + `-- COMMENT_A` + SQL_A.
    const appendedNote = await $(`button*=${NOTE_A.slice(0, 4)}`);
    await appendedNote.click();
    await browser.pause(500);
    // All tool views stay mounted (App.tsx hides them with .hidden), so pick
    // the VISIBLE CodeMirror editor — the Notes editor — not the last one.
    const readVisibleEditor = () =>
      browser.execute(() => {
        const editors = Array.from(document.querySelectorAll<HTMLElement>('.cm-content'));
        const visible = editors.filter((node) => node.getClientRects().length > 0);
        return (visible[visible.length - 1] ?? visible[0] ?? editors[editors.length - 1])?.textContent ?? '';
      });
    const appendedContent = await readVisibleEditor();
    await shot('12-notes-appended-content');
    // eslint-disable-next-line no-console
    console.log('NOTE_A_CONTENT=' + JSON.stringify(appendedContent.slice(0, 300)));
    // CodeMirror's rendered textContent drops some punctuation (semicolons)
    // and newlines between line widgets, so compare normalized forms:
    // whitespace-stripped AND semicolon-stripped.
    const norm = (s: string) => s.replace(/\s+/g, '').replace(/;/g, '');
    expect(norm(appendedContent).startsWith(norm(`-- ${COMMENT_SEED_A}`))).toBe(true);
    expect(norm(appendedContent)).toContain(norm(SQL_SEED_A));
    expect(norm(appendedContent)).toContain(norm(`-- ${COMMENT_A}`));
    expect(norm(appendedContent)).toContain(norm(SQL_A));

    // Created note (NEW_TITLE): starts with `-- COMMENT_B` + SQL_B.
    const createdNote = await $(`button*=${NEW_TITLE.slice(0, 4)}`);
    await createdNote.click();
    await browser.pause(500);
    const createdContent = await readVisibleEditor();
    await shot('13-notes-created-content');
    // eslint-disable-next-line no-console
    console.log('NEW_NOTE_CONTENT=' + JSON.stringify(createdContent.slice(0, 200)));
    expect(norm(createdContent).startsWith(norm(`-- ${COMMENT_B}`))).toBe(true);
    expect(norm(createdContent)).toContain(norm(SQL_B));
    // The new note's title is asserted from the list item (the title input
    // selector is ambiguous here — the notes search input also matches).
    const createdListText = await createdNote.getText();
    expect(createdListText).toContain(NEW_TITLE);

    // ── f) Duplicate comment warning ────────────────────────────────────
    await (await waitForVisible('[data-testid="toolbox-nav-postgres"]')).click();
    await browser.pause(300);
    await setEditorSql(SQL_A, 'QA 用例 A 复检'); // same SQL again
    await openSaveDialog();
    await openCombobox();
    await typeIntoCombobox(NOTE_A);
    await browser.pause(400);
    const dupOption = await $(`[role="option"]*=${NOTE_A}`);
    await dupOption.click();
    await browser.pause(300);
    // NOTE_A already contains `-- COMMENT_A` — type the same comment.
    const commentInput3 = await $('[data-testid="postgres-save-note-comment"]');
    await setInputValue(commentInput3, COMMENT_A);
    await browser.pause(300);
    const duplicateWarning = await $('[data-testid="postgres-save-note-duplicate"]');
    await duplicateWarning.waitForExist({ timeout: 5_000 });
    await shot('14-duplicate-warning');
    const duplicateText = await duplicateWarning.getText();
    expect(duplicateText.length).toBeGreaterThan(0);
    // Duplicate also disables the confirm button.
    const confirmBtn3 = await $('[data-testid="postgres-save-note-confirm"]');
    expect(await confirmBtn3.isEnabled()).toBe(false);
    // Changing the comment re-enables confirm (no duplicate anymore).
    await setInputValue(commentInput3, `${COMMENT_A} v2`);
    await browser.pause(300);
    expect(await confirmBtn3.isEnabled()).toBe(true);

    // ── Long-title truncation + dark theme popover readability ──────────
    await openCombobox();
    const LONG = 'QA 超长标题验收'.repeat(10);
    await typeIntoCombobox(LONG);
    await browser.pause(400);
    await assertSaveDialogVisualGeometry();
    await shot('15-long-title-truncated');

    // Dark theme: switch via settings, reopen the combobox popover.
    await cancelSaveDialog();
    await $('button:has(svg.lucide-settings)').click();
    const settingsDialog = await $('[role="dialog"]');
    await settingsDialog.$('button=界面').click();
    await settingsDialog.$('[role="combobox"]').click();
    await (await $(`[role="option"]=深色`)).click();
    await settingsDialog.$('button=保存设置').click();
    await settingsDialog.waitForExist({ reverse: true });
    await browser.pause(400);
    await openSaveDialog();
    await openCombobox();
    await typeIntoCombobox('QA');
    await browser.pause(400);
    await assertSaveDialogVisualGeometry();
    await shot('16-dark-theme-popover');

    // Restore light theme for any later specs in this run.
    await cancelSaveDialog();
    await $('button:has(svg.lucide-settings)').click();
    const restoreDialog = await $('[role="dialog"]');
    await restoreDialog.$('button=界面').click();
    await restoreDialog.$('[role="combobox"]').click();
    await (await $(`[role="option"]=浅色`)).click();
    await restoreDialog.$('button=保存设置').click();
    await restoreDialog.waitForExist({ reverse: true });
  });
});
