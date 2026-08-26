# B18 Slice A「数据网格过滤与排序」QA 评审报告

> 作者：qa（严过关）｜2026-08-26
> 评审对象：B18 Slice A 过滤/排序功能测试资产（Rust 单测 / 前端单测 / E2E spec）
> 评审方式：纯代码走查（只读核对，未执行任何测试；WDIO 桌面环境不稳定为已登记 R9 风险）
> 上游输入：`b18-filter-test-plan.md`（测试计划）、`b18-slice-a-ac-tracker.md`（AC 清单）、`batch-18-browse-plan.md` §4/§9/§11
> 验证基线（fe-dev 提供的环境验证结果，本报告引用不复测）：vitest **708 passed** / cargo test **244 passed** / tsc **0 error**

---

## 1. 各层测试落地核对

### 1.1 Rust 单测（`cargo test`，src-tauri/src/postgres.rs:1501-1860）

计划 R-1…R-14 全部落地，实测 **22 个** filter/order 相关测试（超出计划的 14 个），断言质量高（SQL 字符串精确断言 + params 向量断言双保险）：

| 分组 | 测试（postgres.rs 行号） | 计划映射 | 断言质量评价 |
|---|---|---|---|
| 条件构造 | `where_clause_binds_values_with_typed_casts`(:1519)、`…or_logic_joins_predicates`(:1534)、`…supports_full_operator_set`(:1561，六运算符循环)、`…null_operators_bind_no_value`(:1589) | R-1~R-4 | 优：逐运算符断言 `$n::text::<type>` 形态与 params 顺序 |
| NULL/空值边界 | `…rejects_null_value_on_value_operators`(:1614)、`…distinguishes_none_from_empty_string`(:1634)、`…value_operators_require_a_value`(:1649) | R-15（计划补充项已实现） | 优：`None`≠`""` 语义显式锁定，7 个值运算符全量循环 |
| like 语义 | `where_clause_like_binds_pattern_verbatim`(:1667) | R-5/R-16 | 优：`%O'Brien%` 原样绑定且 `LIKE $1::text` 不做列类型 cast（security §2.1 对齐） |
| 防护上限 | `…rejects_too_many_conditions`(:1684，>32)、`…rejects_oversized_value`(:1700，>64KB)、`…rejects_unsafe_cast_type_from_catalog`(:1713，catalog 污染类型名拦截) | 计划外新增 | 优：DoS/二阶注入护栏，计划未要求但已补 |
| 白名单拒绝 | `…rejects_unknown_column/operator/logic`(:1730/:1743/:1756)、注入字面绑定(:1780) | R-7~R-10 | 优：注入串 `x' OR '1'='1` 断言进 params 不进 SQL 文本 |
| 空条件 | `where_clause_empty_conditions_yields_no_clause`(:1769) | R-6 / A-12 | 优 |
| ORDER BY | `order_by_whitelists_columns_and_directions`(:1795)、`…appends_primary_key_tie_breaker`(:1813)、`…empty_without_primary_key_yields_no_clause`(:1824)、`…rejects_unknown_column/direction`(:1830/:1839)、`…rejects_too_many_columns`(:1849) | R-11~R-14 | 优：多列 + PK 兜底 `score DESC, name ASC, id ASC` 形态断言到位 |

结论：**Rust 层 22/22 用例落地，计划 14 项全覆盖 + 8 项计划外加固，无缺口。** 计划 §3.3 中仅 R-17（列名含引号 `we"ird` 的 `quote_identifier` 转义专项测试）未见独立用例，但 `quote_identifier` 为既有复用函数且全部测试经其路径，风险低。

### 1.2 前端单测（vitest，src/lib/__tests__/）

| 文件 | 数量 | 覆盖点核对 |
|---|---|---|
| `table-filter.test.ts` | 7 | `resolveFilterShortcut` 三态（apply/replay/refresh，A-7 纯函数决策）4 例 + `isEmptyFilter`（A-12：空条件+空排序=清除；仅排序非空）3 例。纯函数抽取建议（AC tracker §5.2）已落实 |
| `database-command-registry.test.ts`（filter 相关） | 1 大用例（约 10 断言） | 四命令 `filterByFieldValue/customFilter/filterSort/clearFilter` 在 DATA_GRID+connected 下 enabled；SQLite（无编辑能力）下仍 enabled（**A-9 readOnly/read-only provider 读操作不拦截**）；QUERY_EDITOR scope 下 hidden+wrong-scope（**A-13 命令侧范围守卫**） |
| `find-matches.test.ts` | 7 | B-6 网格查找回归：大小写不敏感 contains、NULL 单元格跳过、空文本无匹配、next/previous 环绕、空结果集稳定 |
| `grid-layout-storage.test.ts` | 5 | Slice C 前置（列布局存储）：key 按 provider/connection/schema/table 隔离、round-trip、默认值、损坏 JSON 回退、越界数值消毒 |

