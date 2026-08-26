# B21 导航器对象全覆盖 + B22 连接管理 架构约束（实现前）

> 作者：architect（高见远）｜2026-08-26
> 适用：v2.9.0 冲刺 B21（导航器对象全覆盖 + 21 项确认菜单）/ B22（连接管理：颜色/虚拟分组/导入导出/批量测试重连）实现前**架构约束**。fe-dev（Rust + 导航器组件）/ fe-dev2（连接管理 UI + 导入导出）照做即可。
> 依据：`navicat-parity-master-plan.md` §6 M2 B21/B22 条目、§7.4 操作习惯（导航器：单击选择、双击打开、Enter 同双击、右键上下文菜单）、D2 scope 路由、D3（菜单由 provider 声明）、`navicat-premium-context-menus.md`（21 项确认菜单 + UNVERIFIED 协议）；现状代码（下述 §0 盘点）；B17 AlertDialog 确认模式先例（tool-postgres.tsx:1930）；B20 `command-registry.ts`（scope/enablement 体系）。
> 性质：**只读评审产出**，本文不改动产品代码。每条均为明确决策，编号 D-B21-x / D-B22-x。冲突消解优先级：安全红线文档 > 本文 > 各实现计划。

---

## 0. 现状盘点（2026-08-26 工作区代码核实）

### 0.1 导航器树现状

| 项 | 位置 | 现状 |
|---|---|---|
| 对象加载 | `postgresql-object-loader.ts` `loadPostgresNavigatorChildren` | 四层：connection → catalog(数据库) → schema → 3 个 group（tables/views/materializedViews）→ object。**懒加载**（展开时按节点加载，tool-postgres.tsx:1001 `treeToggle`） |
| 树渲染 | `database-navigator.tsx` `DatabaseNavigator` | **单击即同时触发 select + toggle + open**（:100-106 `onClick` 三连）——无双击/Enter 区分，B21 必须修正为"单击选择、双击打开、Enter 同双击"（§7.4） |
| 节点模型 | `types.ts` | `DatabaseObjectNodeKind` = connection/catalog/schema/group/object；`DatabaseObjectRole` = relation/table/view/materializedView；`iconRole` 同枚举 + connection/catalog/schema/group |
| 节点 id | `object-identity.ts` `createDatabaseObjectNodeId` | `database://<provider>/<connId>/connection:<id>/catalog:<db>/schema:<schema>/group:<tables>/object:<name>`，segments 为 `kind:encodeURIComponent(value)`，确定性、可 decode |
| 对象引用 | `postgresql-object-loader.ts` `getPostgresRelationReference` | 仅解 `path.length===5 && objectRole∈{table,view,materializedView}`；reference.path[5]=objectRole |
| 菜单挂载 | `database-navigator.tsx` :96-129 + tool-postgres.tsx:1606 `renderContextMenu` | 每节点一个 ContextMenu；`renderContextMenu` 已按 node.kind 分支（connection → 连接菜单；其余 → 对象菜单），菜单项 enablement 已走 `resolveDatabaseCommand`（B20 体系） |
| 双击打开 | tool-postgres.tsx:1602 `onOpen` | 仅 `getPostgresRelationReference` 命中时 `browse(relation)` 打开数据网格 tab；对象 tab 类型仅 `table`/`query` |
| 图标 | database-navigator.tsx `nodeIcon` | connection/catalog/schema/group/relation/table/view/materializedView 七个 iconRole，无函数/序列/索引/约束/触发器/列图标 |

### 0.2 后端 catalog 现状

- `postgres_catalog_search`（postgres.rs:2216）：`request.kind` 白名单 relation/column/function/type；relation 只查 `relkind IN ('r','v','m','p')`（:2231）；**为补全设计**：LIMIT 1..100、`ILIKE $prefix%`。导航器需要的是**整组全量 + 精确 schema**，语义不匹配。
- `postgres_catalog_schemas`（postgres.rs:2194）：schema 列表，白名单 `NOT LIKE 'pg_%' AND <> 'information_schema'`。
- 无 DDL 预览命令；无对象属性命令；无批量连接测试命令。
- 连接客户端在 `PostgresState.clients: HashMap<String, Arc<Client>>`（postgres.rs:38），`postgres_connect` 会进 map；无"仅探测不驻留"的路径。

