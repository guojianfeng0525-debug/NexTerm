# NexTerm「未来三步」测试计划（QA）

> 作者：qa（严过关）｜2026-08-26
> 覆盖：**Step1 技术债清零（v2.9.1）→ Step2 B23 表设计器 → Step3 B24 ER 图（v2.10.0）**
> 依据：`v290-release-review.md`（遗留项 §3：jump-persistence flaky、v29 spec M-1/M-2、截图捕获缺陷）、`b21-22-test-plan.md`（分层格式与方法参照）、`b19-20-test-plan.md`（M-1/M-2 人工清单 + 选择器契约）、`postgres-query-commands.e2e.ts`（B19 遗留 120 行 spec）、`jump-persistence.test.ts`（flaky）、`navicat-parity-master-plan.md` §6 M2（B23/B24 定义与 DoD）、`v290-visual-review.md`（hy3 评审 10 张截图 + M-1/M-2 缺陷登记）、`wdio.conf.ts`（fixture 自动生成逻辑）
> 状态：PLANNING——供 team-lead 编排，dev 实现前由 qa 核对 testid 契约后回填
> **用户硬门禁（已确立）**：① 真实 E2E 路径（WDIO + debug 二进制 + 真实 PG fixture 127.0.0.1:55432）；② E2E 窗口令牌制（跑前申请 lsof :4445 + pgrep + dist 三项检查，用完释放）；③ 版本发布前视觉门禁（最新截图 + hy3 视觉模型评审全 PASS）；④ 每个功能必须真实页面验证后才标记实现；⑤ **每步结束无遗留**——全量回归通过才进入下一步。

---

## 0. 总原则

1. **无遗留门禁**：每个 Step 结束必须完成 §6 全量回归，B17-B22 + 上一步新功能全绿才放行下一步——对齐用户「每步无遗留」。
2. **R9 已解除**：所有 E2E spec 必须实跑，禁止 DEFERRED 占位（`postgres-query-commands.e2e.ts` 头部 DEFERRED 注释在实跑通过后删除）。
3. **测试先行于实现**：B23/B24 的 Rust DDL 生成/diff 与 ER FK 查询均为纯函数层，可先写测试后实现（对齐 b21-22 §0.3）。
4. **选择器契约**：spec 只引用对照真实 DOM 核验过的 data-testid；新 UI testid 由 fe-dev PR 附清单，qa 按 DOM 复核后回填 §7.2（沿用 b21-22 §7.2 纪律）。
5. **窗口令牌制**：跑 E2E 前向 team-lead 申请（lsof :4445 + pgrep + dist 三项检查），用完汇报释放。
6. **视觉门禁硬性**：改动可见 UI 一律产出 dark/light/960×700 截图 + hy3 复评（对齐 b21-22 §0.6）。
7. **证据纪律**：截图 hash 去重（同 MD5 报错，防 M-2 复用缺陷复发）；破坏性用例用 `e2e_` 前缀 + 幂等重建。

---

## 一、Step 1 测试任务清单（v2.9.1 技术债清零）

> 目标：闭环 v2.9.0 全部遗留项（release-review §3 项 3/4/5 + postgres-query-commands B19 债），技术债归零后才进入 B23。

### 1.1 任务 1：`postgres-query-commands.e2e.ts` 实跑（B19 验证债）

**现状**：120 行 spec，标注 DEFERRED（R9 时写），选择器已对照真实 DOM 核验（postgres-run/stop/explain、.cm-editor、postgres-workspace、postgres-new-query）。

**执行**：
```bash
pnpm exec wdio run wdio.conf.ts --spec e2e/desktop/postgres-query-commands.e2e.ts
```
前置：向 team-lead 申请窗口令牌（lsof :4445 + pgrep + dist 三项检查）；PG fixture 127.0.0.1:55432 在线。

**3 个用例 + 预期断言核对表**：

| # | 用例 | 预期断言（spec 现状） | 核对项（qa 需对照实现确认） |
|---|---|---|---|
| Q-1 | Ctrl+Shift+R 运行当前语句 | `SELECT 1;\nSELECT 2;` 光标在末尾 → 只执行 SELECT 2 → 结果网格出现且首行值含 `2` | ① 核对 B19 快捷绑定：**运行=Ctrl+R、当前语句=Ctrl+Shift+R**（b19-20 组 11）与 spec 一致；② spec:90 注释「plain Ctrl+R is the app refresh path? No — scope router handles it」存疑——需核对 QUERY_EDITOR scope 下 Ctrl+R 是否无绑定（B20 语义）；③ 断言 SELECT 1 未执行（结果只有一行） |
| Q-2 | Ctrl+T 停止长查询 | `SELECT pg_sleep(30)` → 点 toolbar postgres-run → postgres-stop 出现 → Ctrl+T → stop 消失 → `SELECT 42` 结果网格复现（连接未挂） | ① Ctrl+T 停止绑定在 QUERY_EDITOR scope（b19-20 组 7）；② stop 后连接复用路径（B19 `postgres_query_cancel` 语义） |
| Q-3 | Ctrl+R 不劫持 | 编辑器内 Ctrl+R → 800ms 后无结果网格（plain Ctrl+R 未绑定） | ① 与 Q-1 的 Ctrl+Shift+R 对照验证 scope 路由正确；② 800ms 等待窗口是否足够（防假阴性，建议改为 waitUntil 反断言） |

