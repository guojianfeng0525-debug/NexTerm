import { expect } from "@wdio/globals";

describe("MySQL native workspace", () => {
  before(async () => { await browser.tauri.switchWindow("main"); });
  it("connects to the dedicated MySQL fixture and preserves precise result values", async () => {
    const password = `E2E_${Date.now()}`;
    await $("#app-lock-password").waitForDisplayed(); await $("#app-lock-password").setValue(password); await $("#app-lock-confirm").setValue(password); await $("#app-lock-submit, button.w-full").click();
    await $('[data-testid="toolbox-nav-mysql"]').click(); await $('[data-testid="mysql-new-connection"]').click();
    const dialog = await $('[data-testid="mysql-connection-dialog"]'); await browser.saveScreenshot('./test-results/database-visual/mysql-dialog-after.png'); await browser.execute(() => document.documentElement.classList.remove('dark')); await browser.saveScreenshot('./test-results/database-visual/mysql-dialog-light-after.png'); await browser.setWindowSize(960, 700); await browser.saveScreenshot('./test-results/database-visual/mysql-dialog-small-after.png'); await browser.setWindowSize(2048, 1200); await browser.execute(() => document.documentElement.classList.add('dark')); const inputs = await dialog.$$("input");
    await inputs[0]!.clearValue(); await inputs[1]!.clearValue(); await inputs[2]!.clearValue(); await inputs[3]!.clearValue(); await inputs[4]!.clearValue(); await inputs[5]!.clearValue();
    await inputs[0]!.setValue("NexTerm Native MySQL"); await inputs[1]!.setValue("127.0.0.1"); await inputs[2]!.setValue("33306"); await inputs[3]!.setValue("nexterm_e2e"); await inputs[4]!.setValue("nexterm_e2e"); await inputs[5]!.setValue("nexterm_e2e"); await browser.pause(100); await dialog.$("button=连接").click();
    await expect($('[data-testid="mysql-disconnect"]')).toBeEnabled(); await $("button=users").waitForDisplayed();
    const workspace = await $('[data-testid="mysql-workspace"]'); const editor = await workspace.$(".cm-content"); await editor.click(); await editor.clearValue(); await editor.setValue("SELECT id, name, balance, note FROM users ORDER BY id"); await $('[data-testid="mysql-run"]').click();
    const result = await workspace.$("table"); await result.waitForDisplayed(); expect(await result.getText()).toContain("9007199254740993"); expect(await result.getText()).toContain("1234567890.123456789"); await browser.saveScreenshot('./test-results/database-visual/mysql-workspace-after.png'); await expect($('[data-testid="mysql-explain"]')).not.toBeExisting();
  });
});