### 0.3 连接配置现状

- `PostgreSQLConnectionProfile`（postgresql-profile-adapter.ts:40）：已有 `group?: string`（虚拟分组字段已存在但 UI 未用）、`environment`、`providerConfig`。**无 color 字段**。
- 持久化：`postgres_connections` 表（postgres-storage.ts），敏感字段逐字段 `encField`（AES-GCM，app-lock key）——password/sslClientKey/sslKeyPassphrase/sshPassword/sshPrivateKey/sshPrivateKeyPassphrase 六类密文入库。
- 全量配置归档：`config-export-import.ts` `exportAllConfig`/`importAllConfig` 是**明文本地 ZIP**（含所有工具箱数据 + postgresConnections 明文 profile）——**这是全量备份，不是 B22 的连接专用导入/导出**；且含明文凭据，依赖 app-lock 验证。

### 0.4 21 项确认菜单归属盘点（navicat-premium-context-menus.md）

| 归属 | 项 | 状态 |
|---|---|---|
| Data grid scope | Delete Record / Set NULL / Set Empty / Generate UUID / Filter by field value / Custom Filter / Filter & Sort / Copy/Paste / Freeze Column / Unfreeze All / Set Column Width / Show Field Type / Show Comment / Set Row Height | B17-B18 已实现大部分（Copy/Paste 部分）；**B21 不重复** |
| Query builder / ER diagram | Remove / Edit Join / Add Field To… / Zoom / Design/Delete FK | B23/B24 批次 |
| **Navigator scope** | connection/database/schema/table/view/function/procedure/sequence/trigger/index/query/… 的 full object menu | **UNVERIFIED**（手册无逐项证据）——B21 按"功能优先保守菜单"实现并登记验证协议，不发明手册外命令、不声称 parity |

---

## 一、B21 对象类型扩展架构

### 1.1 对象节点模型（六类入树方案）

**D-B21-1（分组结构：两级对象组，沿用现有 group 机制）**：不引入新节点 kind，扩展现有 `group` 的 value 枚举。schema 下新增 **2 个 schema 级组**；表/视图/物化视图展开后新增 **4 个表级组**（Navicat 层级对齐）：

```
schema
 ├─ tables ─ table ─ columns ─ column          （表级组：columns/indexes/constraints/triggers）
 │                ├─ indexes  ─ index
 │                ├─ constraints ─ constraint
 │                └─ triggers ─ trigger
 ├─ views ─ view ─ columns ─ column             （视图仅展开 columns）
 ├─ materializedViews ─ materializedView ─ columns ─ column
 ├─ functions ─ function                        （schema 级新组，对象不展开）
 └─ sequences ─ sequence                        （schema 级新组，对象不展开）
```

- **表/视图/物化视图 `expandable` 由 false 改 true**（现有 object 节点 :236 硬编码 false）。展开动作只构建 4 个 group 子节点（或视图仅 columns 组），**不发 DB 查询**（组节点是纯静态结构，对象查询下放到组展开时）。
- 组 value 命名即对象角色，与现有 `tables→table` 约定同构：`functions`/`sequences`/`columns`/`indexes`/`constraints`/`triggers`。**禁止新增 `DatabaseObjectNodeKind`**（保持 connection/catalog/schema/group/object 五元组稳定）。

**D-B21-2（角色与图标扩展）**：
- `DatabaseObjectRole` 增加 `"function" | "sequence" | "index" | "constraint" | "trigger" | "column"`（原 relation/table/view/materializedView 保留）。
- `DatabaseObjectIconRole` 增加同名六值；`database-navigator.tsx` `nodeIcon` 补六个图标映射（Function/Files/ListOrdered/GitBranch/ToggleLeft/Column 或等价 lucide 图标），**group 图标沿用现有 Table2 视觉**（可细分但不强制，避免无调用方抽象）。
- `objectRole` 由**父 group 决定**（现有约定）：`group==="functions"→function` 等，与 `postgresql-object-loader.ts:206` 的 `relationRole` 模式同构。**对象节点 `reference.path` 末尾追加 objectRole 字符串**（沿用现有 `[...schema, relation, objectRole]` 的 5 段→六类对象为 `[...schema, group, name, objectRole]`，仍 5 段，`getPostgresRelationReference` 只认前 3 段 + name 时即兼容——见 D-B21-4）。

