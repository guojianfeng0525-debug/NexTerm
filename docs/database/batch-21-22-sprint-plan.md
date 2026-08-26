# B21+B22「导航器对象全覆盖 + 连接管理」合并冲刺计划（Navicat Parity，v2.9.0 收官 M2）

> 状态：ACTIVE（用户已拍板大版本节奏：M2 一次性合并 B21+B22，收官发 v2.9.0；无 PLANNING 审批门）
> 作者：pm（许清楚）｜2026-08-26
> 依据：`navicat-parity-master-plan.md` §6 M2（B21/B22 定义）、§5 D3/D9（上下文菜单由 provider 声明、能力声明驱动 enablement）、§8（质量门禁）；`navicat-premium-context-menus.md`（21 项确认菜单清单）；`navicat-premium-interactions.md` IN-01/02/03/07/29（双击/Enter/连接生命周期证据）；`batch-19-20-sprint-plan.md`（Slice/AC 格式与证据规则范本）
> **用户新门禁（2026-08-26，必须遵守）**：① 每个 Slice 标记实现完成前，必须**真实页面 E2E 验证通过**（WDIO + debug 二进制 + 真实 PG fixture，已验证可用）；② 版本发布前 **UI/UX 视觉验证**（visual spec 截图 + glm5.3 视觉评审）全通过才发布。
> **范围裁定（2026-08-26）**：v2.9.0 = B21（导航器对象全覆盖）+ B22（连接管理）一次性合并收官 M2；B23（表设计器）/B24（ER）顺延至下一里程碑（v2.9.x 或 v2.10.0，发布时由产品在 master-plan §6 登记归属调整）。

---

## 0. 证据规则（沿用 B18/B19+B20）

| 标记 | 含义 |
|---|---|
| **[Fact]** | Navicat 17 Windows 手册（M17）直接证据，标注页码/条目 |
| **[UNVERIFIED]** | 现有官方资料无法建立该精确行为，禁止声称 parity |
| **[NexTerm]** | 产品决策：NexTerm 自定义行为，不声称 Navicat parity |

**范围（Master Plan §6 M2 + 用户裁定）**：
- **B21 导航器对象全覆盖**：函数/序列/索引/约束/触发器/列六类节点入树 + 图标 + 双击打开语义；21 项确认菜单逐项核对并按对象启用；对象操作（复制名/刷新/生成 DDL/Drop）；关键 DoD = 每对象类型原生 E2E 打开/菜单。
- **B22 连接管理**：连接颜色与虚拟分组、连接导入/导出、批量测试/重连 + 状态语义；关键 DoD = 连接导入导出原生 E2E。
- 约束延续：`Command Resolver` 不执行命令；浏览器 E2E 不替代原生 E2E；每批窄范围、独立验证、更新全部审计台账。

---

## 1. 范围与目标

### 1.1 目标

把 PG 导航器从「schema + 表/视图/物化视图」推进到「Navicat 级对象树全覆盖」：六类对象节点（函数/序列/索引/约束/触发器/列）入树、对象类型图标、双击/Enter 打开语义、按对象启用的确认菜单、DDL/Drop 操作；并把连接入口推进到「颜色标识 + 虚拟分组 + 导入导出 + 批量测试/重连 + 状态语义」，全部以原生 E2E + 视觉门禁验收，收官 M2 发 v2.9.0。

### 1.2 范围界定决策

| # | 决策 |
|---|---|
| D-B21-1 [NexTerm] | **树层级**：schema 下对象组从 3 组扩到 5 组——Tables / Views / Materialized Views / **Functions / Sequences**；**表/视图/物化视图节点由「叶子」改为「可展开」**，展开显示 Columns / Indexes / Constraints / Triggers 四个子组（子组为叶子组，组内为对象节点）。列节点为叶子。 |
| D-B21-2 [NexTerm] | **双击打开语义**（延续 IN-02 表=查看器的 [Fact] 基线）：表/视图/物化视图=浏览数据（现状语义不变）；函数/序列/索引/约束/触发器=**对象查看器 tab**（只读，展示 DDL + 对象属性）；列=打开所属表浏览 tab（[NexTerm]，Navicat 列双击 [UNVERIFIED]）。**Enter 键 = 双击等价**（IN-02「Enter UNVERIFIED」，以 [NexTerm] 对齐双击）。对象查看器为**纯只读**，不提前承担 B23 设计器职责。 |
| D-B21-3 [NexTerm] | **函数节点显示签名**：节点 label 用 `proname`，双击查看器展示完整 `pg_get_function_identity_arguments` 签名与 DDL；不把签名展开为多节点（[NexTerm]，Navicat 函数树展示 [UNVERIFIED]）。 |
| D-B21-4 [NexTerm] | **确认菜单按对象类型启用**（决策 D3 落地）：菜单项集合由 provider 声明（`postgresql-object-loader.ts` / menu descriptor），enablement 走既有 `resolveDatabaseCommand`；UI 禁止按 PG 对象名硬编码分支。21 项清单中归属本批的落地，归属 B23/B24 的标注移交。 |
| D-B21-5 [NexTerm] | **生成 DDL**：新 Rust 命令 `postgres_object_ddl`（表=`pg_dump -s` 单表降级为 `pg_get_*def` 组合；视图=`pg_get_viewdef`；物化视图=`pg_get_viewdef`；函数=`pg_get_functiondef`；序列=`pg_get_serial_sequence` + 属性；索引=`pg_get_indexdef`；约束=`pg_get_constraintdef`；触发器=`pg_get_triggerdef`），输出为新查询 tab 只读 SQL 文本。 |
| D-B21-6 [NexTerm] | **Drop 对象**：新 Rust 命令 `postgres_drop_object`（按类型映射 `DROP TABLE/VIEW/MATERIALIZED VIEW/FUNCTION/SEQUENCE/INDEX/TRIGGER/CONSTRAINT`），前端二次确认对话框；readOnly 连接 / 断连禁用；成功后刷新对应父节点子树。**Drop 是破坏性操作，二次确认 + 权限门禁 + 审计日志为硬约束**（Master Plan §8 Safety / R5）。 |
| D-B21-7 [NexTerm] | 21 项菜单核对口径：`navicat-premium-context-menus.md` 全部 24 行（toolbar 2 + data grid 14 + query builder 6 + ER 2）逐项核对；**本批落地** toolbar 2 项 + 导航器对象菜单（[UNVERIFIED]→[NexTerm] 规格）；**维持+回归** data grid 14 项（B17/B18 已覆盖，本批不重复实现，仅核对补齐缺口）；**移交 B23** query builder 6 项；**移交 B24** ER 2 项。 |
| D-B22-1 [NexTerm] | **连接颜色**：profile 新增 `color` 字段（持久化，可选），应用于连接节点图标/标签着色 + 该连接数据 tab 标题标记；默认无颜色（中性）。配色取自既有主题色板，不引入新色域。 |
| D-B22-2 [NexTerm] | **虚拟分组**：复用已持久化但未 UI 化的 `profile.group` 字段（`postgres-storage.ts:20` 已有 `group_name`）；导航器连接列表按组分组渲染；组管理 = 连接编辑对话框内分组下拉 + 组名自由输入（新建即输入），不做独立组管理器对话框（[NexTerm]，Navicat 分组管理细节 [UNVERIFIED]）。 |
| D-B22-3 [NexTerm] | **连接导入/导出**：在数据库工具箱内新增「连接管理」入口，导出为脱敏 JSON（密码字段加密导出，导入时解密或要求重输）；复用既有 `ConnectionStorageManager.exportConnections/importConnections`（`src/lib/config-export-import.ts:137-158`）底层，不另造格式；不做 Navicat `.ncx` 专有格式（[UNVERIFIED] 且闭源）。 |
| D-B22-4 [NexTerm] | **批量测试/重连**：测试连接 = 新建临时连接校验（成功返回 server version / 延迟 ms），**不注册进 `PostgresState.clients`**；批量测试支持多选连接并发（上限 5，防资源耗尽）；重连 = 复用既有 connect 流程（`postgres_connect`），tab 内断连态提供 Reconnect 按钮。 |
| D-B22-5 [NexTerm] | **连接状态语义**：导航器连接节点状态徽标（connected/connecting/error/disconnected）；断连后子树保留缓存但只读（操作禁用）；不引入自动重连（autoReconnect 文案属于终端/App 全局层，DB 工具箱不做，避免范围蔓延）。 |

