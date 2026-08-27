# DB Toolbox UX — 视觉门禁（GATE）报告

> 版本：2.0 ｜ 审查人：visual-gate（GATE）｜ 日期：2026-08-28
> 依据：`docs/design/db-toolbox-ux-spec.md`（v0.2）§0 token 契约、§1 菜单形态、§2 错误三级呈现、§4.5 历史视图、§5 线框
> 范围：分支 `feat/db-toolbox-ux-enhancement` 的 DB 工具箱 UX 增强（右键菜单 / 错误工程化 / 快捷键 / 生成 SQL / 查询历史）

---

## 0. 结论

**GATE 结论：通过（PASS）**

- **v2.0 更新**：PG 主工具四组菜单的 GATE 遗留项已全部修复（提交见 §4.2），运行时复验 25 项全 PASS，e2e 集成套件 4 passed / 1 skipped（预期跳过）。
- 新增强化组件（错误卡、历史视图、共享菜单、生成 SQL 子菜单）满足视觉契约。
- 遗留未覆盖项仅 `table-designer` 右键菜单（spec A7，本迭代范围外，见 §5）。

---

## 1. 静态检查（对照 §0/§1/§2/§4.5）

### 1.1 token 契约（不得引入新色值）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| T1 | 新组件仅用 token 类名，无硬编码 hex / tailwind 调色板色值 | ✅ PASS | `db-context-menus.tsx`、`database-result-error.tsx`、`query-history-view.tsx` 全文件扫描无 `#[0-9a-f]{3,6}` 非 token 值；无 `bg-red-600`/`text-red-500` 等调色板类 |
| T2 | 错误卡 destructive 系 token（`border-destructive/30`/`bg-destructive/5`/`text-destructive`） | ✅ PASS | `database-result-error.tsx:112,117,122` |
| T3 | 状态点沿用 `statusDotClass` 色板（`bg-emerald-500`/`bg-red-500`） | ✅ PASS | `query-history-view.tsx:249`；spec §0 允许 |
| T4 | 遗留非 token 色（非本迭代引入） | ⚠️ NOTE | `table-designer-tab.tsx:439-440` warnings banner 用 `border-yellow-500/30` 等（旧代码）；不在本次增强点 |

### 1.2 菜单形态（§1.1）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| M1 | 分组用 `ContextMenuSeparator`（共享菜单 + PG 菜单） | ✅ PASS | `db-context-menus.tsx:147,159,258,300`；`query-history-view.tsx:300`；PG 连接/对象/编辑/网格菜单均含 Separator |
| M2 | 危险项 `variant="destructive"`（含 PG 删除/Drop/删除记录） | ✅ PASS | `db-context-menus.tsx:149,229,302`；`query-history-view.tsx:302`；PG：连接删除、Drop、删除记录、移除记录、生成 DELETE `tool-postgres.tsx` |
| M3 | 危险组置于菜单底部（带分隔线） | ✅ PASS | PG 连接节点删除项置底（运行时 lastVariant=destructive）、对象 Drop 置底、单元格删除记录 + 独立导出组分隔 |
| M4 | 勾选项用 `ContextMenuCheckboxItem`，无手写 `" ✓"` | ✅ PASS（已修复） | 修复前 `tool-postgres.tsx` 手写 `" ✓"`；修复后 `ContextMenuCheckboxItem`（提交 `5615361`）。运行时 `checkboxItems=2` |
| M5 | 快捷键标注用 `ContextMenuShortcut`/`DropdownMenuShortcut`，非自建 span | ✅ PASS | `db-context-menus.tsx` 各菜单项；PG 编辑器菜单 12 个 `ContextMenuShortcut`（运行时 found=12）、连接/对象/网格菜单同步补齐 |
| M6 | 菜单项图标 `h-3.5 w-3.5`，默认 `text-muted-foreground`（Radix 规则） | ✅ PASS | 共享组件 + PG 全部菜单项（运行时连接菜单 svg=6、关系菜单 svg=8） |
| M7 | 平台符号 `formatShortcut`（⌘/Ctrl） | ✅ PASS | `db-context-menus.tsx:51-63` 导出复用；e2e `toHaveText(/Ctrl\+Enter\|⌘Enter/)` |
| M8 | 禁用置灰（`disabled` 而非条件隐藏） | ✅ PASS | `db-context-menus.tsx:106,121,134,141,150`；`disabledExecute` 执行组 `db-context-menus.tsx:356-391` |
| M9 | 编辑器菜单补齐 EXPLAIN / 注释 / 保存 SQL 入口（spec §1.2.5 新增项） | ✅ PASS | `tool-postgres.tsx` 编辑器菜单：`postgres-editor-explain`（Ctrl+Shift+E）、`postgres-editor-toggle-comment`（Ctrl+/）、`postgres-editor-save-sql`（Ctrl+S） |
| M10 | 删除连接确认升级为 AlertDialog（spec §1.2.1） | ✅ PASS | `window.confirm` 移除；新增 `postgres-connection-delete-confirm` AlertDialog（`tool-postgres.tsx`）+ i18n keys |

