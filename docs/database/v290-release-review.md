# NexTerm v2.9.0 五方发布评审报告

> 评审协调：general-purpose-23｜2026-08-26
> 评审对象：M2 收官发布 v2.9.0（B21 导航器对象全覆盖 + B22 连接管理 + 回归修复 + 视觉门禁修复）
> 代码状态：HEAD=1f15556（v2.8.0），工作树含 M2 全部变更（43 处未提交，含 17 个新文件）
> 评审依据：`batch-21-22-sprint-plan.md`（105 AC）、`b21-22-architecture-constraints.md`（D-B21-x/D-B22-x）、`b21-22-security-constraints.md`（红线）、`b21-22-test-plan.md`、`v290-visual-review.md`（hy3 视觉评审）、fe-dev/fe-dev2/CTO 汇报、实测自动化门禁与 E2E 证据

---

## 1. 五方评审总览

| 方 | 结论 | 一句话理由 |
|---|---|---|
| 产品（pm） | **PASS** | 105 AC 全覆盖，导航器六类对象入树 + 连接管理（颜色/分组/导入导出/批量测试）达成 Navicat 对齐，B21/B22 用户价值全部交付 |
| 架构（architect） | **PASS** | D-B21-1..12 / D-B22-1..7 逐项落地，`postgres_catalog.rs` 新域模块成立，tool-postgres.tsx 单所有者文件边界零冲突，与 B20 命令体系/懒加载架构兼容 |
| 安全（security） | **PASS** | 红线全符合：Drop 白名单化专用命令 + 服务端 confirmed 门禁、导入导出 AES-GCM 脱密、批量测试并发上限 + 错误脱敏、catalog 六类查询全参数化 + 权限守卫，无新增注入面 |
| QA（qa） | **PASS** | 自动化门禁全绿（tsc/eslint/i18n/cargo 实测 0 失败，vitest 784 全绿、1 个并发时序 flaky 复跑通过）+ 真实 E2E 全套通过（b21 13/13×2、b22 7/7×2 等）+ 视觉门禁 PASS WITH NOTES（2 Blocking 已修复） |
| Release（汇总） | **READY** | 无阻塞缺陷，发布前置动作（版本 bump + 台账登记）列入执行清单；遗留项均为发布流程/测试侧改进，不构成延期理由 |

---

## 2. 每方评审依据

### 2.1 产品（pm）—— PASS

**依据**（`batch-21-22-sprint-plan.md` §3-10，105 AC 矩阵）：

- **B21 用户价值**：六类对象（函数/序列/索引/约束/触发器/列）入树 + 对象查看器 + 按对象启用的确认菜单 + 复制名/刷新/生成 DDL/Drop 全链路（AC-21A/B/C）。
- **B22 用户价值**：连接颜色/虚拟分组/导入导出/批量测试/重连 + 状态徽标（AC-22A/B/C）。
- **DoD 证据**：fe-dev B21 13/13 E2E、fe-dev2 B22 7/7 E2E 均双跑通过（`b21-navigator-objects.e2e.ts` 13 it、`b22-connections.e2e.ts` 7 it，spec 已核实）。
- **Navicat 对齐**：21 项确认菜单逐项核对闭环（toolbar 2 项本批落地、data grid 14 项维持回归、query builder 6 项 / ER 2 项移交 B23/B24）；[UNVERIFIED] 项全部按 [NexTerm] 规格登记，不声称 parity（§5.2/§5.3）。
- **范围裁定**：B23/B24 顺延登记，不含 AI/BI/Collab，发布叙事与 master-plan §6 一致。

### 2.2 架构（architect）—— PASS

**依据**（`b21-22-architecture-constraints.md` D-B21-x/D-B22-x + 工作树文件核实）：

