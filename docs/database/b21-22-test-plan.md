# B21+B22「导航器对象全覆盖 + 连接管理」测试计划（QA）

> 作者：qa（严过关）｜2026-08-26
> 依据：`navicat-parity-master-plan.md` §6 M2（B21/B22 定义）、§7.4 操作习惯对齐（导航器单击/双击/Enter/右键）、§8 质量门禁、§10 风险登记（R9）；`navicat-premium-context-menus.md`（21 项确认菜单 + UNVERIFIED 协议）；`navicat-premium-feature-matrix.md`（CN-01..08 连接管理、D1 功能树）
> 参照：`b19-20-test-plan.md`（分层方法）、`b18-filter-test-plan.md`（分层方法）、`postgres-visual.e2e.ts`（视觉 spec 现有模式）、`sqlite-workspace.e2e.ts`（连接测试既有模式）、`postgres-grid-edit.e2e.ts`（交互/选择器纪律）
> 现状基线：`postgres_catalog_search`（postgres.rs:2216 仅 relation/column/function/type 四类，**B21 不动它**——架构约束 D-B21-4 裁定新增 `postgres_catalog_objects` 命令于新模块 `postgres_catalog.rs`）、`postgresql-object-loader.ts`（仅 tables/views/materializedViews 三组、表节点 `expandable:false`）、导航器/网格上下文菜单已有部分项（tool-postgres.tsx:1606/1780）、`vault-crypto.ts` AES-GCM 逐字段加密、`db.ts` encField/decField
> 状态：PLANNING——AC 编号为占位（对齐主规划 §6 M2 条目），待 pm `batch-21-22-sprint-plan.md` 发布后由 team-lead 对齐回填
> **门禁更新（用户，2026-08-26）**：R9 解除——真实 E2E 路径已验证（`pnpm exec wdio run wdio.conf.ts --spec e2e/desktop/postgres-visual.e2e.ts` 实测 1 passing 10.3s，PG fixture 127.0.0.1:55432 在线，debug 二进制已构建）。**本批 E2E 必须编写且执行**，不再是 DEFERRED。版本发布前必须视觉验证（visual spec 截图 + glm5.3 视觉评审）。

---

## 0. 总原则

1. **R9 解除，E2E 实跑**：B21/B22 全部 WDIO spec 编写 + 执行 + 结果留档，禁止 DEFERRED 占位。
2. **测试先行于实现**：Rust catalog 查询（六类对象）与 B22 导入导出加密载荷均为**纯函数/纯数据结构层**，可先写测试后实现（fe-dev/fe-dev2 按本计划 §2/§3 契约落地）。
3. **选择器契约**：spec 只引用**已对照真实 DOM 核验**的 data-testid（E2E-BUG-1/2 教训，b19-20 计划 §6.2）；新 UI 的 testid 由 fe-dev PR 附清单，qa 按 DOM 复核后回填 §7.2。
4. **对象级菜单证据纪律**：导航器/对象列表全量菜单在 context-menus 文档中为 `UNVERIFIED`——**不发明命令凑菜单**；本批落地项以 `[NexTerm]` 标注并逐项记录 enabled/disabled 状态与前置条件（文档 Required verification protocol）。
5. **破坏性操作门禁**：Drop 对象/删除连接/覆盖导入一律二次确认（alertdialog），E2E 断言确认对话框出现且取消路径无副作用。
6. **视觉门禁硬性**：B21/B22 改动可见 UI 一律产出 dark/light/960×700 截图 + 评审结论，纳入 glm5.3 视觉评审（§6）。

---

## 1. 分层策略总览

| 层 | 被测对象 | 用例形态 | 本批状态 |
|---|---|---|---|
| Rust 单测（cargo） | `postgres_catalog_objects` 六类对象白名单/过滤 + `postgres_object_props` / `postgres_object_ddl` / `postgres_drop_object`（cascade/confirmed 语义）、B22 导入导出加密载荷编解码、连接状态语义 | `cargo test postgres` / `cargo test config` | 可先行 |
| vitest 纯函数 | 节点模型（object-identity 扩展 + loader 六类分组 + 表节点列展开）、21 项菜单 enablement 表、连接颜色/虚拟分组逻辑、导入导出序列化（含凭据字段处理） | `src/lib/__tests__/` | 可先行 |
| 组件/集成 | 导航器六类对象渲染、菜单渲染回归、连接管理对话框/分组 UI | 既有渲染回归模式 | 部分（视基建） |
| 原生 E2E | B21 六类对象打开/双击/右键菜单/Drop 确认 + 21 项菜单抽样；B22 连接管理全链路（真实 PG fixture 127.0.0.1:55432 + 临时 SQLite） | WDIO spec | **编写且执行** |
| 视觉门禁 | 导航器（六类对象展开/图标/选中态）、对象菜单、连接管理器（颜色/分组）、导入导出对话框、dark/light/小窗 | 截图 + glm5.3 评审 | 必交 |
| 回归 | B17 编辑闭环 / B18 过滤布局 / B19 查询命令 / B20 快捷键 / 终端 | 既有测试 + 清单核对 | 验收必跑 |

---

## 2. Rust 单测设计（catalog 对象命令 + 导入导出加密，无真实 PG 亦可先行）

### 2.1 `postgres_catalog_objects` 六类对象查询（D-B21-4，新模块 `postgres_catalog.rs`）