结论：**前端纯逻辑层计划 V-1~V-7、V-8/V-9 对应覆盖到位**；V-10（Ctrl+R 焦点守卫）无独立单测，仅实现于 `tool-postgres.tsx:1266-1270`（`typingInField` 提前 return），逻辑内联在组件中未抽纯函数，详见 §3 缺口 G-4。

### 1.3 i18n 对齐（zh-CN.json / en.json）

脚本比对两侧共 **1926 个扁平 key，完全对齐（差集为空）**。B18 新增过滤键 22 个（`toolbox.postgres.filterByFieldValue / customFilter / filterSort / filterSortTitle / filterSortSection / clearFilter / filterActive / filterColumn / filterOperator / filterValue / filterLogicAnd / filterLogicOr / filterAddCondition / filterRemoveCondition / filterAddSort / filterApply / filterCancel / filterClear` 及运算符名 `operatorEq/Neq/Gt/...` 等），zh/en 值一一对应，占位符（`{{count}}`）一致。**无缺口。**

### 1.4 类型检查

tsc **0 error**（验证基线引用），前端 TS 层无遗留类型债。

---

## 2. E2E 评审（e2e/desktop/postgres-filter.e2e.ts）— 状态 **DEFERRED（R9）**

### 2.1 用例设计质量

主链路（A-1 apply + A-8 clear）设计合理：

- **相对断言策略正确**：行数 N → <N → 恢复 N，避免 B17 grid-edit 残留行（e2e_b17i_*）导致的绝对值 flake；
- **列值匹配不变量强**：`allCellsMatch` 断言过滤后所有可见行 `active` 列文本 === 原值，比单纯行数断言强一档；
- **稳定性处理到位**：`switchWindow` 4 次重试（冷启动）、全部 DOM 查询经 `browser.execute` 页面内完成（规避 stale element 旋转）、`waitUntil` + 15s 超时、整体 `this.timeout(150000)`、`Date.now()` 唯一值防碰撞；
- **React 受控输入处理正确**：端口字段经原生 value setter + input 事件绕过 React 值跟踪（与 grid-edit spec 同款惯例）；
- 菜单项定位用正则 `/Filter by field value|按字段值|字段值/` 兼容 i18n，稳健。

### 2.2 发现的问题（执行必失败项，需修复后再排期）

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| E2E-BUG-1 | 清除按钮选择器用 `[data-testid="postgres-filter-clear"]`，实际 DOM 为 `postgres-clear-filter`（tool-postgres.tsx:1368） | spec :179 | 清除段必失败（testid 契约不匹配——spec 是 fe-dev 落地前写的预估版，计划 §5.1 已预警此项） |
| E2E-BUG-2 | `rowCount()` 等 4 个 helper 的 `browser.execute` 回调引用外层常量 `WORKSPACE_SELECTOR`，WDIO execute 脚本序列化后该闭包变量在页面上下文为 undefined，`querySelectorAll(\`undefined tbody tr\`)` 抛错 | spec :70/:77/:88/:96 | 整个用例从第一步计数起必失败（grid-edit spec 同 pattern 但常量写在回调内，为正确写法） |

### 2.3 结论

E2E 定为 **DEFERRED（R9）**：WDIO 桌面环境不稳定为已登记风险，本批不执行；且 spec 存在 2 个必失败缺陷，需先修复 E2E-BUG-1/2 并对照真实 DOM 复核其余预估 testid（`postgres-filter-badge` 已确认存在，`database-result-context-menu` 已确认存在）后再在稳定环境排期执行。FilterSortDialog 组件（filter-sort-dialog.tsx）无任何 data-testid，A-3/A-4 的 E2E 落地前需先补选择器契约。

---

## 3. 测试缺口清单（对照 AC-A1…A13）

