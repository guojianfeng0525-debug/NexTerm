# NexTerm × Navicat Premium 对标全流程规划（需求 → 发布）

> 主控规划（Master Plan）。本文件是"从需求到发布"的总控层：定义范围、功能树、优先级、用户故事、架构决策、User Visible Slice 批次路线、快捷键/操作习惯对标、质量门禁、发布计划与风险登记。
> 细节以既有审计为准：`navicat-premium-audit.md`（审计）、`navicat-premium-feature-matrix.md`（74 项矩阵）、`navicat-premium-interactions.md`（34 项交互）、`navicat-premium-context-menus.md`（21 项确认菜单）、`navicat-premium-shortcuts.md`（18 组快捷键 + 冲突矩阵）、`database-roadmap.md`（架构路线图）、`database-development-status.md`（开发状态）。
> 状态：PLANNING（待批准后进入实现）。批准纪律：每个 Atomic Capability 实现前需批准（沿用 roadmap 纪律）。

---

## 1. 目标与范围

### 1.1 目标

把 NexTerm 数据库工具箱从"PostgreSQL 完整 + SQLite/MySQL 实验性"推进到**对标 Navicat Premium 17.3 Enterprise 的日常全功能**：连接管理、数据浏览/编辑、查询、对象设计、ER 图、导入导出、备份恢复、传输/同步、数据生成/字典、服务器管理、自动化，并**对齐 Navicat 的快捷键与操作习惯**（Windows 手册基线，macOS 映射为 ⌘ 等价，Linux 沿用 Ctrl）。

### 1.2 范围边界（用户决策）

| 项 | 决策 |
|---|---|
| ✅ 纳入 | 全部关系型/文档/键值数据库功能（Feature Matrix 中除 AI/BI/Collab 外 68 项） |
| ✅ 纳入 | 快捷键、操作习惯、上下文菜单、鼠标交互对齐 |
| ❌ 排除 | AI（FM `AI-01`/`AI-02`）、BI（FM `BI-01`）、Collaboration（FM `CO-01/02/03`）——产品决策，后续单独立项 |
| ❌ 排除 | 云端服务商预设认证（FM `DB-11..15` 的云直连）——依赖外部凭据体系，P2 后评估 |
| ⏸ 保留 | 已有安全基线：凭据 AES-GCM 加密、SSH 隧道指纹 fail-closed、全链路禁用 zlib、日志禁打密码 |

### 1.3 约束（沿用架构纪律）

1. 现有共享 Provider Core 优先，禁止为"理想架构"重写
2. 最小改动、成熟技术优先；不建无调用方的抽象
3. 无假 provider 进生产 registry
4. `Command Resolver` 不执行命令
5. 浏览器 E2E 不是原生桌面 E2E 的替代
6. 每个 Feature Batch 窄范围、独立验证、更新全部审计台账
7. 不破坏终端快捷键/IME；数据库快捷键按 scope 路由，终端 wins 于终端 scope

---

## 2. Phase 0 审计基线（2026-08-26）

### 2.1 已有关资产（不要重复造）

- **12 份对标文档**（见头注）：Feature Matrix / Interactions / Context Menus / Shortcuts / Audit / Roadmap / Status / Provider Capabilities / Coupling / Navigator / Usability / Shared Core Design
- **16 个 Feature Batch 完成**：共享 Core（registry/profile/command/object model/workspace shell/dialog shell）→ PG 完整 provider → SQLite/MySQL 实验性 P0 → 视觉一致性 → 原生稳定性 → 导航器对象覆盖
- **架构已埋 scope 概念**：`src/lib/database/command-registry.ts` 已有 `QUERY_EDITOR`/`DATA_GRID` scopes 与 enablement
- **网格基础**：`database-result-pane.tsx` 支持双击编辑（Escape 取消）、PK 列只读、`renderContextMenu` 挂载点；`tool-postgres.tsx` 已接 `onEditCell`（readOnly 连接禁用）
- **快捷键系统**：`keyboard-shortcuts.ts` 全局注册器（macOS 自动 Ctrl→⌘ 等价）、终端 `ignoreInTerminal` 保护

### 2.2 Scorecard（审计日基线）

