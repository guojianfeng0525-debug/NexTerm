# B19 查询命令 + B20 快捷键体系 架构约束（实现前）

> 作者：architect（高见远）｜2026-08-26
> 适用：v2.8.0 冲刺 B19（查询命令）/ B20（快捷键 scope 体系）实现前**架构约束**。fe-dev（B19）/ fe-dev2（B20）照做即可。
> 依据：`navicat-parity-master-plan.md` §5 D2、§7、§6 B19/B20 条目；`navicat-premium-shortcuts.md`（18 组绑定 + 冲突矩阵）；现状代码（下述 §0 盘点）；B18 先例 `b18-filter-architecture-constraints.md`（立即应用、browse 单一路径、tab 级状态）。
> 性质：**只读评审产出**，本文不改动产品代码。每条均为明确决策，编号 D-B19-x / D-B20-x。冲突消解优先级：安全红线文档 > 本文 > 各实现计划。

---

## 0. 现状盘点（2026-08-26 工作区代码核实）

### 0.1 键盘路由现状：三套机制并存

| 机制 | 位置 | 监听方式 | 判定逻辑 | 现状问题 |
|---|---|---|---|---|
| ① 全局注册器 | `src/lib/keyboard-shortcuts.ts:250` `useKeyboardShortcuts`（App.tsx:297 唯一调用） | `window` keydown **capture** | ① `isTerminalInputTarget`（closest `.xterm`）透传终端；② `isEditableTarget`（input/textarea/contenteditable）直接 return；③ 逐条匹配 Ctrl→⌘ 等价 | 无 scope 概念；editable 内一律放行（无法区分"网格内 input"与"普通 input"） |
| ② scope 声明注册表 | `src/lib/database/command-registry.ts` | **无监听**（纯数据 + `resolveDatabaseCommand` enablement 判定） | scopes/requiredCapabilities/connectionStates → enabled/disabled/hidden | 只管菜单/按钮 enablement，**不接管键盘分发**；scope 名 `DATABASE/WORKSPACE` 与 D2 术语（`DATABASE_WORKSPACE/GLOBAL`）不一致 |
| ③ 组件内手工分发 | `tool-postgres.tsx:1223` `onDatabaseKeyDown`（useEffectEvent，window keydown **非 capture**） | 手写 if 链 | `typingInField` 焦点守卫（input/textarea/select/contenteditable）+ tab.type 分支（table/query）+ findState 状态分支 | B17/B18 键处理全在此（Insert/F3/Esc/Ctrl+F/N/Enter/Shift+E/W/S/R）；无优先级模型；与 ① 在 capture 阶段存在执行顺序耦合（① capture 先于 ③ bubble） |

**执行顺序事实**：① 在 capture 阶段先跑；若 ① preventDefault + stopPropagation，③ 收不到事件。现状没炸的原因：① 对 editable 目标直接 return，而数据库工作区几乎所有按键发生在编辑器/网格内。

### 0.2 查询编辑器现状（B19 起点）

- **已是 CodeMirror 6**（不是 CM5，不是裸 textarea）：`tool-postgres.tsx:1584` 用 `<CodeEditor>`，实现在 `src/components/code-editor.tsx`（@codemirror/view 的 EditorView + EditorState，带 SQL 补全/搜索面板/自定义 keymap）。
- **关键缺口**：`CodeEditorProps`（code-editor.tsx:178）**无 ref 暴露、无 selection 出口、无命令式 API**（无 `getView()`/`onSelectionChange`/`insertText()`）。B19 的"当前语句选中"（Ctrl+Shift+R）、"运行选中"（Ctrl+E 选区）、Ctrl+/ 注释、snippet 插入全部需要 EditorView 命令式访问。**B19 必须先给 CodeEditor 加受控出口**（见 D-B19-2）。
- 执行路径：`execute(explain)`（tool-postgres.tsx:622）整段 `tab.sql` 直接 `invoke("postgres_execute")`；无选中/当前语句概念。
- Rust：`postgres_execute`（postgres.rs:576）`simple_query` 整批执行，`QUERY_TIMEOUT=30s`（:22）超时报错但**无取消通道**；`single_statement()`（:987）已有词法级语句切分（引号/行注释/块注释/转义感知），目前仅 EXPLAIN 使用。

