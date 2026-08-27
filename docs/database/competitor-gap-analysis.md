# NexTerm × 竞品功能模块差距分析

> 编制：competitor-researcher（竞品研究）
> 基线版本：NexTerm v2.10.0（2026-08-27 工作树）
> 范围声明：**AI、BI、ER 图三个方向按产品决策排除**，本报告不纳入相关差距对比；协作/团队功能在 master plan 中亦被排除（`navicat-parity-master-plan.md` §1.2），仅作标注。

---

## ① 竞品选型说明

| 竞品 | 定位 | 选择理由 | 本报告角色 |
|---|---|---|---|
| **Navicat Premium 16/17.3** | 桌面数据库客户端（多协议/多 provider） | 项目业务对标基线（README、`navicat-parity-master-plan.md` 均声明）；仓库已有 12 份对标证据（feature matrix 74 项 / interactions 34 项 / context menus / shortcuts） | **主竞品** |
| **DataGrip** | 数据库 IDE（JetBrains） | 代表"开发者工具链"的智能上限：补全、重构、迁移、视觉化执行计划 | 参考 |
| **DBeaver** | 开源 + 商业数据库工具 | 免费策略是 NexTerm 的直接价格竞争；商业版覆盖 NoSQL/比较/同步/数据生成 | 参考 |
| **TablePlus** | 轻量 macOS 原生数据库客户端 | 原生体验与性能标杆，反衬 Tauri 壳的优劣势 | 参考 |
| Beekeeper Studio / dbForge Studio | 轻量 / 企业级单库工具 | 差异点补充（见各模块注） | 补充 |

**选型说明**：Navicat 覆盖"数据库客户端日常全功能"，DataGrip 覆盖"开发者智能体验"，DBeaver 覆盖"免费广度"，TablePlus 覆盖"原生质感"。NexTerm 与它们的核心差异在于：NexTerm 不是纯数据库客户端，而是**多协议连接工作区**（终端/文件/文档/API 调试在同一壳内），数据库工具箱只是其中一个强模块。因此差距矩阵按模块拆分，避免整体误判。

---

## ② 功能模块差距矩阵

> 差距等级：`parity`（对齐）/ `minor gap`（小幅差距）/ `major gap`（明显差距）/ `missing`（缺失）/ `lead`（领先竞品）