| 指标 | 值 | 说明 |
|---|---|---|
| Provider 覆盖 | 1/16 官方族 | PG 完整；SQLite/MySQL 实验性 P0 |
| Feature FULL / PARTIAL / UI_ONLY / MISSING | 0 / 9 / 1 / 64 | 严格定义，无 FULL |
| Interaction MISSING | 25/34 | 确认交互清单 |
| Shortcut Parity | 0% | 无任何 Navicat 数据库绑定 |
| Context Menu Parity | 0% | 有挂载点无内容 |
| 数据网格 | 只读 + 双击编辑基础 | 无增删改/撤销/过滤/排序/复制粘贴/NULL |
| 查询 | 执行 + 文本 EXPLAIN | 无当前语句/停止/格式化/参数/snippet/Find Builder |
| 导航器 | schema + 表/视图/物化视图 | 函数/序列/索引/约束/触发器/列未覆盖 |
| 未启动 | form view / 设计器 / ER / 导入导出 / 备份 / 传输同步 / 字典 / 自动化 / 服务器管理 / SQLServer / Oracle / MongoDB / Redis / 模型 / 调试器 | — |

---

## 3. 需求层：功能树与优先级

### 3.1 功能树（8 大域，括号为 Feature Matrix ID 数）

```
NexTerm 数据库平台（对标 Navicat Premium 17.3）
├── D1 连接管理 (CN-01..08)        ── SSH/TLS/隧道、profile、颜色、虚拟分组、导入导出、批量操作、URI
├── D2 数据编辑 (DE-01..08)        ── 网格/表单/JSON 视图、编辑闭环、过滤排序查找、值查看器、profile 颜色
├── D3 查询 (QY-01..08)            ── 编辑器、补全/snippet、构建器/Find/Aggregate、Visual Explain、结果 pin、格式化、参数查询
├── D4 对象设计 (OD-01..03, OT-01) ── 表/视图设计器、ER 图、调试器
├── D5 传输与迁移 (SY-01..06)      ── 结构同步、数据传输、数据同步、数据生成、数据字典、跨库复制粘贴
├── D6 备份恢复 (BR-01..03)        ── PG/MySQL/SQLite/Redis 备份恢复、转 SQL
├── D7 自动化与服务器 (AU-01..02, SM-01..02) ── 调度、批量任务、用户管理、监控
├── D8 Provider 家族 (DB-01..15)   ── MySQL/MariaDB、SQLite、SQL Server、Oracle、MongoDB、Redis、兼容引擎
└── X 横切：快捷键 / 上下文菜单 / 操作习惯 / 视觉一致性 / 安全基线 / i18n
```

### 3.2 P0 / P1 / P2 映射（依据：用户价值 × 对标核心体验 × 依赖）

| 优先级 | 能力 | 依据 |
|---|---|---|
| **P0** | 数据网格完整编辑闭环（增删改/保存/撤销/NULL/UUID/复制粘贴/多选/脏确认）`DE-01,07,08,09-17` | Navicat 每日核心操作，无此不成 Navicat |
| **P0** | 查询编辑器命令（当前语句/停止/格式化/注释/Find Builder/参数/snippet/标识符面板）`QY-01,02,07,08` | 日常核心 |
| **P0** | 数据库 scope 快捷键体系 + 18 组 Navicat 绑定 | 用户明确要求"包括快捷键" |
| **P0** | 导航器对象全覆盖 + Navicat 确认菜单（21 项按对象启用） | 操作习惯核心 |
| **P0** | 过滤/排序/查找（字段值/自定义/全局 Find）`DE-07` | 数据操作核心 |
| **P0** | 连接管理完善：颜色、虚拟分组、导入导出、批量测试/重连 `CN-04,06,07` | 连接是入口 |
| **P0** | 表设计器 + DDL 预览 + View Builder `OD-01,03` | 对象设计核心 |
| **P0** | ER 图反向工程 `OT-01` | Navicat 招牌能力 |
| **P0** | 导入导出（TXT/CSV/JSON/XML 向导）`IE-01` | 高频刚需 |
| **P0** | 备份/恢复（PG/MySQL/SQLite）`BR-01,02` | 高频刚需 |
| **P1** | MySQL 完整 provider（实验性→parity） | 对标覆盖 16 族，MySQL 是最大缺口 |
| **P1** | 结构同步 / 数据传输 / 数据同步 / 跨库复制粘贴 `SY-01,02,03,06` | 迁移场景 |
| **P1** | 表单视图 + 值查看器（文本/hex/图像/网页）`DE-02,05` | 编辑体验 |
| **P1** | 查询构建器 / Find Builder `QY-03,04` | 复杂查询 |
| **P1** | SQLite 完整 provider | 本地场景 |
| **P1** | 服务器管理（PG 用户/角色 + 监控）`SM-01,02` | 运维场景 |
| **P1** | SQL Server / Oracle provider（平台限制评估） | 企业覆盖 |
| **P2** | 数据生成 + 数据字典 `SY-04,05` | 低依赖可后置 |
| **P2** | MongoDB / Redis provider `OT-02,03` | 文档/键值域 |
| **P2** | 自动化（调度/job runner/批量/邮件附件）`AU-01,02` | 企业增强 |
| **P2** | 概念/逻辑/物理模型 + 正反向同步 `MO-01..04` | 建模域 |
| **P2** | PL/SQL、PL/pgSQL 调试器 `OD-02` | 需可行性研究 |
| **P2** | URI 打开 / 对象 URI `CN-08` | 效率增强 |
| **P2** | Data Profiling、Aggregate Builder `DE-04, QY-04` | 分析增强 |