### 1.3 不变量

- B17/B18 数据网格行为、B19/B20 快捷键 scope 路由与执行语义**零回归**（新节点入树不得改变现有表/视图/物化视图的单击/双击/菜单行为）。
- readOnly 连接：浏览/复制名/刷新/生成 DDL 全部可用；Drop 禁用。
- 断连状态：导航器缓存子树仍可浏览（只读），连接节点菜单仅显示 Connect/Edit/Delete。
- 共享 Navigator（`database-navigator.tsx`）保持 provider 无关：对象类型/图标/菜单由 provider 数据驱动，禁止在共享组件里写 `pg_` 分支。
- 不破坏 `Command Resolver` 与 `command-registry.ts` 既有 scope（NAVIGATOR scope 的 enablement 是唯一新增接线点）。

---

## 2. 现状基线（代码锚点，勿重复实现）

### 2.1 B21 基线（2026-08-26 代码审计）

| 现状 | 位置 |
|---|---|
| `postgres_catalog_search` 已支持 relation/column/function/type 四种 kind；relation 仅 `relkind IN ('r','v','m','p')` | `src-tauri/src/postgres.rs:2216-2290` |
| **缺** index/constraint/trigger 查询 kind；**缺** DDL 生成命令；**缺** Drop 命令 | — |
| 树构建：schema → 3 组（tables/views/materializedViews）→ 关系叶子；表/视图/物化视图节点 `expandable: false` | `src/lib/database/postgresql-object-loader.ts:131-242` |
| `DatabaseObjectRole` / `DatabaseObjectIconRole` 仅 relation/table/view/materializedView | `src/lib/database/types.ts:18-28` |
| 共享导航器渲染：单击=select+toggle+open 混合（`onClick`），无独立双击语义、无 Enter 处理 | `src/components/toolbox/database-navigator.tsx:100-123` |
| 上下文菜单挂载点 `renderContextMenu`：connection 节点（断开/新建查询/刷新/编辑/删除）、relation 对象（Open Data/刷新/复制名）；catalog/schema/group 走通用 fallback（刷新/复制名/新建查询） | `tool-postgres.tsx:1606-1642` |
| 双击打开 `onOpen`：仅 relation → `browse()` | `tool-postgres.tsx:1602-1605` |
| 复制名/刷新/新建查询/CSV 导出已存在 | `tool-postgres.tsx:1035-1062` |

### 2.2 B22 基线（2026-08-26 代码审计）

| 现状 | 位置 |
|---|---|
| profile 已持久化 `group`（`group_name`）与 `environment`，但 `group` 无 UI | `postgres-storage.ts:20,36-38`；`postgresql-profile-adapter.ts:49-50` |
| **缺** `color` 字段（adapter 无、SQLite 无列） | — |
| 连接导出/导入底层已存在（config 级） | `src/lib/config-export-import.ts:137-158`（`ConnectionStorageManager.exportConnections/importConnections`） |
| Rust 连接命令：`postgres_connect` / `postgres_disconnect`（无独立 test/ping 命令） | `postgres.rs:621,671` |
| 断连/重连：App 级 terminal 层有 reconnect 文案与流程；DB 工具箱 tab 无 Reconnect 按钮 | `src/App.tsx:434-440`；locales 有 `reconnect` 键 |
| 导航器连接 root 节点渲染（无状态徽标） | `postgresql-object-loader.ts:39-57`；`database-navigator.tsx:21-40` |

---

## 3. B21 User Visible Slice 划分

| Slice | 用户可见能力 | 依赖 | 交付形态 |
|---|---|---|---|
| **A 对象类型扩展** | 六类对象节点（函数/序列/索引/约束/触发器/列）入树 + 图标 + 双击/Enter 打开语义；表节点可展开显示四类子对象 | Rust：catalog_search 增 index/constraint/trigger kind + 对象属性查询；前端：loader/树结构扩展、对象查看器 tab | 独立可发布 |
| **B 确认菜单** | 21 项确认菜单逐项核对；导航器对象菜单按类型启用（Open/Copy Name/Generate DDL/New Query/Refresh/Drop…）；toolbar Use Big Icons / Show Caption | Slice A 的节点类型（菜单按类型分支） | 独立可发布，A 部分并行（菜单 descriptor 与节点扩展同批开发） |
| **C 对象操作** | 复制名（全类型）、刷新（子树级）、生成 DDL（新 tab）、Drop 对象（二次确认 + 树刷新） | Slice A 节点 + Slice B 菜单入口；Rust `postgres_object_ddl`/`postgres_drop_object` | 独立可发布，依赖 B 入口 |

**建议开发顺序**：A 先行（Rust kind 扩展 + 树结构是 B/C 地基）→ B（菜单 descriptor）→ C（操作命令）；B 与 A 的 Rust 部分可并行，C 的 Rust 命令可与 A 并行开发。

---

## 4. Slice A：对象类型扩展

### 4.1 用户故事

> 作为开发，我要在导航器里像 Navicat 一样一眼看到函数的签名、序列、以及表下面的列/索引/约束/触发器，双击任何对象就能打开它对应的查看器，按 Enter 也能得到同样的行为。**[Fact]** 表在 List/Detail 视图中双击打开 Table Viewer（IN-02 / Double Click Matrix）；导航器连接/数据库双击连接（IN-01）；对象树按类型分组展示为 Navicat 导航器基本形态（context-menus.md Navigator 行 [UNVERIFIED]，分组形态以 [NexTerm] 规格落地，不声称 parity）。

### 4.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| schema 节点展开 | 5 组：Tables / Views / Materialized Views / **Functions / Sequences**（i18n 本地化） | 组形态 [NexTerm]（D-B21-1） |
| 表/视图/物化视图节点展开 | 4 子组：Columns / Indexes / Constraints / Triggers；子组懒加载 | [NexTerm]（D-B21-1） |
| 函数节点 | label=proname；右键可复制名/DDL/Drop；**双击 → 对象查看器 tab**（签名 + `pg_get_functiondef` DDL） | 打开语义 [NexTerm]（D-B21-2） |
| 序列节点 | label=seqname；**双击 → 对象查看器 tab**（DDL + last_value/is_called/min/max/increment 只读属性） | [NexTerm]（D-B21-2） |
| 索引/约束/触发器节点 | label=名称（约束显示类型前缀如 `CHECK/UNIQUE/FK/PK`）；**双击 → 对象查看器 tab**（`pg_get_indexdef`/`pg_get_constraintdef`/`pg_get_triggerdef` DDL） | [NexTerm]（D-B21-2） |
| 列节点 | label=列名，类型/可为空为 tooltip；**双击 → 打开所属表浏览 tab** 并在结果网格列头定位高亮 | [NexTerm]（D-B21-2） |
| Enter 键 | 导航器节点聚焦时按 Enter = 触发 onOpen（与双击等价）；仅 `openable` 节点生效 | [NexTerm]（对齐双击） |
| 对象查看器 tab | 只读：标题=对象名，正文=DDL 代码块（CodeMirror readonly）+ 属性行；无编辑入口 | [NexTerm]（D-B21-2） |
| 加载失败 | 子组/节点加载失败显示错误行（沿用 `loadStates` 机制），刷新可重试 | [NexTerm] |

### 4.3 依赖分析（Rust + 前端）

- **Rust**：`postgres_catalog_search` 新增 `index`/`constraint`/`trigger` 三个 kind：
  - `index`：`pg_indexes`（schemaname/tablename/indexname/indexdef）；
  - `constraint`：`pg_constraint` join `pg_class`/`pg_namespace`（conname/conttype→CHECK/UNIQUE/PRIMARY KEY/FOREIGN KEY/EXCLUDE + `pg_get_constraintdef`）；
  - `trigger`：`pg_trigger` join `pg_class`/`pg_namespace`（tgname + `pg_get_triggerdef`）。
  - 新增 `postgres_object_props(connectionId, kind, schema, name, table?)`：返回对象查看器展示的属性（函数签名、序列属性、索引/约束/触发器 DDL），供查看器渲染。
  - 表子节点加载在现有 `column` kind（`postgres_catalog_search` 已支持 relation 限定）基础上复用。
