# B23 PG 表设计器 + DDL 预览/回滚 + View Builder + B24 PG ER 图反向工程 架构约束（实现前）

> 作者：architect（高见远）｜2026-08-26
> 适用：v2.9.0 冲刺 B23（表设计器 + DDL 预览/回滚 + View Builder）/ B24（ER 图反向工程）实现前**架构约束**。fe-dev（B23：Rust + 表设计器组件）/ fe-dev2（B24：ER 画布组件）照做即可。
> 依据：`navicat-parity-master-plan.md` §3.2 P0（表设计器 + DDL 预览 + View Builder、ER 图反向工程）、§5 D5（对象设计器为声明式表单 + DDL 预览/diff/回滚）、D6（ER/模型画布共用 canvas 核心）、§6 M2 B23/B24 条目、§7.2 快捷键表（Ctrl+D 设计对象、ER F5/R/Delete/Ctrl+=/-/0）、§7.4 操作习惯（对象面板 List/Detail/ER 视图）；现状代码（下述 §0 盘点）；B21 既有约束（`postgres_catalog.rs` 新模块、D-B21-x 系列、文件边界纪律）；B20 `command-registry.ts`（scope/enablement 体系）。
> 性质：**只读评审产出**，本文不改动产品代码。每条均为明确决策，编号 D-B23-x / D-B24-x。冲突消解优先级：安全红线文档 > 本文 > 各实现计划。

---

## 0. 现状盘点（2026-08-26 工作区代码核实）

| 项 | 位置 | 现状 |
|---|---|---|
| 表打开语义 | tool-postgres.tsx:1014 `browse` + :1866 `onOpen` | 表/视图双击/Enter 打开数据网格 tab（`type:"table"`）；tab id `table:schema.name` |
| tab 类型 | tool-postgres.tsx:169 `WorkspaceTab` | `"query" \| "table" \| "object"` 三态；object = 只读属性面板（object-viewer-tab.tsx） |
| 设计器占位 | command-registry.ts:239 `database.object.design` | 已注册（scopes `["NAVIGATOR"]`），B21 前端 `resolveDatabaseCommand` 后恒 disabled，B23 激活 |
| 表结构读取 | postgres_catalog.rs `postgres_object_ddl` table 分支 :350 `table_ddl` | 已有 CREATE TABLE 文本拼接（列/约束/索引），**结构化返回不存在**；`postgres_catalog_objects` columns/constraints/indexes/triggers 四组已就绪 |
| FK 元数据 | postgres_catalog.rs | constraints 组仅返回 `conname + contype`，**无 FK 列/引用明细** |
| DDL 预览 | postgres_catalog.rs :862 `postgres_object_ddl` | 视图走 `pg_get_viewdef`（:423 `view_ddl`）；全部白名单化 + `map_ddl_privilege_error` 泛化错误 |
| 安全原语 | postgres.rs :1008 `quote_identifier`、:1226 `build_insert_statement`、:961 `postgres_transaction`（txn_modes 防嵌套）、:75 `is_read_only` | 全可复用；M3 `count==1` 校验已在 update/delete（:1997/:2085） |
| 删除对象 | postgres_catalog.rs :1036 `postgres_drop_object` | constraint kind 已支持（`ALTER TABLE ... DROP CONSTRAINT`），**ER 删线可直接复用**；dry-run（dependents）→ confirmed 双模式 |
| 能力声明 | types.ts :111 `DatabaseCapabilities` | `supportsRelations/supportsResultEditing/supportsPagination` 等；**无设计器/ER 专属 capability**（决策：不加，见 §四） |
| scope 体系 | command-registry.ts :7 `DATABASE_COMMAND_SCOPES` | 五 scope：DATABASE/NAVIGATOR/WORKSPACE/QUERY_EDITOR/DATA_GRID；**无 DESIGNER / ER_DIAGRAM**（master plan D2 提及 ER_DIAGRAM 但未落地） |
| 前端依赖 | package.json | React 19.2.7；无 react-flow/d3/elkjs 等图形库；有 @dnd-kit、Radix、CodeMirror |
| 导航器 | database-navigator.tsx + postgresql-object-loader.ts | B21 已落地：单击选择、双击/Enter 打开、表级组（columns/indexes/constraints/triggers） |

