# B19/B20 安全约束（实现前红线）

> 作者：security（安无恙）｜2026-08-26
> 适用：fe-dev 实现 B19「查询命令 + M2/M3/M4 安全债」、fe-dev2 实现 B20「快捷键 scope 体系」时必须遵守的实现前安全约束。
> 依据：`navicat-parity-master-plan.md` §6 B19/B20、§11.5（B17 遗留 M2/M3/M4）；现状代码 `src-tauri/src/postgres.rs`、`src/components/toolbox/tool-postgres.tsx`、`src/lib/database/command-registry.ts`；B18 红线基线 `b18-filter-security-constraints.md`。
> 性质：**只写约束，不改产品代码**。每条标注 [MUST]（硬红线，违反即打回）或 [SHOULD]（建议，偏离需说明理由）。与架构约束文档冲突时以本文红线为准；红线间冲突报 team-lead 裁决，不自行放宽。

---

## 0. 威胁模型速览（B19/B20 新增面）

| # | 面 | 风险 | 约束章节 |
|---|---|---|---|
| N-1 | 事务窗口并发（M2） | 自动保存 BEGIN..COMMIT 跨多次 IPC，期间普通 SQL 插入会毒化/误回滚事务 | §1 |
| N-2 | 静默丢更新（M3） | 并发行被删/改时 update/delete 影响 0 行或 >1 行而无人察觉 | §2 |
| N-3 | 事务悬空（M4） | commit/rollback 失败被吞，连接持锁悬空，锁死表 | §3 |
| N-4 | 语句切分 | 在注释/字符串/dollar-quote 内错误切分 → 执行了用户不打算执行的语句片段 | §4.1 |
| N-5 | 停止查询 | 取消不落底（UI 停了服务端还在跑）或取消机制死锁 | §4.2 |
| N-6 | 参数查询 | $n 填值走字符串替换 → SQL 注入 | §4.3 |
| N-7 | snippet/格式化 | 引入 eval/shell/网络面 | §4.4 |
| N-8 | 快捷键绕过 | keydown 直调 invoke() 绕过 enablement（readOnly/断连/running 态失守） | §5 |

现状缺陷证据（B19 顺带修复，见对应章节）：
- `postgres_table_update`/`postgres_table_insert`/`postgres_table_delete` 的 `client.execute()` **均未包 QUERY_TIMEOUT**（postgres.rs:1253、:1300、:1344）→ §1.6。
- `postgres_execute` 超时后仅放弃 future，**服务端查询仍在跑**（postgres.rs:594）→ §4.2。
- `saveTableChanges` 的 rollback `.catch(() => undefined)` 吞错（tool-postgres.tsx:1203-1205）→ §3。

---

## 1. M2：per-connection 事务互斥（N-1）

### 1.1 状态结构 [MUST]

`PostgresState`（postgres.rs:24）新增三张表，与 `clients` 同生命周期管理（connect 时建、disconnect 时清）：

```rust
pub struct PostgresState {
    clients: RwLock<HashMap<String, Arc<Client>>>,
    /// 每连接单飞锁：任何语句命令执行期间持有，序列化协议层交错
    txn_locks: RwLock<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// 事务模式登记：None=无事务；Some("save")=自动保存中；Some("manual")=手动事务
    /// （借用 connection_manager.rs:22 active_transfers 的 Mutex-registry 先例）
    txn_modes: RwLock<HashMap<String, String>>,
    /// 每连接 backend pid + 运行中查询的取消句柄（§4.2 用）
    backends: RwLock<HashMap<String, PostgresBackendInfo>>,
}
```

- `postgres_disconnect`（postgres.rs:567）**必须**同时清理上述三表中该 connection_id 的条目（含锁、模式、pid、取消句柄）。[MUST]
- 锁的持有方式：跨 IPC 保存事务用 `lock_owned()` 产生的 `OwnedMutexGuard` 存入 state（或采用 §1.5 形态 B 则不需要跨调用持锁）。[MUST：不得用 `std::sync::Mutex` 跨 await]

