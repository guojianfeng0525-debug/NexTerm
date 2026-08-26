# B18 Slice A 过滤安全约束（实现前评审）

> 作者：security（安无恙）｜2026-08-26
> 适用：fe-dev 实现 B18 Slice A「数据过滤」时必须遵守的实现前安全约束。
> 依据：`batch-18-browse-plan.md` §4/§9；现状 `src-tauri/src/postgres.rs`（B17 模式 + fe-dev 已落地的 `build_where_clause` 骨架）。
> 性质：**只读评审**，不改产品代码。本文每条均为硬约束（[MUST]）或明确建议（[SHOULD]），fe-dev 照此实现即可避开安全坑。

---

## 0. 威胁模型（30 秒速览）

过滤是**唯一一个把用户可控字符串（value）与数据库运算符组合注入 SQL 的 B18 功能**，且可被远端/本机恶意或误操作的前端触发。攻击面集中在 4 处：

| # | 注入面 | 现状风险 | 结论 |
|---|---|---|---|
| S-1 | 过滤**值**（value）进入 SQL | 若走 simple_query / 字符串拼接 → SQL 注入 | 必须 `$n` 参数化（铁律，§1.1） |
| S-2 | **列名**（column）进入 SQL | 直接拼接 → 任意标识符注入 | quote_identifier + 列白名单（§1.2、§3） |
| S-3 | **类型名**（`::text::<type>` 的 type） | 若前端可控类型串 → 类型名即 SQL 文本 | 仅接受 catalog 来源 + 字符集守卫（§1.3） |
| S-4 | **数值/结构爆炸**（条件数、value 长度、offset） | 无上限 → DoS | 边界约束（§4） |

> **最大实现风险（务必先读 §2.1）**：`postgres_table_data` 现在用 `client.simple_query()`（postgres.rs:1049），**simple_query 不支持 `$n` 参数绑定**，会把 `$1` 当字面量文本。实现过滤后**必须迁移到 `client.query()`（extended protocol）**，与 B17 的 `execute()` 路径一致。这是本功能正确性与安全性的前提，不是可选项。

---

## 1. 参数化铁律（对应任务点 1）

### 1.1 所有过滤值必须 `$n` 参数化 [MUST]

- 每个条件值作为参数加入 `params`，SQL 文本中只出现 `$n` 占位符，n 为累计参数序号（`build_where_clause` 现有实现已如此，保持）。
- **禁止**任何形式的 `format!("... {}", value)` 拼接 value；禁止对 value 做"手动转义单引号"后再拼接（这是 B17 已经消灭的反模式，不要复活）。
- 执行必须走 `client.query(statement, &param_refs)`（extended protocol）。**禁止 simple_query 执行带 `$n` 的语句**。

### 1.2 标识符必须 quote_identifier [MUST]

- schema/table/column 一律 `quote_identifier()`（`"` 翻倍转义，postgres.rs:696），**先过白名单，再 quote**，二者缺一不可：
  - quote 只解决"引号内逃逸"，**不解决"被拼进 SQL 语义位"**——所以未知列必须先拒绝（§3）。
  - 顺序固定为：白名单校验 → quote → 拼 SQL。

### 1.3 类型名（cast 目标）必须是 catalog 来源 + 字符集守卫 [MUST]

- `PostgresFilterCondition` **不允许出现 type 字段**（当前定义即无，保持）。前端无法传类型串进 SQL——这是结构上消灭 S-3 的关键，后续迭代不得给该结构加类型字段。
- cast 目标 `data_type` 必须来自 `load_column_metadata`/`load_column_types` 的 `pg_catalog.format_type` 输出（同一查询取白名单 + 类型，避免两次读取间表结构漂移）。
- format_type 输出是服务端可信数据，但它被**插值进 SQL 文本**（`${}::text::{}`），因此构造 cast 前必须过字符集守卫，防御"catalog 被污染"的纵深防线：

