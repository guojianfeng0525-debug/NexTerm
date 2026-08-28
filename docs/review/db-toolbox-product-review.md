# DB 工具箱迭代 — 产品复核报告（Product Review）

> 复核人：product-reviewer ｜ 日期：2026-08-28 ｜ 分支：`feat/db-toolbox-ux-enhancement`
> 复核依据：`docs/design/db-toolbox-product-spec.md`（v0.2）AC-F1.1~F5.6、§3 联动地图 L1-L8、§4 用户旅程、§5 门禁度量
> 对照实现：`docs/design/db-toolbox-feature-design.md` + 当前分支源码 + 测试用例（独立复核，不盲信 dev/GATE 自述）
> 方法：静态证据为主（文件:行号），关键行为已跑单测独立验证（87 个相关测试全绿）。

---

## 0. 复核结论

**结论：有条件通过（Conditional PASS）**

- **F2（错误工程化）、F3（PG 快捷键收敛）、F5（查询历史）核心链路满足**，证据充分（实现 + 单测 + PG e2e）。
- **F1（MySQL/SQLite 三件套）与 F4（生成 SQL）存在规格打折**，共 3 条 P1：
  - P1-1 PG 生成 UPDATE 模板**无 WHERE 子句**（违反 AC-F4.3/4.4，且有"误执行即全表更新"风险）；
  - P1-2 MySQL/SQLite 快捷键大面积缺失（Ctrl+Shift+F/Ctrl+//Ctrl+W 等被 hook 静默吞掉），且右键菜单却标注这些快捷键，形成误导（违反 AC-F1.2）；
  - P1-3 MySQL/SQLite 生成 SQL 仅 SELECT，INSERT/UPDATE 未实现（违反 AC-F4.5）。
- 附注：MySQL/SQLite 导航入口在当前 main/branch 均被隐藏（`toolbox-nav.tsx:53` 仅 postgres），F1/F4 的 MySQL/SQLite 相关 AC **当前无法从 UI 端到端验证**，e2e 1 项按预期 skip。

---

## 1. AC 复核矩阵

图例：✅ 满足 ｜ ⚠️ 部分满足（注明差距）｜ ❌ 不满足 ｜ ➖ 不适用/无法验证

### 特性 F1：MySQL / SQLite 三件套补齐（P0）