### 1.3 错误卡（§2.2.2）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| E1 | 卡片容器 token：`m-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 shadow-soft-lg` | ✅ PASS | `database-result-error.tsx:112` |
| E2 | 标题 `text-[12px] font-medium text-foreground` + `CircleAlert size-4 text-destructive` | ✅ PASS | `database-result-error.tsx:116-119` |
| E3 | 错误码行 `font-mono text-[12px] text-foreground`，`CODE: message` | ✅ PASS | `database-result-error.tsx:129-131` |
| E4 | 引导行 suggestion：`text-muted-foreground` + `Lightbulb text-warning` | ✅ PASS（已修复） | 修复前整行 `text-warning`（spec 要求行 `text-muted-foreground`，图标 `text-warning`）；修复后 `database-result-error.tsx:135-138` |
| E5 | 详情 `Collapsible` 折叠 + `pre max-h-40 overflow-auto whitespace-pre-wrap font-mono text-muted-foreground` | ✅ PASS | `database-result-error.tsx:143-163`；运行时 `overflowY=auto` |
| E6 | 全卡 `select-text` | ✅ PASS | `database-result-error.tsx:112`；运行时 `userSelect=text` |
| E7 | 按钮行 `mt-2 flex gap-2` + `Button size=sm variant=outline h-6 rounded-sm px-2 text-[11px]` | ✅ PASS | `database-result-error.tsx:167-204` |
| E8 | `retryable=false` 时重试禁用；`editorLine` 空时定位按钮隐藏 | ✅ PASS | `onGoToLine` 条件渲染 `database-result-error.tsx:192-204`；`disabled={!onRetry}` |
| E9 | LINE 徽标用 destructive token | ✅ PASS | `database-result-error.tsx:122-124` |

### 1.4 历史视图（§4.5）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| H1 | 条目 `flex h-7 items-center gap-2 rounded-sm px-2 text-[12px]` | ✅ PASS | `query-history-view.tsx:242`；运行时 height=28px |
| H2 | 状态点 `size-2 rounded-full bg-emerald-500/bg-red-500` | ✅ PASS | `query-history-view.tsx:247-251`；运行时 dot 存在 |
| H3 | 时间 `w-16 text-right text-[10px] text-muted-foreground tabular-nums` | ✅ PASS | `query-history-view.tsx:253-258` |
| H4 | SQL 摘要 `flex-1 min-w-0 truncate font-mono`，96 字符截断 | ✅ PASS | `query-history-view.tsx:259-261,68-72` |
| H5 | hover 浮现唯一操作 `▶ 再次执行`（`opacity-0 group-hover:opacity-100`） | ✅ PASS | `query-history-view.tsx:262-275`；运行时 before=0 after=1 |
| H6 | 右键菜单：再次执行/插入编辑器/复制/删除本条(destructive) | ✅ PASS | `query-history-view.tsx:278-309`；运行时 items=4，destructive=1 |
| H7 | 清空历史 `AlertDialog` 确认 + `bg-destructive` | ✅ PASS | `query-history-view.tsx:316-335` |
| H8 | 空态 `h-24` 居中 + `Inbox` + 副文案 | ✅ PASS | `query-history-view.tsx:225-228` |
| H9 | 错误条目状态点 tooltip =「执行失败」 | ✅ PASS（已修复） | 修复前复用 `labels.run`；修复后 `labels.error`（提交 `5615361`，新增 6 个 i18n key，parity 通过） |
| H10 | 耗时 `(1.2s)`（可选）、搜索框（MVP 可选） | ⚠️ NOTE | spec 标注可选未实现，不阻断 |