| # | 缺口 | 关联 AC | 现状 | 建议 |
|---|---|---|---|---|
| G-1 | **过滤全链路 E2E 未执行**（含 A-1/A-8 主链路 spec 已写但带 2 个必失败缺陷；A-2 NULL 过滤、A-3 Custom Filter、A-4 Filter & Sort、A-5 过滤重置 offset、A-6 过滤态翻页、A-9 readOnly 连接、A-11 过滤×B17 编辑回归的 E2E 场景未编写） | A-1/2/3/4/5/6/8/9/11 | Rust/vitest 已覆盖各自层语义；端到端集成无已执行证据 | **B19**：修 E2E-BUG-1/2 + 补 FilterSortDialog testid + 等稳定桌面环境（R9 解除后）批量补写执行；其中 A-5/A-6 的 offset 语义已由 Rust `WHERE+LIMIT/OFFSET` 组合构造覆盖（build_where_clause 与 browse 拼装同函数路径），风险可控 |
| G-2 | `applyFilterByFieldValue` 的 NULL→`isNull` 分支（A-2 前端侧）无 vitest：该函数内联在组件（tool-postgres.tsx:756-769），未抽纯函数 | A-2 | Rust 侧 `isNull` 不绑定值已测；前端「右键 NULL 单元格 → 运算符变 isNull」仅代码走查确认 | **本批可补（低成本）**：抽 `buildFieldValueFilter(column, value)` 纯函数 + 3 行单测；或 B19 随 A-2 E2E 一并覆盖 |
| G-3 | `applyFilter`/`clearFilter` 的 tab 状态迁移（draft→active、offset 归 0、徽标条件数派生）无自动化；徽标条件数计算内联于 JSX（tool-postgres.tsx:1355-1360） | A-7/A-12 | `resolveFilterShortcut`/`isEmptyFilter` 纯函数已测；副作用路径（`patchTab`+`browse(reference,0,…)`）未测 | **B19**（需组件级测试基建或 RTL，当前仓库无 React 组件测试惯例，仅 2 个 .test.tsx） |
| G-4 | Ctrl+R **焦点守卫**（R-B18-2）无自动化：`typingInField` 提前 return 逻辑内联在 `onDatabaseKeyDown`（tool-postgres.tsx:1266-1270） | A-7 / R-B18-2 | 仅代码走查：守卫存在且顺序正确（Ctrl 组合键判定后、table tab 分支前） | **B19**：将 `typingInField` 判定与 shortcut 分发抽纯函数补单测；本批风险低（逻辑 3 行） |
| G-5 | 列头右键「Filter & Sort」入口（renderColumnContextMenu，tool-postgres.tsx:1705）仅在 table tab 挂载、query tab 传 undefined——**无 query tab 侧反证测试**（右键菜单不含过滤项的断言） | A-13 | 命令层范围守卫已测（QUERY_EDITOR hidden）；UI 层 renderContextMenu 对 query tab 仍渲染 Copy 项但过滤项被 `tab.type === "table"` 条件排除（:1677），代码走查确认 | **B19**：A-13 的「视觉门禁截图复核」由 pm+QA 人工执行（AC tracker §1 约定），自动化反证可随 E2E 补 |

### 缺口归属汇总

- **本批建议补**：G-2（一个纯函数 + 3 行单测，10 分钟级）
- **B19**：G-1（E2E 批量补写+修复+执行，R9 依赖）、G-3（组件测试基建）、G-4（焦点守卫纯函数化）、G-5（query tab 反证 + 人工视觉复核）

---

## 4. 覆盖统计总览

| 层 | 计划用例 | 实际落地 | 基线结果 | 判定 |
|---|---|---|---|---|
| Rust 单测（filter/order） | 14（+4 建议） | **22**（含 8 个计划外加固） | cargo 244 passed（引用基线） | 覆盖充分 |
| 前端单测（filter 相关） | V-1~V-10 | table-filter 7 + command-registry 1（≈10 断言）；V-10 未落 | vitest 708 passed（引用基线） | 核心覆盖，V-10 缺 |
| i18n | 新 key 对齐 | 22 键 zh/en 全对齐（1926/1926） | tsc 0 error（引用基线） | 无缺口 |
| E2E | 主链路 1 条（A-1+A-8） | spec 已写，**未执行**，含 2 个必失败缺陷 | 无（R9 DEFERRED） | DEFERRED |

---

## 5. QA 结论

### **PASS WITH GAPS**

**依据**：

1. **可自动化验证的核心语义全部落地且通过**：SQL 注入防护（A-10）、空条件=清除（A-12）、Ctrl+R 三态决策（A-7 核心语义）、NULL 运算符语义（A-2 Rust 侧）、命令 enablement 与 scope 守卫（A-9/A-13 命令层）、ORDER BY 白名单 + PK 兜底（A-4 Rust 侧）均有高质量单测，验证基线（vitest 708 / cargo 244 / tsc 0）全绿。
2. **缺口集中在端到端集成层与内联逻辑**：E2E 因 R9 环境风险 DEFERRED 且 spec 自带 2 个必失败缺陷（修复项已列明）；4 项自动化缺口（G-2~G-5）中仅 G-2 建议本批低成本补齐，其余归 B19。
3. **无阻断性质量风险**：所有缺口均有下层单测或代码走查证据托底，不构成 Slice A 发布阻断；建议 team-lead 将 G-2 与 E2E-BUG-1/2 修复列入后续批次任务。
