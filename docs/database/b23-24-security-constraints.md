# B23/B24 安全约束（实现前红线）

> 作者：security（安无恙）｜2026-08-26
> 适用：fe-dev 实现 B23「PG 表设计器 + DDL 预览/回滚 + View Builder」、B24「PG ER 图反向工程：关系线/拖拽/缩放/FK 设计删除」时必须遵守的实现前安全约束。
> 依据：`navicat-parity-master-plan.md` §6（B23/B24 DoD）、§11.5（B17 遗留 M2/M3/M4）；既有红线基线 `b19-20-security-constraints.md`（M2/M3/M4/参数化/停止）、`b21-22-security-constraints.md`（catalog 白名单/破坏性操作护栏/DDL 透传），**B23/B24 不得回退**；现状代码 `src-tauri/src/postgres.rs`（`postgres_save_table_changes` 形态 B 复合事务、`txn_modes`、`quote_identifier`、`is_read_only`、`postgres_table_data`、M3 count==1）、`src-tauri/src/postgres_catalog.rs`（`postgres_drop_object` 白名单模式、`require_schema`、`resolve_object_oid`、`map_ddl_privilege_error`、`table_ddl`/`view_ddl` 服务端构造先例）。
> 性质：**只写约束，不改产品代码**。每条标注 [MUST]（硬红线，违反即打回）或 [SHOULD]（建议，偏离需说明理由）。与架构约束文档冲突时以本文红线为准；红线间冲突报 team-lead 裁决，不自行放宽。

---

## 0. 威胁模型速览（B23/B24 新增面）

| # | 面 | 风险 | 约束章节 |
|---|---|---|---|
| N-D1 | DDL 应用命令 | 前端拼 `ALTER TABLE` 字符串 invoke → SQL 注入/越权；变更类型不白名单 → 任意 DDL | §1 |
| N-D2 | 类型/默认/约束表达式 | 类型名/表达式被拼进 SQL 文本（DDL 无法参数化标识符）→ 注入 | §1.3 |
| N-D3 | 破坏性变更（drop column/表/约束） | 带数据列被误删；无二次确认；DDL 部分成功半应用 | §2 |
| N-D4 | DDL 事务窗口 | 应用过程中外来命令插入/事务交错 → 误回滚/毒化 | §2.3 |
| N-D5 | DDL 预览回显 | 视图/函数定义含硬编码凭据被回显/落日志/复制泄漏 | §3 |
| N-D6 | 权限不足错误透传 | ALTER 失败底层错误含表结构/行号细节泄漏 | §4 |
| N-E1 | ER 图 FK 数据源 | FK 查询 SQL 拼接回退；schema 无白名单 → 枚举无权限对象 | §5.1 |
| N-E2 | 画布渲染 | 表名/列名（PG 标识符可含任意字符，含 `<img onerror>`/`</text>`）经 innerHTML 渲染 → XSS；SVG 属性注入 | §5.2 |
| N-E3 | 删线=删 FK | 前端拼 `ALTER TABLE DROP CONSTRAINT` invoke；无二次确认 | §6 |
| N-E4 | 布局持久化 | 坐标/表引用脏数据入库 → 渲染层注入/存储 DoS | §7 |

现状代码面（B23/B24 必须复用，不得另起炉灶）：
- `postgres_save_table_changes`（postgres.rs:1870-2118）：**形态 B 复合事务**先例——manual 事务拒绝 → `txn_modes` 置 `"save"` → BEGIN → 逐步骤应用（M3 count==1）→ 任一步失败 `rollback_save` → COMMIT → 清标记。B23 DDL 应用必须同构。
- `postgres_drop_object`（postgres_catalog.rs:1036-1180）：kind 白名单 + `require_schema` + `resolve_object_oid`（含执行前 TOCTOU 重校验）+ `confirmed`/`cascade` + readOnly 检查 + `quote_identifier` 拼装 + QUERY_TIMEOUT + 审计日志。B23 dropColumn/dropConstraint、B24 dropForeignKey 必须同构。
- `quote_identifier`（postgres.rs:1008）：标识符唯一合法构造途径。
- `map_ddl_privilege_error`（postgres_catalog.rs:280）：权限错误通用化先例（底层错误不跨 IPC）。