### 1.2 持锁规则（函数级）[MUST]

| 命令 | 无事务时 | save 事务进行中 | manual 事务进行中 |
|---|---|---|---|
| `postgres_transaction(begin)` | 获取锁→登记模式→放锁 | **拒绝**："transaction already in progress (save)" | **拒绝**："transaction already in progress (manual)"（PG 本身也拒绝嵌套 BEGIN） |
| `postgres_transaction(commit/rollback)` | 正常执行（PG 容忍） | 执行语句→清模式→放锁 | 同左 |
| `postgres_table_update/insert/delete` | 正常执行（单语句持锁） | **允许**（它们是保存事务的参与者，saveTableChanges 在 begin..commit 之间调用它们） | 允许 |
| `postgres_execute` / `postgres_explain` / `postgres_table_data` / `postgres_catalog_*` | 正常执行（单语句持锁） | **拒绝**："a grid-save transaction is in progress on this connection; wait for it to finish"（防毒化：任意语句出错会把整个事务打成 aborted） | **允许**（手动事务中用户跑语句是本意，同 psql 语义） |
| B19 新命令（当前语句/选中/参数化执行，§4） | 正常执行（单语句持锁） | **拒绝**（同上） | 允许 |
| `postgres_query_cancel`（§4.2） | **不取锁** | **不取锁** | **不取锁** |

**死锁红线**：`postgres_query_cancel` 及一切取消/超时清理路径**永远不得获取该连接的 `txn_locks` 锁**——运行中的查询正持有它，取消路径等锁 = 必然死锁。[MUST]

### 1.3 "参与者 vs 外来语" 判定 [MUST]

- 参与者仅限：`postgres_table_update` / `postgres_table_insert` / `postgres_table_delete`（它们只被保存链路调用，独立调用时无事务也合法）。
- manual 模式下 `postgres_execute` 等放行的理由：手动 BEGIN/COMMIT/ROLLBACK 按钮已存在（tool-postgres.tsx:1568 附近），用户在事务中有意执行语句是既有产品语义，不因 M2 收紧而回退。
- save 模式的登记/清除只能由 `postgres_transaction` 的 begin/commit/rollback（或形态 B 的复合命令）驱动；**禁止**其他命令写 `txn_modes`。

### 1.4 拒绝语义 [MUST]

- save 事务进行中对外来命令返回**立即错误**（fail-fast），**不得**无限 await 等锁——UI 挂死比报错更糟。错误信息须可行动（提示用户等待保存完成）。
- 前端配合：`saving` 状态下禁用会触发外来命令的入口（查询编辑器执行、表数据刷新等），后端拒绝是兜底而非唯一防线。[SHOULD]

### 1.5 实现形态（二选一，安全属性等价）

**形态 A（master plan §11.5 原案）**：`postgres_transaction(begin)` 以 `try_lock`/`lock_owned` 持锁并把 guard 存入 state，commit/rollback 执行语句后 drop guard。持锁跨越全部 IPC 往返。
- 细节 [MUST]：guard 存放于 state 内 `HashMap<String, OwnedMutexGuard<()>>`；commit/rollback 无论成败最终必须 drop guard（含错误路径）；disconnect 清理时 drop。
- 风险提示：guard 生命周期横跨 IPC，panic/disconnect 清理必须测试覆盖。

**形态 B（推荐，[SHOULD] 采用）**：新增复合命令 `postgres_save_table_changes(request)`，把 BEGIN + 全部 update/insert/delete + COMMIT 收进**单个 Rust 命令**内完成；前端 `saveTableChanges`（tool-postgres.tsx:1065-1212）改调它，删除自己的 BEGIN/COMMIT 编排。
- 收益：跨 IPC 事务窗口从结构上消失（M2 自动满足），M4 的"Rust 侧主动 ROLLBACK"有唯一落点，顺带减少 IPC 往返。
- 若采用形态 B，§1.2 表中 save 列的拒绝规则仍需保留（复合命令持锁期间外来命令照拒），§2/§3 的校验落在复合命令内部。

