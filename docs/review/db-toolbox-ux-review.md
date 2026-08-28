# NexTerm 数据库工具箱 UI/UX 界面复核报告

> 复核角色：ux-reviewer（独立于开发与视觉门禁）｜ 日期：2026-08-28
> 分支：`feat/db-toolbox-ux-enhancement`
> 复核依据：`docs/design/db-toolbox-ux-spec.md`（v0.2）、`docs/design/db-toolbox-product-spec.md`（v0.2）
> 复核对象：`src/components/toolbox/` 下 tool-postgres.tsx / tool-mysql.tsx / tool-sqlite.tsx / db-context-menus.tsx / database-result-error.tsx / query-history-view.tsx / database-result-pane.tsx / table-designer-tab.tsx
> 方法：运行时实测（Playwright mock Tauri invoke，中文 locale）+ 代码审查。走查脚本见 `docs/review/db-toolbox-ux-review.e2e.spec.ts`（临时复核产物，非门禁），证据截图见 `docs/review/screenshots/`。

---

## 一、复核清单

> 判定：✅ 符合预期 ｜ ⚠️ 轻微偏差 ｜ ❌ 未满足

### 1. 导航树右键菜单（spec §1.2.1 / §1.2.2 / §1.2.3 / §1.2.4）

| # | 复核项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 1.1 | 连接节点菜单三分组：连接状态 / 管理 / 危险（置底 destructive） | ✅ | 断开/新建查询/刷新 ｜ 连接管理器/编辑 ｜ 删除（分隔线+destructive） |
| 1.2 | 表/视图节点菜单：打开数据 / 设计表 / 生成 SQL▸ / 复制名称 / 生成 DDL / 刷新 / 新建查询 / 删除表 | ✅ | 项齐全；删除表 destructive 置底 + dry-run 确认（截图 `ux-t7-drop-table-preview.png`） |
| 1.3 | 物化视图「设计视图」恒置灰 + title 提示只读 | ✅ | `disabled title="物化视图为只读"` |
| 1.4 | 弹出位置不出视口 | ✅ | 实测 boundingBox 在视口内（`ux-t1-navigator-menu.png`） |
| 1.5 | 生成 SQL▸ 子菜单 hover 展开 | ✅ | hover 后子项可见（`ux-t1-generate-sql-submenu.png`） |
| 1.6 | 生成 SQL 内容：SELECT/INSERT 模板正确 | ✅ | `SELECT "id", "name" FROM "public"."users" LIMIT 100;`、`INSERT INTO ... ("id","name") VALUES ('','');` |
| 1.7 | 生成 UPDATE 模板含 WHERE 条件或占位 | ❌ | 实测 `UPDATE "public"."users" SET "id"='', "name"='';` **无 WHERE** → 见问题 P0-1 |
| 1.8 | 生成 DELETE 带「全表删除」内联提示 | ❌ | 实测 `DELETE FROM "public"."users";` 无注释 → 问题 P2-6 |
| 1.9 | 生成 SQL 子菜单图标对齐 | ⚠️ | SELECT/INSERT/UPDATE 无图标，DELETE 项带 Trash2，图标列跳动 → P2-7 |
| 1.10 | 「复制名称」统一为「复制限定名」 | ⚠️ | i18n 仍为「复制名称」→ P2-8 |
| 1.11 | 列节点「复制列定义」 | ⚠️ | 仅「复制列名」，spec §1.2.4 新增的「复制列定义」未实现（本轮范围可接受，记为 P2） |
| 1.12 | 加载子节点失败重试行内按钮 | ⚠️ | `errorLabel` 文案有，未见行内「重试」按钮 → 见问题 P2-9 |

### 2. 查询编辑器右键菜单（spec §1.2.5）

| # | 复核项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 2.1 | 三分组结构：编辑 / 执行与SQL / 保存与复用 | ✅ | 撤销重做剪切复制粘贴全选｜运行/运行选择/解释/格式化/注释｜保存到记事本(来源副文本)/保存 SQL |
| 2.2 | 快捷键标注齐全且右对齐 | ✅ | Ctrl+Z / Ctrl+Shift+Z / Ctrl+X / Ctrl+C / Ctrl+V / Ctrl+A / Ctrl+Enter / Ctrl+Shift+Enter / Ctrl+Shift+E / Ctrl+Shift+F / Ctrl+/ / Ctrl+S |
| 2.3 | 「保存 SQL Ctrl+S」实际生效 | ❌ | 实测 Ctrl+S 不保存 SQL（localStorage 0→0、无 toast）→ P1-2 |
| 2.4 | 运行/运行选择置灰 | ⚠️ | 运行按 `!connected || 无SQL` 置灰 ✓；运行选择仅 `!connected`，无选中时不置灰（点击会降级运行当前语句，可接受） |
| 2.5 | 剪切/复制无选中置灰 | ⚠️ | 未置灰（spec §1.1.4 要求），CodeMirror 上下文下影响有限，记为 P2 |
| 2.6 | 「保存到记事本」来源副文本 | ✅ | 当前语句 / 整个文档 / 所选内容（n 行） |

