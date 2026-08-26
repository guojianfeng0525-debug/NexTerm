# 「未来三步」合并冲刺计划：v2.9.1 技术债清零 → v2.10.0 B23 表设计器 + B24 ER 图

> 状态：ACTIVE（用户已拍板三步持续执行不中断，无 PLANNING 审批门）
> 作者：pm（许清楚）｜2026-08-26
> 依据：`navicat-parity-master-plan.md` §5 D5/D6（设计器声明式表单 + DDL 预览/diff/回滚；ER 画布共用 canvas 核心）、§6 M2（B23/B24 定义）、§8（质量门禁）、§10 R9（B19 E2E 验证债）；`batch-21-22-sprint-plan.md`（Slice/AC/证据规则范本）；`v290-release-review.md`（五方评审遗留项）；`v290-visual-review.md`（hy3 评审 B-1/B-2 已修、M-1/M-2、Minor m-1）；`navicat-premium-interactions.md`（IN-02/04/27/28/33 ER 与 Designer 证据）
> **用户硬性要求（2026-08-26，必须遵守）**：
> ① 三步持续执行不中断（Step 1 → Step 2 → Step 3 一次跑完）；
> ② 每步结束后**不能有遗留项**（含历史遗留问题全部清空：无 flaky、无 DEFERRED、无未复跑 spec、无未关闭视觉项）；
> ③ 删除操作自行执行（当前目录下均可操作）。

---

## 0. 证据规则与代号（沿用 batch-21-22）

| 标记 | 含义 |
|---|---|
| **[Fact]** | Navicat 17 Windows 手册（M17）直接证据，标注页码/条目 |
| **[UNVERIFIED]** | 现有官方资料无法建立该精确行为，禁止声称 parity |
| **[NexTerm]** | 产品决策：NexTerm 自定义行为，不声称 Navicat parity |

| 代号 | 含义 |
|---|---|
| **UT** | vitest 单测（`pnpm test`） |
| **RT** | Rust 单测（`cargo test`） |
| **E2E** | 原生桌面 E2E（WDIO + debug 二进制 + 真实 PG Docker fixture） |
| **(SAF)** | 安全/破坏性护栏断言（注入/权限/二次确认/断连/原子性） |
| **(REG)** | 既有行为回归断言（B17–B22） |
| **VIS** | 视觉门禁：dark/light/960×700 + visual spec 截图 + glm5.3/hy3 视觉评审 |
| **GATE** | 全量回归：`pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check` |

---

## 1. 范围与目标

| Step | 版本 | 内容 | 性质 |
|---|---|---|---|
| **Step 1** | v2.9.1（patch） | 技术债清零 + 验证门禁补全（§2） | 纯质量收口，零新功能 |
| **Step 2** | v2.10.0 | B23 PG 表设计器 + DDL 预览/回滚 + View Builder（§3） | 功能（master-plan M2 顺延项） |
| **Step 3** | v2.10.0 收官 | B24 PG ER 图反向工程（关系线/拖拽/缩放/FK 设计删除）（§4） | 功能（master-plan M2 顺延项） |

**发布节奏建议（详见 §6）**：Step 1 独立发 v2.9.1（纯质量）；Step 2 + Step 3 **合并发 v2.10.0**（一次大版本收官 M2 剩余能力，内部设两个验证门；若 Step 2 DDL diff 出现不可控延期则启用预案 B23→v2.10.0 / B24→v2.11.0 拆分）。

**不变量（三步全程）**：
- B17–B22 已发布能力零回归（数据网格编辑/过滤/查询命令/快捷键 scope/导航器对象树/连接管理）。
- `Command Resolver` 不执行命令；新命令全部走 `command-registry.ts` scope + enablement（D2/D3 纪律）。
- 视觉一致性：dark/light/960×700 小窗三态全覆盖，不改主题系统。
- 安全红线：破坏性操作（DROP/ALTER/DELETE FK）二次确认 + readOnly 双层拦截 + 审计；DDL/SQL 全参数化 + 标识符引号转义，前端无拼 SQL 路径。

---

## 2. Step 1：技术债清零 + 验证门禁补全（v2.9.1）

### 2.1 遗留项清单与验收标准（AC-S1-x）

> 现状基线（2026-08-26 实测）：v2.9.0 已发布（HEAD=2c7e5c7，版本 bump + CHANGELOG 完成）；11 个 desktop E2E spec 中 7 个已实跑（v2.9.0 评审 §2.4 记录），4 个状态需处理；vitest 存在 1 个并发 flaky；视觉门禁 2 Blocking 已修复但未复评、2 Major 测试侧缺陷未修。