- **前端**：
  - `postgresql-object-loader.ts`：schema 分支增加 Functions/Sequences 组（catalog_search kind=function/新增 sequence kind——**sequence 复用 relation kind 需在 Rust 侧增 `relkind='S'` 或独立 kind，实现由 cto 定**）；表/视图/物化视图节点改 `expandable:true`，展开分支按 kind 返回 Columns/Indexes/Constraints/Triggers 子组；新 `getPostgresObjectReference(node)`（覆盖六类对象，返回 connectionId/database/schema/objectKind/name/table）。
  - `database-navigator.tsx`：单击=select（**若 expandable 且非 openable 才 toggle**），双击=onOpen，Enter=onOpen——**调整单击/双击语义**（现状 onClick 三合一要拆开：onClick=select；expandable 用箭头按钮或节点展开手势；onDoubleClick=open；onKeyDown Enter=open）。**此改动影响面最大，见风险 R-B21-1。**
  - 新组件 `object-viewer-tab.tsx`（只读查看器 tab）；`tool-postgres.tsx` 的 `onOpen` 分支按对象类型路由（relation→browse，其余→查看器）。
  - 类型扩展：`DatabaseObjectRole`/`IconRole` 增 `function`/`sequence`/`index`/`constraint`/`trigger`/`column`（types.ts 由 fe-dev2 契约冻结）。
- **命令注册**：`database.object.open`（NAVIGATOR，已有）扩展 enablement；无新 scope。

### 4.4 Acceptance Criteria（AC-21A）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-21A-1 | 连接 fixture 数据库后，展开 schema → 出现 **Functions / Sequences** 组（i18n 文案正确）；展开后列出该 schema 全部用户函数（含签名 tooltip）与全部序列 | E2E |
| AC-21A-2 | 展开表节点 → 出现 Columns / Indexes / Constraints / Triggers 四子组；展开 Columns 列出的列名与 `information_schema.columns` 一致（顺序按 attnum）；Indexes 列出该表全部索引（名称与 `pg_indexes` 一致）；Constraints 显示类型前缀（PK/FK/CHECK/UNIQUE）；Triggers 列出触发器 | E2E |
| AC-21A-3 | **双击函数** `add(int,int)` → 打开对象查看器 tab，标题=函数名，正文 DDL 含 `CREATE OR REPLACE FUNCTION add(` 完整定义，属性区显示签名 `(integer, integer)` | E2E |
| AC-21A-4 | **双击序列** `order_seq` → 查看器显示 `CREATE SEQUENCE` DDL + last_value/min/max/increment 属性，属性值与 `SELECT * FROM order_seq` 一致 | E2E |
| AC-21A-5 | **双击索引**（orders 表 name 列索引）→ 查看器 DDL = `pg_get_indexdef` 输出；**双击 CHECK 约束** → `CHECK (...)` 原文；**双击触发器** → `CREATE TRIGGER ... BEFORE UPDATE ON orders ...` | E2E |
| AC-21A-6 | **双击列** `orders.name` → 打开 orders 浏览 tab，结果网格该列头高亮 | E2E |
| AC-21A-7 | **Enter 语义**：导航器聚焦表节点按 Enter = 打开浏览 tab；聚焦函数节点按 Enter = 打开函数查看器；聚焦连接/组（非 openable）按 Enter 无动作 | E2E |
| AC-21A-8 | 单击语义回归：单击表节点**不**打开数据（仅选中）；单击 expandable 表节点展开/收起；选中态高亮正确 | E2E(REG) |
| AC-21A-9 | 表/视图/物化视图双击浏览语义与现状一致（`browse()` 不变），导航器整体行为不回归 | E2E(REG) |
| AC-21A-10 | 懒加载：初始展开 schema 仅请求 5 组（≤5 个 IPC）；展开表才请求其子组；大 schema（≥200 对象）下无逐对象 N+1 | E2E(性能断言) |
| AC-21A-11 | 函数重载：同名不同签名函数各占一个节点（label 相同，tooltip 区分签名），均可分别打开查看器 | E2E |
| AC-21A-12 | 对象查看器 tab 可关闭、可切换；关闭不脏确认（只读无脏状态）；readOnly 连接下查看器正常打开 | E2E |
| AC-21A-13 | 断连后展开已缓存子树：子组数据仍显示（缓存），新展开请求报错显示错误行而非崩溃 | E2E(SAF) |

---

## 5. Slice B：21 项确认菜单 + 导航器对象菜单

### 5.1 用户故事

> 作为从 Navicat 迁移的开发，我要在正确的地方右键得到正确的菜单：工具栏右键能切图标大小/显示文字，表上右键能打开数据、复制名、生成 DDL、删除，函数上右键有 Drop Function，且菜单项按连接状态/权限自动启用或禁用。**[Fact]** 工具栏 Use Big Icons / Show Caption（M17 p.27，context-menus.md Main toolbar 2 行）；数据网格 14 项菜单（M17 p.95-102，context-menus.md Data grid 14 行）；导航器对象菜单官方资料 [UNVERIFIED]，以 [NexTerm] 规格落地（D-B21-4）。

### 5.2 21 项确认菜单逐项核对表

> 来源：`navicat-premium-context-menus.md`（共 24 行；主计划 §6 B21 记为「21 项」，以本表逐项核对为准）。NexTerm 现状 = 2026-08-26 代码审计。

| # | Scope | 菜单项 | 证据 | NexTerm 现状 | 本批处理 |
|---|---|---|---|---|---|
| 1 | Main toolbar | Use Big Icons | [Fact] M17 p.27 | MISSING | **本批落地**（工具栏右键） |
| 2 | Main toolbar | Show Caption | [Fact] M17 p.27 | MISSING | **本批落地**（工具栏右键） |
| 3 | Data grid | Delete Record | [Fact] M17 p.95 | B17 已做（删行+确认） | 维持 + REG |
| 4 | Data grid | Set to Empty String | [Fact] M17 p.95 | B17 已做 | 维持 + REG |
| 5 | Data grid | Set to NULL | [Fact] M17 p.95 | B17 已做（tool-postgres.tsx:1040） | 维持 + REG |
| 6 | Data grid | Generate UUID | [Fact] M17 p.95 | B17 已做（PG uuid 列） | 维持 + REG |
| 7 | Data grid | Filter by field value | [Fact] M17 p.98 | B18 已做（字段值过滤） | 维持 + REG |
| 8 | Data grid | Custom Filter | [Fact] M17 p.98 | B18 已做（自定义过滤） | 维持 + REG |
| 9 | Data grid | Filter & Sort | [Fact] M17 p.98 | B18 已做 | 维持 + REG |
| 10 | Data grid | Copy / Paste | [Fact] M17 p.99 | B17 已做（Copy/Paste+事务） | 维持 + REG |
| 11 | Data grid | Freeze Column | [Fact] M17 p.101 | B18 已做（列冻结） | 维持 + REG |
| 12 | Data grid | Unfreeze All Columns | [Fact] M17 p.101 | B18 已做 | 维持 + REG |
| 13 | Data grid | Set Column Width | [Fact] M17 p.101 | B18 已做（列宽） | 维持 + REG |
| 14 | Data grid | Show Field Type / Show Comment | [Fact] M17 p.102 | B18 已做（Show Field Type/Comment） | 维持 + REG |
| 15 | Data grid | Set Row Height | [Fact] M17 p.101 | B18 已做（行高） | 维持 + REG |
| 16 | Query builder | Remove | [Fact] M17 p.132 | MISSING（B23 范围） | **移交 B23** |
| 17 | Query builder | Remove / Edit Join | [Fact] M17 p.132 | MISSING（B23） | **移交 B23** |
| 18 | Query builder | Add Field To WHERE/GROUP BY/ORDER BY ASC/DESC | [Fact] M17 p.133 | MISSING（B23） | **移交 B23** |
| 19 | Query builder | Zoom In / Out / 100% | [Fact] M17 p.132 | MISSING（B23） | **移交 B23** |
| 20 | ER diagram | Design Foreign Key | [Fact] M17 p.30 | MISSING（B24） | **移交 B24** |
| 21 | ER diagram | Delete Foreign Key | [Fact] M17 p.30 | MISSING（B24） | **移交 B24** |
| — | Navigator | 对象 full menu | [UNVERIFIED] | 部分（connection/relation） | **[NexTerm] 规格落地**（§5.3） |