| 决策 | 落地核实 |
|---|---|
| D-B21-1/2/3 节点模型扩展 | `types.ts` Role/IconRole 六类扩展；group value 枚举扩展，未新增 node kind；id 约定沿用 `createDatabaseObjectNodeId` |
| D-B21-4/5/8 catalog 域新命令 | **`src-tauri/src/postgres_catalog.rs` 新模块就位**（catalog_objects/object_props/object_ddl/drop_object），未堆叠进 `commands.rs`；懒加载保持（组节点纯静态，展开才请求） |
| D-B21-6/7 双击/Enter 语义 | `database-navigator.tsx` 单击=select、双击=onOpen、Enter=onOpen；对象查看器 `object-viewer-tab.tsx` 新文件就位（只读 DDL + 属性） |
| D-B21-9/10/12 菜单与命令 | 菜单按 objectRole 分支走 `resolveDatabaseCommand`；Drop 统一 AlertDialog 二次确认；11 个新 command descriptor 注册（NAVIGATOR scope） |
| D-B22-1/2 颜色/分组存储 | profile `color` 字段 + SQLite 列扩展（PG/SQLite/MySQL 同构）；虚拟分组复用 group 字段，无独立表 |
| D-B22-3/4/5 导入导出 | `src/lib/connections-io.ts` 就位：JSON 单文件、默认脱密 + 可选 AES-GCM、merge/替换策略 |
| D-B22-6/7 测试/重连/状态 | `postgres_connection_manager.tsx` 就位；批量测试并发上限 + 不写 clients map；Reconnect 复用既有 connect 流程 |

- **文件边界**：tool-postgres.tsx 单所有者（fe-dev），database-navigator.tsx/command-registry.ts/storage（fe-dev2），`src/lib/i18n.ts` fe-dev 独占——无冲突登记。
- **B20 兼容**：Command Resolver 不执行命令；NAVIGATOR scope 是唯一新增接线点；Enter 处理在 navigator 聚焦下接管，无双重拦截。

### 2.3 安全（security）—— PASS

**依据**（`b21-22-security-constraints.md` 红线 §1-6 + 实现核实）：

- **catalog 六类查询（§1）**：全参数化绑定；kind 白名单短路；`has_schema_privilege` 守卫；schema 白名单校验；limit clamp(1,100)。column 分支权限守卫补齐。
- **破坏性操作（§2）**：Drop 走 `postgres_drop_object` 专用命令（白名单 kind→DDL 模板 + quote_identifier），**前端无拼 SQL 路径**；服务端 confirmed 门禁 + dry-run 存在性校验 + TOCTOU 重校验；CASCADE 显式化；readOnly 双层拦截；DELETE 行级仍走 `postgres_table_delete`（无旁路）。
- **DDL 预览（§3）**：专用命令服务端解析 oid，不接收前端 oid/SQL；权限错误通用化（不透传底层细节）；渲染仅文本节点（无 innerHTML 路径）；不落日志。
- **导入导出（§4）**：默认脱密导出（密码置空 + `__hasPassword` 标记），可选 AES-GCM 加密封套（截图 #5 实测确认「加密导出 (AES-GCM)」UI）；导入大小/深度/字段白名单/原型键净化；替换导入全量校验通过才替换（无半删态）+ 二次确认；路径仅 dialog 来源。
- **批量测试（§5）**：前端并发 ≤5、错误 message 脱敏（host/port/db/username + 错误分类，无凭据）、不写入 clients map、测试连接用完即 drop。
- **分组/颜色（§6）**：分组名长度/分隔符/`..` 校验；颜色 hex 白名单；渲染无 innerHTML。
- **无新增注入面**：安全文档 §7 禁止回退清单 15 项逐项自查通过。

### 2.4 QA（qa）—— PASS（含 1 个 flaky 观察项）

**依据**（`b21-22-test-plan.md` + 实测复跑 + team-lead/fe-dev 汇报）：

**自动化门禁（本报告实测复跑）**：

| 门禁 | 结果 | 验证方式 |
|---|---|---|
| `tsc --noEmit` | **0 error** | 实测 exit 0 |
| `vitest --run` | **784 tests / 91 files 全绿** | 实测 2 次：首次 1 个 flaky（jump-persistence）复跑全绿 |
| `cargo test` | **278 passed / 0 failed** | 实测（src-tauri） |
| `i18n:check` | **1995 keys parity** | 实测通过 |
| `eslint src/` | **0 error** | 实测 exit 0 |

**真实 E2E（原生 WDIO + debug 二进制 + 真实 PG fixture）**：

| spec | 结果 |
|---|---|
| `b21-navigator-objects.e2e.ts` | 13/13 × 2 轮通过（AC-21A 全覆盖） |
| `b22-connections.e2e.ts` | 7/7 × 2 轮通过（AC-22B/C 导入导出/测试/重连） |
| `postgres-grid-edit.e2e.ts` | 1/1 × 2 通过（B17 回归） |
| `postgres-visual.e2e.ts` | 通过（视觉冒烟 + 连接回归） |
| `postgres-filter.e2e.ts` | 通过（B18 回归） |
| `b21-context-menu.e2e.ts` | 通过（菜单 enablement + 断连态） |

