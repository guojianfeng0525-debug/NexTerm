# B19+B20「查询命令 + 快捷键体系」合并冲刺计划（Navicat Parity，v2.8.0 收官 M1）

> 状态：ACTIVE（用户已授权 v2.8.0 冲刺全速执行，无 PLANNING 审批门；CTO 三项裁定已并入，2026-08-26）
> 作者：pm（许清楚）｜2026-08-26
> 依据：`navicat-parity-master-plan.md` §6 M1（B19/B20 定义）、§7.2/§7.3（快捷键绑定与冲突决策）、§8（质量门禁）、§11.5（B17 安全债 M2/M3/M4 转入 B19）；`navicat-premium-shortcuts.md`（18 组绑定 + 冲突矩阵）；`navicat-premium-interactions.md` IN-18/19/20/21/22（查询交互证据）；`navicat-premium-feature-matrix.md` QY-01/02/04/07/08；`batch-18-browse-plan.md`（Slice/AC 格式与证据规则范本）
> 用户决策（2026-08-26）：不挤牙膏，B19+B20 一次性合并冲刺；B17 已合入 main，B18 核心已实现（原生 E2E/视觉门禁收尾中）；本批完成即**收官里程碑 M1，发 v2.8.0 大版本**。
> **CTO 裁定（2026-08-26，已并入本版）**：① M2 采用**形态 B**——新增 `postgres_save_table_changes` 复合命令，放弃事务互斥锁；② `tool-postgres.tsx` 接线权归 **fe-dev 全程**（P1 迁移 + P2 接线均 fe-dev，不设 fe-dev2 窗口），fe-dev2 严格 lib 层（architect D-B20-5），`code-editor.tsx` editorRef 扩展归 fe-dev；③ 快捷键 combo 以本计划定稿（Ctrl+Shift+R 当前语句 / Ctrl+E 选语句 / Ctrl+T 停止 / Ctrl+/ 注释），已同步 fe-dev2。

---

## 0. 证据规则（沿用 B18）

| 标记 | 含义 |
|---|---|
| **[Fact]** | Navicat 17 Windows 手册（M17）直接证据，标注页码/条目 |
| **[UNVERIFIED]** | 现有官方资料无法建立该精确行为，禁止声称 parity |
| **[NexTerm]** | 产品决策：NexTerm 自定义行为，不声称 Navicat parity |

**范围（Master Plan §6）**：
- **B19 查询命令**：当前语句/运行选中/停止、格式化/压缩、Ctrl+/ 注释、Find Builder、参数查询、snippet、标识符面板；关键 DoD = 当前语句 + 停止原生 E2E。
- **B20 快捷键体系**：scope 路由 + 18 组 Navicat 绑定全量落地，冲突矩阵生效；关键 DoD = scope 路由单测 + 原生 E2E 快捷键 + 终端回归。
- **安全债**：B17 评审遗留 M2/M3/M4（master-plan §11.5）随 B19 归还。

---

## 1. 范围与目标

### 1.1 目标

把查询工作区从「整段执行 + 文本 EXPLAIN」推进到「Navicat 级日常查询工作台」：执行控制三件套（当前语句/运行选中/停止）、编辑工具（格式化/压缩/注释/Find Builder/参数查询）、效率工具（snippet/标识符面板/剪贴板栈），并以 scope 路由器一次性落地 18 组 Navicat 快捷键绑定与冲突矩阵，全部以原生 E2E 验收。

### 1.2 范围界定决策

| # | 决策 |
|---|---|
| D-B19-1 [NexTerm] | B19 全部能力**仅限 PG query tab**（`QUERY_EDITOR` scope）；table tab（`DATA_GRID`）与 SQLite/MySQL 实验性 provider 不扩。Find Builder 生成的 SQL 也落在新的 PG query tab。 |
| D-B19-2 [NexTerm] | **语句切分在前端**（CodeMirror 所在地，光标/选区可直接使用）：新增 `sql-statement.ts` tokenizer（`;` 分隔，感知 `'…'` 字符串、`E''`、`--` 行注释、`/* */` 块注释、`$tag$` dollar-quoted 体）。Rust 不重复实现（`single_statement` 仅继续服务 EXPLAIN）。 |
| D-B19-3 [NexTerm] | **参数查询用 `:name` 语法**（Navicat FM 级证据，细节 [UNVERIFIED]）。执行时扫描非注释/非字符串区的 `:name`，弹出参数对话框收集值，**由 Rust 侧做服务端替换与字面量转义**后 `simple_query`；前端不拼 SQL 值。 |
| D-B19-4 [NexTerm] | **格式化/压缩引入 `sql-formatter` 库**（成熟、支持 PostgreSQL 方言），格式风格为主流缩进换行风格，**不声称与 Navicat beautifier 逐字符一致**（其具体风格 [UNVERIFIED]）。格式化作为一个编辑器事务提交，Ctrl+Z 一步可撤销。 |
| D-B19-5 [NexTerm] | Find Builder = **查找构建器对话框 → 生成跨表查找 SQL 到新 query tab**（值以 `:name` 参数占位，复用 D-B19-3 安全路径）。不直接执行跨表搜索；Aggregate Builder（QY-04 后半）为 Master Plan §3.2 P2 项，**排除**。 |
| D-B19-6 [NexTerm] | 标识符面板数据源**复用 `postgres-completion.ts` 的 `PostgresCatalogLookup`**（relation/column 元数据已有），不新增 IPC；双击插入为 [Fact]（IN-20），插入格式细则为 [NexTerm]。 |
| D-B20-1 [Fact→架构] | scope 分发优先级（shortcuts.md Required shortcut architecture / 主计划 D2）：`DIALOG > QUERY_EDITOR / DATA_GRID > MODEL / ER_DIAGRAM > NAVIGATOR > DATABASE_WORKSPACE > GLOBAL`；xterm textarea **永不拦截**。本批激活 DIALOG/QUERY_EDITOR/DATA_GRID/NAVIGATOR/DATABASE_WORKSPACE；MODEL/ER_DIAGRAM 仅注册占位（B24 激活）。 |
| D-B20-2 [NexTerm] | 绑定表**数据驱动**：`shortcut-router.ts` 内键位 →（scope, commandId）映射表驱动分发；键位冲突解决结论（主计划 §7.2/§7.3）固化为路由单测。18 组中依赖未上线能力的绑定（Ctrl+D 设计对象→B23 表设计器、ER 三组→B24）**注册命令但保持 hidden/disabled**，不绑定到全局。 |
| D-B20-3 [NexTerm] | 现有 `tool-postgres.tsx` 手写 `onDatabaseKeyDown`（:1223）**整体迁移**到路由器（行为等价迁移，B17/B18 语义不变），`keyboard-shortcuts.ts` 全局注册器不动（继续承担 GLOBAL 层 + 终端保护）。 |
| D-B19-7 [CTO 裁定] | **安全债 M2 采用形态 B**：新增 `postgres_save_table_changes` **复合命令**，单命令内 BEGIN→语句→count 校验→COMMIT/ROLLBACK 闭合，事务交错窗口**结构性消失**；M3 校验与 M4 主动 ROLLBACK 获唯一落点（不再分散在裸 `postgres_transaction` 三段调用中）。放弃原事务互斥锁方案。手动事务污染（用户查询 tab 手动 BEGIN 未关）用**前置检测**兜底：保存命令入口检查 `transaction_status`，连接已处于开事务则拒绝并提示。B17 前端 begin→batch→commit 三段式调用整体替换为该复合命令。 |
| D-B20-4 [CTO 裁定] | **`tool-postgres.tsx` 接线权归 fe-dev 全程**（P1 迁移窗口与 P2 接线均为 fe-dev）：B19 三个 Slice 的组件改动（执行状态机/取消/复合保存迁移/Find Builder/snippet 面板）占该文件改动大头，Rust 新命令 API 上下文在 fe-dev 手里。fe-dev2 **严格 lib 层**（shortcut-scope/shortcut-router/bindings/command-registry 的 scope 扩展），符合 architect D-B20-5。`code-editor.tsx` 的 editorRef 扩展也归 fe-dev。 |
| D-B20-5 [CTO 裁定] | 快捷键 combo 以本计划 §7.3 定稿：Ctrl+Shift+R 当前语句 / Ctrl+E 选语句 / Ctrl+T 停止 / Ctrl+/ 注释；fe-dev2 的 bindings.ts 以此对齐。 |

