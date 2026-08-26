# B18「数据浏览增强」需求规格（Navicat Parity Batch 18）

> 状态：IMPLEMENTED（Slice A/B/C 核心实现完成，单元/集成测试绿；原生 E2E 与视觉门禁待跑）
> 作者：pm（许清楚）｜2026-08-26
> 实现：cto（齐活林）｜2026-08-26
> 依据：`navicat-parity-master-plan.md` §6 B18 定义 + §7.4；`navicat-premium-interactions.md` IN-12/13/16/17；`navicat-premium-context-menus.md`；`navicat-premium-shortcuts.md`；现状代码 `database-result-pane.tsx` / `tool-postgres.tsx` / `postgresql-result-adapter.ts` / `result-types.ts` / `command-registry.ts`

## 0. 证据规则（Fact / UNVERIFIED / NexTerm 决策）

| 标记 | 含义 |
|---|---|
| **[Fact]** | Navicat 17 Windows 手册（M17）直接证据，标注页码 |
| **[UNVERIFIED]** | 现有官方资料无法建立该精确行为，禁止声称 parity，须在授权 17.3 Enterprise 运行捕获后方可对齐 |
| **[NexTerm]** | 产品决策：NexTerm 自定义行为，不声称 Navicat parity |

**B18 范围（Master Plan §6，DoD）**：数据浏览 —— Filter & Sort（字段值/自定义）、Find/下一个、列冻结/宽度/最佳适配、行高、Show Field Type/Comment，布局持久化。

---

## 1. 范围与目标

### 1.1 目标
把数据网格从「只读渲染 + 双击编辑 + 分页」推进到「可浏览的数据集」：过滤、查找、列布局三大能力，全部以原生 E2E 验收，与 Navicat 操作习惯对齐。

### 1.2 范围界定（三个关键决策）
- **D-B18-1 [NexTerm]**：过滤/排序**仅作用于 table tab（表/视图浏览），且为服务端 SQL 过滤**（WHERE/ORDER BY 注入分页查询）；query tab 的结果网格不做过滤（排除项 §7.1）。
- **D-B18-2 [NexTerm]**：过滤条件以**结构化数据**（`{column, operator, value}[]` + logic）传入 Rust 侧，Rust 构造**参数化 SQL**（沿用 `postgres_table_update` :858 的 escaping 模式）；前端一律不拼接 SQL 文本。值参数绑定为 text，由 PG 端类型转换。
- **D-B18-3 [NexTerm]**：Show Field Type / Show Comment 需要**后端扩展列元数据**（当前 adapter 明确不提供类型信息，见 `postgresql-result-adapter.ts:25` "no type metadata"）。新增 `columnTypes[]` / `columnComments[]` 并行数组，**不破坏**现有 `columns: string[]` 结构。

### 1.3 不变量
- 不破坏终端快捷键/IME；B18 不改全局快捷键架构，仅在现有 `onDatabaseKeyDown`（tool-postgres.tsx:946）内扩展 table tab 语义，并**新增 `event.target` 焦点守卫**（见风险 R-B18-2）。
- B17 编辑闭环（增删改保存/回滚/脏确认）不回归；过滤态下编辑保存沿用 B17 行为（§4.4.6）。
- 只读连接：过滤/查找/列布局均为读操作，必须可用。

---

## 2. 现状基线（代码锚点，勿重复实现）