---

## 4. 用户故事与验收标准（核心 10 条）

| # | 用户故事 | 验收标准（DoD 级） |
|---|---|---|
| US-01 | 作为开发，我要像 Navicat 一样右键表格即可"打开表/设计表/复制名/删除"，无需进入菜单 | 导航器表格右键出现 Navicat 确认菜单；菜单按对象类型/权限启用/禁用 |
| US-02 | 作为开发，我要双击单元格即编辑、Ctrl+S 应用、Esc 撤销、右键 Set NULL/Empty/UUID | 原生 E2E：改值→应用→数据库生效；撤销→无变更；PK 列不可编辑 |
| US-03 | 作为开发，我要右键字段"Filter by field value"、Ctrl+R 应用过滤、F3 下一个 | 过滤/排序/Find 原生 E2E 通过，SQL 预览正确 |
| US-04 | 作为开发，我要 Ctrl+R 运行查询、Ctrl+Shift+R 运行当前语句、Ctrl+T 停止 | 三态（运行中/停止/结果）原生 E2E；终端快捷键不受影响 |
| US-05 | 作为开发，我要复制粘贴单元格/整行数据（含 NULL 语义），跨网格粘贴有事务确认 | 复制→粘贴→应用成功；事务失败可回滚 |
| US-06 | 作为 DBA，我要对表执行导入/导出 CSV 向导，映射→预览→执行→取消全程可见 | 向导各步原生 E2E；错误行策略（跳过/中止）生效 |
| US-07 | 作为 DBA，我要一键备份 PG/MySQL 数据库并在灾难时恢复 | 备份→真实恢复→数据校验 E2E；破坏性操作二次确认 |
| US-08 | 作为 DBA，我要反向工程 ER 图，拖动表、编辑关系 | ER 画布拖拽/缩放/关系线原生 E2E |
| US-09 | 作为开发，我要新建/修改表结构（字段/约束/索引/FK），DDL 预览后保存 | 表设计器 DDL diff 原生 E2E；非法结构拒绝 |
| US-10 | 作为运维，我要管理 PG 用户/角色，查看服务器活动会话并安全终止 | 权限拒绝、终止二次确认、无特权用户降级提示 |

---

## 5. 架构决策

