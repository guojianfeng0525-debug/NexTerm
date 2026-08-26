# B21/B22 安全约束（实现前红线）

> 作者：security（安无恙）｜2026-08-26
> 适用：fe-dev 实现 B21「导航器对象全覆盖 + Navicat 21 项确认菜单」、B22「连接管理：颜色/虚拟分组/导入导出/批量测试重连」时必须遵守的实现前安全约束。
> 依据：`navicat-parity-master-plan.md` §6（B21/B22 DoD）；`navicat-premium-context-menus.md`（21 项确认菜单，含 Delete Record/Remove/Delete FK 等破坏性项）；现状代码 `src-tauri/src/postgres.rs`（postgres_catalog_search / postgres_catalog_schemas）、`src/lib/connection-storage.ts`、`src/lib/toolbox/db.ts` + `vault-crypto.ts`（AES-GCM 凭据基线）、`src-tauri/src/connection_manager.rs`（连接管理先例）；B18/B19-20 红线基线（参数化/白名单/禁止回退清单，B21/B22 不得回退）。
> 性质：**只写约束，不改产品代码**。每条标注 [MUST]（硬红线，违反即打回）或 [SHOULD]（建议，偏离需说明理由）。与架构约束文档冲突时以本文红线为准；红线间冲突报 team-lead 裁决，不自行放宽。

---

## 0. 威胁模型速览（B21/B22 新增面）

| # | 面 | 风险 | 约束章节 |
|---|---|---|---|
| N-B1 | catalog 查询扩展（序列/索引/约束/触发器/列） | 新 kind 查询 SQL 构造回退拼接；schema 无白名单；无权限对象被枚举；LIKE 通配符语义放大 | §1 |
| N-B2 | 破坏性操作（Drop/Truncate/清空/Delete Record） | 前端拼 DROP 字符串 invoke；无存在性校验；无 CASCADE 显式确认 → 误删/连带删除 | §2 |
| N-B3 | DDL 预览（pg_get_viewdef/functiondef） | 函数体含硬编码凭据回显；权限不足错误透传细节；innerHTML 渲染 XSS | §3 |
| N-B4 | 连接导入/导出 | 导出明文密码（现状直接泄漏）；恶意 JSON（超限/深度/原型键）DoS；替换导入半删态丢数据；任意路径读写 | §4 |
| N-B5 | 批量测试/重连 | 并发连接无上限 → 连接风暴 DoS；错误信息泄漏凭据细节；重连密码回传前端 | §5 |
| N-B6 | 虚拟分组/颜色 | 分组名/颜色入库后渲染 XSS；分组名含 `/`/`..` 路径污染 | §6 |

现状缺陷证据（B21/B22 必须修复）：
- `exportConnections()`（connection-storage.ts:915-919）直接 `JSON.stringify` **内存缓存 = 已解密明文凭据** → 导出文件含明文密码。[MUST 修复，见 §4]
- `importConnections()`（connection-storage.ts:924-976）`JSON.parse` 无大小/字段/深度校验；替换模式**先删后插**（:943-945），中途异常即半删态丢数据。
- `postgres_catalog_search`（postgres.rs:2216-2290）的 `column` 分支**缺 `has_schema_privilege` 守卫**（relation/function/type 已有，B21 补齐）；prefix 直接 `format!("{}%")` 未转义 LIKE 通配符。

---

## 1. B21 catalog 查询扩展（函数/序列/索引/约束/触发器/列）

### 1.1 SQL 构造铁律 [MUST]

新增 kind（sequence/index/constraint/trigger）与既有 kind（function/column）统一遵守：