### 0.3 执行状态现状

- `running` 是 **ToolPostgres 组件级单一 useState**（tool-postgres.tsx:282），query 执行与 table browse 共用——切 tab 后 spinner 是全局的，无法表达"per-tab Running"。
- 无停止通道：`invoke` 无超时参数、无 cancel；Rust `PostgresState`（postgres.rs:25）仅 `clients: RwLock<HashMap<String, Arc<Client>>>`，无 per-connection 互斥（B17 遗留 M2）、无执行中任务登记。

### 0.4 终端防回归锚点（不可破坏）

- `keyboard-shortcuts.ts:219` `isTerminalInputTarget`：closest `.xterm` 判定 + `ignoreInTerminal` 逐条保护——**保留**。
- `pty-terminal.tsx:828` `attachCustomKeyEventHandler`：IME（isComposing/keyCode 229）early-return true、仅处理 keydown、↑↓/Enter/Esc/Tab 建议框逻辑、Ctrl+C（有选区才复制）、Ctrl+V 走 Tauri clipboard——**B20 不得触碰该文件**。
- 全局绑定清单（App.tsx:297 注册）：Ctrl+B/J/M/Z/\、Ctrl+\、Ctrl+1..9、Ctrl+Tab(±Shift)、Ctrl+W（closeTab 可配置）。

---

## 一、B20 快捷键 scope 路由架构

### D-B20-1（单一路由层）：新建 `src/lib/database/scope-router.ts`，收敛三套机制为"一个分发函数 + 两类注册源"

**目标模型**（Master Plan D2 / §7.1 落地）：

```
window keydown（capture，单一入口）
 ├─ 0. 硬防线：event.target closest('.xterm') → 直接 return（终端永不被数据库路由触碰）
 ├─ 1. DIALOG：任一 Radix Dialog/AlertDialog open → scope = DIALOG（对话框内默认浏览器行为，仅注册 Escape/Enter 等对话框自身键）
 ├─ 2. 焦点元素判定（自最内向外）：
 │     CodeMirror `.cm-editor` 聚焦        → QUERY_EDITOR
 │     网格容器 [data-scope="data-grid"]    → DATA_GRID
 │     导航器 [data-scope="navigator"]      → NAVIGATOR
 │     数据库工作区根 [data-scope="db-workspace"] → DATABASE_WORKSPACE
 ├─ 3. 按 scope 优先级查绑定表：当前 scope → 逐级回落（QUERY_EDITOR→DATABASE_WORKSPACE→GLOBAL）
 ├─ 4. 命中 → resolveDatabaseCommand 判 enablement（能力/连接态）→ enabled 才执行 handler
 └─ 5. 未命中 → 放行（不 preventDefault）
```

- **单一入口**：路由器接管数据库工作区内的 keydown。`useKeyboardShortcuts`（App.tsx）继续负责终端/布局 GLOBAL 层，但**数据库工作区聚焦时其数据库类绑定让位**——实现上：路由器在 capture 阶段判定 scope 非 GLOBAL 时，对已声明为"数据库接管键"的组合 preventDefault 并 stopPropagation，其余放行。
- **scope 判定用 DOM 锚点，不用 React 状态**：给 `database-workspace-shell.tsx` 根加 `data-scope="db-workspace"`、导航器加 `data-scope="navigator"`、结果网格容器加 `data-scope="data-grid"`（B19 侧 fe-dev 配合加这 3 个属性，见 §三）。CodeMirror 自带 `.cm-editor` 类无需加。焦点判定 = `document.activeElement.closest('[data-scope], .cm-editor, .xterm')`。理由：零新状态、无 context 冒泡、与现有 `isTerminalInputTarget` 的 closest 模式同构。
- **`typingInField` 守卫语义被 scope 判定取代**：input/select 聚焦时如果落在网格/工作区容器内，scope 仍是 DATA_GRID/DATABASE_WORKSPACE（容器内 input 的 Ctrl+R 应路由而非放行——修正现状 ① 把网格 find 输入框当普通 editable 放行的缺口）；真正例外仅对话框（scope=DIALOG）与终端（硬防线）。