### 1.6 顺带修复：写路径超时 [MUST]

`postgres_table_update`（:1253）、`postgres_table_insert`（:1300）、`postgres_table_delete`（:1344）的 `client.execute()/query_one()` 必须包 `tokio::time::timeout(QUERY_TIMEOUT, ...)`，与 `postgres_execute` 一致。超时后的处理遵循 §4.2 的取消语义（取消或拆除），不得只报错留悬挂查询。

### 1.7 测试与验收（M2）

| 用例 | 期望 |
|---|---|
| Rust 集成测试：save 事务进行中并发调用 `postgres_execute` | 返回 "transaction in progress" 错误；事务本身不受影响、可正常 commit |
| save 事务中依次调用 update/insert/delete | 全部成功执行在事务内（参与者放行） |
| manual begin 后执行 `postgres_execute` | 放行（psql 语义） |
| 双重 begin | 第二次返回明确错误 |
| commit 后再调外来命令 | 放行（模式已清） |
| disconnect 时事务挂起 | 三张表全部清理，无锁/pid 残留；重连后可用 |
| 死锁回归：查询运行中调用 `postgres_query_cancel` | 立即返回，不等待查询锁 |
| update/insert/delete 超时包装 | 超时返回错误且连接按 §4.2 清理 |

---

## 2. M3：受影响行数校验（N-2）

### 2.1 校验位置（函数级）[MUST]

- `postgres_table_update`：`client.execute(&statement, &params)` 之后（postgres.rs:1253），对返回的 `u64` 判定：

```rust
let affected = client.execute(...).await?;
if affected != 1 {
    return Err(format!(
        "UPDATE affected {affected} row(s), expected exactly 1; the row was changed or deleted by another session (transaction rolled back)"
    ));
}
```

- `postgres_table_delete`：同模式，在 :1344 的 execute 之后。
- INSERT 无需 count 校验（失败自然报错，RETURNING 路径已覆盖）。
- 形态 B：校验落在复合命令内的每行语句之后，**第一处 count!=1 即整体 Err → 触发回滚**（§3）。

### 2.2 禁止行为 [MUST]

- **禁止**把 count!=1 当成功静默返回（现状 `Ok(count)` 把 0 行也当成功——这就是 M3）。
- **禁止**在前端才校验行数（IPC 边界是权威判定点；前端拿不到可靠 count 语义）。
- **禁止**对 >1 行"多删多改放行"——PK 定位谓词影响多行本身异常，必须报错。

### 2.3 测试与验收（M3）

| 用例 | 期望 |
|---|---|
| Rust 集成测试：连接 A 读出基线 → 连接 B 删除该行 → A 执行 update/delete | 返回 count!=1 错误；错误信息含实际影响行数；事务回滚（表内其余变更未生效） |
| 正常单行 update/delete | count==1，成功 |
| E2E：两个窗口并发编辑同一行 | 后保存方收到明确报错，无静默丢失 |

---

## 3. M4：事务失败主动 ROLLBACK（N-3）

### 3.1 ROLLBACK 时机（函数级）[MUST]

按失败点分层，**每一层都必须落地**：