| # | 遗留项 | 来源 | 问题描述 | 验收标准（AC） |
|---|---|---|---|---|
| S1-1 | **实跑 postgres-query-commands.e2e.ts**（B19 验证债） | master-plan §10 R9 / spec 头部 DEFERRED 标记 | B19 查询命令 + B20 scope 路由的 3 条用例从未在稳定环境实跑；selectors 曾在编写时对照真实 DOM 验证，但无真实页面执行证据 | **AC-S1-1**：实跑 `postgres-query-commands.e2e.ts`（真实 PG fixture 127.0.0.1:55432）3 条用例全通过；spec 头部 DEFERRED 标记移除，注释更新为实跑结果 |
| S1-2 | **实跑/确认 mysql-workspace / sqlite-workspace / smoke** | team-lead 状态盘点 | 三 spec 在 v2.8.0 时期实跑过（`test-results/database-visual/` 截图 13:05、`smoke-vault.png` 13:04 为证据），但 v2.9.0 后未复跑；B21/B22 改动（导航器渲染、连接管理）可能引入回归 | **AC-S1-2**：三 spec 在 v2.9.1 工作树上各实跑通过（sqlite 需 `NEXTERM_SQLITE_E2E_PATH` fixture 环境）；MySQL/SQLite/终端三侧均无回归；结果与截图归档 |
| S1-3 | **修复 jump-persistence flaky** | v290-release-review §3-3 | `src/lib/__tests__/jump-persistence.test.ts` 并发 flaky：`saveConnectionWithId` 后 10ms settle 窗口与 mock 共享状态冲突，异步 persist 时序竞态；单独/复跑全绿但全量 vitest 偶发失败 | **AC-S1-3**：修复测试隔离（等真实 persist promise 完成替代固定 10ms sleep / 每用例独立 mock 状态）；连续 3 轮全量 `pnpm test` 0 flaky；`connection-storage.ts` 无生产逻辑改动 |
| S1-4 | **修复 v29 spec M-1（01-object-tree 滚动位置）** | v290-visual-review M-1 / release-review §3 遗留 6 | `v29-visual-capture.e2e.ts` 截图时树被滚动到可视区外，只拍到函数平铺 + 一个序列节点，表四子组/五类分组层级感缺失；期望展示"六类对象树完整形态" | **AC-S1-4**：修 `v29-visual-capture.e2e.ts` 截图步骤（展开 users 表四子组后先 `scrollIntoView`/重置导航器滚动位置再截图）；重截 `01-object-tree.png` 完整显示 5 组 + 表四子组 + 六类对象节点 |
| S1-5 | **修复 v29 spec M-2（07-small-dialog-fields 截图复用）** | v290-visual-review M-2 / release-review §3 遗留 5 | `07-small-dialog-fields.png` 与 `06-small-grouped-navigator.png` MD5 完全一致（复用截图）；小窗下 ConnectionDialog 字段从未真实捕获；it('08') 在 960×700 下连拍两张同一画面 | **AC-S1-5**：`v29-visual-capture.e2e.ts` it('08') 在 960×700 下先打开 ConnectionDialog（`[data-testid="postgres-new-connection"]`）再截图；`07-small-dialog-fields.png` 与所有其它截图 MD5 互不相同（截图 hash 去重检查落地）；补 CI/复跑截图 hash 去重脚本 |
| S1-6 | **重截 v2.9.0 关键截图 + hy3 复评关闭 Blocking** | release-review §3 遗留 4 | B-1（Toast 小窗自适应，`sonner.tsx`）/ B-2（SQL/DDL 编辑器水平滚动，`code-editor.tsx`）修复后**未重截图复评**，Blocking 关闭缺视觉证据 | **AC-S1-6**：重截 2 张修复界面（960×700 小窗 Toast + 长 SQL 编辑器），连同修正后的完整 10 张清单交 hy3 复评；复评结论 Blocking 全部关闭、无 FAIL；评审记录存档（如 `docs/database/v291-visual-review.md`） |
| S1-7 | **确认浅色 oneDark Minor（m-1）** | v290-visual-review m-1 / release-review §3 遗留 6 | 浅色主题下 SQL/DDL 编辑器曾为深色 oneDark；release-review 称已随 B-2 修复为"跟随主题"，需在重截图中确认实际效果并定论（修复生效 or 登记为已知决策） | **AC-S1-7**：浅色主题截图中编辑器配色与浅色面板一致（修复生效）；若未生效则本步修复至跟随主题；评审结论明确关闭或登记 [NexTerm] 决策（编辑器中立配色属设计选择，二选一必须有证据） |
| S1-8 | **全量验证 + 台账同步 + v2.9.1 发布** | 发布门禁 §8 | Step 1 收口：全量 GATE + 11 spec 全量实跑 + 视觉门禁复评全 PASS；台账登记（v2.9.1 补丁记录、master-plan §6 B23/B24 归属确认、development-status、CHANGELOG） | **AC-S1-8**：GATE 五件套全绿 + 11 个 desktop spec 全量实跑通过（含 S1-1/2 新实跑项）+ 视觉复评 PASS + 无任何 DEFERRED/flaky/未关闭项；版本 bump 2.9.0 → 2.9.1（package.json + Cargo.toml + tauri.conf.json）；CHANGELOG 落 [2.9.1]；台账同步完成 |

**Step 1 范围外（明确不做，避免范围蔓延）**：不改 `connection-storage.ts` 生产逻辑（仅测试隔离）；不引入新功能；不提前动 B23/B24 代码。

### 2.2 Step 1 验收方法与测试矩阵

| 类别 | 必交证据 |
|---|---|
| UT | jump-persistence 修复后 3 轮全量 vitest 无 flaky（AC-S1-3） |
| E2E | postgres-query-commands 3/3（AC-S1-1）；mysql-workspace / sqlite-workspace / smoke 各通过（AC-S1-2）；v29-visual-capture 修正后重跑（AC-S1-4/5/6） |
| VIS | 完整 10 张截图重截 + hy3 复评 Blocking 关闭（AC-S1-6/7） |
| GATE | `pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check` 全绿（AC-S1-8） |

### 2.3 Step 1 DoD（"无遗留项"定义，三步通用模板）

1. **AC 全量通过**：AC-S1-1..8 按 §2.2 验证留档；
2. **验证债清零**：11 个 desktop spec **全部实跑通过**，无 DEFERRED、无未复跑、无状态未知项；
3. **flaky 清零**：连续 3 轮全量 vitest 无 flaky；
4. **视觉门禁关闭**：hy3 复评全 PASS，Blocking/Major 全部关闭，Minor 有结论（修复或 [NexTerm] 登记）；
5. **GATE 全绿**：五件套 + i18n；
6. **版本发布**：v2.9.1 bump + CHANGELOG + 台账同步。

---

## 3. Step 2：B23 PG 表设计器 + DDL 预览/回滚 + View Builder（v2.10.0）

### 3.1 Navicat 证据（读 `navicat-premium-interactions.md` / master-plan）

| 证据 | 内容 | 引用 |
|---|---|---|
| IN-33 [Fact] | Designer：edit / save / revert / SQL preview（MISSING → 本批落地） | interactions.md IN-33 |
| IN-04 [UNVERIFIED] | Object pane 三视图（List / Detail / ER）切换；ER 视图中表双击打开 Table Designer | interactions.md IN-04 / Double Click Matrix |
| D5 [NexTerm 基线] | **对象设计器为声明式表单 + DDL 预览/diff/回滚**，先表设计器，后视图/函数 | master-plan §5 |
| US-09 | 新建/修改表结构（字段/约束/索引/FK），DDL 预览后保存；表设计器 DDL diff 原生 E2E；非法结构拒绝 | master-plan §4 |
| 快捷键 | Ctrl+D = Design Object（`DATA_GRID`/`NAVIGATOR` scope） | master-plan §7.2 |
| 移交项 | query builder 6 项菜单（Remove/Edit Join/Add Field To/Zoom）由 B21 核对表移交 B23（Query Builder 属 B23 View Builder 相邻能力，本批以 [NexTerm] 规格最小落地：不做完整 Query Builder，仅做 View Builder 声明式编辑，**6 项菜单保持移交登记至后续 Query Builder 专项**） | batch-21-22 §5.2 |

> 表设计器**内部字段布局** Navicat 手册 [UNVERIFIED]，以 [NexTerm] 规格落地（不声称 parity）：列网格 + 索引/FK/CHECK tab 页 + DDL 预览对话框。