**D-B21-3（节点 id 方案）**：沿用 `createDatabaseObjectNodeId`，无 id 格式变更：
- schema 级新组：`.../group:functions`、`.../group:sequences`（与现有 group:tables 同构）。
- 表级组：`.../object:<table>/group:columns` 等（parent 为 object 节点，group segment 前移一层）。
- 六类对象：`.../group:<group>/object:<name>`；**函数重载**（同名多签名）唯一性约束：`name` 编码为 `proname(identity_args)`（identity args 来自现有 `pg_get_function_identity_arguments`），**label 仍显示 proname**、签名放 `reference.path` 或属性面板，避免重载冲突与列表重复感。
- 列对象：`.../object:<table>/group:columns/object:<attname>`，**attnum 不进 id**（id 确定性要求；列顺序由查询 `ORDER BY a.attnum` 保证，属性面板展示序号）。

### 1.2 数据加载

**D-B21-4（新增 `postgres_catalog_objects` 命令，不扩展 `postgres_catalog_search`）**：
- 理由：`catalog_search` 是补全命令（LIMIT 1..100 + `ILIKE prefix` + 三元组语义），导航器需要"整组全量 + 精确 schema"。复用会污染补全语义且带 limit 隐患；按 master plan R1（新 DB 命令按域分文件，不继续堆叠 `commands.rs` 4637 行债务），新命令**落在 `postgres.rs` 新增 `postgres_catalog.rs` 模块**（catalog 域）并注册到 `lib.rs` invoke_handler。
- 命令签名（白名单化，kind 枚举即白名单）：

```rust
#[tauri::command]
pub async fn postgres_catalog_objects(
    request: PostgresCatalogObjectsRequest, // { connectionId, kind, schema, relation? }
    state: tauri::State<'_, PostgresState>,
) -> Result<Vec<PostgresCatalogObject>, String>
// kind ∈ { functions, sequences, indexes, constraints, triggers, columns }
// PostgresCatalogObject { kind, schema, name, signature?, relationKind?, dataType?, ordinal? }
```

- 六类 catalog 查询设计（全部参数化、`has_schema_privilege` 白名单、`NOT pg_%` schema 由上层保证）：

| kind | 查询要点 |
|---|---|
| functions | 复用 search 同款（pg_proc + `pg_get_function_identity_arguments`），**去 LIMIT/去 ILIKE**，`ORDER BY p.proname`；返回 signature 供重载 id 编码 |
| sequences | `pg_class c JOIN pg_namespace n ... WHERE c.relkind='S' AND has_schema_privilege(n.oid,'USAGE') AND ($1::text IS NULL OR n.nspname=$1) ORDER BY c.relname` |
| indexes | 需要 `relation` 参数：`pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_class tc ON tc.oid=i.indrelid JOIN pg_namespace n ON n.oid=tc.relnamespace WHERE n.nspname=$1 AND tc.relname=$2 AND has_schema_privilege(...)`，返回 indexrelid 名称（待 indexdef 预览） |
| constraints | `pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND has_schema_privilege(...)`，返回 `conname + contype::text` |
| triggers | `pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND NOT t.tgisinternal AND has_schema_privilege(...)` |
| columns | 复用 search 同款查询，**去 LIMIT/去 ILIKE**，`ORDER BY a.attnum`，返回 `format_type(a.atttypid,a.atttypmod)` + `attnotnull` + `atthasdef`（属性面板用） |

- **安全护栏**：全部沿用参数化绑定（安全基线 §4.3.1）；`kind` 非法直接 `Err`（白名单即拒绝）；`columns` 缺 `relation` 报错（与 search:2235 同语义）；所有查询走 `QUERY_TIMEOUT`。

