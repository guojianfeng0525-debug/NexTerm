/**
 * UI/UX 界面复核临时脚本（ux-reviewer 运行时实测，非提交门禁）。
 *
 * 以用户视角走查 PG 工作台：右键菜单结构/弹出位置、生成 SQL 插入反馈、
 * 错误卡全链路（定位/重试/复制）、历史视图交互、快捷键、表设计器、
 * 危险操作确认路径。mock Tauri invoke 套路与 tests/db-toolbox-ux.e2e.spec.ts
 * 一致。截图输出到 docs/review/screenshots/。
 *
 * 运行：pnpm exec playwright test docs/review/db-toolbox-ux-review.spec.ts
 */

import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __pgExecuteCount?: number;
    __pgCatalogSearchCount?: number;
    __pgDesignApplyCalls?: number;
    __copied?: string[];
    __pgDropCalls?: unknown[];
  }
}

const SHOT_DIR = "docs/review/screenshots";

async function installPgMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, {
      __pgExecuteCount: 0,
      __pgCatalogSearchCount: 0,
      __pgDesignApplyCalls: 0,
      __pgDropCalls: [],
      __pgCalls: [],
      __delayExecuteMs: 0,
      __copied: [],
          __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: { request?: Record<string, unknown> }) => {
          const req = args?.request ?? {};
          window.__pgCalls?.push(command);
          if (command === "row_list") return Promise.resolve([]);
          // Force the UI into zh-CN so the review exercises the localized copy.
          if (command === "get_system_locale") return Promise.resolve("zh-CN");
          if (command === "postgres_connect") {
            return Promise.resolve({ serverVersion: "16.0" });
          }
          if (command === "postgres_disconnect") return Promise.resolve(undefined);
          if (command === "postgres_catalog_schemas") return Promise.resolve(["public"]);
          if (command === "postgres_catalog_search") {
            window.__pgCatalogSearchCount = (window.__pgCatalogSearchCount ?? 0) + 1;
            return Promise.resolve([
              { kind: "relation", schema: "public", name: "users", relationKind: "r" },
            ]);
          }
          if (command === "postgres_catalog_objects") {
            const kind = req.kind;
            if (kind === "columns") {
              return Promise.resolve([
                { name: "id", dataType: "int4", nullable: false, default: null },
                { name: "name", dataType: "text", nullable: true, default: null },
              ]);
            }
            return Promise.resolve([]);
          }
          if (command === "postgres_table_data") {
            const offset = (req.offset as number) ?? 0;
            return Promise.resolve({
              columns: ["id", "name"],
              rows: [
                [String(offset + 1), "Alice"],
                [String(offset + 2), "Bob"],
              ],
              primaryKeyColumns: ["id"],
              truncated: true,
            });
          }
          if (command === "postgres_execute") {
            window.__pgExecuteCount = (window.__pgExecuteCount ?? 0) + 1;
            const sql = (req.sql as string) ?? "";
            if (window.__delayExecuteMs) {
              await new Promise((r) => setTimeout(r, window.__delayExecuteMs));
            }
            if (/\bSELEC\b/.test(sql)) {
              return Promise.reject(
                new Error(
                  'PostgreSQL query failed: db error: ERROR: syntax error at or near "SELEC"\nLINE 1: SELEC * FROM users\n        ^',
                ),
              );
            }
            return Promise.resolve({
              columns: ["id", "name"],
              rows: [["1", "Alice"], ["2", "Bob"]],
              commandTags: [],
              truncated: false,
            });
          }
          if (command === "postgres_table_design_load") {
            return Promise.resolve({
              schema: "public",
              table: "users",
              columns: [
                { name: "id", dataType: "int4", nullable: false, default: null, comment: null, ordinal: 1, primaryKey: true },
                { name: "name", dataType: "text", nullable: true, default: null, comment: null, ordinal: 2, primaryKey: false },
              ],
              primaryKey: { name: "users_pkey", columns: ["id"] },
              constraints: [{ name: "users_pkey", type: "p", definition: "PRIMARY KEY (id)", columns: ["id"] }],
              indexes: [],
              foreignKeys: [],
              comment: null,
              hasData: true,
            });
          }
          if (command === "postgres_table_design_apply") {
            window.__pgDesignApplyCalls = (window.__pgDesignApplyCalls ?? 0) + 1;
            return Promise.resolve({ ddl: "-- apply", warnings: [], applied: true });
          }
          if (command === "postgres_drop_object") {
            window.__pgDropCalls = [...(window.__pgDropCalls ?? []), req];
            const confirmed = req.confirmed === true;
            if (confirmed) return Promise.resolve({ dropped: true });
            return Promise.resolve({
              objectExists: true,
              dependentCount: 0,
              sampleDependents: [],
            });
          }
          // Tauri clipboard-manager plugin: record every write for the copy test.
          if (command.includes("clipboard-manager") || command.includes("write_text")) {
            window.__copied?.push(JSON.stringify(args));
            return Promise.resolve();
          }
          return Promise.resolve(undefined);
        },
      },
    });
  });
}