### 1.3 不变量

- 不破坏终端快捷键/IME：xterm 聚焦时一切数据库键位透传；`ignoreInTerminal` 语义保留。
- B17 编辑闭环、B18 过滤/查找/列布局行为不回归（Ctrl+R 在 table tab 的过滤重放语义原样迁入路由表）。
- readOnly 连接：查询命令全部可用（读路径）；断连/执行中命令 enablement 正确。
- `Command Resolver` 不执行命令；路由器只分发到已注册命令 id，enablement 仍走 `resolveDatabaseCommand`。

---

## 2. 现状基线（代码锚点，勿重复实现）

| 现状 | 位置 |
|---|---|
| 整段执行 + 文本 EXPLAIN，无停止/当前语句/运行选中 | `execute()` @ tool-postgres.tsx:622（`postgres_execute`/`postgres_explain`） |
| 手写 keydown 分发（Ctrl+N/Enter/Shift+E/W/S/R、Insert、F3/Escape-Find），含 B18 焦点守卫 | `onDatabaseKeyDown` @ tool-postgres.tsx:1223-1307 |
| 全局快捷键注册器：macOS Ctrl→⌘ 等价、`isTerminalInputTarget`/`isEditableTarget` 守卫 | `src/lib/keyboard-shortcuts.ts:219-296` |
| 命令 scopes 已有 `DATABASE/NAVIGATOR/WORKSPACE/QUERY_EDITOR/DATA_GRID`；命令 resolver 只判可用性 | `command-registry.ts:7-53, 104+` |
| Rust：`PostgresState.clients: RwLock<HashMap<String, Arc<Client>>>`；`postgres_execute` 仅 timeout 无取消；`postgres_transaction` 裸 BEGIN/COMMIT/ROLLBACK；无参数绑定；update/delete 无行数校验 | `postgres.rs:25, 576-632, 673-694` |
| CodeEditor（CodeMirror 6 + `@codemirror/lang-sql`）：history/indentOnInput/search 面板/补全上下文已接 | `src/components/code-editor.tsx` |
| `defaultKeymap` 自带 Mod-/ 行注释切换（**需 AC 验证保留，不重写**） | code-editor.tsx:8, 241-252 |
| 补全元数据 lookup（relation/column/function/type，含 dataType） | `src/lib/postgres-completion.ts` → `postgresql-query-editor.ts:13` |
| 无：格式化/压缩、参数查询、Find Builder、snippet 库、标识符面板、剪贴板栈、Ctrl+O 打开、缩放 | — |
| B17 编辑事务（begin→batch→commit）与保存/回滚 | tool-postgres.tsx `saveTableChanges`/`postgres_transaction` 调用点 |

---

## 3. B19 User Visible Slice 划分

| Slice | 用户可见能力 | 依赖 | 交付形态 |
|---|---|---|---|
| **A 执行控制** | 运行当前语句（Ctrl+Shift+R）、运行选中、停止（Ctrl+T）、选择当前语句（Ctrl+E）、运行三态 UI；**安全债 M2 复合保存命令 / M3 行数校验 / M4 主动回滚（形态 B，CTO 裁定）** | Rust：取消 + 参数替换占位 + `postgres_save_table_changes` 复合命令（M2/M3/M4 唯一落点）；前端：`sql-statement.ts` | 独立可发布 |
| **B 编辑工具** | 格式化（Ctrl+Shift+F）/压缩、Ctrl+/ 注释确认、参数查询（:name + 对话框）、Find Builder | Slice A 的参数替换通道（D-B19-3）；`sql-formatter` 新依赖 | 独立可发布，与 A 部分并行（参数通道就绪后） |
| **C 效率工具** | snippet（内置+自定义+补全插入）、标识符面板（树+双击插入）、剪贴板栈（Ctrl+Shift+V）、Ctrl+O 打开 .sql、缩放（Ctrl+=/-/0） | 低；与 B 并行 | 独立可发布 |

**建议开发顺序**：A 先行（Rust 通道 + tokenizer 是 B 的地基）→ B / C 并行；三 Slice 验收相互独立。

---

## 4. Slice A：执行控制 + 安全债归还

### 4.1 用户故事

> 作为开发，我要像 Navicat 一样在多语句脚本中只运行光标所在的语句、只运行选中的片段，并且随时停止跑飞的查询，而不用担心一次误执行整个文件或只能干等超时。**[Fact]** Run / Run Current Statement / Run Selected / Stop 为查询工具栏文档化命令，Ctrl+R / Ctrl+Shift+R / Ctrl+T（M17 p.380；interactions.md Toolbar Matrix「Query-execution」行、IN-18）；Ctrl+E 选择当前语句（shortcuts.md Query 行 2，M17 p.380）。

### 4.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| **Ctrl+R**（query tab） | 运行编辑器**全部** SQL（现状语义保持） | [Fact] M17 p.380 |
| **Ctrl+Shift+R** | 运行**当前语句**：光标所在语句（tokenizer 切分）；若存在非空选区则改为运行**选中文本** | [Fact] M17 p.380；选中优先为 [NexTerm]（Navicat Run Selected 为工具栏命令，键位 [UNVERIFIED]） |
| **Ctrl+T**（运行中） | **停止**当前查询：取消 Rust 侧执行，UI 立即回到 idle，连接保持可用 | [Fact] M17 p.380；取消机制为 [NexTerm]（tokio-postgres cancel） |
| **Ctrl+E** | **选择**当前语句（编辑器选区覆盖整条语句，不含尾 `;` 后空白）；随后 Ctrl+Shift+R 按选区执行 | [Fact] M17 p.380 |
| 工具栏 | Run 按钮在运行中变为 **Stop**（同键 Ctrl+T）；Run 拆分为下拉：Run / Run Current Statement / Run Selected / Stop | [Fact] interactions.md Toolbar Matrix「Query-execution」 |
| 停止后 | 结果区显示「查询已取消」消息（不显示半截结果），后续查询立即正常 | [NexTerm] |

### 4.3 安全债归还（Master Plan §11.5，归属 Slice A 的 Rust 改动；**M2 形态 B 为 CTO 裁定**）

> 核心设计：新增**复合命令 `postgres_save_table_changes`**——单命令内完成 `BEGIN → INSERT/UPDATE/DELETE（逐条，含 M3 行数校验）→ COMMIT / 任一步失败 → ROLLBACK` 的完整闭合。事务的开启与关闭不可被其他 IPC 请求交错（单次命令调用内完成），事务交错窗口**结构性消失**（优于锁互斥：不拒绝、不污染——保存期间连接上并发的普通查询 SQL 不受事务影响，也不再需要「事务进行中拒绝 execute」的互斥语义）。B17 前端现有 begin→batch→commit 三段式调用整体替换为该命令。