> **fe-dev 裁定（D-B21-4）**：**新增命令而非扩展 `postgres_catalog_search`**——避免 LIMIT+ILIKE 语义污染既有补全路径。`kind ∈ {functions, sequences, indexes, constraints, triggers, columns}`（**复数命名**，与旧 search 单数 kind 隔离）；`postgres_catalog_search` 维持现状（relation/column/function/type）供补全使用，本批不改。
> 共同模式：**kind 白名单先判、权限谓词（`has_schema_privilege USAGE`）恒定、按 schema 精确过滤（无 ILIKE，前缀匹配按实现定稿）、limit clamp(1,100)**。建议把 kind→SQL 映射抽成纯函数（如 `catalog_objects_kind_query(kind)`），命令壳只做查询与行解码。

| # | 用例 | 断言 |
|---|---|---|
| CAS-1 | kind 白名单全量 | `functions/sequences/indexes/constraints/triggers/columns` 六类均返回 Ok；未知 kind（`table`/`relation`/`column`/`" "`/空串）→ Err（消息含 Unsupported/Unknown catalog object kind 语义） |
| CAS-2 | 未知 kind 不触达 DB | 白名单失败在查询前短路（mock：`clients` 未取到也先判 kind） |
| CAS-3 | functions 查询形态 | 关联 `pg_proc`，含 `has_schema_privilege`、schema 精确谓词、`LIMIT $2`（**无 ILIKE**）；返回签名 detail |
| CAS-4 | sequences 查询形态 | `pg_class` 且 `c.relkind = 'S'`；返回 name + 类型 detail |
| CAS-5 | indexes 查询形态 | 关联 `pg_index`/`pg_class`，含 `indisvalid` 过滤（无效索引不列出）、返回索引名 + 所属表 |
| CAS-6 | constraints 查询形态 | 关联 `pg_constraint`，按类型（p/f/u/c）返回，含所属表/列 detail |
| CAS-7 | triggers 查询形态 | 关联 `pg_trigger`，`NOT tgisinternal` 过滤系统触发器，返回所属表 + 触发事件 detail |
| CAS-8 | columns 查询形态 | 关联 `pg_attribute`，`attnum > 0 AND NOT attisdropped`，按 `attnum` 排序；所属表参数（schema+relation）缺失 → Err（语义对齐旧 search :2235-2236，但走新命令） |
| CAS-9 | schema 过滤精确匹配 | `schema=Some("public")` 时入参精确等值；None 时不加 schema 谓词；与旧 search 的 `$1::text IS NULL` 语义相互独立（各自断言） |
| CAS-10 | limit clamp | `Some(0)`/`Some(200)`/`None` → 分别 clamp 到 1/100/100；负值 → 1 |
| CAS-11 | 行解码字段归属 | functions → signature；columns → data_type；indexes/constraints/triggers/sequences → 各自 detail（所属表/类型/事件）；其余 → None |
| CAS-12 | 新旧命令隔离 | `postgres_catalog_objects` 不接受旧 kind（relation/column/function/type）；`postgres_catalog_search` 不接受新 kind（回归断言两者白名单互斥，防误用污染） |

### 2.2 对象属性 / DDL / Drop 命令（B21：`postgres_object_props` / `postgres_object_ddl` / `postgres_drop_object`）

> 四个新命令签名（fe-dev 给定，E2E 用例按此引用）：`postgres_catalog_objects` / `postgres_object_props` / `postgres_object_ddl` / `postgres_drop_object`（**含 `cascade` + `confirmed` 参数**）。本组单测锁定「confirmed 门禁」「cascade 语义」「DDL 按类型路由」三层纯决策。

| # | 用例 | 断言 |
|---|---|---|
| DDL-1 | DDL 按对象类型路由 | function → `pg_get_functiondef`；index → `pg_get_indexdef`；trigger → `pg_get_triggerdef`；constraint → `pg_get_constraintdef`；sequence → 序列 DDL（`CREATE SEQUENCE` 或 `pg_get_serial_sequence` 语义按实现定稿）；columns → 明确 no-DDL 返回（不报错但无 DDL 文本） |
| DDL-2 | 对象不存在 / 类型不匹配 | 给定 schema+name 无对应对象 → Err（含对象名）；约束/触发器请求缺所属表参数 → Err |
| DDL-3 | props 结构完整性 | 函数：签名 + 源码；序列：last_value/start/increment（或等价值）；索引：所属表；约束：类型 + 列；触发器：事件 + 执行函数；列：类型 + 注释——逐类型断言必含字段 |
| DROP-1 | **confirmed 门禁** | `confirmed=false`（无论 cascade 取值）→ Err 拒绝，**不触达 DB**（mock 断言无语句执行） |
| DROP-2 | 无 cascade 普通删除 | `confirmed=true, cascade=false` → 普通 `DROP ...`（RESTRICT 语义）；有依赖时 → Err（依赖报错）且对象仍在 |
| DROP-3 | cascade 级联删除 | `confirmed=true, cascade=true` → 删除成功；对象及其依赖一并消失（关联对象断言） |
| DROP-4 | 对象不存在 | → Err 明确（不静默成功） |
| DROP-5 | 权限不足 | → Err 上抛（不吞权限错误） |
| DROP-6 | 专用删除语句形态 | 触发器 → `DROP TRIGGER <name> ON <table>`；约束 → `ALTER TABLE <table> DROP CONSTRAINT <name>`；其余 → `DROP <TYPE> <schema>.<name>`——语句形态与对象类型一一对应 |
| DROP-7 | 删除后与 catalog 联动 | drop 成功后再查 `postgres_catalog_objects` 同 kind → 该对象不出现（跨命令一致性） |