**执行前需核对的风险点**：
- `setEditorSql`（spec:47-54）用 `Ctrl+A` + 逐字母 `browser.keys(sql.split(''))` 输入——需在 debug 二进制实测可用（CodeMirror contenteditable 收键）；若不稳定改为 CodeMirror 6 View API 注入（与 v29 spec 的 `browser.execute` 双保险模式对齐）。
- B21 后 `postgres-new-query` tab 类型扩展是否影响 Query tab 定位（spec:73 `[data-testid="postgres-new-query"]`）。
- 用例间状态耦合：Q-2/Q-3 复用 Q-1 的连接与编辑器，中间无 reconnect——若 Q-1 失败连坐 Q-2/Q-3，失败定位需看 spec 报告。

**通过标准**：3/3 通过 × 2 轮；核对表 ①/② 结论记录在案；spec 头部 DEFERRED 注释删除。

### 1.2 任务 2：mysql-workspace / sqlite-workspace / smoke 三 spec 状态评估

**评估表**（qa 读源码结论，实跑验证）：

| spec | 覆盖 | fixture 依赖 | 可跑性评估 | 结论 |
|---|---|---|---|---|
| `smoke.e2e.ts` | lock profile → Vault 打开 → aria-current 断言 + 截图 | **无**（纯 UI 冒烟） | 可跑，最快，无外部依赖 | **Step1 环境冒烟首选** |
| `sqlite-workspace.e2e.ts` | SQLite 连接（`NEXTERM_SQLITE_E2E_PATH`）→ 查询 Alice/Bob → sqlite-explain 不存在断言 → 对话框截图 → 删除连接（edit disabled） | SQLite fixture 由 `wdio.conf.ts` 自动生成（users/projects 表） | 可跑，无外部依赖；⚠️ spec:50 `$('button=users')` 在连接后立即查找，无显式等待 connect 完成——连接慢时有 flaky 风险，需实跑观察 | **可跑**，作 Step1 第二冒烟 |
| `mysql-workspace.e2e.ts` | MySQL 连接（127.0.0.1:33306）→ 大整数 `9007199254740993` + 高精度 decimal `1234567890.123456789` 精度保留 → mysql-explain 不存在 → 截图（dialog dark/light/small + workspace） | **MySQL 服务 127.0.0.1:33306 + `nexterm_e2e` 库 + users 表（id/name/balance/note，含大整数/decimal 数据）**——`wdio.conf.ts` **不自动生成** | **依赖外部 MySQL fixture**：需先 `lsof -i:33306` / 试连确认在线；若不在线登记为环境依赖（与 PG fixture 同模式，由环境方提供） | **环境依赖项**，fixture 在线才跑 |

**执行顺序**：smoke → sqlite-workspace → mysql-workspace（fixture 确认后）→ 1.1。

**各 spec 共同注意**：均用 `E2E_${Date.now()}` 密码初始化 lock → 每次独立 data-dir，隔离 OK；截图落盘 `test-results/database-visual/`，纳入 hash 去重检查（§0.7）。

### 1.3 任务 3：jump-persistence flaky 复现策略

**背景**（v290 §3-3）：`jump-persistence.test.ts` 全量 vitest 偶发失败——`saveConnectionWithId` 后 `setTimeout(r, 10)` 的 10ms settle 窗口与 mock 共享状态（ipc.DB）并发冲突；单独跑/复跑全绿。

**复现步骤**：
```bash
# 5 次连续单独跑，记录每次 pass/fail，计算失败率
for i in 1 2 3 4 5; do
  pnpm vitest run src/lib/__tests__/jump-persistence.test.ts 2>&1 | tail -3
done
# 然后全量跑 2 次观察是否复现（与 v290 复跑口径一致）
pnpm vitest --run
```