| 现状 | 位置 |
|---|---|
| 网格只读渲染 + 双击编辑 + 分页（Prev/Next） | `database-result-pane.tsx:94-284` |
| 单元格右键挂载点 `renderContextMenu`（已含 Copy/Set NULL/Delete 等） | `database-result-pane.tsx:167-178, 238-248`；tool-postgres.tsx:1305 |
| **列头（th）无右键挂载点**；**行头（# 列）无右键挂载点** | 需新增 |
| 表浏览 `browse(reference, offset)` 调 `postgres_table_data`（limit/offset，无 where/orderBy） | tool-postgres.tsx:593-633 |
| `Ctrl+R`：table tab = 刷新当前页（`browse`），query tab = `refreshNavigator` | tool-postgres.tsx:976-983 |
| `Ctrl+S` 保存、`Ctrl+N` 新查询、`Ctrl+Enter` 执行、Insert 增行 | tool-postgres.tsx:946-984 |
| WorkspaceTab 已有 `baseline/pendingInserts/pendingDeleteRows/dirty`（B17） | tool-postgres.tsx:115-126 |
| 列定义 `DatabaseResultColumn {key,label,ordinal,semanticType,providerType?}`；`providerType` 字段存在但 adapter 未填 | `result-types.ts:16-23`；adapter 恒 `semanticType:"unknown"` |
| 命令注册已有 `DATA_GRID` scope + `database.result.*` / `database.data.*` 命令 | `command-registry.ts:17-42, 189-265` |
| 表数据结果 adapter `adaptPostgresTableResult`（pagination.hasMore = truncated） | `postgresql-result-adapter.ts:52-79` |

---

## 3. User Visible Slice 划分

| Slice | 用户可见能力 | 依赖 | 预估交付形态 |
|---|---|---|---|
| **Slice A 过滤** | Filter by field value / Custom Filter / Filter & Sort 对话框、Ctrl+R 应用、过滤状态指示 + 清除、排序 | 需 Rust 扩展 `postgres_table_data`（filter/orderBy/列元数据）；列头+行头右键基础设施；Ctrl+R 语义变更 | 独立可发布 |
| **Slice B 查找** | Ctrl+F 查找栏、F3/Enter 下一个、匹配高亮、无匹配提示、Escape 关闭 | 低；与 Slice A 共享焦点守卫；翻页时清空 | 独立可发布，可与 A 并行 |
| **Slice C 列布局** | 列冻结/取消、拖拽改宽、双击最佳适配、Set Column Width、Set Row Height、Show Field Type/Comment、布局持久化 | 依赖 Slice A 建立的列头/行头右键挂载点；Show Type/Comment 依赖 Rust 列元数据 | 独立可发布 |

**建议开发顺序**：A → C（复用列头右键基建）→ B；但三者验收与发布相互独立，任一先行不影响其余。

---

## 4. Slice A：过滤（Filter）

### 4.1 用户故事
> 作为开发，我要像 Navicat 一样按字段值一键过滤、用 Custom Filter / Filter & Sort 组合条件，Ctrl+R 应用到网格，并随时看清/清除当前过滤，从而在海量数据中快速定位行。**[Fact]** 三个过滤入口 + Ctrl+R 应用均为 Navicat 行为（M17 p.98, p.380）。

### 4.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 单元格右键 → **Filter by field value** | 以当前字段 + 当前单元格值立即构造单条件并应用（`col = 值`；值 NULL 时 `col IS NULL`）；替换现有过滤（单条件覆盖） | [Fact] M17 p.98；NULL→IS NULL 为 [NexTerm] |
| 单元格/网格右键 → **Custom Filter** | 打开自定义过滤对话框（多条件构建） | [Fact] M17 p.98 入口存在；对话框内部 UI 为 [NexTerm]（见 §4.3） |
| 列头右键 → **Filter & Sort** | 打开过滤+排序对话框（条件 + ORDER BY 多列） | [Fact] M17 p.98 入口存在；内部 UI 为 [NexTerm] |
| **Ctrl+R**（table tab 聚焦，`DATA_GRID`） | 应用当前过滤条件（draft→active 并重新查询 offset=0）；无 draft 有 active 时重放 active；二者皆无时保持现状（刷新当前页） | [Fact] Ctrl+R 应用过滤/排序（M17 p.380） |
| 过滤状态指示 | table tab 工具栏显示过滤徽标（条件数），含「清除过滤」入口；清除后全量重查 offset=0 | [NexTerm]（Navicat 指示 UI 无证据） |

### 4.3 过滤条件模型与对话框规格

