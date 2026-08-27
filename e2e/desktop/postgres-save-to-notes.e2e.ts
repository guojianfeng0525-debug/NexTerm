import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';

describe('PostgreSQL save to notes', () => {
  it('writes a titled SQL note', async () => {
    await browser.tauri.switchWindow('main');
    await unlockApp(`E2E_${Date.now()}`);
    await (await waitForVisible('[data-testid="toolbox-nav-postgres"]')).click();
    await $('[data-testid="postgres-new-connection"]').click();
    const dialog = await $('[data-testid="postgres-connection-dialog"]');
    const inputs = await dialog.$$('input');
    await inputs[0].setValue(`Notes ${Date.now()}`);
    await inputs[1].setValue('127.0.0.1');
    await browser.execute((input: HTMLInputElement) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; set?.call(input, '55432'); input.dispatchEvent(new Event('input', { bubbles: true })); }, inputs[2]);
    await inputs[3].setValue('nexterm_e2e'); await inputs[4].setValue('nexterm_e2e'); await inputs[5].setValue('nexterm_e2e');
    await dialog.$('button=连接').click();
    await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
    await browser.execute(() => { const editor = document.querySelector('.cm-content') as HTMLElement; editor.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, 'SELECT 9090'); });
    await $('[data-testid="postgres-save-to-notes"]').click();
    const saveDialog = await $('[role="dialog"]');
    await (await saveDialog.$('input')).setValue('saved title');
    await (await saveDialog.$('[data-testid="postgres-save-note-confirm"]')).click();
    await browser.pause(800);
    await (await waitForVisible('[data-testid="toolbox-nav-notes"]')).click();
    const note = await $('button*=saved title');
    await note.waitForDisplayed({ timeout: 10000 });
    await note.click();
    expect(await note.getText()).toContain('-- saved title');
  });
});