**验证/修复策略**：
1. **隔离性核对**：`beforeEach` 中 `resetConnectionsCache()` + `ipc.DB` 清空是否覆盖全部测试文件共享状态；检查是否有其他测试文件在 `ipc` 模块级共享 `DB`（跨文件串扰是首要嫌疑）。
2. **确定性替代**：`setTimeout(r, 10)` 为固定时序窗口——建议改为轮询 `persistAll` 落库完成的确定性信号（如等 `ipc.DB.connections` 行数变化或 await mock 的 persist promise），消除 10ms 竞态假设。
3. **通过标准**：5/5 单独连续通过 + 全量 vitest 跑 2 次全绿（含该文件 3 用例）。若仍偶发 → 登记为阻塞 Step1 的测试债，定位后再继续。

### 1.4 任务 4：v29 spec M-1/M-2 修复后重跑

**M-1（对象树未完整捕获）**：`01-object-tree.png` 只拍到函数平铺 + 序列折叠，「表」分组与四子组被滚动到可视区外（v290-visual-review §M-1）。修复方向：
- `v29-visual-capture.e2e.ts` it 01 截图前：展开 users 表四子组 + functions + sequences 后，**`scrollIntoView` 导航器首节点（表分组）**使层级结构整体入画；或临时放大窗口高度（如 2048×1600）保证 6 类对象同时可见。
- 复跑后人工/脚本检查截图像素：树层级可见（含 Columns/Indexes/Constraints/Triggers 子组 + 函数 + 序列）。

**M-2（截图复用缺陷）**：`07-small-dialog-fields.png` 与 `06-small-grouped-navigator.png` MD5 完全一致（v290 §M-2）。修复方向：
- spec 08 小窗步骤改为：**小窗下重新打开 ConnectionDialog**（点击 postgres-new-connection）→ 滚动到颜色/分组字段 → 再截图，杜绝复用导航器截图。
- **CI/脚本加截图 hash 去重检查**：同一 spec 运行产物中任意两图 MD5 相同 → 报错（防复发）。落点：`wdio.conf.ts` afterTest 或独立 node 脚本 `test-results/v29` 全量扫描。

**重跑命令**：
```bash
pnpm exec wdio run wdio.conf.ts --spec e2e/desktop/v29-visual-capture.e2e.ts
```
通过标准：M-1/M-2 对应截图内容正确 + hash 无重复 + hy3 复评（§1.5）。

### 1.5 任务 5：重截 v2.9.0 关键图 + hy3 复评清单

> B-1/B-2 两个视觉 Blocking 已在代码层修复（sonner.tsx Toast 自适应 / code-editor.tsx 长 SQL 横向滚动），但**修复后未重截图复评**（v290 §3-4）。本步补齐。

| # | 截图 | 内容 | 时态 |
|---|---|---|---|
| R-1 | 01-object-tree.png（M-1 修复后重截） | 六类对象树完整层级 | dark/2048×1200 |
| R-2 | 07-small-dialog-fields.png（M-2 修复后重截） | ConnectionDialog 颜色/分组字段**真实小窗** | 960×700 |
| R-3 | toast-small.png（B-1 修复后） | 小窗下 Toast 自适应（触发一个操作类 toast 截图） | 960×700 |
| R-4 | sql-long-line.png（B-2 修复后） | 长 SQL 横向滚动 + 浅色主题编辑器跟随主题 | 浅色/2048×1200 |
| R-5 | 06-light/small-grouped-navigator.png（回归） | 分组导航器浅色/小窗不回归 | 浅色/960×700 |

**hy3 复评**：五维（A 布局/B 主题/C 响应式/D 组件/E 对比度）逐张 PASS/FAIL；**全 PASS 才放行 v2.9.1 发布**；FAIL 项登记 BUG → 修复 → 重截 → 重评闭环。

### 1.6 任务 6：回归清单（B17-B22 全量）

**E2E 回归套件**（`maxInstances:1` 串行）：

| 顺序 | spec | 覆盖 | 备注 |
|---|---|---|---|
| 1 | `postgres-grid-edit.e2e.ts` | B17 编辑闭环 | ×2 轮 |
| 2 | `postgres-filter.e2e.ts` | B18 过滤/查找 | ×2 轮 |
| 3 | `postgres-visual.e2e.ts` | 视觉基线 + 连接回归 | 冒烟前置 |
| 4 | `b21-context-menu.e2e.ts` | 菜单 enablement + 断连态 | |
| 5 | `b21-navigator-objects.e2e.ts` | B21 六类对象 | 13 it |
| 6 | `b22-connections.e2e.ts` | B22 连接管理 | 7 it |

**自动化门禁五件套**：`tsc --noEmit` / `eslint src/` / `vitest --run`（×2 次全绿）/ `cargo test` / `i18n:check`。