| # | 债 | 落地 |
|---|---|---|
| **M2** | 事务进行中执行普通 SQL 可能被误回滚（B17 三段式调用存在交错窗口） | **形态 B**：`postgres_save_table_changes(connectionId, statements[])` 复合命令，事务在单命令内闭合，交错窗口结构性消失；保存期间并发普通 `postgres_execute` 正常执行、不受事务影响、也不会误回滚。手动事务污染兜底：命令入口**前置检测** `transaction_status`，连接已处于开事务（用户查询 tab 手动 BEGIN 未关等）→ 拒绝并返回明确错误（「连接存在未关闭的手动事务」，提示先 COMMIT/ROLLBACK），不执行任何语句 |
| **M3** | update/delete 未校验受影响行数，并发行被删改时静默丢更新 | 复合命令内逐条语句校验受影响行数：UPDATE/DELETE 影响 `0 行` → 返回 `record changed or deleted` 错误 → 复合命令整体 ROLLBACK（M4 落点）；前端 toast 提示，网格脏状态保持（用户可刷新重试） |
| **M4** | commit 失败时前端 rollback 失败被吞，事务悬空 | 复合命令内 COMMIT 失败 → Rust 侧**主动尝试 ROLLBACK**（尽力而为，失败则将两条错误详情一并上抛）→ 前端 toast 且保存状态复位；后续查询验证不在悬空事务中 |

### 4.4 Acceptance Criteria（AC-19A）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-19A-1 | 编辑器含两条语句（`SELECT 1; SELECT 2;`），光标置于第二条内 → 按 **Ctrl+E** → 选区精确覆盖 `SELECT 2`（不含首尾空白与尾分号后的换行）；再按 **Ctrl+Shift+R** → 结果区仅显示第二条的结果 | E2E |
| AC-19A-2 | 存在非空选区（跨语句的片段）→ **Ctrl+Shift+R** → 仅执行选中文本，未选中部分不执行（结果与该片段单独运行一致） | E2E |
| AC-19A-3 | 语句切分边界感知：`;` 出现在 `'str;ing'` 字符串、`-- 注释;`、`/* ; */`、`$body$ ; $body$` 内部时**不**切分语句；Ctrl+E 选区验证四类样例各一 | UT + E2E |
| AC-19A-4 | 运行 `SELECT pg_sleep(15)` → 工具栏 Run 变为 Stop → 按 **Ctrl+T**（或点 Stop）→ **≤2s** 内 UI 恢复 idle，结果区显示「查询已取消」，随后的 `SELECT 1` 立即成功（连接未损坏） | E2E |
| AC-19A-5 | 服务端确认取消：停止后 `pg_stat_activity` 中原查询状态不再是 active（E2E 断言查询计数/状态，或 RT 断言 cancel 调用） | E2E/RT |
| AC-19A-6 | 运行三态：idle（Run 可用/Stop 隐藏）→ running（Run→Stop，Explain/Save 等禁用）→ 恢复 idle；重复 Ctrl+T 在非运行态为 no-op | E2E |
| AC-19A-7 | **Ctrl+R 运行整段**（现状）不回归：多语句脚本一次执行返回聚合结果（REG 基线） | E2E |
| AC-19A-8 | **M2（形态 B）**：① 保存期间并发普通 SQL 不受事务影响——网格 Apply（多行增删改）进行中，同连接查询 tab 执行 `SELECT` 正常返回正确结果（未被卷入事务、未被误回滚）；② 保存完成/失败后连接状态干净；③ 前置检测：查询 tab 手动 `BEGIN` 未关后触发网格 Apply → 返回「存在未关闭的手动事务」明确错误，无任何语句执行；手动 ROLLBACK 后 Apply 恢复正常 | RT + E2E(SAF) |
| AC-19A-9 | **M3**：模拟并发行删改（先外部 DELETE 该行，再在网格改值 Apply）→ 复合命令内 `record changed or deleted` 错误 → **整体自动 ROLLBACK**（同批其他行的修改也不落库，表内无半套更新）、toast 提示、网格脏状态保持 | RT + E2E(SAF) |
| AC-19A-10 | **M4**：COMMIT 失败场景（RT 模拟断连/约束冲突）→ Rust 侧已主动尝试 ROLLBACK 并返回错误；随后同连接新查询成功且不处于事务中（`SELECT txid_current_if_assigned()` 或等价断言无活动事务） | RT(SAF) |
| AC-19A-11 | 空 SQL / 断连状态：Run/Stop enablement 正确（沿用 resolver；断连时 Run disabled） | UT + E2E |
| AC-19A-12 | readOnly 连接：Ctrl+R / Ctrl+Shift+R / Ctrl+T 全部可用（读路径不拦截） | E2E |

### 4.5 依赖分析

- **Rust**：`postgres_execute` 增查询取消注册（进入时登记 per-connection cancellation token，结束移除）；新增 `postgres_cancel_query(connectionId)` 命令（优先 tokio-postgres 原生 cancel；不可用则中止 future + 连接重建降级——实现方式由 cto 定，验收以 AC-19A-4/5 行为准）；`PostgresExecuteRequest` 增可选 `parameters`（Slice B 使用，A 批先落通道与转义单测）；新增 `postgres_save_table_changes` 复合命令（M2/M3/M4 唯一落点：BEGIN→语句→count 校验→COMMIT/失败 ROLLBACK，含 `transaction_status` 前置检测）；B17 前端三段式事务调用替换为复合命令（裸 `postgres_transaction` 保留给手动事务用途）。
- **前端**：`sql-statement.ts`（findStatementAt(text, offset) / statements(text)）；`tool-postgres.tsx` 执行入口拆分 `executeRange(sql)`；CodeEditor 暴露光标/选区读写（已有 ref 基础）。
- **命令注册**：`database.query.run` / `runCurrent` / `runSelected` / `stop` / `selectCurrentStatement`（QUERY_EDITOR scope）。

---

## 5. Slice B：编辑工具（格式化/注释/参数/Find Builder）

### 5.1 用户故事

> 作为开发，我要一键把乱糟糟的 SQL 格式化成缩进清晰的形态、压缩成单行、用 Ctrl+/ 批量注释，用 `:name` 参数写可复用查询，并用 Find Builder 跨表找数据而不用手写一堆 LIKE。**[Fact]** 注释 Ctrl+/（M17 p.381，shortcuts.md Query editor 行）；QY-07 beautifier/minifier、QY-08 参数查询、QY-04 Find Builder 为 FM 级功能证据（内部细节 [UNVERIFIED]，以 [NexTerm] 规格落地）。

