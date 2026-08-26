# B18 Slice A「过滤」AC 验收跟踪

> 状态：VERIFIED（fe-dev 实现完成；pm 已于 2026-08-26 逐条核对代码 + 单测证据；原生 E2E 因 R9 环境风险整体 DEFERRED，待稳定环境补跑）
> 作者：pm（许清楚）｜2026-08-26
> 上游规格：`docs/database/batch-18-browse-plan.md` §4（Slice A，AC 原文 A-1…A-13）
> 证据来源：`navicat-premium-context-menus.md`、`navicat-premium-interactions.md`、`navicat-premium-shortcuts.md`
> 关联产出：`b18-filter-security-constraints.md`（security）、`b18-filter-architecture-constraints.md`（architect）、QA 测试计划/E2E spec

## 1. 验收方法代号

| 代号 | 含义 | 归口 |
|---|---|---|
| 原生 E2E | 真实 PG fixture + WDIO 原生 GUI 驱动 | QA（tests/e2e） |
| Rust 单测 | `cargo test`，`src-tauri` where/orderBy 构造、白名单、注入护栏 | fe-dev |
| vitest | 前端纯逻辑单测（filter 状态、命令 enablement、焦点守卫） | fe-dev |
| 人工 | 手工核对（如视觉门禁截图复核） | pm + QA |

## 2. Slice A Acceptance Criteria 清单（AC-A1 … AC-A13）

> 以下 13 条由 `batch-18-browse-plan.md` §4.4 原样提取；验证方式为规格原文，验收方法与依赖为本文档补充。

### 通用依赖（Slice A 全量 AC 共享）

- **Rust**：`postgres_table_data` request 增加可选 `filter?: {logic, conditions:[{column,operator,value?}]}`、`orderBy?: [{column,direction}]`；WHERE/ORDER BY 白名单 + `$n` 参数化绑定；`truncated`（limit+1）判定在 WHERE/ORDER BY 之后保持正确。§4.5/§9。
- **前端状态**：`WorkspaceTab` 增加 `filter?`（draft）与 `activeFilter?`（已应用）；`browse()` 签名扩展携带 filter/orderBy。§4.5。
- **右键基建**：单元格右键新增 Filter by field value / Custom Filter 项；列头 th 挂 ContextMenu（Filter & Sort）。§4.5。
- **命令注册**：`database.data.filterByFieldValue` / `customFilter` / `filterSort` / `clearFilter`（`DATA_GRID` scope，读操作，不要求 `supportsResultEditing`）。§4.5。
- **i18n**：新增过滤相关键。§4.5。
- 注：`columnTypes/columnComments`（Rust 列元数据）为 Slice C 依赖；fe-dev 任务 #1 一并实现，但 Slice A 的 AC 本身不依赖它。

### AC 清单

