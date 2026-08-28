# 数据库工具箱现有实现审计报告

> 审计人：db-auditor ｜ 日期：2026-08-28
> 范围：数据库工具箱 UX（右键菜单、错误信息、快捷键、跨功能联动）
> 结论先行：PostgreSQL 是唯一功能完备的实现；MySQL / SQLite 仅"能用"级别，三件套几乎整体缺失；B20 快捷键路由机制（bindings + scope-router）已实现但**未接入生产代码**，是最大的一块"未激活能力"。

---

## 一、右键菜单现状

### 1.1 已有右键菜单（✅）

#### PostgreSQL（tool-postgres.tsx，功能最完整）

| 场景 | 位置 | 菜单项 |
| --- | --- | --- |
| 导航树·连接节点 | database-navigator.tsx:148-202 + tool-postgres.tsx:2443-2460 | 断开/重连、新建查询、刷新、连接管理器、编辑、删除 |
| 导航树·表/视图/物化视图 | tool-postgres.tsx:2495-2528 | 打开数据、设计表/设计视图、复制名称、生成 DDL、刷新、（表分组）新建表、Drop（带依赖 dry-run 确认，2493 / 2523） |
| 导航树·函数/序列/索引/约束/触发器 | tool-postgres.tsx:2499-2503 | 打开对象查看器（openObjectViewer） |
| 导航树·列 | tool-postgres.tsx:2504 | 复制列名 |
| 工作区 Tab | database-workspace-shell.tsx:59-86 + tool-postgres.tsx:2547-2553 | 关闭、关闭其他 |
| 查询编辑器 | tool-postgres.tsx:2639-2756 | 撤销/重做、剪切/粘贴/全选、运行、运行选择、格式化、保存到记事本（含来源标注 selection/statement/document，2737-2746）、复制 |
| 数据网格·单元格 | database-result-pane.tsx:192-243 + tool-postgres.tsx:2898-2941 | 复制单元格/复制行/复制列名、按字段值筛选、自定义筛选、设为 NULL/空串/生成 UUID、删除记录、导出 CSV/Excel；插入行：复制/移除 |
| 数据网格·列头 | database-result-pane.tsx:644-657 + tool-postgres.tsx:2942-2962 | 筛选排序、冻结列/取消冻结、设置列宽、最佳宽度、显示字段类型/注释 |
| 数据网格·行号 gutter | database-result-pane.tsx:623-636 + tool-postgres.tsx:2963-2965 | 设置行高 |

#### 记事本（tool-notes.tsx）
列表 + 编辑器均有右键菜单（tool-notes.tsx:28-35 引入全套 ContextMenu 组件），包含：粘贴到终端（212-219）、粘贴 SQL 到 PostgreSQL / 快速执行（221-235）、发送到查询页（237-251，多连接子菜单 257-300）、复制、删除、钉住等。

### 1.2 缺失的右键菜单（❌ / ⚠️）

| 场景 | 现状 | 证据 |
| --- | --- | --- |
| **MySQL / SQLite 全场景** | ❌ 完全没有右键菜单（导航树、编辑器、结果网格、Tab 全部没有）；数据库导航器复用组件虽带触发点，但 `renderContextMenu` 未传入 | tool-mysql.tsx / tool-sqlite.tsx 全文无 `ContextMenu`/`ContextMenuItem`/`renderContextMenu` 引用；tool-sqlite.tsx:143 的 DatabaseNavigator 未传 renderContextMenu |
| 表设计器 | ❌ 列/约束/FK 行只有行内按钮（加列/删列），无右键（复制列定义、置顶、批量操作） | table-designer-tab.tsx:452-516 |
| 对象查看器 | ❌ 只读展示，无右键（复制 DDL、在编辑器打开、刷新） | object-viewer-tab.tsx:97-153 |
| 结果面板·空态/消息区 | ❌ `labels.ready` 无右键（无法复制错误文本/清空） | database-result-pane.tsx:801-803 |
| DDL 预览面板 | ⚠️ 只有工具栏按钮（复制/刷新/打开到编辑器），无右键 | tool-postgres.tsx:2992-3054 |
| 查询历史 | ⚠️ 仅 hover 复制按钮（tool-command-history.tsx:153-161），无右键（再次执行/删除单条） | tool-command-history.tsx:141-162 |
| 结果网格·表头命令区域 | ⚠️ 行数、commandTags 无右键 | database-result-pane.tsx:533-540 |

