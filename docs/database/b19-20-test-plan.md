# B19+B20「查询命令 + 快捷键 Scope 体系」测试计划（QA）

> 作者：qa（严过关）｜2026-08-26
> 依据：`navicat-parity-master-plan.md` §6 B19/B20 条目、§7 快捷键路由与 18 组绑定、§8 质量门禁、§10 R9、§11.5 安全债 M2/M3/M4；`navicat-premium-shortcuts.md`（18 组 + 冲突矩阵 + scope 架构）
> 参照：`b18-filter-test-plan.md`（分层方法）；`b18-slice-a-qa-report.md`（E2E-BUG-1/2 教训、缺口 G-1..G-5 归属 B19）
> 现状基线：`keyboard-shortcuts.ts`（全局注册器 + macOS Ctrl→⌘ 等价 + ignoreInTerminal）、`command-registry.ts`（QUERY_EDITOR/DATA_GRID 等 5 scope）、`tool-postgres.tsx:1223` onDatabaseKeyDown（Insert/F3/Esc/Ctrl+F/N/Enter/Shift+E/W/S/R）
> 状态：PLANNING——AC 编号为占位（对齐主规划条目设计），待 pm `batch-19-20-sprint-plan.md` 发布后由 team-lead 对齐回填；E2E 全部 DEFERRED（R9）

---

## 0. 总原则

1. **测试先行于实现**：Rust 纯函数抽取（M2 锁表 / M3 count 校验 / M4 事务善后决策）、语句切分器、scope 路由器、绑定表均可先写测试后实现（fe-dev/fe-dev2 按本计划 §2/§3 的函数契约落地）。
2. **无真实 PG 的单测策略**：只测**纯决策/纯数据结构层**（锁语义、count 判定、善后动作决策、SQL 切分、路由决策），不伪造 Client、不引 mock 框架；真实数据库行为一律归 E2E（DEFERRED）。
3. **选择器契约**：凡 E2E spec 必须引用**已对照真实 DOM 核验**的 data-testid，禁止估算（E2E-BUG-1/2 教训，见 §6.2）。
4. **R9**：本批 E2E 只编写不执行，标记 DEFERRED，与 B17/B18 E2E 一并等稳定环境批量补跑（§7）。

---

## 1. 分层策略总览

| 层 | 被测对象 | 用例形态 | 本批状态 |
|---|---|---|---|
| Rust 单测（cargo） | 安全债 M2 事务互斥锁表、M3 受影响行数校验、M4 事务善后决策；语句超时/取消句柄表（若实现采用） | `cargo test postgres` | 可先行 |
| vitest 纯函数 | SQL 语句切分器（当前语句/选中）、scope 路由器（D2 优先级链）、快捷键绑定表（18 组注册完整性/唯一性/危险键护栏）、macOS ⌘ 映射、命令 registry 扩展 enablement | `src/lib/__tests__/` | 可先行 |
| 组件/集成 | 查询 tab 状态机（running/stop/format 入口） | 依赖 G-3 组件测试基建，本批视基建落地补 | 部分 |
| 原生 E2E | B19 查询命令全链路 + B20 快捷键路由（真实 PG fixture 127.0.0.1:55432） | WDIO spec | **编写不执行，DEFERRED（R9）** |
| 回归 | B17 编辑闭环 / B18 过滤查找布局 / 终端快捷键 / i18n parity / 全量四件套 | 既有测试 + 清单核对 | 验收必跑 |

---

## 2. Rust 单测设计（安全债 M2/M3/M4，无真实 PG）

> 落点均为 `src-tauri/src/postgres.rs`。共同模式：**把可测语义抽成纯函数/纯结构体**，`#[tauri::command]` 薄壳只做 IO 组装；单测只打纯层。真实 PG 上的端到端事务行为归 E2E（DEFERRED）。

### 2.1 M2 per-connection 事务互斥锁（现状：`PostgresState.clients` @ postgres.rs:25 无互斥）

建议实现形态：`TransactionLocks`（`HashMap<String, Arc<tokio::sync::Mutex<()>>>`，按 connection_id 一把锁；事务命令 begin→commit/rollback 全程持锁，普通 `postgres_execute`/`postgres_table_update` 等持同一把锁短临界区）。