| # | 验收项（规格原文） | 验收方法 | 当前状态 | 专项依赖 |
|---|---|---|---|---|
| AC-A1 | 右键单元格（非 NULL）→ Filter by field value → 网格以 `col = <值>` 重查，**offset 归 0**，行数 = 匹配数，过滤徽标显示 1 条件 | 原生 E2E | 待实现 | 单元格右键项；filter/orderBy IPC；徽标（[NexTerm]） |
| AC-A2 | 右键 NULL 单元格 → Filter by field value → 结果满足 `col IS NULL` | 原生 E2E | 待实现 | 同上；Rust `isNull` → `col IS NULL`（不绑定值） |
| AC-A3 | Custom Filter：2 条件 AND（eq + like），Apply → 结果与预期 SQL 语义一致；徽标更新 | 原生 E2E | 待实现 | Custom Filter 对话框组件；`like` 值原样绑定 |
| AC-A4 | Filter & Sort：设置条件 + ORDER BY col ASC → 结果有序；多列排序生效 | 原生 E2E | 待实现 | Filter & Sort 对话框（含排序区）；列头右键挂载点；orderBy 白名单 + PK 兜底 |
| AC-A5 | 在第 2 页（offset=100）上应用新过滤 → 结果从 **offset 0** 开始（过滤×分页边界） | 原生 E2E | 待实现 | 应用过滤统一重置 offset=0；`tableOffset` 单一路径 |
| AC-A6 | 过滤态下点 Next → offset 在**过滤后结果集**上继续（LIMIT/OFFSET 带 WHERE 正确） | 原生 E2E | 待实现 | 过滤态分页；Rust WHERE+OFFSET 组合正确 |
| AC-A7 | Ctrl+R：有 draft 未应用 → 应用；无 draft 有 active → 重放；皆无 → 刷新当前页（兼容现状） | 原生 E2E + vitest | 待实现 | **三态逻辑建议抽纯函数**（便于单测）；焦点守卫（编辑 input 聚焦不接管）；R-B18-1/R-B18-2 |
| AC-A8 | 清除过滤 → 全量重查 offset=0，徽标消失 | 原生 E2E | 待实现 | `clearFilter` 命令；徽标清除入口（[NexTerm]） |
| AC-A9 | readOnly 连接：过滤全部入口可用（读操作不拦截） | 原生 E2E | 待实现 | 命令 enablement 不依赖 `supportsResultEditing` |
| AC-A10 | 注入防护：值 `x' OR '1'='1`、列名非法、运算符非法 → 均按字面值/白名单处理，无注入、无 panic | 原生 E2E + Rust 单测 | 待实现 | Rust 列名/运算符/direction 白名单；`$n` 参数化；单测全量覆盖（§9）；与 security 约束文档联动 |
| AC-A11 | 过滤态下 B17 编辑保存不回归（改值→Apply→数据库生效；插入行保存后不在过滤集时按 §4.4.6 处理） | 原生 E2E | 待实现 | B17 编辑闭环 + filter 状态共存；不改变 PK 定位语义 |
| AC-A12 | 空条件（0 条件）Apply / Clear → 等价清除过滤 | vitest | 待实现 | 前端 filter reducer；Rust 空 filter 等价无 WHERE |
| AC-A13 | query tab 结果网格**不出现**任何过滤入口（范围界定 D-B18-1） | vitest + 视觉门禁 | 待实现 | 过滤命令仅 table tab 注册/enable；视觉门禁截图复核 |

## 3. 过滤 UI 交互对照表（Navicat 证据）

| 交互 | 入口位置 | Navicat 行为 | 证据 | NexTerm B18 落地 | 对应 AC |
|---|---|---|---|---|---|
| 字段值过滤（Filter by field value） | 单元格右键 | 以当前字段+值立即建单条件过滤（值 NULL → `IS NULL`，[NexTerm]） | [Fact] M17 p.98；context-menus.md「Data grid / selected cell / Filter by field value」；interactions IN-16 | 单元格右键新增项；单条件覆盖现有过滤 | AC-A1 / AC-A2 |
| Custom Filter | 单元格/网格右键 | 打开自定义过滤对话框（多条件构建） | [Fact] M17 p.98 入口；context-menus.md「Data grid / grid / Custom Filter」；interactions IN-16；对话框内部 UI [NexTerm] | Custom Filter 对话框（§4.3 规格） | AC-A3 |
| Filter & Sort | 列头右键 | 打开过滤+排序对话框（条件 + ORDER BY） | [Fact] M17 p.98 入口；context-menus.md「Data grid / field / Filter & Sort」；interactions IN-16 | 列头右键挂载点 + Filter & Sort 对话框（含排序区） | AC-A4 |
| Ctrl+R | 快捷键（table tab 聚焦，`DATA_GRID`） | 应用过滤/排序（draft→active→重放→刷新兼容） | [Fact] M17 p.380；shortcuts.md「Data grid / Apply filter/sort / Ctrl+R」 | `onDatabaseKeyDown` table tab 语义扩展 + 焦点守卫 | AC-A7 |
| 过滤徽标 + 清除 | table tab 工具栏 | 无 Navicat 手册证据 | [NexTerm]（标注不声称 parity） | 徽标显示条件数 + 清除过滤入口；清除→全量重查 offset=0 | AC-A8 |
| 过滤态分页（Next） | 分页控件 | 过滤集上继续分页 | 交互语义派生；[NexTerm] | LIMIT/OFFSET 带 WHERE 保持正确 | AC-A5 / AC-A6 |
| query tab 排除 | — | 范围界定 D-B18-1 | [NexTerm] | query 结果网格无任何过滤入口 | AC-A13 |

