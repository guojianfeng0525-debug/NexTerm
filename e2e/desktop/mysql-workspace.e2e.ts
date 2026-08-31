import { expect } from "@wdio/globals";
import { unlockApp, waitForVisible } from './helpers/webkit';

async function configureTheme(label: "深色" | "浅色") {
  await $("button:has(svg.lucide-settings)").click();
  const settingsDialog = await $('[role="dialog"]');
  await settingsDialog.$("button=界面").click();
  await settingsDialog.$('[role="combobox"]').click();
  await $(`[role="option"]=${label}`).click();
  await settingsDialog.$("button=保存设置").click();
  await settingsDialog.waitForExist({ reverse: true });
}

describe("MySQL native workspace", () => {
  before(async () => { await browser.tauri.switchWindow("main"); });
  it.skip("connects to the dedicated MySQL fixture and preserves precise result values", async () => {
    // SKIPPED: commit fe1d1f2 ("chore(toolbox): hide mysql and sqlite
    // navigation") removed the `mysql` entry from NAV_ENTRIES, so
    // `[data-testid="toolbox-nav-mysql"]` no longer renders. Re-enable this
    // spec once the MySQL navigation entry is restored.
    const password = `E2E_${Date.now()}`;
    await unlockApp(password);
    await configureTheme("深色");
    const mysqlNav = await $('[data-testid="toolbox-nav-mysql"]');
    await mysqlNav.click(); await $('[data-testid="mysql-new-connection"]').click();
    const dialog = await $('[data-testid="mysql-connection-dialog"]'); await browser.saveScreenshot('./test-results/database-visual/mysql-dialog-after.png'); await browser.keys("Escape"); await dialog.waitForExist({ reverse: true }); await configureTheme("浅色"); await $('[data-testid="mysql-new-connection"]').click(); const lightDialog = await $('[data-testid="mysql-connection-dialog"]'); await browser.saveScreenshot('./test-results/database-visual/mysql-dialog-light-after.png'); await browser.setWindowSize(960, 700); await browser.saveScreenshot('./test-results/database-visual/mysql-dialog-small-after.png'); await browser.setWindowSize(2048, 1200); const inputs = await lightDialog.$$("input");
    await inputs[0]!.clearValue(); await inputs[1]!.clearValue(); await inputs[2]!.clearValue(); await inputs[3]!.clearValue(); await inputs[4]!.clearValue(); await inputs[5]!.clearValue();
    await inputs[0]!.setValue("NexTerm Native MySQL"); await inputs[1]!.setValue("127.0.0.1"); await inputs[2]!.setValue("33306"); await inputs[3]!.setValue("nexterm_e2e"); await inputs[4]!.setValue("nexterm_e2e"); await inputs[5]!.setValue("nexterm_e2e"); await browser.pause(100); await lightDialog.$("button=连接").click();
    await expect($('[data-testid="mysql-disconnect"]')).toBeEnabled(); await waitForVisible("button=users");
    const workspace = await $('[data-testid="mysql-workspace"]'); const editor = await workspace.$(".cm-content"); await editor.click(); await editor.clearValue(); await editor.setValue("SELECT id, name, balance, note FROM users ORDER BY id"); await $('[data-testid="mysql-run"]').click();
    const result = await workspace.$("table"); await result.waitForDisplayed(); expect(await result.getText()).toContain("9007199254740993"); expect(await result.getText()).toContain("1234567890.123456789"); await browser.saveScreenshot('./test-results/database-visual/mysql-workspace-after.png'); await expect($('[data-testid="mysql-explain"]')).not.toBeExisting();
  });
});