**D-B21-5（懒加载决策：保持逐级懒加载，不引入全量）**：
- 现状 treeToggle 懒加载已就绪，B21 只加层级（schema→5 组、object→表级组、表级组→对象），**零全量预取**。理由：pg_catalog 全量拉取（尤其 columns）在大型库上显著放大首屏成本；懒加载与现有 `navigatorChildren`/`loadStates` 状态模型零冲突。
- 组节点（functions/sequences/columns/...）构建**不触发 DB 调用**（纯静态），DB 调用仅发生在组节点展开时——与现有 tables 组行为一致。
- 列顺序：`ORDER BY a.attnum`（物理序），属性面板 + DDL 预览均按此展示。

### 1.3 双击/Enter 语义矩阵

**D-B21-6（单击/双击语义修正，改 `database-navigator.tsx`）**：`onClick` 三连改为：单击 = `onSelect`（+ 展开/折叠 toggle 仅对可展开节点保持）；**双击 = `onOpen`**；**Enter = `onOpen`**（聚焦节点上 keydown Enter）。具体：
- button 加 `onDoubleClick`（可展开节点双击仍先走 onClick 的 toggle——**Navicat 习惯：双击 group 展开/收起，双击 object 打开**；故 `onClick` 保留 toggle、移除 open，`onDoubleClick` 调 open，`onKeyDown Enter` 调 open）。
- 与 B20 scope-router（`[data-scope="navigator"]`）兼容：Enter 处理前先确认 scope（导航器聚焦时接管 Enter，其余放行）。

**D-B21-7（打开语义矩阵：六类对象 → 只读属性面板 tab；表/视图保持数据网格）**：

| 对象 | 双击/Enter 打开 | 实现载体 |
|---|---|---|
| table | 数据网格（现状 browse 不变） | 现有 table tab |
| view / materializedView | 数据网格（现状 browse 不变） | 现有 table tab |
| function | 属性面板 tab：签名 + DDL（`pg_get_functiondef`）+ 基础元数据（返回类型/易变性） | 新 tab 类型 `"object"` |
| sequence | 属性面板 tab：类型 + 当前值/步长/上下界 + 构造 DDL | 新 tab 类型 `"object"` |
| index | 属性面板 tab：索引列 + 唯一性 + `pg_get_indexdef` | 新 tab 类型 `"object"` |
| constraint | 属性面板 tab：contype 分类 + 涉及列 + `pg_get_constraintdef` | 新 tab 类型 `"object"` |
| trigger | 属性面板 tab：触发时机/事件/函数 + `pg_get_triggerdef` | 新 tab 类型 `"object"` |
| column | 属性面板 tab：类型（format_type）/可空/默认/位置 | 新 tab 类型 `"object"` |

- 新 tab 类型 `"object"`（`WorkspaceTab` 联合类型扩展）：`{ type:"object", object:{ schema, name, objectRole, group, signature? } }`，渲染组件 `database-object-properties.tsx`（新文件，fe-dev 范围）。**B23 设计器批次再把表/视图/函数等接设计器，属性面板作为通用底座保留**。
- 属性面板与"对象属性只读"定位一致：B21 **不做编辑**（编辑 = B23 设计器），只读 DDL 预览 + 元数据表格。

### 1.4 DDL 预览

**D-B21-8（新增 `postgres_object_ddl` 命令，系统函数白名单）**：`{ connectionId, objectType, schema, name, signature? }` → DDL 文本。按 objectType 白名单分发：

| objectType | 系统函数 |
|---|---|
| view / materializedView | `pg_get_viewdef(oid)`（`c.relkind='v'/'m'`） |
| function | `pg_get_functiondef(oid)`（需 `proname + identity_args` 定位 oid，重载按签名精确匹配） |
| index | `pg_get_indexdef(oid)` |
| constraint | `pg_get_constraintdef(oid)` |
| trigger | `pg_get_triggerdef(oid)` |
| sequence | 无系统函数 → 用 `pg_sequences` + `pg_sequence` 构造 `CREATE SEQUENCE ...`（**实现按"构造 + 显式标注"处理，不冒充系统函数输出**） |
| column | 无系统函数 → `format_type` 组合 `ADD COLUMN` 片段，属性面板展示 |

