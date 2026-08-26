# B18 Slice A 过滤架构约束（实现前评审）

> 作者：architect（高见远）｜2026-08-26
> 适用：fe-dev 实现 B18 Slice A「数据过滤」时必须遵守的**实现前架构约束**（可执行，照做即可）。
> 依据：`batch-18-browse-plan.md` §4/§9；`navicat-parity-master-plan.md` §5（D1/D2/D3）；现状 `tool-postgres.tsx` / `database-result-pane.tsx` / `command-registry.ts` / `result-types.ts`；并行产出 `b18-filter-security-constraints.md`（安全红线，本文不与之冲突）。
> 性质：**只读评审**，不改产品代码。本文每条均为明确决策，fe-dev 遵守。

> **修订 r1（2026-08-26，实现后）**：实现评审（`b18-slice-a-architecture-review.md` MAJOR-1）发现决策 2 的 draft 机制在 UI 上不可达——对话框 Apply 若只写 draft 不查询，则与规格 A-3（"Apply → 结果与预期 SQL 语义一致；徽标更新"）、A-5（以 Apply 触发 offset 归 0）直接矛盾；且列头右键的 draft 预填使 `tab.filter` 永远等于 activeFilter，Ctrl+R 的"应用 draft"分支成为死路径。经裁定，**接受"立即应用"为最终语义**：本文决策 1/2/10 及相关表述已按最终实现修订（WorkspaceTab 仅存 `activeFilter`、对话框 Apply 立即应用、Ctrl+R 二态）。修订后的描述即当前代码现状，以本文为准。

---

## 0. 评审基线（代码现状，2026-08-26 工作区）

- **Rust 侧已在途实现**（`src-tauri/src/postgres.rs` 未提交改动，+460 行）：`PostgresTableFilter`/`PostgresFilterCondition`/`PostgresSortClause` 结构体、`build_where_clause`/`build_order_by_clause`/`load_column_metadata`、`postgres_table_data` 已消费 `filter`/`order_by` 并以 `client.query()` 参数化执行、返回 `column_types`/`column_comments`、已带 `limit+1` 的 `truncated` 判定与 Rust 单测。**前端尚未接入**（`result-types.ts` 无 `TableFilterState`、adapter 未填 `providerType`、`browse()` 未携带 filter）。
- **前端 B17 基线**：`WorkspaceTab` 已含 `baseline/dirty/pendingInserts/pendingDeleteRows`（tool-postgres.tsx:115-126）；`browse(reference, offset)` 为 table tab 唯一查询路径（:593）；`onDatabaseKeyDown` 手工分发 + `typingInField` 焦点守卫（:962-966）；`tableOffset` 从 `result.pagination.offset` 推导（:272-273）；保存走 `saveTableChanges` 本地合并（:923-939）。
- **安全红线已锁定**（`b18-filter-security-constraints.md`）：参数化铁律、列白名单 + quote、类型名无前端入口 + 字符集守卫、`eq` 等 1 参数操作符 **value=None 必须报错**（禁止 `unwrap_or_default()` 静默空串）、offset/条件数/排序列数/value 长度边界、查询超时。本文全部遵守，不重复展开。

---

## 1. 过滤状态模型

### 决策 1（状态归属）：filter 状态放 `WorkspaceTab`，不建独立 context/store【r1 修订】

```ts
type WorkspaceTab = {
  // ...B17 既有字段
  activeFilter?: TableFilterState;    // 已应用、正在驱动当前查询
};
```

理由（最小改动、适配现有架构）：
1. **B17 已确立 tab 级状态模式**——`pendingInserts/pendingDeleteRows/dirty/baseline` 全在 `WorkspaceTab`，过滤是同一粒度的"浏览状态"，同层存放最自然，`patchTab` 直接可写，零新机制。
2. **过滤是 per-tab 的**，与 tab 生命周期绑定（关闭即丢），无跨 tab 共享需求。
3. **无第二个调用方**：当前只有 `tool-postgres.tsx` 消费过滤状态（query tab 明确不做，见 A-13）。独立 context/hook/store 违反 Master Plan 纪律"无调用方不建抽象"。
4. 过滤对话框的**打开/关闭是局部 UI 状态**（如 `filterDialog`），放 `ToolPostgres` 组件级 `useState` 即可，不进 `WorkspaceTab`（`WorkspaceTab` 只存数据，不存 UI 展示态）。
5. **r1：draft 字段（`tab.filter`）已删除**——对话框编辑态是对话框内部局部 useState，打开时从 `activeFilter` 水合（`initialFilter`），Apply/Cancel 即收敛，不落在 WorkspaceTab。单一真相源，无双状态漂移。