### 3. 数据网格右键菜单（spec §1.2.6 / §1.2.7 / §1.2.8）

| # | 复核项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 3.1 | 单元格菜单（查询结果）：复制单元格/复制行/复制列名/导出 | ✅ | 实测菜单项：复制单元格｜复制行｜复制列名｜导出 CSV｜导出 Excel（`ux-t8-cell-menu.png`） |
| 3.2 | 单元格菜单（table tab）：筛选/编辑组/设为 NULL・DEFAULT・空串・UUID・删除记录 | ✅ | 代码确认：筛选组仅 table tab，编辑组按 `canSetNull/isPrimaryKeyColumn` 置灰，删除记录 destructive+PK 置灰，导出兜底 |
| 3.3 | 列头菜单：筛选排序 / 冻结 / 列宽 / 最佳宽度 / 显示类型・注释（CheckboxItem） | ✅ | 代码确认；已用 `ContextMenuCheckboxItem`，无手写 "✓" |
| 3.4 | 行 gutter 菜单：添加记录 / 复制本行 / 设置行高 | ✅ | 代码确认 |
| 3.5 | insert 行菜单独立分组 | ✅ | 仅复制单元格/复制行/移除记录 |

### 4. 错误信息呈现（spec §2 / product-spec F2）

| # | 复核项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 4.1 | 执行失败 → 错误进结果面板（非仅 toast） | ✅ | `kind:"error"` 持久渲染，toast 只显示精炼 message（`ux-t3-error-card.png`） |
| 4.2 | 错误卡结构：标题 + LINE 徽标 + 错误码/消息 | ✅ | 实测标题行「执行失败」+「第 1 行」徽标 + mono 消息 |
| 4.3 | 服务端详情折叠（可滚动/可选中） | ✅ | Collapsible 展开显示完整原文（`ux-t3-error-details-open.png`） |
| 4.4 | 复制错误 = 完整原始文本 | ✅ | 实测剪贴板收到 `Error: PostgreSQL query failed: ... LINE 1: SELEC ... ^`（完整） |
| 4.5 | 定位到出错行：滚动+聚焦 | ✅ | 实测点击后光标落到出错行（SELEC 行）并聚焦编辑器（`ux-t3-goto-line.png`） |
| 4.6 | 定位高亮为 2s 临时高亮+波浪线 | ⚠️ | MVP 降级为光标+行内 active 高亮，无波浪线/2s 渐隐（spec §2.2.1）→ P2 |
| 4.7 | 重试按钮真实重跑 | ✅ | 实测点击后 invoke 计数 +1 |
| 4.8 | 错误码知识库 suggestion 行 | ✅ | 静态映射表（MySQL errno / PG SQLSTATE / SQLite 关键字），未知码不显示空行 |
| 4.9 | 错误卡标题「查询失败/解释失败」动词化 | ⚠️ | 实际为「执行失败」，与 spec §2.4 模板不一致 → P2-13 |
| 4.10 | L3 连接级错误横幅（常驻+重连） | ❌ | 未实现，断线仍走 toast（4s 消失）→ P2-10 |

### 5. 查询历史视图（spec §4.5 / product-spec F5）

| # | 复核项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 5.1 | 工具栏「历史」按钮切换视图（结果↔历史） | ✅ | 位置在保存到记事本后、停止前 ✓；点击切换 ✓ |
| 5.2 | 条目形态：状态点 / 时间(HH:mm:ss) / mono 摘要 truncate / 耗时 | ✅ | 实测（`ux-t4-history.png`） |
| 5.3 | hover 浮现「再次执行」 | ✅ | 实测 hover 后按钮可见（`ux-t4-history-hover.png`） |
| 5.4 | 右键菜单：再次执行/插入编辑器/复制/删除 | ✅ | 实测菜单项：再次执行｜插入编辑器｜复制｜删除 |
| 5.5 | 右键菜单含「清空本连接历史」 | ❌ | 缺该项（spec §1.2.12 / §4.5）→ P2-4 |
| 5.6 | 清空 AlertDialog 确认 | ✅ | 实测文案：「清空查询历史？这将删除此连接的所有查询历史，且无法撤销。」（`ux-t4-history-clear-dialog.png`） |
| 5.7 | 键盘 ↑/↓/Enter/Esc | ✅ | 列表内 ↑/↓/Enter 有效；Esc 关闭面板 |
| 5.8 | Esc 关闭面板的实现方式 | ⚠️ | window 级监听，关闭右键菜单的 Esc 也会误关面板 → P2-5 |
| 5.9 | 空态 | ⚠️ | Inbox 图标+「暂无查询历史」有；spec 要求的副文案「执行过的 SQL 会出现在这里」缺 → P2 |

