# B18 Slice A 数据网格过滤与排序 — 安全评审报告

> 评审人：security（安无恙）｜2026-08-26
> 评审对象：B18 Slice A「数据网格过滤与排序」已实现代码（实现后复核）。
> 依据：`docs/database/b18-filter-security-constraints.md`（下称"约束文档"）三条红线及 §6.1 禁止回退清单。
> 评审方式：只读代码走查 + Rust 单测运行验证。**未改动任何产品代码。**

---

## 0. 评审范围

| 文件 | 评审点 |
|---|---|
| `src-tauri/src/postgres.rs` | `build_where_clause`、`build_order_by_clause`、`postgres_table_data`、`validate_cast_type`、`quote_identifier`、常量边界、单测 |
| `src/lib/database/result-types.ts` | 前端过滤契约类型（结构化数据，无 SQL 文本位） |
| `src/lib/database/table-filter.ts` | Ctrl+R 决策逻辑、空过滤判定 |
| `src/components/toolbox/filter-sort-dialog.tsx` | 过滤/排序对话框构造逻辑 |
| `src/components/toolbox/tool-postgres.tsx`（browse / applyFilter / applyFilterByFieldValue） | invoke 调用载荷构造 |

单测运行结果：`cargo test --lib postgres::tests` → **32 passed, 0 failed**。

---

## 1. 红线逐条复核

### 红线 1：过滤 SQL 必须走 client.query() extended protocol（$n 参数化），禁止 simple_query 拼接带 $n 的 SQL

**结论：合规（PASS）**

证据：

1. **SQL 构造全部参数化**。`build_where_clause`（postgres.rs:810-873）中每个 1 参数操作符的 value 仅通过 `params.push(Some(value.clone()))`（:847）进入参数向量，SQL 文本只出现 `$n` 占位符：`"{column} {symbol} ${}::text::{type}"`（:861-863）。LIKE 同样参数化且不 cast 列类型（`LIKE $n::text`），符合约束 §2.1。
2. **执行路径已迁移**。`postgres_table_data`（postgres.rs:1123-1129）统一走 `client.query(&statement, &params)` 并包 `tokio::time::timeout(QUERY_TIMEOUT, ...)`，QUERY_TIMEOUT=30s（:22）。旧的 `simple_query` 浏览路径已删除——postgres.rs 中 `simple_query` 仅剩两处：`postgres_query`（:594，SQL 编辑器自由查询入口，B17 既有行为，用户自担 SQL，无 $n 拼接）与 `postgres_explain`（:649，EXPLAIN 前缀 + 单语句校验，同前）。二者均不属于过滤路径，无回退（约束 §6.1-1 满足）。
3. **无过滤路径也走 query()**。filter 为 None 时 `(String::new(), Vec::new())`（:1093-1094），空 params 传空切片，同一条 `client.query` 执行，消除了"无过滤走 simple_query"的分叉。
4. **测试覆盖**：
   - `where_clause_binds_values_with_typed_casts`：断言 SQL 形态 `"name" = $1::text::text`，参数独立返回；
   - `where_clause_treats_injection_value_as_literal_parameter`：`x' OR '1'='1` 全量作为 $1 字面参数，SQL 文本无注入痕迹；
   - `where_clause_like_binds_pattern_verbatim`：`%O'Brien%` 原样绑定（含 `%` 通配语义验证，约束 §2.3）；
   - `where_clause_supports_full_operator_set`：9 个操作符全部断言 SQL 形态。

### 红线 2：1 参数操作符 value=None 必须报错拒绝，不得静默当 NULL/空串

**结论：合规（PASS）**

证据：

1. `build_where_clause` 中 7 个 1 参数操作符（eq/neq/gt/gte/lt/lte/like，:837）统一走 `condition.value.as_ref().ok_or_else(|| format!("Filter operator {} requires a value", ...))`（:838-843）。**约束文档指出的 `unwrap_or_default()` 缺陷已修复**，不再存在静默空串路径。
2. 超长值在绑定前检查：`value.len() > MAX_FILTER_VALUE_LEN`（64KiB，:844-846）返回错误，且**拒绝而非截断**（截断会静默改变比较语义），符合约束 §4。
3. `isNull` / `isNotNull`（:866-867）生成 `IS NULL` / `IS NOT NULL`，不读取 value、不消费参数序号——NULL 语义只能通过这两个操作符表达，`col = NULL`（恒假）路径不存在。
4. **测试覆盖**：
   - `where_clause_rejects_null_value_on_value_operators`：7 个操作符 × value=null 全部拒绝；
   - `where_clause_value_operators_require_a_value`：value 缺省同样拒绝；
   - `where_clause_distinguishes_none_from_empty_string`：`value: Some("")` 是合法空串参数（约束 §5 空串= `''` 匹配），与 None 语义分离；
   - `where_clause_null_operators_bind_no_value`：isNull/isNotNull 不产生参数。