- **全参数化**：schema / relation / prefix / limit 一律走 extended protocol `$n` 绑定（沿用 B18 §1.1），**禁止**任何字符串拼接；kind 值本身走白名单 `match`（现状 postgres.rs:2229 模式，禁止变成「字符串→SQL 片段」的模板表）。
- **白名单 schema 校验**：`request.schema` 非空时，服务端必须以参数化查询 `SELECT 1 FROM pg_namespace WHERE nspname = $1` 校验其真实存在；不存在或权限不足 → 统一返回 "schema does not exist"。这是**门禁**：后续任何以该 schema 构造的查询/命令不得在 schema 校验失败后继续。[MUST]
- **权限守卫**：所有 kind 查询必须带 `has_schema_privilege(n.oid, 'USAGE')` 过滤（`column` 分支补齐；新 kind 从第一版就带），无权限对象不返回（fail-closed），不返回「存在但无权限」的歧义条目。[MUST]
- **LIKE 通配符语义**：prefix 以 `ILIKE $n` 绑定是安全的（无注入），但 prefix 内含的 `%`/`_` 是通配符 → 若产品语义是「字面前缀补全」，必须服务端转义：`WHERE name ILIKE (replace(replace(replace($n,'\','\\'),'%','\%'),'_','\_') || '%') ESCAPE '\'`；若产品明确接受通配符补全，UI 必须提示且返回集受 limit 约束。[SHOULD：现状 `format!("{}%", prefix)` 不是注入漏洞，但会放大返回集，B21 顺手修]
- **限额统一**：`limit` 沿用 `clamp(1, 100)`；每个新 kind 的查询必须有 `LIMIT $n`。错误返回不得含参数值。[MUST]
- **kind → 查询模板映射**：新 kind 建议落点：

| kind | 主表 | 过滤 | 返回 detail |
|---|---|---|---|
| sequence | pg_class（relkind='S'）+ pg_namespace | 同上 | 无（或 type 名） |
| index | pg_index JOIN pg_class（索引 rel）+ pg_namespace | `has_schema_privilege` | `pg_get_indexdef(oid)` 或索引列清单（**服务端决定**，不把 def 函数暴露给前端拼参） |
| constraint | pg_constraint JOIN pg_class（所属表）+ pg_namespace | contype IN ('p','f','u','c','x','t','e') | `pg_get_constraintdef(oid)` |
| trigger | pg_trigger JOIN pg_class + pg_namespace | `NOT tgisinternal` | `pg_get_triggerdef(oid)` |
| function | pg_proc（现状已有） | 沿用 | `pg_get_function_identity_arguments`（签名）——**定义体走 §3 专用命令** |

### 1.2 系统函数调用面（pg_get_functiondef 等）[MUST]

问题：`pg_get_functiondef` / `pg_get_viewdef` / `pg_get_indexdef` / `pg_get_constraintdef` / `pg_get_triggerdef` 是否安全暴露给前端？

结论：**允许暴露，但只经专用命令、由服务端解析 oid**。理由：`postgres_execute` 已是「执行任意 SQL」的既定产品能力，系统函数本身不构成新越权；红线在**不产生新的窄而失守的路径**：

1. **禁止前端传 oid 直接调 def 函数**。新增专用命令（如 `postgres_catalog_ddl(connectionId, kind, schema, name)`）由服务端执行「白名单 kind + schema/name 参数化定位 → 拿到 oid → 服务端调对应 pg_get_* 函数」两步，前端只传 `{kind, schema, name}`。禁止新命令接受 `oid`/任意 SQL 文本参数。[MUST]
2. **权限不足错误映射**：`pg_get_functiondef` 对非 owner 报 `insufficient privilege`——服务端必须映射为 `"insufficient privilege to view definition of <kind> <schema>.<name>"`，**不透传底层错误全文**（底层错误可能含对象细节/行号）。UI 收到该错误时隐藏 DDL 区域并展示「无权限查看定义」。[MUST]
3. **DDL 文本 = 敏感数据**：命令返回前不落日志（沿用「日志禁打敏感信息」基线）；前端按 §3 渲染。[MUST]

### 1.3 测试与验收（catalog）

| 用例 | 期望 |
|---|---|
| 六类 kind 各自构造 SQL | 无用户可控文本进入 SQL 文本（注入串作为 schema/prefix 值全部参数化） |
| schema 不存在/无 USAGE | 返回 "schema does not exist"，不执行后续 |
| 无权限 schema 的 index/constraint/trigger/sequence | 查询结果为空（has_schema_privilege 过滤生效） |
| prefix 含 `%`/`_` | 字面前缀语义（转义后）或明确通配符语义+limit 生效 |
| limit 越界 | clamp 到 1..100 |
| DDL 专用命令传不存在对象/非法 kind | 明确错误，无 def 函数被调用 |
| 非 owner 调 DDL 专用命令 | "insufficient privilege..." 通用错误，无底层细节 |