### 6. 快捷键（spec §3 / product-spec F3）

| # | 复核项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 6.1 | Ctrl+Enter 执行 | ✅ | 实测执行失败路径正常触发错误卡 |
| 6.2 | F5 刷新导航树 | ✅ | 实测展开节点后 F5 触发 catalog 重新加载 |
| 6.3 | Ctrl+N 新建查询 | ✅ | 实测 tab +1 |
| 6.4 | Ctrl+W 关闭 tab（dirty 有确认） | ✅ | 实测关闭；dirty tab 走 AlertDialog（代码确认 requestCloseTab:2172-2179） |
| 6.5 | Ctrl+S 编辑器保存 SQL | ❌ | 实测无效（被 `database.data.saveChanges` 占位，query tab no-op）→ P1-2 |
| 6.6 | 表设计器 Ctrl+S 应用 / Escape 放弃 | ✅ | 实测 Ctrl+S 触发 apply；Escape 在焦点移出输入框后生效（`ux-t6-*.png`） |
| 6.7 | 表设计器输入框内 Escape | ⚠️ | 在列名输入框内按 Escape 无效（typingInField 保护）→ P2-14 |
| 6.8 | 输入框内快捷键误触（Ctrl+Enter 等） | ✅ | scope 路由 + typingInField 保护，查询/网格编辑场景未发现误触发 |
| 6.9 | 快捷键标注真实性（标注=实现） | ⚠️ | 唯一失效项为「保存 SQL Ctrl+S」→ P1-2 |

### 7. 生成 SQL 联动（spec §4.4 / product-spec F4）

| # | 复核项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 7.1 | 右键表 → 生成 SELECT 插入编辑器 | ✅ | 编辑器出现完整语句 |
| 7.2 | 插入后光标/选中反馈 | ❌ | 实测**整段语句处于选中态**（54 字符全选中），输入即整体替换；spec 要求「光标插入 + 2s 高亮渐隐」→ P1-3 |
| 7.3 | INSERT 模板含全部列名 | ✅ | 实测 `("id","name") VALUES ('','')` |
| 7.4 | UPDATE 模板带主键条件 | ❌ | 无主键发现、无 WHERE、无占位 → P0-1 |
| 7.5 | 无主键 UPDATE 走 `WHERE 1=1 -- TODO` 占位 | ❌ | 未实现 → P0-1 |

### 8. 危险操作确认

| # | 复核项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 8.1 | 删除连接 AlertDialog 文案讲清后果 | ✅ | 「删除连接？确定要删除连接「PG UX Fixture」吗？此操作无法撤销。」（`ux-t7-delete-connection.png`） |
| 8.2 | 删除表 dry-run 预览 + 确认 | ✅ | 预览 → AlertDialog 确认 → confirmed drop（`ux-t7-drop-table-preview.png`） |
| 8.3 | 危险组 destructive 红色置底 | ✅ | 导航树/编辑器/网格三处一致 |

### 9. 四态视觉（spec §4.2）

| # | 复核项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 9.1 | 执行中态：Loader2 + 停止按钮 | ✅ | 工具栏右侧 spinner + Stop 按钮（`ux-t8-running.png`） |
| 9.2 | 执行中网格遮罩（opacity-60 + 禁止交互） | ❌ | 未实现，旧结果仍可交互 → P2-11 |
| 9.3 | 成功 tabular：网格正常 | ✅ | `ux-t8-grid.png` |
| 9.4 | 空态：居中图标+文案 | ⚠️ | 仅左侧文本「就绪」，无 Inbox 图标、无右键 → P2-12 |
| 9.5 | 错误态 | ✅ | 见第 4 节 |

---

## 二、界面问题清单

### P0（高危，须修复后才能合入）