**本批落地范围**：第 1、2 项（toolbar）+ Navigator 对象菜单（§5.3）。第 3-15 项核对缺口（若 B17/B18 有遗漏则在 B21-B 补齐，以 AC-21B-8 全量核对为准）；第 16-21 项移交。

### 5.3 导航器对象菜单（[NexTerm] 规格，按对象类型启用）

| 对象类型 | 菜单项（按序） | enablement |
|---|---|---|
| 连接（已连接） | Disconnect / New Query / Refresh / ─ / Edit / Delete | Disconnect/New Query/Refresh=connected；Edit/Delete 恒可用 |
| 连接（未连接） | Connect / Edit / Delete | — |
| 表/视图/物化视图 | **Open Data** / Copy Name / **Generate DDL** / Refresh / New Query / ─ / **Drop Table（View/Materialized View）** | Open/DDL/Drop 需 connected；Drop 需 `!readOnly` |
| 函数 | **Open Function**（查看器）/ Copy Name / Generate DDL / Refresh / ─ / **Drop Function** | 同上；Drop Function 需 `!readOnly` |
| 序列 | Open / Copy Name / Generate DDL / Refresh / ─ / Drop Sequence | 同上 |
| 索引 | Open / Copy Name / Generate DDL / Refresh / ─ / Drop Index | 同上（Drop Index 也可在表设计器做，B23 后由设计器入口覆盖，本批保留导航器入口） |
| 约束 | Open / Copy Name / Refresh / ─ / Drop Constraint | 同上 |
| 触发器 | Open / Copy Name / Generate DDL / Refresh / ─ / Drop Trigger | 同上 |
| 列 | Copy Column Name / Refresh / ─ /（Open Data on table） | Copy 需 connected |
| schema/catalog/组 | New Query / Refresh / Copy Schema Name | New Query/Refresh 需 connected |

> 菜单项集合由 provider 声明（D-B21-4）：`tool-postgres.tsx` 内按 `node.objectRole` + `reference.objectKind` 分支返回，enablement 走 `resolveDatabaseCommand`（新增 `database.object.drop` / `database.object.generateDdl` / `database.connection.disconnect` 既有 / `database.toolbar.bigIcons` 等 descriptor）。

### 5.4 Acceptance Criteria（AC-21B）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-21B-1 | **21 项核对完成**：§5.2 核对表 24 行逐项有结论（本批落地/维持/移交），缺口项（若有）在 B21-B 补齐并有证据 | GATE（文档核对）+ 抽样 E2E |
| AC-21B-2 | 工具栏右键 → 菜单含 **Use Big Icons** 与 **Show Caption**；勾选 Big Icons → 主工具栏图标变大（DOM 尺寸断言）；取消恢复 | E2E + VIS |
| AC-21B-3 | **右键表节点** → 菜单项顺序与 §5.3 一致，含 Open Data / Copy Name / Generate DDL / Refresh / New Query / Drop Table；readOnly 连接下 Drop Table 显示为 disabled | E2E |
| AC-21B-4 | **右键函数节点** → 菜单含 Open Function / Copy Name / Generate DDL / Refresh / **Drop Function**；选择 Drop Function → 出现二次确认对话框（显示对象名 `public.add(integer, integer)`）→ 确认 → **函数从导航器树消失**；取消 → 不删除 | E2E(SAF) |
| AC-21B-5 | **右键序列/索引/约束/触发器节点** → 菜单类型正确（§5.3），Drop 后对象从树消失（含确认对话框） | E2E(SAF) |
| AC-21B-6 | **右键列节点** → 菜单含 Copy Column Name；选择 → 剪贴板获得 `public.orders.name`（限定名）或 `name`（裸名，默认限定名） | E2E |
| AC-21B-7 | 断连状态右键表/函数/列 → Drop/Open Data/Generate DDL disabled；Connect/Edit 可用；**导航器菜单不得崩溃或出现空菜单** | E2E(SAF) |
| AC-21B-8 | **Data grid 14 项核对回归**：Set NULL / Set to Empty / Generate UUID / Delete Record / Copy-Paste / Filter by field value / Custom Filter / Filter & Sort / Freeze / Unfreeze / Set Column Width / Show Field Type / Show Comment / Set Row Height 在真实 fixture 上各触发一次成功（B17/B18 行为保持） | E2E(REG) |
| AC-21B-9 | 菜单 enablement 单测：`database.object.drop` 在（connected&&!readOnly&&relation/function/sequence/index/constraint/trigger）为 enabled，其余 disabled/hidden；`database.object.generateDdl` 同规则 | UT |
| AC-21B-10 | Query builder 6 项 / ER 2 项菜单在本批**不存在**（不提前注册空项），台账标记移交 B23/B24 | UT + VIS |

---

## 6. Slice C：对象操作（复制名/刷新/生成 DDL/Drop）

### 6.1 用户故事

> 作为开发，我要对任意对象一键复制它的限定名、一键刷新当前子树、一键把对象的完整 DDL 生成到新查询 tab 里慢慢研究；确认无误后再决定是否 Drop。**[Fact]** 复制名/刷新为 Navicat 导航器对象菜单通用行为（context-menus.md Navigator 行 [UNVERIFIED]，以 [NexTerm] 规格落地）；Drop 破坏性操作二次确认（Master Plan §8 Safety / R5）。

### 6.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| **Copy Name**（全对象类型） | 复制 `schema.objname`（函数含签名 `schema.fn(integer,integer)`；列复制 `schema.table.column`；组/schema 复制 `schema` 或组名）到剪贴板 | [NexTerm]（D-B21-6 同款引号规则沿用 `quoteQualifiedPostgresName`） |
| **Refresh** | 仅刷新右键节点子树（父组/子组重新请求，不刷新整树）；现有整树刷新入口保留 | [NexTerm] |
| **Generate DDL**（表/视图/物化视图/函数/序列/索引/触发器） | 新命令 `postgres_object_ddl` → 新查询 tab（只读，标题=`对象名.ddl`）展示完整 DDL；DDL 失败（权限/不存在）toast 错误并保持 tab 不创建 | [NexTerm]（D-B21-5） |
| **Drop Object**（表/视图/物化视图/函数/序列/索引/约束/触发器） | 二次确认对话框（对象类型+限定名，红色警示）；确认 → `postgres_drop_object` → 成功 → **父节点子树自动刷新**（对象从树消失）+ toast；失败 → toast 错误，树不变 | [NexTerm]（D-B21-6） |
| Drop 护栏 | readOnly 连接禁用；断连禁用；`has_schema_privilege(...,'DROP')` 缺失时返回权限错误 | [NexTerm]（SAF） |