### 2.3 导入导出凭据加密载荷（B22，AES-GCM）

现状：`vault-crypto.ts` `encryptPayload`（AES-GCM 256，`payload = base64(iv ‖ ciphertext)`，随机 iv 每次不同）、`db.ts` `encField`/`decField` 逐字段加密。导出文件不得含明文密码，导入需同密钥可解。

| # | 用例 | 断言 |
|---|---|---|
| EXP-1 | 导出序列化器对密码字段走加密 | 序列化纯函数：password 字段输出 `v1:<base64(iv‖cipher)>` 形态（或实现定稿形态），**不出现明文**；host/user/db 等非敏感字段按明文导出（可读性） |
| EXP-2 | 导出载荷无 IV 复用 | 同密码两次导出 → 两段 ciphertext 不同（随机 iv；依赖既有 encryptPayload 语义，回归 vault-crypto 既有测试） |
| EXP-3 | 导出文件不含明文密码扫描 | 对序列化结果做字面量断言：源密码字符串不得作为子串出现 |
| IMP-1 | 导入反序列化器校验信封 | 无 `v1:` 前缀/截断/base64 非法 → Err，不进入存储 |
| IMP-2 | 导入后同密钥解密还原 | 导出→导入 round-trip → `decryptPayload` 还原原始密码（与源连接配置一致） |
| IMP-3 | 错误密钥导入 | 换密钥解密 → Err（不可静默降级为明文） |
| IMP-4 | 导入覆盖语义 | 覆盖导入前先确认；同 id 连接覆盖、新连接追加，均幂等可重放 |
| IMP-5 | 空文件/非法 JSON | Err 且导入事务不产生半写状态（全部成功才落库） |

> 落点：若实现采用 Rust 侧编解码（`config_archive.rs` 已有 `write_config_archive`/`read_config_archive` 可仿），Rust 侧单测；若前端侧，则归 vitest（§3.4）。跨层**测试用例同一套语义**，实现定稿后回填落点。

### 2.4 连接状态语义（B22 批量测试/重连，若含 Rust 侧探活）

| # | 用例 | 断言 |
|---|---|---|
| CON-1 | 探活结果映射 | 成功/超时/认证失败/网络不可达 → 状态枚举（ok/timeout/auth/offline）各自独立可序列化 |
| CON-2 | 批量探活不串行阻塞 | 多连接并发探活（tokio join），单连接超时不影响其余结果 |
| CON-3 | 超时边界 | 探活 timeout 夹紧（如 ≤5s），不依赖默认连接超时 |
| CON-4 | 重连降级 | disconnect 后同配置重连成功；重连失败错误上抛且 UI 状态回 disconnected（回归 postgres_disconnect 现状） |

---

## 3. vitest 纯函数测试设计

### 3.1 节点模型扩展（B21：六类对象 + 列展开）

现状：`object-identity.ts`（确定性/层级 scoping）、`postgresql-object-loader.ts` 仅三组。B21 需：schema 下新增 `functions/sequences/indexes/constraints/triggers` 分组；表节点 `expandable:true` → 展开为列节点（`objectRole:"column"`）。

| # | 用例 | 断言 |
|---|---|---|
| NM-1 | schema 子级分组顺序稳定 | tables → views → materializedViews → functions → sequences → indexes → constraints → triggers（或实现定稿顺序），各分组 id 按 schema scoped（回归既有 `scopes group IDs to their parent schema`） |
| NM-2 | 六类对象节点角色 | function/sequence/index/constraint/trigger/column → `objectRole`/`iconRole` 各自正确、id 互不相同（同 `users` 表名下 index 与 constraint 不撞 id） |
| NM-3 | 表节点列展开 | 表 `expandable:true`；展开返回列节点（`attnum` 排序）；列节点 `expandable:false`、`openable:false` |
| NM-4 | 引用解析扩展 | `getPostgresRelationReference` 保持表/视图/物化视图（回归）；新增 `getPostgresObjectReference`（函数/序列/索引/约束/触发器，含 schema/name）不破坏既有调用 |
| NM-5 | 空分组 | 某 schema 无序列 → 分组仍渲染但为空（或按实现决策隐藏），id 不抛错 |
| NM-6 | 惰性加载 | 展开到哪层才 invoke 到哪层（无 N+1）；列展开只对单表查列（走新命令 `postgres_catalog_objects(kind=columns, schema, relation)`） |

### 3.2 菜单 enablement 表（B21：21 项确认菜单 + 对象级菜单状态）

建议：把 21 项菜单的（scope, 对象类型, 条件, enablement）抽成声明式表 `context-menu-bindings.ts`，provider 声明驱动（架构决策 D3，禁止 UI 按 PG 对象名分支）。