**P0-1｜生成 UPDATE SQL 无 WHERE 子句，可直接全表更新**
- 现象：导航树右键表 → 生成 SQL → UPDATE，产生 `UPDATE "public"."users" SET "id" = '', "name" = '';`（实测 T2）。无任何条件。用户生成后按 Ctrl+Enter 即**全表所有行被写空**。
- 复现路径：连接 PG → 右键 `users` 表 → 生成 SQL ▸ → 生成 UPDATE → 查看编辑器文本。
- 证据：截图 `ux-t2-generate-update.png`；代码 `src/components/toolbox/tool-postgres.tsx:1472-1474`（主键发现被注释为 deferred、传空数组）+ `src/lib/database/sql-generation.ts:85-87`（`primaryKeyColumns.length > 0 ? WHERE : ""`）。
- 依据：product-spec F4 裁定「无主键则生成 `WHERE 1=1 -- 请补充条件` 占位」；ux-spec §1.2.2 要求 `UPDATE ... WHERE pk = …` 模板。
- 建议：立即在 `generateUpdateSql` 无主键分支补 ` WHERE 1=1 -- TODO: 补充更新条件`（或隐藏 UPDATE 菜单项并给出原因）；主键发现（`postgres_catalog_objects` columns 已带 primaryKey 信息，可复用）补上后用 `WHERE "pk" = <id>` 占位。

### P1（体验阻断，建议本轮修复）

**P1-2｜编辑器菜单标注「保存 SQL Ctrl+S」，但 Ctrl+S 实际不保存**
- 现象：查询编辑器按 Ctrl+S 无任何反应（实测：localStorage 无写入、无 toast）；菜单标注却在误导用户。绑定 `Ctrl+S` 仅存在于 `database.data.saveChanges`（DATA_GRID scope）与 `database.design.save`（DESIGNER），`database.query.save` 无任何 combo；编辑器内 Ctrl+S 经 scope 路由命中 `data.saveChanges`，而 PG handler 对 query tab 为 no-op（tool-postgres.tsx:2416-2418）。
- 复现路径：打开查询 tab → 输入 SQL → 按 Ctrl+S。
- 证据：截图 `ux-t5-ctrl-s.png`；`src/lib/keyboard/bindings.ts:27-30`。
- 建议：给 `database.query.save` 注册 `Ctrl+S` 绑定（QUERY_EDITOR scope，优先级高于 DATA_GRID 的 data.saveChanges），handler 挂 `saveCurrentSql`；或移除菜单上的 Ctrl+S 标注。

**P1-3｜生成 SQL 后整段语句处于选中态，输入即整体替换**
- 现象：右键生成 SELECT/INSERT/UPDATE 插入编辑器后，整条语句被选中（实测原生 selection 长度 = 生成的语句长度 54），而不是 spec 要求的「光标插入语句首字符 + 语句 2s 高亮渐隐」。用户想微调（改列名、去 LIMIT）时，输入任意字符都会替换整个语句——高危误操作源。
- 复现路径：右键表 → 生成 SQL → SELECT → 直接在编辑器输入字符。
- 证据：截图 `ux-t1-select-inserted.png`；代码 `tool-postgres.tsx:1427-1430`（`selection: { anchor: insertAt, head: insertAt + len }`）。
- 建议：改为 `selection: { anchor: 语句末尾, head: 语句末尾 }`（光标落位）+ `flashEditorRange(view, from, to)` 临时高亮 2s 渐隐（ux-spec §4.4 契约，spec A10 落地清单）。

### P2（体验打磨，可下轮）