| # | 用例 | 断言 |
|---|---|---|
| M2-1 | 同一 connection_id 并发 acquire 串行化 | 两个 tokio 任务 + 屏障：临界区内观察到的并发度 == 1 |
| M2-2 | 不同 connection_id 互不阻塞 | 两连接各自 acquire 后均能同时进入（并发度 == 2） |
| M2-3 | guard drop 后锁释放 | 事务正常结束/出错路径（提前 `?` 返回）后可立即再次 acquire |
| M2-4 | disconnect 清理锁表项 | `remove(conn_id)` 后 map 无残留（防长期运行泄漏） |
| M2-5 | 事务持锁期间普通 SQL 排队不交错 | 以锁语义模拟：事务任务持锁 sleep，普通任务等待后进入；断言进入顺序（先事务后普通） |

> 说明：M2-5 只验证**锁序语义**，不连真实 PG；「事务中执行普通 SQL 被误回滚」的真实场景由 E2E 补（DEFERRED，场景 E-12）。

### 2.2 M3 受影响行数 count==1 校验（现状：`postgres_table_update` :1253 直接 execute 不看返回值；delete 同）

建议实现形态：纯函数 `validate_affected_rows(count: u64, schema: &str, table: &str) -> Result<(), String>`（update/delete 共用）。

| # | 用例 | 断言 |
|---|---|---|
| M3-1 | count == 1 | Ok |
| M3-2 | count == 0 | Err，消息含「行已被删除或主键变更」语义 + 表名（并发丢失更新不再静默） |
| M3-3 | count > 1 | Err（PK 定位理论上唯一，>1 视为异常并拒绝） |
| M3-4 | 校验失败上抛后触发批量回滚 | 决策函数返回 Err 即可（回滚由前端保存流程 + M4 善后兜底）；断言 Err 字符串可被前端 toast 展示（无嵌套吞并） |
| M3-5 | insert 不走该校验（返回生成 PK，语义不同） | 走 `PostgresTableInsertResult` 路径，回归既有 insert 单测 |

### 2.3 M4 commit 失败主动 ROLLBACK（现状：`postgres_transaction` :673 纯 action 字符串 match，commit 失败后前端 rollback 失败被吞）

建议实现形态：纯决策函数 `plan_transaction_followup(action: &str, result: &Result<(), String>) -> Followup`，`Followup = Done | Rollback | RollbackAndReport { commit_err, rollback_err }`；命令壳按 Followup 执行第二条语句并**合并错误上抛**。

| # | 用例 | 断言 |
|---|---|---|
| M4-1 | commit Ok | `Done`，不发 ROLLBACK |
| M4-2 | commit Err | `Rollback`（主动善后，事务不悬空） |
| M4-3 | ROLLBACK 也失败 | `RollbackAndReport`，两段错误都出现在最终 Err（不吞 rollback 失败） |
| M4-4 | begin Err | `Done`（无需善后）+ 锁已释放（配合 M2-3） |
| M4-5 | rollback 显式调用 Err | 错误原样上抛（不被 followup 二次包裹成误导信息） |
| M4-6 | 未知 action | Err "Unsupported PostgreSQL transaction action"（回归 ：688 现状） |

### 2.4 语句执行取消（B19「停止」，若实现含 Rust 侧句柄/超时表）

现状 `postgres_execute` 已有 `QUERY_TIMEOUT` 超时（:594）。若停止采用「前端 AbortSignal + Rust 句柄注册表」或 `pg_cancel_backend` 方案：句柄注册/注销/取消标记的**纯表语义**按 M2 同模式测（注册后可标记取消、断开连接清理、重复取消幂等）。若采用纯前端方案（不等待 invoke），则只做 vitest（§3.1 SQ-9）。**实现方案定稿后由 fe-dev 在 PR 描述中回填本节**。

---

## 3. vitest 纯函数测试设计

### 3.1 SQL 语句切分器（B19 执行控制核心，建议新模块 `src/lib/database/sql-statements.ts`）