### 6.3 Acceptance Criteria（AC-21C）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-21C-1 | 右键表 `orders` → Copy Name → 剪贴板 = `"public"."orders"`；大写表名 `"Users"` → `"public"."Users"`；列 → `"public"."orders"."name"`；函数 → 含签名 | E2E |
| AC-21C-2 | 右键表节点 → Refresh → 仅该表子组重新请求（网络/IPC 计数断言），树其它部分不刷新 | E2E |
| AC-21C-3 | 表 Generate DDL → 新 tab 打开，内容含 `CREATE TABLE public.orders (` 全列定义 + 约束 + 索引（与 `pg_dump -s -t orders` 单表语义一致，或 `pg_get_*def` 组合——以 cto 定实现） | E2E |
| AC-21C-4 | 视图 Generate DDL → 含 `CREATE OR REPLACE VIEW`；函数 → `CREATE OR REPLACE FUNCTION`；序列 → `CREATE SEQUENCE`；索引 → `CREATE [UNIQUE] INDEX`；触发器 → `CREATE TRIGGER`（各一） | E2E |
| AC-21C-5 | DDL 失败路径：对已被外部 Drop 的对象 Generate DDL → toast 错误、无空 tab 残留 | E2E(SAF) |
| AC-21C-6 | Drop Table：确认对话框显示 `DROP TABLE public.orders` 风险提示 → 确认 → orders 从树消失 → 再 `SELECT` 验证对象确实不存在（数据库侧断言） | E2E(SAF) |
| AC-21C-7 | Drop 取消：确认对话框点取消 → 对象仍在、数据库对象仍在 | E2E(SAF) |
| AC-21C-8 | Drop Function 重载场景：`add(int,int)` 与 `add(int,text)` 并存 → Drop 一个只删一个（签名精确匹配），另一个仍在 | E2E(SAF) |
| AC-21C-9 | readOnly 连接：Drop 入口 disabled；Generate DDL/Copy Name 可用 | E2E(SAF) |
| AC-21C-10 | 无权限用户（fixture 只读角色）：Drop 返回权限错误 toast，树不变 | E2E(SAF) |
| AC-21C-11 | Rust 单测：`postgres_drop_object` 类型→DROP 语句映射全表；SQL 注入（对象名含 `;`/引号）被引号转义安全执行 | RT(SAF) |

---

## 7. B22 User Visible Slice 划分

| Slice | 用户可见能力 | 依赖 | 交付形态 |
|---|---|---|---|
| **A 连接颜色与虚拟分组** | profile 颜色（连接图标/tab 标记着色）+ 连接按组分组渲染 + 组管理（编辑对话框内） | profile schema 扩展（color 列）；loader/导航器连接 root 渲染 | 独立可发布 |
| **B 导入/导出** | 工具箱内连接导入/导出（脱敏 JSON，密码加密）；复用 ConnectionStorageManager | Slice A 的 profile 字段（导出含 color/group） | 独立可发布 |
| **C 批量测试/重连 + 状态语义** | 测试连接（单项/批量矩阵）、断连态 Reconnect、连接状态徽标与只读缓存 | Rust `postgres_test_connection` | 独立可发布 |

---

## 8. Slice A：连接颜色与虚拟分组

### 8.1 用户故事

> 作为 DBA，我要给生产连接一个红色、开发连接一个绿色，把一堆连接按「业务线/环境」分组收进导航器，一眼分清哪些连接属于哪个组，而不是靠名字猜。**[Fact]** 连接 profile 颜色/分组为 Navicat 连接管理标准能力（FM CN-04/CN-06；IN-29 连接 profile 生命周期），具体交互 [UNVERIFIED]，以 [NexTerm] 落地。

### 8.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 连接编辑对话框「常规」页 | 新增「颜色」选择器（无/红/橙/绿/蓝/紫，主题色板）；「分组」文本框（自由输入组名，下拉提示已有组名） | [NexTerm]（D-B22-1/2） |
| 导航器连接 root | 按 `color` 渲染节点图标/标签颜色标记；同一 `group` 的连接在导航器连接列表中连续分组显示（组名头部分隔行） | [NexTerm]（D-B22-1/2） |
| 数据 tab | 连接颜色作为 tab 标题左侧色条标记（同连接打开的 tab 一致） | [NexTerm]（D-B22-1） |
| 组管理 | 组=分组字段值；无独立组管理器；重命名=改分组字段（所有同组连接显示为新组）；删除组=清空该组连接的分组字段 | [NexTerm]（D-B22-2） |

### 8.3 依赖分析

- **存储**：`postgresql-profile-adapter.ts` + `postgres-storage.ts`（+ mysql/sqlite 同构，本批仅 PG 入口验证，SQLite/MySQL 存储字段同步扩展但不做 UI 断言）新增 `color: string | null`；SQLite `postgres_connections` 表新增列——**需 schema 迁移**（`ALTER TABLE ... ADD COLUMN`，老数据默认 NULL，工具列处理逻辑见既有 db.ts 模式）；`group` 字段沿用（无需迁移）。
- **前端**：`tool-postgres.tsx` 导航器连接 root 渲染（颜色/分组头）；连接编辑对话框扩展；`database-navigator.tsx` 连接节点图标支持颜色标记（provider 数据驱动，不写死色值——iconRole 增加 `connection-colored` 或节点带 `tint` 属性，实现由 fe-dev2 定）。
- **无 Rust 改动**（纯前端存储/渲染）。

### 8.4 Acceptance Criteria（AC-22A）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-22A-1 | 编辑连接 A 设置颜色=红、分组=`prod` → 保存 → 导航器 A 连接节点显示红色标记，A 出现在 `prod` 分组头下 | E2E + VIS |
| AC-22A-2 | 另一连接 B 设置分组=`prod` → A、B 在同一组连续显示；设置分组=`dev` → 移到 `dev` 组 | E2E |
| AC-22A-3 | 打开 A 的数据 tab → tab 标题左侧出现与连接色一致的色条 | E2E + VIS |
| AC-22A-4 | 重启动应用 → 颜色/分组持久保留（存储断言 + 重启断言） | E2E |
| AC-22A-5 | 老连接（无 color 字段的历史数据）→ 迁移后加载正常、无颜色、分组为空（NULL 兼容） | RT/UT + E2E |
| AC-22A-6 | 分组字段为空连接 → 显示在「未分组」区，不崩溃 | E2E |
| AC-22A-7 | 颜色选择器仅主题色板选项，无任意色值输入（防主题不一致）；取消保存不生效 | UT + VIS |

---

## 9. Slice B：连接导入/导出

### 9.1 用户故事

> 作为 DBA，我要把本机精心配置的连接（含分组/颜色）打包带走，在另一台机器导入就能用；导出的文件不能明文暴露密码。**[Fact]** Navicat 连接文件导入导出为 FM 级能力（CN-07），专有格式 [UNVERIFIED]，以 [NexTerm] JSON 规格落地。

### 9.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 「连接管理」入口（工具箱工具栏/连接菜单） | 对话框：连接列表 + 全选/多选 + 「导出所选」「导入」按钮 | [NexTerm]（D-B22-3） |
| 导出 | 所选连接 → JSON 文件（`nexterm-connections-<date>.json`）；密码字段 **AES-GCM 加密导出**（沿用 profile 加密方案 encField 语义）；含 color/group/environment 全字段 | [NexTerm]（D-B22-3） |
| 导入 | 选 JSON → 预览（连接名/主机/库/类型，密码掩码显示）→ 合并策略（**追加 / 覆盖同名**，对话框选择）→ 导入 | [NexTerm]（D-B22-3） |
| 导入后 | 刷新导航器连接列表；密码解密失败（密钥不匹配）→ 该项提示重新输入密码或跳过 | [NexTerm] |

### 9.3 Acceptance Criteria（AC-22B）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-22B-1 | 导出 2 个连接（含颜色/分组字段）→ JSON 文件生成；文件内容含 color/group/environment，**密码字段为加密密文非明文**（文件 grep 断言无明文密码） | E2E(SAF) |
| AC-22B-2 | 删除 1 个连接 → 导入该 JSON（追加模式）→ 连接恢复，颜色/分组正确，密码可用（可连接成功） | E2E |
| AC-22B-3 | 覆盖模式：同名连接导入 → 覆盖旧配置（host/密码等更新）；追加模式：同名跳过 | E2E |
| AC-22B-4 | 导入预览：密码显示为掩码（`••••`），无明文泄露 | E2E(SAF) + VIS |
| AC-22B-5 | 非法 JSON / 缺字段文件 → 导入被拒并 toast 明确错误，连接列表无变化 | E2E(SAF) |
| AC-22B-6 | 取消导入 → 无任何连接变更 | E2E |
| AC-22B-7 | Rust/UT：加密导出→解密导入 roundtrip 单测（encField/decField 语义）；篡改文件 → 解密失败路径 | RT/UT(SAF) |

