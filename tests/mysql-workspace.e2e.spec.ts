import { expect, test } from "@playwright/test";

test.describe("MySQL workspace", () => {
  test("uses the registered MySQL provider through shared workspace UI", async ({ page }) => {
    await page.addInitScript(() => { Object.assign(window, { __TAURI_INTERNALS__: { invoke: (command: string) => {
      if (command === "row_list") return Promise.resolve([]);
      if (command === "mysql_connect") return Promise.resolve({ connectionId: "mysql-e2e", connected: true });
      if (command === "mysql_catalog_objects") return Promise.resolve([{ name: "users" }, { name: "projects" }]);
      if (command === "mysql_execute") return Promise.resolve({ columns: ["id", "name", "balance"], rows: [["9007199254740993", "Alice", "1234567890.123456789"]], commandTags: [], truncated: false });
      return Promise.resolve(undefined);
    } } }); });
    await page.goto("/");
    const setup = page.getByRole("button", { name: "Set Password" }); if (await setup.isVisible()) { await page.getByRole("textbox", { name: "New password" }).fill("e2e-password"); await page.getByRole("textbox", { name: "Confirm password" }).fill("e2e-password"); await setup.click(); }
    await page.getByTestId("toolbox-nav-mysql").click();
    const workspace = page.getByTestId("mysql-workspace"); await expect(workspace).toBeVisible(); await expect(workspace.getByTestId("mysql-run")).toBeDisabled();
    await page.getByTestId("mysql-new-connection").click(); const dialog = page.getByTestId("mysql-connection-dialog");
    await page.getByTestId("database-provider-select").click(); await expect(page.getByRole("option", { name: "MySQL (Experimental)" })).toBeVisible(); await page.getByRole("option", { name: "MySQL (Experimental)" }).click();
    const inputs = dialog.locator("input"); await inputs.nth(0).fill("MySQL Fixture"); await inputs.nth(1).fill("127.0.0.1"); await inputs.nth(2).fill(""); await expect(inputs.nth(2)).toHaveValue(""); await inputs.nth(2).fill("3307"); await expect(inputs.nth(2)).toHaveValue("3307"); await inputs.nth(2).fill("3306"); await inputs.nth(3).fill("nexterm_e2e"); await inputs.nth(4).fill("fixture"); await inputs.nth(5).fill("fixture"); await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(workspace.getByTestId("mysql-disconnect")).toBeEnabled(); await expect(workspace.getByTestId("mysql-new-query")).toBeEnabled(); await expect(workspace.getByRole("button", { name: "users", exact: true })).toBeVisible();
    await workspace.locator(".cm-content").fill("SELECT id, name, balance FROM users ORDER BY id"); await workspace.getByTestId("mysql-run").click(); await expect(workspace.locator("table")).toContainText("9007199254740993"); await expect(workspace.getByRole("button", { name: "Explain", exact: true })).toHaveCount(0);
    await page.getByTestId("mysql-edit-connection").click(); await dialog.locator("input").nth(0).fill("MySQL Fixture Edited"); await dialog.getByRole("button", { name: "Save", exact: true }).click(); await page.keyboard.press("Escape"); await page.getByTestId("mysql-delete-connection").click(); await page.getByRole("button", { name: "Delete", exact: true }).click(); await expect(page.getByTestId("mysql-edit-connection")).toBeDisabled();
  });
});