5. **前端配合**：`applyFilterByFieldValue`（tool-postgres.tsx:756-769）对 NULL 单元格构造 `isNull` 而非 `eq + null`（约束 §5 A-2 满足）；invoke 载荷 `value: condition.value ?? null`（:702）明确传递 null 语义。

### 红线 3：data_type 白名单仅来自 catalog 来源 + 字符集守卫 + 边界限制

**结论：合规（PASS）**

证据：

**3a. data_type 仅 catalog 来源**：
- `PostgresFilterCondition` 结构体（postgres.rs:78-85）**无 type 字段**，前端无法传入类型串（约束 §1.3 结构性消灭 S-3，保持）。契约类型 `result-types.ts` 的 `FilterCondition` 同样无 type 字段。
- cast 目标 `data_type` 取自 `column_types`（本次 `load_column_metadata` 的 `pg_catalog.format_type` 输出，postgres.rs:1081-1088），即白名单与类型同源同次读取（约束 §3"白名单与返回列元数据来自同一次 catalog 读取"满足）。

**3b. 字符集守卫**：
- `validate_cast_type`（postgres.rs:789-798）在每次取用 data_type 后调用（:834），只放行 `[A-Za-z0-9 _(),[\]".]`，注释符（`-`/`*`）、引号（`'`）、分号、反斜杠全部拒绝。
- 测试 `where_clause_rejects_unsafe_cast_type_from_catalog`：污染 catalog 注入 `"text; DROP TABLE x --"` 被拦截。

**3c. 边界限制全部落地**（模块级 const，postgres.rs:778-783）：

| 边界 | 要求 | 实现位置 | 状态 |
|---|---|---|---|
| 条件数 ≤32 | `MAX_FILTER_CONDITIONS` | :817-822 | 落地 |
| value ≤64KiB | `MAX_FILTER_VALUE_LEN` | :844-846 | 落地 |
| 排序列 ≤8 | `MAX_ORDER_BY_COLUMNS` | :883-888 | 落地 |
| offset ≤1M | `.min(1_000_000)` | :1054 | 落地（clamp 而非报错，符合约束"不破坏翻页体验"） |
| limit 1..=1000 | `.clamp(1, 1_000)` | :1051 | 保持 B17 语义 |
| 超时 30s | `QUERY_TIMEOUT` 包裹 query | :22, :1123-1128 | 落地 |

测试覆盖：`where_clause_rejects_too_many_conditions`（33 条拒绝）、`where_clause_rejects_oversized_value`（64KiB+1 拒绝）、`order_by_rejects_too_many_columns`（9 列拒绝）。offset clamp 与超时为运行时行为（数值 clamp 无分支失败可能；超时与 postgres_execute 模式一致），无独立单测但代码路径直接、风险低。

---

## 2. 附加检查

### 2.1 标识符（表名/列名）防注入

- **schema/table**：`postgres_table_data` 入口先校验非空（:1041-1043），随后 `quote_identifier(schema/table)`（:1055-1059）`"` 翻倍转义（:696-698）。注意 schema/table 本身**无白名单**（表不存在的场景由 PG 报错兜底），但引号转义保证其只能命中至多一个关系，不能逃逸标识符位置——与 B17 一致，非新引入面。
- **列名（过滤/排序/SELECT 列表）**：严格白名单。过滤列 `column_types.get(&condition.column)` 查无即拒（:831-833，`Unknown filter column`）；排序列 `valid_columns.contains`（:891-893）；SELECT 列表直接来自 metadata 迭代（:1111-1115），不经用户输入。**顺序符合约束 §1.2：白名单校验 → quote → 拼 SQL**。主键 tie-breaker 列同样来自 catalog（:1060-1067）并 quote。
- **精确大小写匹配**：HashMap key 精确命中，无大小写折叠猜测（约束 §3-1 满足）。
- 测试：`where_clause_rejects_unknown_column`、`order_by_rejects_unknown_column`。

### 2.2 操作符/logic/direction 白名单

- 操作符 9 个固定集合，未列出即 `Unsupported filter operator` 拒绝（:868）；logic 仅 AND/OR（:823-827）；direction 仅 asc/desc（:894-898）。无嵌套分组，单一层级 join（约束 §4）。
- 测试：`where_clause_rejects_unknown_operator`、`where_clause_rejects_unknown_logic`、`order_by_rejects_unknown_direction`。

### 2.3 错误信息泄漏