**Step1 完成退出标准**：1.1-1.6 全部通过 + 视觉复评全 PASS + flaky 归零 → 进入 Step2。

---

## 二、Step 2 测试用例（B23 表设计器，v2.10.0 前）

> 定义（master-plan §6）：**PG 表设计器 + DDL 预览/回滚 + View Builder**；DoD = DDL diff 原生 E2E + 非法结构拒绝（US-09）。入口：导航器右键「设计表」（B21 中 disabled 占位激活）+ `database.object.design`（Ctrl+D，B20 hidden 命令激活）。**前提**：B21 的 `postgres_object_props/ddl` 只读底座复用，本批升级为可写。

### 2.1 Rust 单测（DDL 生成 / diff / 非法结构拒绝）

| # | 用例 | 断言 |
|---|---|---|
| DD-1 | 新增列 | 目标结构新增列 → `ALTER TABLE <schema>.<table> ADD COLUMN <name> <type> [NOT NULL] [DEFAULT x]`（quote_identifier 精确断言） |
| DD-2 | 改类型 | `ALTER COLUMN <name> TYPE <newtype> [USING ...]`（按实现定稿 USING 语义） |
| DD-3 | 可空性变更 | NOT NULL→可空 → `DROP NOT NULL`；可空→NOT NULL → `SET NOT NULL`（对已有 NULL 行数据的拒绝语义：Err 或降级按决策锁定） |
| DD-4 | 默认值变更 | `SET DEFAULT x` / `DROP DEFAULT` |
| DD-5 | PK 变更 | 修改 PK → `DROP CONSTRAINT <old_pk>; ADD CONSTRAINT <new_pk> PRIMARY KEY (...)` 两语句有序 |
| DD-6 | 约束增删 | CHECK/UNIQUE 增 → `ADD CONSTRAINT`；删 → `DROP CONSTRAINT`；语句与约束类型一一对应 |
| DD-7 | 索引增删 | 增 → `CREATE INDEX`；删 → `DROP INDEX`（非约束索引，注意与约束索引区分） |
| DD-8 | FK 增删 | 增 → `ADD CONSTRAINT ... FOREIGN KEY (...) REFERENCES ...`；删 → `DROP CONSTRAINT`（与 B24 删线共用语句形态） |
| DD-9 | diff 无变化 | 当前=目标 → 空 ALTER 列表（无多余 DDL） |
| DD-10 | diff 有序性 | 多变更（加列+改类型+加约束）→ 语句顺序稳定（列级先、约束后） |
| DD-11 | 重复列名 | 目标含重复列名 → Err（含列名），不生成 DDL |
| DD-12 | 删带数据列拒绝 | 目标删列但有数据（fixture 预置行）→ 拒绝语义：Err 或需显式 `cascade`（按产品决策锁定），无级联时**不触达 DB** |
| DD-13 | 空目标 | 全空结构 → 全 `DROP` 序列按依赖逆序（FK 先于表） |

### 2.2 vitest（设计器状态机 / 校验）

| # | 用例 | 断言 |
|---|---|---|
| DS-1 | 脏标记 | 任何字段编辑 → dirty=true；保存/回滚 → dirty=false；切换对象时 dirty 确认提示 |
| DS-2 | diff 触发 | 编辑触发 diff 重算；diff 结果供 DDL 预览渲染（只读文本，无 innerHTML） |
| DS-3 | 回滚 | 编辑后回滚 → 结构快照复原、dirty 清除、无 DDL 残留 |
| DS-4 | 类型校验 | 非法 PG 类型输入拒绝；长度/精度组合（numeric(p,s)/varchar(n)）校验 |
| DS-5 | 约束名唯一 | 约束名重复 → 拒绝；命名冲突提示 |
| DS-6 | 保存状态流 | 保存成功 → 清 dirty + 刷新结构；保存失败（权限/语法）→ 保留 dirty + 错误可见 |
| DS-7 | readOnly 拒绝 | readOnly 连接打开设计器 → 编辑 disabled / 保存拒绝（安全门禁回归） |

### 2.3 E2E（真实 PG fixture，新 spec `postgres-table-designer.e2e.ts`）

> fixture：建 `e2e_design_*` 表（独立于 B21 `e2e_orders`，幂等重建；含数据行以支撑「删带数据列拒绝」用例）。