---

## 一、B23 表设计器架构

### 1.1 打开语义与 tab 类型

**D-B23-1（tab 类型新增 `"designer"`，双击仍开数据网格）**：
- `WorkspaceTab.type` 扩展为 `"query" | "table" | "object" | "designer"`。
- **双击/Enter 表节点 → 数据网格（现状 `browse` 不变）**——Navicat 习惯：双击打开表数据（§7.4）。
- **右键菜单「设计表」→ 打开 `designer` tab**；激活 B21 已注册的 `database.object.design`（原 disabled 占位 → enabled，仅 provider=postgresql）。
- **不做 tab 内模式切换**（数据网格 ⇄ 设计器）：两态渲染逻辑、dirty 语义、工具栏命令集完全不同，揉进一个 `table` tab 会显著膨胀状态机；独立 tab 与现有 `object` tab 的"属性面板→设计器升级"路径正交，且 B29 表单视图批次不依赖它。
- `designer` tab 状态载荷：

```ts
{ type: "designer", id: `designer:${schema}.${table}`, title, object: { schema, name },
  objectRole: "table", connectionId, baseline: TableDesign | null, draft: TableDesignDraft | null,
  dirty: boolean, previewDdl: string | null, applying: boolean }
```

- **designer 与 table 同表复用**：先打开数据网格再「设计表」→ 各自独立 tab（Navicat 允许表数据与设计器并存）；同一表重复打开 designer 时 `openTab` 按 id 去重（现有语义）。
- 表 id 命名空间 `designer:` 与 `table:` 前缀不冲突（`openTab` 的 `some(id)` 去重按全 id）。

### 1.2 数据模型与加载命令

**D-B23-2（新 Rust 模块 `postgres_design.rs`，不扩展 postgres.rs / postgres_catalog.rs）**：
- master plan R1：新 DB 命令按域分文件。表设计器是**读写域**（load + diff + apply + view save），`postgres_catalog.rs` 是只读 catalog 域（模块注释已声明"deliberately does NOT extend"），`postgres.rs` 已是 3022 行。故**新建 `postgres_design.rs`** 承载全部设计器命令，注册到 `lib.rs` invoke_handler。
- 复用：`quote_identifier`、`require_schema`、`resolve_object_oid`、`oid_param`、`map_ddl_privilege_error`、`PostgresState::is_read_only`、`QUERY_TIMEOUT`（均 `pub(crate)` 已导出或本文件 `use crate::postgres::...`）。

**D-B23-3（`postgres_table_design_load`：结构化全量加载，非 DDL 文本）**：

```rust
#[tauri::command]
pub async fn postgres_table_design_load(
    request: PostgresTableDesignLoadRequest, // { connectionId, schema, table }
    state: State<'_, PostgresState>,
) -> Result<PostgresTableDesign, String>

PostgresTableDesign {
  schema, table,
  columns: [{ name, dataType, nullable, default, comment, ordinal }],
  primaryKey: { name, columns: [] } | null,          // indkey 序
  constraints: [{ name, type /* p/f/u/c/x */, definition /* pg_get_constraintdef */, columns, deferrable? }],
  indexes: [{ name, unique, method, columns: [{ name, desc, nullsFirst }], definition /* pg_get_indexdef */ }],
  foreignKeys: [{ name, columns, references: { schema, table, columns }, onDelete, onUpdate, deferrable? }],
  comment: string | null,
  hasData: bool,   // EXISTS(SELECT 1 FROM <t> LIMIT 1)，供 drop column 确认文案
}
```

- 查询复用 B21 已验证模式：`pg_attribute`（列，`ORDER BY attnum`）+ `pg_constraint`（分 contype，FK 展开 `conkey/confkey` 列名映射 + `confrelid` 引用表 + `confupdtype/confdeltype`）+ `pg_index`（`indkey` 带序）+ `col_description/obj_description` + `has_schema_privilege` 门禁 + `LIMIT 10_000` 上限；**参数化全部走 catalog 参数绑定**（无一处拼接用户文本，标识符一律 `quote_identifier` 后仅作库表名占位）。
- `primaryKey` 从 constraints 中 `type=="p"` 单独提取（设计器 UI 需要把 PK 作为列集合展示，Navicat 表设计器"主键"是独立编辑行）。