### D-B20-2（注册方式决策）：绑定声明扩展在 `command-registry.ts`，不建独立绑定表

- `DatabaseCommandDescriptor` 增加**可选**字段：

```ts
readonly defaultBinding?: {
  readonly key: string;              // "r" | "Enter" | "F3" | "/" ...
  readonly ctrlKey?: boolean;        // true = Ctrl（macOS 自动映射 ⌘，沿用 keyboard-shortcuts 语义）
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly when?: "always" | "dirty" | "running" | "not-running";  // 运行态条件
};
```

- 冲突消解**在同一 scope 内按"更具体者胜"**：同一 (scope, 组合键) 多命令注册时，构建期静态检查（一个纯函数 `validateBindings(commands)`）在测试里断言无重复，重复即 CI 失败——不建运行时优先级排序。
- 理由：① command-registry 已有 scope/enablement/labelKey，绑定是命令的属性而非独立实体，独立表必然双源漂移；② 菜单/按钮/快捷键三处消费同一 `resolveDatabaseCommand`，enablement 天然一致（快捷键不执行 disabled 命令）；③ 最小改动——Master Plan D2 原文即"在 command-registry.ts 现有 scopes 上实现注册器"。
- **不做的**：用户自定义绑定 UI（B20 范围外，B22 后评估）；chord 组合键（Navicat 无此需求）。
- scope 枚举收敛：`DATABASE_COMMAND_SCOPES` 现有 `DATABASE`（工具入口级）与 `WORKSPACE`，路由层新增 `DIALOG` 与 `GLOBAL` 概念但**不进 DatabaseCommandScope**（DIALOG 无数据库命令；GLOBAL 属于 keyboard-shortcuts 层）。`DATABASE`→路由上映射为 `DATABASE_WORKSPACE`（重命名 `WORKSPACE`→`DATABASE_WORKSPACE` 一次到位，tsc 保证全量替换）。

### D-B20-3（18 组绑定的冲突消解矩阵，逐条对照 shortcuts.md）