---

## 二、错误信息现状

### 2.1 当前呈现方式

| 错误类型 | 呈现 | 证据 |
| --- | --- | --- |
| SQL 执行错误（PG） | `toast.error(title, { description: String(error) })`，正文为 Rust 端 `format!("PostgreSQL query failed: {error}")` 原始字符串 | tool-postgres.tsx:983-991, 1257-1260；src-tauri/src/postgres.rs:828 |
| SQL 执行错误（MySQL/SQLite） | 同样 `toast.error(..., { description: String(error) })` | tool-mysql.tsx:217-220；tool-sqlite.tsx:102 |
| 连接失败（PG） | toast + host-key 变更时的"重新信任"action 按钮 | tool-postgres.tsx:752-771 |
| 连接失败（MySQL/SQLite） | 普通 toast，无特殊处理 | tool-mysql.tsx:196-199；tool-sqlite.tsx:95 |
| 导航树加载失败 | 内联 `errorLabel` 文本 | database-navigator.tsx:212-216（tool-postgres 未传可重试的 error 文案/按钮） |
| DDL 预览失败 | 内联 red 文本 | tool-postgres.tsx:3039-3042 |
| 表设计器加载/应用失败 | 加载失败整页内联错误（table-designer-tab.tsx:323-329）；应用失败 toast（186-189） | |
| 对象查看器权限拒绝 | 内联 ShieldAlert 提示 | object-viewer-tab.tsx:99-105 |

### 2.2 差距（⚠️ / ❌）

1. **错误格式原始化**：全部 `String(error)` 原样透传，未结构化。PG 后端错误通常含 `position`/`LINE n` 字段（Display 输出），前端未解析。
2. **无法定位到 SQL 行** ❌：前端已有语句 tokenizer（`currentStatementAt`，sql-statement-tokenizer.ts:159-168）可定位语句范围，但错误从未与编辑器关联。
3. **无重试动作** ❌：查询失败 toast 无"重试"按钮（PG 仅在连接错误上做过 action 先例，752-771）。
4. **无复制** ❌：sonner toast 无复制按钮，长错误文本难以留存；错误不进入 `DatabaseResult`（result-types.ts:100-103 只有 tabular/command/empty 三种，**无 error kind**），切换 tab 即丢失。
5. **无内联错误区** ❌：结果面板"message"区只渲染 `labels.ready`（database-result-pane.tsx:801-803），执行错误不展示在结果面板内，仅靠瞬时 toast。
6. **MySQL/SQLite 错误无上下文**：无 runId/停止能力（PG 有 postgres_cancel，1163-1175），超时错误无法取消。

---

## 三、快捷键现状

### 3.1 注册机制（⚠️ 双轨且未打通）

**轨道 A — 已实现但未接入（B20 死代码）**：
- `src/lib/keyboard/bindings.ts` 定义了 18 组 Navicat 绑定（Ctrl+R 筛选、Insert 加记录、Ctrl+Shift+R/Ctrl+E 执行、F5 刷新、Ctrl+N 新建、Ctrl+W 关 tab 等，bindings.ts:9-95）。
- `src/lib/keyboard/scope-router.ts` 实现了 scope 优先级路由（DIALOG > QUERY_EDITOR/DATA_GRID > NAVIGATOR > DATABASE_WORKSPACE > GLOBAL，scope-router.ts:80-95）与 xterm 硬边界（74-77）。
- `command-registry.ts` 每个命令带 `defaultBinding`（command-registry.ts:93, 214, 280…）。
- **关键事实：全项目 grep `scope-router|routeKeyEvent|NAVICAT_BINDINGS|ALL_BINDINGS`，只有 `__tests__/scope-router.test.ts` 引用，没有任何生产 hook 把 routeKeyEvent 挂到 DOM。** 这套机制是"测试绿、上线无"。