```ts
type FilterOperator =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "like"            // SQL LIKE，值中 % _ 由用户书写，原样绑定
  | "isNull" | "isNotNull";
interface FilterCondition {
  column: string;              // 列 key
  operator: FilterOperator;
  value?: string | null;       // isNull/isNotNull 忽略
}
interface SortClause { column: string; direction: "asc" | "desc"; }
interface TableFilterState {
  logic: "AND" | "OR";                       // 条件间逻辑
  conditions: FilterCondition[];
  orderBy: SortClause[];
}
```

对话框（Custom Filter 与 Filter & Sort 共用，Filter & Sort 额外含排序区）：
- 条件行列表：列选择（下拉，列 label）｜ 运算符（下拉）｜ 值输入（文本；isNull/isNotNull 时禁用值输入）。
- 「+ 添加条件」；每行可删除。
- 逻辑切换：AND / OR（作用于全部条件，不承诺嵌套分组）**[NexTerm]**。
- 排序区（仅 Filter & Sort）：多行「列 + 方向(ASC/DESC)」。
- 按钮：**Apply**（提交 draft → active，重新查询）、Cancel（丢弃草稿）、Clear（清空条件）。

> 运算符集合（eq/neq/gt/gte/lt/lte/like/isNull/isNotNull）为 **[NexTerm]** 决策：Navicat Custom Filter 对话框内具体运算符集 [UNVERIFIED]，不承诺 parity；保留扩展位。

### 4.4 Acceptance Criteria

| # | 验收项 | 验证方式 |
|---|---|---|
| A-1 | 右键单元格（非 NULL）→ Filter by field value → 网格以 `col = <值>` 重查，**offset 归 0**，行数 = 匹配数，过滤徽标显示 1 条件 | 原生 E2E |
| A-2 | 右键 NULL 单元格 → Filter by field value → 结果满足 `col IS NULL` | 原生 E2E |
| A-3 | Custom Filter：2 条件 AND（eq + like），Apply → 结果与预期 SQL 语义一致；徽标更新 | 原生 E2E |
| A-4 | Filter & Sort：设置条件 + ORDER BY col ASC → 结果有序；多列排序生效 | 原生 E2E |
| A-5 | 在第 2 页（offset=100）上应用新过滤 → 结果从 **offset 0** 开始（过滤×分页边界） | 原生 E2E |
| A-6 | 过滤态下点 Next → offset 在**过滤后结果集**上继续（LIMIT/OFFSET 带 WHERE 正确） | 原生 E2E |
| A-7 | Ctrl+R：有 draft 未应用 → 应用；无 draft 有 active → 重放；皆无 → 刷新当前页（兼容现状） | 原生 E2E + 单测 |
| A-8 | 清除过滤 → 全量重查 offset=0，徽标消失 | 原生 E2E |
| A-9 | readOnly 连接：过滤全部入口可用（读操作不拦截） | 原生 E2E |
| A-10 | 注入防护：值 `x' OR '1'='1`、列名非法、运算符非法 → 均按字面值/白名单处理，无注入、无 panic | 原生 E2E + Rust 单测 |
| A-11 | 过滤态下 B17 编辑保存不回归（改值→Apply→数据库生效；插入行保存后不在过滤集时按 §4.4.6 处理） | 原生 E2E |
| A-12 | 空条件（0 条件）Apply / Clear → 等价清除过滤 | 单测 |
| A-13 | query tab 结果网格**不出现**任何过滤入口（范围界定 D-B18-1） | 单测 + 视觉门禁 |

### 4.5 依赖分析
- **Rust**：`postgres_table_data` request 增加可选 `filter?: {logic, conditions:[{column,operator,value?}]}`、`orderBy?: [{column,direction}]`；WHERE/ORDER BY 白名单 + 参数化；`truncated`（limit+1）判定在 WHERE/ORDER BY 之后保持正确。
- **前端状态**：`WorkspaceTab` 增加 `filter?: TableFilterState`（draft）与 `activeFilter?: TableFilterState`（已应用）。`browse()` 签名扩展携带 filter/orderBy。
- **右键基建**：列头 th 挂 ContextMenu（Filter & Sort 等），单元格右键新增 Filter by field value / Custom Filter 项。
- **命令注册**：新增 `database.data.filterByFieldValue`、`database.data.customFilter`、`database.data.filterSort`、`database.data.clearFilter`（`DATA_GRID` scope，读操作不要求 `supportsResultEditing`）。
- **i18n**：新增过滤相关键。