| 组合键 | Navicat 动作 | scope | 消解 |
|---|---|---|---|
| Ctrl+D（设计对象） | DATA_GRID/NAVIGATOR | 表设计器 B23 才有——**B20 只注册命令占位**（handler 禁用态：toast "B23 可用"），避免绑定真空期用户困惑；NAVIGATOR scope 同理 |
| Ctrl+Q（查询对象） | NAVIGATOR | 映射到既有 `database.workspace.newQuery`，enabled=connected |
| Ctrl+F / F3 / Ctrl+G | DATA_GRID 查找/下一个/行 | Ctrl+F 开 find bar（B18 已有，迁移）；F3 findNext；**Ctrl+G（go to row）B20 只占位**（行号输入属 B18 backlog，未实现不绑） |
| Ctrl+R | 网格过滤 vs 查询运行 | **同键不同 scope，按路由天然消解**：QUERY_EDITOR→`database.query.execute`；DATA_GRID→`resolveFilterShortcut` 二态（B18 语义原样迁移）；NAVIGATOR/WORKSPACE→刷新导航器 |
| Ctrl+Enter | DATA_GRID 单元格编辑器 / QUERY_EDITOR 运行 | **同键不同 scope**：网格→打开单元格编辑器（B17 已有）；查询编辑器→运行（现状 tool-postgres 把 Enter 当运行、绑定在 window 层，B20 迁入 QUERY_EDITOR scope 后**裸 Enter 不再是运行键**，符合 Navicat） |
| Insert / Ctrl+N / Ctrl+Delete | 增/删记录 | Insert→DATA_GRID 增行（迁移现状）；**Ctrl+N 在 DATA_GRID scope 内接管为增行，终端 scope 仍是新会话（终端 wins 已由硬防线保证）**；Ctrl+Delete→删行（现状菜单驱动，补绑定） |
| Ctrl+S / Esc / Ctrl+T | 应用/放弃/停止 | Ctrl+S→DATA_GRID dirty 时保存（`when:"dirty"`）；Esc→放弃编辑（DATA_GRID）；**Ctrl+T→停止，仅 `when:"running"` 且 scope∈{QUERY_EDITOR,DATA_GRID}**；Ctrl+W 保持现状关闭 tab（WORKSPACE，脏确认逻辑 B17 已有） |
| Ctrl+A / Shift+Arrow / Ctrl+C / Ctrl+V | 网格选择/复制/粘贴 | B17 已实现网格选择复制；B20 不重复绑定（组件级逻辑保留），**仅把 Ctrl+A 绑定为全选命令**（DATA_GRID） |
| Ctrl+O | 查询编辑器打开文件 | QUERY_EDITOR，**B19 范围**（见 D-B19-7） |
| Ctrl+E | 选中/运行当前语句 | QUERY_EDITOR；与现有 Ctrl+Shift+E（explain）并存——注意现状 onDatabaseKeyDown 的 Ctrl+Shift+E 语义迁移为 `database.query.explain` 绑定 |
| Ctrl+Shift+R | 运行当前语句 | QUERY_EDITOR（**B19 核心**） |
| Alt+0..9 | 结果 tab 切换 | DATABASE_WORKSPACE（**B19 范围**：结果 pin/多结果之后才有意义，B20 先占位禁用） |
| Ctrl+Shift+V | 剪贴板栈 | QUERY_EDITOR；**降级实现**：不建剪贴板历史栈（Navicat 语义 UNVERIFIED），先绑定为"从剪贴板粘贴"并注明证据缺失 |
| Ctrl+/ | 注释切换 | QUERY_EDITOR（CodeMirror `toggleComment`，**B19 范围**实现，B20 注册绑定） |
| Ctrl+= / - / 0 | 缩放 | QUERY_EDITOR+DATA_GRID；**B20 不做**（编辑器字号已有 editor-config 体系，网格缩放无需求证据）——记录为不做项，防止范围蔓延 |
| F5 / Esc / H（ER） | ER 画布 | **B24 才有 ER，B20 完全不注册**；但路由器须保证 F5 在 db-workspace 内不触发浏览器刷新（preventDefault 兜底，B24 接管） |
| R / Delete（ER FK） | ER 画布 | 同上不注册 |
| Ctrl+滚轮（ER 缩放） | ER 画布 | 同上不注册 |

**与终端/系统冲突总表**（B20 验收必测）：Ctrl+N（终端 wins：硬防线 0 号规则）、Ctrl+Tab/Ctrl+Shift+Tab（数据库工作区聚焦时路由为 tab 切换，终端聚焦时终端组切换——**由 scope 判定自动实现，无需改 App.tsx 现有绑定，但需在路由器 return false 让位**）、Ctrl+Z（QUERY_EDITOR/DATA_GRID 内编辑器撤销 wins，非数据库区仍 Zen mode）、Ctrl+W（保留关闭+脏确认）、F5（工作区内吞掉防刷新）。

### D-B20-4（xterm 永不拦截的实现锚点）

1. **路由器第一行**复用 `isTerminalInputTarget(event.target)`（从 keyboard-shortcuts.ts export，B20 允许 fe-dev2 加 export，不改逻辑）——命中直接 return false（放行，不 preventDefault）。
2. `useKeyboardShortcuts` 现有 capture 监听顺序在路由器之前注册（App.tsx 挂载序），其 `isTerminalInputTarget` + `ignoreInTerminal` 双保险**不动**。
3. **禁止事项**：路由器不得监听 keypress/keyup；不得在 `.xterm` 祖先节点上 stopPropagation；不得 preventDefault 任何 isComposing 事件。
4. 单测锚点：`scope-router.test.ts` 必含"xterm textarea 内 Ctrl+R/Ctrl+N/任意键 → 路由器返回放行且不调用任何 handler"。

---

## 二、B19 查询命令架构

### D-B19-1（"当前语句"定位）：语句切分器 = lib 纯函数，语义对齐 Rust `single_statement`