### 决策 2（立即应用）：对话框 Apply 直接写 activeFilter 并立即查询【r1 修订，原"draft 由 Ctrl+R 应用"作废】

- **对话框 Apply = 立即应用**：`applyFilter(next)` 写 `activeFilter = next` 并立即 `browse(offset=0, next)`（空条件等价清除，见 `isEmptyFilter`/A-12）。无 draft 中间态，无"保存草稿不应用"的出口。
- 裁定依据：规格 A-3（Apply → 结果与 SQL 语义一致、徽标更新）与 A-5（第 2 页 Apply → offset 归 0）均以 Apply 为查询触发点；原"draft 由 Ctrl+R 应用"流程与规格矛盾且 UI 不可达（评审 MAJOR-1）。
- **对话框 Cancel = 仅关闭**，不写任何状态（过滤态不因取消而变）。对话框打开时以 `activeFilter` 为初始值，编辑不落 tab。
- **Ctrl+R 语义见决策 10**（重放/刷新，不再承担"应用"职责）。
- **Filter by field value**：单条件立即生效（A-1/A-2），由纯函数 `buildFieldValueFilter(column, value)` 构造完整 `TableFilterState`（NULL 单元格 → `isNull`，非 NULL → `eq`，见安全红线），走同一 `applyFilter` 入口。

### 决策 3（与 B17 暂存编辑的关系）：应用过滤时若有 dirty，静默丢弃，不新增确认对话框

- 应用过滤 = 一次 `browse()` 重查。而 `browse()` **已有语义**：重查成功后清空 `pendingInserts/pendingDeleteRows` 并重置 `baseline`（tool-postgres.tsx:625-635）。**保持该语义不变**，即：应用过滤时，未保存的单元格编辑、暂存插入行、暂存删除行全部随重查丢弃。
- 这与**现有 Ctrl+R 刷新、Refresh 按钮、翻页**的行为完全一致（它们同样静默丢弃暂存），不是新引入的破坏性。不新增"过滤前 dirty 确认"对话框：一致性优先、最小改动优先。
- **记录为已知体验项**（与 R-B18-4 一致）：用户若在未保存编辑时应用过滤会丢编辑。若后续需提示，在 B20 统一对话框体系时评估，**B18 不做**。
- 清空过滤同理（Clear = 无过滤的 browse），语义一致。

---

## 2. 过滤与分页

### 决策 4（offset 重置）：应用/清除过滤一律 `browse(offset = 0)`

- 应用过滤、清除过滤、Filter by field value：全部调用 `browse(ref, 0, activeFilter)`（A-5）。
- 过滤态翻页：`browse(ref, tableOffset ± pageSize, activeFilter)`，**offset 以过滤后结果集为基准**（A-6），由 Rust `LIMIT/OFFSET` 天然保证。
- **单一查询路径约束**：`browse()` 是 table tab 的唯一查询函数，签名扩展为

```ts
browse(reference, offset = 0, filter?: TableFilterState)
```

  `tableOffset` 的推导逻辑（tool-postgres.tsx:272-273）不动。**禁止**在过滤后另开查询路径（如直接 invoke `postgres_table_data`），否则分页/刷新/快捷键三处会漂移。

### 决策 5（hasMore 语义）：保持 adapter 不变，`hasMore = truncated` 由 Rust `limit+1` 保证