| 模块 | NexTerm 现状 | 竞品能力 | 差距等级 | 建议 |
|---|---|---|---|---|
| **1. 连接管理** | | | | |
| 多协议接入 | SSH/SFTP/FTP/FTPS/RDP/VNC 六协议完整 + PG/SQLite/MySQL 三类数据库 | Navicat 仅数据库 + 隧道（无终端协议）；DataGrip/DBeaver 数据库为主 | **lead** | 保持六协议合一，这是 N 端差异化根本 |
| SSH 隧道 | PG/MySQL/SQLite 一键隧道，TOFU 指纹 pin + fail-closed（安全基线强） | Navicat 有 SSH/HTTP 隧道；DataGrip/DBeaver/TablePlus 均有 SSH 隧道 | parity | 差异化：隧道一键化 + 指纹强制 pin 已是安全溢价 |
| 连接管理 UX | 颜色、虚拟分组、JSON 导入导出（脱敏/AES-GCM）、批量测试、重连（B22 完成） | Navicat 同能力（Centralized connection management）；DBeaver 弱 | parity | 已对齐，无需投入 |
| 云数据库接入 | 无 | Navicat 有 AWS/Azure/GCP/阿里云/腾讯云预设认证（FM DB-11..15） | **missing** | master plan 已标注"依赖外部凭据体系，P2 后评估"，维持排除 |
| 高级认证 | 密码/密钥/代理/跳板 | Navicat 另有 PAM/LDAP/Kerberos、SQL Server Windows/AD | **major gap** | P2：LDAP/Kerberos 面向企业，非个人开发者刚需 |
| 连接池 | 无显式连接池（连接即会话） | Navicat 内部连接池；DataGrip 连接复用 | minor gap | 影响大量 tab 场景的延迟，P2 优化 |
| **2. 数据库工具箱** | | | | |
| Provider 覆盖 | PG 完整；SQLite/MySQL 实验性 P0 | Navicat 16 族（MySQL/PG/SQL Server/Oracle/SQLite/MongoDB/Redis/Snowflake…）；DataGrip/DBeaver 全 | **major gap** | P0：MySQL 升完整 provider（B25）；P1：SQL Server/Oracle |
| 数据网格编辑 | B17 事务化编辑闭环（INSERT/UPDATE/DELETE/Set NULL/Empty/UUID/复制粘贴/脏确认） | Navicat 网格编辑 + 表单视图 + 树/JSON 视图（Mongo）；DataGrip 网格 | parity（网格）；missing（表单/JSON） | 已对齐核心；表单视图/值查看器列入 P1 |
| 过滤/排序/查找 | B18 字段值过滤、自定义 Filter&Sort、Ctrl+F 查找、列布局冻结/宽度/最佳适配 | Navicat DE-07 同类 | parity | 已对齐 |
| 表设计器 | B23 PG 表设计器 + DDL 预览/回滚 + View Builder（v2.10.0） | Navicat OD-01/03 表/视图设计器（多 provider） | parity（仅 PG） | MySQL 完整后自然覆盖 |
| 导入/导出 | 无向导；仅结果网格单元格级 CSV 导出 | Navicat IE-01 TXT/CSV/XML/JSON 向导 + ODBC/Excel 导入；DBeaver 商业版有 | **missing** | **P0：B26 导入/导出向导（D4 向导引擎）** |
| 备份/恢复 | 无 | Navicat BR-01/02 PG/MySQL/SQLite/Redis 备份恢复 + 转 SQL | **missing** | **P0：B27 备份/恢复向导** |
| 结构同步/数据传输 | 无 | Navicat SY-01/02/03 结构同步、数据传输、数据同步；DBeaver 商业版比较 | **missing** | P1：B28（迁移场景） |
| 数据生成/字典 | 无 | Navicat SY-04/05；DBeaver 商业版 Mock Data | **missing** | P2：B30 |
| 表单视图/值查看器 | 无 | Navicat DE-02 表单视图、DE-05 文本/hex/图像/网页查看器 | **missing** | P1：B29 |
| 服务器管理 | 无 | Navicat SM-01/02 用户/角色管理、服务器/命令监控 | **missing** | P1：B31（PG 用户/角色 + 活动会话） |
| 调度任务/自动化 | 无 | Navicat AU-01/02 调度查询/备份/传输 + 批量任务 + 邮件附件 | **missing** | P2：B33 |
| 跨库复制粘贴 | 无 | Navicat SY-06 typed interchange | **missing** | P1：B28 连带 |
| **3. 查询编辑器** | | | | |
| 编辑器 + 补全 | CodeMirror + PG（catalog 语义）/SQLite/MySQL 方言补全 | DataGrip 补全业界最强；Navicat 基于 provider 元数据 | minor gap | 补全深度可继续打磨（identifier 面板缺失） |
| 执行控制 | 运行/当前语句/选中/停止/事务锁（B19） | Navicat Ctrl+R / Ctrl+Shift+R / Ctrl+T 全对齐 | parity | 已对齐 |
| 格式化/压缩 | SQL 格式化 ⌘⇧F + DDL 面板（v2.10.0） | Navicat QY-07 beautifier/minifier | parity | 已对齐 |
| 可视化执行计划 | 仅文本 EXPLAIN | Navicat Visual Explain；DataGrip 视觉化计划（树/成本图） | **major gap** | **P0：PG 计划树可视化**（DBA 调优刚需） |
| 查询历史 | 无（`tool-command-history` 仅为终端 shell 历史） | Navicat/DataGrip 均有 SQL 历史 | **major gap** | **P0：查询历史 + snippet 模板**（低成本高感知） |
| Query Builder / Find Builder | 无 | Navicat QY-03/04；DataGrip 可视化构建 | **missing** | P2（成本高，SQL 熟练用户弱需求） |
| 结果 pin / 多结果 tab | 单结果面板 | Navicat QY-06 pin + Alt+0..9 多结果 tab | **missing** | P1：低成本（B20 已埋 Alt+0..9 绑定） |
| 参数查询/标识符面板 | 后端 parameterized execute 已备，无 UI | Navicat QY-08 + 标识符面板（IN-20） | minor gap | P1：参数 UI + 标识符面板 |
| **4. 终端** | | | | |
| 核心能力 | xterm.js + WebSocket PTY、多标签/分屏/拖拽/会话恢复/重连/布局持久化、IME/CJK | Navicat 无真终端；DataGrip 内置终端较弱；DBeaver 终端插件；TablePlus 无 | **lead** | 保持；这是 N 端对纯 DB 客户端的核心反超点 |
| 搜索/主题 | 终端搜索栏、主题可配置、上下文菜单 | DataGrip 终端有搜索；无分屏 | **lead** | 保持 |
| 高级能力 | 无 Zmodem、无 tmux 会话集成、无录屏 | FileZilla 等文件工具有 Zmodem；专业终端工具有 tmux 集成 | minor gap | P2：Zmodem（rz/sz）传输是高感知补强 |
| **5. 文件传输** | | | | |
| 双栏传输 | 本地/远程双栏、SFTP/FTP、队列、重试、进度、目录操作 | Navicat 有基本文件传输（弱）；DataGrip/DBeaver/TablePlus 无 | **lead** | 保持 |
| 目录同步 | 比较/审查/方向/排除项 | Navicat 无此深度；专业工具有 | **lead** | 保持 |
| 断点续传 | 无（`sftp_client.rs` 无 resume 逻辑） | FileZilla/WinSCP 标准能力；Navicat 无 | minor gap | **P1：补断点续传 + 本地拖拽上传**（SFTP 大文件场景刚需） |
| **6. 文档工具** | | | | |
| Word/Excel | 导入/编辑/版本历史（3 版）/导出；基于 SheetJS+TanStack / TipTap 自建 | Navicat/DataGrip/DBeaver/TablePlus **均无此模块** | **lead（能力）**；minor gap（保真度） | 差异化保留；保真度受自建引擎限制 |
| 引擎保真 | BetterOffice 重构方案已设计（`document-module-redesign.md`），P0 PoC 未启动 | —（无竞品） | 内部差距 | P1：跟进 PoC 验证 OOXML 保真，或降级为只读预览 + 表格编辑 |
| **7. API 调试** | | | | |
| REST/WebSocket | 集合/环境/变量替换/多认证/断言/顺序运行器/WS 调试（完整） | Navicat/DataGrip/DBeaver/TablePlus **均无此模块** | **lead** | 差异化保留 |
| 深度能力 | 无 OpenAPI 导入、无 mock server、无 GraphQL | Postman/Bruno（非桌面 DB 竞品）具备 | 内部差距 | P2：OpenAPI 导入（低成本高感知） |
| **8. 协作/团队** | | | | |
| 协作 | 无 | Navicat CO-01/02/03（Projects/连接/查询同步）；DBeaver Team；DataGrip 走 Git | **missing** | **用户决策排除**（master plan §1.2），仅标注；若未来立项，连接/查询包共享为首选 |
| **9. 平台与体验** | | | | |
| 原生性 | Tauri 2 WebView（跨平台一致，非原生控件） | TablePlus 原生 macOS 标杆；Navicat 原生 | minor gap | WebView 换原生不现实；以性能优化 + 原生感样式补偿 |
| 深色模式 | 支持（app theme） | 全支持 | parity | — |
| 快捷键 | B20 scope 体系，14 组 Navicat 数据库绑定（macOS ⌘ 等价） | Navicat 18 组；DataGrip 全家桶 | parity（数据库域） | B20 已收敛到 14 组，ER 组已隐藏（随 ER 排除） |
| i18n | EN/ZH 1995 键 | Navicat 多语言 | parity（目标市场） | — |
| 附加工具 | JAR 反编译、加密笔记库、隧道/服务编排、远程监控/日志 | 竞品均无 | **lead** | 反编译工具是运维侧差异化，保持即可 |