### 1.3 diff 位置与 DDL 生成（关键决策）

**D-B23-4（diff 放前端，DDL 生成放 Rust——安全边界不可前移）**：
- **diff（对比 baseline vs draft，输出结构化变更描述）在前端**：纯计算、无副作用，本地即时刷新 DDL 预览（每次编辑无 IPC 往返），vitest 可覆盖。
- **DDL 文本拼装 + 校验 + 执行全在 Rust**：`ALTER TABLE` 必须由服务端构造（`quote_identifier` + 白名单 + 非法结构拒绝），前端只传**结构化变更描述**，绝不传拼好的 SQL（延续安全基线"SQL 必须服务端构造"，与 `build_insert_statement` 同构）。
- 中间契约（前端类型 + Rust serde 双侧定义，`rename_all = "camelCase"`）：

```ts
interface TableDesignChange {
  schema: string; table: string;
  addColumns: ColumnDef[];                       // ColumnDef = { name, dataType, nullable, default?, comment? }
  dropColumns: Array<{ name: string }>;
  modifyColumns: Array<{ name: string, changes: Partial<Pick<ColumnDef,"dataType"|"nullable"|"default"|"comment">> }>;
  renameColumns: Array<{ from: string; to: string }>;
  setPrimaryKey: Array<{ name: string; columns: string[] }>;   // 空数组 = DROP PRIMARY KEY
  addConstraints: Array<{ name: string; type: "u"|"c"|"x"; columns: string[]; definition?: string }>;
  dropConstraints: Array<{ name: string }>;
  addIndexes: Array<{ name: string; unique: boolean; method: string; columns: Array<{ name: string; desc: boolean }> }>;
  dropIndexes: Array<{ name: string }>;
  addForeignKeys: Array<ForeignKeyDef>;
  dropForeignKeys: Array<{ name: string }>;
  setComment?: string;
}
```

- **diff 算法规则**（前端 `table-design.ts`，纯函数）：按**对象身份**（列名/约束名/索引名/FK 名）配对；同名属性变化 → modify；缺失 → drop；新增 → add。列顺序变化只影响 `addColumns` 追加（B23 不做列重排 DDL，见 R-B23-4）。comment 变化并入 modify。**diff 产出空变更集 → apply 按钮禁用**。

**D-B23-5（`postgres_table_design_apply` 单命令双模式，事务内执行）**：

```rust
#[tauri::command]
pub async fn postgres_table_design_apply(
    request: PostgresTableDesignApplyRequest, // { connectionId, change: TableDesignChange, confirmed: bool }
    state: State<'_, PostgresState>,
) -> Result<PostgresTableDesignApplyResponse, String>
// confirmed=false → dry-run：白名单校验 + 拼装完整 ALTER 文本返回（ddl 字段），不执行
// confirmed=true  → 校验 + 事务执行，返回 { ddl, applied: true }
```

- **dry-run 响应** `{ ddl: string, warnings: string[] }`：`warnings` 含需二次确认的项（如 `DROP COLUMN <col>` 且表有数据 → "该列含 N 行数据，删除将永久丢失"），前端据此弹 AlertDialog；`confirmed=true` 仅当前端已展示并确认 warnings。
- **事务原子性即回滚语义（D-B23-7）**：confirmed 路径用 `tokio_postgres::Client::transaction()` 包裹全部 ALTER 语句，任一失败 → 自动 `ROLLBACK`（事务对象 drop 即回滚），**不做"保存原结构快照 + 手动反向 DDL"式回滚**——PG DDL 事务性使快照回滚是冗余且易错的（列类型变更反向恢复不可靠）。
- **互斥检查**：apply 前读 `PostgresState.txn_modes`，若该连接存在 `manual` 或 `save` 事务进行中 → 拒绝（`"A transaction is in progress on this connection"`），防嵌套事务污染（延续 postgres.rs:980 的防嵌套语义）。
- readOnly 连接 apply 恒拒绝（`is_read_only` 前置 + 服务器端 `default_transaction_read_only` 双保险）。