- oid 定位统一走 `pg_class/pg_proc/pg_constraint/pg_index/pg_trigger` 按 `schema+name(+signature)` 查，**参数化 + `has_*_privilege` 门禁**，未命中返回"对象不存在"错误。
- 本命令与 D-B21-4 的 `postgres_catalog_objects` 同放 `postgres_catalog.rs` 模块（catalog 域）。

### 1.5 21 项确认菜单组织

**D-B21-9（菜单组织：对象级菜单按 objectRole 分支，Data grid 21 项不动）**：
- `renderContextMenu`（tool-postgres.tsx:1606）保持单一挂载点，分支从 `node.kind` 细化为 `node.kind + node.objectRole`：
  - connection → 现有连接菜单（+ B22 增加"测试连接/重连"项，见 §二）。
  - object + table → 打开数据 / 复制名 / 刷新 / **删除（Drop，AlertDialog）** / 设计表（B23 占位 disabled）。
  - object + view/materializedView → 打开数据 / 复制名 / 刷新 / **删除**。
  - object + function/sequence/index/constraint/trigger/column → 属性 / 复制名 / 刷新 / **删除（仅 schema 级对象 functions/sequences 开放，表级对象删除 = 走表删除，不单独 Drop）**。
  - group / schema / catalog → 刷新 / 新建查询（现状保留）。
- **菜单项 enablement 全部走 `resolveDatabaseCommand`**（B20 既有模式，tool-postgres.tsx:1613 已就绪），新命令注册见 §四。
- **导航器 full object menu 为 UNVERIFIED**（context-menus.md:28）：B21 实现"功能优先保守集"（Open/属性、Copy Name、Refresh、Drop），**在 `navicat-premium-context-menus.md` 对应行登记为"PARTIAL（功能优先）"**，不把手册未证实的"Design/Query 对象"等项当作已实现菜单——遵守 UNVERIFIED 验证协议。

**D-B21-10（破坏性操作确认模式：沿用 B17 AlertDialog）**：
- 所有 Drop/Delete（连接删除、对象 Drop、后续批次的表删除）**统一走 AlertDialog 二次确认**（B17 先例：tool-postgres.tsx:1930 `deleteTarget` state + `AlertDialogAction`）。
- 对象 Drop 确认文案必须含**限定对象名**（`DROP TABLE "schema"."table"` 预告形态），readOnly 连接下 Drop 菜单项 disabled。
- **B21 Drop 实现边界**：仅"连接删除"（已存在）+ 导航器对象 Drop 的命令/确认框架。**实际 Drop 的 SQL 执行命令（`postgres_object_drop`）也在 B21 实现**（参数化 + `DROP <TYPE> IF EXISTS` 白名单类型 + readOnly 拒绝），但表级对象的 Drop 菜单项 disabled（表删除语义归数据网格/表设计器）。

---

## 二、B22 连接管理架构

### 2.1 连接颜色 / 虚拟分组

**D-B22-1（存储模型：扩展 profile 字段，不建独立元数据）**：
- `PostgreSQLConnectionConfig` 增加 `color?: string`（hex，`#RRGGBB`），`group` 复用现有 `group?: string`（profile-types.ts:9 已存在）。
- 理由：连接元数据与连接同生命周期，SQLite `postgres_connections` 表加 `color` 列即持久化（postgres-storage.ts `toRow/fromRow` 同步加列，`group` 已有 `group_name` 列）；**不建虚拟分组独立表**（Navicat 虚拟分组是连接列表展示层概念，无独立实体需求）。
- 迁移：`fromRow` 对缺失列宽容（`str(row.color)` 天然 undefined 兼容），**无 schema 迁移版本号需求**（row_upsert 动态列）。

**D-B21-11 已并入 D-B22-1（颜色/分组影响导航器渲染）**：