---

## 1. B23 表设计器：DDL 应用命令设计（N-D1/N-D2）

### 1.1 命令形态：白名单化结构化变更 [MUST]

- **绝对红线**：**禁止**前端拼接 `ALTER TABLE ...` 字符串后 `invoke('postgres_execute')` 或任何「传 SQL 文本」命令来应用设计器变更；**禁止**新增任何接受任意 SQL 文本的专用命令。[MUST]
- 新增专用命令（建议形态，与 `postgres_save_table_changes` 同构）：

```
postgres_apply_table_design(request: {
  connectionId: string,
  schema: string,
  table: string,
  operations: TableDesignOperation[],   // 结构化变更列表
  confirmed: boolean,                   // 破坏性操作二次确认
})
```

- `operations` 是 tagged union（Rust `enum`，`#[serde(tag="op")]`），**操作类型白名单**只允许：

| op | 字段（全部经服务端构造 SQL） |
|---|---|
| `addColumn` | `{ name, dataType, nullable, default? }` |
| `dropColumn` | `{ name }` |
| `modifyColumn` | `{ name, newName?, dataType?, nullable?, default? }`（变更字段可选） |
| `addConstraint` | `{ name, definition }`（definition = 约束体 SQL 片段，见 §1.3） |
| `dropConstraint` | `{ name }` |
| `addIndex` | `{ name, definition }` |
| `dropIndex` | `{ name }` |
| `addForeignKey` | `{ name, columns: string[], refSchema, refTable, refColumns: string[], onDelete?, onUpdate? }` |
| `dropForeignKey` | `{ name }` |

- 服务端以 `match op` 映射到**固定 DDL 模板**（先例：`postgres_drop_object` 的 kind→模板），模板内可变量只有：经 `quote_identifier` 的标识符、经 §1.3 校验的类型/表达式片段、白名单枚举（`onDelete`/`onUpdate` 只允许 `NO ACTION/RESTRICT/CASCADE/SET NULL/SET DEFAULT` 五值白名单）。**未知 op 或非法字段值 → 整体拒绝，不执行任何语句**。[MUST]
- 命令入口校验：`require_schema`（复用 postgres_catalog.rs:173）+ 表存在性校验（参数化 `pg_class` 定位，relkind IN ('r','p')）；表不存在 → "table does not exist"，不执行后续。[MUST]
- **readOnly 双层拦截**：连接级 `default_transaction_read_only`（服务端自然拒绝 DDL）+ 服务端显式 `is_read_only`（postgres.rs:75）检查返回「read-only connection cannot modify schema/data」，与 `postgres_drop_object` 一致。[MUST]

### 1.2 变更校验（对象/列存在性、类型白名单）[MUST]

**列存在性**：
- `dropColumn`/`modifyColumn` 的 `name`：执行前以参数化查询校验 `pg_attribute` 中存在该列（`attnum > 0 AND NOT attisdropped`，先例 resolve_object_oid 的 column 分支）；列不存在 → "column <name> does not exist on <schema>.<table>"，**不得**泄漏表内其他列清单。[MUST]
- `dropIndex`/`dropConstraint`/`dropForeignKey`：同 B21 模式，参数化定位对象存在性；不存在 → 明确报错。[MUST]
- `modifyColumn` 的 `newName`：若与现有列重名 → PG 报错由事务回滚兜底，服务端亦可预检。[SHOULD]