**D-B23-6（非法结构拒绝清单——Rust 侧权威校验，dry-run 即拒绝）**：
- 标识符：schema/table/column/constraint/index 名 `trim()` 空 → Err；列名/约束名/索引名重复 → Err。
- 数据类型：`dataType` 不在可识别集合（长度 ≤ 64、字符集白名单 `[A-Za-z0-9_ ()\[\]",.]`，防注入 type 文本）→ Err。
- **DROP COLUMN 被 FK 引用**（本表被引用方或引用方列）→ Err（`"column X is referenced by foreign key Y"`，不静默 CASCADE）——B21 drop 无此场景，此处是 B23 特有护栏。
- DROP PRIMARY KEY 时若有 FK 引用主键列 → Err。
- readOnly 连接 → Err。
- `modifyColumns` 类型变更 PG 自身拒绝转换失败 → 错误透传（泛化文案，延续 `map_ddl_privilege_error` 风格，不泄漏原始 SQL）。

**D-B23-7（回滚语义：事务原子性，无独立快照机制）**：
- 应用前保存 `baseline`（load 结果）到 tab state，用途是 **diff 展示**（用户可看"将变更"明细），不是回滚载体。
- 应用失败/取消 → 事务 ROLLBACK，库结构零变更；前端保留 draft（编辑内容不丢），toast 展示失败原因。
- 应用成功后：重新 `postgres_table_design_load` 刷新 baseline + 数据网格 tab 若打开则提示刷新（browse 重置，不改脏状态）。

### 1.4 表设计器 UI（声明式表单）

**D-B23-8（`table-designer-tab.tsx` 新文件，声明式表单 + 双栏布局）**：
- 布局：**左主区 = 编辑表单（声明式），右栏 = DDL 预览**（只读 CodeMirror，`language:"sql"`，dry-run 结果实时刷新——防抖 300ms 触发 `postgres_table_design_apply(confirmed=false)`）。
- 编辑区三 Tab（复用 Radix Tabs）：**列**（表格行：名称/类型 select/可空/默认/注释/主键勾选；增删行）+ **约束/索引**（类型+列多选+去重选项）+ **外键**（本表列 → 引用 schema/表/列 + ON DELETE/UPDATE 下拉）。
- 变更驱动 diff：`draft` 每次编辑 → 前端 `diffTableDesign(baseline, draft)` → `TableDesignChange` → 预览/保存。
- 工具栏（designer tab 内）：保存（Ctrl+S）、撤销（Esc，恢复 baseline）、刷新。**保存 = dry-run 先出 warnings → 有 warning 弹 AlertDialog → confirmed apply**；无 warning 直接 apply。
- 新建表入口：B23 **不做**「新建表」向导（Navicat 新建表 = 空设计器 + CREATE TABLE），但 tab 打开仅来自已有表右键；新建表放 backlog（R-B23-3）。

### 1.5 View Builder

**D-B23-9（视图可编辑、物化视图只读；复用 `postgres_object_ddl` view 分支加载）**：
- 入口：视图/物化视图右键「设计视图」（B21 菜单表 object+view 分支扩展；materializedView 项 disabled + 提示只读）。
- 加载：`postgres_object_ddl`（objectType=view，走 `pg_get_viewdef`）→ 编辑 SQL。
- 保存：新命令 `postgres_view_save`（`postgres_design.rs`）：

```rust
PostgresViewSaveRequest { connectionId, schema, name, definition /* 用户编辑的 SELECT 文本 */, confirmed }
```

- 构造 `CREATE OR REPLACE VIEW {schema}.{name} AS {definition}`：
  - `definition` 是用户编辑 SQL，**无法参数化**（DDL 语义）；护栏 = `single_statement` 校验（postgres.rs:1299 已有，防 `; DROP` 批注入）+ 只允许以 `SELECT`/`WITH` 开头（大小写不敏感、前导空白容忍）+ readOnly 拒绝 + confirmed 二次确认。
  - 审计日志：`tracing::info!("CREATE OR REPLACE VIEW schema name")`，不含 definition 文本（防敏感信息）。
- **物化视图不提供编辑**（`CREATE OR REPLACE` 不适用于 matview，DROP+CREATE 破坏依赖且需重建数据）：仅预览（现状已支持），文档注明。

---

## 二、B24 ER 图反向工程架构

### 2.1 画布选型（方案对比与裁定）

**D-B24-1（裁定：方案 A——react-flow v12 + dagre，不选自研）**：