async function openPostgresWorkspace(page: Page) {
  await page.goto("/");
  // Lock screen: match by stable testid (label copy changes with the locale).
  const setupSubmit = page.getByTestId("app-lock-submit");
  if (await setupSubmit.isVisible()) {
    await page.locator("#app-lock-password").fill("e2e-password");
    const confirm = page.locator("#app-lock-confirm");
    if (await confirm.isVisible()) await confirm.fill("e2e-password");
    await setupSubmit.click();
  }
  await page.getByTestId("toolbox-nav-postgres").click();
  const workspace = page.getByTestId("postgres-workspace");
  await expect(workspace).toBeVisible();
  await page.getByTestId("postgres-new-connection").click();
  const dialog = page.getByTestId("postgres-connection-dialog");
  const inputs = dialog.locator("input");
  await inputs.nth(0).fill("PG UX Fixture");
  await inputs.nth(1).fill("127.0.0.1");
  await inputs.nth(2).fill("5432");
  await inputs.nth(3).fill("nexterm_e2e");
  await inputs.nth(4).fill("fixture");
  await inputs.nth(5).fill("fixture");
  await dialog.getByRole("button", { name: /^(连接|Connect)$/ }).click();
  await expect(workspace.getByTestId("postgres-disconnect")).toBeEnabled();
  return workspace;
}

async function typeSql(page: Page, editor: ReturnType<Page["locator"]>, sql: string) {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(sql);
  await expect(editor).toContainText(sql.slice(0, 20));
}

async function editorSelectionText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    return selection ? selection.toString() : "";
  });
}