### 1.5 布局与接入

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| L1 | 结果面板 error 分支（`kind:"error"` → `renderError`） | ✅ PASS | `database-result-pane.tsx:400-403,554-559`；三端接入 `tool-postgres.tsx:3307`、`tool-mysql.tsx:889`、`tool-sqlite.tsx` |
| L2 | 历史视图接入三端工具栏 + 面板切换 | ✅ PASS | `tool-postgres.tsx:3150-3175`、`tool-mysql.tsx:826-848`、`tool-sqlite.tsx:481` |
| L3 | 无横向溢出（document.scrollWidth ≤ clientWidth） | ✅ PASS | 运行时 scrollWidth=1280 = clientWidth |
| L4 | 关键容器（navigator/结果面板/工具栏）存在 | ✅ PASS | 运行时 aside 可见、结果表渲染 |

---

## 2. 运行时验证（Playwright，临时脚本 `tests/db-toolbox-ux.gate.e2e.spec.ts`）

Mock harness 同 `tests/db-toolbox-ux.e2e.spec.ts`（`__TAURI_INTERNALS__`），仅 PG 工作台可见（MySQL/SQLite 导航入口被 `fe1d1f2` 隐藏）。

| 断言 | 结果 |
|---|---|
| 菜单容器背景 = `--popover` | ✅ bg=rgb(30,41,59)=#1e293b |
| 菜单项 `py-1.5`（6px）+ text-sm，高 32px | ✅ pt=pb=6px |
| **PG 编辑器菜单含 `ContextMenuShortcut`** | ✅ **found=12**（v2.0 修复后；v1.0 为 0） |
| 编辑器菜单分组线 | ✅ separators=3 |
| 连接节点菜单带 lucide 图标 | ✅ svg=6 |
| 连接节点菜单 destructive 删除项置底 | ✅ destructive=1，lastVariant=destructive |
| 关系节点菜单带 lucide 图标 | ✅ svg=8 |
| 关系节点菜单 Drop destructive 置底 | ✅ lastVariant=destructive |
| 错误卡 `border-destructive/30`/`bg-destructive/5` | ✅ |
| 错误卡 `select-text` | ✅ |
| 错误标题 `text-foreground` | ✅ |
| 错误码 `font-mono` | ✅ |
| LINE 徽标 `bg-destructive/10` + mono | ✅ |
| 详情折叠 `font-mono` + `text-muted-foreground` + 可滚动 | ✅ |
| 重试/复制/定位三按钮存在 | ✅ |
| 历史条目 h-7（28px） | ✅ |
| 历史状态点（emerald/red） | ✅ |
| hover 浮现再次执行（opacity 0→1） | ✅ |
| 历史右键菜单 4 项 + 1 destructive | ✅ |
| 列头菜单用 CheckboxItem（无手写 ✓） | ✅ checkboxItems=2 |
| 无横向溢出 | ✅ |
| 结果面板渲染 | ✅ |

**运行时统计（v2.0）：25 PASS / 0 FAIL**。e2e 集成套件 `db-toolbox-ux.e2e.spec.ts`：4 passed / 1 skipped（预期跳过）。

---

## 3. FAIL 清单（v2.0 全部关闭）

v1.0 的 F1–F4 已随本次修复关闭（见 §4.2）。剩余非阻断项：

| # | 位置 | 说明 | 状态 |
|---|---|---|---|
| F5 | `tool-mysql.tsx` / `tool-sqlite.tsx` 连接节点菜单 | 无快捷键标注（新建查询 Ctrl+N/刷新 F5） | ⚠️ 轻微，MySQL/SQLite 导航入口当前被隐藏，建议后续随导航恢复一并补齐 |
| F6 | `table-designer-tab.tsx` | 列行/约束行右键菜单未实现（spec A7）；warnings banner 用 `yellow-500` 非 token 色（旧代码） | ⚠️ 范围外（本迭代仅做快捷键），建议 backlog 登记 |