| 方案 | 内容 | 优点 | 缺点 | 评估 |
|---|---|---|---|---|
| **A：react-flow v12 + dagre** | 引入 `@xyflow/react`（MIT，v12.3+ 官方支持 React 19）+ `dagre`（分层布局，MIT） | pan/zoom/拖拽/选择/edge 删除是内建一等交互；自定义节点（表卡片）声明式；B35 模型画布零迁移；社群成熟、E2E 稳定 | 依赖体积 ~100KB+；需学其数据模型（nodes/edges）与受限的自定义 edge 渲染 | **采纳** |
| B：自研 SVG canvas 核心 | 全屏 `<g transform>` + pointer 拖拽 + wheel 缩放 + 连线 | 零依赖、可控 | pan/zoom 原点变换、缩放跟随、连线锚点、边界钳制等细节易出 bug；E2E 反复打回；等于造一个 mini react-flow，且违背「成熟技术优先」 | 否决 |
| C：d3-zoom + d3-drag | 只引 d3 子模块做变换数学，节点/线仍自绘 | 依赖小 | zoom/drag 变换仍要自研画布状态机 + 节点渲染 + 连线，工作量接近 B 但多一个间接层 | 否决 |

- 裁定依据：master plan §1.3「最小改动、成熟技术优先」+ D6「ER/模型画布共用 canvas 核心」——**react-flow 即该共享核心**；B35 模型画布直接复用本批画布组件与数据装配层。自研方案的抽象成本（viewport 变换/选择/连线/拖拽）等于造一个 mini react-flow，与既有纪律相悖。
- dagre 而非 elkjs：elkjs 更现代但体积/复杂度高（E2E 布局调度、wasm 路径），ER 反向工程的 FK 图规模（几十表）dagre 足够，且确定性布局对视觉门禁友好。

### 2.2 数据源与布局

**D-B24-2（`postgres_er_schema` 命令——Rust 侧，fe-dev 在 B23 实现）**：

```rust
#[tauri::command]
pub async fn postgres_er_schema(
    request: PostgresErSchemaRequest, // { connectionId, schema }
    state: State<'_, PostgresState>,
) -> Result<PostgresErSchema, String>

PostgresErSchema {
  tables: [{ name, comment, columns: [{ name, dataType, primaryKey, nullable, comment }] }],
  foreignKeys: [{ name, fromTable, fromColumns, toTable, toColumns, onDelete, onUpdate }],
}
```

- 查询：表 = `pg_class relkind IN ('r','p')` + 列 = `pg_attribute`（复用 `postgres_catalog_objects` columns 同款）；FK = `pg_constraint con.contype='f' AND con.connamespace = <schema>`，`conkey/confkey` 经 `pg_attribute` 映射列名，`confrelid` 定位引用表——**含反向外键**（B 表引用 A 表时，A 的关系线同样出现，Navicat ER 反向工程默认展示全部 FK 边，含循环引用）。
- 落点：**`postgres_design.rs`**（与表设计器同批 Rust；`postgres_catalog.rs` 是只读单对象域，ER 是 schema 级多对象域，不复用其函数签名，但复用 `require_schema`/`quote_identifier`/白名单纪律）。权限：`has_schema_privilege(USAGE)` 门禁 + 参数化 + `LIMIT 10_000` 表上限。
- **前端装配（fe-dev2 的 `postgresql-er-loader.ts`）**：`invoke postgres_er_schema` → 映射为 react-flow `nodes/edges`，**FK 边由 frontend 计算锚点**（从列 → 引用列，两侧列名一致时可无锚定渲染）。

**D-B24-3（布局算法：dagre 分层，手动拖拽优先）**：
- 初始布局/工具栏「重新排列」：dagre `layout`（rankdir=LR，edge 方向 = FK 引用方向：被引用表靠左/靠上）→ 生成节点 `position`。
- 用户拖拽后：节点 position 进入本地 override map（`positionsByTable`），「重新排列」清空 override 重算；**手摆优先**（Navicat 行为）。
- 布局与缩放持久化：`localStorage`（key `er-layout:<connId>:<schema>`，仅存 override positions + viewport），不依赖服务端。

### 2.3 交互与 FK 设计删除