---

## 10. Slice C：批量测试/重连 + 状态语义

### 10.1 用户故事

> 作为 DBA，我要在迁移一批连接前批量测试哪些能连、哪些不行（为什么不行），测试不打断已连接的会话；断掉的连接要能一键重连，并且导航器一眼看出每个连接的连接状态。**[Fact]** 连接 test 为 Navicat 连接管理标准能力（IN-29：test/open/close/reconnect）；批量测试矩阵形态 [NexTerm]。

### 10.2 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 连接菜单「测试连接」 | 单项：临时连接校验 → toast 成功（server version + 延迟 ms）/失败（原因）；**不注册进 clients**、不影响已连接会话 | [NexTerm]（D-B22-4） |
| 「连接管理」对话框「批量测试」 | 多选连接 → 并发测试（≤5）→ 结果矩阵对话框：每行连接名/状态（✓/✗）/原因/耗时；可再次测试失败的 | [NexTerm]（D-B22-4） |
| 断连态 tab | 工作区顶部显示断连横幅 + **Reconnect** 按钮 → 复用 `postgres_connect` 流程重连 → 恢复 | [NexTerm]（D-B22-4） |
| 连接状态徽标 | 导航器连接节点右侧状态点（绿=connected/灰=disconnected/黄=connecting/红=error）；断连后子树保留缓存只读，操作入口按 connected 禁用 | [NexTerm]（D-B22-5） |
| 测试不中断 | 测试进行中，已连接连接照常执行查询 | [NexTerm] |

### 10.3 依赖分析

- **Rust**：新增 `postgres_test_connection(request: PostgresConnectRequest)` → 建立独立连接（`tokio_postgres::connect`，10s 超时）→ `SELECT version(), pg_backend_pid()` → 返回 `{ ok, version?, latencyMs, error? }`；失败返回结构化原因（认证失败/超时/网络不可达）；**不写入 `PostgresState.clients`、不触发 SSH 隧道 pin 变更路径**（沿用既有 connect 路径的 SSH/TLS 配置）。批量并发由前端控制（≤5）。
- **前端**：`tool-postgres.tsx` 连接状态 state 扩展（connecting/error 态 + 原因）；导航器连接节点徽标渲染；Reconnect 按钮接线既有 connect 流程。

### 10.4 Acceptance Criteria（AC-22C）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-22C-1 | 正确配置连接 → 测试连接 → 成功 toast 含 server version（如 `PostgreSQL 16.x`）与延迟；**已连接会话不受影响**（测试前后同连接查询正常） | E2E |
| AC-22C-2 | 错误密码连接 → 测试失败，toast 显示认证失败原因；错误端口 → 连接超时/拒绝原因 | E2E(SAF) |
| AC-22C-3 | 批量测试：2 正常 + 1 错误密码 → 结果矩阵 2 ✓ 1 ✗，失败行原因正确；矩阵对话框可关闭 | E2E + VIS |
| AC-22C-4 | 测试连接**不产生连接记录**：测试后「已连接连接」列表无新增、导航器无新增节点 | E2E |
| AC-22C-5 | 断连（kill fixture 连接/调 disconnect）→ 工作区出现断连横幅 + Reconnect → 点击 → 重连成功，原 tab 数据可刷新 | E2E |
| AC-22C-6 | 导航器连接节点状态徽标：connected=绿点、disconnected=灰点、connecting=黄点（连接中）、error=红点（测试/连接失败） | E2E + VIS |
| AC-22C-7 | 断连后：子树缓存仍可浏览展开（只读），右键 Drop/Open/New Query disabled，Connect/Edit 可用 | E2E(SAF) |
| AC-22C-8 | Rust 单测：`postgres_test_connection` 成功/认证失败/超时三条路径；请求不污染 clients map | RT |

---

## 11. 验收方法代号与测试矩阵

### 11.1 代号（沿用 B19+B20）

| 代号 | 含义 |
|---|---|
| **UT** | vitest 单测（`pnpm test`） |
| **RT** | Rust 单测（`cargo test`） |
| **E2E** | 原生桌面 E2E（WDIO + debug 二进制 + 真实 PG Docker fixture） |
| **(SAF)** | 安全/破坏性护栏断言（注入/权限/二次确认/断连） |
| **(REG)** | 既有行为回归断言（B17/B18/B19/B20） |
| **VIS** | 视觉门禁：dark/light/960×700 + visual spec 截图 |
| **GATE** | 全量回归四件套 + i18n：`pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check` |

### 11.2 测试矩阵（对 Master Plan §8.1）

| 类别 | 必交证据 |
|---|---|
| Unit（UT） | 菜单 descriptor 按对象类型映射、enablement（AC-21B-9）、对象引用解析（getPostgresObjectReference 全类型）、profile color/group 迁移与 roundtrip、导入导出合并策略 |
| Rust（RT） | catalog_search 新 kind 的 SQL 构造、postgres_object_ddl 各类型 def、postgres_drop_object 类型→语句映射 + 注入护栏（AC-21C-11）、postgres_test_connection 三路径（AC-22C-8）、加密导入导出 roundtrip（AC-22B-7） |
| Integration | Tauri IPC × PG fixture：DDL 生成/Drop/对象属性/测试连接全命令链路 |
| Browser 组件 | 对象查看器 tab、连接管理对话框、批量测试矩阵、Drop 确认对话框渲染回归（不构成 parity） |
| 原生 GUI E2E | AC-21A-1..13、AC-21B-2..8、AC-21C-1..10、AC-22A-1..6、AC-22B-1..6、AC-22C-1..7（fixture 见 §11.4） |
| Safety | AC-21A-13、AC-21B-4/5/7、AC-21C-6/7/8/9/10/11、AC-22B-1/4/5、AC-22C-2/7 |
| 视觉门禁（VIS） | §11.5 清单全量截图 + glm5.3 视觉评审记录 |
| 全量回归（GATE） | 四件套 + i18n + B17/B18/B19/B20/终端 E2E 套件 |

### 11.3 用户门禁（2026-08-26，硬性）

1. **每 Slice 门禁**：A/B/C 各 Slice 标记「实现完成」前，对应 AC 的 **E2E 必须在真实页面通过**（WDIO + debug 二进制 + 真实 PG fixture），验证记录随合入提交。
2. **发布门禁**：v2.9.0 发布前，§11.5 全部界面截图（visual spec）+ **glm5.3 视觉评审全通过**；评审结论记录（通过/需改项+重截图）存档；任一截图评审不通过 → 修复后重截图重评审，直至全通过。

### 11.4 E2E fixture（新增）

```sql
-- B21 对象类型全覆盖 fixture
CREATE SEQUENCE order_seq START 100 INCREMENT 5;
CREATE FUNCTION add_numbers(a integer, b integer) RETURNS integer
  LANGUAGE plpgsql AS $$ BEGIN RETURN a + b; END $$;
CREATE FUNCTION add_numbers(a integer, b text) RETURNS text      -- 重载
  LANGUAGE plpgsql AS $$ BEGIN RETURN a || b; END $$;
CREATE TABLE orders (
  id serial PRIMARY KEY,
  name text NOT NULL,
  score numeric,
  CONSTRAINT orders_score_check CHECK (score > 0)
);
CREATE INDEX idx_orders_name ON orders(name);
CREATE UNIQUE INDEX idx_orders_name_unique ON orders(lower(name));
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE "Users" (id int PRIMARY KEY, name text);             -- 大写名验证引号
-- 只读角色（Drop 权限拒绝验证）：CREATE ROLE nexterm_ro LOGIN; GRANT USAGE ON SCHEMA public TO nexterm_ro; ...
```

### 11.5 E2E 用例清单（按对象类型打开/菜单，对应 AC 映射）