---

## 2. B21 破坏性操作（Drop / Truncate / 清空 / Delete Record）

B21 菜单面含破坏性项：导航器对象菜单的 **Drop**（表/视图/物化视图/序列/索引/约束/触发器/函数/schema，Navicat 确认菜单按对象启用）、**Truncate（清空表）**、数据网格的 **Delete Record**（21 项确认菜单之一）、Query Builder 的 **Remove / Delete Foreign Key**。安全约束不因菜单项细节未完全验证而放宽。

### 2.1 命令形态：白名单化定位 + 服务端构造 [MUST]

- **禁止**前端拼接 `DROP ...` / `TRUNCATE ...` 字符串后 `invoke('postgres_execute')` 或任何「传 SQL 文本」命令执行破坏性操作。[MUST 绝对红线]
- 新增专用命令（建议形态，二选一，安全属性等价）：
  - `postgres_drop_object(request: {connectionId, kind, schema, name, cascade, confirmed})`
  - `postgres_truncate(request: {connectionId, schema, table, confirmed})`
- `kind` 必须枚举白名单（table/view/materialized_view/sequence/index/constraint/trigger/function/schema），服务端以 **kind → 固定 DDL 模板** 映射（如 `DROP TABLE {schema}.{name}` / `DROP SEQUENCE` / `DROP TRIGGER {name} ON {table}`）；模板内唯一可变量是经 `quote_identifier` 的 schema/name，模板内不得有用户可控片段。[MUST]
- **对象存在性校验（fail-closed）**：执行前以参数化 catalog 查询定位对象（§1.1 的 schema 白名单 + 对象名 + kind 过滤）；**对象不存在 → 报错 "object does not exist"**，不得静默成功、不得执行「空 DROP」。[MUST]
- **二次确认在服务端**：`confirmed` 必须由服务端校验存在性后才接受；确认（dry-run）与执行之间对象被并发删除 → 执行阶段**重新校验**，不信任 dry-run 结果（TOCTOU 容忍：先查后删是既有模式，被并发删则返回 not-exist）。前端确认对话框只是 UX 层，服务端 `confirmed=false` 时只返回 `{kind, schema, name, object_exists, dependent_count, sample_dependents}` 供展示。[MUST]

### 2.2 CASCADE 显式化 [MUST]

- `cascade` 必须是显式布尔参数；dry-run 阶段用 `pg_depend`/`pg_rewrite` 统计依赖对象数量并抽样返回（UI 展示「将连带删除 N 个对象」），执行阶段 `cascade=true` 才生成 `DROP ... CASCADE`。[MUST]
- **禁止**默认静默 CASCADE；**禁止**把 CASCADE 选择权藏在前端拼 SQL 里（§2.1 已禁）。[MUST]
- 无依赖对象时 `cascade=true` 与 `false` 等价（无连带），不额外报错。[SHOULD]

### 2.3 readOnly 与超时 [MUST]

- Drop/Truncate 命令必须双重拦截：连接级 `default_transaction_read_only`（readOnly 连接服务端自然拒绝 DDL）+ 服务端显式检查连接 read_only 标记返回明确错误「read-only connection cannot modify schema/data」。[MUST]
- 所有破坏性语句必须包 `QUERY_TIMEOUT`（沿用 B19 §1.6 写路径超时红线），超时走 §4.2 取消语义（cancel→teardown），不得只报错留悬挂。[MUST]
- 单条破坏性命令**不得**接受对象数组批量执行（防一次误操作毁一片）；批量删除须逐对象独立确认。[SHOULD：如需多选删除，每对象一次命令、逐个确认]

### 2.4 Truncate / 清空 与 Delete Record [MUST]