### 4.6 边界与交互
- **过滤×分页 offset**：应用/清除过滤一律重置 offset=0（A-5）；过滤态翻页的 offset 以过滤集为基准（A-6）。`tableOffset` 计算与 `browse` 保持单一路径。
- **过滤×编辑（B17）**：过滤只影响**查询**，不改变 UPDATE/DELETE 的 PK 定位语义；INSERT 行保存后若落在过滤集外则不在网格显示（可清除过滤查看），不做额外提示。
- **过滤×无 PK 表**：WHERE 不需 PK，过滤可用；排序+offset 分页对无唯一键表的漂移属既有风险（R-B18-5），B18 以 PK 兜底排序缓解。
- **视图浏览**：过滤同样适用（同为 SQL 层）；验证以表为主。
- **仅单表场景**：过滤不跨 JOIN（B18 不涉及 query builder 结果）。

---

## 5. Slice B：查找（Find）

### 5.1 用户故事
> 作为开发，我要 Ctrl+F 在当前网格中查找文本，F3 跳到下一个匹配并高亮，快速确认数据是否存在于当前浏览结果中。**[Fact]** Ctrl+F 查找 / F3 下一个（M17 p.380）。

### 5.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| **Ctrl+F**（table tab，焦点不在 input/textarea/CodeMirror） | 打开 Find 栏（网格顶部或底部浮条） | [Fact] M17 p.380；Find 栏 UI 布局 [NexTerm] |
| Find 栏输入 | 实时匹配当前页单元格，匹配单元格高亮，显示「N 处匹配 / 当前第 k 处」 | [NexTerm]（Navicat 计数 UI 无证据） |
| **Enter / F3** | 跳到下一个匹配（循环，自动滚动到可见） | [Fact] F3 下一个（M17 p.380） |
| **Escape** | 关闭 Find 栏，清除高亮 | [NexTerm] |
| 关闭按钮 | 同 Escape | [NexTerm] |

### 5.3 Acceptance Criteria

| # | 验收项 | 验证方式 |
|---|---|---|
| B-1 | Ctrl+F 打开 Find 栏；输入文本 → 匹配单元格高亮 + 计数显示 | 原生 E2E |
| B-2 | F3 / Enter 依次跳转匹配，循环回绕；焦点单元格滚动至可见 | 原生 E2E |
| B-3 | 无匹配 → 提示「无匹配」，不崩溃 | 原生 E2E |
| B-4 | Escape 关闭并清除全部高亮 | 原生 E2E |
| B-5 | 翻页 / 重新查询（过滤或刷新）→ Find 状态清除 | 原生 E2E |
| B-6 | NULL 单元格不参与文本匹配；匹配基于单元格**原始值**（大小写不敏感 contains）**[NexTerm]** | 单测 |
| B-7 | 编辑 input 聚焦时 Ctrl+F / F3 **不接管**（浏览器默认行为保留） | 原生 E2E |
| B-8 | query tab 结果网格：Ctrl+F 保持现状（不打开网格 Find 栏；B20 scope 体系后统一） | 单测 |

### 5.4 依赖与边界
- 依赖：网格匹配渲染（高亮 class）、滚动定位（`scrollIntoView`）、焦点守卫（与 Slice A 共享）。
- 匹配范围仅**当前已加载页**（分页网格）；**跨页 Find [UNVERIFIED]**，不做、不声称（§7.2）。
- **Shift+F3（上一个）[UNVERIFIED]**：无证据，B18 不承诺；Find 栏可提供「上一个」按钮作为 [NexTerm] 便捷项（可选）。
- **Ctrl+G（Go to Row）[UNVERIFIED]**：UI 细节无证据且涉及跨页服务端跳转，**排除**（§7.3）。

---

## 6. Slice C：列布局