| # | 用例 | 覆盖 |
|---|---|---|
| E2E-1 | 展开 schema → Functions/Sequences 组存在且列表正确 | AC-21A-1 |
| E2E-2 | 展开 orders 表 → Columns/Indexes/Constraints/Triggers 子组，列序与 information_schema 一致 | AC-21A-2 |
| E2E-3 | 双击函数 add_numbers(int,int) → 查看器 DDL | AC-21A-3 |
| E2E-4 | 双击序列 order_seq → 查看器 DDL+属性（last_value=100） | AC-21A-4 |
| E2E-5 | 双击索引/CHECK 约束/触发器 → 对应 DDL | AC-21A-5 |
| E2E-6 | 双击列 orders.name → 打开浏览 tab + 列头高亮 | AC-21A-6 |
| E2E-7 | Enter=双击（表/函数/非 openable） | AC-21A-7 |
| E2E-8 | 单击不打开数据、展开/收起、选中态 | AC-21A-8/9(REG) |
| E2E-9 | 函数重载两节点各自打开 | AC-21A-11 |
| E2E-10 | 右键表 → 菜单含 Open Data/Copy Name/Generate DDL/Drop Table（readOnly 下 Drop disabled） | AC-21B-3 |
| E2E-11 | 右键函数 → Drop Function → 确认 → 树消失 + 数据库侧断言 | AC-21B-4, AC-21C-6 |
| E2E-12 | 右键序列/索引/约束/触发器 → Drop → 树消失 | AC-21B-5 |
| E2E-13 | 右键列 → Copy Column Name → 剪贴板 `"public"."orders"."name"` | AC-21B-6 |
| E2E-14 | 工具栏右键 → Use Big Icons 生效 | AC-21B-2 |
| E2E-15 | Data grid 14 项菜单逐项触发（REG） | AC-21B-8 |
| E2E-16 | 表 Generate DDL → 新 tab `CREATE TABLE public.orders` | AC-21C-3 |
| E2E-17 | 视图/函数/序列/索引/触发器 DDL 各一 | AC-21C-4 |
| E2E-18 | Drop 取消不生效；重载函数 Drop 一个留一个 | AC-21C-7/8 |
| E2E-19 | 只读角色 Drop → 权限错误，树不变 | AC-21C-10 |
| E2E-20 | 连接颜色/分组设置与持久化 | AC-22A-1/2/4 |
| E2E-21 | 数据 tab 颜色条 | AC-22A-3 |
| E2E-22 | 连接导出（密文密码）→ 删除 → 导入恢复可连接 | AC-22B-1/2 |
| E2E-23 | 导入预览掩码/非法文件拒绝 | AC-22B-4/5 |
| E2E-24 | 测试连接成功（含 version）；错误密码失败 | AC-22C-1/2 |
| E2E-25 | 批量测试矩阵 2✓1✗ | AC-22C-3 |
| E2E-26 | 断连横幅 + Reconnect 恢复；状态徽标 | AC-22C-5/6/7 |

### 11.6 视觉门禁清单（glm5.3 评审截图对象）

| # | 界面 | 状态 |
|---|---|---|
| V-1 | 导航器树展开态（5 组 + 表四子组 + 六类对象图标）dark/light | 新 |
| V-2 | 对象查看器 tab（函数/序列各一） | 新 |
| V-3 | 导航器上下文菜单（表/函数/列各一，含 disabled 态） | 新 |
| V-4 | Drop 二次确认对话框（危险态） | 新 |
| V-5 | 连接编辑对话框（颜色选择器 + 分组） | 新 |
| V-6 | 导航器连接分组渲染 + 颜色标记 + 状态徽标 | 新 |
| V-7 | 连接管理对话框（导入导出 + 批量测试矩阵） | 新 |
| V-8 | 断连横幅 + Reconnect | 新 |
| V-9 | B17/B18 改动面回归截图（数据网格/过滤对话框，若受本批波及） | REG |
| V-10 | 960×700 小窗全界面 sanity | 每 Slice 末 |

---

## 12. 并行开发文件边界（fe-dev ↔ fe-dev2 防冲突）

> 原则：**每个文件任一时刻只有一个所有者**。沿用 B19+B20 裁定：`tool-postgres.tsx` 归 **fe-dev**；`src/lib/i18n.ts` 归 **fe-dev 独占全程**。`types.ts` 是本批关键契约点（B21 节点类型扩展影响 loader 与 navigator 双方），由 fe-dev2 先冻结契约、fe-dev 消费。

### 12.1 阶段划分（依赖序，非时间估计）

| 阶段 | 内容 | 所有者 |
|---|---|---|
| **P0 契约冻结** | `DatabaseObjectRole/IconRole` 六类扩展 + 节点引用格式（getPostgresObjectReference 返回结构）+ 菜单 descriptor 接口 + Rust 新命令签名（catalog_search 新 kind / object_ddl / drop_object / test_connection）+ profile color 字段迁移方案 | 双方对齐（pm 主持，fe-dev2 起草 types.ts，fe-dev 起草 Rust 签名） |
| **P1 并行** | **fe-dev**：Rust 四组命令 + `postgresql-object-loader.ts`（树扩展/五组/表可展开/子组加载）+ `tool-postgres.tsx`（onOpen 路由、菜单 descriptor、Drop/DDL/复制名接线、断连 Reconnect、批量测试 UI）+ `object-viewer-tab.tsx` + 连接管理对话框组件；**fe-dev2**：`types.ts` 扩展（P0 冻结后落地）+ `database-navigator.tsx`（双击/Enter 语义改造、颜色徽标/分组头渲染、单击语义拆分）+ `postgres-storage.ts`/adapter（color 迁移）+ `command-registry.ts` 新命令 descriptor + i18n 键清单 | fe-dev ∥ fe-dev2 |
| **P2 联调** | fe-dev 接线 fe-dev2 的 navigator 新 API（onDoubleClick/onKeyDownEnter/节点 tint）；fe-dev2 补 navigator 单测与 REG E2E | fe-dev ∥ fe-dev2 |
| **P3 收口** | E2E 全量 / VIS 截图 + glm5.3 评审 / REG / 台账更新（§15） | 共同（qa 主导） |

### 12.2 文件所有权表

| 文件 | P1 所有者 | 说明 |
|---|---|---|
| `src-tauri/src/postgres.rs`、`commands.rs`、`lib.rs`（catalog_search 新 kind / object_props / object_ddl / drop_object / test_connection） | fe-dev | — |
| `src/lib/database/postgresql-object-loader.ts`（树扩展/五组/子组/对象引用解析） | fe-dev | — |
| `src/components/toolbox/tool-postgres.tsx`（onOpen 路由/菜单/操作接线/连接管理） | **fe-dev（全程）** | 沿用裁定 |
| `src/components/toolbox/object-viewer-tab.tsx`（新） | fe-dev | — |
| `src/lib/database/types.ts`（Role/IconRole 扩展） | **fe-dev2** | P0 契约冻结后落地 |
| `src/components/toolbox/database-navigator.tsx`（双击/Enter/单击拆分/徽标/分组头） | **fe-dev2** | — |
| `src/lib/toolbox/postgres-storage.ts`、`postgresql-profile-adapter.ts`（color 迁移） | fe-dev2 | mysql/sqlite 同构字段同步但不做 UI |
| `src/lib/database/command-registry.ts`（新命令 descriptor + enablement） | fe-dev2 | — |
| `src/lib/i18n.ts`（+ locale） | **fe-dev 独占** | fe-dev2 提交键清单 |
| `e2e/desktop/b21-navigator-objects.e2e.ts`（新） | — | fe-dev |
| `e2e/desktop/b21-context-menu.e2e.ts`、`b22-connections.e2e.ts`（新） | — | fe-dev2 |
| `src/lib/__tests__/postgres-object-model.test.ts`（对象引用/菜单 descriptor） | fe-dev | — |
| `src/lib/__tests__/navigator-semantics.test.ts`、`profile-migration.test.ts`（双击/Enter/color 迁移） | fe-dev2 | — |

冲突协调：任何跨边界改动（如 fe-dev 需要 navigator 新 props）→ SendMessage 直连对方 + 任务备注登记，禁止直接改对方文件。**`database-navigator.tsx` 改造与 `postgresql-object-loader.ts` 扩展共享 `DatabaseObjectNode` 结构**，类型契约 P0 冻结后各自并行（loader 只消费类型，navigator 只改渲染）。