**类型白名单（pg_type 校验）**：
- `addColumn`/`modifyColumn` 的 `dataType`：**禁止**直接插值进 DDL。服务端参数化校验 `SELECT format_type(oid, NULL) FROM pg_type WHERE typname = $1`（或先验固定白名单：`bigint`/`integer`/`smallint`/`numeric`/`text`/`varchar`/`char`/`boolean`/`timestamp`/`timestamptz`/`date`/`time`/`uuid`/`json`/`jsonb`/`bytea`/`serial` 系——两案任选，**不得**两案都做造成双写），以**服务端返回的规范类型名**插值进模板；类型不存在 → "unsupported data type"。禁止传入类型修饰片段（如 `varchar(255)` 以字符串形式透传）。[MUST]
- 类型名/修饰符的字符集守卫：凡被插值进 SQL 文本的类型/表达式片段，沿用 B18 `validate_cast_type` 同精神做字符集白名单（`[A-Za-z0-9_().,' " ]` 之类），**顺序不变：先校验后插值**。[MUST]

**默认值 / 约束体表达式（N-D2 关键）**：
- `default`（`addColumn`/`modifyColumn`）与 `addConstraint`/`addIndex` 的 `definition` 本质是「用户输入的 SQL 片段」（PG 约束可含任意表达式），产品功能需要，无法参数化。安全红线是**把它钉死在模板的固定位置**：
  1. [MUST] 表达式**只允许**出现在模板内列 default 位置 / 约束定义位置，**绝不**作为独立语句执行、**绝不**拼入标识符位置（标识符位置必须 `quote_identifier`）。
  2. [MUST] 长度限制：`default` ≤4KiB、约束/索引定义 ≤16KiB（超限整体拒绝，不截断）。
  3. [MUST] 表达式不落日志、不参与 DDL 预览以外的任何持久化。
  4. [SHOULD] 提交前 DDL 预览**必须完整回显**含表达式的最终 ALTER 语句（用户对将执行文本有完整知情权）。
  5. [MUST] 语法/语义错误由**事务回滚**兜底（§2.3）——表达式非法 → PG 报错 → 整体 ROLLBACK → 前端展示聚合错误；**禁止**「跳过非法变更继续应用」。

### 1.3 DDL 构造铁律汇总 [MUST]

- 唯一合法标识符构造：`quote_identifier`（postgres.rs:1008）。schema/table/列/约束/索引/FK 名**全部**经它；注入串（`weird"; DROP TABLE x; --`）经 quote 后成为字面标识符，已有单测先例（postgres_catalog.rs:1266）。
- 一切值/存在性判断走参数化 catalog 查询（`client.query(..., &[&schema, &name, ...])`），**禁止**格式化字符串拼 catalog 谓词。[MUST]
- FK 引用表/列名同样 quote_identifier；`refSchema` 先 `require_schema`。[MUST]
- 单次 `operations` 上限：≤100 条（防 IPC 超大 payload 与失控变更批）。[MUST，数值可随 sprint 调整但必须存在]

### 1.4 测试与验收（DDL 应用）

| 用例 | 期望 |
|---|---|
| 前端以 `postgres_execute` 传 `ALTER TABLE ...` | 该路径不存在（命令面审查）；设计器只能走 `postgres_apply_table_design` |
| 九种 op 白名单外传 `dropDatabase`/`grant`/`ALTER SYSTEM` | 整体拒绝，无语句执行 |
| 注入串作为表名/列名（`a"; DROP TABLE x; --`） | quote_identifier 后成为字面标识符，DDL 正确（单测断言生成语句） |
| 非法类型名 / 类型修饰片段透传 | "unsupported data type"，无语句执行 |
| 不存在列 dropColumn | 明确报错，不泄漏表内其他列 |
| 表达式含分号/注释/子查询 | 钉死在模板位置，不产生独立语句；事务内语法错 → ROLLBACK |
| readOnly 连接 apply | 服务端明确拒绝 |
| FK onDelete 传 `"cascade; drop table x"` | 白名单拒绝 |

---

## 2. B23 破坏性操作护栏与事务性 DDL（N-D3/N-D4）

### 2.1 drop column 带数据 → 服务端确认 [MUST]