### 3.2 User Visible Slice 划分

| Slice | 用户可见能力 | 依赖 | 交付形态 |
|---|---|---|---|
| **A 表设计器基础** | 打开设计器（右键「设计表」/Ctrl+D）；字段网格增删改列（列名/类型/可空/默认/注释/PK）；PG 类型下拉；脏状态 | 现有导航器 + `postgres_catalog` 类型查询 | 独立可发布 |
| **B 约束/索引/FK 管理** | 设计器内索引/FK/CHECK 约束 tab：列出、新增、删除、编辑（FK 引用表/列/级联） | Slice A 设计器 shell | 独立可发布 |
| **C DDL 预览/diff/回滚 + 保存应用 + View Builder** | 保存 → DDL diff 预览 → 事务执行 → 数据库生效；取消/失败回滚；导航器刷新；新建/编辑视图（View Builder） | Slice A+B 编辑模型；Rust DDL diff 引擎 | 独立可发布（本批收官） |

**建议开发顺序**：A → B → C（C 的 Rust DDL diff 引擎可与 A 并行开发，前端 C 依赖 A+B 的编辑模型）。

### 3.3 Slice A：表设计器基础

#### 用户故事

> 作为开发，我要像 Navicat 一样右键表就能"设计表"，在一个表格里增删改列——改列名、换类型、勾可空、填默认值、设主键——改动实时可见（脏标记），不保存绝不影响数据库。**[Fact]** IN-33 Designer edit/save/revert/SQL preview；表设计器入口双击语义 [UNVERIFIED]，以 [NexTerm] 落地（右键「设计表」+ Ctrl+D）。

#### 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 打开设计器 | 导航器右键表 →「设计表」；表节点聚焦 Ctrl+D（`NAVIGATOR`/`DATA_GRID` scope，enablement 走 `resolveDatabaseCommand`） | [NexTerm]（IN-33） |
| 设计器 tab | 标题=表名，上区字段网格（列名/类型/长度/可空/默认/注释/PK 勾选），下区 tab（索引/外键/约束，Slice B）；无编辑入口时只读展示（readOnly 连接） | [NexTerm]（IN-33） |
| 新增列 | 网格末尾添加行，填列名 → 类型下拉选型 → 可空/默认/注释/PK | [NexTerm] |
| 修改列 | 直接编辑单元格；改动行打脏标记（左侧状态点） | [NexTerm] |
| 删除列 | 选中行删除 → 行标记为删除（红色删除线），可撤销恢复 | [NexTerm] |
| PK 勾选 | 勾选某列 → 该列隐式 NOT NULL（PG 语义）并显示 PK 标记 | [NexTerm]（PG 语义 [Fact]） |
| 类型下拉 | 从 pg_catalog 拉 PG 标准类型（int4/int8/varchar/numeric/timestamp/uuid 等 + schema 限定自定义类型），不可自由输入任意串 | [NexTerm] |
| 关闭脏 tab | 有未保存改动 → 脏确认对话框（保存/放弃/取消） | [NexTerm]（IN-07 dirty 语义） |

#### Acceptance Criteria（AC-S2A）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-S2A-1 | 右键 `orders` 表 →「设计表」→ 打开设计器 tab，字段网格列全（列名/类型/可空/默认/注释 与 `information_schema.columns` 一致，顺序按 attnum）；类型显示含长度/精度（如 `varchar(255)`） | E2E |
| AC-S2A-2 | 新增列 `notes text` → 网格出现新行并带脏标记；**此时数据库无变化**（`SELECT` 断言列不存在） | E2E |
| AC-S2A-3 | 类型下拉列出 PG 标准类型 ≥20 项；选择 `numeric(10,2)` → 类型列显示完整类型 | E2E + UT |
| AC-S2A-4 | 勾选 `id` 列 PK → 该列显示 PK 标记 + 可空自动变为 NOT NULL | E2E |
| AC-S2A-5 | 修改 `name` 列可空（NOT NULL→NULL）→ 脏标记；恢复原值 → 脏标记消除 | E2E |
| AC-S2A-6 | 删除 `score` 列 → 行显示删除态；再删除其它行后撤销删除 → 行恢复 | E2E |
| AC-S2A-7 | 有未保存改动时关闭设计器 tab → 脏确认对话框（保存/放弃/取消 三选一），取消 → tab 保持打开 | E2E |
| AC-S2A-8 | readOnly 连接：右键无「设计表」或入口 disabled；强行打开（若允许）为只读、无编辑控件 | E2E(SAF) |
| AC-S2A-9 | 表设计器命令 enablement 单测：`database.object.design` 在（connected && !readOnly && relation）enabled，其余 disabled | UT |

### 3.4 Slice B：约束/索引/FK 管理

#### 用户故事

> 作为开发，我要在设计表的同时管理它的索引、外键和 CHECK 约束——看看现在有哪些，加一个新的唯一索引，给表加个指向 customers 的外键，保存时一起生成 SQL。**[Fact]** IN-33 Designer 覆盖对象级编辑（索引/FK 为 Navicat Table Designer 标准组成部分，内部布局 [UNVERIFIED]→[NexTerm]）。

#### 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 索引 tab | 列出表全部索引（名称/列/唯一/方法，与 `pg_indexes` 一致）；新增（选列 + 唯一勾选）；删除（标记删除）；无独立索引编辑器对话框（行内编辑） | [NexTerm] |
| 外键 tab | 列出全部 FK（约束名/引用表/引用列/on delete/on update）；新增（选引用表 + 引用列 + 级联策略）；删除；编辑 | [NexTerm] |
| CHECK tab | 列出 CHECK 约束（表达式原文）；新增表达式约束；删除 | [NexTerm] |
| 脏状态 | 与列编辑共用一套编辑会话（统一保存/撤销） | [NexTerm] |
| 非法结构校验 | 列名重复 / FK 引用不存在的表或列 / 类型不存在 / CHECK 表达式空 → 保存前校验失败 toast，不生成 SQL | [NexTerm]（US-09 非法结构拒绝） |