- `TRUNCATE TABLE {schema}.{table}` 与 Drop 同等级：存在性校验（表必须存在）+ `confirmed` + readOnly 拦截 + CASCADE 提示（TRUNCATE 有依赖时默认拒绝，需 `CASCADE` 显式声明）。**禁止** `TRUNCATE` 作用于任意表达式/子查询。[MUST]
- 若提供「清空行」（`DELETE FROM {schema}.{table}` 无 WHERE）：与 Truncate 同等级护栏；全表 DELETE 必须 `QUERY_TIMEOUT` 且提示影响行数。[MUST]
- **Delete Record（行删除）必须复用 `postgres_table_delete`**（PK 定位 + M3 count==1 校验 + readOnly 拦截），禁止为 21 项菜单新增旁路删除路径。[MUST]
- Query Builder「Remove」删除的是画布上的关联/对象（非 DB 对象）——仅前端内存操作，无 DB 写面，不适用本章；但若后续「Remove」语义扩展到删 DB 对象，必须先过本章评审。[SHOULD]

### 2.5 审计日志 [SHOULD]

Drop/Truncate 成功记录 `{kind, schema, name, cascade, 时间戳}` 审计日志（console/in-memory 均可，先落 console）；失败记录原因。**禁止**在日志中出现密码/凭据/连接参数全文。

### 2.6 测试与验收（破坏性操作）

| 用例 | 期望 |
|---|---|
| 前端以 `postgres_execute` 传 `DROP TABLE ...` | 该路径不存在（命令面审查）；UI 只能走专用命令 |
| dry-run 不存在对象 | 返回 object_exists=false，不执行任何语句 |
| 存在性校验后执行 | DROP 生成 `DROP "schema"."name"`（quote_identifier 正确，含特殊字符/注入串的表名） |
| 有依赖对象 + cascade=false | 执行报依赖错误（PG 原生 `dependent objects exist`），无连带删除 |
| 有依赖对象 + cascade=true | dry-run 展示 dependent_count；执行连带删除成功 |
| 确认与执行间对象被删（测试注入） | 执行阶段重新校验 → "object does not exist" |
| readOnly 连接 Drop/Truncate | 服务端明确拒绝，语句未执行 |
| Truncate 无 confirmed | 拒绝，只返回预览 |
| Delete Record 走 postgres_table_delete | 无新删除命令；并发删改仍触发 M3 count 校验 |
| 超时 | 同 §4.2 取消路径，无服务端残留 |

---

## 3. B21 DDL 预览 / 生成（pg_get_viewdef/functiondef 透传）

### 3.1 透传红线 [MUST]

- 服务端对 `pg_get_*` 输出**原样透传**（不做改写/裁剪），但返回**前不落日志**；前端 DDL 区域为只读文本。[MUST]
- **渲染安全**：DDL 文本只允许 React 文本节点渲染，**禁止** `dangerouslySetInnerHTML` / `innerHTML`（函数体可能含 `</script>`、`<img onerror=...>` 等，文本节点安全、innerHTML 即 XSS）。[MUST]
- **大小上限**：DDL 文本超过阈值（建议 512 KiB）截断返回并携带 `truncated=true`，UI 标注「定义过长已截断」；防止 IPC 超大 payload。[SHOULD]

### 3.2 敏感信息风险提示 [MUST/SHOULD]

- **风险事实**：函数/触发器定义可能内含硬编码凭据（如 `CREATE SERVER ... PASSWORD 'xxx'`、`EXECUTE format('... %L', 'secret')`）。DDL 预览是合法功能（DBA 本就可见），安全约束是**生命周期治理**，不是禁止功能：[MUST] DDL 文本不落日志、不参与导出（B26 导入导出平台时 DDL 导出默认排除或加密）；[SHOULD] 对函数/触发器 DDL 显示一次性提示条「定义可能含敏感信息（如硬编码凭据），复制/截屏前确认」。
- 剪贴板复制是用户主动动作，不拦截，但 UI 可提示。[SHOULD]

### 3.3 测试与验收（DDL 预览）

| 用例 | 期望 |
|---|---|
| 含 `</script>` 的函数体渲染 | 按文本显示，无脚本执行（无 innerHTML 路径，grep 审查） |
| 非 owner 查看函数定义 | 通用「无权限查看定义」错误，无底层细节 |
| DDL 文本超限 | truncated=true + 截断展示 |
| 日志审查 | DDL 文本/函数体未出现在任何日志输出 |