| AC | 判定 | 证据 | 备注 |
|---|---|---|---|
| F1.1-1 导航树表节点右键（打开数据/复制名称/生成 DDL/生成 SQL 子菜单/刷新/Drop 带确认） | ⚠️ | `db-context-menus.tsx:95-180`（NavigatorRelationMenu）；`tool-mysql.tsx:719-730`、`tool-sqlite.tsx:463-470` | 有 openData/copyName/生成SQL(SELECT 可用，INSERT/UPDATE/DELETE 置灰)/refresh/newQuery。**缺"生成 DDL"与"Drop（带确认）"** |
| F1.1-2 编辑器右键（运行/运行选择/格式化/注释/保存到记事本/复制） | ✅ | `db-context-menus.tsx:313-407`；`tool-mysql.tsx:807-823`、`tool-sqlite.tsx:481`（QueryEditorMenu） | undo/redo/cut/copy/paste/selectAll/run/runSelection/format/comment 齐全；saveToNotes 属 L7 延后（规格注明） |
| F1.1-3 结果网格单元格右键（复制单元格/行/列名/按字段值筛选/自定义筛选/设 NULL/空串/UUID/删除记录/导出 CSV/Excel，能力按 provider 裁定） | ⚠️ | `tool-mysql.tsx:867-889`、`tool-sqlite.tsx:481`（ResultCellMenu，`db-context-menus.tsx:205-276`） | 只有复制×3 + 导出×2（+insert 行 remove）。**缺"按字段值筛选/自定义筛选"**；编辑类项因 MySQL/SQLite 无表编辑能力可裁定隐藏，但筛选类缺失 |
| F1.1-4 列头右键（筛选排序/冻结/列宽/最佳宽度/显示字段类型） | ❌ | `database-result-pane.tsx` 无列头菜单；`renderColumnContextMenu` 仅 PG table tab 提供（`tool-postgres.tsx:3349-3373`） | MySQL/SQLite 无列头菜单。可辩称其无表浏览 tab（结果集只读），但规格未如此表述 |
| F1.1-5 Tab 右键（关闭/关闭其他） | ✅ | `tool-mysql.tsx:743-758`、`tool-sqlite.tsx:476-478` | |
| F1.1-6 SQLite readOnly 不出现写入类菜单项 | ✅ | 三处菜单均无写项（`db-context-menus.tsx`） | SQLite 菜单本无 Drop/编辑/删除项，trivially 满足 |
| F1.2-1 MySQL/SQLite Ctrl+Enter 执行（含选中语句） | ✅ | `bindings.ts:47-52`（Ctrl+Enter）；hook `use-database-keyboard-shortcuts.ts:146-227`；`tool-mysql.tsx:350-357`、`tool-sqlite.tsx:434-441` | runSelectionOrStatement 逻辑存在（`tool-mysql.tsx:467-479`） |
| F1.2-2 Ctrl+Shift+F 格式化 / Ctrl+/ 注释生效 | ❌ | MySQL/SQLite handlers 仅 execute+newQuery（`tool-mysql.tsx:354-355`、`tool-sqlite.tsx:438-439`）；hook 对缺 handler 命令静默消费（`use-database-keyboard-shortcuts.ts:221`） | 组合键被消费（preventDefault）但无执行。**右键菜单却标注 Ctrl+Shift+F/Ctrl+/（`db-context-menus.tsx:381,390`），属误导** |
| F1.2-3 Ctrl+N 新建 / Ctrl+W 关闭 Tab | ⚠️ | Ctrl+N 已接（`tool-mysql.tsx:355`）；Ctrl+W 无 `database.tab.close` handler | Ctrl+W 被消费无效，Tab 无法用快捷键关闭 |
| F1.2-4 网格 Ctrl+R 筛选 / Escape 清筛选（若 provider 支持） | ⚠️ | MySQL/SQLite 无 `database.data.filterSort/clearFilter` handler | 被消费无效；"若支持"可辩称 MySQL/SQLite 结果集不提供筛选，但 Escape 在网格被吞无副作用出口 |
| F1.2-5 编辑器内 Ctrl+Enter 不触发默认换行（preventDefault） | ✅ | hook `preventDefault`+`stopPropagation`；键盘 hook 单测 29 个全绿；e2e `db-toolbox-ux.e2e.spec.ts:156-194` | |
| F1.3-1 MySQL/SQLite 错误进结果面板（非仅 toast） | ✅ | `tool-mysql.tsx:325-329`、`tool-sqlite.tsx:225-229`；`database-result-pane.tsx:554-559` | |
| F1.3-2 复制完整错误文本 | ✅ | `onCopy → copyText(error.fullText)`（`tool-mysql.tsx:902` 等） | |
| F1.3-3 重试 | ✅ | `onRetry={() => void execute()}`（`tool-mysql.tsx:901` 等） | |
| F1.3-4 错误码解释/未知码显示原文 | ✅ | `database-result-error.tsx:59-94`（MySQL 1045/1049/1064/1146/2003/2059+1130/1366、PG SQLSTATE、SQLite 关键字） | |

### 特性 F2：错误信息工程化（P0）