| # | 用例 | 断言 |
|---|---|---|
| CM-1 | 21 项全量注册 | 对照 context-menus.md 逐项存在（含 PARTIAL 现状项），无遗漏、无杜撰 |
| CM-2 | 按对象类型启用/禁用 | 函数对象菜单含「删除函数」不含「打开数据」；序列/索引/约束/触发器各自菜单集合与声明一致 |
| CM-3 | 权限条件 | readOnly 连接下 Drop 类 disabled；断连下对象菜单只保留连接/刷新/复制名 |
| CM-4 | 网格菜单条件（回归现状） | Set NULL 仅 nullable 列；Generate UUID 仅 uuid 列；Delete Record 仅 PK 行；空字符串与 NULL 语义分离（现状 tool-postgres.tsx:1800-1817 语义锁定） |
| CM-5 | 查询编辑器/表设计器菜单范围 | B21 不引入编辑器全量菜单（UNVERIFIED）；Query tab 编辑器保持浏览器/CM 默认（现状）——测试锁定「不越界」 |
| CM-6 | UNVERIFIED 项登记 | 导航器/对象列表全量菜单为 UNVERIFIED 的落地项全部标注 [NexTerm] 并在 PR 记录 enabled/disabled 快照 |

### 3.3 连接颜色与虚拟分组（B22）

| # | 用例 | 断言 |
|---|---|---|
| CG-1 | 颜色解析纯函数 | 合法色值（hex/rgb 命名）解析；非法值回退默认色；颜色随连接配置持久化（localStorage/存储模块 round-trip） |
| CG-2 | 虚拟分组归属 | 分组→连接多对多：一个连接可在多组、可无组；按组/按未分组过滤正确 |
| CG-3 | 分组排序与折叠 | 组顺序稳定；折叠组隐藏其连接但不丢失状态；组名唯一性校验（重名拒绝或合并，按决策锁定） |
| CG-4 | 删除组 | 组删除不删除组内连接（仅解除归属）；确认对话框语义 |
| CG-5 | 空组/无组视图 | 空组渲染占位；「未分组」视图与全部视图切换正确 |

### 3.4 导入导出序列化（B22 前端侧，若实现在前端）

| # | 用例 | 断言 |
|---|---|---|
| IO-1 | 导出 schema 版本字段 | 文件含 `{version, provider, connections[]}`（或定稿形态），版本可校验 |
| IO-2 | 凭据字段加密 | 密码字段走 `encryptPayload` 路径，明文密码不出现在序列化结果（EXP-1..3 同语义，前端侧实现时此处承接） |
| IO-3 | 导入兼容 | 缺省字段回填默认（jump 端口 22 等，回归 `connection-config.test.ts` 语义）；provider 未知连接拒绝或标记跳过（按决策） |
| IO-4 | 导入后配置对象构造 | `toConnectionConfig` 可消费导入数据（回归 connection-config 既有测试） |

---

## 4. B21 测试用例（六类对象 + 21 项菜单核对表）

### 4.1 E2E 用例清单（真实 PG fixture，fixture 对象见 §7.3）

> 统一前置：连接 PG（沿用 `postgres-grid-edit.e2e.ts` `connectPostgres()` 模式）→ 展开 public schema。用例按对象类型 × 交互方式组织，**每类对象至少覆盖 打开/双击/右键菜单 三态，函数/序列/索引/约束/触发器/表 各含一个 Drop 确认**。
> **数据通道（fe-dev 裁定，D-B21-4）**：列表/展开走 `postgres_catalog_objects`；打开详情走 `postgres_object_props`/`postgres_object_ddl`；Drop 走 `postgres_drop_object`（`cascade` + `confirmed` 两参数，前端在 alertdialog 确认后才传 `confirmed=true`，cascade 复选项传 `cascade=true`）。