**D-B22-2（导航器渲染：虚拟分组容器 + 颜色指示）**：
- 连接根节点聚合：`navigatorRoots`（tool-postgres.tsx:383）改为按 `profile.group` 分组——有 group 的连接生成 **group 容器节点**（复用 `kind:"group"` + `iconRole:"group"`），无 group 的进"未分组"组（Navicat 行为）。连接节点作为容器子节点。
- **虚拟分组容器 id 约定**：`createDatabaseObjectNodeId` 要求 connectionId，约定虚拟容器用 `connectionId="virtual"`、`path=[{kind:"group",value:<groupName>}]`（与 schema 组 `group:<name>` 同构，前缀不冲突——虚拟分组在 path[0]，schema 组在 path[3]）。
- 连接节点（`createConnectionNode`）增加 `color` 指示：节点图标前渲染 8px 色点（hex）；未设置色 → 不渲染。**颜色为纯展示**，不进入 DatabaseObjectNode 契约（`iconRole` 不变），由 loader 在构建连接节点时附加（可用 `DatabaseObjectNode` 扩展可选 `accentColor?` 或由 tool-postgres 层映射——**选后者：共享 Navigator 组件不感知 provider 颜色**，在 `tool-postgres.tsx` 的 `renderContextMenu`/节点包装处映射，避免污染共享契约）。
- 排序：组内连接按 name 排序；未分组组固定排最后。

### 2.2 连接导入 / 导出

**D-B22-3（格式：连接专用 JSON 单文件，独立于全量 ZIP 归档）**：
- 文件 `nexterm-connections.json`，结构：

```jsonc
{
  "format": "nexterm-connections",
  "version": 1,
  "exportedAt": "<ISO>",
  "credentialsEncrypted": false,        // true 时 secrets 为 {enc, iv, salt, algo:"AES-GCM", rounds} 包裹
  "connections": [ /* PostgreSQLPersistedProfile 数组（toPostgreSQLPersistedProfile 序列化） */ ]
}
```

- 复用 `toPostgreSQLPersistedProfile`/`adaptPostgreSQLPersistedProfile`（postgresql-profile-adapter.ts:103/:79）做 profile ⇄ 持久化形状互转，**不发明第三套形状**。
- 路径：前端 `save`/`open`（tauri-plugin-dialog），默认名 `nexterm-connections.json`。
- **不碰 `config-export-import.ts`**（那是全量 ZIP 备份，含全部工具箱域 + 明文凭据，B22 不扩展它；两者并存，B22 文档说明区别）。

**D-B22-4（凭据加密决策：默认脱密导出，可选口令加密，禁止明文密码导出）**：
- **默认：导出不含密码**——`connections[].password/sshPassword/sshPrivateKey/sshPrivateKeyPassphrase/sslClientKey/sslKeyPassphrase` 置空，导入后连接需重新填凭据（Navicat 导入连接默认也需重输）。符合安全基线（日志禁打密码、凭据 AES-GCM 基线）。
- **可选：导出时勾选"加密凭据"**——输入口令，凭据字段用 `AES-GCM`（复用 `vault-crypto.ts` 的 `encryptPayload` 模式，口令经 PBKDF2 派生 key）加密为 `{enc, iv, salt}` 对象，`credentialsEncrypted: true`；导入时若检测到该标记则提示输入口令解密，失败则仅导入非凭据字段。
- **禁止**明文密码导出选项（基线红线）。

**D-B22-5（导入语义：merge/替换选择，沿用 ZIP 归档先例）**：导入对话框提供"合并（按 id 覆盖）/ 替换全部"二选一，复用 `mergeById` 语义（config-export-import.ts:215）；id 冲突在合并模式按导入侧覆盖。

### 2.3 批量测试 / 重连

**D-B22-6（编排：Rust 批量探测命令 + 并发信号量，不进 clients map）**：
- 新增 `postgres_test_connections`：`requests: Vec<PostgresConnectRequest>` → `Vec<{ connectionId, ok, latencyMs?, error? }>`。
  - 每个请求独立建连（复用现有 connect 逻辑，CONNECT_TIMEOUT=10s）→ 执行 `SELECT 1`（QUERY_TIMEOUT）→ 立即断开，**不注册进 `PostgresState.clients`**（纯探测，无残留会话）。
  - 并发控制：`tokio::sync::Semaphore(4)`（上限 4 并发）；整体超时 60s；失败项记 `error` 原文（不含凭据）。
  - 白名单字段只读（`read_only` 恒强制 true 探测语义），安全护栏同 `postgres_connect`（SSH/TLS/指纹 fail-closed 全走通）。