| # | 用例 | 断言 |
|---|---|---|
| SQ-1 | 多语句按 `;` 切分 | `select 1; select 2;` → 2 条；尾部空语句丢弃 |
| SQ-2 | 单引号字符串内的 `;` 不切分 | `'a;b'` 保持完整；`''` 转义处理 |
| SQ-3 | E'…' 与 `$$…$$`/`$tag$…$tag$` dollar quoting | 内部 `;` 均不切分；tag 不匹配的 `$tag$` 按普通文本 |
| SQ-4 | 注释 `--` 行注释与 `/* */` 块注释内 `;` 不切分 | PG 块注释嵌套按实现决策锁定（建议支持嵌套，测试锁定行为并注释说明） |
| SQ-5 | 当前语句 = 光标所在语句 | 光标在第 2 条语句内 → 返回第 2 条（AC-B19-2 占位） |
| SQ-6 | 光标在语句边界（分号上/空白处） | 归属规则锁定（建议：向后归属下一条非空语句；末尾归属最后一条） |
| SQ-7 | 有选区时优先选区 | 非空 selection → 返回选区文本（运行选中，AC-B19-3 占位） |
| SQ-8 | 全空白/无语句 | 返回 null，执行入口 no-op（不发送空 SQL） |
| SQ-9 | 停止状态机（若纯前端方案） | idle→running→stopRequested→idle；stop 后 running=false、result 保持上次、再次运行正常 |
| SQ-10 | 大小写/换行容错 | `SELECT\n1 ;` 与混合换行正常切分 |

### 3.2 scope 路由器（D2 优先级链，建议新模块 `src/lib/database/shortcut-scope.ts`）

优先级：`DIALOG > QUERY_EDITOR / DATA_GRID > MODEL / ER_DIAGRAM > NAVIGATOR > DATABASE_WORKSPACE > GLOBAL`（master plan §7.1）。

| # | 用例 | 断言 |
|---|---|---|
| SC-1 | xterm textarea 聚焦 → 终端透传 | 任何数据库绑定不命中（IME/终端保护，硬约束） |
| SC-2 | 对话框开启 → DIALOG 胜出 | 即使焦点在编辑器/网格，数据库 scope 绑定让路 |
| SC-3 | 焦点在 CodeMirror 查询编辑器 → QUERY_EDITOR | 命中查询命令组 |
| SC-4 | 焦点在结果网格 → DATA_GRID | 命中网格命令组 |
| SC-5 | 焦点在导航器 → NAVIGATOR | 命中导航器组 |
| SC-6 | 数据库工作区无更细焦点 → DATABASE_WORKSPACE | 命中工作区组（Alt+0..9） |
| SC-7 | 非数据库工作区（终端区）→ GLOBAL | 数据库绑定全部不注册/不命中 |
| SC-8 | 路由输入是纯数据 | `resolveShortcutScope({dialogOpen, activeElement, workspace})` 无副作用（同输入同输出，可表驱动全组合） |

### 3.3 快捷键绑定表（18 组注册完整性 + 护栏，建议 `src/lib/database/shortcut-bindings.ts` 声明式表）

表驱动测试：每行 = 组号 + 键 + scope + command id + 终端策略。

| # | 用例 | 断言 |
|---|---|---|
| SB-1 | 18 组全量注册 | 对照 master plan §7.2 逐组存在，无遗漏 |
| SB-2 | 同 scope 内键位唯一 | 同 scope 出现重复组合 → 测试失败（防止实现内冲突） |
| SB-3 | Ctrl+R 跨 scope 路由 | DATA_GRID=应用过滤、QUERY_EDITOR=运行查询；两 scope 各自正确、互不串扰 |
| SB-4 | Ctrl+N 护栏 | 仅 DATA_GRID 注册「新增记录」；GLOBAL/终端 scope 不注册（终端新会话 wins）；当前 `onDatabaseKeyDown` 的 Ctrl+N=createQuery 行为按 B20 决策迁移并在测试中锁定新语义 |
| SB-5 | Ctrl+T 护栏 | 仅 DATA_GRID/QUERY_EDITOR 注册（停止）；GLOBAL 不注册（浏览器/应用标签风险） |
| SB-6 | F5 护栏 | 仅 ER_DIAGRAM 注册；GLOBAL 永不注册（F5 不得刷新应用） |
| SB-7 | Esc 语义分层 | DATA_GRID=放弃编辑、QUERY_EDITOR 查找场景=关查找、DIALOG=关对话框；按 scope 各归其位 |
| SB-8 | Alt+0..9 | DATABASE_WORKSPACE 注册 10 个结果 tab 切换；index 越界（无对应 tab）由调用方忽略 |
| SB-9 | 网格选择/复制/粘贴组 | Ctrl+A / Shift+Arrow / Ctrl+C / Ctrl+V 仅 DATA_GRID 接管；非网格保留浏览器默认 |
| SB-10 | ER 三组（F5/Esc/H、R/Delete、Ctrl+=/-/0/滚轮） | 注册于 ER_DIAGRAM；B24 画布落地前仅注册表级验证（E2E 归 B24 后补） |