| # | 用例 | 关键断言 |
|---|---|---|
| T-1 | 打开设计器 | 导航器右键表 → 「设计表」→ 设计器 tab 打开并回显当前结构（列/类型/可空/默认/PK/约束/索引/FK 各 tab） |
| T-2 | 入口等价 | Ctrl+D（DATA_GRID/NAVIGATOR scope）与右键「设计表」等价打开；B21 时 disabled 的菜单项现在 enabled |
| T-3 | 新增列 → 保存生效 | 新增列（type/可空/默认）→ DDL 预览断言 `ADD COLUMN` → 保存 → **psql 验证**（`pg_attribute` 查列存在 + 类型/可空/默认正确） |
| T-4 | 改类型 → 保存生效 | 改类型 → 预览断言 `ALTER COLUMN ... TYPE` → 保存 → psql 验证类型变更 |
| T-5 | 可空/默认值变更 | 预览断言 `SET/DROP NOT NULL`、`SET/DROP DEFAULT` → psql 验证 |
| T-6 | PK 变更 | 预览断言 DROP+ADD PRIMARY KEY 两语句 → 保存 → `pg_constraint contype='p'` 验证 |
| T-7 | CHECK/UNIQUE 约束增删 | 预览断言 `ADD/DROP CONSTRAINT` → 保存 → `pg_constraint` 验证 |
| T-8 | 索引增删 | 预览断言 `CREATE/DROP INDEX` → 保存 → `pg_indexes` 验证 |
| T-9 | FK 增删 | 预览断言 FK 语句 → 保存 → `pg_constraint contype='f'` 验证（**与 B24 共用语句形态**） |
| T-10 | 非法结构拒绝：删带数据列 | 删带数据列不勾选级联 → UI 明确拒绝（toast/红字）、**不产生 DDL 执行**；psql 验证列仍在 |
| T-11 | 非法结构拒绝：重复列名 | 重复列名 → 拒绝、无 DDL |
| T-12 | diff/回滚 | 编辑多步不保存 → 回滚 → 结构复原；切走 tab 时 dirty 确认对话框出现，取消不丢编辑 |
| T-13 | 保存后 DDL 幂等 | 保存 → 重开设计器 → 结构与保存结果一致（无多余 diff，DD-9 真库形态） |
| T-14 | View Builder | 新建视图（`CREATE VIEW ... AS SELECT`）→ DDL 预览 → 保存 → psql 验证视图存在 + 查询可用；编辑既有视图同样生效 |
| T-15 | 权限/readOnly | readOnly 连接 → 设计器编辑禁用/保存拒绝（DS-7 真库形态） |

### 2.4 B23 视觉门禁截图清单

| # | 界面 | 时态 | 评审要点 |
|---|---|---|---|
| V-B23-1 | 设计器字段列表（列/类型/可空/默认） | dark/light/960×700 | 表格布局、类型下拉、可空 checkbox |
| V-B23-2 | 约束/索引/FK tab | dark/light | tab 切换、条目密度 |
| V-B23-3 | DDL 预览面板 | dark/light | 只读高亮、长 ALTER 语句滚动（B-2 修复回归） |
| V-B23-4 | 非法结构拒绝态 | dark/light | 错误提示醒目度、表单不破坏 |
| V-B23-5 | View Builder | dark/light/960×700 | 画布 + SQL 预览布局 |

---

## 三、Step 3 测试用例（B24 ER 图，v2.10.0）

> 定义（master-plan §6）：**PG ER 图反向工程：关系线/拖拽/缩放/FK 设计删除**；DoD = ER 画布原生 E2E + 视觉门禁（US-08）。**前提**：B20 已注册 ER_DIAGRAM scope 三组快捷键（F5/Esc/H、R/Delete、Ctrl+=/-/0/滚轮），本批激活；21 项菜单 ER 2 项（Design FK/Delete FK）移交本批落地。

### 3.1 Rust 单测（ER FK 查询）

| # | 用例 | 断言 |
|---|---|---|
| ER-1 | FK 查询形态 | `pg_constraint contype='f'`，返回 源表/源列/引用表/引用列 四元组，参数化绑定、schema 白名单、无 ILIKE |
| ER-2 | 多 FK 表 | 含 2+ FK 的表返回全部关系线（数量断言） |
| ER-3 | 无 FK 表排除 | 无 FK 表不出现在关系线结果（节点仍渲染，线为空） |
| ER-4 | schema 过滤 | 指定 schema → 仅该 schema 的 FK（跨 schema 引用按实现定稿：引用另一 schema 的表仍显示或标注） |
| ER-5 | 空库 | 无任何表/FK → 空结果不报错 |

### 3.2 vitest（画布几何 / 交互状态机）