- Rust 侧已实现：`LIMIT limit+1` 取 `limit+1` 行、`truncated = fetched.len() > limit`，且判定发生在 WHERE/ORDER BY 之后（postgres.rs:1063-1075 在途实现）。**前端 `adaptPostgresTableResult` 的 `hasMore: result.truncated` 无需改动**（postgresql-result-adapter.ts:67）。
- 前端**不要**自己计算 hasMore（如用 `rows.length === pageSize` 推断），统一信任 Rust `truncated`。

### 决策 6（IPC 契约，与 Rust camelCase 对齐）

`invoke("postgres_table_data", { request: { connectionId, schema, table, limit, offset, filter, orderBy } })`：

```ts
interface TableFilterState {
  logic: "AND" | "OR";
  conditions: FilterCondition[];        // 空数组 = 无过滤（A-12）
  orderBy: SortClause[];                // 空数组 = 默认 PK 排序
}
interface FilterCondition {
  column: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "isNull" | "isNotNull";
  value?: string | null;                // isNull/isNotNull 忽略
}
interface SortClause { column: string; direction: "asc" | "desc"; }
```

- 类型定义放 `result-types.ts`（共享契约层，与 `DatabaseResultColumn` 同层；规格 §10 已指定）。
- **value 语义遵守安全红线**：NULL 单元格的 Filter by field value 发 `{ operator: "isNull" }`，**禁止发 `eq + value: null`**；`eq/like/gt...` 的 value 必须是字符串（前端保证非 null，安全红线 §2.2）。
- `orderBy` 空数组时 Rust 自动追加 PK 兜底排序（`build_order_by_clause` 已实现），前端无需补。

---

## 3. 过滤与编辑会话共存

### 决策 7（过滤态下允许编辑）：不拦截，保存行为分两种情况

- **过滤只影响查询，不改变编辑能力**：`tableEditingEnabled` 判断（tool-postgres.tsx:301-305）不因 activeFilter 存在而变化；双击编辑、Set NULL、Insert/Delete 行、Ctrl+S 在过滤态下**全部照常可用**（A-11 基础）。
- 理由：B17 编辑以 PK 定位（`saveTableChanges` 内 UPDATE/DELETE 走 `keyValues`），与 WHERE 无关；过滤不改变 PK 语义（计划 §4.6）。

### 决策 8（保存后刷新当前过滤视图）：有 activeFilter 时保存后重查，无过滤时保持 B17 本地合并

- 现状 B17：`saveTableChanges` 成功后**本地合并 rows**（tool-postgres.tsx:923-939），不再查库。这在无过滤时正确（PK 回填、即时反馈，验收过）。
- 过滤态下若仍本地合并，**INSERT 行即使不匹配当前过滤条件也会出现在网格里**，违反计划 §4.4.6「INSERT 行保存后若落在过滤集外则不在网格显示」。
- **决策**：`saveTableChanges` 成功分支末尾判断——
  - `activeFilter` 存在 → 调用 `browse(ref, tableOffset, activeFilter)` 重查当前页（过滤视图，行自动落在过滤集内）；`browse` 内部会顺带清空 pendingInserts/pendingDeleteRows、重置 baseline/dirty（已有逻辑），保存后状态自然收敛。
  - `activeFilter` 不存在 → **保持 B17 本地合并路径完全不变**，零回归。
- 注意点：保存重查保持 `tableOffset` 不变（不跳页）；`saveTableChanges` 内已有的 `nextResult` 本地合并逻辑仅在无过滤分支使用，过滤分支走重查。可把"是否有 activeFilter"作为分支开关，避免改动 B17 主干。
- 不额外 toast 提示"该行不在过滤集内"（§4.4.6 明确不提示）。

---

## 4. 快捷键（Ctrl+R 语义）

### 决策 9（够用评估）：B18 沿用 `onDatabaseKeyDown` 手工分发，不建 B20 正式 scope 路由；补 `select` 到焦点守卫