| AC | 判定 | 证据 | 备注 |
|---|---|---|---|
| F2.1-1 错误态显示跳转入口 + 可见行号 | ✅ | `tool-postgres.tsx:3441-3453`（onGoToLine 条件渲染）；`database-result-error.tsx:121-125`（LINE 徽标） | ⚠️ 徽标显示的是**相对 LINE n**（`error.lineNumber`），选中片段执行时与跳转目标绝对行不一致（P2-2） |
| F2.1-2 SQL 已修改 → 尽力定位 + 提示行号可能偏移 | ⚠️ | `editor-error-reveal.ts:33-41`（clamp 到文档范围，降级不崩溃 ✓） | **无"行号可能已偏移"提示**（P2-3） |
| F2.1-3 无 position 错误不显示跳转入口 | ✅ | `tool-postgres.tsx:3442`（`error.lineNumber != null` 才传）；MySQL/SQLite 无 LINE 自然不显示 | |
| F2.2-1 复制 rawMessage（完整文本含错误码） | ✅ | `onCopy → copyText(error.fullText)`（`tool-postgres.tsx:3440`）；`parsers/*` 均保留 fullText | |
| F2.2-2 长错误可滚动/可全选不被截断 | ✅ | `database-result-error.tsx:156-161`（`max-h-40 overflow-auto whitespace-pre-wrap` + `select-text`） | |
| F2.3-1 retryable 重试 → 重新执行 + 覆盖错误态 | ✅ | `tool-postgres.tsx:3432-3439`（query→runSql / table→browse）；e2e 验证 retry 再执行 | |
| F2.3-2 语法错误（retryable:false）→ 重试入口隐藏或禁用 | ❌ | `ParsedDatabaseError` 无 retryable 字段（`database-error.ts:17-32`）；onRetry 恒传，按钮恒可用 | 语法错误重试会重复失败，无害但违反规格（P2-1） |
| F2.3-3 重试执行中 running 态 + Ctrl+T 停止（PG） | ✅ | `runSql` setRunning(true)；`database.query.stop` handler（`tool-postgres.tsx:2369-2372`）→ `stopQuery`（postgres_cancel） | MySQL/SQLite 无停止，规格明示本迭代不引入 |
| F2.4-1 切 Tab 错误保留 | ✅ | error result 存 tab state（`patchTab({result: databaseErrorResult(...)})`），`tool-postgres.tsx:1381-1385` | |
| F2.4-2 知识库 suggestion | ✅ | `database-result-error.tsx:59-94`，覆盖规格要求的全部初始错误码 | |
| F2.4-3 未知码只显示原始消息 | ✅ | `suggestionFor` 未命中返回 null，不渲染引导行 | |
| F2.4-4 MySQL/SQLite 同一 error 管道 | ✅ | `parseProviderError`（`database-error.ts:44-48`）+ `databaseErrorResult` + `renderError` 三端一致 | |

### 特性 F3：scope-router 快捷键机制（P0）

| AC | 判定 | 证据 | 备注 |
|---|---|---|---|
| F3.1 任意 combo 按 scope 执行 | ⚠️ | hook 完整（`use-database-keyboard-shortcuts.ts:146-227`）；**PG 全 handler**（`tool-postgres.tsx:2348-2428`） | **MySQL/SQLite 仅 execute/newQuery**，F5/Ctrl+R/Ctrl+W 等被消费但无 handler（静默），未达"任一 provider"字面 |
| F3.2 xterm 终端内不拦截 | ✅ | hook 归属判定 `closest([data-testid="${testId}"])`（`use-database-keyboard-shortcuts.ts:171-173`）；DB workspace 内无终端；全局 hook 亦有 `isDbWorkspaceTarget` 放行（`keyboard-shortcuts.ts:262-274`） | |
| F3.3 DIALOG 打开时对话框优先 | ✅ | hook `dialogOpen` 早退（`use-database-keyboard-shortcuts.ts:167`）；PG 枚举全部对话框（`tool-postgres.tsx:2336-2347`） | |
| F3.4 PG 接入前后行为一致（回归清单） | ⚠️ | Insert/Ctrl+F/F3/Esc find/Ctrl+N/Ctrl+Enter/Ctrl+Shift+E/Ctrl+T/Ctrl+//Ctrl+Shift+F/Ctrl+E/Ctrl+W/Ctrl+S/Ctrl+R 均保留 | **Ctrl+Shift+R 语义漂移**：有选区时由"运行当前语句"变为"运行选区"（`tool-postgres.tsx:2352-2357` 注释自述为超集；`runCurrentStatement` 已删除）→ 需产品确认（P2-7） |
| F3.5 表设计器 Ctrl+S 保存 / Escape 放弃 | ✅ | `table-designer-tab.tsx:82-100`（useDesignerShortcuts）、`:262` | |
| F3.6 scope-router.test 及相关测试全绿 | ✅ | 独立复跑 87 个相关测试全绿 | |

### 特性 F4：导航树右键生成 SQL（P1）