| # | 用例 | 断言 |
|---|---|---|
| EC-1 | 表节点渲染 | 节点位置/尺寸计算（网格对齐语义按实现）；表名/列名校验 |
| EC-2 | 拖拽移动 | 拖拽 → 位置增量更新；碰撞/边界钳制（按实现） |
| EC-3 | 缩放 | Ctrl+=/-/0 → scale 因子 clamp（如 0.2-3.0）；0 复位 |
| EC-4 | 平移 | 空白拖拽/H → viewport offset 更新 |
| EC-5 | FK 线几何 | 连线端点 = 源列→引用列坐标；曲线路径可算（bezier 或折线按实现）；无 FK 无线 |
| EC-6 | 选择态 | 单击节点选中高亮；Esc 取消选择；H 进入平移模式 |
| EC-7 | 快捷键 scope | R/Delete/Ctrl+=/-/0/F5 仅 ER_DIAGRAM 生效；编辑器/输入框内 R 正常输入（b19-20 SB-10 回归） |

### 3.3 E2E（真实 PG fixture，新 spec `postgres-er-diagram.e2e.ts`）

> fixture：复用 `e2e_orders.customer_id → users.id` FK + 预置第二 FK（`e2e_design_child` 连 `e2e_design_parent`，独立命名供删线用例后重建）。

| # | 用例 | 关键断言 |
|---|---|---|
| E-ER-1 | 打开 ER | 入口（导航器/右键「打开 ER 图」按实现）→ ER workspace 打开，fixture 表节点渲染（表名 + 列名可见） |
| E-ER-2 | 关系线正确性 | `e2e_orders`→`users` 出现连线；无 FK 表无连线（连线数量/端点断言） |
| E-ER-3 | 拖拽 | 拖动 `users` 节点 → 位置变化（DOM transform/style 断言） |
| E-ER-4 | 缩放 | Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 复位 → scale 断言；Ctrl+滚轮缩放抽样 |
| E-ER-5 | 平移 | 空白拖拽 / H → viewport offset 变化；Esc 取消平移模式 |
| E-ER-6 | 删线=删 FK | ER 中选中 FK 线 → Delete/右键「删除外键」→ DDL 预览断言 `ALTER TABLE e2e_design_child DROP CONSTRAINT <fk_name>` → 确认 → **psql 验证 `pg_constraint contype='f'` 约束消失**；取消路径约束仍在 |
| E-ER-7 | 新建 FK | R 进入连 FK 模式 → 源表列→引用表列 → DDL 预览断言 `ADD CONSTRAINT ... FOREIGN KEY` → 保存 → psql 验证 FK 出现 |
| E-ER-8 | 刷新 | F5 → 新建表/FK 后刷新 → 节点/关系线出现（重拉 catalog） |
| E-ER-9 | 21 项菜单闭环 | ER 2 项（Design/Delete Foreign Key）落地后逐项核对 enabled/disabled（b21-22 §4.2 #20-21 从移交→落地） |
| E-ER-10 | 断连态 | 断开连接 → ER 画布只读（无新增/删除 FK）或关闭，无崩溃 |

### 3.4 B24 视觉门禁截图清单

| # | 界面 | 时态 | 评审要点 |
|---|---|---|---|
| V-B24-1 | ER 画布全貌（多表+FK 线） | dark/light/2048×1200 | 节点布局、连线可读性、表名/列名清晰度 |
| V-B24-2 | FK 线高亮/选中态 | dark/light | 选中线样式、Delete 按钮可见性 |
| V-B24-3 | 缩放态 | dark/light | 缩小/放大后节点文字可读性（防像素糊） |
| V-B24-4 | 新建 FK 预览 | dark/light/960×700 | DDL 预览面板与画布同屏布局 |

---

## 四、分层策略总表

| 层 | 被测对象 | 用例形态 | Step1 | Step2 B23 | Step3 B24 |
|---|---|---|---|---|---|
| Rust 单测（cargo） | DDL 生成/diff/ER FK 查询/非法拒绝（§2.1/§3.1） | `cargo test postgres` | —（无新 Rust 改动） | DD-1..13 | ER-1..5 |
| vitest 纯函数 | 设计器状态机/校验/画布几何/快捷键 scope（§2.2/§3.2） | `src/lib/__tests__/` | jump-persistence 复现（§1.3） | DS-1..7 | EC-1..7 |
| 原生 E2E | 全链路（§1.1/§2.3/§3.3） | WDIO spec | query-commands + 三 spec 评估 + v29 重截 | table-designer spec（T-1..15） | er-diagram spec（E-ER-1..10） |
| 视觉门禁 | 截图 + hy3 复评（§1.5/§2.4/§3.4） | 截图落盘 + 五维评审 | R-1..R-5 | V-B23-1..5 | V-B24-1..4 |
| 回归 | §6 清单 | 全量 | 必跑 | 必跑 | 必跑 |