```rust
/// format_type 输出是可信的，但它会进入 SQL 文本；只放行合法 PG 类型名
/// 的 ASCII 安全字符集。禁止注释符（- / *）、引号边界符（' ; \）等。
fn validate_cast_type(data_type: &str) -> Result<(), String> {
    if data_type.is_empty()
        || !data_type.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b" _(),[]\".".contains(&b)
        })
    {
        return Err("Unsafe column type name from catalog".into());
    }
    Ok(())
}
```
- 字符集说明：`format_type` 合法输出形如 `integer`、`numeric(10,2)`、`character varying(255)`、`timestamp with time zone`、自定义类型可带 schema 前缀或引号（`"My Type"`），全部落在 `[A-Za-z0-9 _(),[\]".]` 内。`-`、`/`、`'`、`;`、`\` 在合法类型名中不出现，放行它们即等于给 `--`/`/*`/字符串逃逸留门。

### 1.4 单测要求（§1 对应）[MUST]

| 用例 | 期望 |
|---|---|
| 值含 `x' OR '1'='1`、`' OR 1=1 --`、`\`、换行 | 全部作为字面参数绑定，SQL 文本无痕迹 |
| 值含 `%`/`_` | 见 §2.3 LIKE 语义 |
| column 含 `"`、`;`、空格、`--` | 白名单拒绝（未知列）或正确 quote |
| 伪造 data_type（若实现上误加了入口） | 拒绝/字符集守卫拦截 |

---

## 2. 操作符白名单（对应任务点 2）

### 2.1 允许集合与参数形态 [MUST]

B18 固定允许以下操作符，**任何未列出的字符串一律拒绝**（`_ => Err("Unsupported filter operator: ...")`，现有实现已如此）：

| operator | 参数形态 | SQL 形态 |
|---|---|---|
| `eq` | 1 参数（value 必须 Some） | `"col" = $n::text::<type>` |
| `neq` | 1 参数 | `"col" <> $n::text::<type>` |
| `gt` / `gte` / `lt` / `lte` | 1 参数 | `"col" >/>=/</<= $n::text::<type>` |
| `like` | 1 参数 | `"col" LIKE $n::text`（**不 cast 到列类型**，见 2.2） |
| `isNull` / `isNotNull` | **0 参数**，忽略 value | `"col" IS NULL` / `"col" IS NOT NULL` |

### 2.2 1 参数操作符的 value 缺失必须显式处理，禁止静默空串 [MUST]

- **当前实现缺陷（postgres.rs:804, 809, 816, 821, 826, 828）**：`condition.value.clone().unwrap_or_default()` 会把 JSON `null` / 缺省静默变成 `""`，生成 `col = ''`——这是**语义错误**（用户想过滤 NULL 却匹配了空串），且掩盖前端 bug。
- 约束：1 参数操作符要求 `value: Some`，为 `None` 直接返回错误 `"Filter operator {op} requires a value"`。
- 前端侧配合（计划 §4.2 已定义）：单元格值为 NULL 时 Filter by field value 必须构造 `isNull`，不要发 `eq + null`。
- 0 参数操作符 `isNull/isNotNull` 忽略 value 字段（可带可不带，不校验），**不得**把 value 绑定进参数。

### 2.3 LIKE 通配语义与转义策略 [MUST]

- B18 的 `like` 语义为 **[NexTerm] 决策**：值**原样绑定**，`%` / `_` 由用户书写并作为 PG 通配符解释，`\` 为 PG 默认 escape 字符。
- 服务端**不得**对 like 值做任何转义或改写（保持 `LIKE $n::text`，当前实现正确）。
- 该语义必须写进 UI 提示文案（如"支持 % 与 _ 通配符"），避免用户把 `50%` 当字面匹配却得到通配结果。
- **扩展位**：若后续新增 `contains / startsWith / endsWith`，必须由**服务端**构造 `%`/`_` 包裹并对用户输入中的 `\ % _` 三字符全部转义 + `ESCAPE '\'`（此时值才需要转义，与 `like` 相反）。B18 不实现，本条仅锁定"两者语义不能混"。

### 2.4 单测要求（§2 对应）[MUST]

- 全部操作符白名单覆盖（每个 operator 生成正确的 SQL 形态，1 参数/0 参数各覆盖）；
- 非法 operator（`=`、`IN`、`BETWEEN`、`regexp`、空串、`is null` 小写变体等）全部拒绝；
- `eq`/`like` 带 `value: null` → 报错，不生成 SQL；
- `isNull` 带 value 也不产生参数（参数序号不被消费）。

---

## 3. 未知列拒绝（对应任务点 3）

- column（过滤与排序共用）必须命中该表**实际列白名单**——白名单 = 本次查询 `load_column_metadata`/`load_column_types` 的结果（与 B17 的 load_column_types 一致，postgres.rs:726）。
- 校验规则 [MUST]：
  1. **精确大小写匹配**。PG 未引号定义的列名会折叠为小写，前端发来 `Name` 而实际列是 `name` 时**拒绝**（返回 `Unknown filter column: Name`），不做大小写折叠猜测——猜测既错也埋注入歧义。
  2. 校验用白名单 **key 命中**（HashMap 查无即拒），**不允许**在 SQL 里用 `column IS NOT NULL` 之类"试探"。现有 `build_where_clause`（:800）与 `build_order_by_clause`（:850）已实现，保持。
  3. 排序列（order_by[].column）同一白名单，`direction` 仅 `asc`/`desc`（现有 :853 已实现）。
- 返回错误信息允许回显列名（用户自输入，无敏感泄漏），但**不得**回显任何表内容。

---

## 4. 边界与 DoS 防护（对应任务点 4）

以下常量建议定义为模块级 const，单测断言。

| 边界 | 取值（建议） | 规则 | 理由 |
|---|---|---|---|
| limit | 1..=1000 | 保持现状 `clamp(1, 1_000)`（postgres.rs:1010） | 不变更既有分页语义 |
| offset | 0..=1_000_000 | **新增** `clamp(0, 1_000_000)` | 现状无上限（:1011），深翻页 `OFFSET 999999999` 在过滤集上可致 PG 全扫描超时；clamp 而非报错，避免破坏翻页体验 |
| 条件数 | 0..=32 | **新增**：`conditions.len() > 32` 直接返回错误 | 防 AND/OR 组合解析/执行爆炸（DoS） |
| 排序列数 | 0..=8 | **新增**：`order_by.len() > 8` 返回错误 | 防 ORDER BY 列爆炸 |
| value 长度 | ≤ 64 KiB | **新增**：超长**拒绝**（报错） | 参数化下超长不构成注入，但防超大 IPC payload 与 PG 端内存/CPU 浪费。**选择拒绝而非截断**：截断会静默改变 eq/gt 等比较语义（匹配错误数据），比报错更危险 |
| 查询超时 | 30s | **新增**：整个过滤查询包 `tokio::time::timeout(QUERY_TIMEOUT, ...)` | 现状 `postgres_table_data` 未包 timeout（:1049），`like '%a%'` 大表 + OR 组合可能长时间占连接；与 `postgres_execute` 一致 |

- 空条件（0 条件）等价无过滤：`build_where_clause` 已返回空 WHERE（:787），保持"0 条件不生成 WHERE、不产生参数"。
- `logic` 仅 `AND`/`OR`（现有 :790 已实现），**无嵌套分组**（计划 §7.6），单一层级 join 无括号优先级歧义；后续若加嵌套必须引入括号构造并重审，禁止直接拼接。

---

## 5. NULL 语义（对应任务点 5）

| 前端形态 | 语义 | 服务端处理 |
|---|---|---|
| `value: null`（JSON null） | SQL **NULL** | 仅允许出现在 `isNull/isNotNull`；1 参数操作符带 null 一律拒绝（§2.2） |
| `value: ""`（空串） | SQL 空字符串 `''` | 合法参数，正常绑定（`eq` 匹配 `''`，`like` 匹配 `''`） |
| `value` 缺省（字段不存在） | 视同 null | 同上：1 参数操作符拒绝，0 参数忽略 |
| `isNull` | `col IS NULL` | 不绑定值；**不得**生成 `col = NULL`（恒假） |
| `isNotNull` | `col IS NOT NULL` | 不绑定值 |

- **铁律**：SQL 语义中的 NULL 只能通过 `IS NULL/IS NOT NULL` 表达，**任何比较操作符（= <> > <）遇到 NULL 恒为 UNKNOWN**，永远不许把 `None` 值绑定进 `= $n` 的谓词。
- `Filter by field value` 对 NULL 单元格发 `isNull`（计划 §4.2 A-2），前端保证。

---

## 6. 与 B17 既有模式的一致性检查（对应任务点 6）

逐项对照 B17 已验收的安全模式，避免引入新注入面：

| B17 模式 | B18 过滤要求 | 差异/风险点 |
|---|---|---|
| `quote_identifier`（schema/table/column） | 复用同一函数 | 无差异 |
| `$n::text::<type>`（update/delete/insert 均如此） | 过滤值 cast 用同模式 | **唯一新增面**：`<type>` 文本进 SQL，必须过 §1.3 守卫 |
| 参数化执行：`client.execute()`（extended protocol） | **必须** `client.query()` 执行 | **最大差异**：`postgres_table_data` 现用 `simple_query()`，**不支持参数**，必须迁移；迁移后统一走 Row 对象读取（弃用 `SimpleQueryMessage::Row` 分支） |
| LIMIT/OFFSET 数字 clamp 后拼接 | 保持数字拼接（非注入面），但 offset 补上限 | offset 从无界 → clamp(0,1M) |
| 单关系（无 JOIN/子查询），`schema.table` quote 后整体引用 | 保持单表/单视图；WHERE/ORDER BY 仅引用白名单列 | 不新增任何子查询、函数调用、`::regclass` 等 SQL 语法位 |
| 错误透传 `Failed to ...: {error}` | 保持透传（含 PG 类型转换错误，如 `::text::integer` 失败） | 与 B17 一致属既有行为；**必须确保**错误返回后连接仍可用（单语句错误不终止连接，tokio_postgres 保证），前端 toast 展示即可 |
| `truncated` = 行数达到 limit | 在 WHERE/ORDER BY 之后判定 | 过滤不得改变 limit/offset 与 truncated 语义（A-6 依赖） |
| readOnly 连接读操作可用 | 过滤/排序纯读，不拦截 | 无新增约束 |

### 6.1 禁止回退清单（实现 PR 自查）

1. [ ] 过滤 SQL 未用 `simple_query` 执行（含无过滤路径，统一 query() 消除分叉）
2. [ ] 无任何 `value` 字符串拼接进 SQL 文本
3. [ ] `data_type` 无前端入口、已过字符集守卫
4. [ ] 1 参数操作符 value=None 已拒绝（不再 `unwrap_or_default()`）
5. [ ] offset/条件数/排序列数/value 长度边界已落地
6. [ ] 过滤查询已包 QUERY_TIMEOUT
7. [ ] 白名单与返回列元数据来自同一次 catalog 读取

### 6.2 补充建议（非阻塞，[SHOULD]）

- `build_where_clause` 将 `params` 从 `Vec<String>` 转 `&dyn ToSql` 时参考 `postgres_table_insert`（:1205-1209）的模式，注意空 params 时传空切片。
- 单测优先测"SQL 文本形态"，用断言锁定 `"col" = $1::text::integer` 等固定输出，防后续改动悄悄引入拼接。

---

## 7. 交付前验证清单（安全侧门禁）

| 项 | 验证方式 |
|---|---|
| 注入串（`x' OR '1'='1` 等）按字面值过滤且无副作用 | Rust 单测 + 原生 E2E（计划 A-10） |
| 非法 operator / 非法 column / 非法 direction / 非法 logic 全部拒绝 | Rust 单测（计划 §9） |
| 全操作符 SQL 形态断言 | Rust 单测 |
| offset=1_000_001 / conditions=33 / value=64KiB+1 被边界拦下 | Rust 单测 |
| 过滤查询超时返回错误、连接可继续用 | 集成单测 |
| `isNull` 不产生参数、`eq`+null 被拒 | Rust 单测 |
| truncated 在过滤集上正确（A-6） | Rust 单测 + E2E |

> 与架构评审文档（b18-filter-architecture-constraints）如有出入，以本文安全红线为准；红线冲突时先报 team-lead 裁决，不自行放宽。