- `dropColumn` 执行前，服务端参数化统计行数 `SELECT count(*) FROM <schema>.<table>`（表名经 quote_identifier；行数用于 UI 展示，不用作门禁本身）。
- **行数 > 0 且 `confirmed=false`** → 返回预览 `{ dropAffectsRows: N, ... }`，**不执行**；`confirmed=true` 才生成 `ALTER TABLE ... DROP COLUMN ...`。[MUST]
- **语义红线**：服务端 `confirmed` 是唯一权威确认（前端对话框只是 UX，先例 B21 §2.1）；`confirmed` 缺省值必须为 `false`（`#[serde(default)]`）。[MUST]
- 顺带防线：PG 对该列有依赖（视图/默认引用等）时 `DROP COLUMN` 本身报错 → 事务回滚兜底，无需额外 CASCADE 语义（**禁止**为 dropColumn 隐式附加 `CASCADE`）。[MUST]

### 2.2 二次确认沿用 B21 AlertDialog 模式 [MUST]

- 破坏性变更集合（`dropColumn` 行数>0、`dropConstraint`、`dropForeignKey`、`dropIndex`）在 `confirmed=false` 时整体返回 dry-run 预览（受影响行数、将删除的约束/索引/FK 名单），前端沿用 B21 Drop 确认 AlertDialog 展示后二次调用（`confirmed=true`）。[MUST]
- **执行阶段重新校验存在性**（TOCTOU，先例 postgres_drop_object:1081）：确认与执行之间对象被并发删改 → 执行时报 "object does not exist" 并 ROLLBACK，不信任 dry-run 结果。[MUST]

### 2.3 事务性 DDL：单命令内 BEGIN→应用→COMMIT [MUST]

PG DDL 是事务性的。B23 必须复用 `postgres_save_table_changes` 的形态 B 复合命令骨架，**禁止** BEGIN/COMMIT 跨 IPC 往返（M2 教训）：

1. 入口处读 `txn_modes`：`manual` 存在 → 拒绝「A transaction is already in progress...」；`save`/`ddl` 存在 → 拒绝重入。[MUST]
2. 写入 `txn_modes[connection_id] = "ddl"`（**新标记值**，复用同一张表与同一把锁的判定；B19 §1.2 外来命令拒绝逻辑对 `"ddl"` 必须同样生效，即 save 事务表中「外来命令拒绝」列同步覆盖 `ddl` 态）。[MUST]
3. `BEGIN` → 逐条按 §1.1 模板生成并执行 ALTER 语句（每条包 `QUERY_TIMEOUT`）→ 全部成功后 `COMMIT`。[MUST]
4. **任一步失败**（含 timeout、M3 式校验、PG 报错）→ `ROLLBACK`（复用 `rollback_save` 先例）→ 清 `txn_modes` 标记 → 返回聚合错误（含失败步索引与原因）；ROLLBACK 本身失败 → 拆除连接（B19 §3.1 第 3 条）。**所有路径**（成功/失败/超时）必须清标记。[MUST]
5. 应用期间同连接上任何外来命令（`postgres_execute`、`postgres_table_data`、`postgres_catalog_*` 等）→ 按 B19 §1.2 拒绝（fail-fast），UI 侧 `applying` 态禁用对应入口为兜底而非唯一防线。[SHOULD 前端配合]
6. **回滚语义**：不支持「DDL 预览/回滚」中的回滚 = 撤销已提交变更（那是结构同步 B28 的事）。B23 的「回滚」仅指**应用失败的事务回滚**，UI 文案不得暗示已提交 DDL 可一键撤销。[MUST]

### 2.4 超时与取消 [MUST]

- 每条 ALTER、BEGIN/COMMIT 均包 `tokio::time::timeout(QUERY_TIMEOUT, ...)`；超时 → 走 B19 §4.2 取消语义（cancel→teardown），不得只报错留悬挂事务。[MUST]
- 应用期间用户点「停止」：中止当前语句 → ROLLBACK → 清标记；命令落底返回。[MUST]

### 2.5 测试与验收（护栏）