## 4. 验收核对记录

> 逐条核对在 fe-dev 实现完成后进行（由 team-lead 通知）。核对时按「实际代码 + 测试结果」更新下列表格状态：`PASS` / `FAIL` / `PARTIAL`，并附证据（文件:行号 / 测试名 / 截图路径）。

### 4.1 状态总览（2026-08-26 核对完成）

| 状态 | 计数 |
|---|---|
| PASS | 8 / 13 |
| FAIL | 0 / 13 |
| PARTIAL | 0 / 13 |
| DEFERRED（E2E，R9） | 5 / 13 |
| 待实现 | 0 / 13 |

> 判定规则：凡「验收方法 = 原生 E2E」的 AC，运行时行为未在真实 GUI 环境复验前一律 DEFERRED（R9 已登记风险，等稳定环境补跑后转正）；代码路径 + Rust/vitest 单测已核对无缺口。AC-A10 同时有 Rust 单测证据，按单测维度记 PASS（E2E 维度仍待补）。AC-A13 的 vitest 维度已核对，视觉门禁维度 DEFERRED。

### 4.2 逐条核对

| # | 状态 | 核对结论 | 证据（文件/测试/截图） | 备注 |
|---|---|---|---|---|
| AC-A1 | DEFERRED | 代码路径完整：右键项→`applyFilterByFieldValue`→`browse(reference, 0, filter)` offset 归 0；徽标显示条件数。E2E 未跑 | tool-postgres.tsx:1678/756-769/744-754；filter badge :1351-1363（`postgres-filter-badge`）；e2e/desktop/postgres-filter.e2e.ts | E2E spec 首稿已写（相对行数断言防 flake）；R9 环境风险待补跑 |
| AC-A2 | DEFERRED | NULL 单元格走 `value === null` → `operator: "isNull"`；Rust 侧 `col IS NULL` 不绑参数。E2E 未跑 | tool-postgres.tsx:763-766；postgres.rs:866（`isNull => IS NULL`）；单测 `where_clause_null_operators_bind_no_value` | SQL 语义由 Rust 单测覆盖（PASS 维度），GUI 维度待 E2E |
| AC-A3 | DEFERRED | Custom Filter 对话框（mode "custom"，includeSort=false）多条件 AND/OR + Apply；`like` 值原样文本绑定。E2E 未跑 | tool-postgres.tsx:1679/1856-1862；filter-sort-dialog.tsx:121-135；单测 `where_clause_or_logic_joins_predicates`、`where_clause_like_binds_pattern_verbatim` | 对话框 UI 为 [NexTerm] 设计（无 parity 声明），符合规格 |
| AC-A4 | DEFERRED | Filter & Sort 对话框含排序区（includeSort），多列 ORDER BY 白名单 + PK tie-breaker；列头右键挂载。E2E 未跑 | filter-sort-dialog.tsx:268-361；tool-postgres.tsx:1705-1713；postgres.rs:878-909；单测 `order_by_whitelists_columns_and_directions`、`order_by_appends_primary_key_tie_breaker` | |
| AC-A5 | DEFERRED | `applyFilter`/Ctrl+R apply/replay 一律 `browse(reference, 0, …)`，offset 单一路径 `tableOffset`（tab.result.pagination）。E2E 未跑 | tool-postgres.tsx:744-754/1302-1314/324-325 | 代码路径核对无缺口 |
| AC-A6 | DEFERRED | 分页 onNext 调 `browse(…, tableOffset + pageSize)`，无 filterOverride 时自动携带 `tab.activeFilter`；SQL `LIMIT/OFFSET` 在 WHERE 之后拼接。E2E 未跑 | tool-postgres.tsx:1640-1651/683-686；postgres.rs:1118-1122 | |
| AC-A7 | PASS | 三态纯函数 + 焦点守卫 + table tab 限定，vitest 全绿 | table-filter.ts:14-26（`resolveFilterShortcut`）；tool-postgres.tsx:1297-1318（三分支接线）+ 1229-1231/1266-1270（`typingInField` 焦点守卫 R-B18-2）；vitest `resolveFilterShortcut (A-7)` 4 用例 | 纯函数方案采纳了本 tracker §5.2 建议 |
| AC-A8 | DEFERRED | `clearFilter` 清 filter/activeFilter → `browse(reference, 0, null)` 全量重查；徽标随 `(activeFilter \|\| filter)` 条件渲染，清除后消失。E2E 未跑 | tool-postgres.tsx:771-776/1351-1372（`postgres-clear-filter`） | E2E spec 里用的是估计选择器 `postgres-filter-clear`（e2e:179），与实现 `postgres-clear-filter` 不一致 → 已登记 QA 跟进项 Q-B18-1 |
| AC-A9 | PASS | 4 个过滤命令 `requiredCapabilities: []`，不依赖 `supportsResultEditing`；vitest 断言无编辑能力 provider（sqlite）下 enabled | command-registry.ts:277-304；vitest `enables filter commands as read operations without editing capability`（database-command-registry.test.ts:228-258） | |
| AC-A10 | PASS | 值按 `$n::text::<type>` 字面绑定；列名白名单（live column set）+ 运算符/方向白名单 + logic 白名单 + cast type 字符集护栏；越界输入全部 `Err` 无 panic；注入单测显式覆盖 | postgres.rs:810-873/878-909/789-798；Rust 单测 32 通过（`where_clause_treats_injection_value_as_literal_parameter`、`…rejects_unknown_column/operator/logic`、`…rejects_unsafe_cast_type_from_catalog`、`…rejects_oversized_value`、`…rejects_too_many_conditions` 等）；与 security 约束文档 §2/§4/§5 条款一一对应 | E2E 维度随 R9 补跑；单测维度已全覆盖 9 运算符 + 非法列/方向/logic |
| AC-A11 | DEFERRED | 保存后 `tab.activeFilter` 存在时 re-query（§4.4.6：行落在过滤集内/外以服务端为准）；PK 定位仍走 baseline keyValues，语义未变。E2E 未跑 | tool-postgres.tsx:1179-1185（filtered re-query 分支）；saveTableChanges :1069-1210 | B17 编辑闭环 × filter 共存的代码路径核对无缺口 |
| AC-A12 | PASS | 前端 `isEmptyFilter`（0 条件 + 0 排序）→ `applyFilter` 内转 `clearFilter`；Rust 空 conditions 返回空 WHERE | table-filter.ts:24-26；tool-postgres.tsx:746-750；postgres.rs:814-816；vitest `isEmptyFilter (A-12)` 3 用例；Rust `where_clause_empty_conditions_yields_no_clause` | |
| AC-A13 | PASS | 代码层三重排除：单元格过滤右键项 `tab.type === "table"` 包裹（tool-postgres.tsx:1677）、列头菜单 `renderColumnContextMenu` 仅 table 提供（:1705）、命令 scope wrong-scope hidden（QUERY_EDITOR）；vitest 断言 wrong-scope → hidden | tool-postgres.tsx:1677/1705；vitest database-command-registry.test.ts:253-257；Ctrl+R 的 table tab 分支 :1299 | 视觉门禁截图复核维度随 E2E/R9 一并 DEFERRED，不阻塞 |