| 决策 | 内容 | 依据 |
|---|---|---|
| D1 | **沿用共享 Provider Core**，不引入 generic runtime 重写 | 现有 PG/SQLite/MySQL 共享 frontend/domain 已验证；runtime 保持 provider-specific（roadmap 结论） |
| D2 | **快捷键按 scope 注册**：`DIALOG > QUERY_EDITOR / DATA_GRID > MODEL / ER_DIAGRAM > NAVIGATOR > DATABASE_WORKSPACE > GLOBAL`；在 `command-registry.ts` 现有 scopes 上实现注册器，终端 xterm textarea 永不拦截 | shortcuts.md 必需架构；现有 `keyboard-shortcuts.ts` 提供基础 |
| D3 | **上下文菜单由 provider 声明**：共享渲染 + enablement 规则，禁止 UI 按 PG 对象名分支 | audit 架构决策；无调用方不建抽象 |
| D4 | **wizard 引擎（导入导出/备份/同步）为共享流程骨架**：source→mapping→preview→execute→error-policy→cancel，provider 提供 adapter | 5 个 Phase 共用一套；避免 5 套向导 |
| D5 | **对象设计器为声明式表单 + DDL 预览/diff/回滚**，先表设计器，后视图/函数 | roadmap Phase 3 |
| D6 | **ER 画布 / 模型画布共用 canvas 核心**（pan/zoom/选择/连线/导出），ER 先行，模型后置复用 | MO/OT 共用 |
| D7 | **跨库复制粘贴用 typed interchange model**，绝不用裸剪贴板文本 | roadmap Phase 7 硬约束 |
| D8 | **job runner（自动化）本地运行 + 持久化历史**，不做云调度 | Phase 9 |
| D9 | 新增 provider 一律走共享契约注册，能力声明驱动 UI enablement | 无假 provider、无泄漏 |

---

## 6. User Visible Slice 批次路线（Batch 17 起）

> 每批 = 完整用户可见能力，独立验证 + 更新审计台账（Permanent audit gates）。里程碑 = 可发布版本。

### 里程碑 M1「日常核心 Parity」（目标 v2.8.0）

| Batch | 用户可见能力（Slice） | 关键 DoD | 依赖 |
|---|---|---|---|
| **B17** | PG 数据网格编辑闭环：增行/删行/保存/撤销/回滚、Set NULL/Empty/UUID、复制粘贴、Ctrl+Enter 编辑器、Ctrl+S/Esc/Ctrl+T、脏确认 | 原生 E2E 增删改保存 + 回滚；PK/只读约束 | 网格基础已具备 |
| **B18** | 数据浏览：Filter & Sort（字段值/自定义）、Find/下一个、列冻结/宽度/最佳适配、行高、Show Field Type/Comment | 过滤排序原生 E2E；布局持久化 | B17 |
| **B19** | 查询命令：当前语句/运行选中/停止、格式化/压缩、Ctrl+/ 注释、Find Builder、参数查询、snippet、标识符面板 | 当前语句+停止原生 E2E | B17 |
| **B20** | 快捷键 scope 体系 + 18 组 Navicat 绑定全量落地，冲突矩阵生效 | scope 路由单测 + 原生 E2E 快捷键；终端回归 | B17-B19 |

### 里程碑 M2「对象与设计」（目标 v2.9.0）

| Batch | 用户可见能力 | 关键 DoD | 依赖 |
|---|---|---|---|
| **B21** | 导航器对象全覆盖（函数/序列/索引/约束/触发器/列）+ Navicat 21 项确认菜单 + 双击/Enter 语义 | 每对象类型原生 E2E 打开/菜单 | B20 |
| **B22** | 连接管理：颜色、虚拟分组、连接导入/导出、批量测试/重连、状态语义 | 连接导入导出原生 E2E | B20 |
| **B23** | PG 表设计器 + DDL 预览/回滚 + View Builder | DDL diff 原生 E2E；非法结构拒绝 | B21 |
| **B24** | PG ER 图反向工程：关系线/拖拽/缩放/FK 设计删除 | ER 画布原生 E2E + 视觉门禁 | B21 |

### 里程碑 M3「Provider 与数据平台」（目标 v2.10.0）

| Batch | 用户可见能力 | 关键 DoD | 依赖 |
|---|---|---|---|
| **B25** | MySQL 完整 provider：SSH/TLS/对象覆盖/数据编辑/explain/备份能力声明 | MySQL parity 矩阵原生 E2E | B18, B23 |
| **B26** | 导入/导出平台（PG/MySQL/SQLite）：TXT/CSV/JSON/XML 向导 | 向导各步 + 错误策略原生 E2E | B22 |
| **B27** | 备份/恢复（PG/MySQL/SQLite）：向导/历史/取消/转 SQL | 真实备份→恢复→校验原生 E2E | B25 |

### 里程碑 M4「迁移与体验」（目标 v2.11.0）