| 用例 | 期望 |
|---|---|
| dropColumn 有数据 + confirmed=false | 返回行数预览，无 DDL 执行 |
| dropColumn 有数据 + confirmed=true | 执行成功 |
| confirmed 缺省 | 视为 false（serde default） |
| 确认与执行间对象被删（注入） | 执行阶段重校验 → "object does not exist" + ROLLBACK |
| 应用中途一条非法 ALTER（如类型冲突） | 整体 ROLLBACK；`SELECT` 验证无半应用变更；标记已清，随后命令正常 |
| manual 事务开在 apply 前 / apply 进行中 | 拒绝重入 |
| 应用超时 | cancel→teardown，PG 侧无残留事务（`pg_stat_activity` 验证） |
| 应用后 `txn_modes` | 清空，同连接可正常查询 |

---

## 3. B23 DDL 预览回显安全面（N-D5）

### 3.1 透传红线 [MUST]

- 服务端对 `pg_get_*`（`pg_get_viewdef`/`pg_get_functiondef`/`pg_get_constraintdef`/`pg_get_indexdef`）输出**原样透传**，不做改写；沿用 B21 §3：**返回前不落日志**、前端 DDL 区域只读、**禁止** `dangerouslySetInnerHTML`/`innerHTML`。[MUST]
- 大小上限：沿用 `DDL_MAX_LEN` 512KiB 截断 + `truncated=true`（postgres_catalog.rs:25 已有常量，B23 预览复用）。[MUST]
- View Builder 的 DDL 预览：视图定义由服务端用 `pg_get_viewdef` 解析（先例 view_ddl，postgres_catalog.rs:423），前端**不得**自行把设计器字段拼成 SELECT 预览文本展示为「将执行 SQL」——预览文本必须与服务端将执行的语句一致或明确标注「预览」。 [SHOULD]

### 3.2 硬编码凭据风险与「脱敏」结论 [MUST]

- **风险事实**：函数/触发器定义体可能含硬编码凭据（`CREATE SERVER ... PASSWORD 'xxx'`、`dblink_connect('...password=...')` 等）；视图定义（`pg_get_viewdef`）本质是 SELECT 文本，通常不含凭据，但底层表可能敏感。DDL 预览是合法功能（DBA 本就可见），**约束是生命周期治理，不是禁止或内容脱敏**。[MUST]
- **「是否脱敏」结论**：**不脱敏**。DDL 是任意 SQL 文本，无可行的可靠凭据识别/脱敏算法，脱敏反而破坏 DDL 预览的合法性（Navicat 也不脱敏）。改为：
  1. [MUST] DDL 文本不落日志、不进入剪贴板以外的任何自动持久化；B26 导入导出平台涉及 DDL 导出时默认排除或加密（**先写进约束**）。
  2. [SHOULD] 对 function/trigger 类 DDL 预览显示一次性提示条「定义可能含敏感信息（如硬编码凭据），复制/截屏前确认」；view 类可不提示或弱提示。
  3. [SHOULD] 剪贴板复制是用户主动动作，不拦截。

### 3.3 测试与验收（DDL 预览）

| 用例 | 期望 |
|---|---|
| 含 `</script>`/`<img onerror=...>` 的函数体渲染 | 按文本显示，无脚本执行（grep 审查无 innerHTML 路径） |
| 预览文本超 512KiB | truncated=true + 截断展示 |
| 日志审查 | DDL/函数体不出现在任何日志输出 |
| function DDL 预览 | 展示敏感信息提示条 |

---

## 4. B23 权限不足处理（N-D6）

- **错误映射**：apply 阶段 PG 报 `permission denied` / `insufficient privilege`（无 ALTER/DDL 权限）→ 服务端映射为通用错误「insufficient privilege to modify table <schema>.<table>」，**不透传底层错误全文**（底层文本可能含对象/行号/权限细节；复用 `map_ddl_privilege_error` 模式，postgres_catalog.rs:280）。[MUST]
- **不泄漏表结构细节**：无权限场景下，错误信息不得包含列清单、类型、约束定义等结构细节；对象存在性 vs 无权限的区分**只允许**以「table does not exist」（已过 `has_schema_privilege` 视域时）或通用权限错误两种形态出现，不得通过第三态信息猜出对象结构。[MUST]
- 预览与执行分阶段失败：预览（读 catalog）无权限 → 报「无法加载表结构」通用错误，不展示结构；执行无权限 → §4 通用映射。[SHOULD：预览读取即失败时，设计器应整体不可编辑并提示无权限，而不是半展示后执行阶段才报错]
- 审计日志（console 级）可记录 `{connectionId, schema, table, op, ok, reason}`，**不得**记录结构细节与凭据。[SHOULD]