**视觉门禁**（`v290-visual-review.md`）：10 张真实截图 hy3 评审 **PASS WITH NOTES**（PASS=33, WARN=12, FAIL=2 均集中响应式维度）；**2 个 Blocking 已修复并核实**：
- B-1 Toast 小窗自适应 → `sonner.tsx`（maxWidth `min(360px, calc(100vw-32px))` + marginTop 40px，diff 已核实）
- B-2 SQL/DDL 编辑器水平滚动 → `code-editor.tsx`（SQL 语言默认关 wordWrap，长行横向滚动；附带修复浅色主题下编辑器跟随主题，diff 已核实）

**回归完整性**：B17（grid-edit×2）、B18（postgres-filter）、B20 scope 回归覆盖；`navicat-premium-context-menus.md` 21 项核对闭环。

### 2.5 Release（汇总）—— READY

- **无 Blocking 缺陷**：2 个视觉 Blocking 已修复（代码 diff 核实）；无 FAIL 级视觉缺陷；无安全红线违反；无架构偏差；无 AC 缺口。
- **风险等级：低**。唯一产品侧留意项为 jump-persistence flaky（非本批改动面，见 §3-3）。

---

## 3. 遗留项清单

| # | 类别 | 项 | 影响 | 处理 |
|---|---|---|---|---|
| 1 | 发布动作 | **版本号未 bump**：`package.json` / `src-tauri/tauri.conf.json` 仍为 2.8.0 | 发布必需 | 发布时手动改 2.9.0（勿跑 `version:minor` 脚本） |
| 2 | 发布动作 | **台账登记未完成**：`navicat-parity-master-plan.md` §6/Scorecard、`database-development-status.md`（无 B21/B22 记录）、context-menus.md（PARTIAL 登记）、interactions.md、feature-matrix.md、AGENTS.md | 发布收口 | 合入后按 DoD §8 逐项更新（CHANGELOG Unreleased 已就绪） |
| 3 | 测试（观察） | **jump-persistence.test.ts 并发 flaky**：全量 vitest 偶发失败（异步 persist 时序竞态，`saveConnectionWithId` 后 10ms settle 窗口与 mock 共享状态冲突）；单独/复跑全绿，`connection-storage.ts` 无本批改动 | 低 | 归入测试隔离改进（resetConnectionsCache + persist 竞态），发布后专项修 |
| 4 | 视觉（建议） | **2 Blocking 修复后未重截图复评**：修复为局部 CSS/配置（sonner.tsx/code-editor.tsx），diff 核实合理 | 低 | 建议发布前对修复界面重截 2 张（小窗 Toast + 长 SQL）复评确认 |
| 5 | 测试侧（Major） | **截图捕获缺陷**：`07-small-dialog-fields.png` 与 `06-small-grouped-navigator.png` MD5 一致（复用截图），ConnectionDialog 小窗字段未真实捕获 | 低（测试侧） | E2E 补真实小窗 ConnectionDialog 截图 + CI 截图 hash 去重检查 |
| 6 | Minor | 浅色主题下编辑器配色（已随 B-2 修复为跟随主题）、#1 截图树形未完整展开（捕获策略）、术语「六类 vs 五类」（文档统一为五类对象组 + 表内四子组） | 不阻塞 | 随文档/捕获改进处理 |

---

## 4. 最终发布决策

**结论：READY —— 批准发布 v2.9.0（M2 收官）**

- 五方评审 5/5 PASS；视觉门禁 PASS WITH NOTES（2 Blocking 已修复）；
- 自动化门禁实测全绿（tsc 0 / vitest 784 / cargo 278 / i18n 1995 keys / eslint 0）；
- 真实 E2E 全套通过（B21+B22+回归）；
- 无阻塞缺陷、无安全红线违反、无架构偏差、无 AC 缺口。

**发布执行前置（合入 main 时一并完成）**：
1. 手动 bump 版本号至 2.9.0（package.json + tauri.conf.json）；
2. 台账登记（master-plan §6、development-status、context-menus PARTIAL、interactions、feature-matrix、AGENTS.md）；
3. （建议）视觉复评 2 张修复后截图确认 Blocking 关闭。

**后续改进（不阻塞本发布）**：jump-persistence flaky 测试隔离、E2E 截图 hash 去重、ConnectionDialog 小窗真实截图补充。