**D-B24-4（交互范围：B24 只做 FK 删除（删线），FK 新建走表设计器）**：
- 画布内建（react-flow 原生）：节点拖拽、滚轮/触摸板 pan、Ctrl+滚轮缩放、框选、点击选中、双击空白取消。
- **删线 = 删除 FK 约束**：选中 FK 边 → Delete 键或边右键「删除外键」→ AlertDialog（文案含 `ALTER TABLE "schema"."table" DROP CONSTRAINT "fkname"` 预告 + 依赖提示）→ **复用 `postgres_drop_object`**（kind=constraint, relation=fromTable, confirmed=true，B21 已实现 dry-run dependents + TOCTOU 复查 + readOnly 拒绝），成功后从画布移除该边。**不新造删 FK 命令**（杜绝重复实现破坏性路径）。
- **FK 新建不在 B24**：R 键（Navicat「新建关系」）注册为 ER scope 命令但 **disabled**，右键菜单项「新建外键（在表设计器中）」→ 打开该表 designer tab（B23 的 FK 编辑器完成创建）。理由：FK 创建需要列级编辑 + 服务端 DDL 校验，与表设计器是同一套 `TableDesignChange.addForeignKeys` 管道，两处实现必然漂移。
- 删表节点 ≠ 删表：节点 Delete 仅移除画布视图中的表卡片（本地过滤），**绝不对接 Drop 命令**（破坏性语义不可藏在画布快捷键里）；右键「删除表」→ 跳转导航器对应表的 Drop 流程（AlertDialog，B21 已有）。

**D-B24-5（与表设计器/数据网格联动）**：
- 单击表节点：选中（+ 高亮其 FK 边，展示关系详情条）。
- 双击表节点：打开 `designer` tab（同 D-B23-1 路由，`designer:schema.table` 去重）。
- 节点右键菜单：「设计表」「打开数据」+「删除外键」（仅边）/「从画布移除」（仅节点）。
- 画布不持有数据，一律经 `openTab` 路由跳转，**保持单一打开入口**（不发明第二套 tab 打开逻辑）。

### 2.4 ER tab 与 scope

**D-B24-6（tab 类型新增 `"er"` + 新增 `ER_DIAGRAM` scope）**：
- `WorkspaceTab.type` 增加 `"er"`：`{ type:"er", id: `er:${schema}`, schema, connectionId, nodes, edges, positions, viewport }`。
- 入口：导航器 schema 节点右键「ER 图」+ 工具栏按钮（占位由 B23 预留，见 §三）。
- **新增 `ER_DIAGRAM` scope**（master plan D2 已规划但 command-registry 未落地），注册 ER 命令（§四）；`[data-scope="er-diagram"]` 由 er-diagram-tab.tsx 根节点提供，scope-router 聚焦判定后接管 F5/R/Delete/Ctrl+=/-/0。

---

## 三、文件边界（fe-dev / fe-dev2 切分）

> 原则：**全部 Rust = fe-dev（B23）**；`tool-postgres.tsx` / `command-registry.ts` = fe-dev 单次改动（B23 把 B24 的 scope、命令、ER 渲染插槽一次铺好）；fe-dev2（B24）只新建/填充画布组件文件，**不碰共享文件**。延续「文件唯一所有」纪律。