#### Acceptance Criteria（AC-S2B）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-S2B-1 | 索引 tab 列出 orders 全部索引（名称/列/唯一 与 `pg_indexes` 一致）；新增索引 `idx_orders_score ON orders(score)` → 新行带脏标记 | E2E |
| AC-S2B-2 | 删除 `idx_orders_name` → 标记删除；撤销 → 恢复 | E2E |
| AC-S2B-3 | 外键 tab 列出全部 FK（含引用表/列/级联）；新增 FK（引用 `customers(id)`，约束名自动生成 `fk_orders_customer`）→ 脏标记；删除 FK → 标记删除 | E2E |
| AC-S2B-4 | FK 编辑：on delete 切换 NO ACTION / RESTRICT / CASCADE / SET NULL → 下拉生效并随保存应用 | E2E |
| AC-S2B-5 | CHECK tab：新增 `score > 0` 表达式约束 → 显示；`orders_score_check` 已存在时列表正确 | E2E |
| AC-S2B-6 | 非法结构校验：列名重复 / FK 引用不存在列 / 空 CHECK 表达式 → 保存时校验失败 toast，**数据库无任何变更** | E2E(SAF) |
| AC-S2B-7 | 索引/FK/CHECK 的删除在**未保存前**数据库无变化（`pg_indexes`/`pg_constraint` 断言） | E2E(SAF) |

### 3.5 Slice C：DDL 预览/diff/回滚 + 保存应用 + View Builder

#### 用户故事

> 作为开发，我要点"保存"先看到将要执行的完整 SQL（新增列、改类型、加索引、加外键的 ALTER 语句），确认无误后执行；执行失败数据库回滚到原样，我的编辑还在可以改；我还要能新建一个视图，把 SELECT 存成数据库视图。**[Fact]** IN-33 SQL preview；D5 声明式表单 + DDL 预览/diff/回滚；US-09 DDL diff 原生 E2E + 非法结构拒绝。

#### 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 保存 | 点保存 → 前端把编辑会话（列/索引/FK/CHECK 增删改清单）发给 Rust DDL diff 引擎 → 生成 ALTER 语句序列 → 弹出 DDL 预览对话框（只读 CodeMirror） | [NexTerm]（D5） |
| DDL 预览 | 展示完整 diff SQL（含所有变更）；「执行」→ 单事务（BEGIN → 全部 DDL → COMMIT，失败 ROLLBACK）；「取消」→ 回到设计器保持编辑 | [NexTerm]（D5） |
| 执行结果 | 成功 → toast + 导航器对应表子树自动刷新（列/索引/约束节点更新）；失败 → toast 明确错误 + 事务回滚（数据库结构无变化）+ 设计器保留编辑可重试 | [NexTerm] |
| 回滚 | 保存前关闭选"放弃" → 编辑全部丢弃；执行失败 → 自动回滚不产生半应用状态 | [NexTerm]（US-09） |
| View Builder | 导航器右键视图 →「设计视图」/ 新建视图入口 → 视图定义编辑器（SELECT + 名称 + 字段列表）→ 保存生成 `CREATE [OR REPLACE] VIEW` → 导航器 Views 组出现/更新 | [NexTerm]（IN-33 扩展） |
| DDL 安全 | 标识符全部 `quote_identifier`；无拼接 SQL 路径；权限不足 → 通用化错误 toast | [NexTerm]（安全红线） |

#### Acceptance Criteria（AC-S2C）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-S2C-1 | **新增列闭环**：设计器新增 `notes text` → 保存 → DDL 预览显示 `ALTER TABLE "public"."orders" ADD COLUMN "notes" text;` → 执行 → `SELECT` 断言列实际生效 → 重开设计器列存在 | E2E |
| AC-S2C-2 | **改类型闭环**：`score numeric` → `bigint`（或需 USING 场景）→ 预览含 `ALTER COLUMN "score" TYPE ...` → 执行 → `pg_attribute` 断言类型变更 | E2E |
| AC-S2C-3 | **加索引闭环**：新增 `idx_orders_score` → 预览含 `CREATE INDEX ... ON "public"."orders"` → 执行 → `pg_indexes` 可见 → 重开设计器索引 tab 显示 | E2E |
| AC-S2C-4 | **加 FK 闭环**：新增 FK（orders.customer_id → customers.id）→ 预览含 `ALTER TABLE ... ADD CONSTRAINT "fk_orders_customer" FOREIGN KEY ...` → 执行 → `pg_constraint` contype='f' 可见 → 画布/设计器同步 | E2E |
| AC-S2C-5 | **失败回滚**：构造保存失败（如 CHECK 表达式非法被 PG 拒绝）→ toast 报错 + `pg_attribute`/`pg_constraint` 断言**全部结构无变化** + 设计器保留编辑可改后可重试 | E2E(SAF) |
| AC-S2C-6 | **取消保存**：DDL 预览点取消 → 数据库无变化；设计器关闭选放弃 → 重开显示原始结构 | E2E(SAF) |
| AC-S2C-7 | **多变更原子性**：一次保存含（加列 + 改类型 + 加索引 + 加 FK）→ 单事务全部生效；令其中一项失败（如 FK 引用不存在列）→ **全部回滚**，无半应用态 | E2E(SAF) |
| AC-S2C-8 | **View Builder 新建**：新建视图 `v_orders_high`（SELECT * FROM orders WHERE score>100）→ 保存 → 导航器 Views 组出现该视图 → 打开视图数据正确 | E2E |
| AC-S2C-9 | **View Builder 编辑**：编辑现有视图定义 → 保存生成 `CREATE OR REPLACE VIEW` → `pg_get_viewdef` 断言新定义 | E2E |
| AC-S2C-10 | readOnly 连接：保存/预览入口禁用，设计器只读；断连状态：操作 disabled，设计器已开则横幅提示 | E2E(SAF) |
| AC-S2C-11 | **Rust DDL diff 引擎单测**：add column / drop column / type change（含 USING cast）/ not null toggle / add index / drop index / add fk / drop fk / add check / drop check 各规则生成的语句正确；多变更组合顺序（先建后删依赖顺序）；标识符注入（列名含 `;`/引号）被转义安全执行 | RT(SAF) |
| AC-S2C-12 | **Rust 事务原子性单测**：批量 DDL 中途失败 → 主动 ROLLBACK，无悬空事务；commit 失败处理 | RT(SAF) |

### 3.6 Step 2 测试矩阵（对 master-plan §8.1）

| 类别 | 必交证据 |
|---|---|
| Unit（UT） | 设计器命令 enablement（AC-S2A-9）、编辑会话 reducer（列/索引/FK/CHECK 增删改状态）、类型下拉数据源、View Builder 表单校验 |
| Rust（RT） | DDL diff 引擎全规则 + 依赖顺序 + 注入护栏（AC-S2C-11/12）、对象属性/类型 catalog 查询 |
| Integration | Tauri IPC × PG fixture：设计器保存链路（diff → 预览 → 执行 → 生效）、View Builder 创建/编辑 |
| 原生 GUI E2E | AC-S2A-1..8、AC-S2B-1..7、AC-S2C-1..10（fixture 见 §5.4） |
| Safety | AC-S2A-8、AC-S2B-6/7、AC-S2C-5/6/7/10/11/12 |
| 视觉门禁（VIS） | §5.5 清单 Step 2 项 + 回归截图 |
| 全量回归（GATE） | 五件套 + B17–B22 全部 E2E 套件补跑 |