- 重连 = 前端编排：对测试失败的连接 `postgres_disconnect`（清理脏状态）→ 逐项 `postgres_connect`；批量连接仍走**现有单连接 connect**（无批量 connect 命令），避免客户端 map 的并发状态复杂度（B19 M2 遗留 txn 互斥不触碰）。

**D-B22-7（状态语义）**：前端模型：

```ts
type ConnectionTestState = "idle" | "testing" | "success" | "failed";
// per connection id，存于 ToolPostgres 或连接管理对话框局部 state
```

- 连接列表 + 导航器连接节点渲染状态指示：testing=spinner、success=绿色点、failed=红色点（与 D-B22-2 颜色点不冲突：状态点恒有，颜色点可选）。
- 测试结果**不持久化**（会话级状态）；重连成功后状态复位为 idle（或直接 connected 视觉）。
- **B22 连接管理 UI 载体**：新 `postgres-connection-manager.tsx`（对话框：连接列表 + 颜色/分组编辑 + 批量测试/重连 + 导入/导出入口），入口放连接右键菜单（"连接管理器"项）+ 导航器头部 + 图标。

---

## 三、文件边界（fe-dev / fe-dev2 切分）

> 原则：**Rust 与导航器树 = fe-dev；连接管理 UI 与导入导出 = fe-dev2**；共享类型由 fe-dev 先行定义，fe-dev2 消费。禁止双方同时改同一文件（列出者为准）。

| 文件 | 归属 | 改动 |
|---|---|---|
| `src-tauri/src/postgres.rs` | fe-dev | 拆 `postgres_catalog.rs` 子模块（D-B21-4 `postgres_catalog_objects`、D-B21-8 `postgres_object_ddl`、D-B21-10 `postgres_object_drop`）；`postgres_test_connections`（D-B22-6）也可落此 |
| `src-tauri/src/lib.rs` | fe-dev | 注册新命令 |
| `src/lib/database/types.ts` | fe-dev | `DatabaseObjectRole`/`iconRole` 六类扩展（D-B21-2） |
| `src/lib/database/object-identity.ts` | fe-dev | 虚拟分组 id 约定常量（D-B22-2，纯约定 + 注释） |
| `src/lib/database/postgresql-object-loader.ts` | fe-dev | 5 组 + 表级组 + 六类对象加载、`getPostgresRelationReference` 兼容扩展（D-B21-1/4/5） |
| `src/components/toolbox/database-navigator.tsx` | fe-dev | 双击/Enter 语义（D-B21-6）、六图标（D-B21-2）、虚拟分组容器渲染（D-B22-2） |
| `src/components/toolbox/database-object-properties.tsx` | fe-dev | **新文件**：对象属性只读面板 tab（D-B21-7） |
| `src/components/toolbox/tool-postgres.tsx` | fe-dev | 对象菜单分支（D-B21-9）、Drop AlertDialog（D-B21-10）、`object` tab 接入、连接节点颜色/状态点映射（D-B22-2/7） |
| `src/lib/database/command-registry.ts` | fe-dev | 对象命令 + 连接测试命令注册（§四） |
| `src/components/toolbox/postgres-connection-manager.tsx` | fe-dev2 | **新文件**：连接管理对话框（颜色/分组/批量测试/重连/导入导出入口，D-B22-2/6/7） |
| `src/lib/connections-io.ts` | fe-dev2 | **新文件**：连接 JSON 导入导出 + 可选 AES-GCM 凭据加密（D-B22-3/4/5） |
| `src/lib/database/postgresql-profile-adapter.ts` | fe-dev2 | `color` 字段（D-B22-1） |
| `src/lib/toolbox/postgres-storage.ts` | fe-dev2 | `color` 列读写（D-B22-1） |

> 交接点：fe-dev2 的 profile-adapter/storage 加 color 字段**依赖 fe-dev 先定 types.ts 扩展**；fe-dev 的菜单里"连接管理器"入口依赖 fe-dev2 的组件存在（可用占位 disabled 项先行）。

---

## 四、B20 scope-router 兼容：对象命令的 scope 归属

**D-B21-12（对象命令注册：全部 NAVIGATOR scope，接入 B20 resolve 体系）**：