| Batch | 用户可见能力 | 关键 DoD | 依赖 |
|---|---|---|---|
| **B28** | 结构同步 + 数据传输（同/跨服务器）+ 数据同步 + 跨库复制粘贴 | 同步预览/冲突策略原生 E2E | B26 |
| **B29** | 表单视图 + 值查看器（文本/hex/图像/网页） | 表单编辑原生 E2E | B23 |
| **B30** | 数据生成（约束感知）+ 数据字典（导出） | 生成数据入库校验 E2E | B28 |
| **B31** | SQLite 完整 provider + PG 用户/角色管理 + 活动会话监控 | 权限拒绝/终止确认原生 E2E | B27 |

### 里程碑 M5「企业扩展」（目标 v3.0.0）

| Batch | 用户可见能力 | 关键 DoD | 依赖 |
|---|---|---|---|
| **B32** | SQL Server / Oracle provider（先可行性 + 平台限制评估） | 连接/浏览/查询原生 E2E | B25 |
| **B33** | 自动化：调度（查询/备份/传输/同步）+ 本地 job runner + 历史/通知 | 调度执行+失败重试 E2E | B30 |
| **B34** | MongoDB / Redis provider（文档/键值域） | 集合/键树原生 E2E | B25 |
| **B35** | 概念/逻辑/物理模型 + 正反向同步（复用 ER canvas） | 模型同步原生 E2E | B24 |

> 不含 AI/BI/Collab（用户排除）。`OD-02` 调试器、`CN-08` URI、`DE-04` Profiling 作为 backlog 在对应里程碑评估。

---

## 7. 快捷键与操作习惯对标

### 7.1 快捷键 scope 路由（决策 D2 落地）

```
keydown
 ├─ xterm textarea 聚焦？→ 透传终端，不拦截（IME/终端保护）
 ├─ 对话框开启？→ DIALOG scope
 ├─ QUERY_EDITOR 聚焦？→ 查询命令
 ├─ DATA_GRID 聚焦？→ 网格命令
 ├─ ER/MODEL 画布聚焦？→ 画布命令
 ├─ NAVIGATOR 聚焦？→ 导航器命令
 ├─ DATABASE_WORKSPACE → 工作区命令
 └─ 否则 → GLOBAL（终端/布局）
```

### 7.2 18 组 Navicat 绑定映射与冲突解决（基线：Navicat 17 Windows 手册 p.379-381；macOS 用 ⌘ 等价——macOS 原生 Navicat 快捷键 UNVERIFIED，以 ⌘ 映射为产品决策）

| 组 | Navicat | NexTerm 绑定 | 冲突 | 决策 |
|---|---|---|---|---|
| 网格-设计对象 | Ctrl+D | `DATA_GRID`/`NAVIGATOR` | 无 | 绑定 |
| 网格-查询对象 | Ctrl+Q | `NAVIGATOR` | 无 | 绑定 |
| 网格-查找/下一个/行 | Ctrl+F / F3 / Ctrl+G | `DATA_GRID` | 无（scope 内） | 绑定 |
| 网格-应用过滤排序 | Ctrl+R | `DATA_GRID` | 查询也用 Ctrl+R | **按 scope 路由**：网格内=过滤，查询编辑器内=运行 |
| 网格-单元格编辑器 | Ctrl+Enter | `DATA_GRID` | 无 | 绑定 |
| 网格-增/删记录 | Insert 或 Ctrl+N / Ctrl+Delete | `DATA_GRID` | **Ctrl+N=终端新会话** | 仅 `DATA_GRID` 聚焦时接管；终端 scope wins |
| 网格-应用/放弃/停止 | Ctrl+S / Esc / Ctrl+T | `DATA_GRID` | Ctrl+T 可能=浏览器标签 | 仅 `DATA_GRID`/`QUERY_EDITOR` scope；全局不注册 |
| 网格-选择/复制/粘贴 | Ctrl+A、Shift+Arrow、Ctrl+C/V | `DATA_GRID` | 浏览器默认 | scope 内接管，保留浏览器行为在非网格 |
| 查询-打开外部文件 | Ctrl+O | `QUERY_EDITOR` | 无 | 绑定 |
| 查询-当前语句 | Ctrl+E | `QUERY_EDITOR` | 无 | 绑定 |
| 查询-运行/当前/停止 | Ctrl+R / Ctrl+Shift+R / Ctrl+T | `QUERY_EDITOR` | 同上按 scope | 绑定 |
| 查询-结果 tab | Alt+0..9 | `DATABASE_WORKSPACE` | 无 | 绑定 |
| 查询-剪贴板栈 | Ctrl+Shift+V | `QUERY_EDITOR` | 平台剪贴板策略 | 编辑器内接管 |
| 查询-注释 | Ctrl+/ | `QUERY_EDITOR` | CodeMirror 默认已有 | 确认/保留 |
| 查询-缩放 | Ctrl+=/-/0 | `QUERY_EDITOR` | 无 | 绑定 |
| ER-刷新/选择/移动 | F5 / Esc / H | `ER_DIAGRAM` | **F5 不得刷新应用** | 画布聚焦时接管，全局 F5 不注册 |
| ER-新建/删除 FK | R / Delete | `ER_DIAGRAM` | 无 | 画布聚焦时绑定 |
| ER-缩放 | Ctrl+=/-/0 或 Ctrl+滚轮 | `ER_DIAGRAM` | 无 | 画布聚焦时绑定 |