### 6.1 用户故事
> 作为开发，我要冻结关键列、拖宽列、双击最佳适配、精确设宽、调行高，并显示字段类型/注释，让网格适配我的数据与习惯，且布局在重开表后保持。**[Fact]** 列冻结/宽度/行高/类型/注释菜单（M17 p.101-102）；拖拽改宽/双击最佳适配（IN-12，M17 交互矩阵）。

### 6.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 列头右键 → **Freeze Column** | 冻结该列及其左侧全部列；横向滚动时冻结区固定 | [Fact] M17 p.101；冻结范围为 [NexTerm]（「冻结所选列及左侧」推断） |
| 列头右键 → **Unfreeze All Columns** | 解除全部冻结 | [Fact] M17 p.101 |
| 列头右键 → **Set Column Width** | 对话框输入精确像素宽，应用到该列 | [Fact] M17 p.101 |
| 列头拖拽右边框 | 拖动改列宽（px，带最小宽下限） | [Fact] IN-12 拖 border 改宽（M17 交互矩阵） |
| 列头右边界**双击** | 最佳适配：按内容 + 表头宽度计算并应用 | [Fact] IN-12 双击 border（M17 交互矩阵）；计算方式 [NexTerm]（canvas measureText，font 12px） |
| 行头（# 列）右键 → **Set Row Height** | 对话框输入像素行高，应用到全部数据行 | [Fact] M17 p.101；作用范围为 [NexTerm] |
| 列头右键 → **Show Field Type** | 列头第二行小字显示列类型（providerType） | [Fact] M17 p.102；数据源见 D-B18-3 |
| 列头右键 → **Show Comment** | 列头第二行小字显示列注释（comment，无注释不显示） | [Fact] M17 p.102；数据源见 D-B18-3 |
| 布局持久化 | 冻结数/列宽/行高/Type/Comment 开关按表持久化，重开表恢复 | [NexTerm]（Master Plan B18 DoD「布局持久化」） |

### 6.3 布局状态模型

```ts
interface GridLayoutState {
  frozenCount: number;
  widths: Record<string, number>;   // columnKey -> px
  rowHeight: number;                // px
  showFieldType: boolean;
  showComment: boolean;
}
```

持久化 key **[NexTerm]**：`nexterm.gridLayout.${providerId}.${connectionId}.${schema}.${table}`（localStorage）。读取时机：table tab 打开时；写入时机：任一布局变更时。翻页/过滤/刷新不重置布局。

### 6.4 Acceptance Criteria

| # | 验收项 | 验证方式 |
|---|---|---|
| C-1 | 列头右键出现 Freeze Column / Unfreeze All Columns / Set Column Width / Show Field Type / Show Comment | 原生 E2E |
| C-2 | Freeze 列 → 横向滚动冻结区保持；Unfreeze All → 恢复 | 原生 E2E |
| C-3 | 拖拽列头右边框 → 列宽变化；双击右边界 → 最佳适配（宽列变窄、窄列变宽） | 原生 E2E |
| C-4 | Set Column Width 输入 200 → 该列 200px | 原生 E2E |
| C-5 | 行头右键 Set Row Height 输入 36 → 全部数据行高 36px | 原生 E2E |
| C-6 | Show Field Type 开 → 列头显示类型（如 `int4`/`text`）；关 → 隐藏 | 原生 E2E |
| C-7 | Show Comment 开 → 有注释列显示注释文本；无注释列不显示 | 原生 E2E |
| C-8 | 布局持久化：设置宽度/冻结/行高/开关 → 关闭 tab 重开 → 全部恢复 | 原生 E2E |
| C-9 | 布局变更不触发重新查询（无额外 IPC）；分页/过滤下布局稳定 | 原生 E2E + 单测 |
| C-10 | query tab 结果网格：列头右键菜单**不包含** Freeze/Width/Type/Comment（范围界定 D-B18-1 派生） | 单测 |
| C-11 | 列头右键包含 **Filter & Sort**（Slice A 入口，共享挂载点） | 原生 E2E |