**轨道 B — 实际生效（手写 window keydown）**：
- tool-postgres.tsx:2087-2208 手写 `onDatabaseKeyDown`（useEffectEvent + window keydown），实现：Insert 加记录、Ctrl+F 查找、F3/Esc find、Ctrl+N 新建查询、Ctrl+Enter 运行选择、Ctrl+Shift+E EXPLAIN、Ctrl+T 停止、Ctrl+/ 注释、Ctrl+Shift+F 格式化、Ctrl+Shift+R 运行语句、Ctrl+E 运行选择、Ctrl+W 关 tab、Ctrl+S 保存表格、Ctrl+R 刷新/筛选重放。
- database-navigator.tsx:128-135 Enter 打开对象（组件内自带）。
- CodeMirror 仅默认 keymap（code-editor.tsx:259-291），无 SQL 专用扩展。

### 3.2 差距

1. **scope-router 未接入（P0）**：手写 keydown 与 command-registry 命令状态、bindings 表完全割裂；两套逻辑重复，未来自定义必然冲突。
2. **F5 刷新导航树未实现** ❌：bindings.ts:69-77 声明 NAVIGATOR 的 F5，但 tool-postgres 的 keydown 没有 F5 分支（grep 确认）。
3. **无可视化自定义** ❌：全项目无"数据库快捷键设置"UI；keyboard-shortcuts.ts 仅持久化 app 级布局/分屏快捷键（178-199），DB 域快捷键不可配。
4. **无 shell 冲突可视化** ⚠️：TERMINAL_RESERVED_COMBOS（bindings.ts:117-137）定义了"不得进 GLOBAL"的组合，但既未被 scope-router 消费，也无冲突提示 UI。
5. **Focus guard 不完整** ⚠️：`typingInField` 只 guard Insert/Ctrl+F/Ctrl+R（tool-postgres.tsx:2092, 2124-2128），在编辑器内按 Ctrl+N/Shift+R 仍会触发命令——可能是设计意图但无一致性约定。
6. **MySQL/SQLite 零快捷键** ❌：两个工具无任何 keydown 处理；DESIGNER scope（command-registry.ts:507-519 的 Ctrl+S/Escape 绑定）也未接入表设计器。

---

## 四、跨功能联动现状

### 4.1 已有联动（✅ PostgreSQL ↔ Notes，单向 + 双向）

| 联动 | 实现 | 证据 |
| --- | --- | --- |
| SQL → 记事本 | 工具栏"保存到记事本" + 编辑器右键，选择/语句/文档三级来源判定，防重复块 | tool-postgres.tsx:1003-1033, 1041-1113 |
| 记事本 → SQL 编辑器 | `nexterm:paste-sql-note` 事件，provider 过滤 | tool-postgres.tsx:451-463；tool-notes.tsx:221-229 |
| 记事本 → 查询页（多连接子菜单） | `nexterm:paste-sql-to-query` | tool-notes.tsx:237-300；tool-postgres.tsx:806-842 |
| 记事本 → 快速执行 | `nexterm:quick-execute-postgres` | tool-notes.tsx:230-235；tool-postgres.tsx:783-805 |
| 保存 SQL（跨会话恢复） | localStorage 按 connectionId 隔离 | tool-postgres.tsx:217-246 |
| 结果集导出 | CSV / Excel（xlsx 动态导入） | tool-postgres.tsx:1785-1827 |
| 行窗口化 | useRowWindow 虚拟滚动（大结果集） | use-row-window.ts:68-126 |
| DDL 预览 → 编辑器 | 面板"在编辑器中打开" | tool-postgres.tsx:3015-3028 |
| 导航树 → 数据浏览/设计器/对象查看器 | 双击/右键打开 | tool-postgres.tsx:2395-2425 |

### 4.2 差距（❌ / ⚠️）