---

## 4. Step 3：B24 PG ER 图反向工程（v2.10.0 收官）

### 4.1 Navicat 证据

| 证据 | 内容 | 引用 |
|---|---|---|
| IN-27 [Fact] | ER 关系：创建=拖 child 字段到 parent；删除/设计=右键关系线；快捷键 **R**（新建 FK）/ **Delete**（删除 FK）；菜单 **Design / Delete Foreign Key**（M17 p.30） | interactions.md IN-27；context-menus.md |
| IN-28 [Fact] | 画布：SPACE+拖拽平移、Ctrl+滚轮缩放；快捷键 Esc（选择）、H（移动）、Ctrl+=/-/0（缩放） | interactions.md IN-28；master-plan §7.2 |
| IN-04 [UNVERIFIED] | Object pane List / Detail / **ER Diagram** 三视图切换 | interactions.md IN-04 |
| US-08 | 反向工程 ER 图，拖动表、编辑关系；ER 画布拖拽/缩放/关系线原生 E2E | master-plan §4 |
| D6 [NexTerm 基线] | **ER 画布 / 模型画布共用 canvas 核心**（pan/zoom/选择/连线/导出），ER 先行，模型后置复用 | master-plan §5 |
| 快捷键组 | ER-刷新 F5 / 选择 Esc / 移动 H / 新建 FK R / 删除 FK Delete / 缩放 Ctrl+=/-/0 或 Ctrl+滚轮（`ER_DIAGRAM` scope，全局 F5 不注册） | master-plan §7.2 |

> ER 画布**实现选型**：见 §7 风险 R-3（候选：SVG + 自研轻量 pan/zoom vs React Flow 等成熟库；以最小改动 + 不建无调用方抽象为裁量，进入 P0 契约评审）。

### 4.2 User Visible Slice 划分

| Slice | 用户可见能力 | 依赖 | 交付形态 |
|---|---|---|---|
| **A ER 画布基础** | 反向工程（表 + 列 + FK 关系）；表节点渲染（表名/列/PK 标记）；关系线（child FK → parent PK，线标签=约束名）；自动布局 | 导航器表/列/FK catalog（B21 已有列/约束子组） | 独立可发布 |
| **B 交互** | 拖拽节点、Ctrl+滚轮/Ctrl+=/-/0 缩放、SPACE/中键拖拽平移、H 移动模式、Esc 选择、F5 刷新、视口保持 | Slice A 画布 | 独立可发布 |
| **C FK 设计删除同步** | 右键关系线 Design/Delete Foreign Key；R 拖拽新建 FK；Delete 删除选中 FK；确认 → DDL 执行 → 数据库 + 画布双向同步 | Slice A/B；Rust DDL（复用 B23 引擎/命令） | 独立可发布（本批收官） |

### 4.3 Slice A：ER 画布基础

#### 用户故事

> 作为 DBA，我要一键把当前 schema 的表、列、外键关系画成 ER 图：每个表一个节点列出全部列（主键打钥匙标），外键用一条线连到它引用的表，一眼看清数据模型。**[Fact]** ER 反向工程为 Navicat 招牌能力（IN-04 ER view；主计划 OT-01）。

#### 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 打开 ER 图 | 导航器 schema 右键 →「ER 图」/ 对象面板视图切换入口（[NexTerm] 落地 IN-04） | [NexTerm]（IN-04 [UNVERIFIED]） |
| 反向工程 | 拉取 schema 内全部表 + 列（PK 标识、类型、可空）+ FK（`pg_constraint` contype='f'，含引用表/列/级联） | [NexTerm]（基于 B21 catalog 扩展） |
| 表节点 | 表名标题栏 + 列列表（列名/类型；PK 列前置钥匙图标标记；FK 列标记） | [NexTerm] |
| 关系线 | child FK 列 → parent PK 列连线；线标签 = FK 约束名；无 FK 的表独立节点 | [NexTerm]（IN-27 关系语义） |
| 自动布局 | 初始网格/分层布局（拓扑排序防线交叉），节点不重叠 | [NexTerm]（布局算法 [UNVERIFIED]） |
| 加载失败 | 反向工程失败 → 错误 toast + 画布空态可重试 | [NexTerm] |

#### Acceptance Criteria（AC-S3A）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-S3A-1 | 打开 ER 图 → 画布渲染 schema 全部表节点（数量与 `information_schema.tables` 一致），节点含表名 + 全列（类型） + PK 列钥匙标记 | E2E |
| AC-S3A-2 | FK 关系线：`orders.customer_id → customers.id` 连线两端锚定正确（child FK 列 → parent PK 列），线标签显示约束名 `fk_orders_customer` | E2E |
| AC-S3A-3 | 3+ 表 FK 链自动布局：节点 bounding box 无重叠（布局断言） | E2E |
| AC-S3A-4 | 无 FK 的孤立表渲染为独立节点，不崩溃 | E2E |
| AC-S3A-5 | 反向工程失败路径：断连/权限不足 → toast + 空态可重试，不崩溃 | E2E(SAF) |
| AC-S3A-6 | 表节点列信息 tooltip（类型/可空）；节点可选中（高亮边框） | E2E + VIS |

### 4.4 Slice B：交互（拖拽/缩放/平移）

#### 用户故事

> 作为 DBA，我要拖动表到顺手的位置、放大缩小看细节、按住空格拖画布漫游，改完的布局刷新后还在。**[Fact]** IN-28：SPACE-drag pan、Ctrl-wheel zoom；master-plan §7.2：Esc/H/Ctrl+=/-/0 绑定。

#### 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 拖拽节点 | 按住表节点拖到新位置，松手停留；关系线跟随重绘（不脱锚） | [Fact] IN-28 |
| 缩放 | Ctrl+滚轮 / Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 复位 100%；缩放范围 clamp（25%–200%） | [Fact] IN-28 + master-plan §7.2 |
| 平移 | SPACE 按住拖拽 / 鼠标中键拖拽平移画布；H 键进入移动模式（光标变抓手） | [Fact] IN-28 |
| 选择 | 单击节点选中；Esc 取消选择 | [Fact] master-plan §7.2 |
| 刷新 | F5 重拉结构（外部新增表出现在画布）；刷新后**用户拖拽布局保留**（会话内/持久化） | [Fact] master-plan §7.2 |
| scope | `ER_DIAGRAM` scope 接管以上快捷键；画布外不注册全局 F5 | [NexTerm]（D2） |