### 6.5 依赖分析
- 依赖 Slice A 的列头/行头右键基建与 Rust 列元数据扩展（columnTypes/columnComments）。
- 渲染：冻结用 sticky 定位（th/td `position:sticky; left`），列宽用 `<colgroup>`/style width，行高用 tr style height。
- adapter：`DatabaseResultColumn.providerType` 开始由 Rust 填充（D-B18-3）。
- 命令注册：`database.layout.freezeColumn` / `unfreezeAllColumns` / `setColumnWidth` / `bestFitColumn` / `setRowHeight` / `toggleFieldType` / `toggleComment`（`DATA_GRID` scope）。

---

## 7. 排除项（明确不做）

| # | 排除项 | 原因 / 去向 |
|---|---|---|
| 7.1 | **query tab 结果网格过滤/排序** | D-B18-1 范围界定；query result 无分页模型，Navicat 语义含 re-execute 歧义；需求价值低于 table tab。留后续评估 |
| 7.2 | **跨页 Find、Shift+F3 上一个** | 跨页 Find 涉及服务端分页扫描 [UNVERIFIED]；Shift+F3 无手册证据 |
| 7.3 | **Ctrl+G Go to Row** | 对话框 UI [UNVERIFIED] + 跨页 offset 跳转，留 B20 快捷键 scope 批次或其后续 |
| 7.4 | **列头拖拽重排（Reorder）** | 7.4 操作习惯含重排，但 B18 DoD 未列；拖拽 DnD 视觉/放置/滚动成本高；留后续批次（标注 [NexTerm] 决策，非 UNVERIFIED 阻塞） |
| 7.5 | **冻结分隔线拖拽调整冻结数量** | [UNVERIFIED] 交互细节，仅做菜单式 Freeze/Unfreeze |
| 7.6 | **过滤器嵌套分组（(A AND B) OR C）** | 对话框无嵌套分组，条件间单一 AND/OR |
| 7.7 | **过滤条件保存为命名书签** | Navicat 无确认证据；不做 |
| 7.8 | **ILIKE / REGEX 运算符** | 运算符集 [NexTerm] 保守取 LIKE；无 Navicat 证据不扩 |
| 7.9 | **列布局作用于 query tab / 跨 provider 通用化** | B18 仅 PG table tab；SQLite/MySQL 实验性不扩 |
| 7.10 | **快捷键 scope 路由体系落地** | B20 专属；B18 仅做 table tab 语义 + 焦点守卫，不建通用路由 |

---

## 8. 操作习惯对齐表（证据来源 M17 页码）

| 操作 | Navicat 行为 | 证据 | NexTerm B18 落地 | 状态 |
|---|---|---|---|---|
| Filter by field value | 单元格右键，按当前字段值建过滤 | M17 p.98 / context-menus.md | Slice A A-1/A-2 | 对齐 |
| Custom Filter | 网格右键打开自定义过滤 | M17 p.98 | Slice A A-3 | 对齐（入口），内部 UI [NexTerm] |
| Filter & Sort | 字段右键打开过滤+排序 | M17 p.98 | Slice A A-4 | 对齐（入口），内部 UI [NexTerm] |
| Apply Filter & Sort | Ctrl+R | M17 p.380 / shortcuts.md | Slice A A-7 | 对齐（table tab scope） |
| Find / next | Ctrl+F / F3 | M17 p.380 / shortcuts.md | Slice B B-1/B-2 | 对齐 |
| Go to Row | Ctrl+G | M17 p.380 | 排除 §7.3 | 后置 |
| Column header drag/border/best-fit | 拖头重排/拖边改宽/双击边适配 | M17 交互矩阵 IN-12 | Slice C C-3（改宽+适配）；重排排除 §7.4 | 部分对齐 |
| Freeze Column / Unfreeze All | 列头右键 | M17 p.101 | Slice C C-1/C-2 | 对齐 |
| Set Column Width | 列头右键精确宽度 | M17 p.101 | Slice C C-4 | 对齐 |
| Set Row Height | 行头右键 | M17 p.101 | Slice C C-5 | 对齐 |
| Show Field Type / Show Comment | 列头右键 | M17 p.102 | Slice C C-6/C-7 | 对齐（需后端列元数据） |