1. **导航树右键无"生成 SELECT/INSERT/UPDATE"** ❌：grep 全项目无 `generateSelectSql/generateInsertSql/generateUpdateSql`；复制名称只有限定名（tool-postgres.tsx:2475-2492），无基于行的 DML 生成。
2. **MySQL/SQLite 仅单向** ❌：只有 `paste-sql-note`（notes→editor），无 SQL→notes、无保存、无导出、无快速执行（SQLite 还有 quick-execute 事件，但 PG 专属 provider="postgres"）。
3. **无"结果集 → INSERT 语句"** ❌（Navicat 常见能力）。
4. **无"SQL 保存为 .sql 文件"** ❌：saveFile 只用于 CSV/Excel（1794-1797, 1814-1817）。
5. **对象查看器无"在编辑器打开 DDL"** ⚠️：DDL 预览面板有，但 object-viewer-tab 无。
6. **查询历史与查询编辑器无联动** ❌：tool-command-history 是终端命令历史（lib/command-history.ts 面向 shell），与 DB 查询历史无关；DB 侧没有查询历史记录。

---

## 五、优先级建议

### P0（立即可感知的核心差距）
1. **MySQL / SQLite 三件套补齐**：右键菜单（导航树/编辑器/网格/Tab）、快捷键（执行至少 Ctrl+Enter）、错误 toast 结构化。当前两工具标注 "Experimental"，但与 PG 的 UX 落差超过可用边界。
2. **错误信息工程化**：前端解析 PG 错误（position/LINE → 定位到编辑器行并高亮）、错误可复制、可重试（复用 752-771 的 action 先例）；`DatabaseResult` 增加 error kind，错误内联进结果面板而非只靠瞬时 toast。
3. **接入 B20 scope-router**：写一个 `useDatabaseKeyboardShortcuts` hook 挂载 routeKeyEvent，让 bindings.ts + command-registry 的 defaultBinding 真正生效，删除/收敛手写 keydown（tool-postgres.tsx:2087-2208），同时补 F5 刷新、DESIGNER 域绑定。

### P1（体验与一致性）
4. **导航树右键生成 SQL**：SELECT / INSERT / UPDATE 模板 + 复制完整限定名（已具备引用模型 postgresql-object-loader.ts:147-154）。
5. **快捷键可视化**：DB 域快捷键设置面板（读 bindings + command-registry），至少支持显示与冲突检测（TERMINAL_RESERVED_COMBOS 已有基础）。
6. **表设计器 / 对象查看器右键**：复制列定义、复制 DDL、在编辑器打开；设计器补 Ctrl+S/Ctrl+Z。
7. **MySQL/SQLite 补齐快速执行与 SQL→记事本反向联动**。

### P2（增强）
8. **查询历史（DB 域）**：记录已执行 SQL，历史列表右键"再次执行/删除单条"。
9. **结果集 → INSERT 生成**、**SQL 导出 .sql 文件**。
10. **结果面板消息区交互化**：错误/提示文本可选中复制，空态支持右键。

---

## 附：核心证据文件清单

- 右键菜单完整实现：`src/components/toolbox/tool-postgres.tsx`（2427-2530 导航树 / 2639-2756 编辑器 / 2898-2965 网格）
- 右键菜单复用组件：`src/components/toolbox/database-navigator.tsx`（148-202）、`database-result-pane.tsx`（192-243, 623-657）、`database-workspace-shell.tsx`（59-86）
- 零右键实现：`src/components/toolbox/tool-mysql.tsx`、`tool-sqlite.tsx`
- 错误处理：`tool-postgres.tsx`（752-771, 983-991）、`src-tauri/src/postgres.rs`（828）
- 快捷键（未接入）：`src/lib/keyboard/bindings.ts`、`scope-router.ts`、`command-registry.ts`（defaultBinding）
- 快捷键（实际）：`tool-postgres.tsx`（2087-2208）
- 联动事件：`tool-notes.tsx`（212-300）、`tool-postgres.tsx`（451-463, 783-842）