---

## 4. B22 连接导入/导出

### 4.1 导出：明文密码禁令 [MUST]

现状 `exportConnections()`（connection-storage.ts:915-919）导出内存缓存（**已解密明文**）——直接泄漏。修法三选一（[MUST] 任一实现）：

- **A（推荐）默认排除 + 可勾选加密**：导出默认将 password/passphrase/proxyPassword/jumpPassword/vncPassword 置空（带 `__hasPassword: true` 占位标记），UI 明确提示「导出文件不含密码，导入后需重填」；用户勾选「包含密码」时必须整体加密（见 B）。
- **B 整体加密**：复用 `db.rs` 加密备份封套模式（magic + salt + PBKDF2 150k + AES-256-GCM），导出文件无明文 JSON，口令要求 ≥8 字符。[MUST 任一路径：**明文密码不得出现在任何导出文件中**]
- 禁止「导出明文 JSON + 靠文件权限保护」——基线是凭据 AES-GCM 加密入库，导出必须守住同等级。[MUST]

### 4.2 导入：恶意 JSON 防护 [MUST]

- **大小限制**：`JSON.parse` 前校验文件大小（建议 ≤5 MiB），超限拒绝「file too large」；不得先 `readTextFile` 全量读入再报错（大文件本身即 DoS）。[MUST]
- **字段白名单 schema 校验**：逐对象校验已知字段集合（ConnectionData 键），未知字段**丢弃**或拒绝；`protocol`/`authMethod`/`proxyType` 等枚举字段非法值拒绝；嵌套深度 ≤8（JSON.parse reviver 计数）。[MUST]
- **原型键防护**：反序列化后禁止 `{...connection}` 裸展开——改为显式白名单字段拷贝（`__proto__`/`constructor` 等键不得进入 rowUpsert）。[MUST]
- **敏感字段语义**：导入 JSON 中若出现密码字段，一律视为**明文待加密**，写入前必须走 `encField`（现状 persistConnection 已加密，**保留且不得绕过**）；若导入文件来自 A 方案导出（密码已排除），导入后这些字段为空，UI 提示需重填。[MUST]
- **格式失败不泄漏**：`JSON.parse` 失败 / schema 校验失败 → 错误信息只含「无效的导入文件 / 第 N 项无效」，**不含文件内容片段**。[MUST]

### 4.3 替换导入：事务性与确认 [MUST]

- 非 merge 导入（connection-storage.ts:943-945 现状**先删后插**）必须改为：**全量校验通过 → 一次性替换**；任何一项无效即整体失败，**禁止**留下半删态（现状丢数据风险）。[MUST]
- 替换导入必须二次确认（与 B21 Drop 同级）：确认内容含「将移除 N 个现有连接/分组，导入 M 个」。[MUST]

### 4.4 路径校验 [MUST]

- **导入**：只读用户经 Tauri 文件对话框选择的文件；若实现走 Rust 命令读文件，路径必须来自 dialog 返回值，**禁止**接受前端传入任意 path 直接读（防读任意文件如 `/etc/passwd`）；服务端可选校验扩展名 `.json` + 内容 `JSON.parse` 判定。[MUST]
- **导出**：只写用户选择的路径；写前确认目标不存在或为同类型导出文件，**禁止**覆盖任意文件路径。[MUST]
- 文件头判定：导入时以「文件内容可解析为预期结构」为准，不信任扩展名；导出文件可带 `nexterm-connections-export` 标识便于识别（[SHOULD]）。

### 4.5 测试与验收（导入/导出）

| 用例 | 期望 |
|---|---|
| 导出默认 | 文件中 grep 不到任何明文密码/口令字段 |
| 导出含密码（若实现） | 文件为加密封套，无明文 JSON |
| 导入 >5MiB 恶意文件 | 快速拒绝，无冻结 |
| 深度嵌套 JSON / `__proto__` 键 | 拒绝或净化，rowUpsert 无污染字段 |
| 替换导入含无效项 | 整体失败，既有数据不变（无半删态） |
| 替换导入确认前 | 不执行任何删除 |
| 导入路径为任意文件（构造请求） | 服务端拒绝（仅 dialog 路径有效） |