| # | 用例 | 关键断言 |
|---|---|---|
| E-B21-1 | 函数：打开 | 双击函数节点 → `postgres_object_props`/`postgres_object_ddl` 渲染打开（函数编辑器/DDL 视图按实现），展示 `pg_get_functiondef` 或签名+源码；无数据网格打开 |
| E-B21-2 | 函数：双击 + Enter | 双击与选中后按 Enter 行为等价（都打开）；单击只选中不打开 |
| E-B21-3 | 函数：右键菜单 | 菜单出现，含「打开函数/复制名/刷新/删除函数」（[NexTerm] 集合）；复制名得到 `public.e2e_get_user_count()` 形态 |
| E-B21-4 | 函数：Drop 确认 | 右键删除函数 → alertdialog 确认 → **确认后才触发 `postgres_drop_object(confirmed=true)`**，函数消失且刷新后仍不在；**取消路径**：不传 confirmed、函数仍在；有依赖时无 cascade 报错、勾选 cascade 后成功（DDL/DROP-2/3 真库形态） |
| E-B21-5 | 序列：打开/右键/复制名 | 双击或菜单「打开序列」→ 序列详情（props：last_value/start/increment）；复制名 `public.e2e_sequence` |
| E-B21-6 | 序列：Drop 确认 | 确认后消失；使用中的序列（被列 default 引用）→ 无 cascade 时 Drop 报错路径提示明确，勾选 cascade 后成功 |
| E-B21-7 | 索引：打开/右键 | 双击索引 → `postgres_object_ddl` 视图（`CREATE INDEX ... ON public.users ...`）；菜单含「删除索引」 |
| E-B21-8 | 索引：Drop 确认 | `postgres_drop_object(confirmed=true)` 确认删除后 `pg_indexes` 无该索引（可经查询 tab 断言）；取消路径不变 |
| E-B21-9 | 约束：列表正确 | `postgres_catalog_objects(kind=constraints)` 列出 PK/FK/UNIQUE/CHECK 各类型（fixture 建 `e2e_orders` 全四类）；双击打开 DDL 视图 |
| E-B21-10 | 约束：右键菜单 | 菜单含「删除约束」；PK 约束删除路径与 FK 约束删除路径各自确认文案不同 |
| E-B21-11 | 触发器：打开/右键 | 双击触发器 → `postgres_object_ddl` 展示触发器源码（`CREATE TRIGGER ...`）；菜单含「删除触发器/启用禁用触发器」（[NexTerm]） |
| E-B21-12 | 触发器：Drop 确认 | `postgres_drop_object(confirmed=true)` 确认删除后 `pg_trigger` 无该触发器；**启用/禁用** toggle 生效（`pg_trigger.tgenabled` 断言） |
| E-B21-13 | 列：表展开 | 表节点可展开（回归现状 `expandable:false` 变更），经 `postgres_catalog_objects(kind=columns, schema, relation)` 取列；列按 attnum 排序，含类型/注释（showFieldType 语义一致） |
| E-B21-14 | 列：双击/右键 | 双击列 → 无打开动作（列不可打开，断言无新 tab）；右键菜单含「复制列名/复制限定名」 |
| E-B21-15 | 列：复制名 | 复制列名 → `id`；限定名 → `public.users.id`（或 `users.id`，按实现） |
| E-B21-16 | 表/视图回归 | 表/视图/物化视图打开行为与 B17/B18 一致不回归（双击→数据网格、右键菜单原集合完整；`postgres_catalog_search` 补全路径不受新命令影响） |
| E-B21-17 | 六类对象刷新 | 新建对象（经查询 tab CREATE）→ 刷新 → 各分组出现新对象（经 `postgres_catalog_objects` 重新拉取）；刷新不重置连接 |
| E-B21-18 | 断连态菜单 | 断开后右键对象 → 仅连接/复制名等非 DB 项可用；Drop/打开 disabled |
| E-B21-19 | Enter 语义统一 | 对函数/序列/索引/约束/触发器逐类验证 Enter=双击（抽样 3 类即可，其余随打开用例覆盖） |
| M-B21-1 | 21 项菜单人工核对 | 见 §4.2 核对表：逐项在真实 UI 右键触发，记录 enabled/disabled 状态 + 截图（非 WDIO，人工脚本清单，同 b19-20 M-1 模式） |

### 4.2 21 项确认菜单逐项核对表（现状缺口标记）

> 来源：`navicat-premium-context-menus.md`（Status 列 = 审计日基线）。本表为 B21 落地后逐项复核的核对清单；NexTerm 列以现状代码为准（tool-postgres.tsx:1606/1780 已核验）。

| # | Scope | 菜单项 | 审计日 Status | NexTerm 现状（2026-08-26 代码核验） | B21 期望 | 缺口 |
|---|---|---|---|---|---|---|
| 1 | 主工具栏 | Use Big Icons | MISSING | 无 | 工具栏右键菜单（[NexTerm] 或明确不实现） | **缺口** |
| 2 | 主工具栏 | Show Caption | MISSING | 无 | 同上 | **缺口** |
| 3 | 数据网格 | Delete Record | MISSING | 已实现（:1814-1817，PK 行 + alertdialog 确认） | 保留 + E2E 已覆盖（B17） | 无 |
| 4 | 数据网格 | Set to Empty String | MISSING | 已实现（:1805-1808，非 PK 列） | 保留 + B17 回归 | 无 |
| 5 | 数据网格 | Set to NULL | MISSING | 已实现（:1800-1804，nullable 列） | 保留 + B17 回归 | 无 |
| 6 | 数据网格 | Generate UUID | MISSING | 已实现（:1809-1812，非 PK 列，`crypto.randomUUID()`） | 保留；断言仅 uuid 列（CM-4 前端侧） | 无 |
| 7 | 数据网格 | Filter by field value | MISSING | 已实现（:1796） | 保留（B18 回归） | 无 |
| 8 | 数据网格 | Custom Filter | MISSING | 已实现（:1797） | 保留（B18 回归） | 无 |
| 9 | 数据网格 | Filter & Sort | MISSING | 已实现（列头菜单 :1826-1827） | 保留（B18 回归） | 无 |
| 10 | 数据网格 | Copy / Paste | PARTIAL | 复制已实现（Copy Cell/Row/Column Name :1791-1793）；粘贴块功能待确认 | 粘贴目标语义 E2E | **部分** |
| 11 | 数据网格 | Freeze Column | MISSING | 已实现（:1829） | 保留（B18 回归） | 无 |
| 12 | 数据网格 | Unfreeze All Columns | MISSING | 已实现（:1830） | 保留（B18 回归） | 无 |
| 13 | 数据网格 | Set Column Width | MISSING | 已实现（:1831） | 保留（B18 回归） | 无 |
| 14 | 数据网格 | Show Field Type / Show Comment | MISSING | 已实现（:1834-1841） | 保留（B18 回归） | 无 |
| 15 | 数据网格 | Set Row Height | MISSING | 已实现（行头菜单 :1844 起，B18） | 保留（B18 回归） | 无 |
| 16 | 查询构建器 | Remove | MISSING | 无（Query Builder 未实现，B28+） | 不实现（B21 范围外） | 非 B21 范围 |
| 17 | 查询构建器 | Remove / Edit Join | MISSING | 无 | 同上 | 非 B21 范围 |
| 18 | 查询构建器 | Add Field To WHERE/GROUP BY/ORDER BY | MISSING | 无 | 同上 | 非 B21 范围 |
| 19 | 查询构建器 | Zoom In/Out/100% | MISSING | 无 | 同上 | 非 B21 范围 |
| 20 | ER 图 | Design Foreign Key | MISSING | 无（ER B24） | 不实现 | 非 B21 范围 |
| 21 | ER 图 | Delete Foreign Key | MISSING | 无（ER B24） | 不实现 | 非 B21 范围 |