### 3.4 macOS ⌘ 映射（复用 `keyboard-shortcuts.ts` 既有语义）

| # | 用例 | 断言 |
|---|---|---|
| CM-1 | 数据库绑定以 Ctrl 声明，mac 上 ⌘+X 命中 | 复用 `ctrlOrCmd` 等价逻辑（keyboard-shortcuts.ts:266）；绑定表不自造第二套匹配 |
| CM-2 | `formatKeyboardShortcut` 显示 | mac → `⌘R`、`⌘⇧R`；win/linux → `Ctrl+R` |
| CM-3 | 显式 meta 声明不被 DB 绑定误用 | DB 绑定全部走 ctrl 声明路径（usesExplicitMeta 分支不触发） |
| CM-4 | ignoreInTerminal 语义保持 | 终端聚焦时绑定不触发（与 SC-1 呼应，注册器层测试） |

### 3.5 命令 registry 扩展（B19 新命令 enablement）

| # | 用例 | 断言 |
|---|---|---|
| CR-1 | `database.query.runCurrentStatement` / `runSelection` / `stop` / `formatSql` / `commentToggle` / `openFile` / `insertSnippet` / `paramQuery` 等新命令（名称以实现为准） | QUERY_EDITOR + connected 下 enabled |
| CR-2 | readOnly 连接 | 执行/停止/格式化等读与编辑器操作不拦截（readOnly 只挡写库，编辑器文本操作不受限；参数查询执行按现有 execute 语义回归） |
| CR-3 | 错 scope hidden | DATA_GRID 下查询命令 hidden（wrong-scope）；QUERY_EDITOR 下网格命令 hidden |
| CR-4 | disconnected | 执行类 disabled（connection-state） |
| CR-5 | 标识符面板/Find Builder 若作为命令 | NAVIGATOR/QUERY_EDITOR 归属 scope 正确 |

### 3.6 B18 遗留缺口归位（b18-slice-a-qa-report.md §3，归属 B19 项）

| # | 用例 | 断言 |
|---|---|---|
| BG-2 | `buildFieldValueFilter(column, value)` 纯函数（G-2） | value=null → isNull 运算符；非 null → eq；offset 归 0 |
| BG-4 | `typingInField`/快捷键分发守卫抽纯函数（G-4） | input/textarea/CodeMirror 聚焦时网格快捷键不接管 |
| BG-5 | query tab 反证（G-5） | query tab 的网格上下文菜单不含过滤项（命令层 hidden 已测，UI 层随 E2E 补） |
| BG-3 | 组件级测试基建（G-3） | 本批若引入 RTL/组件测试则覆盖 filter 副作用路径；否则维持 E2E 承接（DEFERRED） |

---

## 4. B19 测试用例 ↔ Slice 映射（AC 占位，待 pm 计划对齐）

> AC 编号 `AC-B19-x` 为占位，映射主规划 §6 B19 条目与 §4 US-04；pm `batch-19-20-sprint-plan.md` 发布后由 team-lead 组织回填对齐，本表结构不变。

### 4.1 Slice A 执行控制