---

## 9. SQL 安全设计（Rust 侧）

- **列名白名单**：`filter.conditions[].column` 与 `orderBy[].column` 必须存在于该表实际列集合；引用转义遵循现有 `quoteQualifiedPostgresName` 模式，禁止直接拼接。
- **值参数化**：所有条件值走 `$n` 参数绑定（复用 `postgres.rs` 现有绑定模式）；值作为 text 绑定，由 PG 端向列类型转换（无法转换时报错并回滚，不影响连接）。
- **运算符白名单**：仅接受 §4.3 枚举；`isNull/isNotNull` 不绑定值、生成 `col IS NULL` / `col IS NOT NULL`；`like` 值原样绑定。
- **direction 白名单**：仅 `asc`/`desc`。
- **ORDER BY 兜底**：存在 PK 时自动追加 `PK asc` 作为稳定排序尾（缓解无唯一排序键的分页漂移）**[NexTerm]**。
- **SQL 形态**：
  ```
  SELECT ... FROM schema."table"
    [WHERE (cond AND/OR cond ...)]        -- 参数化
    [ORDER BY col asc|desc, (PK asc)]
    LIMIT $limit+1 OFFSET $offset          -- truncated=hasMore 判定保持
  ```
- 单元测试必须覆盖：合法/非法列名、全部运算符、注入字符串值、limit+1 判定在过滤集上正确。

---

## 10. 改动文件清单（预估）

| 层 | 文件 | 改动 |
|---|---|---|
| Rust | `src-tauri/src/postgres.rs` | `postgres_table_data` request 扩展 filter/orderBy/columnTypes/columnComments；WHERE/ORDER BY 构造 + 白名单 + 参数化；列类型/注释批量查询（单条 catalog 查询，避免逐列 N+1） |
| Rust | `src-tauri/src/commands.rs` + `lib.rs` | 命令签名更新（如结构变化） |
| 前端 | `result-types.ts` | `DatabaseResultColumn.providerType` 落地；新增 `providerComment?: string`；新增 `GridLayoutState` / `TableFilterState` / `FilterCondition` / `SortClause` 类型 |
| 前端 | `postgresql-result-adapter.ts` | 填充 providerType/providerComment；`PostgresTableRuntimeResult` 增加 parallel 数组 |
| 前端 | `database-result-pane.tsx` | 列宽/冻结/行高渲染；列头+行头右键挂载；Find 栏与高亮；编辑焦点守卫；匹配滚动 |
| 前端 | `tool-postgres.tsx` | `browse()` 携带 filter/orderBy；`WorkspaceTab.filter/activeFilter`；Ctrl+F/R/F3 语义；过滤徽标 + 清除；布局读写与持久化；单元格右键新增过滤项 |
| 前端 | `command-registry.ts` | 新增 `database.data.filterByFieldValue` / `customFilter` / `filterSort` / `clearFilter`、`database.layout.*` 命令 |
| 前端 | 新组件（`components/toolbox/`） | `filter-sort-dialog`、`find-bar`、`column-header-menu`、`row-header-menu` |
| 前端 | `src/lib/i18n.ts` | 新增过滤/查找/布局键 |
| 测试 | `src-tauri` 单测 | where/orderBy 构造、白名单、注入护栏、列元数据 |
| 测试 | vitest | filter reducer、layout reducer、find 逻辑、命令 enablement、焦点守卫 |
| 测试 | 原生 WDIO PG E2E | §4.4/§5.3/§6.4 场景 |

---

## 11. 测试矩阵（对 Master Plan §8.1）