测试：无 ALTER 权限连接 apply → 返回通用权限错误，不含列/类型细节；无 SELECT 权限连接打开设计器 → 通用「无法加载表结构」。

---

## 5. B24 ER 图数据源安全（N-E1/N-E2）

### 5.1 FK 关系查询：参数化 + schema 白名单 [MUST]

- 新增专用命令（如 `postgres_er_fks(request: { connectionId, schemas: string[] })`）返回 FK 边集：`{ schema, table, columns, refSchema, refTable, refColumns, constraintName, onDelete, onUpdate }`。[MUST]
- **全参数化**：`pg_constraint`（contype='f'）查询的 `schemas` 以 `= ANY($1)` 或逐项 `$n` 绑定，**禁止**拼进 SQL 文本；返回集 `LIMIT` 上限（建议 10,000 边，与 `CATALOG_GROUP_LIMIT` 同精神）。[MUST]
- **schema 白名单**：请求的每个 schema 经 `require_schema`（参数化 + `has_schema_privilege`）校验；请求 schema 不存在/无权限 → 该 schema 整体从结果剔除或报「schema does not exist」（**fail-closed**，与 B21 §1.1 一致：门禁后不再以该 schema 构造任何查询）。[MUST]
- **权限守卫**：FK 查询必须带 `has_schema_privilege(n.oid,'USAGE')` 过滤（与 catalog 六类查询一致）；无权限 schema 的对象不出现在画布。[MUST]
- `onDelete`/`onUpdate` 枚举值白名单取回，前端只做展示。[SHOULD]
- 单请求 schema 数量上限 ≤50。[SHOULD]

### 5.2 画布渲染：禁止 innerHTML + SVG 注入防护 [MUST]

PG 标识符可含**任意字符**（含 `<`、`"`、`&`、`</text>`、emoji、控制字符），表名/列名是画布文本内容，直接构成 XSS/SVG 注入面：

- **绝对红线**：ER 画布（表盒、列行、关系线标签、tooltip）**禁止** `dangerouslySetInnerHTML`、`innerHTML`、`insertAdjacentHTML`；所有标识符经 React 文本节点（`<text>{name}</text>`）渲染。[MUST]
- **SVG 注入防护**：
  1. [MUST] 标识符**禁止**出现在任何 SVG/HTML 属性的非白名单位置（`xlink:href`、`style`、`fill`、`id` 等——`<script>` 借 `onload`/`onclick` 属性注入是经典载体）；颜色等属性值沿用 B22 白名单（`^#[0-9a-fA-F]{6}$`），不渲染任意字符串进属性。
  2. [MUST] 画布元素若需 `key`/`id`，用内部自增编号或 hash，**禁止**用表名/列名原文作 DOM id（`document.getElementById` 语义 + 特殊字符破坏选择器）。
  3. [MUST] 禁止把后端返回的任何字符串拼入 SVG 字符串模板后 `dangerouslySetInnerHTML={{__html: svgString}}` 式整段渲染——ER 画布必须用 React 元素树受控渲染；若采用生成 SVG 字符串方案，**必须**逐标识符先做 XML 转义且仍禁止属性注入，但**强烈建议**直接走 React 元素树（转义漏一次即 XSS）。[MUST：方案二必须过安全评审]
  4. [SHOULD] 表名过长展示截断（画布性能 + 视觉），但不改变渲染路径安全。
- 布局持久化读回的数据（坐标/表引用）**同样**只能经上述受控路径渲染（防 localStorage 被改造成注入通道，见 §7）。[MUST]