| 能力（主规划条目） | AC 占位 | Rust | vitest | E2E（DEFERRED） |
|---|---|---|---|---|
| 运行当前语句 Ctrl+Shift+R | AC-B19-1 | — | SQ-1/5/6（切分+定位）、CR-1 | E-1：编辑器两条语句，光标在第 2 条 → 仅第 2 条结果返回 |
| 选中即运行（选区优先） | AC-B19-2 | — | SQ-7 | E-2：选中文本执行选区 |
| 停止 Ctrl+T（运行中） | AC-B19-3 | §2.4（视实现方案） | SQ-9 三态、SB-5 | E-3：`select pg_sleep(30)` 运行中 → 停止 → running 消除、无结果残留、可再次运行 |
| 当前语句选中高亮 Ctrl+E | AC-B19-4 | — | SQ-5（同一定位函数） | E-4：Ctrl+E → 编辑器选中当前语句文本 |
| 事务安全（安全债） | AC-B19-5 | M2-1..5、M3-1..5、M4-1..6 | — | E-12：事务保存中途失败 → 回滚生效（DEFERRED） |

### 4.2 Slice B 编辑工具

| 能力 | AC 占位 | Rust | vitest | E2E（DEFERRED） |
|---|---|---|---|---|
| 格式化 / 压缩 SQL | AC-B19-6 | — | 格式化纯函数（若自研；若引库则锁定库输出快照：关键字大写/缩进/压缩单行） | E-5：点格式化 → 编辑器文本变为预期形态（快照比对） |
| Ctrl+/ 注释切换 | AC-B19-7 | — | SB-1（注册）；CodeMirror toggleComment 行为锁定 | E-6：行注释加/去往返 |
| Ctrl+O 打开外部文件 | AC-B19-8 | — | 命令注册 CR-1 | 原生文件对话框 E2E 不稳定 → **人工脚本清单**（M-1），不入 WDIO |
| 剪贴板栈 Ctrl+Shift+V | AC-B19-9 | — | 栈语义纯函数（push/pop/上限） | E-7：多次复制 → Ctrl+Shift+V 依栈序粘贴 |

### 4.3 Slice C 效率工具

| 能力 | AC 占位 | Rust | vitest | E2E（DEFERRED） |
|---|---|---|---|---|
| 参数查询（:name 占位 → 提示输入 → 绑定执行） | AC-B19-10 | 参数绑定走既有参数化路径（回归） | 占位符扫描纯函数（:name 检出/去重/字符串内忽略） | E-8：含 `:min` 的 SQL → 参数对话框 → 输入 → 结果正确 |
| snippet 插入 | AC-B19-11 | — | snippet 表 + 插入点（光标/选区替换）纯函数 | E-9：选 snippet → 模板插入光标处 |
| 标识符面板（双击插入编辑器） | AC-B19-12 | — | CR-5（命令归属） | E-10：面板双击列名 → 编辑器光标处插入标识符 |
| Find Builder | AC-B19-13 | — | 条件→SQL 构造纯函数（复用 B18 filter 条件模型，禁止拼裸 SQL） | E-11：构建 `name like` 条件 → 生成 SQL 且可执行 |
| 结果 tab Alt+0..9 | AC-B19-14 | — | SB-8 | E-13：多结果 → Alt+2 切至第 2 个 |

---

## 5. B20 快捷键测试（18 组逐组路由）

### 5.1 逐组路由矩阵（vitest 表驱动 + E2E 抽样）