1. **`postgres_transaction` 的 commit 路径**（postgres.rs:672-694）：`COMMIT` 执行失败时，Rust 侧必须在返回错误前**主动执行一次 `ROLLBACK`**（PG 语义：失败事务已 aborted，此时 ROLLBACK 总能成功清理），然后清理 `txn_modes` 并释放 guard。错误信息链上原始 COMMIT 失败原因。[MUST]
2. **保存链路中任一语句失败**（update/insert/delete 报错，含 M3 的 count!=1）：
   - 形态 A：该失败沿 IPC 返回前端，前端 rollback——但**后端兜底**：`postgres_table_update/insert/delete` 在返回错误时若检测到 `txn_modes` 为 save，**必须**在错误路径上主动 ROLLBACK 再返回（不信任前端一定会来 rollback）。[MUST]
   - 形态 B：复合命令内部 catch 一切语句错误 → ROLLBACK → 返回聚合错误。[MUST]
3. **ROLLBACK 本身失败或超时**（连接已坏）：**拆除连接**——从 `clients` 移除该 `Arc<Client>`（drop 触发 TCP 关闭，服务端断连即回滚，这是唯一可靠兜底），清理三张表，返回错误注明 "connection reset to clear a stuck transaction"。[MUST]
4. **超时路径**（§1.6/§4.2）：事务内语句超时 → 走取消；取消不成 → 拆除连接（同第 3 条）。[MUST]

### 3.2 前端配合 [MUST]

- `saveTableChanges` catch 块（tool-postgres.tsx:1202-1208）的 rollback **禁止** `.catch(() => undefined)` 静默吞错：rollback 失败必须并入 toast 错误展示（"回滚失败，连接将被重置"），让用户知道事务可能未清理。
- 手动事务面板的 rollback 按钮（:1568）失败同样必须展示错误。[MUST]
- 形态 B 下前端不再有自己的 rollback 调用（消失即正确）。

### 3.3 语义细节 [MUST]

- 主动 ROLLBACK 必须幂等安全：对已 aborted 事务 ROLLBACK 合法；对已无事务（前面已清）ROLLBACK 产生 warning 不算失败，忽略即可。
- `txn_modes` 清理与 guard 释放必须在**所有**路径（成功/失败/超时/拆除）发生——建议用 RAII guard（drop 时清 mode + 释放锁）杜绝遗漏。

### 3.4 测试与验收（M4）

| 用例 | 期望 |
|---|---|
| manual：BEGIN → 执行非法语句（打 aborted）→ COMMIT 失败 | Rust 自动 ROLLBACK；随后 `postgres_execute("SELECT 1")` 正常（无 "current transaction is aborted" 残留） |
| 保存中语句失败（形态 B 或 A 兜底） | 服务端已回滚；`SELECT` 验证半成品数据不存在 |
| ROLLBACK 失败注入（测试中断开 socket） | client 从 `clients` 移除；下一次命令报 "connection is not active"；PG 侧确认事务已因断连回滚 |
| 前端 rollback 失败 | toast 展示错误而非静默 |

---

## 4. B19 查询命令新增面

### 4.1 当前语句 / 运行选中（N-4）

**定位**：查询编辑器本就执行任意 SQL（产品功能），因此这里的红线不是"限制 SQL 内容"，而是**保证执行的语句 = 用户意图的语句**：切分错误 = 执行了用户不打算执行的片段（完整性风险）。

#### 4.1.1 切分器状态机 [MUST]

- 语句边界扫描**必须**是带状态机的词法扫描（扩展现有 `single_statement`，postgres.rs:987-1034 的逻辑），覆盖：

| 状态 | 进入 | 退出 | 分号切分？ |
|---|---|---|---|
| 行注释 `--` | `--` | `\n` | 否 |
| 块注释 `/* */` | `/*` | `*/`（**嵌套计数**，PG 支持嵌套） | 否 |
| 单引号字符串 `'…'` | `'` | 未跟随 `'` 的 `'`（`''` 转义续留） | 否 |
| 双引号标识符 `"…"` | `"` | 未跟随 `"` 的 `"` | 否 |
| dollar-quote `$tag$…$tag$` | `$$` 或 `$tag$`（tag 限 `[A-Za-z_][A-Za-z0-9_]*`，大小写敏感回看匹配） | 相同 tag 的 `$…$` | 否 |
| 默认 | — | — | **是**（仅默认态的分号是边界） |