测试：建一张名为 `<img src=x onerror=alert(1)>`（或 `<text>` 注入串）的表 → ER 画布渲染后无脚本执行、无节点逃逸（原生 E2E + grep 审查）；表名含 `"&<>` 各字符正常显示。

---

## 6. B24 删线 = 删 FK 约束（N-E3）

- **绝对红线**：画布删除关系线（快捷键 Delete，master plan §7.2「ER-新建/删除 FK」）**禁止**前端拼 `ALTER TABLE ... DROP CONSTRAINT ...` invoke；必须走 B23 的 `postgres_apply_table_design` 的 `dropForeignKey` 白名单化路径（同源同构，服务端 quote_identifier + 存在性校验 + readOnly 拦截 + QUERY_TIMEOUT）。[MUST]
- 复用 B23 二次确认模式（§2.2）：删除关系线 → dry-run 确认（展示 FK 名与两端表）→ `confirmed=true` 执行；FK 不存在 → "constraint does not exist"。[MUST]
- 删除 FK 与 drop constraint 的关系：`dropForeignKey` 服务端实现 = 模板 `ALTER TABLE {schema}.{table} DROP CONSTRAINT {name}`（quote_identifier），与 `dropConstraint` 复用同一构造函数；前端语义上分开（ER 线 vs 约束列表）只是 UI 层区分，**不得**出现第二条执行路径。[MUST]
- 事务性：B24 FK 删除同样包单命令事务（BEGIN→DROP→COMMIT，失败 ROLLBACK），复用 §2.3。[MUST]

测试：ER 画布删线 → 仅走 `postgres_apply_table_design(dropForeignKey)`；约束实际已删（catalog 验证）；readOnly 拒绝；确认与执行间 FK 被删 → not-exist 报错。

---

## 7. B24 布局持久化存储校验（N-E4）

- 若布局持久化落 **localStorage**：
  1. [MUST] 容量上限 ≤1MiB（超限拒绝写入，防 DoS）；存储值必须 JSON 结构校验（解析失败丢弃，不崩溃）。
  2. [MUST] **字段白名单**：只存 `{ tablePositions: [{ key: 画布内自增id, x, y }], zoom, selectedKeys, ... }` 固定结构；坐标/缩放必须数字校验（`Number.isFinite` 且范围 clamp，如 x/y ∈ [-1e6, 1e6]）；**禁止**把任意后端返回对象整段序列化存下。
  3. [MUST] **不存敏感数据**：不存 SQL 文本、不存凭据、不存 DDL 预览文本。
  4. [SHOULD] 表引用（schema/table 名）可存（用于恢复位置映射），但读回渲染必须走 §5.2 受控路径；若存，写入时长度限制（≤256/项）与非法字符不做硬限制（渲染层已防），但**推荐**存「本次加载的 schema 白名单内」的表名（未知表名恢复时忽略位置）。[SHOULD]
- 若布局持久化落**服务端文件**：路径必须来自 Tauri dialog，禁止接受前端任意 path（B22 §4.4 同款）。[MUST]
- 校验函数与写入口解耦：localStorage 写入前统一走一次校验（与读回校验同一函数），防多处写路径绕过。[MUST]

测试：localStorage 注入超长/非法坐标/`__proto__` 键 → 拒绝或净化；读回渲染无 innerHTML 路径；恶意 `x=NaN`/`Infinity` → clamp/丢弃。

---

## 8. 禁止回退清单（B18/B19-20/B21-22 既有体系 + B23/B24 新增，PR 自查勾选）