### 7.3 既有冲突审计结论（延续 shortcuts.md）

| 快捷键 | 全局 | Navicat 数据库动作 | 结论 |
|---|---|---|---|
| Ctrl+N | 终端新会话 | 网格新增记录 | 网格 scope 接管，终端 wins |
| Ctrl+W | 关闭标签 | 无确认数据库动作 | 保留全局 |
| Ctrl+Z | Zen mode | 编辑器撤销 | `QUERY_EDITOR`/`DATA_GRID` 内撤销优先 |
| Ctrl+Tab / Shift+Tab | 终端组切换 | 数据库 tab 行为 | 按聚焦 workspace 路由 |
| Ctrl+1..9 / Ctrl+B/J/M / Ctrl+\ | 终端/布局 | 无确认冲突 | 保留 |
| Ctrl+R | 未注册全局 | 网格过滤 / 查询运行 | scope 路由，无实际冲突 |

### 7.4 操作习惯对齐（交互矩阵落地优先级）

- **导航器**：单击选择、双击打开（表=查看器/设计器按视图）、Enter 同双击、右键上下文菜单
- **对象面板**：List / Detail / ER 三种视图切换
- **网格**：单击选中、双击编辑、右键 Set NULL/Empty/UUID/Filter、Shift 范围选择、Ctrl 行多选、列头拖拽重排/改宽/双击最佳适配、行高设置
- **查询**：标识符面板双击插入、Alt+0..9 切结果 tab、结果 pin
- **向导**：Source→Mapping→Preview→Execute→Done 五步骨架
- 每项交互落地前必须过 `navicat-premium-interactions.md` 的 UNVERIFIED 协议（未证实的不发明、不声称 parity）

---

## 8. 质量门禁与验证

### 8.1 每批测试矩阵（沿用 roadmap Permanent audit gates）

| 类别 | 必交证据 |
|---|---|
| Unit | command scope/enablement、序列化器、provider 能力决策、冲突矩阵路由 |
| Integration | Tauri IPC × 一次性 provider fixture；错误与权限路径 |
| Browser 组件 | grid/editor/tab 渲染（仅渲染回归，不构成 parity） |
| 原生 GUI E2E | 右键/双击/键盘/拖拽 splitter/画布/对话框/脏状态（**每批必须**） |
| Safety | 二次确认、只读拒绝、权限拒绝、取消、错误恢复 |
| 视觉门禁 | 改动可见 UI 的批：dark/light/960×700 小窗 + 多 provider 一致 + 截图（Permanent Visual Quality Gate） |
| 全量回归 | `pnpm test`（vitest）、`cargo test`、`tsc --noEmit`、`pnpm lint`、`i18n:check`、受影响批的 WDIO/Playwright 原生套件 |

### 8.2 发布门禁（Phase 8 发布评审）

- 产品/架构/安全/QA/Release 五方投票，任一方否决 → 打回
- 存在 Blocking Issue → 不得 READY
- 输出 `READY / READY WITH RISK / NOT READY`
- **打包验证不强制**（2026-08-26 用户决策：`pnpm tauri build` 不再作为发布前置）；发布流程保留全量自动化测试 + 受影响 E2E + 五方评审