- **dollar-quote 是 [MUST]**：`CREATE FUNCTION … AS $$ … ; … $$` 是 PG 日常写法，B17 现有 `single_statement` 未覆盖（当时仅服务 EXPLAIN，可接受；B19 切分器必须补上，否则函数体被拦腰切断执行半截 DDL）。
- E-string（`E'…\'…'` 反斜杠转义）为 [SHOULD]：不实现则须在文档/CHANGELOG 记录已知局限（`E'\''` 会被误判闭合）。不允许静默。
- 实现位置二选一：前端 TS（CodeMirror 光标在手）或后端 Rust（执行边界）。**同一算法只允许一份实现**；若前后端都需要（前端定位、后端复用），必须共享**黄金测试向量**（同一组输入→输出断言，vitest 与 cargo test 双跑）。[MUST]

#### 4.1.2 黄金向量（最低覆盖）[MUST]

至少覆盖：`SELECT 1; SELECT 2`（2 条）；`SELECT ';' AS v`（1 条）；`-- ;\nSELECT 1`（1 条）；`/* ; */ SELECT 1`（1 条）；嵌套 `/* /* ; */ */ SELECT 1`（1 条）；`SELECT $$;$$`（1 条）；`$fn$ ; $fn$ SELECT 1`（1 条，tag 不匹配不闭合）；`CREATE FUNCTION f() … AS $body$ … ; … $body$ LANGUAGE sql`（1 条）；空语句 `;;;`（0 条）；尾随分号（N 条）。新增向量必须双侧同步添加。

#### 4.1.3 语句定位与执行红线 [MUST]

- **"当前语句"** = 光标所在的语句区间（光标落在边界分号上时取结束于该分号的语句）；光标在末尾空白处取最后一条非空语句；无任何语句 → 返回错误/no-op，不得执行。
- **"运行选中"**：选区非空时**逐字执行选区原文**——不做切分、不做 trim 以外的任何改写（trim 仅去首尾空白）。
- **执行文本 = 编辑器内容的字节精确子串**（或逐字选区）：**禁止**拼接、补分号、包 wrapper、替换占位符等任何变形——这是"语句定位算法不产生新注入面"的具体含义：算法只做 substring，不做 SQL 构造。
- **索引域陷阱**：CodeMirror 光标是 UTF-16 offset，Rust 扫描器是字节 offset；跨语言传递区间时**必须显式转换并测试**（用含中文/emoji 的 SQL：`SELECT '中'; SELECT 1` 光标定位正确）。[MUST]

#### 4.1.4 与 EXPLAIN 的一致性 [MUST]

`postgres_explain` 的 `single_statement` 拒绝批量语义必须保留（postgres.rs:639）；若切分器重构抽公共模块，EXPLAIN 路径改为"切分后取唯一语句"，**不得**放宽为执行批量。

### 4.2 停止查询（N-5）

#### 4.2.1 取消语义选型 [MUST]

红线是**取消必须落底**：用户点停止后，要么服务端查询确已停止，要么连接被拆除——禁止"UI 标记已停止、服务端仍在跑"的假取消（既占连接又持锁，还是 §1.6 超时同款问题）。

实现优先级：
1. [SHOULD] **cancel-first**：`pg_cancel_backend(pid)` 经由**另一条短连接**发送（PG 协议无带内取消；用 connect 时保存的连接参数新开一条取消连接），随后等待原查询 future 结束（宽限 ≤5s）。取消自己的 backend 无需额外权限。pid 来源：`postgres_connect` 时执行一次 `SELECT pg_backend_pid()` 存入 `backends` 表（[MUST] connect 时获取并保存）。取消连接的连接参数（含密码）**仅内存保存**（已在 `clients` 内存生命周期内），禁止日志/持久化（沿用既有"日志禁打密码"基线）。
2. [MUST 兜底] **teardown**：cancel 不可得/宽限超时/取消连接开不出来 → 直接从 `clients` 移除该 client（drop 即断连，服务端中止查询并回滚其事务），前端收到 "connection reset" 并引导重连。
3. **禁止**把 `pg_terminate_backend` 暴露为常规手段；对任意他人 backend 的取消/终止 UI 属 B31 服务器管理，B19 不做。[MUST]