> **UNVERIFIED 行（导航器/对象列表/查询编辑器/工作表 tab 全量菜单）**：B21 只落地「六类对象各自明确子集」（打开/复制名/刷新/删除类，[NexTerm] 集合），其余不发明。核对协议照抄 context-menus.md Required verification protocol：记录对象类型、enabled/disabled、截图、状态前置。

### 4.3 B21 与 B20 快捷键联动

- Enter=双击 已由 B20 NAVIGATOR scope 承接（组 2 Ctrl+Q 打开新查询、Enter 打开）；B21 只验证六类对象 Enter 语义统一（E-B21-19）。
- 右键菜单弹出期间 DIALOG scope 优先（B20 回归 AC-20-15 语义适用对象菜单）：菜单打开时快捷键不穿透。

---

## 5. B22 测试用例（连接管理）

### 5.1 vitest 已覆盖层（§3.3/§3.4 颜色/分组/序列化）→ E2E 补真实链路

### 5.2 E2E 用例清单（PG fixture + SQLite 双 provider 抽样）

| # | 用例 | 关键断言 |
|---|---|---|
| E-B22-1 | 连接颜色设置 | 新建连接 → 设置颜色 → 树中连接节点显示颜色标识（class/样式断言）→ 重开应用持久 |
| E-B22-2 | 颜色非法值容错 | 非法色值输入 → 回退默认色、无崩溃（对话框校验提示） |
| E-B22-3 | 虚拟分组创建 | 新建分组 → 拖入/勾选连接 → 树中组折叠/展开正确、连接仍在未分组视图可查 |
| E-B22-4 | 虚拟分组删除 | 删除组 → 组内连接保留且回到未分组；确认对话框 |
| E-B22-5 | 虚拟分组重命名 | 重命名生效且组内连接归属不变 |
| E-B22-6 | 导出连接 | 导出 → 文件生成（对话框确认路径）→ **读文件断言不含明文密码**（PG/SQLite 各一连接，密码为唯一随机串） |
| E-B22-7 | 导入连接（新环境） | 用导出文件在新 data-dir 实例导入 → 连接列表恢复 → 用主密码解锁后连接成功 |
| E-B22-8 | 导入覆盖/合并 | 覆盖导入同名连接 → 配置更新、不产生重复项；合并导入 → 既有连接保留、新连接追加 |
| E-B22-9 | 导入非法文件 | 损坏 JSON/错误版本 → 明确错误提示、连接列表无变化 |
| E-B22-10 | 批量测试连接 | 多选连接（PG 在线 + SQLite 在线 + 一个故意断开的坏连接）→ 批量测试 → 每连接独立状态（ok/ok/error），单失败不影响其余 |
| E-B22-11 | 批量测试超时 | 不可达主机（如 127.0.0.1:1）→ 该连接超时状态，不阻塞整体 |
| E-B22-12 | 断线重连 | 断开 PG → 树节点状态 disconnected → 重连 → 数据/导航器恢复可用 |
| E-B22-13 | 失败重连 | 改错密码重连 → 明确错误、状态保持 disconnected、无半连接残留（回归 `postgres-connect` 失败路径） |
| E-B22-14 | 多连接并存 | 同时打开 PG + SQLite 两连接 → 各自工作区互不干扰（tab/连接状态独立） |
| E-B22-15 | 连接删除确认 | 删除连接 → 确认 → 从列表移除；取消 → 保留（回归现状 tool-postgres.tsx:1627-1633） |
| E-B22-16 | 视觉：连接管理器 | 颜色/分组/状态徽标 dark/light/小窗截图（§6） |

### 5.3 凭据加密专项验证点（安全门禁，必交）

| # | 验证点 | 方法 |
|---|---|---|
| SEC-1 | 导出文件不含明文密码 | E2E（E-B22-6 读文件 + 字符串扫描）+ vitest（EXP-3 字面量断言）双保险 |
| SEC-2 | 导出载荷为 AES-GCM 信封 | vitest EXP-1（`v1:<base64(iv‖cipher)>` 形态）；E2E 断言文件内密码字段非明文且含随机 iv 特征 |
| SEC-3 | 导入回解密正确 | E2E E-B22-7（导入后连接成功 = 密码还原正确） |
| SEC-4 | 换主密码后导出 | reencrypt 路径回归（既有 `reencrypt.test.ts` 语义）：改密码后导出的载荷用旧密码不可解 |
| SEC-5 | 导出文件不含 SSH 私钥/敏感字段明文 | 扫描 host key/私钥路径字段：私钥内容不导出（仅引用路径），或按加密信封导出（按实现决策锁定） |
| SEC-6 | 日志不打印密码 | `RUST_LOG=info` 捕获后端日志，断言无连接密码子串（沿用日志禁打密码基线） |

---

## 6. 视觉门禁清单（B21/B22）