---

## 9. 发布计划

| 里程碑 | 版本 | 内容 | 发布前置 |
|---|---|---|---|
| M1 | v2.8.0 | 数据编辑/浏览/查询/快捷键（B17-20） | 全量回归 + 发布评审 |
| M2 | v2.9.0 | 导航器/连接管理/设计器/ER（B21-24） | 同上 |
| M3 | v2.10.0 | MySQL parity/导入导出/备份恢复（B25-27） | 同上 |
| M4 | v2.11.0 | 迁移/表单/字典/服务器管理（B28-31） | 同上 |
| M5 | v3.0.0 | 企业 provider/自动化/NoSQL/模型（B32-35） | 同上 + 3.0 兼容性声明 |

- 每个 Batch 合入 main 后：CHANGELOG（Unreleased）、AGENTS.md、开发状态文件同步
- 版本号统一走 `pnpm run version:minor/patch`

---

## 10. 风险登记册

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | `commands.rs` 4637 行债务，DB IPC 继续膨胀 | 高 | 新 DB 命令按域分文件落盘，不继续堆叠；批次内顺带治理 |
| R2 | macOS 快捷键 parity 无官方证据（UNVERIFIED） | 中 | 以 ⌘ 映射为产品决策并记录；不声称官方 parity |
| R3 | 原生 E2E 依赖 Docker live fixture，CI 未含 | 中 | 沿用 `scripts/ssh-fixture.sh` 思路；CI 可选 job 先行 |
| R4 | 网格编辑/事务语义引入数据损坏风险 | 高 | 只读连接默认拒绝写；事务包裹 + 回滚；Safety E2E 门禁 |
| R5 | 备份/恢复、传输等破坏性操作 | 高 | 二次确认 + 权限门禁 + 审计日志 + 恢复校验 E2E |
| R6 | 跨平台（Win/Linux/mac）快捷键/剪贴板差异 | 中 | 平台适配层 + 三平台 smoke |
| R7 | 范围蔓延（对标 68 项全做） | 中 | 里程碑冻结范围；每批 DoD 明确；P2 项可裁剪 |
| R8 | WDIO 并行 spec 共享数据目录冲突 | 低 | CI 串行（沿用既有结论） |
| R9 | B17 新 E2E（postgres-grid-edit）受 WDIO 桌面环境不稳定性阻塞，3 轮验证未稳定通过（无产品 bug 证据） | 中 | spec 已打磨至可提交质量；发布评审按 RISK 记录，稳定环境/CI 补跑（任务 #14）；产品逻辑经 qa 调试证据 + 全量自动化验证确认正常 |

---

## 11. 立即行动（首个批次提案）

**首批 = B17「PG 数据网格编辑闭环」**（已获用户批准：深度优先策略；依赖最小、用户价值最高、与现有双击编辑/scope 架构衔接最顺）。

### 11.1 B17 现状基线（2026-08-26 代码审计，勿重复实现）

| 已有（B17 起点） | 位置 |
|---|---|
| 双击编辑→暂存→dirty 高亮 | `stageTableEdit` @ tool-postgres.tsx:668 |
| 保存（UPDATE，PK 定位 + 非 PK 变更列） | `saveTableChanges` :679 → `postgres_table_update`（Rust:775） |
| 回滚 | `revertTableChanges` :709 |
| Set NULL（仅 nullable 列） | 上下文菜单 :1040 |
| Copy Cell / Row / Column Name / Export CSV | :1035-1043 |
| 事务命令 BEGIN/COMMIT/ROLLBACK | `postgres_transaction`（Rust:609） |
| 快捷键（部分） | `onDatabaseKeyDown` :712（Ctrl+N 查询/Ctrl+Enter 执行/Ctrl+Shift+E/Ctrl+W/Ctrl+R） |
| 能力声明 | PG `supportsResultEditing:true, supportsPagination:true`；result adapter 提供 PK/nullable keys |

### 11.2 B17 缺口（本次实现范围）