#### 4.2.2 运行登记 [MUST]

- `PostgresState.backends` 记录每连接 `{ pid, cancel_handle }`；`postgres_execute`（及 B19 新执行命令）开始时登记、结束时清除。
- 新命令 `postgres_query_cancel(connection_id)`：无运行中查询 → **幂等成功返回**（重复点停止不是错误）。
- 取消路径**不得获取 txn_locks**（§1.2 死锁红线）。

#### 4.2.3 超时与取消统一 [MUST]

`postgres_execute` 的 `QUERY_TIMEOUT`（postgres.rs:594）超时后必须走同一取消路径（cancel→teardown），替换现状"放弃 future + 服务端继续跑"。编辑器长查询是否放宽 30s 上限属产品决策：若提供"无超时执行"，则**必须**同时提供可用且落底的停止。[MUST：放宽超时的前提是停止先行可用]

#### 4.2.4 停止 × 保存事务 [MUST]

- 停止落在保存事务（形态 B 复合命令或形态 A 语句）上：中止当前语句 → ROLLBACK（§3）→ 清模式/放锁。复合命令循环内每语句前检查取消令牌。
- 停止后连接必须处于明确状态之一：可用（事务已清）/ 已拆除。禁止"停止后连接还能收到新命令但事务状态未知"。[MUST]

#### 4.2.5 测试与验收

| 用例 | 期望 |
|---|---|
| `SELECT pg_sleep(30)` → 停止 | ≤5s 返回 "cancelled"；连接随后可正常查询 |
| 停止无运行查询 | 幂等成功 |
| cancel 失败注入（断取消连接）→ teardown | client 被移除；UI 提示重连；PG 侧查询已中止 |
| `QUERY_TIMEOUT` 触发 | 同停止路径，服务端无残留查询（`pg_stat_activity` 验证） |
| 保存事务运行中停止 | 事务回滚（数据无半成品），连接状态明确 |
| 查询运行中按停止 | 不等待 txn_locks（无死锁） |

### 4.3 参数查询（N-6）

#### 4.3.1 绑定铁律 [MUST]

- 新命令（如 `postgres_execute_parameterized`）入参 `{ connectionId, sql, params: Vec<Option<String>> }`，**必须**走 extended protocol（`client.query` / `query_typed`）绑定参数；**禁止** `simple_query`（不支持 `$n`，会把 `$1` 当字面量）；**禁止**任何把参数值拼进/替换进 SQL 文本的路径（包括"安全的转义替换"——B17/B18 已消灭的反模式不许借壳复活）。
- 参数类型推断：[SHOULD] 以 UNKNOWN 类型绑定（`query_typed` + `Type::UNKNOWN`）让服务端按上下文推断，`WHERE int_col = $1` 传 `"42"` 可用；若驱动形态不允许可要求用户 SQL 内显式 cast（`$1::int`，用户行为）并在 UI 提示——**便利性不足永远不构成回退到替换的理由**。
- NULL 语义与 B18 §5 一致：`params` 元素 `None`=SQL NULL、`Some("")`=空串，序列化保真。[MUST]
- 参数计数/预览校验只做 UX（前端提示 `$2` 未填）；**权威判定是服务端 bind**（数量不匹配由 PG 报错），前端校验不得作为安全依据。[MUST]
- 参数值**禁止进入任何日志**（参数可能是口令/PII，沿用日志基线）。[MUST]
- 边界：单参数 ≤1 MiB、总数 ≤256、SQL 文本 ≤4 MiB（防 IPC 超大 payload；与 B18 §4 同精神，超限报错不截断）。[MUST，数值可随 sprint 计划微调但必须存在]