- 新建 `src/lib/database/sql-statement.ts`：`splitSqlStatements(sql: string): SqlStatement[]`（含 `{ text, start, end }` 偏移）+ `statementAtPosition(statements, offset): SqlStatement | null`。**词法规则逐条移植 postgres.rs:987 `single_statement`**（单引号含 '' 转义、双引号标识符、`--` 行注释、`/* */` 嵌套块注释、分号界定），保证前端选中范围与 Rust EXPLAIN 单语句校验同一语法口径。
- **CodeMirror 6 是唯一编辑器事实**（§0.2）。"当前语句" = `statementAtPosition(statements, view.state.selection.main.head)`；无分号结尾的尾句视为一条语句（与 single_statement 尾段一致）。
- 纯函数放 lib（不放组件）的理由：B18 先例（table-filter.ts / find-matches.ts）+ 单测矩阵要求"语句切分器"独立可测 + MySQL/SQLite provider 复用同一契约。
- 运行语义：Ctrl+Shift+R（运行当前语句）= 取当前语句文本执行；Ctrl+R = 整段（多语句 simple_query，保持现状）；有选区时优先选区（Navicat "Run Selected"，Master Plan B19 条目）。

### D-B19-2（CodeEditor 命令式出口）：加最小 ref API，不重构

`CodeEditorProps` 增加（code-editor.tsx）：

```ts
editorRef?: MutableRefObject<CodeEditorHandle | null>;   // { getView(): EditorView | null }
onSelectionChange?: (selection: { from: number; to: number; head: number }) => void;
```

- `CodeEditorHandle` 只暴露 `getView()`（拿到 EditorView 即可命令式做 selection/toggleComment/snippet 插入/缩放），**不封装高层方法**（防止抽象膨胀，B19 各功能直接用 CM6 官方 command 包）。
- tool-postgres 持 ref；Ctrl+E/Ctrl+Shift+R 的 handler 经 `editorRef.current?.getView()` 拿 `state.doc`/`selection`，与 D-B19-1 纯函数组合。
- 禁止：为 B19 把 CodeEditor 改成完全受控 selection（CM6 状态机自持，外部强控必炸）；禁止再开第二个编辑器实例路径。

### D-B19-3（执行状态机）：状态归属 WorkspaceTab，组件级 `running` 拆为 per-tab

```ts
type WorkspaceTab = {
  // ...既有
  execution?: {
    state: "running" | "stopping";
    /** Mirrors the Rust cancellation token for Stop. */
    runId: string;              // 本次执行 id（uuid）
    startedAt: number;
  };
};
```

- **归属理由**：与 B17/B18 的 tab 级状态模式一脉相承（activeFilter/pendingInserts 同层）；切 tab 时各 tab spinner 独立；`running` 组件级标志退役，`isRunning = activeTab.execution?.state === "running"` 派生（工具栏禁用态、Ctrl+T 可用性均派生）。
- **状态机**：`Idle →(run) Running →(stop|完成|失败) Idle`；`Running →(stop) Stopping →(后端确认|超时 3s) Idle`。Stopping 期间禁 Run/Stop 按钮；停止完成 toast 提示（措辞含"已取消"）。
- **不做**：全局执行队列/并发限制（单连接 tokio_postgres Client 本身串行排队，`simple_query` 不会交叉）。

### D-B19-4（停止的取消通道）：新 Tauri 命令 `postgres_cancel`，CancellationToken 按 runId 登记

Rust 侧（postgres.rs + commands.rs + lib.rs 注册）：

```rust
// PostgresState 增加：
cancellations: RwLock<HashMap<String, CancellationToken>>,   // key = runId
```