### 5.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 工具栏「格式化」/ **Ctrl+Shift+F**（query tab） | SQL 按 sql-formatter（PostgreSQL 方言）重排：主关键字（SELECT/FROM/WHERE/GROUP/ORDER/LIMIT 等）换行、子句块缩进；**光标保持在原光标所在语句的对应语句内**（按语句序号映射）；格式化为单事务，Ctrl+Z 一步还原 | 键位 [NexTerm]（Navicat 格式化键位无证据）；风格 [NexTerm]（D-B19-4） |
| 工具栏「压缩」 | 移除多余空白/换行折叠为单行（保留字符串与注释内空白）；同为单事务可撤销 | [NexTerm]（QY-07 minifier，FM 级证据） |
| **Ctrl+/** | 行注释切换：无选区=当前行；有选区=选中各行全部加 `-- `；已全部注释则取消（toggle）。沿用 CodeMirror `defaultKeymap` 的 Mod-/ 行为，**本批只验证不重写** | [Fact] M17 p.381；CM 行为确认 [NexTerm] |
| **参数查询** | 执行时（Ctrl+R / Ctrl+Shift+R）扫描 `:name`（跳过字符串/注释内出现）→ 弹参数对话框（名称/值两列表，记住本 tab 会话内上次值）→ 确认后 Rust 侧替换为安全字面量执行；无参数则不弹窗 | 语法 [FM/QY-08]；对话框/记忆 [NexTerm] |
| **Find Builder**（查询工具栏/Query 菜单入口） | 对话框：选 schema → 勾选表（≤5）→ 列（默认仅文本类列）→ 查找文本 + 匹配方式（包含 ILIKE / 前缀 / 精确，默认包含）→ Generate → **新 query tab** 生成多语句 SQL（每表一条 `SELECT * FROM t WHERE col ILIKE :find_n`），参数预填 → 用户 Ctrl+R 执行 | 入口存在 [FM/QY-04]；对话框 UI/生成语义 [NexTerm]（D-B19-5） |

### 5.3 Acceptance Criteria（AC-19B）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-19B-1 | 输入单行 `select a,b from t where x=1 order by a` → 按 **Ctrl+Shift+F** → 文本变为多行：`SELECT`/`FROM`/`WHERE`/`ORDER BY` 各起一行、子句相对缩进（快照断言格式化输出）；再按 Ctrl+Z **一步**恢复原文 | E2E + UT（格式化快照） |
| AC-19B-2 | 格式化前光标在第 2 条语句内 → 格式化后光标仍落在第 2 条语句文本内（语句序号映射，非字节偏移） | UT + E2E |
| AC-19B-3 | 「压缩」：格式化后的多行 SQL → 压缩 → 单行且语义等价（压缩后 Ctrl+R 执行成功）；字符串字面量 `'a  b'` 内空白保留；Ctrl+Z 一步还原 | UT + E2E |
| AC-19B-4 | **Ctrl+/**：无选区时注释当前行（行首 `-- `）；选中 3 行 → 全部注释；再 Ctrl+/ → 全部取消；`-- ` 与代码间保留一个空格 | E2E |
| AC-19B-5 | `SELECT * FROM t WHERE name = :pname AND age > :min_age` 按 Ctrl+R → 弹参数对话框列出 `pname`、`min_age` 两行（顺序稳定）；填值执行 → Rust 收到的 SQL 已替换为安全字面量、结果正确 | E2E |
| AC-19B-6 | 参数值注入防护：`:p` 值填 `x'; DROP TABLE t;--` → 执行后目标表完好、按字面值匹配（RT 断言替换产物为合法转义字面量；E2E 断言无副作用） | RT(SAF) + E2E(SAF) |
| AC-19B-7 | `:name` 出现在 `'字符串:xx'`、`-- 注释 :xx`、`/* :xx */` 内 → **不**识别为参数，不弹窗直接执行 | UT + E2E |
| AC-19B-8 | 参数对话框：取消 → 不执行；会话内再次执行同 SQL → 上次值预填；修改 SQL 中参数名 → 对话框列表同步 | E2E |
| AC-19B-9 | Find Builder：勾选 2 表 + 查找文本 `abc` → Generate → 新 query tab 出现 2 条 `SELECT ... WHERE <文本列> ILIKE :find_1/:find_2`，参数对话框预填 `%abc%` → Ctrl+R → 两结果语句顺序执行，结果含匹配行 | E2E |
| AC-19B-10 | Find Builder 生成 SQL 的标识符全部来自 catalog 元数据并按需引号转义（含大写/保留字表名 `"Users"`）；值只经 `:name` 通道，SQL 文本中无用户值拼接 | UT + RT(SAF) |
| AC-19B-11 | table tab 中不出现格式化/压缩/Find Builder/参数入口（D-B19-1 范围界定） | UT + VIS |

### 5.4 依赖分析

- 新依赖：`sql-formatter`（MIT，PG 方言）——**需架构确认**（R-B19-3）。
- Rust：参数替换器（`replace_parameters(sql, values) -> String`，含 tokenizer 扫描 + 字面量转义，复用 §4.3 M 系列同一文件域）；RT 覆盖转义/边界。
- 前端：`sql-parameters.ts`（扫描 :name，供对话框与预填）；`query-parameters-dialog.tsx`、`query-find-builder.tsx` 新组件；CodeEditor 增 format/minify 命令接线与光标映射。
- 命令注册：`database.query.format` / `minify` / `findBuilder` / `parameters`（QUERY_EDITOR）。

---

## 6. Slice C：效率工具（snippet/标识符面板/剪贴板栈/打开/缩放）

### 6.1 用户故事

> 作为开发，我要双击标识符面板把表/列名插进 SQL、用 snippet 一键展开常用骨架、Ctrl+Shift+V 粘贴最近复制过的片段、Ctrl+O 打开本地 .sql 文件、Ctrl+=/-/0 调编辑器字号——高频操作全部键鼠直达。**[Fact]** 标识符面板双击插入（IN-20 / Double Click Matrix「Query identifiers pane item」）；剪贴板栈 Ctrl+Shift+V、Ctrl+O、Ctrl+=/-/0（shortcuts.md Query/Query editor 行，M17 p.380-381）；snippet（FM/QY-02「completion and snippets」）。

### 6.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| **标识符面板**（query tab 侧栏，可折叠） | 树：schema → 表/视图 → 列（懒展开，复用 `PostgresCatalogLookup`）；双击表/视图插入关系名，双击列插入列名；面板顶部开关「限定名」=on 时插入 `schema.table` / `table.column` | 双击插入 [Fact IN-20]；树/开关/折叠 [NexTerm]（D-B19-6） |
| 标识符插入格式 | 标识符为小写常规名 → 裸名；含大写/空格/保留字 → `"Quoted"` | [NexTerm] |
| **snippet** | 补全：输入前缀（如 `ssf`）出现 snippet 项（标记 kind），Tab/Enter 插入展开多行骨架；管理：选中 SQL 右键/面板「保存为 Snippet」命名；内置集（SELECT * FROM / INNER JOIN ON / CTE / INSERT…VALUES / UPDATE…WHERE，PG 方言）；自定义存 localStorage（key `nexterm.sqlSnippets`） | 功能 [FM/QY-02]；触发词/内置集/存储 [NexTerm] |
| **Ctrl+Shift+V**（query tab 编辑器内） | 剪贴板栈弹层：编辑器内最近 20 条 copy/cut 内容（去重、最新在前）；点击/Enter 粘贴到光标；Esc 关闭。仅应用内编辑器自建栈，不读系统剪贴板历史 | 键位 [Fact M17 p.381]；栈实现 [NexTerm] |
| **Ctrl+O**（query tab） | 系统文件选择器（.sql）→ 内容替换当前编辑器（单事务，Ctrl+Z 可还原）；tab 标题不变 | 键位 [Fact M17 p.380]；加载语义 [NexTerm] |
| **Ctrl+= / Ctrl+- / Ctrl+0**（query tab 编辑器） | 编辑器字号 +1/-1px（范围 10-24，夹紧）、Ctrl+0 重置 14px；按连接持久化（localStorage） | 键位 [Fact M17 p.381]；范围/持久化 [NexTerm] |

### 6.3 Acceptance Criteria（AC-19C）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-19C-1 | 打开 query tab → 标识符面板列出当前 schema 的表与视图；展开表显示列（名称与 catalog 一致）；面板可折叠且状态按 tab 持久 | E2E |
| AC-19C-2 | 光标置于 SQL 中 → 双击面板中的表 `orders` → `orders` 插入光标处（不覆盖已有选区文本以外的内容）；双击列 `id` → 插入 `id` | E2E |
| AC-19C-3 | 「限定名」开关 on → 双击表插入 `public.orders`；双击列插入 `orders.id`；含大写的表 `Users` 任意模式下插入为 `"Users"` | UT + E2E |
| AC-19C-4 | 输入 `ssf` → 补全列表出现 snippet 项（与表/列补全同列表、带 kind 标记）→ Enter → 展开 `SELECT * FROM ` 骨架（多行 snippet 展开为多行） | E2E |
| AC-19C-5 | 选中一段 SQL → 保存为 snippet（命名 `mysel`）→ 新 tab 输入 `mysel` → 补全出现并可展开；重启应用后仍在（localStorage 持久化）；可删除 | E2E |
| AC-19C-6 | 编辑器内复制 `A`、复制 `B` → **Ctrl+Shift+V** → 弹层列表 [`B`, `A`]（最新在前、去重）→ 选 `A` → `A` 粘贴到光标；Esc 关闭不粘贴 | E2E |
| AC-19C-7 | **Ctrl+O** → 选择 fixture `.sql` 文件 → 编辑器内容替换为文件内容；Ctrl+Z 一步恢复替换前内容；tab 标题不变 | E2E |
| AC-19C-8 | **Ctrl+=** 三次 → 编辑器字号 +3px（DOM/计算样式断言）；**Ctrl+-** 回落；**Ctrl+0** 重置 14px；重开 tab 字号保持 | E2E |
| AC-19C-9 | 标识符面板/snippet/剪贴板栈/缩放仅作用于 query tab；table tab 网格无这些入口与键位（DATA_GRID 路由不命中） | UT + E2E |
| AC-19C-10 | 标识符面板在大 schema（≥200 对象）下滚动流畅（无逐项 IPC N+1；懒展开按需查询） | E2E(性能断言) |

### 6.4 依赖分析

- 新文件：`query-identifier-pane.tsx`、`query-snippets`（`src/lib/database/query-snippets.ts`：内置集 + localStorage CRUD）、CodeEditor 剪贴板栈/字号/插入 API。
- 命令注册：`database.query.insertIdentifier`（内部）/ `database.query.pasteFromStack` / `database.query.openFile` / `database.editor.zoomIn` / `zoomOut` / `zoomReset` / `database.query.saveSnippet`。
- 无 Rust 改动（数据复用 completion lookup）。

---

## 7. B20：快捷键 scope 体系 + 18 组绑定落地

### 7.1 用户故事

> 作为从 Navicat 迁移的开发，我要在数据库工作区内用全套 Navicat 肌肉记忆快捷键（Ctrl+R 运行、Ctrl+Shift+R 当前语句、Ctrl+T 停止、Ctrl+E 选语句、Alt+0..9 切结果、Ctrl+D 设计、Ctrl+Q 查询……），且这些键**绝不**干扰终端和全局布局键。

### 7.2 架构（决策 D2 落地，D-B20-1/2/3）

```
keydown（window, capture）
 ├─ xterm textarea？→ 透传（IME/终端保护，永不拦截）
 ├─ scope 解析（shortcut-scope.ts，按 DOM 焦点/对话框状态）：
 │    DIALOG > QUERY_EDITOR / DATA_GRID > (MODEL / ER_DIAGRAM 预留)
 │    > NAVIGATOR > DATABASE_WORKSPACE > GLOBAL(放行至现有全局注册器)
 ├─ 查当前 scope 的 (key → commandId) 绑定表（shortcut-router.ts）
 │    命中 → resolveDatabaseCommand 校验 enablement → enabled: preventDefault + dispatch
 │    disabled/hidden: 不 preventDefault（放行为普通按键）
 └─ 未命中 → 放行（终端/布局/浏览器默认）