---

## 5. B22 批量测试/重连

### 5.1 并发与资源限制 [MUST]

批量测试命令（如 `postgres_batch_test(requests: Vec<{connectionId, ...}>)`）必须：

- **批量上限**：单次请求连接数 ≤50，超出整体拒绝「batch too large」。[MUST]
- **全局并发信号量**：服务端 Semaphore（建议 ≤10）限制同时开起的连接，超出的请求排队或立即返回「busy」——防连接风暴 DoS。[MUST]
- **单连接超时**：沿用 `CONNECT_TIMEOUT`（10s，不得放宽），每项独立 `tokio::time::timeout`；**批量总超时**（建议 ≤60s）超限后未完成项标记 timeout，命令**必须落底返回**，禁止无限等待挂起。[MUST]
- **逐项独立**：一项失败不影响其余项完成测试；每项结果独立返回 `{connectionId, ok, errorKind, message}`。[MUST]
- **连接复用约束**：批量测试**不写入** `clients` 注册表（测试连接用完即 drop，防止污染正式连接池/事务状态）；测试不得触发 SSH 隧道打开超过并发上限。[MUST]

### 5.2 错误信息脱敏 [MUST]

- 失败项的 `message` **只含**：host、port、database、username、错误分类（timeout / auth-failed / connection-refused / tls-failed / ssh-failed / unknown）。**禁止**含：password/passphrase/private_key 内容、连接参数完整 JSON、证书/密钥片段、`pg_cancel_backend` 类内部细节。[MUST]
- 认证失败错误**不得**细分「用户不存在 vs 密码错误」（防用户名枚举）。[SHOULD]
- 日志（console/tracing）同规则：批量测试任何输出不得含凭据。[MUST]

### 5.3 重连 [MUST]

- 重连命令的连接参数**不得由前端回传**：复用服务端内存保存的 connect request（`PostgresState.cancel_configs` 同源模式，postgres.rs:51），前端只传 connectionId；密码不经过 IPC 回传路径。[MUST]
- 重连失败错误按 §5.2 脱敏；重连成功走正常 connect 流程（readOnly 设置、pid 登记、txn_modes 清空）。[MUST]

### 5.4 测试与验收（批量测试/重连）

| 用例 | 期望 |
|---|---|
| 单批 51 个连接 | 整体拒绝 |
| 并发 30 项同时测 | 在途 ≤10（信号量生效），全部落底返回 |
| 一项 hang（注入不可达地址） | ≤10s 单项超时；批量 ≤60s 总超时；无挂起命令 |
| 错误项 message | grep 断言无 password/私钥/证书内容 |
| 认证失败 | 不区分用户不存在/密码错误 |
| 重连 | 前端不传密码；成功后连接状态正常可查询 |

---

## 6. B22 虚拟分组/颜色

无直接 DB 注入面，约束集中在**存储格式与渲染**：

- **分组名校验** [MUST]：长度 ≤128；**禁止** `/` `\`（分组名会拼入 `path`/`folder`，分隔符破坏层级）、**禁止** `..`（路径穿越——导入的分组名尤其要查）；控制字符拒绝。创建/重命名/导入三条路径同一校验（复用 `renameFolder` 的 `/` 拒绝先例，connection-storage.ts:624）。
- **颜色值校验** [MUST]：白名单格式 `^#[0-9a-fA-F]{6}$`（或命名词表）；非法值拒绝，**禁止**把任意字符串当颜色入库（防脏数据后接渲染层）。
- **渲染 XSS 防护** [MUST]：分组名/颜色只经 React 文本节点/受控属性渲染，**禁止** `dangerouslySetInnerHTML`/`innerHTML`/`style` 属性注入任意值（颜色值经白名单后可直接用于 `style={{color}}`）。[MUST]
- 分组名作为 key/path 的深层使用（URL、文件路径、localStorage key）**禁止**——只作展示与层级字符串。[SHOULD]
- 存储层：写入 SQLite 前在 `persistFolder`/`persistConnections` 统一走校验（与导入共用同一校验函数，防导入绕过前端 UI 直接入库）。[MUST]