| 组 | 键 | 注册 scope | 让路场景（必须不触发） | 单测 | E2E |
|---|---|---|---|---|---|
| 1 网格-设计对象 | Ctrl+D | DATA_GRID / NAVIGATOR | 终端聚焦、QUERY_EDITOR、GLOBAL | SB-1/2 | —（B23 设计器落地前命令禁用态） |
| 2 网格-查询对象 | Ctrl+Q | NAVIGATOR | 网格/编辑器聚焦 | SB-1/2 | E-14 |
| 3 网格-查找/下一个/行 | Ctrl+F / F3 / Ctrl+G | DATA_GRID | 终端、QUERY_EDITOR（编辑器自带查找组 15） | SB-1/9 | E-15（Ctrl+F 开查找 + F3 下一个，B18 回归） |
| 4 网格-应用过滤排序 | Ctrl+R | DATA_GRID | QUERY_EDITOR（=运行查询）、终端 | SB-3 | E-16 |
| 5 网格-单元格编辑器 | Ctrl+Enter | DATA_GRID | QUERY_EDITOR（=执行） | SB-1/2 | E-17 |
| 6 网格-增/删记录 | Insert 或 Ctrl+N / Ctrl+Delete | DATA_GRID | **终端 Ctrl+N 新会话 wins**；非网格 Ctrl+N 保持新建查询（B20 决策锁定） | SB-4 | E-18 |
| 7 网格-应用/放弃/停止 | Ctrl+S / Esc / Ctrl+T | DATA_GRID（+QUERY_EDITOR 停止） | GLOBAL 不注册 Ctrl+T；DIALOG 的 Esc 归对话框 | SB-5/7 | E-19 |
| 8 网格-选择/复制/粘贴 | Ctrl+A、Shift+Arrow、Ctrl+C/V | DATA_GRID | 非网格保留浏览器默认 | SB-9 | E-20 |
| 9 查询-打开外部文件 | Ctrl+O | QUERY_EDITOR | 终端、GLOBAL | SB-1 | 人工 M-1 |
| 10 查询-当前语句 | Ctrl+E | QUERY_EDITOR | DATA_GRID（=设计对象组 1 的 Ctrl+D 类似让路原则；Ctrl+E 仅编辑器） | SB-1/2 | E-4 |
| 11 查询-运行/当前/停止 | Ctrl+R / Ctrl+Shift+R / Ctrl+T | QUERY_EDITOR | DATA_GRID 的 Ctrl+R（=过滤）；终端 | SB-3/5 | E-1/E-3/E-21 |
| 12 查询-结果 tab | Alt+0..9 | DATABASE_WORKSPACE | 终端、系统 Alt 组合 | SB-8 | E-13 |
| 13 查询-剪贴板栈 | Ctrl+Shift+V | QUERY_EDITOR | 系统粘贴（非编辑器） | SB-1 | E-7 |
| 14 查询-注释 | Ctrl+/ | QUERY_EDITOR | 终端、GLOBAL | SB-1 | E-6 |
| 15 查询-缩放 | Ctrl+= / Ctrl+- / Ctrl+0 | QUERY_EDITOR | 全局缩放（应用级）不劫持 | SB-1/2 | E-22（字号变化 DOM 断言） |
| 16 ER-刷新/选择/移动 | F5 / Esc / H | ER_DIAGRAM | **全局 F5 不注册**；DIALOG Esc | SB-6/7 | B24 后补（画布未落地） |
| 17 ER-新建/删除 FK | R / Delete | ER_DIAGRAM | 单字母键不泄漏到其他 scope（输入框/编辑器内 R 必须正常输入） | SB-10 | B24 后补 |
| 18 ER-缩放 | Ctrl+=/-/0、Ctrl+滚轮 | ER_DIAGRAM | 与组 15 同键不同 scope 路由正确 | SB-10/2 | B24 后补 |

### 5.2 冲突回归（终端零影响）

| # | 用例 | 断言 |
|---|---|---|
| TR-1 | 终端聚焦时按全部 18 组键 | 无一被数据库层拦截（SC-1 + 集成冒烟：xterm textarea 内 Ctrl+R/Ctrl+N/Ctrl+T/F5 均走终端/浏览器） |
| TR-2 | 既有终端/布局快捷键回归 | Ctrl+N 新会话、Ctrl+W 关标签、Ctrl+Tab 切组、Ctrl+B/J/M、Ctrl+Z zen、Ctrl+\ 分屏在终端 scope 行为不变（`createSplitViewShortcuts`/`createLayoutShortcuts` 既有测试 + 新增路由断言） |
| TR-3 | Ctrl+Z 在 QUERY_EDITOR | 编辑器撤销 wins（zen 不触发）；DATA_GRID 内编辑态同理让路 |
| TR-4 | IME 组合键 | 输入法激活/组合中不触发任何数据库命令（路由器对 isComposing 直接透传——建议纳入实现并在 SC-8 锁定） |
| TR-5 | 数据库工作区 vs 终端区切换 | 聚焦切换后路由即时生效（无残留上一次 scope 的处理器——注册随 scope 激活/失活，shortcuts.md 架构要求） |

### 5.3 macOS ⌘ 映射

- CM-1..4（§3.4）；E2E 抽样 E-23：mac 上 ⌘R 在编辑器=运行、网格=过滤（DEFERRED，CI mac runner 补跑时验证）。
- 风险 R2 登记：macOS Navicat 官方键位 UNVERIFIED，⌘ 映射为产品决策——测试只锁定「Ctrl 声明 ↔ ⌘ 触发」等价正确，不声称官方 parity。