| AC | 判定 | 证据 | 备注 |
|---|---|---|---|
| F4.1 SELECT 生成 + 插入当前 Tab 光标处 + 语句高亮 2s | ⚠️ | `tool-postgres.tsx:1418-1447`（insertGeneratedSql）；e2e `db-toolbox-ux.e2e.spec.ts:137-154` | **无 `flashEditorRange`（2s 渐隐）**，`code-editor.tsx` 全文无此 API；实现改为"插入文本全选"（feature-design §4.2 设计如此，但与产品规格视觉契约不一致）（P2-4） |
| F4.2 INSERT 含全部列名（与表元数据一致） | ✅ | `tool-postgres.tsx:1469-1470`；`loadRelationColumns`（`tool-postgres.tsx:1389-1410`）→ `postgres_catalog_objects` kind:columns | 占位符用 `''` 而非规格字面 `?`——`?` 非可执行 SQL，`''` 反而满足 AC-F4.7"可直接运行"，判为合理偏差 |
| F4.3 表有主键 → UPDATE WHERE 主键列 | ❌ | **`tool-postgres.tsx:1474` 恒传空主键数组 `[]`**（注释明示 primary-key discovery deferred）→ 生成无 WHERE 的 UPDATE | 违反 AC-F4.3（P1-1） |
| F4.4 表无主键 → `WHERE 1=1 -- TODO` 占位 | ❌ | `sql-generation.ts:85-88` 无主键时 `whereClause = ""`；测试**显式断言省略 WHERE**（`sql-generation.test.ts:130-134`） | 违反 AC-F4.4（P1-1） |
| F4.5 MySQL/SQLite SELECT/INSERT/UPDATE 与 PG 一致 | ❌ | `tool-mysql.tsx:723`、`tool-sqlite.tsx:466` 仅传 generateSelect；INSERT/UPDATE 菜单项置灰（`db-context-menus.tsx:133-146`） | feature-design §4.1 允许退化，但产品规格 AC 未许可（P1-3） |
| F4.6 列元数据加载失败 → SELECT 可用 + INSERT/UPDATE 隐藏 + 原因提示 | ⚠️ | PG `loadRelationColumns` catch→[] → `generateRelationSql` 降级为 SELECT *（`tool-postgres.tsx:1465-1468`） | 降级是**静默**的：INSERT/UPDATE 仍可点击、点后得到 SELECT 模板，无原因提示；MySQL/SQLite 置灰但无原因（P2-6） |
| F4.7 生成 SQL 可直接运行 | ⚠️ | SELECT/INSERT 可执行；UPDATE 无 WHERE 可执行但危险；库内带主键模板 `WHERE "id" = <id>` 为**非法 SQL**（仅测试覆盖，UI 未产出该形式） | 与 P1-1 同源 |

### 特性 F5：DB 域查询历史贯穿（P1）

| AC | 判定 | 证据 | 备注 |
|---|---|---|---|
| F5.1 成功 SQL 记录 + 成功徽标 | ✅ | `addQueryHistory` 成功分支三端接入（`tool-postgres.tsx:1350-1356,1052-1058`、`tool-mysql.tsx:317-323`、`tool-sqlite.tsx:217-223`）；测试断言 success:true | |
| F5.2 失败 SQL 记录 + 错误徽标 | ✅ | 失败分支（`tool-postgres.tsx:1367-1373` 等）；`query-history-view.tsx:249-253` 红点 + error tooltip | |
| F5.3 右键再次执行 + 新记录追加 | ✅ | `nexterm:db-query-history-execute` → `onHistoryExecute`（`tool-postgres.tsx:1483-1491`）→ runSql → 再次 addQueryHistory；e2e `db-toolbox-ux.e2e.spec.ts:223-250` | 连接归属校验 `detail.connectionId !== tab.connectionId` 拦截跨连接（P1 语义正确） |
| F5.4 插入编辑器 | ✅ | `nexterm:db-query-history-insert` → `insertGeneratedSql`（`tool-postgres.tsx:1492-1498`） | 无 Tab 自动新建 |
| F5.5 删除单条 / 清空（确认） | ✅ | `removeQueryHistory`/`clearQueryHistory`（`query-history-view.tsx:281-311,176-179,318-337`）+ AlertDialog | |
| F5.6 重启持久（localStorage） | ✅ | `query-history.ts:38-48`；测试覆盖 localStorage 读写 | ⚠️ 存储按 **providerId** 隔离（`nexterm.dbQueryHistory.<providerId>`），产品规格裁定"按 connectionId 隔离"；**UI 层已按 connectionId 过滤**（`query-history-view.tsx:130-136`），显示行为符合 AC，存储层与规格不一致（P2-5） |