1. **INSERT**：Rust 新增 `postgres_table_insert`（传入列值 Map，返回生成 PK）；前端 Add Record 行（dirty 标记，Apply 时 INSERT）
2. **DELETE**：Rust 新增 `postgres_table_delete`（PK 定位）；前端 Delete Record 上下文菜单 + 二次确认，Apply 时 DELETE
3. **Set to Empty String**（与 NULL 区分）、**Generate UUID**（PG uuid 列）
4. **复制/粘贴**：网格选中块复制（Tab 分隔 + NULL 语义）；粘贴到块（事务确认）
5. **快捷键补齐**（`DATA_GRID` 聚焦时接管，scope 路由）：Ctrl+Enter 单元格编辑器、Ctrl+S Apply、Esc Discard、Ctrl+Delete 删行、Ctrl+T Stop（运行中）
6. **脏状态确认**：关闭有未保存改动的 tab（关闭按钮/菜单/Ctrl+W）→ 确认对话框。**决策：切换 tab 不确认**（数据保留于 tab 无丢失，符合 Navicat 操作习惯；仅关闭时提示）
7. **保存事务化**：批量 INSERT/UPDATE/DELETE 包裹 `postgres_transaction`（begin→batch→commit，失败 rollback）——避免逐行半成功
8. **写路径护栏**：readOnly 连接、无 PK 表、非 nullable 列 Set NULL 全部禁用（已有部分，补齐 DELETE/INSERT 护栏）

### 11.3 B17 改动文件清单（预估）

| 文件 | 改动 |
|---|---|
| `src-tauri/src/postgres.rs` | 新增 `postgres_table_insert` / `postgres_table_delete`（参数化 SQL + 单语句安全护栏，沿用 :858 UPDATE 的 escaping 模式） |
| `src-tauri/src/commands.rs` + `lib.rs` | 注册两个新命令 |
| `src/lib/toolbox/postgres-storage.ts` / 类型 | 表 tab 状态扩展：`pendingInserts`/`pendingDeletes`（或统一 edit-session 模型） |
| `src/components/toolbox/tool-postgres.tsx` | Add/Delete 入口、Set Empty/UUID 菜单、粘贴、脏确认、快捷键补齐、事务化保存 |
| `src/components/toolbox/database-result-pane.tsx` | 范围选择（Shift/Ctrl）、粘贴目标、行删除标记视觉 |
| `src/lib/database/command-registry.ts` | 新增 `database.data.addRecord`/`deleteRecord`（DATA_GRID scope） |
| i18n | `src/lib/i18n.ts`（或 locale 文件）补键 |
| 测试 | Rust 单测（insert/delete/单语句护栏）、vitest（edit-session reducer/命令 scope）、原生 WDIO PG E2E（增删改保存/回滚/readOnly 拒绝） |

### 11.4 B17 验收（DoD）

- 原生 E2E（真实 PG Docker fixture）：增行→Apply→数据库可见；改值→Apply→生效；改值→Discard→无变更；删行→确认→生效；Set NULL/Empty 语义正确；readOnly 连接拒绝写；无 PK 表禁用编辑；批量操作事务原子性（中途失败可回滚）
- 视觉门禁：dark/light/960×700 + 截图
- `pnpm test` / `cargo test` / `tsc --noEmit` / `pnpm lint` / `i18n:check` 全绿；终端快捷键回归

> 后续批次严格按第 6 节顺序执行，每批完成一个 Slice 全部能力后才进入下一个（SOP Phase 5）。B17 完成后更新本文件、`database-development-status.md`、Feature Matrix 台账。

### 11.5 B17 安全评审遗留（security 专家 PASS，3 项 Medium 转后续批次）

| # | 项 | 处置 |
|---|---|---|
| M2 | `PostgresState.clients` 无 per-connection 事务互斥锁，事务进行中执行普通 SQL 可能被误回滚 | 纳入 B19 查询命令批次（后端加 `HashMap<String, Mutex<()>>`，事务命令持锁） |
| M3 | update/delete 未校验受影响行数 `count==1`，并发行被删改时静默丢更新 | 纳入 B19（`count!=1` 报错触发回滚） |
| M4 | commit 失败时前端 rollback 失败被吞，事务可能悬空 | 纳入 B19（Rust 侧事务失败主动 ROLLBACK） |
| L5 | `$n::text::<type>` 对 bytea 等无 text→目标 cast 的列报错（功能性） | backlog，值查看器批次评估 |
| L6 | `postgres_table_data` offset 无上限 | 顺手 clamp（后续批次） |