**协作点**：B23/B24 Rust 测试可先行（DDL/diff/FK 查询纯函数，fe-dev 定稿签名后 qa 回填断言）；vitest 状态机在 UI 落地前可先行；E2E 需等 UI testid 清单（§7.2 契约）。

---

## 五、E2E 执行顺序与依赖

### 5.1 Step1（v2.9.1）执行顺序

| 顺序 | 动作 | fixture | 前置/依赖 |
|---|---|---|---|
| 1 | smoke.e2e.ts | 无 | WDIO 环境冒烟（最快） |
| 2 | sqlite-workspace.e2e.ts | SQLite（conf 自动生成） | 1 通过 |
| 3 | postgres-query-commands.e2e.ts | PG 55432 | 窗口令牌 + PG 在线 |
| 4 | mysql-workspace.e2e.ts | **MySQL 33306（需先确认在线）** | `lsof -i:33306` 检查；不在线登记环境依赖 |
| 5 | v29-visual-capture.e2e.ts（M-1/M-2 修复后） | PG 55432 | 3 通过 + spec 修复 |
| 6 | 回归套件（§1.6） | 全量 | 上述全过 |
| 7 | 截图 hash 去重脚本 | 全量产物 | 5/6 之后扫 `test-results/v29` 与 `database-visual` |

### 5.2 Step2（B23）执行顺序

| 顺序 | 动作 | 前置/依赖 |
|---|---|---|
| 1 | **fixture 准备**：建 `e2e_design_*` 表 SQL（幂等，含数据行支撑删列拒绝用例） | 无 |
| 2 | Rust 单测 DD-1..13（可先行） | fe-dev 定稿 DDL 生成签名 |
| 3 | vitest DS-1..7（可先行） | 状态机接口定稿 |
| 4 | 新 spec `postgres-table-designer.e2e.ts` T-1..15 | testid 清单核验 + 窗口令牌 |
| 5 | 视觉门禁 V-B23-1..5 + hy3 复评 | 4 通过 |
| 6 | **回归（§6 Step2 清单）** | 上述全过 |

### 5.3 Step3（B24）执行顺序

| 顺序 | 动作 | 前置/依赖 |
|---|---|---|
| 1 | Rust 单测 ER-1..5（可先行） | FK 查询签名定稿 |
| 2 | vitest EC-1..7（可先行） | 画布 API 定稿 |
| 3 | fixture：确认 `e2e_orders` FK + 预置 `e2e_design_child/parent` 第二 FK | 无 |
| 4 | 新 spec `postgres-er-diagram.e2e.ts` E-ER-1..10 | testid 清单 + 窗口令牌 |
| 5 | 视觉门禁 V-B24-1..4 + hy3 复评 | 4 通过 |
| 6 | **回归（§6 Step3 清单 = Step2 + Step3 全量）** | 上述全过 |
| 7 | v2.10.0 发布门禁：全套截图 + hy3 全 PASS + 台账登记 | 全绿 |

---

## 六、回归完整性（每 Step 结束必跑）

> 用户硬门禁「每步无遗留」：Step 未全量回归通过前不得进入下一步；上一步新功能并入下一步回归基线。

| 域 | 项目 | Step1 | Step2 | Step3 |
|---|---|---|---|---|
| 自动化五件套 | `tsc --noEmit` / `eslint src/` / `vitest --run`×2 / `cargo test` / `i18n:check` | ✔ | ✔ | ✔ |
| B17 编辑闭环 | `postgres-grid-edit.e2e.ts` ×2 | ✔ | ✔ | ✔ |
| B18 过滤 | `postgres-filter.e2e.ts` + filter 单测 | ✔ | ✔ | ✔ |
| B19 查询命令 | `postgres-query-commands.e2e.ts` | ✔（本步修） | ✔ | ✔ |
| B20 快捷键 | `scope-router`/`shortcut-bindings` 单测；Ctrl+D/ER 三组从 hidden→激活后路由回归；终端 TR-1..5 | ✔ | ✔（Ctrl+D 激活） | ✔（ER 激活） |
| B21 导航器对象 | `b21-context-menu` + `b21-navigator-objects`（13 it） | ✔ | ✔ | ✔ |
| B22 连接管理 | `b22-connections`（7 it）+ 存储单测 | ✔ | ✔ | ✔ |
| 上一步新功能 | Step1→B23 spec；Step2→B23+B24 spec | — | T-1..15 | T-1..15 + E-ER-1..10 |
| 视觉一致性 | 新界面截图与既有同源调色板无漂移（CSS 变量）；截图 hash 去重 | ✔ | ✔ | ✔ |
| 21 项菜单核对 | 受影响域逐项核对（B23：设计表入口；B24：ER 2 项） | ✔（抽检） | ✔ | ✔ |
| flaky 归零 | 全量 vitest 连续 2 次全绿；jump-persistence 5/5 | ✔ | ✔ | ✔ |