| 文件 | 归属 | 改动 |
|---|---|---|
| `src-tauri/src/postgres_design.rs` | fe-dev | **新文件**：D-B23-2/3/5/9（`postgres_table_design_load`、`postgres_table_design_apply`、`postgres_view_save`）+ D-B24-2（`postgres_er_schema`，B23 一并实现） |
| `src-tauri/src/lib.rs` | fe-dev | 注册上述 4 个命令 |
| `src/lib/database/table-design.ts` | fe-dev | **新文件**：`TableDesign`/`TableDesignChange` 类型 + `diffTableDesign()` 纯函数（D-B23-4） |
| `src/components/toolbox/table-designer-tab.tsx` | fe-dev | **新文件**：声明式表单 + DDL 预览 + save/revert（D-B23-8） |
| `src/components/toolbox/er-diagram-tab.tsx` | fe-dev 建空壳 → **fe-dev2 填实现** | B23 先建空壳组件（`return null` + i18n 占位）供路由编译；B24 实现画布 |
| `src/components/toolbox/er-canvas.tsx` | fe-dev2 | **新文件**：react-flow 画布 + 自定义表卡片节点 + FK 边渲染 + dagre 布局（D-B24-1/3/4） |
| `src/lib/database/postgresql-er-loader.ts` | fe-dev2 | **新文件**：`postgres_er_schema` 结果 → react-flow nodes/edges 装配 + 布局 override 持久化（D-B24-2/3） |
| `src/components/toolbox/tool-postgres.tsx` | fe-dev（B23 单次） | designer/er tab 路由 + 右键「设计表」「设计视图」「ER 图」入口 + toolbar ER 按钮（占位 disabled）+ `data-scope` 挂载 |
| `src/lib/database/command-registry.ts` | fe-dev（B23 单次） | 新增 `DESIGNER`/`ER_DIAGRAM` scope + D-B23-10/D-B24-7 全部命令注册（含 ER 命令，B24 不新增） |
| i18n | fe-dev（B23） | 设计器/ER 键（fe-dev2 的组件消费 B23 已建键） |

> 交接点：
> - fe-dev2（B24）**唯一 Rust 依赖** = B23 已实现的 `postgres_er_schema`（invoke 契约即 `PostgresErSchema`，fe-dev 先定类型并导出 TS 形状）。
> - fe-dev2 填充 `er-diagram-tab.tsx` 时，tool-postgres.tsx / command-registry.ts 已被 B23 一次性铺好（ER 命令 enabled、渲染插槽已接），fe-dev2 **零共享文件改动**。
> - 顺序约束：B23 合入 main 后 B24 才可开工（依赖 `postgres_er_schema` + 路由插槽）。

---

## 四、B20 scope-router 兼容：designer / er 的 scope 归属

**D-B23-10（新增 `DESIGNER` scope；`database.object.design` 激活；designer 写命令注册）**：

| command id | scope | connectionStates | 说明 |
|---|---|---|---|
| `database.object.design` | NAVIGATOR | connected | B21 占位 → **B23 激活**（resolve enabled）；open designer tab |
| `database.design.save` | DESIGNER | connected | Ctrl+S；dirty 才 enabled；readOnly 时 handler 层拒绝 |
| `database.design.revert` | DESIGNER | connected | Esc；恢复 baseline |
| `database.design.refresh` | DESIGNER | connected | 重新 load + 重算 diff |

**D-B24-7（新增 `ER_DIAGRAM` scope + ER 命令注册）**：

| command id | scope | connectionStates | defaultBinding | 说明 |
|---|---|---|---|---|
| `database.er.open` | NAVIGATOR | connected | — | schema 右键/工具栏打开 ER tab |
| `database.er.refresh` | ER_DIAGRAM | connected | F5 | 重拉 schema 重排布局（F5 全局不注册，画布聚焦才接管） |
| `database.er.zoomIn` / `zoomOut` / `resetZoom` | ER_DIAGRAM | connected | Ctrl+= / Ctrl+- / Ctrl+0 | 画布聚焦时接管 |
| `database.er.deleteRelation` | ER_DIAGRAM | connected | Delete | 删除选中 FK 边 → AlertDialog → `postgres_drop_object` |
| `database.er.newRelation` | ER_DIAGRAM | connected | R | **占位 disabled**（提示"在表设计器中添加外键"） |
| `database.er.openDesigner` | ER_DIAGRAM | connected | — | 双击节点，组件原生跳转，不绑快捷键 |

- **scope 归属原则**：入口类（open）一律 `NAVIGATOR`；画布内交互命令一律 `ER_DIAGRAM`（不进 DATA_GRID/QUERY_EDITOR，无冲突）。designer 保存/撤销用 `DESIGNER` scope（与 DATA_GRID 的 Ctrl+S/Esc 按聚焦 scope 路由，互不干扰）。
- **能力门槛：不加新 capability**——B21 先例（六类对象无 capability 门槛）。design/er 命令 `requiredCapabilities` 为空，前端按 `provider.id==="postgresql"` 启用菜单（`nodeContext` 里已是 PG provider）。**不得**给 `DatabaseCapabilities` 加 `supportsDesigner` 之类（无调用方不建抽象，且 PG 是当前唯一 provider，声明无意义）。
- 与 B20 scope-router 共存：`designer`/`er` tab 根节点挂 `[data-scope="designer"]`/`[data-scope="er-diagram"]`，router 在聚焦判定阶段接管对应绑定表；非聚焦时快捷键放行（终端 wins 纪律不变）。