| # | 问题 | 现象 / 复现 | 证据 | 建议 |
|---|---|---|---|---|
| P2-4 | 历史视图右键菜单缺「清空本连接历史」 | 历史条目右键只有 再次执行/插入编辑器/复制/删除，清空只能走 header 按钮；spec §1.2.12 / §4.5 要求右键含清空 | `ux-t4-history-context-menu.png`；`query-history-view.tsx:280-311` | 右键菜单尾部加 destructive「清空本连接历史」（复用现有 AlertDialog） |
| P2-5 | 历史面板 Esc 为 window 级监听，关闭右键菜单会误关整个面板 | 在历史面板中右键打开菜单，按 Esc 关闭菜单的同时面板也被关闭 | `query-history-view.tsx:120-128`（window keydown） | 监听改为列表容器内（`onKeyDown` 已有），移除 window 级 Esc |
| P2-6 | 生成 DELETE SQL 无「全表删除」内联提示，且子菜单项标 destructive 红色易被误读为"执行删除" | 生成内容为 `DELETE FROM "public"."users";`，无 `-- 全表删除` 注释 | `ux-t2-generate-delete.png`；`tool-postgres.tsx:1478-1479` | 补 `-- 全表删除` 内联注释；子菜单内 DELETE 改回普通样式（危险提示靠注释而非红字），或将 DELETE 从生成子菜单移到危险组 |
| P2-7 | 生成 SQL 子菜单图标列不对齐 | SELECT/INSERT/UPDATE 无图标，DELETE 带 Trash2 | `ux-t1-generate-sql-submenu.png`；`tool-postgres.tsx:2779-2811` | 子菜单项统一无图标，或 DELETE 移出子菜单 |
| P2-8 | 「复制名称」未统一为「复制限定名」 | i18n `copyName=复制名称`，与「复制列名」并存易混淆 | zh-CN.json | 文案改为「复制限定名」（spec §1.3） |
| P2-9 | 导航树加载失败无行内「重试」按钮 | 仅 `errorLabel` 红字提示 | `tool-postgres.tsx:2632`；spec §4.1 | errorLabel 旁补 `text-[11px] text-primary` 重试按钮 |
| P2-10 | L3 连接级错误横幅未实现 | 断线/连接失败仍走 4s toast，无常驻横幅与重连按钮 | 代码无 banner；spec §2.2.3 | 按 spec A8 落地（toolbar 下方 h-9 横幅 + 重新连接） |
| P2-11 | 执行中态无网格遮罩 | running 时旧结果无 `opacity-60 pointer-events-none`，可继续双击编辑 | `ux-t8-running.png`；spec §4.2 | result-pane 顶部叠遮罩或 disabled 传递 |
| P2-12 | 结果面板空态无图标/无右键菜单 | 空态仅文本「就绪」，spec §1.2.9 要求居中 Inbox 图标 + 复制消息/清空结果右键 | `ux-t8-empty-state.png`；`database-result-pane.tsx:820-822` | 升级空态容器 + 挂右键菜单 |
| P2-13 | 错误卡标题「执行失败」与 spec 动词化模板不一致 | spec §2.4 要求「查询失败/解释失败」；实现统一「执行失败」（且错误码行格式为 `CODE: message` 时标题与消息重复表意） | `ux-t3-error-card.png`；i18n `errorPane.error` | 按动作区分标题（查询失败/解释失败/浏览失败） |
| P2-14 | 表设计器输入框内按 Escape 不放弃 | 列名输入框内按 Escape 无效（typingInField 保护），需先移出焦点 | `table-designer-tab.tsx:82-97` | 输入框内 Escape 先退出输入/取消编辑，再按才 revert（两级语义） |
| P2-15 | i18n 文案质量：`result="结果 1"` 异常 | 结果面板 header 显示「结果 1」（en 为 "Result 1"），用户困惑"1 指什么" | i18n `toolbox.postgres.result` | 改为「结果」；顺带统一「无法加载对象。请刷新后重试。」全角句号、「过滤/筛选」「最佳适配/最佳宽度」术语 |

---

## 三、复核结论

**总体判定：核心链路质量高，但存在 1 个高危安全型 UX 缺陷，不建议在当前状态直接合入。**

- ✅ **已达标的主体验链路**：导航树/编辑器/网格三处右键菜单结构完整（三分组、危险置底、快捷键标注、CheckboxItem 组件化）；错误卡（L2）三级呈现的"进面板+可复制+可重试+可定位"闭环真实可用（复制内容完整、重试真重跑、定位滚动到出错行）；历史视图（列表/hover 再次执行/右键/清空确认/Esc）完整；快捷键路由（Ctrl+Enter、F5、Ctrl+N、Ctrl+W、设计器 Ctrl+S/Escape）实测生效且输入框防误触；危险操作（删除连接/删除表）确认文案讲清后果。
- ❌ **必须修复后合入**：P0-1 生成 UPDATE 无 WHERE（全表更新风险）。
- ⚠️ **建议本轮修复**：P1-2 Ctrl+S 保存 SQL 标注失效（菜单标注欺骗）；P1-3 生成 SQL 后整段选中（微调即替换整句）。
- 其余为 P2 打磨项（14 条），不阻塞合入但建议排期。

**对视觉门禁的补充意见**：视觉门禁主要查 token/间距合规，本复核补充发现的是"标注与实现不符"（Ctrl+S）、"生成物语义危险"（UPDATE/DELETE）、"选中态代替高亮"这类**使用风险与误导**类问题，建议在门禁 checklist 中增加"快捷键标注真实性抽查"与"生成 SQL 危险度走查"两项。