> 门禁：改动可见 UI 产出 dark/light/960×700 截图（沿用 `postgres-visual.e2e.ts` `configureTheme` + `setWindowSize` 模式，落盘 `test-results/database-visual/`）+ **glm5.3 视觉评审结论**（布局/主题/响应式/组件/对比度五维，逐项 PASS/FAIL + 证据截图路径）。

| # | 界面 | 截图时态 | 评审维度要点 |
|---|---|---|---|
| V-1 | 导航器：六类对象展开态 | 深色/浅色/960×700 | 图标语义区分（函数 f(x)/序列/索引/约束/触发器/列）、层级缩进、分组折叠箭头、空分组占位 |
| V-2 | 导航器：表节点列展开 | 同上 | 列排序、类型/注释列、滚动条在小窗下的表现 |
| V-3 | 对象右键菜单（函数/序列/索引/约束/触发器各一） | 深色/浅色 | 菜单分组分隔线、disabled 项灰化对比度、小窗下菜单位置不溢出 |
| V-4 | 连接树：颜色 + 虚拟分组 | 深色/浅色 | 颜色标识可见性（对比度 ≥4.5:1 对背景）、组标题样式、未分组视图 |
| V-5 | 连接导入/导出对话框 | 深色/浅色/960×700 | 表单布局、错误提示态、文件选择入口 |
| V-6 | 批量测试结果面板 | 深色/浅色 | 状态徽标（ok/error/timeout）色盲可辨（不单靠颜色）、列表滚动 |
| V-7 | 连接对话框（回归） | 深色/浅色/小窗 | 与既有 `postgres-dialog-*` 截图对比不回归 |
| V-8 | 主题一致性 | 深色/浅色全量 | 与 B17-B20 既有截图同源调色板无漂移（CSS 变量一致） |

评审输出：每个 V-x 一张结论表（截图路径 + 五维 PASS/FAIL + FAIL 项登记 BUG）。

---

## 7. E2E 执行策略

### 7.1 spec 清单与执行顺序

| 顺序 | spec | 覆盖 | fixture | 前置 |
|---|---|---|---|---|
| 1 | `pnpm exec wdio run wdio.conf.ts --spec e2e/desktop/postgres-visual.e2e.ts` | 视觉基线 + 连接回归 | PG 127.0.0.1:55432 | 已在 §0 验证（10.3s passing），**作为冒烟前置** |
| 2 | `e2e/desktop/sqlite-workspace.e2e.ts` | SQLite 连接基线（B22 复用的连接路径） | SQLite（wdio.conf.ts 自动生成） | 无 |
| 3 | `e2e/desktop/postgres-objects.e2e.ts`（新） | B21 六类对象 打开/双击/菜单/Drop（§4.1 E-B21-1..19） | PG + B21 fixture 对象 | 视觉冒烟通过 |
| 4 | `e2e/desktop/postgres-connection-manager.e2e.ts`（新） | B22 颜色/分组/批量测试/重连（§5.2 E-B22-1..5,10..16） | PG + SQLite | B21 spec 通过 |
| 5 | `e2e/desktop/connection-import-export.e2e.ts`（新） | B22 导入导出 + 凭据加密（§5.2 E-B22-6..9 + SEC-1/3） | PG + SQLite + 临时 data-dir | 可独立，或并入 4 |
| 6 | 回归套件 | §8 清单 | 全量 | 上述全过 |

- **串行执行**（`maxInstances:1` 既有配置；R8 结论沿用：WDIO 并行共享 data-dir 冲突）。
- 每个新 spec 文件头标注 B21/B22 + fixture 依赖；不再标注 DEFERRED。
- 破坏性用例（Drop/删除连接/覆盖导入）在 spec 末尾自清理或使用独立 fixture 对象名（`e2e_` 前缀 + 幂等 `CREATE OR REPLACE`/`DROP IF EXISTS` 重建），保证可重复跑。

### 7.2 选择器契约

1. **已核验 testid**（现状 DOM）：`postgres-workspace` / `postgres-run` / `postgres-new-connection` / `postgres-connection-dialog` / `postgres-new-query` / `postgres-refresh` / `postgres-connect` / `postgres-disconnect` / `database-navigator-context-menu` / `database-result-context-menu` / `database-result-find-input` / `postgres-add-record` / `postgres-save-changes` / `postgres-revert-changes` / `postgres-stop` / `postgres-explain` / `sqlite-workspace` / `sqlite-new-connection` / `sqlite-connection-dialog` / `sqlite-run` / `sqlite-disconnect` / `sqlite-edit-connection` / `sqlite-delete-connection` / `app-lock-password` / `app-lock-confirm` / `app-lock-submit`。
2. **新增 testid 建议命名**（供 fe-dev 落地参考，spec 依据以实际 DOM 复核为准）：`postgres-function-*` / `postgres-sequence-*` / `postgres-index-*` / `postgres-constraint-*` / `postgres-trigger-*`（对象节点 `data-node-id` 沿用 `[data-node-id*="/group:functions"]` 模式）；B22：`connection-color-input` / `connection-group-*` / `connection-export` / `connection-import` / `connection-batch-test` / `connection-reconnect` / `connection-status-badge`。
3. **execute 闭包纪律**：沿用 b19-20 §6.2.5——`switchWindow` 4 次重试、相对断言、`browser.execute` 页内计算、`this.timeout(150000)`、`Date.now()` 唯一值、React 受控 input 用原生 value setter（postgres-visual.e2e.ts:51-55 模式）。