test.describe("UX 复核走查", () => {
  test("T1 导航树右键菜单结构 / 弹出位置 / 生成 SQL SELECT 插入反馈", async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const users = workspace.getByTestId("database-navigator-node").filter({ hasText: "users" });
    await users.click({ button: "right" });
    const menu = page.getByTestId("database-navigator-context-menu");
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    const vp = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
    await page.screenshot({ path: `${SHOT_DIR}/ux-t1-navigator-menu.png` });

    // 菜单项齐全性（spec §1.2.2）
    const items = menu.locator("[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']");
    const texts = await items.allTextContents();
    const joined = texts.join("|");
    for (const expectText of ["打开数据", "设计表", "生成 SQL", "复制名称", "生成 DDL", "刷新", "删除表"]) {
      expect(joined).toContain(expectText);
    }

    // hover 生成 SQL → 子菜单展开（PG 子菜单内容项无独立 testid，检查子项）
    await page.getByTestId("navigator-generate-sql").hover();
    await page.waitForTimeout(400);
    await expect(page.getByTestId("navigator-generate-select")).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/ux-t1-generate-sql-submenu.png` });

    // 点 SELECT → 插入编辑器 → 检查选中反馈（整段选中 or 光标）
    await page.getByTestId("navigator-generate-select").click();
    const editor = workspace.getByRole("main").locator(".cm-content");
    await expect(editor).toContainText('SELECT "id", "name" FROM "public"."users" LIMIT 100;');
    await page.screenshot({ path: `${SHOT_DIR}/ux-t1-select-inserted.png` });
    const sel = await editorSelectionText(page);
    console.log("T1 生成 SELECT 后编辑器原生选中文本长度:", sel.length);
    const sqlText = await editor.textContent();
    console.log("T1 编辑器全文长度:", (sqlText ?? "").length);
  });

  test("T2 生成 INSERT / UPDATE / DELETE SQL 内容检查（危险性）", async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const users = workspace.getByTestId("database-navigator-node").filter({ hasText: "users" });
    const editor = workspace.getByRole("main").locator(".cm-content");

    // INSERT
    await users.click({ button: "right" });
    await page.getByTestId("navigator-generate-sql").hover();
    await page.waitForTimeout(400);
    await page.getByTestId("navigator-generate-insert").click();
    await expect(editor).toContainText("INSERT INTO");
    const insertSql = await editor.textContent();
    console.log("T2 INSERT:", insertSql);
    await page.screenshot({ path: `${SHOT_DIR}/ux-t2-generate-insert.png` });

    // UPDATE — 关注是否带 WHERE
    await users.click({ button: "right" });
    await page.getByTestId("navigator-generate-sql").hover();
    await page.waitForTimeout(400);
    await page.getByTestId("navigator-generate-update").click();
    await expect(editor).toContainText("UPDATE");
    const updateSql = await editor.textContent();
    console.log("T2 UPDATE:", updateSql);
    await page.screenshot({ path: `${SHOT_DIR}/ux-t2-generate-update.png` });

    // DELETE
    await users.click({ button: "right" });
    await page.getByTestId("navigator-generate-sql").hover();
    await page.waitForTimeout(400);
    await page.getByTestId("navigator-generate-delete").click();
    await expect(editor).toContainText("DELETE FROM");
    const deleteSql = await editor.textContent();
    console.log("T2 DELETE:", deleteSql);
    await page.screenshot({ path: `${SHOT_DIR}/ux-t2-generate-delete.png` });
  });

  test("T3 错误卡全链路：LINE 徽标 / 详情折叠 / 定位 / 重试 / 复制", async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole("main").locator(".cm-content");
    await typeSql(page, editor, "SELEC * FROM users");

    const before = await page.evaluate(() => window.__pgExecuteCount ?? 0);
    await page.keyboard.press("Control+Enter");
    const errorCard = page.getByTestId("database-result-error");
    await expect(errorCard).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/ux-t3-error-card.png` });

    // 结构：标题 / LINE 徽标 / 消息 / 详情折叠 / 三按钮
    const title = errorCard.locator(":scope > div").first();
    console.log("T3 错误卡标题行:", (await title.textContent())?.trim());
    await expect(errorCard).toContainText("第 1 行");
    await expect(errorCard).toContainText("syntax error");

    // 详情折叠
    await errorCard.getByTestId("database-result-error-details-trigger").click();
    await expect(errorCard.getByTestId("database-result-error-details")).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/ux-t3-error-details-open.png` });

    // 复制（clipboard-manager 插件调用为异步，等待写入）
    const copyBtn = errorCard.getByTestId("database-result-error-copy");
    await copyBtn.click();
    await page.waitForTimeout(600);
    const copied = await page.evaluate(() => window.__copied ?? []);
    console.log("T3 复制内容:", copied[copied.length - 1]?.slice(0, 160));
    // 插件 writeText 的 payload 键为 text，内容应为完整原始错误（含 LINE n 与 caret）
    const copiedText = copied[copied.length - 1] ?? "";
    expect(copiedText).toContain("PostgreSQL query failed");
    expect(copiedText).toContain("LINE 1: SELEC * FROM users");
    expect(copiedText).toContain("^");

    // 定位 → 编辑器滚动到出错行（光标落在出错行，检查光标所在行文本）
    await errorCard.getByTestId("database-result-error-goto").click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) return null;
          const node = selection.getRangeAt(0).startContainer;
          const lineEl =
            node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
          return lineEl instanceof Element ? lineEl.closest(".cm-line")?.textContent ?? null : null;
        }),
      )
      .toContain("SELEC");
    await page.screenshot({ path: `${SHOT_DIR}/ux-t3-goto-line.png` });

    // 重试 → 再执行一次
    await errorCard.getByTestId("database-result-error-retry").click();
    await expect
      .poll(() => page.evaluate(() => window.__pgExecuteCount ?? 0))
      .toBe(before + 2);
  });

  test("T4 历史视图：列表 / hover 再次执行 / 右键 / 清空 AlertDialog / Esc", async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole("main").locator(".cm-content");

    // 执行成功一条 → 进历史
    await typeSql(page, editor, "SELECT id, name FROM users ORDER BY id");
    await workspace.getByTestId("postgres-run").click();
    await expect(workspace.getByRole("main").locator("table tbody")).toContainText("Alice");

    await workspace.getByTestId("postgres-history").click();
    const history = page.getByTestId("query-history-view");
    await expect(history).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/ux-t4-history.png` });
    await expect(history.getByTestId("query-history-item-0")).toContainText("SELECT id, name");

    // hover 浮现「再次执行」
    await history.getByTestId("query-history-item-0").hover();
    const runBtn = history.getByTestId("query-history-run-0");
    await expect(runBtn).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/ux-t4-history-hover.png` });

    // 右键菜单项
    await history.getByTestId("query-history-item-0").click({ button: "right" });
    const ctxMenu = page.getByTestId("query-history-context-menu");
    await expect(ctxMenu).toBeVisible();
    const ctxTexts = await ctxMenu.locator("[role='menuitem']").allTextContents();
    console.log("T4 历史右键菜单项:", ctxTexts.map((t) => t.trim()).join("|"));
    await page.screenshot({ path: `${SHOT_DIR}/ux-t4-history-context-menu.png` });
    // Escape 关闭右键菜单（面板级 Esc 监听会同时关闭历史面板——这正是被测行为）
    await page.keyboard.press("Escape");
    await expect(ctxMenu).toHaveCount(0);
    // 面板被 Esc 一起关闭则重新打开，继续清空流程
    if (await history.count() === 0) {
      await workspace.getByTestId("postgres-history").click();
    }
    await expect(page.getByTestId("query-history-view")).toBeVisible();

    // 清空 → AlertDialog
    await history.getByTestId("query-history-clear").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/ux-t4-history-clear-dialog.png` });
    const dialogText = await dialog.textContent();
    console.log("T4 清空确认文案:", dialogText?.trim());
    await page.getByTestId("query-history-clear-confirm").click();
    await expect(history.getByTestId("query-history-item-0")).toHaveCount(0);
    await page.screenshot({ path: `${SHOT_DIR}/ux-t4-history-cleared.png` });

    // Esc 关闭面板
    await page.keyboard.press("Escape");
    await expect(history).toHaveCount(0);
  });

  test("T5 快捷键：Ctrl+N / Ctrl+W / F5 / Ctrl+S（编辑器保存 SQL）", async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole("main").locator(".cm-content");
    await typeSql(page, editor, "SELECT 1");

    // F5 刷新导航树：先展开 schema 产生"已展开节点"，刷新才会真正发请求
    const schemaNode = workspace.getByTestId("database-navigator-node").filter({ hasText: "public" });
    await schemaNode.dblclick().catch(() => undefined);
    await page.waitForTimeout(600);
    const beforeSearch = await page.evaluate(() => window.__pgCatalogSearchCount ?? 0);
    await page.keyboard.press("F5");
    await expect
      .poll(() => page.evaluate(() => window.__pgCatalogSearchCount ?? 0))
      .toBeGreaterThan(beforeSearch);
    console.log("T5 F5 刷新导航树 OK");

    // Ctrl+S 在编辑器内 → 应保存 SQL（写 localStorage + toast）
    const keyBefore = await page.evaluate(
      () => Object.keys(localStorage).filter((k) => k.startsWith("nexterm.postgres.savedQueries.")).length,
    );
    await page.keyboard.press("ControlOrMeta+S");
    const toast = page.getByText("SQL 已保存", { exact: false });
    await toast.waitFor({ timeout: 3000 }).catch(() => undefined);
    const keyAfter = await page.evaluate(
      () => Object.keys(localStorage).filter((k) => k.startsWith("nexterm.postgres.savedQueries.")).length,
    );
    console.log(`T5 Ctrl+S 保存 SQL：key 数量 ${keyBefore} → ${keyAfter}，toast 可见=${await toast.isVisible().catch(() => false)}`);
    await page.screenshot({ path: `${SHOT_DIR}/ux-t5-ctrl-s.png` });

    // Ctrl+N 新建查询（tab 计数 +1；tab 自身无独立 testid，用关闭按钮前缀计数）
    const tabBefore = await page.locator('[data-testid^="database-workspace-close-"]').count();
    await page.keyboard.press("ControlOrMeta+N");
    await expect
      .poll(() => page.locator('[data-testid^="database-workspace-close-"]').count())
      .toBeGreaterThan(tabBefore);
    console.log("T5 Ctrl+N 新建查询 OK");

    // Ctrl+W 关闭当前 tab
    await page.keyboard.press("ControlOrMeta+W");
    // 至少还剩 1 个查询 tab（close 后兜底 newQuery）
    await expect.poll(() => workspace.locator(".cm-content").count()).toBeGreaterThanOrEqual(1);
    console.log("T5 Ctrl+W 关闭 tab OK");
  });

  test("T6 表设计器 Ctrl+S 应用 / Escape 放弃", async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const users = workspace.getByTestId("database-navigator-node").filter({ hasText: "users" });

    // 打开表设计器
    await users.click({ button: "right" });
    await page.getByRole("menuitem", { name: "设计表" }).click();
    const designer = page.getByTestId("table-designer");
    await expect(designer).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/ux-t6-designer.png` });

    // 修改列名触发 dirty
    const nameInput = page.getByTestId("designer-column-name-0");
    await nameInput.fill("user_id");
    await expect(designer.getByTestId("designer-save")).toBeEnabled();

    // Escape 放弃：先点击工具栏按钮让焦点离开输入框（输入框内 Esc 被 IME/输入保护）
    await designer.getByTestId("designer-refresh").click();
    await page.keyboard.press("Escape");
    await expect(designer.getByTestId("designer-save")).toBeDisabled();
    await page.screenshot({ path: `${SHOT_DIR}/ux-t6-designer-escaped.png` });

    // 再改一次 → Ctrl+S 应用
    await nameInput.fill("user_id");
    const applyBefore = await page.evaluate(() => window.__pgDesignApplyCalls ?? 0);
    await page.keyboard.press("ControlOrMeta+S");
    await expect
      .poll(() => page.evaluate(() => window.__pgDesignApplyCalls ?? 0))
      .toBeGreaterThan(applyBefore);
    console.log("T6 表设计器 Ctrl+S 触发 apply");
    await page.screenshot({ path: `${SHOT_DIR}/ux-t6-designer-saved.png` });
  });

  test("T7 危险操作确认：删除连接 AlertDialog / 删除表 dry-run 预览", async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);

    // 连接节点右键 → 删除连接 → AlertDialog
    const conn = workspace.getByTestId("database-navigator-node").filter({ hasText: "PG UX Fixture" });
    await conn.click({ button: "right" });
    const menu = page.getByTestId("database-navigator-context-menu");
    await expect(menu).toBeVisible();
    await page.getByRole("menuitem", { name: "删除" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    const dialogText = await dialog.textContent();
    console.log("T7 删除连接确认文案:", dialogText?.trim());
    await page.screenshot({ path: `${SHOT_DIR}/ux-t7-delete-connection.png` });
    await page.keyboard.press("Escape");

    // 表节点 → 删除表 → dry-run 预览 + 确认
    const users = workspace.getByTestId("database-navigator-node").filter({ hasText: "users" });
    await users.click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除表" }).click();
    const dropPreview = page.getByRole("alertdialog");
    await expect(dropPreview).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/ux-t7-drop-table-preview.png` });
    const dropText = await dropPreview.textContent();
    console.log("T7 删除表确认文案:", dropText?.trim());
    await dropPreview.getByRole("button", { name: /删除/ }).click();
    await expect
      .poll(() => page.evaluate(() => (window.__pgDropCalls ?? []).length))
      .toBeGreaterThanOrEqual(2);
    console.log("T7 删除表 confirmed drop 调用 OK");
  });

  test("T8 网格右键菜单 / 执行中态 / 空态四态视觉", async ({ page }) => {
    await installPgMock(page);
    const workspace = await openPostgresWorkspace(page);
    const editor = workspace.getByRole("main").locator(".cm-content");

    // 空态（未执行前）
    await page.screenshot({ path: `${SHOT_DIR}/ux-t8-empty-state.png` });

    // 执行成功 → 网格
    await typeSql(page, editor, "SELECT id, name FROM users ORDER BY id");
    await workspace.getByTestId("postgres-run").click();
    const grid = workspace.getByRole("main").locator("table tbody");
    await expect(grid).toContainText("Alice");
    await page.screenshot({ path: `${SHOT_DIR}/ux-t8-grid.png` });

    // 网格单元格右键菜单
    await grid.locator("td:has(button)").first().click({ button: "right" });
    const cellMenu = page.getByTestId("database-result-context-menu");
    await expect(cellMenu).toBeVisible();
    const cellTexts = await cellMenu.locator("[role='menuitem'], [role='menuitemcheckbox']").allTextContents();
    console.log("T8 网格单元格右键菜单项:", cellTexts.map((t) => t.trim()).join("|"));
    await page.screenshot({ path: `${SHOT_DIR}/ux-t8-cell-menu.png` });
    await page.keyboard.press("Escape");

    // 执行中态（mock 延迟 2500ms，截图 running 视觉）
    await typeSql(page, editor, "SELECT 1");
    await page.evaluate(() => { window.__delayExecuteMs = 2500; });
    await workspace.getByTestId("postgres-run").click();
    await expect(workspace.getByTestId("postgres-stop")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT_DIR}/ux-t8-running.png` });
    await expect
      .poll(() => page.evaluate(() => window.__pgExecuteCount ?? 0))
      .toBeGreaterThan(0);
  });
});