### 4.3 Navicat 对标语义复核（M17 p.98 / p.380）

| 对照项 | 结论 | 说明 |
|---|---|---|
| 过滤为**服务端过滤** | 一致 | filter 结构化传给 `postgres_table_data`，后端拼 WHERE（postgres.rs:1091-1122）；非前端本地过滤。与 Navicat「重查数据源」语义一致 |
| 字段值过滤入口（M17 p.98，单元格右键） | 一致 | 单条件覆盖现有过滤（applyFilterByFieldValue 构造单条件），NULL → IS NULL 与 context-menus.md 证据吻合 |
| Custom Filter 对话框语义（M17 p.98） | 一致（入口） | 多条件构建 + Apply；对话框内部 UI 为 [NexTerm] 设计，tracker §3 已标注不声称 parity |
| Filter & Sort 入口（M17 p.98，列头右键） | 一致 | 列头 ContextMenu 打开含排序区的对话框；对话框打开时回填 draft ?? active |
| Ctrl+R 语义（M17 p.380） | 一致 | draft→应用 / active→重放 / 皆无→刷新，兼容现状（table tab 刷新、非 table 刷新 navigator） |
| 清除行为（[NexTerm] 无手册证据） | 符合规格 | 清除 → 全量重查 offset=0 + 徽标消失；已按 §3 标注不声称 parity |