1. [ ] 表数据路径 `client.query()`（extended protocol）——不回退 `simple_query`（B18 §0/§6.1）。
2. [ ] 一切值走 `$n` 参数绑定，无字符串拼接/手动转义（B18 §1.1）。
3. [ ] 标识符先白名单后 `quote_identifier`，顺序不变（B18 §1.2/§3；B23 所有 DDL 模板同守）。
4. [ ] `validate_cast_type` 字符集守卫覆盖所有被插值进 SQL 的类型名/表达式片段（B18 §1.3；B23 §1.2）。
5. [ ] 边界常量：条件 ≤32、排序列 ≤8、过滤值 ≤64KiB、offset ≤1,000,000、QUERY_TIMEOUT（B18 §4）。
6. [ ] NULL 语义：值操作符 value=None 拒绝、`isNull/isNotNull` 不绑参（B18 §2.2/§5）。
7. [ ] readOnly：连接时 `SET default_transaction_read_only` + UI 双层护栏；B23 apply / B24 FK 删同样服务端显式检查（B19 §6、B21 §2.3）。
8. [ ] M2/M3/M4：save 事务互斥、count==1 校验、失败主动 ROLLBACK（B19 §1-3）——B23 DDL 事务复用同一套（txn_modes/rollback/拆连接）。
9. [ ] 凭据/指纹基线：密码不落日志、SSH 指纹 fail-closed、禁 zlib 隧道；B21 DDL 文本不落日志（B23 §3 同守）。
10. [ ] B21 catalog：六类查询全参数化 + `has_schema_privilege` + schema 白名单（B21 §1；B24 FK 查询同守）。
11. [ ] B21 破坏性操作：前端禁拼 DROP/TRUNCATE；只走白名单专用命令 + confirmed + CASCADE 显式（B21 §2；B23 dropColumn/dropConstraint、B24 dropForeignKey 同守）。
12. [ ] B21 DDL 透传：无 innerHTML、无日志、权限错误通用化、超限截断（B21 §3；B23/B24 渲染同守）。
13. [ ] **B23 新增**：前端禁拼 ALTER 字符串；设计器只走 `postgres_apply_table_design` 白名单化命令（§1）。
14. [ ] **B23 新增**：事务性 DDL 单命令内 BEGIN→COMMIT，失败 ROLLBACK；`txn_modes` 增 `"ddl"` 态且外来命令拒绝列覆盖（§2.3）。
15. [ ] **B24 新增**：ER 画布无 innerHTML/无 SVG 属性注入/标识符仅文本节点渲染（§5.2）。
16. [ ] **B24 新增**：删线仅走 `dropForeignKey` 白名单路径，无旁路（§6）。

---

## 9. 交付前验证清单（安全侧门禁，随 PR 提交证据）

| 项 | 验证方式 |
|---|---|
| apply 命令：九种 op 白名单、无前端拼 SQL 路径、quote_identifier 全覆盖 | 代码审查（grep `ALTER TABLE` 不出现在前端拼接处）+ Rust 单测（注入串表名/列名生成语句断言） |
| 类型 pg_type 校验、表达式钉死模板位 + 长度限制 | Rust 单测 + 集成测试 |
| 存在性/列存在性校验、confirmed 缺省 false、执行前 TOCTOU 重校验 | Rust 集成测试 |
| 事务性 DDL：成功/失败/超时三路径标记清空、ROLLBACK、manual/save/ddl 互斥 | Rust 集成测试 + `pg_stat_activity` 无残留事务 |
| DDL 预览：无 innerHTML、无日志、512KiB 截断、function 提示条 | grep 审查 + 集成测试 + 日志审查 |
| 权限错误通用化（无 ALTER → 通用信息，无结构细节） | Rust 集成测试（构造无权限连接） |
| ER FK 查询：参数化、schema 白名单、has_schema_privilege、LIMIT | Rust 集成测试 |
| 画布渲染：`<img onerror>` 表名/列名渲染无脚本、无属性注入、无 DOM id 用原文 | grep 审查 + 原生 E2E |
| 删线仅走 dropForeignKey；二次确认；readOnly 拒绝 | 代码审查 + 原生 E2E |
| 布局持久化：容量/字段白名单/坐标数字校验/无敏感数据/读回渲染受控 | vitest 单测 + grep 审查 |
| §8 禁止回退清单 16 项 | PR 自查勾选 + 安全评审复核 |

> fe-dev/fe-dev2 对红线有任何放宽需求（如 operations 上限、表达式长度、FK 边 LIMIT、布局容量），先提 security 评审，不在 PR 里静默改。