| 类别 | B18 必交证据 |
|---|---|
| Unit | filter reducer、SQL 构造（参数化/白名单/运算符全量）、layout reducer、find 匹配（大小写/NULL/回绕）、命令 scope/enablement（含读操作不要求 editing capability）、焦点守卫 |
| Integration | Tauri IPC × PG fixture：过滤/排序/列元数据返回；非法输入拒绝；错误回滚 |
| Browser 组件 | 网格渲染（冻结 sticky、列宽、行高、Find 高亮、徽标）仅渲染回归 |
| 原生 GUI E2E | §4.4 A-1…A-13、§5.3 B-1…B-8、§6.4 C-1…C-11（真实 PG Docker fixture，含 150 行表 + 注释列） |
| Safety | 只读连接过滤可用、注入拒绝无副作用、过滤态编辑保存不回归、无 PK 表过滤可用 |
| 视觉门禁 | dark/light/960×700：过滤徽标、Find 栏、列头第二行 Type/Comment、冻结分隔线 |
| 全量回归 | `pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check`；受影响批（B17 编辑）回归 |

**E2E fixture 建议**：
```sql
CREATE TABLE browse_fixture (
  id serial PRIMARY KEY,
  name text,
  category text,
  score numeric,
  note text
);
COMMENT ON COLUMN browse_fixture.name IS 'display name';
COMMENT ON COLUMN browse_fixture.category IS 'product category';
-- 插入 150 行（category 至少 3 个取值，若干 NULL note）
```

---

## 12. 风险与开放问题

| # | 风险/问题 | 等级 | 缓解 / 决策 |
|---|---|---|---|
| R-B18-1 | `Ctrl+R` 在 table tab 原语义为刷新（tool-postgres.tsx:976），改为「应用过滤」后刷新入口依赖 Refresh 按钮；回归风险 | 中 | 无过滤时 Ctrl+R 保持刷新兼容（A-7）；E2E 覆盖；B20 scope 体系统一后再收敛 |
| R-B18-2 | `onDatabaseKeyDown` 无 `event.target` 检查，编辑 input 聚焦时 Ctrl+F/R 可能误接管 | 高 | **B18 前置**：新增焦点守卫（input/textarea/select/CodeMirror 容器聚焦时不处理）；E2E B-7/A-7 覆盖 |
| R-B18-3 | Show Comment 需后端 catalog 查询，大表/无权限可能慢或失败 | 中 | 单条批量查询（pg_catalog.col_description 按列数组一次取）；失败降级为不显示注释，不影响网格 |
| R-B18-4 | 过滤态下编辑保存（B17 交互）语义未定 | 中 | 保持 B17 行为（§4.4.6）；不额外提示；记录为已知体验项 |
| R-B18-5 | 排序 + offset 分页对无唯一键表跨页漂移（既有） | 中 | PK 兜底排序缓解（§9）；不引入新问题 |
| R-B18-6 | Filter & Sort / Custom Filter 对话框内部 UI 无 Navicat 证据 | 中 | 以 [NexTerm] 规格定义（§4.3），标注不承诺 parity；M17 17.3 运行捕获后修订 |
| R-B18-7 | 列布局持久化作用域（仅 PG table tab）后续扩 provider 需 key 含 providerId | 低 | key 已含 providerId（§6.3），预留 |
| O-1 | 列重排（Reorder）是否纳入 B18 之后的短期批次 | 开放 | 需 architect 评估 DnD 成本；默认后置 |
| O-2 | Find 匹配是否计入隐藏行/过滤后行号语义 | 开放 | 默认基于当前渲染行；如 Filter 后 Find 与行号错位，E2E 明确（当前页文本匹配不依赖行号） |

---

## 附：完成定义（DoD 摘要）

1. Slice A/B/C 全部 AC（A-1…A-13, B-1…B-8, C-1…C-11）原生 E2E 通过。
2. 过滤/排序为参数化 SQL，注入护栏单测覆盖。
3. 布局持久化（C-8）通过。
4. B17 编辑闭环回归无退化；终端快捷键回归。
5. 视觉门禁截图 + `pnpm test`/`cargo test`/`tsc --noEmit`/`pnpm lint`/`i18n:check` 全绿。
6. 更新 `navicat-parity-master-plan.md` §6、`database-development-status.md`、Feature Matrix / Interactions / Context Menus / Shortcuts 台账中对应行（MISSING → 实现状态）。