---

## 2. 联动地图 L1-L8 复核

| 链路 | 规格状态 | 复核判定 | 证据 |
|---|---|---|---|
| L1 导航树→生成SQL→编辑器 | ✅ MVP | ⚠️ 高亮契约打折 | 插入+选中 ✓（`tool-postgres.tsx:1418-1447`）；`flashEditorRange` 2s 渐隐未实现 |
| L2 编辑器→执行→结果 | ✅ MVP | ✅ | error/tabular 均入结果面板；e2e 覆盖 |
| L3 错误→编辑器回跳 | ✅ MVP | ✅ | `revealEditorLine` + onGoToLine（PG）；MySQL/SQLite 无 LINE 无跳转（符合 F2.1-3） |
| L4 错误→重试→执行 | ✅ MVP | ✅ | onRetry 三端接入 |
| L5 执行→历史→再次执行 | ✅ MVP | ✅ | event bus + runSql + 追加记录 |
| L6 历史→编辑器 | ✅ MVP | ✅ | event bus + insertGeneratedSql |
| L7 编辑器↔记事本 | 🔄 已有(PG)+补齐(延后) | ✅ 按规格延后 | MySQL/SQLite QueryEditorMenu 未传 saveToNotes（规格明确"延后"） |
| L8 网格→复制/导出 | 🔄 已有(PG)+本轮补齐 | ✅ 已扩展 | MySQL/SQLite 网格菜单含 copy×3 + export CSV/Excel（`tool-mysql.tsx:877-886`） |

> 注：team-lead 提到的"L1-L15 / L12/L13"编号在 product-spec（L1-L8）与 ux-spec（L1-L3）中均不存在，疑为口径混淆；本报告按 product-spec §3 的 L1-L8 复核。

---

## 3. 用户旅程走查

### 场景 A（PG：写 SQL → Ctrl+Enter → 错误卡 → 跳行 → 修正 → 重试 → 历史）
| 步骤 | 落地 | 证据 |
|---|---|---|
| 2. Ctrl+Enter 执行 | ✅ | hook + e2e |
| 3. 错误进面板 + 精炼消息 + 错误码 + 引导 | ✅ | error card + suggestion |
| 4. 跳转到第 N 行 + 波浪线 + 临时高亮 | ⚠️ | 滚动+selection 跳行 ✓；**波浪线/临时高亮未实现**（feature-design §2.5 裁定用 highlightActiveLine 替代，与产品规格 §2.2.1 视觉契约不一致） |
| 5/6. 修正重跑 / 重试 | ✅ | |
| 7. 历史沉淀 + 插入编辑器 + 再次执行 | ✅ | |

### 场景 B（MySQL：生成 SQL → Ctrl+Enter → 网格筛选 → 导出 → 历史复用）
| 步骤 | 落地 | 证据 |
|---|---|---|
| 2. 右键生成 SELECT + 新 Tab + 插入 | ⚠️ | SELECT ✓；INSERT/UPDATE 缺失；无 2s 渐隐高亮 |
| 4. Ctrl+Enter | ✅ | |
| 5. 网格右键"按字段值筛选" | ❌ | 网格菜单无筛选项（`tool-mysql.tsx:867-889`） |
| 6. 导出 CSV | ✅ | |
| 7. 历史再次执行 | ✅ | |

---

## 4. 门禁度量核验（规格 §5）