---

## 6. E2E 场景清单与选择器契约（全部 DEFERRED，R9）

### 6.1 场景清单（spec 骨架，fixture 同 B17/B18：127.0.0.1:55432 / nexterm_e2e）

| # | 场景 | 关键断言 | 关联 |
|---|---|---|---|
| E-1 | 运行当前语句 | 编辑器 `select 1; select 2;` 光标在第 2 条 → 结果仅 2 | AC-B19-1 |
| E-2 | 运行选中 | 选区文本执行 | AC-B19-2 |
| E-3 | 停止 | pg_sleep(30) → 停止按钮/Ctrl+T → running 消除、可再运行 | AC-B19-3 |
| E-4 | Ctrl+E 当前语句高亮 | 编辑器选区=当前语句 | AC-B19-4 |
| E-5 | 格式化/压缩 | 编辑器文本快照比对 | AC-B19-6 |
| E-6 | Ctrl+/ 注释往返 | 行前缀 `--` 加/去 | AC-B19-7 |
| E-7 | 剪贴板栈 | 多次复制 → Ctrl+Shift+V 栈序粘贴 | AC-B19-9 |
| E-8 | 参数查询 | `:min` 对话框 → 绑定值生效 | AC-B19-10 |
| E-9 | snippet 插入 | 光标处出现模板 | AC-B19-11 |
| E-10 | 标识符面板双击 | 编辑器插入标识符 | AC-B19-12 |
| E-11 | Find Builder | 条件→SQL→可执行 | AC-B19-13 |
| E-12 | 事务安全（M2/M3/M4 真库） | 中途失败整批回滚、count!=1 报错 | AC-B19-5 |
| E-13 | Alt+0..9 结果 tab | 切换激活 tab | AC-B19-14 |
| E-14 | Ctrl+Q 新查询 | 导航器聚焦 → 新查询 tab | 组 2 |
| E-15 | Ctrl+F/F3 网格查找 | 开查找 + 下一个（B18 回归） | 组 3 |
| E-16 | Ctrl+R 网格=过滤 | 网格聚焦重放过滤；编辑器聚焦=运行（同键双 scope 抽样） | 组 4/11 |
| E-17 | Ctrl+Enter 单元格编辑器 | 网格内开编辑器 | 组 5 |
| E-18 | Ctrl+N 路由 | 网格=增行；终端=新会话（终端 wins） | 组 6 |
| E-19 | Ctrl+S/Esc 网格 | 保存/放弃语义（B17 回归） | 组 7 |
| E-20 | 网格 Ctrl+A/C/V | 网格接管、非网格浏览器默认 | 组 8 |
| E-21 | Ctrl+Shift+R 编辑器 | 运行当前语句 E2E 形态 | 组 11 |
| E-22 | 编辑器缩放 | 字号 DOM 变化 | 组 15 |
| E-23 | mac ⌘ 等价抽样 | ⌘R/⌘F 等价 Ctrl 路由 | §5.3 |
| M-1 | Ctrl+O 文件对话框 | **人工脚本清单**（原生对话框不稳定，不入 WDIO） | 组 9 |

### 6.2 选择器契约（强制，E2E-BUG-1/2 教训固化为流程）

1. **禁止估算**：spec 只允许引用已对照真实 DOM 核验的 data-testid；B19/B20 新 UI 的 spec 在 fe-dev 合入后编写/修正，不先写预估版。
2. **testid 清单随实现交付**：fe-dev/fe-dev2 的 PR 必须附「新增 data-testid 清单」，列入本批 DoD；qa 按 DOM 复核后回填本节 §6.3。
3. **命名约定（供 fe-dev 落地参考，非 spec 依据）**：沿用 `postgres-*` 前缀——建议 `postgres-stop`、`postgres-format`、`postgres-comment-toggle`、`postgres-params-dialog`、`postgres-snippet-menu`、`postgres-identifier-panel`、`postgres-result-tab-{i}`、`postgres-clipboard-stack`；scope 层 `database-scope-root`（路由挂载点）。
4. **已核验存在的 testid**（来自现状 DOM 与既有 spec）：`postgres-workspace`、`postgres-run`、`postgres-new-connection`、`postgres-connection-dialog`、`postgres-new-query`、`postgres-filter-badge`、`postgres-clear-filter`、`postgres-add-record`、`postgres-save-changes`、`postgres-revert-changes`、`postgres-refresh`、`postgres-connect`、`postgres-disconnect`、`database-result-find-input`、`database-result-context-menu`。
5. **execute 闭包纪律**：`browser.execute` 回调内联选择器字符串，禁止引用外部常量（E2E-BUG-2）；沿用 B18 修复版惯例——`switchWindow` 4 次重试、相对断言、`browser.execute` 页内计算、`this.timeout(150000)`、`Date.now()` 唯一值。