- 现状：`onDatabaseKeyDown`（tool-postgres.tsx:962-1004）已覆盖 table tab Ctrl+R 分支（:996-1003，当前语义=刷新当前页）；已有 `typingInField` 守卫（:964-966，匹配 `input, textarea, [contenteditable='true']`）。
- **评估结论**：B18 只改 table tab 的 Ctrl+R 一个分支语义，在现有手工分发内扩展完全够用；B20 正式 scope 路由（Master Plan D2）落地时再迁移，B18 **不**预建路由层（无调用方不建抽象）。
- **必须补的守卫缺口**：现有守卫不含 `select`。过滤对话框（Radix Select 下拉）聚焦时按 Ctrl+R 会误触。改为 `input, textarea, select, [contenteditable='true']`。
- 对话框开启时（Dialog open 状态）Ctrl+R 不得触发网格行为——因焦点在对话框内（input/select）已被守卫拦下，无需额外 state 判断。

### 决策 10（Ctrl+R 二态语义，A-7）【r1 修订：原三态（apply/replay/refresh）简化为二态】

原三态中"有 draft → 应用"分支依赖决策 2 的 draft 机制，已随 r1 作废（draft 不可达，评审 MAJOR-1）。对话框 Apply 已立即应用，Ctrl+R 不再承担应用职责。在 `onDatabaseKeyDown` 现有 `event.key.toLowerCase() === "r"` 分支内按 table tab 扩展，判定逻辑抽为**单参数纯函数**：

```ts
resolveFilterShortcut(active?: TableFilterState):
  | { kind: "replay"; filter: TableFilterState }   // 有 activeFilter → 重放
  | { kind: "refresh" }                            // 皆无 → 刷新当前页
```

| 状态 | 行为 |
|---|---|
| 有 activeFilter | 重放：`browse(offset=0, activeFilter)` |
| 无 activeFilter | **保持现状**：`browse(offset=tableOffset, 无过滤)`（刷新当前页，兼容 B17） |

- query tab Ctrl+R 保持 `refreshNavigator()` 不变（R-B18-1）。
- 读操作：readOnly 连接下 Ctrl+R 应用过滤**可用**（过滤是读，A-9）。

### 决策 11（命令注册）：新增 4 条 DATA_GRID scope 命令，仅声明 enablement，不执行逻辑

`command-registry.ts` 增加（计划 §4.5）：`database.data.filterByFieldValue` / `database.data.customFilter` / `database.data.filterSort` / `database.data.clearFilter`。全部 `scopes: ["DATA_GRID"]`、`requiredCapabilities: []`（读操作不要求 `supportsResultEditing`，与 B17 的 addRecord 等区分）、`connectionStates: ["connected"]`。沿用架构纪律"Command Resolver 不执行命令"——这些命令仅用于右键菜单 enablement 判定，实际 handler 在 tool-postgres.tsx 内联。

---

## 5. 序列化 / 持久化

### 决策 12（本批不持久化过滤）：规格无要求，最小改动优先，B20 后评估

- `batch-18-browse-plan.md` 全篇过滤无持久化 AC（布局持久化 C-8 是 Slice C 的事，key 体系 `nexterm.gridLayout.*` 不覆盖过滤）。过滤 tab 关闭即丢弃，重开表不恢复。
- **B18 不做** localStorage 序列化、不建过滤快照恢复机制。会话恢复需求在 B20 快捷键 scope 体系 + 会话恢复批次统一评估（届时若有，可复用 Slice C 已建的持久化 key 模式）。
- 唯一隐含要求：tab 关闭/切换不触发过滤状态特殊清理（自然随 tab 丢弃，符合 B17「切换不确认」决策）。

---

## 6. 过设计检查（可裁剪项评审）

### 结论：Slice A 13 条 AC 无必须裁剪项，但明确 4 条"不做"以控范围

| 项 | 决策 |
|---|---|
| 过滤器嵌套分组（(A AND B) OR C） | **不做**（计划 §7.6），单一 AND/OR 层级，Rust 单层 join |
| 过滤条件命名书签 / 保存为方案 | **不做**（计划 §7.7） |
| ILIKE / REGEX / BETWEEN 等扩展运算符 | **不做**（计划 §7.8），运算符集锁死 9 个 |
| query tab 过滤入口 | **不做**（D-B18-1 / A-13），右键菜单与徽标仅在 `tab.type === "table"` 渲染 |

### 对 fe-dev 的"不建抽象"清单（防止过度设计）