#### Acceptance Criteria（AC-S3B）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-S3B-1 | 拖拽 `orders` 节点至新位置 → 松手停留新坐标；相连关系线两端仍锚定正确列（无脱锚/乱线） | E2E |
| AC-S3B-2 | Ctrl+= → 画布 scale 增大（transform 断言）；Ctrl+- → 减小；Ctrl+0 → 复位 100% | E2E |
| AC-S3B-3 | SPACE 按住拖拽 → 画布平移（节点相对画布原点位移正确）；松开恢复；中键拖拽同样生效 | E2E |
| AC-S3B-4 | 单击节点选中（高亮边框）；Esc 取消；H 键进入/退出移动模式 | E2E |
| AC-S3B-5 | F5 刷新：外部 `CREATE TABLE` 新表出现在画布；用户拖拽的节点位置保持（刷新不重置布局） | E2E |
| AC-S3B-6 | 960×700 小窗：画布可用，缩放/平移正常，无溢出/遮挡（VIS） | E2E + VIS |
| AC-S3B-7 | 快捷键 scope 路由单测：`ER_DIAGRAM` 聚焦时 F5/Ctrl+=/H/R/Delete 生效；聚焦终端/查询编辑器时透传不拦截 | UT |

### 4.5 Slice C：FK 设计删除同步

#### 用户故事

> 作为 DBA，我要右键关系线就能"设计外键"（改级联策略）或"删除外键"；也可以拖着一个表的列到另一个表生成新的外键；删除后数据库真的删掉约束，画布同步更新。**[Fact]** IN-27：R 新建、Delete 删除、右键线 Design/Delete Foreign Key（M17 p.30）。

#### 交互定义

| 入口 | 行为 | 证据 |
|---|---|---|
| 右键关系线 | 菜单「设计外键」「删除外键」 | [Fact] M17 p.30（context-menus 移交项） |
| 设计外键 | 对话框：约束名/引用表/引用列/on delete/on update（可编辑）→ 保存生成 `ALTER TABLE ... DROP CONSTRAINT` + `ADD CONSTRAINT`（或原地 ALTER） | [NexTerm]（IN-27） |
| 删除外键 | 二次确认（约束名 + 危险提示）→ `ALTER TABLE ... DROP CONSTRAINT "fk_xxx"` → 执行成功 → 画布关系线消失 + `pg_constraint` 断言约束已删 | [Fact] IN-27 + SAF |
| R 新建 FK | 拖拽 child 表列 → parent 表列（或列对）→ FK 设计对话框（预填引用表/列）→ 确认 → `ADD CONSTRAINT` → 画布新增线 + 数据库生效 | [Fact] IN-27 |
| Delete 删除 | 选中关系线按 Delete → 二次确认 → 同「删除外键」流程 | [Fact] IN-27 |
| 同步 | 画布删除/新建 FK 后 F5 刷新不复活（画布与数据库一致）；失败 → toast + 画布不变 | [NexTerm] |
| 护栏 | readOnly 连接：删除/新建入口 disabled，画布仍可浏览；无权限 → 通用化错误 toast | [NexTerm]（SAF） |

#### Acceptance Criteria（AC-S3C）

| # | 验收项 | 验证方式 |
|---|---|---|
| AC-S3C-1 | 右键关系线 → 菜单含「设计外键」「删除外键」；选设计 → 对话框显示 FK 属性（约束名/引用表/列/级联），修改 on delete=CASCADE → 保存 → `pg_get_constraintdef` 断言级联变更生效 + 画布线标签更新 | E2E |
| AC-S3C-2 | **删除 FK 闭环**：右键关系线 → 删除外键 → 二次确认显示 `DROP CONSTRAINT "fk_orders_customer"` → 确认 → `pg_constraint` contype='f' 断言约束消失 → 画布关系线消失 → F5 刷新不复活 | E2E(SAF) |
| AC-S3C-3 | **新建 FK 闭环**：拖拽 `orders.customer_id` → `customers.id` → 对话框预填引用表/列 → 确认 → `pg_constraint` 新增 FK → 画布新增关系线（标签正确） | E2E(SAF) |
| AC-S3C-4 | Delete 键删除选中关系线 → 二次确认 → 数据库 FK 删除 + 画布同步（同 AC-S3C-2 断言） | E2E(SAF) |
| AC-S3C-5 | readOnly 连接：删除/新建 FK disabled，画布仍可浏览/拖拽/缩放 | E2E(SAF) |
| AC-S3C-6 | 取消操作（对话框取消/确认框取消）→ 数据库与画布均无变化 | E2E(SAF) |
| AC-S3C-7 | Rust：FK 增删 DDL 生成单测（复用 B23 DDL 引擎扩展：DROP CONSTRAINT/ADD CONSTRAINT + 标识符转义）；ER catalog 查询（表/列/FK 一次拉取，无 N+1） | RT(SAF) |

### 4.6 Step 3 测试矩阵

| 类别 | 必交证据 |
|---|---|
| Unit（UT） | ER_DIAGRAM 快捷键 scope 路由（AC-S3B-7）、布局算法、FK 编辑会话、画布状态 reducer |
| Rust（RT） | ER catalog 查询（无 N+1）、FK DDL 生成 + 注入护栏（AC-S3C-7）、复用 B23 diff 引擎 |
| Integration | Tauri IPC × PG fixture：ER 反向工程、FK 增删执行链路 |
| 原生 GUI E2E | AC-S3A-1..6、AC-S3B-1..6、AC-S3C-1..6（fixture 见 §5.4） |
| Safety | AC-S3A-5、AC-S3C-2/3/4/5/6/7 |
| 视觉门禁（VIS） | §5.5 清单 Step 3 项 |
| 全量回归（GATE） | 五件套 + B17–B22 + B23 全部 E2E 套件补跑 |

---

## 5. 验收方法与门禁汇总

### 5.1 每 Step 验收方法对照