#### 4.3.2 测试与验收

| 用例 | 期望 |
|---|---|
| 参数值含 `x' OR '1'='1`、`; DROP TABLE`、`%`、`\` | 全部作为字面值绑定，无注入、无语义改变 |
| NULL vs 空串参数 | 语义区分正确（`col = ''` vs `col IS NULL` 用法各自成立） |
| `WHERE int_col = $1` 传 `"42"` | UNKNOWN 绑定成功；或显式 cast 提示路径可用 |
| 参数数量不匹配 | 服务端 bind 错误透传 |
| readOnly 连接 + 参数化 UPDATE | 服务端 `default_transaction_read_only` 拒绝（连接级既有防线，不额外造） |
| 日志审查 | 无参数值泄漏 |

### 4.4 snippet 展开 / 格式化 / 压缩（N-7）

- **纯文本操作**：snippet 展开是"在光标处插入模板字符串"，格式化/压缩是"字符串→字符串变换"。[MUST] 全链路无 `eval`/`new Function`/动态 `import()`/子进程/shell/网络请求（不 fetch 远端 snippet 源）；snippet 库为仓内静态 JSON 或用户本地存储的纯数据。
- 格式化**不得触碰后端**：不执行 SQL、不查 catalog 之外的任何东西；格式化失败的输出只能是原文+错误提示，禁止部分应用产生语义漂移的改写。[MUST：格式化结果与原文执行语义等价（仅空白/大小写/换行差异），黄金向量断言]
- snippet 内容即用户将执行的文本，无独立信任边界；若未来引入"snippet 市场/导入"，另行评审。[SHOULD 预留]
- 展开的占位符（如 `$1`、`:name`）只做文本替换占位提示，**不得**在展开时预填真实数据值。[MUST]

---

## 5. B20 快捷键 enablement 红线（N-8）

快捷键本身无新注入面，红线是**不得绕过既有命令治理**：

1. [MUST] 每个数据库快捷键的 keydown 处理必须经 `resolveDatabaseCommand`（command-registry.ts:362）解析：unknown-command/wrong-scope → 忽略；disabled（missing-capability/connection-state）→ no-op（可配 toast 反馈）——**禁止**在 keydown 里直接 `invoke()` Tauri 命令绕过解析。理由：readOnly 连接（`supportsResultEditing`）、断连态（connectionStates）、能力差异（explain modes）都靠这一层守。
2. [MUST] B19 新命令（当前语句/选中/停止/参数执行）必须登记进 `DATABASE_COMMAND_IDS` + descriptor（scope/能力/连接态），随 registry 走；"停止" 需要 running 态 enablement 时，扩展 `DatabaseCommandContext`（如增加 `queryRunning` 字段）而不是在 handler 里私判。[MUST 扩展走 registry，SHOULD 优先扩 context 而非旁路]
3. [MUST] 终端保护不回退：xterm 聚焦时 keydown 永不进入数据库命令路由（master plan §7.1/D2，既有 `ignoreInTerminal` 模式）；DB 快捷键只注册在 DB scopes，全局不注册（Ctrl+T/Ctrl+N 教训）。回归测试：终端聚焦时 Ctrl+R 到达终端、不执行 SQL。
4. [MUST] 快捷键触发的 UI 层写护栏（readOnly 按钮 disabled、无 PK 表禁编辑、非 nullable 禁 Set NULL）**不得**因"反正 registry 会拦"而移除——双层防线都要。
5. [SHOULD] 同一命令多入口（菜单/右键/快捷键）收敛到同一 command handler，禁止复制粘贴第二份执行逻辑（漂移即漏洞温床）。

---

## 6. 禁止回退清单（B17/B18 既有体系，PR 自查勾选）

B19/B20 改动 `postgres.rs`、`tool-postgres.tsx`、`command-registry.ts` 时不得回退以下既有防线：

1. [ ] 表数据路径 `client.query()`（extended protocol）——**不回退** `simple_query`（B18 §0/§6.1；`postgres_execute` 自身作为"无参数任意 SQL 编辑器执行"保留 simple_query 是既有设计，但参数化新命令禁用）。
2. [ ] 一切值走 `$n` 参数绑定，无字符串拼接/手动转义（B18 §1.1）。
3. [ ] 标识符先白名单后 `quote_identifier`（B18 §1.2/§3），顺序不变。
4. [ ] `validate_cast_type` 字符集守卫覆盖所有被插值进 SQL 的类型名（B18 §1.3）。
5. [ ] 边界常量：条件 ≤32、排序列 ≤8、过滤值 ≤64KiB、offset ≤1,000,000、数据查询 QUERY_TIMEOUT（B18 §4）。
6. [ ] NULL 语义：值操作符 value=None 拒绝（不 `unwrap_or_default`）、`isNull/isNotNull` 不绑参（B18 §2.2/§5）。
7. [ ] LIKE 原样绑定不转义；未来 contains/startsWith 必须服务端包裹+转义（B18 §2.3 锁定的两套语义不混）。
8. [ ] `single_statement` 的 EXPLAIN 单语句防线（§4.1.4）。
9. [ ] readOnly：连接时 `SET default_transaction_read_only`（postgres.rs:541）+ UI 双层护栏。
10. [ ] B17 写护栏：无 PK 表禁 update/delete、PK 列只读、非 nullable 禁 Set NULL。
11. [ ] `max_rows` clamp、浏览路径 metadata-必须（无 simple_query 兜底浏览）。
12. [ ] 凭据/指纹基线：密码不落日志、SSH 指纹 fail-closed、禁 zlib 隧道（master plan §1.2 ⏸ 项）。

---

## 7. 交付前验证清单（安全侧门禁，随 PR 提交证据）

| 项 | 验证方式 |
|---|---|
| M2：save 事务中外来命令被拒 / 参与者放行 / 双 begin 拒绝 | Rust 集成测试（§1.7 表） |
| M2：disconnect 清理三表、cancel 不取锁 | Rust 集成测试 |
| M3：并发删改 → count!=1 报错 + 回滚 | Rust 集成测试 + 原生 E2E 双窗口场景 |
| M4：commit 失败自动 ROLLBACK / rollback 失败拆连接 / 前端不吞错 | Rust 集成测试 + 代码审查（`.catch(() => undefined)` 消失） |
| 写路径 execute 已包 QUERY_TIMEOUT | 代码 diff 审查 + 超时单测 |
| 切分器黄金向量双侧（TS/Rust）全绿（含 dollar-quote/嵌套注释/UTF-16 边界） | vitest + cargo test |
| 选中执行 = 逐字子串（无变形） | vitest 断言 |
| 停止落底：cancel→teardown；超时同路径；`pg_stat_activity` 无残留 | Rust 集成测试 + E2E |
| 停止幂等、×事务交互明确 | §4.2.5 表 |
| 参数化：注入串字面绑定、NULL/空串区分、无日志泄漏、边界拒绝 | Rust 单测 + 日志审查 |
| snippet/格式化：无 eval/shell/network；格式化语义等价 | 依赖审查（grep eval/child_process/fetch）+ 黄金向量 |
| 快捷键全走 registry；终端回归（Ctrl+R 归终端）；readOnly 双层护栏在 | vitest scope 路由单测 + 原生 E2E |
| §6 禁止回退清单 12 项 | PR 自查勾选 + 安全评审复核 |

> fe-dev/fe-dev2 对红线有任何放宽需求（例如超时常量、边界数值调整），先提 security 评审，不在 PR 里静默改。