1. **不建独立 context/hook/store**：过滤状态全在 `WorkspaceTab`（决策 1）。
2. **对话框单组件复用**：Custom Filter 与 Filter & Sort **共用同一个对话框组件**，以 prop 控制是否显示排序区（计划 §4.3 已指定共用）；不建两个对话框组件。
3. **不建 SQL 构造层**：前端只传结构化 `TableFilterState`，绝不拼 SQL 文本（D-B18-2）；SQL 构造全在 Rust `build_where_clause`。
4. **filter 逻辑只建纯函数**：为满足单测（测试矩阵"filter reducer"），抽 `resolveFilterShortcut`/`isEmptyFilter`/`buildFieldValueFilter` 纯函数模块（table-filter.ts，r1 后即现状），但**不引入状态管理库、不建 reducer dispatch 框架**、不建 draft 状态。
5. **adapter 最小扩展**：`PostgresTableRuntimeResult` 增加 `columnTypes`/`columnComments` 并行数组、`DatabaseResultColumn` 填 `providerType` + 新增 `providerComment?`（D-B18-3），不重构 `columns` 结构。

---

## 7. 前端改动文件清单（对照计划 §10，fe-dev 落地顺序）【r1 后为已落地现状】

| 文件 | 改动 | 说明 |
|---|---|---|
| `result-types.ts` | 新增 `TableFilterState/FilterCondition/SortClause`；`DatabaseResultColumn.providerType` 落地 + `providerComment?` | 契约层先行 |
| `postgresql-result-adapter.ts` | `PostgresTableRuntimeResult` 加 `columnTypes`/`columnComments`；`adaptPostgresTableResult` 填充 providerType/providerComment | 并行数组按序 zip |
| `tool-postgres.tsx` | `WorkspaceTab` 加 `activeFilter`（r1：仅此一个过滤字段）；`browse` 加 filter 参数；Ctrl+R 二态；`saveTableChanges` 过滤分支重查；右键菜单 3 入口 + 过滤徽标 + Clear；`onDatabaseKeyDown` 守卫补 `select` | 主改动 |
| `database-result-pane.tsx` | 列头 th 右键挂载点（Filter & Sort）| 仅加挂载点，列布局留给 Slice C |
| 新组件 `filter-sort-dialog` | 共用对话框（条件区 + 可选排序区），Apply 立即应用 | 只建一个 |
| `table-filter.ts` | 纯函数：`resolveFilterShortcut(active?)`（二态）/ `isEmptyFilter` / `buildFieldValueFilter` | r1 后现状 |
| `command-registry.ts` | 4 条 DATA_GRID 命令 | 仅声明 |
| `i18n.ts` | 过滤键 | — |

> 协作提示：Rust 侧 `postgres.rs` 在途实现中有一处与安全红线冲突——`build_where_clause` 对 1 参数操作符仍 `unwrap_or_default()` 静默空串（security 文档 §2.2 已指出）。fe-dev 需按安全红线修复（`value: None → Err`）。本文不覆盖该点，以安全文档为准。

---

## 8. 关键决策速览（fe-dev 必读）【r1 修订后】

1. **状态在 WorkspaceTab**：仅 `activeFilter`（applied），不建 context/store、无 draft 字段；对话框 Apply **立即应用**（写 activeFilter + browse(offset=0) 重查），dirty 暂存静默丢弃（与刷新一致，不加确认框）。
2. **browse 单一路径**：`browse(reference, offset, filter?)` 为唯一查询入口；应用/清除过滤 offset=0，翻页带 activeFilter；hasMore 信任 Rust truncated。
3. **过滤态可编辑**：保存时若有 activeFilter → 重查当前 offset 过滤视图（满足 §4.4.6），无过滤 → B17 本地合并零回归。
4. **Ctrl+R 二态**（`resolveFilterShortcut(active?)`：有 active → replay / 皆无 → refresh）在现有 `onDatabaseKeyDown` 扩展，不建 B20 路由；焦点守卫补 `select`。
5. **不持久化过滤**，B20 后评估；对话框单组件复用；前端不拼 SQL、不建抽象。