| Step | UT | RT | E2E | VIS | GATE |
|---|---|---|---|---|---|
| Step 1 | jump-persistence 3 轮无 flaky | cargo 全绿 | 11 spec 全量实跑 | hy3 复评 Blocking 关闭 | 五件套全绿 |
| Step 2 | enablement/reducer/类型源/表单校验 | DDL diff 全规则 + 原子性 | AC-S2A/B/C 全部用例 | Step 2 界面截图 + hy3 评审 | 五件套 + 全量 E2E |
| Step 3 | scope 路由/布局/会话 | ER catalog + FK DDL | AC-S3A/B/C 全部用例 | Step 3 界面截图 + hy3 评审 | 五件套 + 全量 E2E |

### 5.2 真实 E2E 用例清单（新增/重跑）

**Step 1（重跑/补跑）**：

| # | 用例 | 覆盖 |
|---|---|---|
| S1E-1 | postgres-query-commands：Ctrl+Shift+R 当前语句 / Ctrl+T 停止长查询 / Ctrl+R 不劫持 | AC-S1-1（B19/B20） |
| S1E-2 | mysql-workspace / sqlite-workspace / smoke 各一 | AC-S1-2 |
| S1E-3 | v29-visual-capture 修正版（树完整捕获 + 真实小窗 Dialog + hash 去重） | AC-S1-4/5/6 |

**Step 2（B23 新增）**：

| # | 用例 | 覆盖 |
|---|---|---|
| S2E-1 | 打开设计器 → 列全量核对 | AC-S2A-1 |
| S2E-2 | 加列/勾 PK/改可空/删列 + 脏标记 + 数据库无变化 | AC-S2A-2/4/5/6, AC-S2B-7 |
| S2E-3 | 类型下拉 + numeric(10,2) | AC-S2A-3 |
| S2E-4 | 关闭脏 tab 三选一 | AC-S2A-7 |
| S2E-5 | 索引/FK/CHECK 增删（未保存无变化） | AC-S2B-1/2/3/5 |
| S2E-6 | FK 级联编辑 | AC-S2B-4 |
| S2E-7 | 非法结构拒绝 | AC-S2B-6 |
| S2E-8 | 保存闭环：加列→预览 ADD COLUMN→生效→重开确认 | AC-S2C-1/2/3/4 |
| S2E-9 | 失败回滚 + 取消保存 + 多变更原子性 | AC-S2C-5/6/7 |
| S2E-10 | View Builder 新建/编辑视图 | AC-S2C-8/9 |
| S2E-11 | readOnly 只读打开 + 保存禁用 | AC-S2A-8, AC-S2C-10 |

**Step 3（B24 新增）**：

| # | 用例 | 覆盖 |
|---|---|---|
| S3E-1 | ER 打开 → 表节点全量 + FK 线锚定 | AC-S3A-1/2 |
| S3E-2 | 多表布局无重叠 + 孤立表 | AC-S3A-3/4 |
| S3E-3 | 拖拽 + 关系线跟随 | AC-S3B-1 |
| S3E-4 | 缩放/平移/H 模式/Esc | AC-S3B-2/3/4 |
| S3E-5 | F5 刷新 + 布局保持 | AC-S3B-5 |
| S3E-6 | 右键线 Design/Delete FK 闭环（含 F5 不复活） | AC-S3C-1/2 |
| S3E-7 | 拖拽新建 FK + Delete 删除 | AC-S3C-3/4 |
| S3E-8 | 取消操作无变化 + readOnly 禁用 | AC-S3C-5/6 |

### 5.3 视觉门禁清单（hy3 评审截图对象）

| # | 界面 | 所属 |
|---|---|---|
| V-1 | 表设计器字段网格（含 PK 标记/脏行）dark/light | Step 2 |
| V-2 | 表设计器索引/FK/CHECK tab 页 | Step 2 |
| V-3 | DDL 预览对话框（多变更 diff SQL） | Step 2 |
| V-4 | 脏确认对话框 / 保存失败 toast | Step 2 |
| V-5 | View Builder（视图定义 + 预览） | Step 2 |
| V-6 | ER 画布（多表 + FK 关系线 + PK 钥匙标记）dark/light | Step 3 |
| V-7 | ER 画布 960×700 小窗（缩放/平移态） | Step 3 |
| V-8 | FK 设计对话框 + 关系线右键菜单 + 删除二次确认 | Step 3 |
| V-9 | B17–B22 改动面回归截图（导航器树/连接管理器/数据网格等） | Step 1–3 REG |
| V-10 | 960×700 小窗全界面 sanity | 每 Step 末 |

### 5.4 E2E fixture（Step 2/3 新增，SQL 片段）

```sql
-- B23 表设计器 + B24 ER fixture（在既有 nexterm_e2e 库内）
CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id),
  name text NOT NULL,
  score numeric,
  CONSTRAINT orders_score_check CHECK (score > 0)
);
CREATE INDEX IF NOT EXISTS idx_orders_name ON orders(name);
-- 多表 FK 链（布局断言）：order_items -> orders -> customers
CREATE TABLE IF NOT EXISTS order_items (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id),
  product text,
  qty integer NOT NULL DEFAULT 1
);
-- 孤立表（无 FK）：audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (id serial PRIMARY KEY, msg text);
-- 只读角色（权限拒绝验证）沿用 B21：nexterm_ro
```

### 5.5 每 Step DoD（"无遗留项"统一定义）

> 某 Step 完成 = 满足以下**全部**条件，缺一不可：

1. **该 Step 全部 AC 通过**（含历史遗留项：Step 1 必须闭环 S1-1..8；Step 2/3 必须闭环各自 AC + **前一 Step 无未决项**）；
2. **全部 E2E 实跑通过**（WDIO + debug 二进制 + 真实 PG fixture；该 Step 范围内新增/重跑用例全绿；Step 1 要求 11 个 spec 全量）；
3. **视觉门禁 PASS**（hy3 评审全通过，Blocking/Major 全部关闭，Minor 有结论）；
4. **全量验证绿**：`pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check`；
5. **无遗留状态物**：无 flaky、无 DEFERRED spec、无未复跑 spec、无截图复用/捕获缺陷、无未关闭视觉项、无台账未同步项；
6. **版本发布 + 台账同步**：版本 bump、CHANGELOG、master-plan §6/Scorecard、development-status、interactions/context-menus/feature-matrix 台账、AGENTS.md 全部更新。

---

## 6. 发布计划：v2.9.1 → v2.10.0

| 版本 | 内容 | 发布前置 |
|---|---|---|
| **v2.9.1**（patch） | Step 1 技术债清零 + 验证门禁补全（零新功能） | Step 1 DoD 全满足；发布评审（Release 汇总，四件套可） |
| **v2.10.0**（minor） | Step 2 B23 + Step 3 B24（合并收官 M2 剩余能力） | Step 2/3 DoD 全满足；五方发布评审；视觉门禁全 PASS |