---

## ③ 关键差异点详述

### 1. 连接管理
NexTerm 已具备 Navicat 的核心连接管理 UX（颜色、虚拟分组、导入导出、批量测试），且 SSH 隧道与数据库工具箱深度集成（一键隧道 + 指纹 fail-closed）在安全语义上强于 Navicat 的普通隧道。最大缺口是**云数据库预设认证**（AWS/Azure/国内云）与 **PAM/LDAP/Kerberos**——均面向企业级客户，与 NexTerm 当前个人开发者/中小团队定位错位，建议维持 P2 后评估。连接池缺失会在大量结果 tab 场景造成延迟，但属体验级问题。

### 2. 数据库工具箱
这是差距最集中的模块。网格编辑闭环（B17）、过滤排序（B18）、表设计器（B23）已经对齐 Navicat 日常核心，但 **Provider 覆盖只有 1.5 个（PG 完整 + SQLite/MySQL 实验）**，Navicat 是 16 族。MySQL 是最大缺口——它是最广泛使用的数据库，而当前仅为实验性 P0（无 SSH/TLS、无结果编辑、无 explain、无备份）。**导入/导出向导、备份/恢复**属于 Navicat 高频刚需而 NexTerm 完全缺失，二者复用同一向导引擎（master plan D4），成本可控，是投入产出比最高的两块。结构同步、数据同步、数据生成、服务器管理等迁移/运维能力全部缺失，按 B28-B31 顺序推进。