- `postgres_execute` 请求体加 `run_id: Option<String>`；有 run_id 时先登记 token，查询 `tokio::select! { result = simple_query(..) => .., _ = token.cancelled() => return Err("Query cancelled") }`，**finally 移除登记**。
- 新命令 `postgres_cancel(request: { connectionId, runId })`：取 token（有则）`cancel()`，立即返回 Ok（不等待查询真正结束——前端 Stopping 超时兜底）。
- **query timeout 30s 与取消正交**：select! 同时挂 timeout 与 cancelled，先到者赢。
- **B17 安全遗留三项（M2/M3/M4）在 B19 一并落**（Master Plan §11.5 已指定本批）：M2 = `PostgresState` 加 `txn_locks: RwLock<HashMap<String, Arc<Mutex<()>>>>`，`postgres_transaction` 持锁至 commit/rollback 完成；M3 = update/delete 校验受影响行数 `count == 1` 否则 Err 触发回滚；M4 = commit 失败 Rust 侧主动 `ROLLBACK` 再返回错误。
- 事务与取消的关系：`postgres_cancel` **只取消登记了 run_id 的 execute/table_data**，不触碰显式事务命令（BEGIN/COMMIT/ROLLBACK 属用户显式控制）。

### D-B19-5（Find Builder / 参数查询 / snippet / 标识符面板的组件边界）：延续 B18"对话框纯展示 + lib 纯逻辑"

| 功能 | 组件（新） | lib 纯逻辑（新） | 边界规则 |
|---|---|---|---|
| Find Builder | `find-builder-dialog.tsx`（单一对话框） | `find-builder.ts`：`buildFindQuery(input): { sql, params? }` | 对话框只收集输入/预览 SQL/Apply；SQL 生成纯函数、参数化（`$1..$n`）绝无字符串拼接（安全红线延续 D-B18-2） |
| 参数查询（`:param` 占位） | 参数输入面板（对话框内嵌） | `sql-params.ts`：`extractSqlParams(sql): ParamSpec[]` + 替换为 `$n` 的纯变换 | 执行前拦截：发现 `:name` 占位 → 弹面板收集值 → 变换后走 `postgres_execute`；值以参数下发需 Rust execute 支持 `params: Option<Vec<String>>`（simple_query 不支持参数 → **改用 `client.query` + `$n`**，与 table_data 的参数化路径同构） |
| Snippet | `snippet-manager.tsx`（面板/对话框） | `sql-snippets.ts`：snippet 存储（localStorage `nexterm.sqlSnippets.*`，沿用 grid-layout-storage 模式）+ 展开纯函数 | 插入经 D-B19-2 的 getView() dispatch changes；不建全局 snippet 服务 |
| 标识符面板 | `identifier-panel.tsx`（工作区侧挂面板，非 Dialog） | 复用 `postgres_catalog_search`（已存在，tool-postgres.tsx:362 已调用） | 双击插入编辑器；只读展示，无独立状态机 |

- 全部遵守 Master Plan 纪律：Command Resolver 不执行命令；对话框 Apply 即动作（B18 立即应用语义）；不建 provider 无调用方的抽象——以上组件先只做 PG 侧，组件接口**不得**带 provider 泛型（等 MySQL B25 复用时再抽）。

### D-B19-6（命令注册）：新增 QUERY_EDITOR/WORKSPACE scope 命令

`command-registry.ts` 增加：`database.query.executeCurrentStatement`（QUERY_EDITOR，Ctrl+Shift+R）、`database.query.runSelection`（QUERY_EDITOR，Ctrl+E）、`database.query.stop`（QUERY_EDITOR+DATA_GRID，Ctrl+T，`connectionStates:["connected"]`）、`database.query.comment`（QUERY_EDITOR，Ctrl+/）、`database.query.openFile`（QUERY_EDITOR，Ctrl+O）、`database.query.format`（QUERY_EDITOR，无绑定，菜单驱动）、`database.query.beautifyMinify` 同前、`database.workspace.resultTab`（DATABASE_WORKSPACE，Alt+0..9，B20 占位）。全部仅声明 + enablement（requiredCapabilities 空——执行不依赖能力位，连接态即够）。

### D-B19-7（格式化/压缩/Ctrl+O/注释的实现边界）