**合并 or 分两次建议：合并发 v2.10.0（推荐），理由**：

1. **用户硬性要求"三步持续执行不中断"**——一次冲刺内连续完成，合并发布符合节奏；
2. **master-plan 原设计 B23/B24 同属 M2「对象与设计」**，B24 仅依赖 B21（已完成），FK 设计删除的 DDL 由 ER 模块独立生成，与 B23 无硬依赖，可并行；
3. **验证成本**：一次全量 GATE + 一次视觉门禁 + 一次五方评审，比分两版省一次完整发布成本；且避免 v2.10.0 后紧接着 v2.11.0 只含 B24 的"半版"尴尬；
4. **风险对冲**：内部设两个验证门——Step 2 完成（GATE 绿 + AC-S2 全部 E2E 实跑 + 视觉评审）→ 才进入 Step 3；若 Step 2 DDL diff 出现不可控延期，启用**预案**：v2.10.0 仅含 B23、B24 单独 v2.11.0（并在 master-plan §6 登记归属调整）。

**版本号纪律**：Step 1 后 `package.json` + `Cargo.toml` + `Cargo.lock` + `tauri.conf.json` 手动 bump 至 2.9.1；Step 3 收官手动 bump 至 2.10.0（沿用 release-review §3 结论：不跑 `version:minor` 脚本，手动改）。

---

## 7. 风险登记

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R-1 | **表设计器 DDL diff 复杂度**：ALTER TABLE 多变更组合（类型变更需 USING cast、NOT NULL 迁移、FK 约束名自动生成、先建后删依赖顺序）、事务原子性、失败回滚一致性 | 高 | Rust 侧独立 diff 引擎 + 全规则 RT 单测（AC-S2C-11/12）；E2E 真实 fixture 全闭环（AC-S2C-1..7）；预览对话框先行（用户看到 SQL 才执行，错误面收敛）；多变更原子性 E2E 兜底 |
| R-2 | **ER 画布实现选型**：SVG 自研（轻量 pan/zoom/连线，契合 D6 无重依赖）vs React Flow 等成熟库（功能全但引入依赖 + webview 兼容性 + 主题定制成本） | 中 | P0 契约评审：画布核心 API（节点/线/视口/选择）先冻结；优先评估 SVG + 自研（项目已有 pointer 事件与 DOM 渲染基础，关系线数量级小）；决策时对比 React Flow 的 XSS/依赖体积；选定后布局算法 RT/UT 先行 |
| R-3 | **Step 1 历史 spec 可能暴露存量 bug**：postgres-query-commands（B19）从未实跑，可能暴露查询命令/scope 实际缺陷；mysql/sqlite/smoke 复跑可能暴露 v2.9.0 回归 | 中 | Step 1 前置执行；发现 bug 当场修复（符合"无遗留项"硬要求），修复范围仅限测试所暴露的真实缺陷，不扩大；修复后全量 E2E 复跑 |
| R-4 | **v2.9.1 与 v2.10.0 双版本连发范围重叠**：Step 1 收口若与 Step 2 开发并行，共享文件的改冲突 | 低 | Step 1 全部合入并 GATE 绿后才开 Step 2；文件所有权沿用 §8 纪律 |
| R-5 | **B23/B24 与既有导航器交互耦合**：设计器保存后刷新表子树、ER 图打开入口、FK 删除与 B21 Drop 约束并存 | 中 | 入口收敛：设计器保存统一走"刷新所属表子树"；ER FK 操作与导航器约束菜单语义一致（都走 `postgres_drop_object`/diff 引擎）；REG 套件把关 B21 行为 |
| R-6 | **View Builder 范围蔓延**：用户任务含 View Builder，但 Navicat Query Builder 6 项菜单（Join/WHERE/GROUP BY 拖拽构建器）不在本批 | 中 | 明确本批 View Builder = 声明式视图定义编辑（SELECT 文本 + 字段列表），**不做拖拽 Query Builder**；6 项菜单保持移交登记至后续专项；DoD 不要求其落地 |
| R-7 | **ER 布局算法性能/质量**：大 schema（100+ 表）初始布局耗时或线交叉严重 | 低 | 懒加载 + 分层布局简化版；性能断言（100 表 < 2s 渲染）；后续 Batch 35（模型）再优化 |

---

## 8. 文件边界与并行纪律（防冲突，沿用 batch-21-22）

- **P0 契约冻结（Step 2/3 开工前）**：Rust 新命令签名（DDL diff 引擎 / ER catalog / FK 增删）+ 设计器编辑会话模型 + 画布核心 API + `command-registry.ts` 新 descriptor（`database.object.design` / `database.object.erDiagram` / `database.er.*`）→ pm 主持，相关方对齐。
- `tool-postgres.tsx` / `src/lib/i18n.ts`：**单所有者全程**（沿用裁定）。
- 画布/设计器新组件：独立新文件，避免改动共享 navigator 渲染路径。
- Step 2/3 合入 main 后：台账同步（master-plan §6、development-status、feature-matrix、interactions、context-menus、CHANGELOG、AGENTS.md）随 DoD 一并完成。

---

## 附：Rust IPC / 命令新增清单（P0 契约冻结待对齐）

```
# B23 表设计器
postgres_table_columns       变更/新增（设计器列全量：名称/类型/精度/可空/默认/注释/PK，按 attnum）
postgres_table_indexes       新增（设计器索引 tab：pg_indexes）
postgres_table_foreign_keys  新增（设计器 FK tab：pg_constraint contype='f' + 引用列/级联）
postgres_table_checks        新增（设计器 CHECK tab：pg_get_constraintdef）
postgres_pg_types            新增（类型下拉：pg_catalog 类型 + schema 限定）
postgres_apply_table_ddl     新增（DDL diff 引擎入口：编辑会话 → ALTER 序列 → 单事务执行 → 返回结果）
postgres_create_view / postgres_alter_view  新增（View Builder：CREATE [OR REPLACE] VIEW）
# B24 ER 图
postgres_er_schema           新增（反向工程：表+列+FK 一次拉取，无 N+1）
postgres_er_fk_ddl           新增（FK 增删 DDL：ADD/DROP CONSTRAINT，复用 diff 引擎规则）
# command-registry
database.object.design        NAVIGATOR/DATA_GRID（connected && !readOnly && relation）
database.object.erDiagram     NAVIGATOR（connected && schema）
database.er.newFk / designFk / deleteFk   ER_DIAGRAM scope
```