- 所有错误仅回显用户自输入的列名/操作符与固定文案，或 PG 错误透传（`Failed to load table data: {error}`，与 B17 既有模式一致）。无表内容、无 SQL 文本回显。`validate_cast_type` 失败返回固定文案 `Unsafe column type name from catalog`，不回显被拒类型串。**无敏感泄漏**。

### 2.4 前端契约符合性

- `TableFilterState` / `FilterCondition` / `SortClause`（result-types.ts:33-55）为纯结构化类型，注释明确"D-B18-2：后端构造参数化 SQL，前端不做字符串拼接"。
- `filter-sort-dialog.tsx`：列名来自 `columns[].label`（数据库列名）下拉选择；操作符来自固定 `FILTER_OPERATORS` 常量；value 为自由文本（Input）。`apply()` 仅过滤空条件后原样传递结构（:121-135），**无任何 SQL 拼接**。
- `tool-postgres.tsx` browse()：invoke 载荷逐字段映射（:697-709），camelCase ↔ Rust serde rename_all = "camelCase" 对齐。
- `table-filter.ts`：纯决策函数，无 SQL 相关逻辑。

---

## 3. 新发现问题

### Medium-1：LIKE 通配符 UI 提示缺失（约束 §2.3 [MUST] 的文案部分未落地）

- **现象**：约束 §2.3 要求"该语义必须写进 UI 提示文案（如'支持 % 与 _ 通配符'）"。实际 `filter-sort-dialog.tsx:204` 的 value Input placeholder 仅用 `labels.value`，zh-CN 为 `"filterValue": "值"`（zh-CN.json:1294），en 同样无通配符说明。
- **影响**：用户把 `50%` 当字面匹配却得到通配结果，属可用性/误匹配问题，**非注入风险**（服务端语义正确且有测试锁定）。
- **建议**：修改 locale 文案（如"值（like 支持 % 与 _ 通配符）"或操作符选择 like 时动态提示）。**可转 B19 或随本批文案修补**，不阻塞安全结论。

### Low-1：超时后连接状态无集成测试

- **现象**：约束 §7 要求"过滤查询超时返回错误、连接可继续用（集成单测）"。QUERY_TIMEOUT 已包裹（:1123），但无针对超时的集成测试（需要真实 PG + 慢查询构造，单测环境不可行）。tokio_postgres 单语句 extended protocol 查询超时取消后连接保持可用是库保证，与 postgres_execute 同模式。
- **建议**：转 B19 补集成/E2E 层超时用例（QA 的 E2E 计划 A-10 可顺带覆盖）。

### Low-2：过滤对话框 apply() 未过滤"列名为空"以外的无效条件

- **现象**：`apply()`（filter-sort-dialog.tsx:122-128）的 `nonEmpty` 过滤仅要求 `condition.column` 非空；若用户选择了 1 参数操作符但 value 输入框被清空（受控组件 value 永远为字符串，不会是 undefined），会发送 `value: ""`——服务端按空串字面匹配（约束 §5 明确这是合法语义）。行为正确但用户可能困惑。**无安全影响**。
- **建议**：无需服务端改动；如需 UI 提示（"值为空将匹配空字符串"）转 B19。

### 信息项（不计问题）

- offset clamp 采用 `.min(1_000_000)` 静默截断而非提示，符合约束文档 §4 的设计决策（clamp 避免破坏翻页），非问题。
- `postgres_query`/`postgres_explain` 保留 simple_query 属 SQL 编辑器自由查询入口（B17 验收行为），不在过滤红线范围。

---

## 4. 安全结论

# PASS WITH CONDITIONS

**三条红线全部合规**，均有代码证据 + 单测锁定（32 个单测全数通过），约束文档 §6.1 禁止回退清单 7 项全部满足：

| # | 红线 | 结论 |
|---|---|---|
| 1 | extended protocol 参数化、禁 simple_query 过滤路径 | ✅ 合规 |
| 2 | 1 参数操作符 value=None 拒绝 | ✅ 合规 |
| 3 | catalog 白名单 + 字符集守卫 + 边界（offset≤1M/条件≤32/排序列≤8/value≤64KiB/30s 超时） | ✅ 合规 |

**条件（不阻塞发布，须跟踪）**：
1. [Medium] LIKE 通配符 UI 提示文案补齐——转 B19 或本批文案热修；
2. [Low] 超时后连接可用性的集成测试——转 B19（并入 E2E A-10）；
3. [Low] 空值过滤的 UI 提示——转 B19，可选。

**发布判定**：B18 Slice A 的过滤/排序实现满足全部安全红线，无 Critical/High 问题，可发布。上述条件项均为可用性/测试完备性范畴，不构成安全阻塞。