- **格式化/压缩**：用成熟库（`sql-formatter` 或等价）在 lib 包一层纯函数 `formatSql(sql): string`（`sql-formatter.ts`），不手写格式化器；经 getView() 整文档替换（保留 undo 历史，dispatch changes 而非 setState 重建）。
- **Ctrl+O**：`@tauri-apps/plugin-dialog` open + `plugin-fs` readTextFile（项目已有依赖，tool-postgres.tsx:11-12 已 import save/writeTextFile），读入写 `tab.sql`。
- **Ctrl+/**：CM6 `@codemirror/commands` `toggleComment`，绑在 CodeEditor keymap（与 Mod-f 同层）**或**路由器 QUERY_EDITOR scope——**决策：绑路由器**（与其他 QUERY_EDITOR 键一致，CodeEditor 保持通用组件，不为 SQL 特化 keymap）。

---

## 三、文件边界：fe-dev（B19）vs fe-dev2（B20）

| 文件 | B19（fe-dev） | B20（fe-dev2） | 冲突处置 |
|---|---|---|---|
| `src-tauri/src/postgres.rs` | **独占**（cancel 命令、params、M2/M3/M4） | 不动 | — |
| `src/components/toolbox/tool-postgres.tsx` | **独占**（execution 状态、停止、当前语句、新对话框挂载、data-scope 属性三处） | **不动组件**；迁移键处理由 fe-dev 在 B19 内同步完成（见下） | 见 D-B20-5 |
| `src/components/code-editor.tsx` | **独占**（editorRef/onSelectionChange 出口） | 不动 | — |
| `src/lib/database/sql-statement.ts` 等新 lib | **独占**（新建） | 只读消费 | — |
| `src/lib/database/command-registry.ts` | 加 B19 命令（D-B19-6，不含 binding 字段） | **独占 binding 字段 + 18 组绑定 + scope 重命名**（D-B20-2） | 时序上 fe-dev 先行合并（B19 依赖 B20 的绑定才能验收快捷键 → 见依赖注） |
| `src/lib/database/scope-router.ts` | 不建不读 | **独占**（新建路由器 + 单测） | — |
| `src/lib/keyboard-shortcuts.ts` | 不动 | export `isTerminalInputTarget`（仅加 export） | — |
| `src/components/toolbox/database-workspace-shell.tsx` / `database-navigator.tsx` / `database-result-pane.tsx` | 只加 `data-scope` 属性（各 1 行） | 只读消费 | — |
| `src/App.tsx` / `src/components/pty-terminal.tsx` | 不动 | App.tsx 仅在需要时挂路由器 hook（一处）；**pty-terminal.tsx 禁改** | — |

### D-B20-5（onDatabaseKeyDown 双方都要动的处置方案）：B19 一次性收敛，B20 不碰组件

**决策：fe-dev（B19）在实现查询命令的同时，把 `onDatabaseKeyDown` 的全部键处理迁移到 fe-dev2 交付的 scope-router 上；fe-dev2 只交付 lib 层（路由器 + 注册表绑定），不改 tool-postgres.tsx。**

- 时序与依赖：fe-dev2 **先交付** `scope-router.ts` + `command-registry.ts` 绑定声明（纯 lib，可独立单测：scope 判定矩阵 + 冲突校验 + enablement 路由）→ fe-dev 在 B19 内接线：删 `onDatabaseKeyDown`（tool-postgres.tsx:1223-1312 整段）改为向路由器注册 handlers（`registerScopeHandler(commandId, handler)` 模式，handlers 存 ref 不重挂监听）。
- 理由：① 组件内 40+ 行手写 if 链与路由器并存必然漂移（capture/bubble 双路径），一次收敛最干净；② B19 的 Ctrl+Shift+R/Ctrl+T/Ctrl+E 反正要动全部查询键，增量迁移=双份代码；③ fe-dev2 不动组件 = 两个 agent 零文件冲突，可真正并行。
- **B19 交付顺序内含 B20 验收依赖**：B19 DoD 的快捷键 E2E（当前语句/停止）在路由器接线后才成立——team-lead 排期时 fe-dev2 的 lib 交付是 fe-dev 接线的前置（可同日）。
- 兜底：若 fe-dev2 交付延迟，fe-dev 允许临时保留 onDatabaseKeyDown 仅查询键分支（与路由器并存按注册序去重——路由器先注册先赢），但 **B20 DoD 验收前必须删除**（grep 断言 `onDatabaseKeyDown` 不存在）。

---

## 四、与 B18 已确立架构的兼容

1. **browse 单一路径不动**：B19 停止/执行状态不进 browse；table tab 的 `postgres_table_data` 同样支持 runId 取消（长查询翻页也能停），browse 签名不变（内部 invoke 加 runId 参数）。
2. **立即应用语义延续**：Find Builder/参数面板的 Apply 即执行（非 draft），与 B18 决策 2 同构；对话框 Cancel 只关不写。
3. **WorkspaceTab 只存数据不存 UI 态**：`execution` 是数据态（驱动 spinner/按钮禁用），合法；对话框 open/close 仍组件 useState。
4. **过滤态与执行态正交**：activeFilter 存在时运行/停止照常；保存后重查逻辑（B18 决策 8）不因 execution 字段改变。
5. **命令注册表只声明不执行**（B18 决策 11 / Master Plan 约束 4）：B19/B20 新命令全部延续；handler 仍在 tool-postgres 组件闭包内。
6. **grid-layout-storage 持久化模式**：snippet 存储沿用其 key 体系与版本容错写法。

---

## 五、过设计检查（明确不做项）

| 项 | 决策 |
|---|---|
| 快捷键用户自定义 UI / 设置页扩展 | 不做（B22 后） |
| chord（序列键如 Ctrl+K Ctrl+C） | 不做（无 Navicat 证据） |
| 剪贴板历史栈（Ctrl+Shift+V 完整语义） | 降级为粘贴；栈待 UNVERIFIED 消除 |
| 编辑器/网格缩放 Ctrl+=/-/0 | 不做（无证据 + editor-config 已有字号） |
| 全局执行队列 / 并发调度器 | 不做（tokio_postgres 连接内天然串行） |
| snippet 云同步 / 导入导出 | 不做（localStorage 即可） |
| CodeEditor 高层命令封装层 | 不做（只暴露 getView） |
| ER/MODEL scope 的任何绑定 | 不做（B24） |

---

## 六、决策速览（fe-dev / fe-dev2 必读）

1. **D-B20-1** 单一路由器 `scope-router.ts`：capture keydown → xterm 硬防线 → DIALOG → DOM 锚点判 scope（`.cm-editor`/`data-scope`）→ 逐级回落查绑定 → enablement → handler。
2. **D-B20-2** 绑定声明进 `command-registry.ts`（`defaultBinding` 可选字段），不建独立绑定表；同 scope 冲突靠构建期静态校验；`WORKSPACE` 重命名 `DATABASE_WORKSPACE`。
3. **D-B20-3** 18 组冲突全量消解：Ctrl+R/Ctrl+Enter 同键异 scope 路由；Ctrl+N 终端 wins；Ctrl+T 仅 running 态；ER 组不注册；缩放/剪贴板栈不做。
4. **D-B20-4** xterm 永不拦截 = 路由器第一道 closest('.xterm') 放行 + 不监听 keypress/keyup + 不碰 isComposing。
5. **D-B19-1** 语句切分器 `sql-statement.ts` 纯函数，词法规则对齐 Rust `single_statement`。
6. **D-B19-2** CodeEditor 加 `editorRef`（getView）+ `onSelectionChange`，不加高层封装。
7. **D-B19-3** 执行状态机 per-tab（`execution.state: running|stopping`），组件级 running 退役。
8. **D-B19-4** 取消通道 = `runId` + CancellationToken 登记 + 新命令 `postgres_cancel`；select! 与 30s timeout 竞速；M2/M3/M4 安全遗留本批落地。
9. **D-B19-5** 四个新功能全走"对话框纯展示 + lib 纯函数"，参数化 `$n` 绝不拼接。
10. **D-B20-5** 文件边界：fe-dev2 只交付 lib（router + 绑定），fe-dev 负责组件接线并删除 onDatabaseKeyDown；兜底并存方案 B20 DoD 前必须清零。

> 验收提醒：B19/B20 各自 DoD 里必须有 scope 路由单测（18 组矩阵 × 终端/对话框/编辑器/网格焦点）与终端回归 E2E（Ctrl+N/C/R/Tab 在 xterm 聚焦时行为与 main 基线逐键一致）。