| command id | scope | connectionStates | capability 门槛 | 说明 |
|---|---|---|---|---|
| `database.object.open` | NAVIGATOR | connected | （既有 supportsRelations 门槛按现状，六类对象不设门槛） | 已存在 |
| `database.object.refresh` / `copyName` | NAVIGATOR | connected | 无 | 已存在 |
| `database.object.properties` | NAVIGATOR | connected | 无 | 新增：属性面板打开 |
| `database.object.ddlPreview` | NAVIGATOR | connected | 无 | 新增：DDL 预览（并入属性面板 tab，可独立注册） |
| `database.object.design` | NAVIGATOR | connected | 无 | 新增：**B23 占位**（resolve 后 state 恒 disabled，reason `missing-capability` 预留 B23 能力声明） |
| `database.object.drop` | NAVIGATOR | connected | 无 | 新增：破坏性，触发 AlertDialog（D-B21-10）；readOnly 时在 handler 层拒绝 |
| `database.connection.test` | NAVIGATOR, DATABASE | disconnected, connected | 无 | 新增：测试连接（单个或选中批量） |
| `database.connection.reconnect` | NAVIGATOR, DATABASE | connected | 无 | 新增：重连 |
| `database.connection.manager` | NAVIGATOR, DATABASE | disconnected, connected | 无 | 新增：打开连接管理器对话框（fe-dev2 入口） |

- **scope 归属原则**：对象操作一律 NAVIGATOR（B20 已定义）；连接测试/重连/管理器放 `NAVIGATOR + DATABASE`（连接级操作可在连接节点或全局菜单触发）；**不进 DATA_GRID / QUERY_EDITOR scope**（无冲突）。快捷键：本批对象/连接命令**均不绑定 Navicat 快捷键**（navicat-premium-shortcuts.md 无对象管理绑定项；Enter/双击走组件原生，不经 scope-router 绑定表）。
- 双击/Enter 语义（D-B21-6）与 B20 scope-router 共存：`database-navigator.tsx` 的 Enter 处理在 `[data-scope="navigator"]` 聚焦下接管（scope-router 的 NAVIGATOR scope 绑定表为空 → 放行 → 组件自身处理），无双重拦截。

---

## 五、风险与待验证

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R-B21-1 | Navicat 导航器对象菜单 UNVERIFIED（手册无逐项证据） | 中 | 功能优先保守菜单 + context-menus.md 登记 PARTIAL + 验证协议；不声称 parity |
| R-B21-2 | 函数重载 id 唯一性依赖 identity_args 编码 | 中 | id 编码 `proname(identity_args)`；label 显示 proname；签名入 path；单测覆盖重载对 |
| R-B21-3 | 大库组展开（columns）查询放大 | 低 | 懒加载保持；columns 查询白名单 + QUERY_TIMEOUT；后续可加分页（非 B21） |
| R-B22-1 | 批量测试并发建连放大资源 | 中 | Semaphore(4) + 整体 60s 超时 + 探测连接不驻留；E2E 用 2-3 连接 fixture |
| R-B22-2 | 导入导出的凭据脱密被误当缺陷 | 低 | 导出对话框显式说明"密码不随导出携带（可选加密）"；导入后提示重填 |
| R-B22-3 | color 字段与既有 row_upsert 动态列兼容 | 低 | 列缺省宽容（fromRow undefined 兼容）；无迁移版本需求 |

---

## 六、验收线索（DoD 支撑，供 QA）

- B21：每类对象（函数/序列/索引/约束/触发器/列）原生 E2E：展开组 → 加载对象 → 双击/Enter 打开属性面板 → DDL 预览正确；表/视图双击仍开数据网格；对象 Drop 触发 AlertDialog 且 readOnly 拒绝。
- B21：`postgres_catalog_objects` 六 kind 白名单单测（非法 kind 拒绝、columns 缺 relation 报错、重载签名唯一）。
- B22：连接专用 JSON 导出（默认无密码 / 可选加密）/ 导入（merge/替换）原生 E2E；批量测试 2 成功 1 失败 → 状态点正确 → 重连成功。
- 全量回归：`pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check`；视觉门禁（dark/light/960×700 + 截图）。