| 指标 | 目标 | 复核判定 | 说明 |
|---|---|---|---|
| 右键可达高频操作覆盖率 | ≥80%；MySQL/SQLite 对齐 PG | ⚠️ 未证实达标 | MySQL/SQLite 菜单密度低于 PG（缺 DDL/Drop/列头菜单/网格筛选），估计 60-75%；且导航入口隐藏，无法运行时勾选 |
| 错误定位成功率（手工样例集 ≥20） | 100% | ⚠️ 证据不足 | 解析器+单测覆盖好（`database-error.test.ts` 10 例）；但无"≥20 条手工样例集"记录 |
| 错误可复制/可重试可用率 | 100% | ✅ | 三端实现 + 单测 + e2e |
| 错误进面板持久率 | 100% | ✅ | tab state 持久 |
| MySQL/SQLite 与 PG UX 落差收敛 | ≥90% 对齐 | ❌ 未达成 | F1.1（菜单项集合）、F1.2（快捷键集合）均未对齐 PG |
| scope-router 激活率 | 100%（18 绑定） | ⚠️ | PG 侧几乎所有命令有 handler；MySQL/SQLite 侧多个组合键"被消费无执行"，实际不生效 |
| 手写 keydown 收敛 | 全部收敛 | ✅ | `runCurrentStatement` 删除，仅保留 find-bar 局部监听（feature-design §1.2 注明不收敛） |
| 生成 SQL 成功率 | 100% | ⚠️ | SELECT/INSERT 可执行；UPDATE 无 WHERE（危险）或 `<id>`（非法），不符合 |
| 历史贯穿闭环 | 100% | ✅ | e2e 闭环验证 |
| 回归门禁 | 全绿 | ✅ | 992 tests / tsc 0 错误 / build 成功（release-review 记录 + 本次抽查） |

---

## 5. 问题清单

### P0（阻断）
无。

### P1（需修复或产品显式决策）

**P1-1｜PG 生成 UPDATE 模板无 WHERE 子句（AC-F4.3/F4.4 违反，全表更新风险）**
- 现象：右键表 → 生成 SQL → UPDATE，产出 `UPDATE "public"."users" SET "name" = '', ...;`，无任何 WHERE/占位。用户补 SET 值后直接执行即**全表更新**。
- 证据：`tool-postgres.tsx:1471-1474` 恒传 `[]` 主键（注释：primary-key discovery deferred）；`sql-generation.ts:85-88` 无主键省略 WHERE；`sql-generation.test.ts:130-134` 显式断言该行为。与产品规格 AC-F4.3（有主键→WHERE 主键列）、AC-F4.4（无主键→`WHERE 1=1 -- TODO` 占位）不符。
- 建议修复方向：① 接入主键发现（PG `postgres_catalog_objects` 已有列模型，补主键标记即可）；② 无主键时至少生成 `WHERE 1=1 -- TODO: 补充更新条件` 占位（与 AC-F4.4 一致）；③ 模板插入后以错误色/注释强调 WHERE 缺失。

**P1-2｜MySQL/SQLite 快捷键大面积缺失且被"静默吞键"，右键菜单标注造成误导（AC-F1.2-2/3/4）**
- 现象：Ctrl+Shift+F（格式化）、Ctrl+/（注释）、Ctrl+W（关闭 Tab）、网格 Ctrl+R/Escape 在 MySQL/SQLite 一律无效；组合键被 hook 消费（preventDefault）但无 handler，且**右键菜单用 ContextMenuShortcut 标注了这些快捷键**（用户按菜单提示按键却无反应）。
- 证据：`tool-mysql.tsx:350-357`、`tool-sqlite.tsx:434-441` handlers 仅 execute/newQuery；`use-database-keyboard-shortcuts.ts:220-221`（缺失 handler 静默消费）；`db-context-menus.tsx:326,363,381,390`（菜单标注 Ctrl+Z/Ctrl+Enter/Ctrl+Shift+F/Ctrl+/ 等）。
- 建议修复方向：① 为 MySQL/SQLite 注册 formatSql/toggleComment/tab.close 等 handler（函数已存在，`tool-mysql.tsx:481-512`）；② 或 hook 对"无 handler 的命令"不消费（放行给 CodeMirror/默认行为），消除吞键；③ 或菜单对未注册命令不标注快捷键。

**P1-3｜MySQL/SQLite 生成 SQL 仅 SELECT，INSERT/UPDATE 未实现（AC-F4.5）**
- 现象：MySQL/SQLite 导航树"生成 SQL"子菜单中 INSERT/UPDATE 置灰不可用，与 PG 行为不一致。
- 证据：`tool-mysql.tsx:719-730`、`tool-sqlite.tsx:463-470` 只传 `generateSelect`；`db-context-menus.tsx:133-146` 缺 action 置灰。feature-design §4.1 允许"无列元数据则退化"，但**产品规格 AC-F4.5 要求三库一致且未授权该退化**。
- 建议修复方向：① 新增 `mysql_catalog_columns`（information_schema.columns）/`sqlite_catalog_columns`（PRAGMA table_info）薄命令，接通 INSERT/UPDATE；② 或产品显式批准降级并在发布说明标注（规格变更）。