### 3. 查询编辑器
执行控制与格式化已实现 parity。**可视化执行计划**是最大功能缺口——PG 仅有文本 EXPLAIN，DBA 无法快速定位慢查询瓶颈（Navicat Visual Explain、DataGrip 计划树均为标配）。**查询历史缺失**是感知型缺口：所有竞品都有 SQL 历史，而 NexTerm 连常用 SQL 记忆都没有，实现成本极低（前端存储）。Query Builder 建议 P2 后置：目标用户是开发者/运维，手写 SQL 能力强，可视化构建器价值有限且实现成本高（AST + 画布）。

### 4. 终端
NexTerm 终端（xterm.js PTY + 多标签分屏 + 会话恢复 + IME/CJK）是相对所有纯数据库竞品的**碾压级优势**——Navicat/TablePlus 无真终端，DataGrip 内置终端较弱，DBeaver 终端为插件级。这构成了"连接 + 终端 + 数据库"一体的产品护城河，应持续强化而非与数据库模块争夺资源。Zmodem（rz/sz）是传输场景的补强项，成本低、感知强。

### 5. 文件传输
双栏 SFTP/FTP + 目录同步已领先竞品（Navicat 仅有基本传输）。**断点续传缺失**是唯一实质短板——大文件传输中断后无法续传，与 FileZilla/WinSCP 等专用工具相比是硬伤，且 SFTP 后端（`sftp_client.rs`）实现 resume 的改动可控，建议 P1。

### 6. 文档工具
Word/Excel 工具箱在数据库客户端中无竞品（差异化），但**引擎保真度受限于自建实现**（SheetJS 表格 / TipTap 文档），复杂公式、分页、样式与 WPS/Office 有差距。重构方案（BetterOffice，WASM+Rust 同引擎）已设计但 PoC 未启动。建议 P1 推进 PoC 验证——若保真不达标，降级为只读预览 + 表格编辑是更诚实的路径，避免维护半成品编辑器。

### 7. API 调试
REST + WebSocket 调试器在数据库客户端领域完全无竞品（差异化）。相对 Postman/Bruno 缺 OpenAPI 导入、mock server、代码生成——但对 NexTerm 用户（开发者/运维）而言，集合 + 环境 + 断言 + 顺序运行器已覆盖日常调试。建议保持现状，仅 P2 补 OpenAPI 导入。