---

## 五、风险与待验证

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R-B23-1 | diff 算法与 Rust 校验语义不一致（前端认为可变更、Rust 拒绝） | 中 | 前端 diff 规则与 §1.3 拒绝清单逐条对齐；dry-run 结果即预览唯一事实源；vitest 覆盖 diff 边界 + Rust 单测覆盖拒绝清单 |
| R-B23-2 | 复杂表（大宽表/多 FK）DDL 预览性能 | 低 | dry-run 防抖 300ms；单表变更范围天然受限；`LIMIT`/`QUERY_TIMEOUT` 沿用 |
| R-B23-3 | 新建表向导缺失被误当缺陷 | 低 | B23 明确范围=编辑已有表；新建表 = 空设计器 + CREATE TABLE 支持 backlog 登记（master plan 未列 P0） |
| R-B23-4 | 列重排/类型变更的列顺序 DDL 不支持（PG 无列序 ALTER） | 低 | diff 不做列重排；设计器展示物理序，重排仅 UI 提示"需重建表"（不做重建） |
| R-B24-1 | react-flow v12 与 React 19/WebView 兼容性（Tauri macOS WebKit） | 中 | 选 v12.3+（官方 React 19 支持）；E2E 首轮即验证渲染；若 WebKit 异常则降级记录并评估方案 C |
| R-B24-2 | dagre 布局在超多表 schema（数百表）性能 | 中 | `postgres_er_schema` LIMIT 10_000；前端懒渲染（虚拟化或分 schema 进入）；视觉门禁用 ≤30 表 fixture |
| R-B24-3 | FK 边从列到列的锚定在布局后交叉重叠 | 低 | 双层贝塞尔边 + 列名一致时直连锚点；交叉不阻塞 B24（可后置优化） |
| R-B24-4 | 删线（删 FK）与表设计器 FK 编辑器双入口状态同步 | 中 | 两入口都写同一张表（走 `postgres_drop_object` / `TableDesignChange.addForeignKeys`）；删线成功后画布局部移除边，ER 图重开时以服务端为准（不缓存 FK 集） |

---

## 六、验收线索（DoD 支撑，供 QA）

- **B23**：原生 E2E（真实 PG fixture）——右键表「设计表」打开 designer tab；改列类型/可空/默认 → 预览区 DDL 正确（dry-run 文本含 `ALTER TABLE`）；保存 → 服务端生效；改完未保存 Esc → 恢复 baseline；**非法结构拒绝**（删除被 FK 引用的列 → 报错不执行；删除带数据列 → warnings 弹确认后执行）；失败 apply（如类型转换失败）→ 数据库结构零变更（事务回滚验证）；readOnly 连接「设计表」打开但保存禁用；View Builder：编辑视图 SELECT → 保存 `CREATE OR REPLACE VIEW` 生效，`; DROP` 注入被拒，物化视图只读。
- **B23**：`postgres_table_design_load` 全量字段正确（PK/FK 列序）；`postgres_table_design_apply` 拒绝清单单测 + 事务原子性单测；前端 `diffTableDesign` vitest（add/drop/modify/rename/FK/PK 全分支）。
- **B24**：原生 E2E——schema 右键「ER 图」打开画布；表卡片渲染列名/类型/PK 标记；FK 关系线正确（含反向外键与循环引用）；拖拽节点 → 位置保持（重开后 localStorage 恢复）；Ctrl+滚轮缩放 + 拖拽平移；选中 FK 边按 Delete → AlertDialog 预告 `DROP CONSTRAINT` → 确认后服务端 FK 删除 + 画布移除边；readOnly 连接删线被拒；双击表节点 → 打开 designer tab。
- **B24**：`postgres_er_schema` 单测（FK 列序、跨 schema 过滤、权限门禁）；视觉门禁（dark/light/960×700 + 截图，画布含 3-5 表 + 关系线）。
- 全量回归：`pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check`；受影响批 WDIO/Playwright 原生套件。