## 6. 产品视角放行结论

**PASS（放行，附带条件）**

- 代码 + 单测维度：8 PASS / 0 PARTIAL / 0 FAIL，实现与规格 §4.4 及 security/architect 约束逐条对得上，质量达到发布标准。
- 5 条 DEFERRED 全部集中在原生 E2E 维度（R9 已登记环境风险），非实现缺口；放行条件为 R9 环境就绪后补跑 E2E 并将 DEFERRED 转正。
- 转交 QA 的跟进项：
  - **Q-B18-1**：e2e/desktop/postgres-filter.e2e.ts:179 使用估计选择器 `postgres-filter-clear`，实现实际为 `postgres-clear-filter`（tool-postgres.tsx:1368），补跑 E2E 前必须先修正，否则 clear 断言必挂。
  - E2E 目前仅覆盖 AC-A1/A8 主链路，A2-A6/A11 的 E2E 用例待 QA 按 b18-filter-test-plan.md 补齐。

## 7. QA 跟进项汇总

| 编号 | 项 | 责任 | 状态 |
|---|---|---|---|
| Q-B18-1 | E2E spec 选择器 `postgres-filter-clear` ≠ 实现 `postgres-clear-filter` | QA | OPEN |
| Q-B18-2 | E2E 用例覆盖面扩展（A2-A6/A11） | QA | OPEN（依赖 R9） |
| R9 | 原生 E2E 环境不稳定 | QA/team-lead | 已登记 |

## 5. fe-dev 实现提醒（重点 AC）

1. **AC-A10 注入防护**：Rust 侧必须覆盖全部 9 个运算符 + 非法列名 + 非法 direction 的单测；注入值按字面绑定；任何白名单外输入拒绝且**无 panic**。与 security 约束文档联动。
2. **AC-A7 Ctrl+R 三态**：原 table tab 语义是刷新（tool-postgres.tsx:976），改为「应用过滤」后回归风险高（R-B18-1）；draft/active/皆无三态建议抽纯函数做 vitest，且必须新增 `event.target` 焦点守卫（R-B18-2，编辑 input 聚焦时不接管）。
3. **AC-A13 query tab 排除**：过滤入口（右键项/命令/Ctrl+R 语义）仅作用于 table tab；query 结果网格不得出现任何过滤入口。命令 enablement 是读操作、不依赖 `supportsResultEditing`（AC-A9 同源）。

## 附：核对流程约定

- 核对触发：fe-dev 实现完成 + QA 测试计划就绪后，由 team-lead 通知 pm 启动。
- 核对输入：实现代码、`cargo test` / vitest / E2E 结果、视觉门禁截图。
- 状态判定：AC 全量断言满足 → PASS；任一断言不满足 → FAIL；部分满足且有明确缺口 → PARTIAL（备注列写明缺口与复测项）；验收方法含原生 E2E 且环境不可用（R9）→ DEFERRED（不算 FAIL，环境就绪后补跑转正）。
- 文档维护：核对结果直接更新本文件 §4，更新后同步 team-lead。
- 2026-08-26 核对执行记录：pm 逐条阅读 postgres.rs / tool-postgres.tsx / filter-sort-dialog.tsx / table-filter.ts / command-registry.ts 及三个测试文件；本机复跑取证 `cargo test postgres::` 32 通过、`npx vitest run table-filter + database-command-registry` 25 通过；E2E 未运行（R9）。