---

## 13. 完成定义（DoD）

1. **AC 全量通过**：AC-21A-1..13、AC-21B-1..10、AC-21C-1..11、AC-22A-1..7、AC-22B-1..7、AC-22C-1..8（共 56 项）按 §11 代号验证留档；**每个 Slice 的实现完成标记前 E2E 真实页面通过（用户门禁①）**。
2. **21 项菜单核对闭环**：§5.2 核对表 24 行全部有结论，缺口补齐或移交登记（B23/B24）完成。
3. **导航器零回归**：表/视图/物化视图双击浏览、选中态、过滤行为与 B20 前一致（AC-21A-8/9）。
4. **破坏性操作安全**：Drop 全路径二次确认 + readOnly/权限拒绝 + 审计（AC-21C-6..10 SAF）。
5. **连接数据安全**：导入导出密码密文、导入预览掩码、篡改拒绝（AC-22B SAF）。
6. **视觉门禁（用户门禁②）**：§11.6 清单全量截图 + glm5.3 视觉评审全通过，评审记录存档。
7. **GATE 全绿**：`pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check`。
8. **台账更新**（合入 main 后同步）：`navicat-parity-master-plan.md` §6（M2 B21/B22 状态 + §2.2 Scorecard + B23/B24 归属调整）、`navicat-premium-context-menus.md`（NexTerm 列 + 状态）、`navicat-premium-interactions.md`（IN-01/02/03/07/29）、`navicat-premium-feature-matrix.md`（CN-04/06/07）、`database-development-status.md`、CHANGELOG（Unreleased → v2.9.0）、AGENTS.md。

---

## 14. 与 v2.9.0 发布的关联（收官 M2）

| 项 | 说明 |
|---|---|
| 里程碑 | M2「对象与设计」用户裁定收窄为 **B21+B22**（设计器 B23 / ER B24 顺延，产品在 master-plan §6 登记归属）；B17/18/19/20 已合入（M1 v2.8.0） |
| 版本 | 本批合入 main + 台账/CHANGELOG 更新后，M2 冻结 → `pnpm run version:minor` 发 **v2.9.0** |
| 发布门禁 | 全量 GATE + 受影响 E2E（含 B17-B20 套件补跑）+ **视觉门禁（visual spec 截图 + glm5.3 评审全通过）** + 五方发布评审；打包验证不强制（2026-08-26 用户决策沿用） |
| 发布内容叙事 | 「NexTerm 数据库工具箱导航器达到 Navicat 级对象覆盖：函数/序列/索引/约束/触发器/列全量入树，按对象启用的确认菜单与 DDL/Drop 操作，连接颜色/虚拟分组/导入导出/批量测试」 |
| 不含 | B23 表设计器 / B24 ER / B25+（下一里程碑）；AI/BI/Collab（产品排除） |

---

## 15. 风险与开放问题

| # | 风险/问题 | 等级 | 缓解 / 决策 |
|---|---|---|---|
| R-B21-1 | **树结构影响面**：表/视图/物化视图由叶子改可展开、单击语义拆分（select/toggle/open 三合一拆开），触及共享 navigator 渲染与既有 E2E 断言 | 高 | P0 冻结节点结构与导航器 props 契约；单击/双击/Enter 语义用单测固化（navigator-semantics.test.ts）；AC-21A-8/9 + B17-B20 REG 套件把关；`database-navigator.tsx` 单所有者（fe-dev2），避免双写 |
| R-B21-2 | **21 项缺口评估**：24 行中 data grid 14 项依赖 B17/B18 已实现质量；若存在未覆盖项需临时补做，挤占本批 | 中 | §5.2 核对表先行（P0 完成），缺口逐项进 B21-B 范围并加 AC；已做项以 AC-21B-8 全量 REG 兜底 |
| R-B21-3 | 导航器对象菜单本身 [UNVERIFIED]，逐对象菜单集合为 [NexTerm] 决策，存在与 Navicat 实际行为偏差风险 | 中 | 文档明确标注 [NexTerm]；不声称 parity；菜单集合按 21 项证据驱动 + 常用操作（Open/Copy/DDL/Drop/Refresh）收敛，避免臆造菜单项 |
| R-B21-4 | 表子组加载新增 IPC（每表最多 4 组查询），大库多表展开性能 | 中 | 懒加载（AC-21A-10 性能断言）；子组按需请求；catalog_search 单查询复用（index/constraint/trigger 合并为一次 `pg_catalog` 查询，实现由 cto 定） |
| R-B21-5 | Drop/DDL 依赖 `pg_get_*def` 系列函数，老版本 PG（<9.2）缺部分函数 | 低 | fixture 固定 PG16；RT 覆盖缺失函数错误路径 → toast 明确错误；产品最低支持版本声明沿用现状 |
| R-B22-1 | profile schema 迁移（color 列）涉及 SQLite 表结构变更与老数据兼容 | 中 | 既有 db.ts 迁移模式沿用（`ALTER TABLE ADD COLUMN` + NULL 兼容）；AC-22A-5 老数据回归；RT 覆盖迁移 |
| R-B22-2 | 批量测试并发连接可能触发服务器 max_connections / SSH 隧道并发压力 | 中 | 前端并发上限 5（D-B22-4）；超时 10s 硬上限；RT 验证请求不污染 clients map |
| R-B22-3 | 连接导出 JSON 若被篡改（密码密文 + 其余字段）导入行为需安全 | 低 | 全字段 schema 校验 + 解密失败跳过提示（AC-22B-5/7）；不执行导入文件内任何 SQL |
| R-B21/22-4 | fe-dev/fe-dev2 在 `DatabaseObjectNode` 结构上交叉（loader 消费、navigator 渲染），契约漂移风险 | 中 | P0 契约冻结 + 单测互锁；loader 新增字段若变更必须经 fe-dev2 确认并更新 navigator 渲染 |
| O-1 | 函数节点是否展示参数个数/类型徽标（Navicat 展示 [UNVERIFIED]） | 开放 | 本批 label=proname + tooltip 签名；视觉评审后按结论调整（轻量） |
| O-2 | 序列「查看器」是否需要额外命令（nextval/重置值） | 开放 | 本批只读展示（DDL+属性）；B23 设计器阶段评估可写操作 |
| O-3 | 连接导出是否纳入「全配置导出」（含终端/偏好） | 开放 | 本批仅连接级（复用既有 ConnectionStorageManager）；全配置导出已存在（config-export-import.ts），本批不动其行为 |
| O-4 | 断连后自动重连（autoReconnect）是否纳入 DB 工具箱 | 开放 | 本批明确**不做**（D-B22-5，防范围蔓延）；若用户反馈则立专项 |

---

## 附：B21+B22 命令注册清单（command-registry 新增，P0 冻结）

```
database.object.open            NAVIGATOR   扩展 enablement（六类对象 openable）
database.object.drop            NAVIGATOR   B21-C（connected && !readOnly && 支持类型）
database.object.generateDdl     NAVIGATOR   B21-C（connected && 支持类型）
database.object.copyName        NAVIGATOR   全对象类型
database.connection.disconnect  NAVIGATOR   既有
database.connection.test        NAVIGATOR   B22-C（单项测试）
database.connection.batchTest   NAVIGATOR   B22-C（批量矩阵）
database.connection.import / export  NAVIGATOR  B22-B
database.toolbar.bigIcons / showCaption  WORKSPACE  B21-B（toolbar 右键）
```

**Rust IPC 新增/变更（fe-dev，P0 契约冻结）**：

```
postgres_catalog_search   变更（新增 index/constraint/trigger 三个 kind；sequence 处理：新增 kind 或 relkind='S'，cto 定）
postgres_object_props     新增（对象查看器属性：函数签名/序列属性/DDL）
postgres_object_ddl       新增（生成 DDL，pg_get_*def 组合；AC-21C-3/4 行为验收）
postgres_drop_object      新增（DROP 类型映射 + 引号转义 + 权限检测；AC-21C-6..11 验收）
postgres_test_connection  新增（临时连接校验，不写 clients map；AC-22C-1/2/4/8 验收）
```