### P2（可放行，建议排期）

| # | 现象 / 证据 | 对应 AC | 建议修复方向 |
|---|---|---|---|
| P2-1 | 语法错误也显示可重试按钮（无 retryable 建模）`database-error.ts:17-32`、`database-result-error.tsx:167-179` | F2.3-2 | 解析时判定 retryable（连接断/超时 true、语法错 false），按钮 disable |
| P2-2 | 错误卡行号徽标显示相对 LINE n，选中片段执行时与跳转绝对行不一致 `database-result-error.tsx:121-125` | F2.1-1 | 错误卡显示换算后的绝对行号（或去掉徽标行号） |
| P2-3 | 行号偏移无提示：SQL 被改后跳转无"行号可能已偏移"提示 `editor-error-reveal.ts:33-41` | F2.1-2 | reveal 时比对文档长度/范围失效则 toast 提示 |
| P2-4 | L1 高亮契约打折：`flashEditorRange`（2s 渐隐）未实现，`code-editor.tsx` 无此 API；插入文本用 selection 替代 `tool-postgres.tsx:1426-1430` | F4.1 / L1 | 实现 flashEditorRange 或产品接受 selection 方案并更新规格 |
| P2-5 | 历史存储按 providerId 隔离而非规格的 connectionId 隔离 `query-history.ts:22-29`；UI 层已过滤（`query-history-view.tsx:130-136`） | F5.6（存储裁定） | 产品确认接受 or 迁移 key 结构 |
| P2-6 | 列元数据加载失败时降级静默：INSERT/UPDATE 仍可点且产出 SELECT，无原因提示 `tool-postgres.tsx:1465-1468` | F4.6 | 降级时禁用 INSERT/UPDATE 并给原因（toast 或菜单禁用+title） |
| P2-7 | PG Ctrl+Shift+R 语义漂移：有选区时由"运行当前语句"变"运行选区"（dev 自述行为超集）`tool-postgres.tsx:2352-2357` | F3.4 | 产品确认；若须保真，hook 需透传 combo 让 handler 分派 |
| P2-8 | 错误波浪线/临时高亮未实现（用 selection+highlightActiveLine 替代）feature-design §2.5 与产品规格 §2.2.1 视觉契约不一致 | 旅程 A 步骤 4 | 产品确认接受降级 or 补装饰扩展（§6.4 预留位） |
| P2-9 | MySQL/SQLite 菜单密度低于规格：无"生成 DDL"/Drop（导航树）、无"按字段值筛选"（网格）、无列头菜单 | F1.1-1/3/4 | 结果集筛选为通用能力建议补；DDL/Drop 登记 backlog |
| P2-10 | toast 无重试 action（feature-design §2.7 `showQueryErrorToast` 未实现，实际为 `toast.error(description: message)`） | 设计层 | 非产品 AC，可选 |
| P2-11 | MySQL/SQLite 导航入口被 main 隐藏（`toolbox-nav.tsx:53` 仅 postgres），F1/F4 相关 AC 无法运行时验证；e2e 1 项预期 skip | F1 整体 | 随导航入口恢复一并复验（release-review §3.2 同） |

---

## 6. 附：复核方法说明

- 独立复跑关键单测：`database-error` / `sql-generation` / `query-history` / `editor-error-reveal` / `use-database-keyboard-shortcuts` 共 87 个用例全绿（`pnpm vitest run`，1.17s）。
- 全部结论基于当前分支（`feat/db-toolbox-ux-enhancement`）源码与测试；未改动任何业务代码。
- 需运行时验证项：MySQL/SQLite 三件套（导航恢复后）、P1-2 的"菜单标注 vs 按键无效"（可在 hook 单测中加 handler 缺失断言）、P2-2 徽标行号差异（选中片段执行触发）。

*复核完成时间：2026-08-28。*