测试：分组名 `../../x`、`a/b`、`<img src=x onerror=...>`、颜色 `"red;background:url(...)"`、超长 → 全部拒绝；合法 `#1a2b3c` 正常；渲染无 innerHTML 路径（grep 审查）。

---

## 7. 禁止回退清单（B18/B19-20 既有体系 + B21/B22 新增，PR 自查勾选）

1. [ ] 表数据路径 `client.query()`（extended protocol）——不回退 `simple_query`（B18 §0/§6.1）。
2. [ ] 一切值走 `$n` 参数绑定，无字符串拼接/手动转义（B18 §1.1）。
3. [ ] 标识符先白名单后 `quote_identifier`，顺序不变（B18 §1.2/§3）。
4. [ ] `validate_cast_type` 字符集守卫覆盖所有被插值进 SQL 的类型名（B18 §1.3）。
5. [ ] 边界常量：条件 ≤32、排序列 ≤8、过滤值 ≤64KiB、offset ≤1,000,000、QUERY_TIMEOUT（B18 §4）。
6. [ ] NULL 语义：值操作符 value=None 拒绝、`isNull/isNotNull` 不绑参（B18 §2.2/§5）。
7. [ ] LIKE 原样绑定不转义；contains/startsWith 必须服务端包裹+转义（B18 §2.3）。
8. [ ] `single_statement` 的 EXPLAIN 单语句防线（B19 §4.1.4）。
9. [ ] readOnly：连接时 `SET default_transaction_read_only` + UI 双层护栏；B21 Drop/Truncate 额外服务端检查。
10. [ ] M2/M3/M4：save 事务互斥、count==1 校验、失败主动 ROLLBACK（B19 §1-3）——B21 新命令若落进事务路径必须过这三条。
11. [ ] 凭据/指纹基线：密码不落日志、SSH 指纹 fail-closed、禁 zlib 隧道（master plan §1.2 ⏸ 项）；B21 DDL 文本同视为敏感不落日志。
12. [ ] **B21 新增**：catalog 六类查询全参数化 + `has_schema_privilege` 守卫 + schema 白名单校验（§1）。
13. [ ] **B21 新增**：前端禁拼 DROP/TRUNCATE 字符串 invoke；破坏性操作只走白名单化专用命令（§2）。
14. [ ] **B22 新增**：导出文件不含明文密码（§4.1）；导入全量校验通过才替换（§4.3）。
15. [ ] **B22 新增**：批量测试并发上限 + 错误脱敏（§5）。

---

## 8. 交付前验证清单（安全侧门禁，随 PR 提交证据）

| 项 | 验证方式 |
|---|---|
| catalog 六类查询：注入串参数化、schema 白名单、权限守卫、limit clamp | Rust 单测 + 集成测试（§1.3 表） |
| column 分支补 has_schema_privilege | 代码 diff 审查 |
| Drop/Truncate 无前端拼 SQL 路径；专用命令存在性校验 + confirmed + CASCADE 显式 | Rust 集成测试 + 代码审查（grep `DROP`/`TRUNCATE` 不出现在前端拼接处） |
| Delete Record 复用 postgres_table_delete | 代码审查 |
| readOnly 双层拦截 Drop/Truncate | Rust 集成测试 |
| DDL 透传：无 innerHTML、无日志、权限错误通用化、超限截断 | grep 审查 + Rust 集成测试 |
| 导出无明文密码；导入大小/深度/字段/原型键校验；替换事务性 | vitest 单测 + 手动导出 grep 检查 |
| 导入路径仅 dialog 来源 | 代码审查 + 构造恶意请求测试 |
| 批量测试：批量上限/并发信号量/总超时/错误脱敏/密码不回落 | Rust 集成测试 + 日志审查 |
| 虚拟分组/颜色：长度/分隔符/`..`/颜色白名单/渲染无 innerHTML | vitest 单测 + grep 审查 |
| §7 禁止回退清单 15 项 | PR 自查勾选 + 安全评审复核 |

> fe-dev/fe-dev2 对红线有任何放宽需求（如批量上限、DDL 截断阈值、导出加密实现选型），先提 security 评审，不在 PR 里静默改。