```

- scope 判定基于焦点元素 `data-scope` 标记（workspace shell / navigator / result pane / CodeMirror 容器）+ 模态对话框开闭状态；`isEditableTarget` 既有守卫语义并入 QUERY_EDITOR 判定。
- 现有 `onDatabaseKeyDown` 的全部键位（Ctrl+N/Enter/Shift+E/W/S/R、Insert、F3、Esc-Find）**等价迁移**进绑定表，B17/B18 行为零变化（回归 AC-20-13/14）。

### 7.3 18 组绑定表（shortcuts.md 全量 → 本批落地状态）

| # | 组 | 键位 | scope | commandId | 本批状态 |
|---|---|---|---|---|---|
| 1 | 网格-设计对象 | Ctrl+D | DATA_GRID/NAVIGATOR | `database.object.design` | 注册（hidden：B23 表设计器上线激活） |
| 2 | 网格-查询对象 | Ctrl+Q | NAVIGATOR | `database.workspace.newQuery` | **激活** |
| 3 | 网格-查找/下一个/行 | Ctrl+F / F3 / (Ctrl+G) | DATA_GRID | `database.data.find` / `findNext` | **激活**（B18 已有，迁入路由表；Ctrl+G 不绑，B18 §7.3 排除） |
| 4 | 网格-应用过滤排序 | Ctrl+R | DATA_GRID | `database.data.refresh`（过滤重放语义） | **激活**（B18 语义等价迁移） |
| 5 | 网格-单元格编辑器 | Ctrl+Enter | DATA_GRID | `database.data.editCell` | **激活**（B17 已有，迁入路由表） |
| 6 | 网格-增/删记录 | Insert / Ctrl+Delete | DATA_GRID | `database.data.addRecord` / `deleteRecord` | **激活**（Ctrl+N 不用于网格增行：终端 wins，见冲突矩阵） |
| 7 | 网格-应用/放弃/停止 | Ctrl+S / Esc / Ctrl+T | DATA_GRID | `saveChanges` / `revertChanges` / `stop` | **激活**（仅 scope 内，全局不注册） |
| 8 | 网格-选择/复制/粘贴 | Ctrl+A / Shift+Arrow / Ctrl+C / Ctrl+V | DATA_GRID | 原生选择行为 | **激活**（scope 内保留浏览器行为，AC 只断言不破坏） |
| 9 | 查询-打开外部文件 | Ctrl+O | QUERY_EDITOR | `database.query.openFile` | **激活**（B19-C） |
| 10 | 查询-选择当前语句 | Ctrl+E | QUERY_EDITOR | `database.query.selectCurrentStatement` | **激活**（B19-A） |
| 11 | 查询-运行/当前/停止 | Ctrl+R / Ctrl+Shift+R / Ctrl+T | QUERY_EDITOR | `run` / `runCurrent` / `stop` | **激活**（B19-A） |
| 12 | 查询-结果 tab | Alt+0..9 | DATABASE_WORKSPACE | `database.query.selectResultTab(n)` | **激活**：单结果阶段=聚焦结果网格（多结果 tab 为 IN-22 后续批次，命令已注册不空键） |
| 13 | 查询-剪贴板栈 | Ctrl+Shift+V | QUERY_EDITOR | `database.query.pasteFromStack` | **激活**（B19-C；编辑器内接管） |
| 14 | 查询-注释 | Ctrl+/ | QUERY_EDITOR | CodeMirror Mod-/ | **激活**（保留 CM 行为，AC-20-10 验证） |
| 15 | 查询-缩放 | Ctrl+= / Ctrl+- / Ctrl+0 | QUERY_EDITOR | `zoomIn` / `zoomOut` / `zoomReset` | **激活**（B19-C） |
| 16 | ER-刷新/选择/移动 | F5 / Esc / H | ER_DIAGRAM | `database.er.*` | 注册占位（B24 激活；**全局 F5 不注册**） |
| 17 | ER-新建/删除 FK | R / Delete | ER_DIAGRAM | `database.er.*` | 注册占位（B24） |
| 18 | ER-缩放 | Ctrl+=/-/0 / Ctrl+滚轮 | ER_DIAGRAM | `database.er.*` | 注册占位（B24；与组 15 同键不同 scope，路由已隔离） |

> 依据：shortcuts.md 主表 18 行（M17 p.379-381）；macOS/Linux 列 UNVERIFIED——**macOS 以 ⌘ 等价为 [NexTerm] 产品决策**（沿用 `keyboard-shortcuts.ts` 现有 Ctrl→⌘ 机制），不声称官方 parity（风险 R2 沿用）。

### 7.4 冲突矩阵落地（主计划 §7.2/§7.3 → 路由测试固化）

| 键 | 全局动作 | 数据库动作 | 路由结论（固化为 UT） |
|---|---|---|---|
| Ctrl+N | 终端新会话 | （曾用于网格增行/新查询） | 终端/全局 wins；DATABASE_WORKSPACE 内=新查询 tab（现状迁移）；网格增行用 Insert（组 6） |
| Ctrl+R | 无全局注册 | 网格过滤重放 / 查询运行 | **按 scope 路由**：DATA_GRID→过滤重放，QUERY_EDITOR→运行 |
| Ctrl+T | 浏览器/应用标签风险 | 网格停止 / 查询停止 | **仅 DATA_GRID/QUERY_EDITOR scope 注册**，全局不注册；scope 内 preventDefault |
| Ctrl+Z | Zen mode（全局） | 编辑器撤销 | QUERY_EDITOR 内 CodeMirror 撤销 wins（scope 优先于全局）；网格外保持 Zen |
| Ctrl+Tab / Ctrl+Shift+Tab | 终端组切换 | 数据库 tab 切换 | 按聚焦 workspace 路由：数据库工作区=切数据库 tab，终端=终端组 |
| Ctrl+W | 关闭标签 | 数据库 tab 关闭（脏确认） | 数据库工作区=数据库 tab（B17 脏确认），终端=终端标签 |
| Ctrl+B/J/M/\\、Ctrl+1..9 | 终端/布局 | 无冲突 | 保留全局（数据库 scope 不注册） |
| F5 | 浏览器刷新风险 | ER 刷新 | 仅 ER_DIAGRAM scope（B24）；全局永不注册 F5 |
| Ctrl+Enter | — | 网格编辑器 / 查询执行 | DATA_GRID=单元格编辑器；QUERY_EDITOR=运行（现状迁移） |
| Alt+0..9 | 无 | 结果 tab | DATABASE_WORKSPACE scope 内接管 |

### 7.5 Acceptance Criteria（AC-20）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-20-1 | scope 解析单测矩阵：构造焦点在（对话框/编辑器/网格/导航器/工作区/终端/xterm）六类目标 → `resolveScope()` 返回符合 §7.2 优先级；全量用例绿 | UT |
| AC-20-2 | **xterm 硬守卫**：终端聚焦时按 Ctrl+R/Ctrl+T/Ctrl+N/Ctrl+E → 全部透传（终端内无 preventDefault，数据库命令零触发）；IME 组合键不受影响 | E2E + UT |
| AC-20-3 | 绑定表全量单测：18 组每组（键位, scope, commandId）三元组存在且可解析；本批激活组 enablement 联动 resolver（readOnly/断连/运行态禁用不触发） | UT |
| AC-20-4 | **Ctrl+R 双 scope**：同一工作区，网格聚焦=过滤重放/刷新（B18 语义），编辑器聚焦=运行查询；两 tab 各验证一次 | E2E |
| AC-20-5 | **Ctrl+N**：终端聚焦=新终端会话；DATABASE_WORKSPACE 聚焦=新查询 tab；网格聚焦**不**增行（增行走 Insert/Ctrl+Delete） | E2E |
| AC-20-6 | **Ctrl+S / Esc / Ctrl+T 仅 scope 内**：DATA_GRID=保存/放弃/停止（B17 回归）；QUERY_EDITOR 中 Ctrl+T=停止查询（AC-19A-4）；全局（非数据库工作区）按 Ctrl+T 不被拦截 | E2E |
| AC-20-7 | Ctrl+E：QUERY_EDITOR=选择当前语句（联动 AC-19A-1）；DATA_GRID/NAVIGATOR 不命中 | E2E |
| AC-20-8 | Alt+1 / Alt+0：DATABASE_WORKSPACE 聚焦 → 焦点移至结果网格（单结果阶段降级行为）；终端聚焦时 Alt+数字不被拦截 | E2E |
| AC-20-9 | Ctrl+Shift+V：QUERY_EDITOR=剪贴板栈弹层（AC-19C-6）；table tab 网格聚焦不命中（保持浏览器粘贴语义） | E2E |
| AC-20-10 | Ctrl+/：编辑器内行注释 toggle 生效（AC-19B-4）；非编辑器聚焦不拦截浏览器默认 | E2E |
| AC-20-11 | Ctrl+= / Ctrl+- / Ctrl+0：编辑器缩放生效（AC-19C-8）；非 QUERY_EDITOR 不拦截 | E2E |
| AC-20-12 | F5 全局未注册：非 ER 画布聚焦按 F5 保持浏览器默认（应用不刷新——E2E 断言无 reload）；ER 三组绑定处于 hidden 且不触发 | UT + E2E |
| AC-20-13 | **B17 网格回归**：Insert 增行 / Ctrl+S 保存 / Esc 放弃 / Ctrl+Enter 编辑器 / Ctrl+W 脏确认，行为与迁移前一致（等价迁移证明） | E2E(REG) |
| AC-20-14 | **B18 浏览回归**：table tab Ctrl+F / F3 / Esc-Find / Ctrl+R 过滤重放行为不变；焦点守卫（编辑 input 内 Ctrl+F 走浏览器默认）不变 | E2E(REG) |
| AC-20-15 | **DIALOG 优先**：任意对话框（连接编辑/过滤/参数/Find Builder）打开时，Ctrl+R/Ctrl+T 等不穿透到底层编辑器/网格；Esc 只关对话框 | E2E |
| AC-20-16 | Ctrl+D / Ctrl+Q：NAVIGATOR 聚焦 Ctrl+Q=打开新查询 tab（激活）；Ctrl+D 命令 hidden（无设计器）按下的确无动作 | E2E |
| AC-20-17 | macOS ⌘ 等价：⌘R/⌘Shift+R/⌘T/⌘E 与 Windows Ctrl 行为一致（`formatKeyboardShortcut` 现有机制沿用；平台 smoke） | UT + E2E(平台) |
| AC-20-18 | 终端快捷键全量回归：终端组 Ctrl+1..9/Ctrl+\/Ctrl+Shift+\ / Ctrl+Tab/Ctrl+W / Ctrl+B/J/M/Z 在终端聚焦下行为不变 | E2E(REG) |

---

## 8. 并行开发文件边界（fe-dev ↔ fe-dev2 防冲突）

> 原则：**每个文件任一时刻只有一个所有者**；CTO 裁定（D-B20-4）：`tool-postgres.tsx` 与 `code-editor.tsx` 归 **fe-dev 全程**（B19 组件改动大头 + Rust 新命令 API 上下文在 fe-dev 手里）；fe-dev2 **严格 lib 层**（shortcut-scope / shortcut-router / bindings / command-registry 的 scope 扩展），符合 architect D-B20-5。

### 8.1 阶段划分（依赖序，非时间估计）

| 阶段 | 内容 | 所有者 |
|---|---|---|
| **P0 契约冻结** | 命令 id 清单（§7.3 + B19 各 Slice）与类型契约（`result-types`/`query-editor` 扩展）冻结；`sql-formatter` 依赖决策；快捷键 combo 定稿（CTO 裁定 ③）同步 fe-dev2 bindings.ts | 双方对齐（pm 主持，已完成） |
| **P1 并行** | **fe-dev**：Rust（取消/参数/`postgres_save_table_changes` 复合命令）+ `sql-statement.ts`/`sql-parameters.ts`/`query-snippets.ts` + 新对话框组件 + `code-editor.tsx`（editorRef 扩展）+ `tool-postgres.tsx` 内 `onDatabaseKeyDown` **一次性等价迁移**与 B19 接线（**单一所有者，无交接窗口**）；**fe-dev2**：`shortcut-scope.ts`/`shortcut-router.ts`/bindings + `command-registry.ts` scope 扩展（严格 lib 层，**不碰 tool-postgres.tsx / code-editor.tsx / i18n，键位清单提交 fe-dev**） | fe-dev ∥ fe-dev2 |
| **P2 联调** | fe-dev：tool-postgres.tsx 接入 router 分发（handler 注册到 fe-dev2 的 lib API）；fe-dev2：navigator/workspace-shell/result-pane 的 scope 标记 + 冲突矩阵 UT + 快捷键 E2E | fe-dev ∥ fe-dev2 |
| **P3 收口** | E2E 全量 / 视觉门禁 / REG / 台账更新（§11） | 共同（qa 主导） |

### 8.2 文件所有权表

| 文件 | P1 所有者 | P2 起所有者 |
|---|---|---|
| `src-tauri/src/postgres.rs`、`commands.rs`、`lib.rs`（取消/参数/复合保存命令） | fe-dev | fe-dev |
| `src/lib/database/sql-statement.ts`（新）、`sql-parameters.ts`（新）、`query-snippets.ts`（新） | fe-dev | fe-dev |
| `src/components/code-editor.tsx`（SQL 扩展：格式化/注释验证/剪贴板栈/缩放/插入/snippet 补全源/editorRef 扩展） | **fe-dev（全程）** | fe-dev |
| `src/components/toolbox/tool-postgres.tsx`（迁移 + B19 三 Slice 接线 + 复合保存调用替换） | **fe-dev（全程，CTO 裁定）** | fe-dev |
| `src/components/toolbox/query-identifier-pane.tsx`、`query-parameters-dialog.tsx`、`query-find-builder.tsx`（新） | fe-dev | fe-dev |
| `src/lib/database/command-registry.ts`（scope 扩展 + B19 命令 descriptor） | **fe-dev2（严格 lib 层）** | fe-dev2 |
| `src/lib/database/shortcut-scope.ts`、`shortcut-router.ts`、bindings（新） | fe-dev2 | fe-dev2 |
| `src/lib/keyboard-shortcuts.ts`（仅导出复用；全局层语义不动） | fe-dev2 | fe-dev2 |
| `src/components/toolbox/database-workspace-shell.tsx`、`database-navigator.tsx`、`database-result-pane.tsx`（scope 标记/焦点属性） | fe-dev2 | fe-dev2 |
| `src/lib/i18n.ts` | **fe-dev 独占全程**（fe-dev2 提交键清单，不直接改文件） | fe-dev |
| `e2e/desktop/postgres-query-commands.e2e.ts`（新） | — | fe-dev |
| `e2e/desktop/postgres-shortcuts.e2e.ts`（新） | — | fe-dev2 |
| `src/lib/__tests__/sql-*.test.ts`、`query-snippets.test.ts` | fe-dev | fe-dev |
| `src/lib/__tests__/shortcut-scope.test.ts`、`shortcut-router.test.ts` | fe-dev2 | fe-dev2 |
| Rust 测试（`postgres.rs` 内 #[cfg(test)]） | fe-dev | fe-dev |

冲突协调规则：任何跨边界小改动（如 fe-dev 需要 router 暴露 API）→ SendMessage 直连对方 + 在任务备注登记，禁止直接改对方文件。`tool-postgres.tsx` 自 P1 起单所有者（fe-dev），fe-dev2 需要其接入 router 分发时以 lib API + 键位清单交接，不改文件。

---

## 9. 验收方法代号与测试矩阵

### 9.1 代号

| 代号 | 含义 |
|---|---|
| **UT** | vitest 单测（`pnpm test`） |
| **RT** | Rust 单测（`cargo test`） |
| **E2E** | 原生桌面 E2E（WDIO，真实 PG Docker fixture） |
| **(SAF)** | 安全护栏断言（注入/事务/并发/悬空事务；挂在 UT/RT/E2E 内） |
| **(REG)** | 既有行为回归断言（B17/B18/终端） |
| **VIS** | 视觉门禁：dark/light/960×700 + 截图 |
| **GATE** | 全量回归四件套 + i18n：`pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check` |

### 9.1.1 qa 测试计划 AC 编号映射（qa 用 AC-B19-1..14 / AC-B20-x 占位编号，验收轮回填）

> qa 测试计划先行使用了占位编号（AC-B19-1..14），与本计划正式编号（AC-19A/B/C-x、AC-20-x）对照如下；qa 验收记录回填时以**本计划编号为准**，占位编号仅作检索桥接。若 qa 计划某条在本表无对应（或反之），以本计划为准并在 qa 计划补齐差异后更新此表。

| qa 占位编号 | 本计划正式编号 | 覆盖内容 |
|---|---|---|
| AC-B19-1 | AC-19A-1 | Ctrl+E 选当前语句 + Ctrl+Shift+R 执行 |
| AC-B19-2 | AC-19A-2 | 运行选中文本 |
| AC-B19-3 | AC-19A-3 | 语句切分边界（字符串/注释/dollar-quote） |
| AC-B19-4 | AC-19A-4 | Ctrl+T 停止（UI ≤2s 恢复） |
| AC-B19-5 | AC-19A-5 | 服务端确认取消 |
| AC-B19-6 | AC-19A-6 + AC-19A-7 | 运行三态 UI + Ctrl+R 整段回归 |
| AC-B19-7 | AC-19A-8 | M2 复合保存命令（形态 B）三断言 |
| AC-B19-8 | AC-19A-9 | M3 行数校验→整体回滚 |
| AC-B19-9 | AC-19A-10 | M4 COMMIT 失败主动 ROLLBACK |
| AC-B19-10 | AC-19B-1 + AC-19B-2 + AC-19B-3 | 格式化/光标映射/压缩 |
| AC-B19-11 | AC-19B-4 | Ctrl+/ 注释 toggle |
| AC-B19-12 | AC-19B-5..8 | 参数查询（弹窗/注入防护/边界/记忆） |
| AC-B19-13 | AC-19B-9 + AC-19B-10 | Find Builder 生成与安全 |
| AC-B19-14 | AC-19C-1..10 | 效率工具（snippet/标识符面板/剪贴板栈/打开/缩放） |
| （B20 对应） | AC-20-1..18 | qa 计划若用 AC-B20-x 占位，同样按本编号对照 |

### 9.2 测试矩阵（对 Master Plan §8.1）

| 类别 | 必交证据 |
|---|---|
| Unit（UT） | 语句切分（四类边界/多语句/光标定位）、参数扫描（字符串/注释内跳过）、格式化快照与光标映射、snippet CRUD/持久化、scope 解析矩阵、绑定表 18 组三元组、冲突矩阵路由（Ctrl+N/R/T/Z/Tab/W/F5）、enablement 联动 |
| Rust（RT） | 参数替换与转义（注入样例）、取消路径、M2 复合保存命令（保存期间并发普通 SQL 不受影响、`transaction_status` 前置检测拒绝、成功/失败路径）、M3 count==1（0 行报错→整体 ROLLBACK）、M4 COMMIT 失败自动 ROLLBACK、单语句护栏沿用 |
| Integration | Tauri IPC × PG fixture：带参执行/取消/事务错误路径/Find Builder 生成 SQL 执行 |
| Browser 组件 | 参数对话框/Find Builder/标识符面板/剪贴板栈弹层渲染回归（不构成 parity） |
| 原生 GUI E2E | AC-19A-1..12、AC-19B-1..11、AC-19C-1..10、AC-20-2/4..18 全量（fixture 见下） |
| Safety | AC-19A-8/9/10、AC-19B-6/10、AC-20-12 |
| 视觉门禁（VIS） | 查询工具栏（Run/Stop/格式化/Find Builder）、参数对话框、Find Builder、标识符面板、snippet 管理、剪贴板栈弹层、dark/light/小窗 |
| 全量回归（GATE） | 四件套 + i18n + B17/B18/终端 E2E 套件 |

**E2E fixture（新增）**：
```sql
CREATE TABLE query_fixture (
  id serial PRIMARY KEY,
  name text,
  note text,
  score numeric
);
INSERT ... 20 行（含大写表名伴表 "Users" 验证引号插入）;
-- 停止测试: SELECT pg_sleep(15)
-- M3 并发测试: 外部连接 DELETE 后 Apply
```

---

## 10. 完成定义（DoD）

1. **AC 全量通过**：AC-19A-1..12、AC-19B-1..11、AC-19C-1..10、AC-20-1..18（共 51 项）按 §9.1 代号验证留档。
2. **安全债清零**：M2（形态 B 复合命令）/M3/M4 按主计划 §11.5 归还并各有 RT/E2E 证据；security 专家复核 PASS。
3. **迁移等价**：`onDatabaseKeyDown` → 路由器等价迁移有 REG 证据（AC-20-13/14/18）。
4. **终端零回归**：终端快捷键/IME 全量 E2E 通过（约束 §1.3）。
5. **视觉门禁**：§9.2 VIS 项截图归档。
6. **GATE 全绿**：`pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check`。
7. **台账更新**（合入 main 后同步）：`navicat-parity-master-plan.md` §6（B19/B20 状态 + §2.2 Scorecard）、`navicat-premium-feature-matrix.md`（QY-01/02/04/07/08）、`navicat-premium-interactions.md`（IN-18/20/21/22）、`navicat-premium-shortcuts.md`（NexTerm 列 + 冲突审计列）、`database-development-status.md`、CHANGELOG（Unreleased → v2.8.0）、AGENTS.md。

---

## 11. 与 v2.8.0 发布的关联（收官 M1）

| 项 | 说明 |
|---|---|
| 里程碑 | M1「日常核心 Parity」= B17（网格编辑闭环，已合入）+ B18（数据浏览，核心已实现、E2E/VIS 收尾）+ **B19+B20（本批）** |
| 版本 | 本批合入 main + 台账/CHANGELOG 更新后，M1 冻结 → `pnpm run version:minor` 发 **v2.8.0** |
| 发布门禁 | 全量 GATE + 受影响 E2E（含 B17/B18 套件补跑，B18 遗留 E2E 由 qa 并行收口）+ 五方发布评审（产品/架构/安全/QA/Release，§8.2）；打包验证不强制（2026-08-26 用户决策沿用）；R9（B18 E2E 环境不稳）按 RISK 记录或关闭 |
| 发布内容叙事 | 「NexTerm 数据库工具箱达成 Navicat 日常核心 parity：网格编辑、数据浏览、查询工作台、全套 Navicat 快捷键」——Shortcut Parity 0% → 18 组落地（Master Plan §2.2 Scorecard 更新） |
| 不含 | M2 起的对象设计器/ER/导入导出等（B21+）；AI/BI/Collab（产品排除） |

---

## 12. 风险与开放问题

| # | 风险/问题 | 等级 | 缓解 / 决策 |
|---|---|---|---|
| R-B19-1 | 查询取消依赖 tokio-postgres cancel 能力；若不可行需连接重建降级（代价：取消后重连） | 中 | P1 首日由 fe-dev 做 API 可行性 spike，结论同步 cto；AC-19A-4/5 只认行为不锁实现 |
| R-B19-2 | 参数替换 tokenizer 与语句切分 tokenizer 需同一套词法（字符串/注释/dollar-quote），两处实现漂移 | 中 | 共用 `sql-statement.ts` 单一 tokenizer，参数扫描复用其扫描结果（UT 共用样例） |
| R-B19-3 | `sql-formatter` 新依赖引入（体积/风格/维护度） | 低 | MIT、PG 方言成熟；架构评审 P0 决策；若拒则降级自写最小格式化器（范围缩至换行+缩进两档） |
| R-B19-4 | sql-formatter 重排后光标只能语句级映射，非精确列偏移 | 低 | AC-19B-2 明确为语句序号映射（用户示例「光标位置保持」按此定义），文档标注 |
| R-B19-5 | ~~M2 事务互斥使查询报错可感知~~（**已消解**：CTO 裁定形态 B 后保存事务单命令闭合，查询不再被拒绝）；残留点：手动事务前置检测报错需用户理解（提示文案需指明 COMMIT/ROLLBACK 出口） | 低（原中） | 错误文案明确（「连接存在未关闭的手动事务，请先 COMMIT/ROLLBACK」）；E2E 覆盖拒绝与恢复路径（AC-19A-8③） |
| R-B20-1 | 等价迁移遗漏既有键位语义（B17/B18 回归面大） | 中 | 迁移前先固化迁移快照测试（现有键位行为 UT 化），再替换实现；AC-20-13/14/18 把关 |
| R-B20-2 | scope 判定依赖 DOM 焦点标记，网格内嵌 input（单元格编辑）与 QUERY_EDITOR 判定易混 | 中 | `isEditableTarget` 并入 scope 判定单测；单元格编辑中 DATA_GRID 键位（Ctrl+S）仍需命中的用例显式覆盖（B17 行为） |
| R-B20-3 | macOS ⌘ 等价为产品决策，无官方 parity 证据（主计划 R2 沿用） | 中 | 文档与 UI 提示统一标注；不声称官方 parity |
| R-B20-4 | Alt+0..9 在部分平台与系统快捷键冲突（如 macOS 菜单助记） | 低 | DATABASE_WORKSPACE scope 内 preventDefault；平台 smoke 覆盖 |
| R-B20-5 | ~~`tool-postgres.tsx` 双人交接冲突~~（**已消解**：CTO 裁定该文件 P1 起归 fe-dev 单一所有者）；残留点：fe-dev 迁移 keydown 与 B19 接线同文件叠加，fe-dev2 的 lib API 若变更会波及接线 | 低（原中） | 单所有者硬约束；lib API 契约 P0 冻结（§7.3 + 附录命令清单）；fe-dev2 变更 API 须 SendMessage 同步 fe-dev |
| O-1 | 剪贴板栈是否需要跨 tab/跨连接共享 | 开放 | 默认按 provider 工作区共享（单栈）；用户反馈后调整 |
| O-2 | Find Builder 生成多语句后单结果聚合展示的可读性（多表命中混在一个网格） | 开放 | P2 评估「消息 tab + 逐语句结果」展示（依赖 IN-22 多结果，后续批次） |
| O-3 | Ctrl+G（Go to Row）是否随 B20 落地 | 开放 | 维持 B18 §7.3 排除结论（UI 细节 [UNVERIFIED]）；本批不绑 |

---

## 附：B19+B20 命令注册清单（command-registry 新增，P0 冻结）

```
database.query.run                  QUERY_EDITOR   （现状迁移）
database.query.runCurrent           QUERY_EDITOR   B19-A
database.query.runSelected          QUERY_EDITOR   B19-A（选中优先语义并入 runCurrent，独立 id 便于菜单）
database.query.stop                 QUERY_EDITOR + DATA_GRID   B19-A / B17 迁移
database.query.selectCurrentStatement QUERY_EDITOR B19-A
database.query.format               QUERY_EDITOR   B19-B
database.query.minify               QUERY_EDITOR   B19-B
database.query.findBuilder          QUERY_EDITOR   B19-B
database.query.parameters           QUERY_EDITOR   B19-B（执行时自动触发，命令用于重开对话框）
database.query.openFile             QUERY_EDITOR   B19-C
database.query.pasteFromStack       QUERY_EDITOR   B19-C
database.query.saveSnippet          QUERY_EDITOR   B19-C
database.query.insertIdentifier     QUERY_EDITOR   B19-C（内部）
database.query.selectResultTab      DATABASE_WORKSPACE  B20 组 12
database.editor.zoomIn/zoomOut/zoomReset QUERY_EDITOR  B19-C
database.data.find / findNext       DATA_GRID      B18 迁移（B20 组 3）
database.data.editCell              DATA_GRID      B17 迁移（B20 组 5）
database.object.design              DATA_GRID/NAVIGATOR  B20 组 1（hidden 至 B23）
database.er.refresh/select/move/newFK/deleteFK/zoom*  ER_DIAGRAM  B20 组 16-18（hidden 至 B24）
```

**Rust IPC 新增/变更（fe-dev，P0 契约冻结）**：

```
postgres_save_table_changes   新增（M2 形态 B 复合命令：BEGIN→语句→count 校验→COMMIT/ROLLBACK，
                               含 transaction_status 前置检测；M3/M4 唯一落点）
postgres_cancel_query         新增（查询取消，AC-19A-4/5 行为验收）
postgres_execute              变更（可选 parameters 替换通道）
postgres_transaction          保留（手动事务用途；B17 三段式保存调用替换为复合命令）
```