### 8. 协作/团队
NexTerm 无任何协作能力。Navicat Collaboration（连接/查询同步）面向团队，但**用户已决策排除**（master plan §1.2），DBeaver Team 需付费。若未来立项，最轻量的切入是"连接配置 + 查询包 + snippet 的加密共享包"，而非自建账号体系。

### 9. 平台与体验
Tauri 2 WebView 的跨平台一致性是优势，但原生质感弱于 TablePlus/Navicat（右键菜单、拖拽、系统集成）。数据库快捷键 scope 体系（B20）已实现对 Navicat 18 组绑定的对齐（14 组落地，ER 组随 ER 排除隐藏）。深色模式、i18n 均齐备。

---

## ④ 优先级建议

> 排序依据：**用户价值 × 差距大小 × 实现成本**（排除 AI/BI/ER；协作按用户决策排除）

| 优先级 | 模块 | 依据 | 对应批次 |
|---|---|---|---|
| **P0** | **MySQL 完整 provider** | 使用最广数据库；当前仅实验性 P0（无 SSH/TLS/编辑/explain）；差距 major；共享架构 + `mysql_async` 后端已就绪，成本可控 | B25 |
| **P0** | **导入/导出向导**（TXT/CSV/JSON/XML） | Navicat 高频刚需；NexTerm 完全缺失；复用 D4 向导引擎，成本中 | B26 |
| **P0** | **备份/恢复**（PG/MySQL/SQLite） | 高频刚需 + 破坏性操作安全护栏（B17 已验证事务模型）；复用向导引擎 | B27 |
| **P0** | **查询历史 + 常用 SQL snippet** | 所有竞品标配而 NexTerm 缺失；前端存储实现成本极低；感知提升直接 | 独立小批 |
| **P0** | **可视化执行计划（PG）** | DBA 调优刚需；当前仅文本 EXPLAIN；差距 major；成本中（计划树解析 + 渲染） | 独立小批 |
| **P1** | 断点续传 + 拖拽上传（SFTP） | 文件传输唯一硬伤；`sftp_client.rs` 改动可控 | 独立小批 |
| **P1** | 结果 pin + 多结果 tab | B20 已埋 Alt+0..9 绑定，成本低；对齐 Navicat QY-06 | 独立小批 |
| **P1** | 表单视图 + 值查看器（文本/hex/图像/网页） | 编辑体验补齐；网格已具备编辑闭环 | B29 |
| **P1** | 结构同步 / 数据传输 / 跨库复制粘贴 | 迁移场景刚需；B28 | B28 |
| **P1** | 服务器管理（PG 用户/角色 + 活动会话） | 运维场景；权限拒绝/终止确认安全门禁已论证 | B31 |
| **P1** | 文档引擎 PoC（BetterOffice） | 验证或降级文档模块，避免半成品维护 | `document-module-redesign.md` P0 |
| **P2** | SQL Server / Oracle provider | 企业覆盖，平台限制评估先行 | B32 |
| **P2** | 数据生成 + 数据字典 | 低依赖可后置 | B30 |
| **P2** | 自动化调度（查询/备份/传输） | 企业增强；本地 job runner 已规划 | B33 |
| **P2** | MongoDB / Redis provider | 文档/键值域，需新 provider 族 | B34 |
| **P2** | Query Builder / Find Builder | 目标用户手写 SQL 能力强，价值有限成本高 | 后置 |
| **P2** | Zmodem 传输 / OpenAPI 导入 | 低成本高感知补强 | 后置 |
| **P2 后** | 云数据库预设 / LDAP·Kerberos / 连接池 | 企业级，依赖外部凭据体系；master plan 已排期 | 后评估 |

**推荐 P0 集合（下一阶段）**：MySQL 完整 provider → 导入/导出 → 备份/恢复 → 查询历史+snippet → 可视化执行计划。前三个直接命中 Navicat 高频刚需且已在 master plan 批次中（B25-27），后两个以极低成本补齐"竞品标配缺失"，形成 v2.11 前的完整拼图。