### 7.3 B21 fixture 对象（PG，建在 `nexterm_e2e` / `public`，幂等）

```sql
-- 表：全约束类型载体（B21 约束用例 + B17/B18 既有 users 表并存）
CREATE TABLE IF NOT EXISTS e2e_orders (
  id serial PRIMARY KEY,
  order_no text NOT NULL UNIQUE,
  customer_id integer,
  status text CHECK (status IN ('new','done')),
  note text,
  CONSTRAINT e2e_orders_customer_fk FOREIGN KEY (customer_id) REFERENCES public.users(id)
);
-- 函数
CREATE OR REPLACE FUNCTION public.e2e_get_user_count() RETURNS bigint
LANGUAGE sql AS $$ SELECT count(*) FROM public.users $$;
-- 序列
CREATE SEQUENCE IF NOT EXISTS public.e2e_sequence INCREMENT BY 1;
-- 索引
CREATE INDEX IF NOT EXISTS e2e_orders_status_idx ON public.e2e_orders(status);
-- 触发器（表载体）
CREATE OR REPLACE FUNCTION public.e2e_audit_fn() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.note := COALESCE(NEW.note, 'audited'); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS e2e_orders_audit_trg ON public.e2e_orders;
CREATE TRIGGER e2e_orders_audit_trg BEFORE INSERT ON public.e2e_orders
FOR EACH ROW EXECUTE FUNCTION public.e2e_audit_fn();
```

> 断言用对象名固定为 `e2e_` 前缀，spec 结束不清理（幂等可重跑）；Drop 用例删除后由 spec 开头重建（`CREATE OR REPLACE` / `IF NOT EXISTS` / `DROP IF EXISTS`）。

---

## 8. 回归清单（验收必跑 + 核对）

| 域 | 项目 |
|---|---|
| 全量四件套 | `pnpm test`（vitest）、`cargo test`、`tsc --noEmit`、`pnpm lint`、`i18n:check` |
| B17 编辑闭环 | `postgres-grid-edit.e2e.ts` 复跑；保存事务路径（M2 复合命令回归）；网格菜单新增项后 Copy/Delete/Set NULL 不回归（§4.2 #3-15 现状项） |
| B18 过滤/查找/布局 | `postgres-filter.e2e.ts` + `table-filter`/`find-matches`/`grid-layout-storage` 测试全绿；列头菜单（冻结/宽度/字段类型）与 B21 列节点功能不混淆 |
| B19 查询命令 | `postgres-query-commands.e2e.ts` 复跑（R9 解除后执行）；六类对象 DDL 视图与查询编辑器互不干扰 |
| B20 快捷键 | `scope-router`/`shortcut-bindings` 测试；Enter=双击扩展后 NAVIGATOR scope 回归（对象可打开集变化）；菜单/对话框 DIALOG 优先不穿透（AC-20-15） |
| 终端 | TR-1..TR-5（b19-20 §5.2）：终端聚焦全部透传；Ctrl+N 终端 wins 不受连接管理新快捷键影响 |
| 连接存储 | `connection-config.test.ts`、`postgres-storage.test.ts`、`reencrypt.test.ts` 全绿；导入导出不破坏既有存储 schema |
| i18n parity | B21/B22 新增键 zh/en 全对齐（扁平 key 比对 + `{{param}}` 占位符一致，沿用 B18 报告方法） |
| 命令 registry | `database-command-registry.test.ts` 既有断言不回归；新增对象打开/删除类命令 scope 归属正确 |
| 视觉 | §6 V-1..V-8 全量截图 + glm5.3 评审；与 B17-B20 截图同源一致性 |

---

## 9. 覆盖统计（计划态）

| 层 | 计划用例数 |
|---|---|
| Rust 单测 | CAS 12 + DDL 3 + DROP 7 + EXP/IMP 8 + CON 4 ≈ 34 |
| vitest | NM 6 + CM 6 + CG 5 + IO 4 ≈ 21 |
| E2E | B21 19 + 人工核对 1 + B22 16 + 加密专项 6 |
| 视觉门禁 | 8 界面 × 3 时态截图 + 五维评审 |
| 回归 | 四件套 + 9 域清单 |

---

## 10. 依赖与协作点

| 项 | 说明 |
|---|---|
| 等 pm | `batch-21-22-sprint-plan.md` 发布后对齐回填 §4/§5 AC 正式编号（本计划 AC-B21-x/AC-B22-x 为占位） |
| 等 fe-dev | Rust 新模块 `postgres_catalog.rs`：`postgres_catalog_objects` / `postgres_object_props` / `postgres_object_ddl` / `postgres_drop_object`（D-B21-4）+ 菜单声明表 + B22 导入导出序列化落点（Rust 或前端）；testid 清单随 PR 交付（§7.2.2） |
| 等 fe-dev2 | 节点模型扩展（object-identity/loader）+ 颜色/分组纯函数；若 B22 序列化在前端则归 fe-dev2 |
| 范围仲裁 | §4.2 #1-2（工具栏 Big Icons/Show Caption）是否本批实现需产品决策；#16-21 明确非本批（B23/B24/B28+） |
| 门禁 | E2E 实跑结果、glm5.3 视觉评审结论、R9 解除后全量补跑清单收口 |

---