> 说明：PG 主工具菜单本次**未迁移共享组件**（按 team-lead 指示保留 PG 专属结构），改为就地补齐图标/快捷键/危险项/AlertDialog，视觉契约已满足。

---

## 4. 已修复项

### 4.1 提交 `5615361`（v1.0 轻微偏差）

| 项 | 修改 | 提交 |
|---|---|---|
| 列头菜单手写 `" ✓"` | `ContextMenuItem` + conditional `" ✓"` → `ContextMenuCheckboxItem`（`checked` + `onSelect`） | `tool-postgres.tsx:3270-3279` |
| 错误卡 suggestion 行色 | 整行 `text-warning` → `text-muted-foreground`（Lightbulb 保持 `text-warning`，对齐 §2.2.2） | `database-result-error.tsx:135-138` |
| 历史失败条目 tooltip | `labels.run` → `labels.error`（「执行失败」）；新增 `toolbox.<provider>.history.error` / `historyError` 共 6 个 i18n key（zh/en parity 通过） | `query-history-view.tsx` + 三端 + locales |

### 4.2 提交（v2.0，PG 四组菜单 GATE 修复）

| 项 | 修改 | 证据 |
|---|---|---|
| 编辑器菜单快捷键标注 | 12 项补 `ContextMenuShortcut`（撤销/重做/剪切/复制/粘贴/全选/运行/运行选择/EXPLAIN/格式化/注释/保存 SQL），均来自 §3.1 真实绑定；「复制」移入编辑组 | 运行时 found=12 |
| 编辑器菜单补齐 EXPLAIN/注释/保存 SQL 入口 | 新增 `postgres-editor-explain`（Ctrl+Shift+E）、`postgres-editor-toggle-comment`（Ctrl+/）、`postgres-editor-save-sql`（Ctrl+S） | spec §1.2.5 新增项 |
| 连接节点菜单 | 补图标（Unplug/FilePlus2/RefreshCw/Server/Pencil/Trash2）+ Ctrl+N/F5 标注；删除 `window.confirm` → AlertDialog（`postgres-connection-delete-confirm`）| 运行时 svg=6，destructive 置底 |
| 对象菜单 | 补图标（Table2/PencilRuler/Braces/Eye/Copy/FileCode/RefreshCw/FilePlus2/Table2/Trash2）+ Enter/F5/Ctrl+N 标注；Drop 加 `variant="destructive"` 置底 | 运行时 svg=8，lastVariant=destructive |
| 单元格/列头/行 gutter 菜单 | 补图标；删除记录/移除记录 `variant="destructive"`；删除记录 Ctrl+Delete、筛选 Ctrl+R、添加记录 Insert 标注；行 gutter 补「添加记录」；导出独立分组 | — |
| 共享 `formatShortcut` 导出 | `db-context-menus.tsx` 导出供 PG 复用（单一来源） | — |
| 新增 i18n keys | `toggleComment`、`deleteConnectionConfirmTitle/Description`、`setDefault`（并发引入项补全），zh/en parity 通过（2184 keys） | — |

验证：`tsc --noEmit` 通过；toolbox 单测 72 passed；GATE 运行时 25 PASS / 0 FAIL；e2e 集成 4 passed / 1 skipped。

---

## 5. 处置建议（供 team-lead / dev 裁定）

1. **放行建议**：本次 DB 工具箱 UX 增强（错误工程化 L1/L2、历史视图、共享菜单、生成 SQL、PG 菜单视觉契约）已全部满足 ux-spec v0.2，可放行。
2. F5（MySQL/SQLite 连接节点快捷键标注）：随导航入口恢复（`fe1d1f2` 隐藏解除）一并补齐。
3. F6 表设计器右键：建议在 product backlog 登记，后续迭代实现（spec A7）。
4. 临时 GATE 脚本 `tests/db-toolbox-ux.gate.e2e.spec.ts` 未提交，留作复跑证据；若团队要保留可转正为回归用例。