**发布门禁（v2.9.1 与 v2.10.0 通用）**：自动化五件套全绿 + 真实 E2E 全量通过 + 视觉门禁 hy3 全 PASS + 无 FAIL/Blocking + 台账登记完成 → READY。

---

## 7. 选择器契约与风险登记

### 7.1 已核验 testid（沿用 b21-22 §7.2.1，Step1 直接引用）

`postgres-workspace` / `postgres-run` / `postgres-stop` / `postgres-explain` / `postgres-new-query` / `postgres-new-connection` / `postgres-connection-dialog` / `postgres-refresh` / `postgres-disconnect` / `database-navigator-context-menu` / `app-lock-password` / `app-lock-confirm` / `app-lock-submit` / `sqlite-workspace` / `sqlite-new-connection` / `sqlite-connection-dialog` / `sqlite-run` / `sqlite-disconnect` / `sqlite-edit-connection` / `sqlite-delete-connection` / `mysql-workspace` / `mysql-run` / `mysql-connection-dialog` / `mysql-new-connection` / `mysql-disconnect`。

### 7.2 新增 testid 建议命名（B23/B24，供 fe-dev 参考，qa 按真实 DOM 复核后回填）

- B23：`table-designer-*`（字段表 `table-designer-fields` / 类型下拉 / 可空 checkbox / 默认值 input）、`table-designer-tab-constraints|indexes|foreign-keys`、`ddl-preview` / `ddl-preview-panel`、`designer-save` / `designer-revert`、`view-builder-*`。
- B24：`er-workspace` / `er-canvas` / `er-table-node`（`data-table-id` 标注）/ `er-relation-line` / `er-zoom-in|out|reset` / `er-new-fk` / `er-delete-fk`。

### 7.3 风险登记

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `setEditorSql`（query-commands spec）在 debug 二进制不稳定 | 改为 CodeMirror API 注入双保险（v29 spec 模式） |
| R2 | MySQL 33306 fixture 在线状态未确认 | Step1 任务 2 先 `lsof -i:33306` 探活；不在线登记环境依赖不阻塞其他任务 |
| R3 | sqlite-workspace `$('button=users')` 连接后无等待（spec:50） | 实跑观察，flaky 则加 waitForDisplayed |
| R4 | jump-persistence flaky 修复依赖 `persistAll` 落库信号改造（改 connection-storage 测试层） | 若判定需改源码，报 team-lead 仲裁（测试隔离改动最小化） |
| R5 | B23 diff 引擎「删带数据列」产品语义未定（拒绝 or 需级联） | 用例 DD-12 标注按产品决策锁定，dev 实现定稿后回填 |
| R6 | B24 ER 画布交互（拖拽/缩放）在 WDIO 的 DOM 断言稳定性 | 断言放宽为 transform/style 变化 + 视觉门禁佐证（hy3 像素级） |
| R7 | 新增 spec 均为全链路长时（150s timeout），失败定位成本高 | 遵循 b19-20 §6.2 选择器纪律：唯一值、相对断言、连接复用、破坏性用例幂等重建 |

---

## 8. 覆盖统计（计划态）

| 层 | Step1 | Step2 B23 | Step3 B24 |
|---|---|---|---|
| Rust 单测 | — | DD 13 | ER 5 |
| vitest | jump-persistence 3（复现）+ 全量回归 | DS 7 | EC 7 |
| E2E | query-commands 3 + 三 spec 评估 3 + v29 重截 | T 15 | E-ER 10 |
| 视觉门禁 | R 5 张 + hy3 复评 | V-B23 5 | V-B24 4 |
| 回归 | §1.6 全量 | §6 Step2 | §6 Step3 |

---

## 9. 依赖与协作点

| 项 | 说明 |
|---|---|
| 等 team-lead | E2E 窗口令牌（跑前申请/跑后释放）；Step 放行决策；jump-persistence 修复是否需要改源码的仲裁（R4） |
| 等 fe-dev | B23/B24 Rust DDL 生成/diff/FK 查询签名；设计器/ER UI testid 清单（§7.2）；「删带数据列」语义裁定 |
| 等 pm | 「删带数据列」产品语义（拒绝 vs 显式级联）锁定（R5）；v2.10.0 发布归属登记 |
| 等 security | B23/B24 破坏性操作（保存 DDL/删 FK）沿用 confirmed 门禁 + readOnly 双层拦截的红线核验 |
| 与 architect | B23/B24 命令 scope（`database.object.design` / `database.er.*` 从 hidden→激活）路由回归共同验收 |