---

## 7. R9 策略与回归清单

### 7.1 R9（E2E 环境不稳定）

- 本批全部 E2E（§6.1）**只编写不执行**，spec 文件头标注 `DEFERRED (R9)`（沿用 postgres-filter.e2e.ts 头注格式）。
- 补跑清单（稳定环境/CI 就绪后批量）：B17 `postgres-grid-edit`、B18 `postgres-filter`（含修 E2E-BUG 后复跑）、B19/B20 本批全部 spec；建议 CI 可选 job 沿用 `scripts/ssh-fixture.sh` 思路（主规划 R3）。
- 发布评审（v2.8.0，任务 #31）按 **READY WITH RISK** 评估：产品逻辑以 Rust/vitest 全绿 + qa 代码走查证据托底，E2E 欠账显式登记。

### 7.2 回归清单（验收必跑 + 核对）

| 域 | 项目 |
|---|---|
| 全量四件套 | `pnpm test`（vitest）、`cargo test`、`tsc --noEmit`、`pnpm lint`、`i18n:check` |
| B17 编辑闭环 | 既有 Rust insert/delete/update 护栏单测、`postgres-storage` tab 状态测试、M2/M3/M4 落地后**保存事务路径回归**（锁表不改变既有单语句行为）、Ctrl+S/Esc/Insert 快捷键行为锁定（组 5/6/7 迁移后不回归） |
| B18 过滤/查找/列布局 | `table-filter` / `find-matches` / `grid-layout-storage` 测试全绿；Ctrl+R 新旧语义兼容（DATA_GRID 内仍=过滤重放/刷新，E-15/E-16）；Find/Escape 路径与新 Esc 分层（SB-7）不冲突 |
| 终端快捷键 | TR-1..TR-5；`createSplitViewShortcuts`/`createLayoutShortcuts` 既有测试不动、新增 scope 路由断言 |
| i18n parity | B19/B20 新增键 zh/en 全对齐（沿用 B18 报告 §1.3 的扁平 key 比对法，含 `{{param}}` 占位符一致） |
| 命令 registry | `database-command-registry.test.ts` 扩展后既有 34 命令断言不回归 |
| 视觉门禁 | B19/B20 改动可见 UI：dark/light/960×700 截图（主规划 §8.1 Permanent Visual Quality Gate） |

### 7.3 依赖与协作点

| 项 | 说明 |
|---|---|
| 等 pm | AC 占位（§4）待 `batch-19-20-sprint-plan.md` 对齐回填；切片若增删，§4 表按行增删不影响结构 |
| 等 fe-dev | §2 Rust 纯函数契约（M2/M3/M4 抽取形态）与 §6.2.3 testid 命名约定先行给到，实现按契约落 |
| 等 fe-dev2 | §3.2/§3.3 路由器与绑定表模块名以实现定稿为准；表驱动测试可先按本计划写 |
| 停止方案分叉 | §2.4/§3.1 SQ-9 二选一，fe-dev 定稿后回填（PR 描述） |

---

## 8. 覆盖统计（计划态）

| 层 | 计划用例数 |
|---|---|
| Rust 单测 | M2 5 + M3 5 + M4 6 + 取消视方案 ≈ 16+ |
| vitest | SQ 10 + SC 8 + SB 10 + CM 4 + CR 5 + BG 4 ≈ 41 |
| E2E 场景（DEFERRED） | 23 + 人工 1 |
| 回归 | 四件套 + 6 域清单 |
