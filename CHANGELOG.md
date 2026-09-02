# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added


## [2.16.2] - 2026-09-02

### Fixed

- VNC/RDP connections launched from the server list (connect, reconnect,
  duplicate tab, session restore) no longer fail with "Disconnected" — they
  now route to the desktop viewer path; legacy tabs missing `tabType` are
  normalized to desktop tabs.
- SSH host-key fingerprint probes for the target server now run through the
  jump-host tunnel when a jump host is configured — previously the direct
  probe timed out after 10s on targets unreachable from the client.
- CapsLock can now switch letter case in remote desktop sessions: the VNC
  client's caps latch (previously dead code) resolves keysym case from the
  client's toggle state, and RDP emits toggle sync events (Windows hosts
  track CapsLock/NumLock there rather than via raw scancodes).


## [2.16.0] - 2026-09-02

### Added

- **VNC 远程桌面连接**（社区活跃库 `vnc-rs` 实现 RFB 协议）：支持 ZRLE/CopyRect/Raw 编码、VNC-Auth（DES 挑战响应）与无认证；键盘（JS keyCode → X11 keysym，含 Shift/CapsLock 处理）、鼠标（JS 按键掩码 → RFB 掩码、滚轮）、Latin-1 剪贴板。
- **RDP 与 VNC 的 SSH 跳板机（堡垒机 / ProxyJump）隧道**：两协议共用同一传输层，支持任意跳板端口（含标准 22 端口）；经容器化夹具完成端到端验证（live 测试、隧道断开负向控制、应用内 UI 全流程及 /proc/net/tcp 内核级证据）。
- **Docker 测试夹具**：`e2e/fixtures/vnc`（Xvfb + x11vnc + openbox + xterm）、`e2e/fixtures/ssh-jump`（sshd）。
- **Live 集成测试**：`vnc_live.rs`（直连 + 跳板机）、`rdp_live.rs` 跳板机变体，均落盘合成帧用于视觉验证。

### Changed

- RDP 传输层抽入共享 `desktop_transport` 模块（两协议统一走直连 TCP 或 SSH direct-tcpip 通道）。

### Fixed

- _Add bug fixes here_

- **SFTP 系统剪贴板文件互操作**：文件列表 Ctrl/Cmd+C 将选中远程文件下载到应用缓存并写入 macOS / Windows / Linux 系统剪贴板，可在 Finder / Explorer 粘贴；Ctrl/Cmd+V 在应用内虚拟剪贴板为空时读取本地文件引用并排队上传，虚拟剪贴板仍优先服务远程→远程复制/剪切。
- **服务器文件在线编辑编码转换**：独立文本编辑器新增编码选择器，支持 UTF-8、GBK、GB18030、Big5、Shift_JIS、EUC-JP、EUC-KR、Windows-1252、ISO-8859-1。干净文件切换编码会按新编码重新解码；已修改文件切换编码会在保存时转换，且不可表示字符直接报错而非静默替换。
- **文件列表右键菜单按类型分支**：文件行提供打开/编辑/日志监视/下载等文件动作；目录行提供打开文件夹与目录下载，避免目录与文件操作混用。
- **PostgreSQL「保存到记事本」重构**：目标笔记改为可搜索 Combobox，追加/新建模式即时切换；SQL 注释必填并作为片段头行，重复片段检测会禁用保存。

### Fixed

- **嵌套右键菜单双弹框**：`ContextMenuTrigger` 在次级 mousedown 合成 contextmenu 后阻止事件冒泡，文件行右键不再同时触发外层空白区菜单。
- **保存到记事本超长标题布局**：对话框 grid 轨道可收缩、触发值和搜索输入截断、Popover 与触发器同宽且限制在视口内，修复浮层失控与按钮遮挡。
- **浅色主题终端残留深色**：统一旧默认主题 sentinel，主题切换显式通知 portaled terminal，并清理 xterm WebGL glyph atlas 后刷新可见行。
- **右键菜单贴底裁切**：文件菜单增加 viewport collision padding 与内部滚动高度上限，末项在矮视口中保持可完整点按。

### Test Infrastructure

- 新增真实应用 E2E：PostgreSQL 保存到记事本全链路、SFTP 文件/目录/空白区右键菜单与系统剪贴板空态、远程编辑器 GBK 编码读取。
- E2E 菜单截图改为 WebDriver viewport 捕获，并在截图前后校验菜单 opacity、背景与 viewport 几何，避免采集到错误窗口或透明动画态。

## [2.15.0] - 2026-08-31

**PostgreSQL 注释（comments）全链路支持 + 数据网格快捷动作**：DBeaver 对齐——注释从 catalog 一路贯穿到 DDL 生成、导航树提示与 SQL 补全；另补行数统计、复制为 INSERT、search_path 同步三项高频动作。

### Added (Database Toolbox — PostgreSQL)

- **注释（comments）全链路支持**：
  - **DDL 往返**：`生成 DDL` 在 `CREATE TABLE` 之后追加 `COMMENT ON TABLE` / `COMMENT ON COLUMN`（按 pg_dump 顺序：表注释优先，其后列注释），单引号按 `''` 转义，生成的 DDL 可原样重放还原注释。
  - **导航树提示**：表 / 列节点 hover 显示注释（`obj_description` / `col_description`），无需打开属性面板。
  - **SQL 补全**：补全候选项带出列注释，区分同义列名时不再靠猜。
  - **数据网格「注释」列默认开启**：与 DBeaver 一致；迁移前已保存的旧布局（未存过该开关）同样继承默认值而非静默隐藏。
- **行数统计**：导航器右键 `行数统计 (COUNT)` 直接返回「共 N 行」，另有 `表统计信息` 入口。
- **复制为 INSERT 语句**：结果网格选中行 → 一键生成可直接执行的 `INSERT INTO … VALUES (…)`（字面量按类型转义；缺少表/列信息时给出明确提示而非产出坏 SQL）。
- **search_path 同步**：按导航器当前选中 schema 同步会话 `search_path`（schema 名做标识符校验），裸表名补全与查询不再解析到 `public` 下的同名对象。

### Fixed

- **新建连接后第一个查询必然失败**（产品 Bug）：工作区启动时带一个占位 query tab，它绑定的是「初始 draft id」；点「新建连接」会铸造全新 profile id，而占位 tab 从不回绑，于是首个查询发往后端从未注册过的连接，报 `PostgreSQL connection is not active`，用户无从判断「为什么我的第一条查询毫无反应」。连接建立成功后把所有**从未执行过**（`result == null`）的 query tab 回绑到实际连接；已跑过结果的 tab 一律不动，避免把真实工作静默挪到别的连接上。
- **Ctrl+T 停止查询在焦点离开编辑器后失效**（产品 Bug）：点击工具栏「执行」后焦点移到按钮、查询结束后焦点落在结果网格，而 `database.query.stop` 此前仅注册在 `QUERY_EDITOR` 作用域——结果是最需要它的时刻（查询正在跑）快捷键却是死键。作用域放宽到工作区与数据网格；处理函数本身有 `running` 守卫，非执行态仍为空操作。
- **焦点丢失时数据库快捷键整体失灵**（产品 Bug）：WebKit 会在元素变 disabled 的瞬间把焦点交回 `<body>`——而「执行」按钮在查询启动时正是这么做的。归属判定此前只认「焦点在本工具容器内」，焦点落到 body 时所有数据库快捷键静默失效（含 Ctrl+T）。改为焦点丢失时以「本工具容器可见」认领归属；非活动工具带 `hidden` 类，故任意时刻至多一个工具能匹配。
- **快捷键 handler 竞态**（产品 Bug）：`optionsRef` 用 passive `useEffect` 同步，DOM 提交（Run 变 disabled）到 effect flush 之间存在窗口，此窗口内到达的 keydown 读到的是旧闭包（`running=false`），Ctrl+T 静默空转。改用 `useLayoutEffect` 在提交期同步，早于任何输入事件。
- **长结果集里「新增记录」行不可见**（产品 Bug）：users 表 70 行超过虚拟滚动阈值（60）后进入窗口渲染，Add Record 的暂存 INSERT 行落在 index 70，渲染窗口停在 0~30 从未挂载——用户点了「新增」却什么都没出现。暂存行改为不参与窗口裁剪、始终挂载且排在 bottom spacer 之后，暂存时自动滚到底部；bottom spacer 按已提交行的缺口计算，无暂存行时与旧逻辑等价。
- **文件拖放 hook 在渲染期写 ref**（正确性问题）：`use-webview-file-drop` 在组件渲染过程中直接赋值 `optsRef.current`，并发渲染下不安全。改为在 layout effect 中同步（早于下面的订阅 effect，订阅者拿到的始终是最新 options）。
- **SQLite 工具 `patchTab` 前向引用**：`patchTab` 声明在引用它的三个 effect 之后，属 `react-hooks/immutability` 违规，上移到 effect 之前。

### Test Infrastructure

- **E2E 串行多 spec 状态污染**：同一 run 内第二个及以后 spec 拿到的是已解锁的共享应用，`unlockApp` 的两个等待目标（锁屏 / 已连接）同时不成立 → 30s 超时。改为逐 spec 独立调用（每轮全新 data-dir）。
- **E2E 跑的是过期二进制**（本次排查的关键教训）：Tauri 在**编译期**把 `frontendDist` 嵌进二进制，`pnpm build` 只刷新 `dist/`，对已存在的 `src-tauri/target/debug/nexterm` 毫无影响。此前所有 `pnpm build` 后的 E2E 结论实际上都跑在旧前端上，制造了一连串无法复现的「幽灵 Bug」。E2E 的正确构建链是 `pnpm build && pnpm tauri build --debug --no-bundle`；本轮在此之后 26 个 spec 里 5 个立刻转绿。
- **E2E 单实例插件互斥**：macOS 下 single-instance 插件用 `/tmp/{identifier}_si.sock` 判活，串行重启动应用时可能误连上一实例的 socket 而 `exit(0)` 自杀。E2E 模式（`NEXTERM_DATA_DIR` 已设置）跳过插件注册，生产多开保护不受影响。
- **Spec 漂移修复**：`b21-context-menu` / `bugfix-contextmenu` 断言的「复制名称」已于 b66ee9e 改为「复制限定名」；`mysql-workspace` / `sqlite-workspace` 因 fe1d1f2 隐藏对应导航入口而不可达，改为显式 `it.skip` 并注明恢复条件；`postgres-visual` 补截图目录创建。
- **`postgres-visual` 断连断言未处理二次确认**：spec 先键入 CREATE VIEW 让 query tab 变脏，再点「断开」——而产品在存在未保存 SQL 时会先弹确认框（正确行为）。spec 补上「丢弃并断开」分支。
- **`postgres-grid-edit` 虚拟滚动 flake**：save 后直接断言「能找到合并行」是竞态——合并行追加在 70+ 行结果集末尾，渲染窗口只覆盖 ~30 行，首次查找时可能尚未挂载。改为轮询 + 在两次尝试间把网格滚到底（与用户操作一致）；「旧值已消失」改为断言同一行索引现在承载新值，避免旧值仅因滚出窗口而造成的假通过。
- **清理误入库的临时诊断 spec**：删除 5 个 `_`-prefixed QA 诊断（`_fe-diag-window` / `_diag-dialog-geometry(-small)` / `_diag-perf-baseline` / `_diag-toolbar-clip`）。它们自带「用完即删」声明，随 `39af290` 的 untracked 工作被误收进仓库；不在 CI 内、断言实现内部细节（spacer 元素、窗口行数、像素几何、性能计时），且 3 个因其自身导航树 helper 在窗口过小时取不到 `button=users` 而恒红——已确认**不反映产品缺陷**。

### Release Verification

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过 |
| `eslint src/ --quiet`（error 级） | 0 |
| `pnpm test`（vitest） | 113 文件 / 1051 测试通过 |
| `cargo test` | 292 通过 / 8 ignored |
| `pnpm i18n:check` | 2212 key 双向对齐 |
| 真实应用 E2E（WebdriverIO + Tauri） | 21 / 21 通过 |
| `pnpm test:e2e`（Playwright） | 24 通过 / 1 skip |

> 说明：本地 `cargo clippy -- -D warnings`（58 项）与 `cargo fmt --check`（278 处）有告警，但全部落在本次改动行范围之外，且 22 分钟前 main 上 CI 仍为成功——本地工具链为 rustc/clippy 1.97.1，比 CI 的 `dtolnay/rust-toolchain@stable` 更新（例如 `t("menuBar.*")` 的 needless-borrow 属新版 lint）。故判定为工具链版本差，非本版本回归，未做无收益的大范围改动。

### Removed

- 5 个临时诊断 spec（见 Test Infrastructure），不再计入 E2E 套件。

## [2.14.1] - 2026-08-31

**发布链路修复版**：修复 2.14.0 发布事故（平台资产缺失）+ CI 三平台测试连续失败，发布流程自动化加固。

### Fixed (CI / Release)

- **v2.14.0 平台资产全丢事故**：macOS / Linux / Windows 安装包全部缺失，release 只剩 portable ZIP。根因是 tauri-action 按 tag 查找 release 时看不到未发布状态，自行创建被 403 拒绝——此前版本成功纯属时序运气。新增 `create-release` 前置 job（构建开始前即创建并发布 release），彻底消除竞态。
- **Windows JAR 重编译条目损坏**（产品 Bug）：`compile.rs` 收集 .class 路径时 Windows 下产出反斜杠分隔的 JAR 条目名（`com\example\A.class`），回写 JAR 后条目损坏。统一转为 `/` 分隔。
- **Test workflow 三平台连续失败**（8/25 起）：`jar_hierarchy` 集成测试漏标 `#[ignore]`（CI 无 JDK）；`pom` 测试误断言开发机 `.m2` 仓库内容，改为自建临时夹具。
- **Release workflow 死链路清理**：删除 updater / homebrew-tap 相关 job（应用未启用自动更新、仓库无签名密钥与 tap token，每次发布必红）。

### Changed (CI)

- **main push 不再触发安装包构建**：portable workflow 仅 tag 触发；main 推送只跑测试门禁。
- **Release 产物自动保留最近 3 个版本**：每次发布完成后按语义化版本清理旧 release（含 tag），避免产物无限堆积。

## [2.14.0] - 2026-08-28

**DB 工具箱 UX 评审收口（P2-9~14 + 杂项）+ 安全/CI 加固 + 发布链路修复**。

### Added (Database Toolbox)

- **L3 连接级错误横幅**（P2-10）：断线 / 连接失败 / host-key 变更时 toolbar 下方出现 h-9 常驻横幅（红色警示 + 重新连接按钮 + fade-in 0.2s），重连成功或手动断开自动消失——替代原 4s 即逝的 toast，错误信息不再丢失。
- **导航树行内重试**（P2-9）：子树加载失败时错误文案旁出现「重试」按钮，强制重载失败子树。
- **错误卡标题动词化**（P2-13）：按动作区分「查询失败 / 解释失败 / 浏览失败」（对齐 ux-spec §2.4 模板），错误码与消息重复表意时去重。
- **列节点「复制列定义」**（评审 1.11）：右键列节点一键复制 `ALTER TABLE … ADD COLUMN …` DDL 片段。
- **错误行波浪线**（评审 4.6）：SQL 出错行编辑器内红色波浪下划线 + 2s 渐隐自动清除（CodeMirror line decoration）。

### Fixed

- **执行中网格遮罩**（P2-11）：查询运行中旧结果集置灰禁交互（opacity-60 + pointer-events-none），不再可双击编辑过期数据。
- **剪切 / 复制无选中置灰**（评审 2.5）：编辑器无选中文本时右键 cut/copy 菜单项 disabled。
- **表设计器 Escape 两级语义**（P2-14）：输入框内首次 Esc 退出编辑，再次 Esc 才 revert 草稿。
- **结果面板空态升级**（P2-12）：Inbox 图标 + 复制消息 / 清空结果右键菜单；查询历史空态补副文案（5.9）。
- **传输队列（上传/下载列表）无滚动条**：Radix ScrollArea viewport 在 max-h-only 容器下永不收缩导致溢出被静默裁剪——`viewportClassName` 透传修复，传输队列与目录传输错误日志两处生效。
- **文件管理右键双菜单**：右键文件同时弹出文件行菜单与空白区菜单（嵌套 ContextMenu 事件冒泡双触发）——行级 `stopPropagation` 修复，右键空白区行为不变。
- **Windows 免安装包命名**：portable ZIP 由无版本的 `NexTerm-portable.zip` 改为 `NexTerm_<版本>_<架构>-portable.zip`（如 `NexTerm_2.14.0_x64-portable.zip`），与安装版命名族对齐；打包脚本缺版本号 fail-fast，workflow 命名权单源收敛。

### Added (Security / CI)

- **设置页安全警示**（P1）：关闭「主机密钥验证」后设置页显示红色警示条（中间人攻击风险提示）。
- **TOFU E2E 场景**（P2）：新增 `host-key-tofu.e2e.ts`——首连指纹确认 → 信任保存 → 连接成功，以及拒绝时 fail-closed 不连接。
- **Docker SSH 回归 CI**（P1）：`scripts/ssh-fixture.sh`（Docker OpenSSH fixture）+ 可选 GitHub Actions job（workflow_dispatch / ssh 路径触发，不阻塞 merge），覆盖 PTY 并发 SFTP 上传回归。
- **WDIO 并行冲突消除**：强制 `maxInstances = 1` 串行 + 每进程 `mkdtemp` 唯一数据目录，拒绝「并行 + 共享目录」组合。
- **标签关闭断链修复**（P1-1）：关闭终端/文件/桌面标签页时按协议分发后端断开（ssh / sftp_standalone / ftp / desktop_disconnect），会话不再泄漏。
- **既有 warning 清理**（P3）：cargo 30 → 0（删废弃 DTO 与死函数、cfg(windows) 收敛、前瞻 API allow+注释、eprintln→tracing）；eslint 1 error + 248 w → 0 error + 243 w（余量为存量技术债）。

### Verified

- tsc 0 error / vitest 113 文件 1041 用例全绿 / cargo test 294 passed 0 failed / cargo check 0 warning / eslint 0 error / i18n en-zh 0 diff
- `tauri build --no-bundle` 本机跑通（macOS arm64，60MB Mach-O）；正式发布以 release.yml CI 产物为准

### Added / Fixed (Terminal) — 命令提示框交互优化（Slice 2-4 及交互修复）

- **消隐体系**：IME 组合 / 粘贴（bracketed paste）/ 失焦 / 滚动四类门控——全屏输入法候选、粘贴文本、切窗、滚屏均不再误触发建议弹窗；防抖 20ms → 50ms 可配置。
- **Esc 负反馈**：关闭建议框时对全部候选降权（`recordRejection`），学习引擎立即降温误候选。
- **精细配置**：新增「命令提示防抖（毫秒）」下拉（20/50/100/200）与「全屏应用中抑制提示」开关，与既有命令提示总开关同组。
- **P0 修复·鼠标误选**：hover 仅预览（浅色描边）、不再污染键盘选中——Enter 只响应 ↑/↓ 主动选择，**无选中时 Enter 绝对执行用户输入**；补 onMouseLeave、选中越界重置。
- **P0 修复·光标跟随**：建议框按实际弹层高度落位（不再以固定 190px 预占触发误翻转），底部光标场景贴行显示。
- **P1 修复·接受建议重写**：段级替换算法（前缀补尾防双空格 / 整段替换保留管道前缀 / 中段光标右移删词插入），修复 `git log ` + `git status` 拼成脏命令、`git e` + `git fetch` 残词等缺陷。
- **P1 修复·点击候选**：候选 button 防 blur 抢先关窗，鼠标点击真正生效。
- **P2**：点击弹窗空白不再误关窗抢焦点（排除 suggestion 区）；dark 主题弹窗边框/阴影对比增强。

### Verified

- tsc 0 错误 / vitest 111 文件 1037 用例全绿 / lint 0 error / E2E 7 场景（A-G）全过（含 hover 后 Enter 执行输入、点击替换 `git commit`、回归）
- Hy3 视觉复核 4/4 PASS（弹窗贴光标 / vim 抑制 / Esc 无残影 / settings 版式）

## [2.13.0] - 2026-08-28

**DB 工具箱三库（PostgreSQL / MySQL / SQLite）UX 对齐增强 + 终端命令提示框显示时机优化**。

### Added (Database Toolbox)

- **三库右键菜单对齐**：导航树（连接 / 表 / 列 / 索引节点）、SQL 编辑器、结果网格、查询 Tab 四类菜单三库统一——lucide 图标、`ContextMenuShortcut` 快捷键标注（Ctrl+Enter 执行 / F5 刷新 / Ctrl+N 新建查询等）、危险项 `variant="destructive"` 置底；PG 主工具就地补齐图标 / 快捷键 / 危险项，删除连接升级为 AlertDialog 确认。
- **错误工程化**：三库统一结构化错误解析（`parseDatabaseError`），错误卡进入结果面板（错误码 / LINE 定位 / 一键跳转出错行 / 重试 / 复制），出错行编辑器高亮，轻量 toast 通知。
- **快捷键接入**：基于 scope-router 激活的 `useDatabaseKeyboardShortcuts` 收敛（Ctrl+Enter 执行、F5 刷新、Ctrl+N 新建查询、表设计器 Ctrl+S 保存 / Escape 退出），与菜单快捷键标注同源。
- **导航树「生成 SQL ▸」子菜单**：表 / 列节点一键生成 SELECT / INSERT / UPDATE 语句进入编辑器。
- **查询历史视图**：历史进结果面板（成功 / 失败状态点、耗时、再次执行、插入编辑器、复制、删除、清空确认），三库统一接入。

### Added (Terminal)

- **命令提示框 TUI 全屏抑制**：SSH 终端命令建议框新增双层门控——运行 vim / less / top / htop / fzf 等全屏程序（xterm alternate screen buffer）时**硬性禁用**提示框，退出自动恢复；叠加「提示符行尾上下文」软规则（`suggestion/gate.ts`），TUI 导航 / 行编辑类应用（mysql / psql 等）按键不再误触发弹框。已同步清理进入全屏模式时的输入缓冲 / 防抖计时器 / Tab 补全书签，避免竞态污染命令历史。新增 12 项门控单元测试（含 CJK 多字节 / 边界）。

### Verified

- tsc 0 错误 / vitest 1011（109 文件）全绿 / lint 0 error / 生产构建通过
- 命令提示框门控经独立 QA 审查 PASS（Note 已闭环）；GATE 视觉门禁 25 项运行时断言 PASS；e2e 集成套件 `db-toolbox-ux.e2e.spec.ts` 4 passed / 1 skipped（预期）

## [2.12.0] - 2026-08-27

**Minor — SQL 编辑器右键菜单完善 + 数据网格窗口化（性能根治）+ Excel 导出（真实应用 E2E 验证）**。

### Added (Query Editor)

- SQL 编辑器右键菜单补齐编辑组：撤销 / 重做（CodeMirror `undo`/`redo`）、剪切 / 粘贴 / 全选（`cut`/`paste`/`selectAll`），经 `runCmCommand` 包装聚焦查询编辑器执行。
- 查询结果右键菜单新增「导出 Excel」：复用项目已有 `xlsx` 依赖，`json_to_sheet` + 保存对话框（`.xlsx`），与既有「导出 CSV」并列。

### Changed (Data Grid / Perf)

- **数据网格行窗口化（spacer-tr）**：`database-result-pane.tsx` 通过新增 `useRowWindow` hook（`src/lib/database/use-row-window.ts`）只挂载可视窗口行 + 上下高度占位行，阈值 >60 行自动启用，小结果集保持全量渲染不变。Pg/MySQL/SQLite 三工作区自动受益。
  - 兼容性处理：find 跳转改为容器像素滚动（目标行未挂载时依旧可用）；编辑中的行强制保持挂载避免滚动触发提前提交；`pendingInsertRows` 并入总行数做 `rowAt(i)` 映射。
- **行组件 memo 化**（`CommittedRow`/`InsertRow`）：编辑单格时未触及行跳过重渲染；列样式/PK Set/find Set 计算全部 useMemo 缓存。
- 性能实测（1000 行 × 15 列，真实应用）：打开网格 **1222ms → 40ms（约 30×）**，挂载行从全量 1000 降至窗口 ~30。

### Fixed

- 数据列表工具条在窄窗口（<900px）溢出且无水平滚动：主工具条 header 与查询 tab 内层工具条容器加 `overflow-x-auto`，按钮加 `shrink-0` + 文案 `whitespace-nowrap`，小窗口下可滚动到达最右侧按钮。

### Verified

- tsc 0 错误 / vitest 849（97 文件）/ cargo test 全绿 / lint 无新增（1 error 为存量）
- 真实应用 E2E：toolbar-clip（6/6）、perf-baseline（窗口化对比 1000×15：1222ms→44ms）、postgres-save-to-notes（1/1）、postgres-grid-edit（1/1）、dialog-geometry（7/7）、postgres-query-commands（3/3）

## [2.11.1] - 2026-08-27

**Patch — 构建体积优化 + 代码分割体验保障（真实应用 E2E 验证）**。

### Changed (Build / Perf)

- **构建体积大幅缩减**：主包 index 由 3.3 MB（gzip 999 KB）降至 585 KB（gzip 161 KB，约 -84%）。11 个工具箱视图（服务器 / 应用 / 保险库 / 隧道 / 服务 / 记事本 / 命令历史 / API 调试 / PostgreSQL / SQLite / MySQL）改为代码分割按需加载；codemirror、sql-formatter、xlsx、recharts、xterm、react 等重依赖拆分为独立 vendor chunk（稳定可缓存）。system-monitor 由 433 KB 降至 31 KB。
- **代码分割不牺牲体验**：应用挂载后在空闲时段后台预取全部工具视图，切换菜单即时显示，无「点击后才加载」的等待。

### Fixed

- 清理已废弃的 `nexterm:append-sql-note` 事件监听（SQL 保存到记事本已改经标题对话框，无派发方，避免误触发）。
- SQL 保存到记事本：对话框打开期间切换查询页不再写错对象（打开时快照语句内容）；追加到空笔记不再产生前导空行。

### Verified

- tsc 0 错误 / vitest 829（93 文件）/ lint 无新增 / chunk 体积保持 585 KB
- 真实应用 E2E：postgres-save-to-notes（1/1 passing，代码分割 + 预取下工具面板加载正常）

## [2.11.0] - 2026-08-27

**Minor — SQL ↔ 记事本双向流转 + 弹窗定位修复（真实应用 E2E 验证）**。本版同时落地 v2.10.1 已预告的「SQL 记事本归档」「PostgreSQL 会话加固」「多连接会话隔离」三项能力。

### Added (Toolbox)

- **SQL 保存到记事本**：PostgreSQL 查询页可将当前语句（或全文）一键保存到记事本——已在记事本选中记录时以 `-- 标题` + SQL 换行追加，否则新建 SQL 记录；保存后记事本面板自动刷新（`nexterm:toolbox-changed`）。
- **记事本 SQL 右键「粘贴到查询页」**：SQL 笔记右键菜单可一键将内容粘贴到所选 PostgreSQL 连接对应的查询页；若该连接尚未建立，先自动建立连接再打开查询页，仅粘贴不自动执行。
- **桌面 E2E 覆盖**：新增 `postgres-save-to-notes` 场景（真实应用可见模式验证通过）。

### Fixed

- **指纹确认框 / 保存到记事本对话框定位偏移**：`!inset-0 !m-auto` 覆盖 shadcn `DialogContent` 默认 `top-50%/left-50%` 时未抵消默认 `translate-x/y-[-50%]`，导致弹窗被二次平移偏出中心；已为三处弹窗（SSH 首连指纹框、Postgres 隧道指纹框、保存到记事本框）补齐 `!translate-x-0 !translate-y-0`，指纹框另加 `max-h-[85vh] overflow-y-auto` 防止长指纹溢出。全局复核 30+ 弹窗无同类问题。
- **PostgreSQL 数据安全与工作区生命周期**（v2.10.1 预告落地）：原始 SQL 执行禁止未跟踪的事务控制；只读连接在后端拒绝非读取 SQL；断开连接会关闭其全部工作区标签；存在未保存内容时可保存 SQL 后关闭或明确丢弃，已保存的 SQL 在再次连接时自动恢复。
- **PostgreSQL 多连接会话隔离**（v2.10.1 预告落地）：查询、表格、对象、DDL 与设计器标签永久绑定其 `connectionId`，执行/取消/保存/刷新均使用标签自己的连接，避免切换到其他连接后误操作。

### Verified

- tsc 0 错误 / vitest 829（93 文件）/ cargo test / i18n parity 2058 keys / lint 无新增
- 真实应用 E2E：postgres-save-to-notes（1/1 passing）

## [2.10.1] - 2026-08-27

**Patch — 用户反馈三 bug 修复 + UI 布局调整（真实应用 E2E 验证）**。

### Added (PostgreSQL)

- **新建表设计器**：在 PostgreSQL 导航器的“表”分组右键即可新建表；支持表名、列、主键、约束、索引、外键及表/列注释，并在保存成功后自动切换为常规表设计模式以便继续编辑。
- **CREATE TABLE 安全校验**：服务端拒绝空表和混入 ALTER/DROP 操作的创建请求；CREATE DDL 完整生成索引、排除约束及注释，所有操作保持单事务原子性。
- **桌面 E2E 覆盖**：新增“右键新建表 → 填写列 → DDL 预览 → 保存 → 导航器出现新表 → 清理”的端到端场景，并为设计器列名/类型提供稳定测试标识。

### Changed (UI layout)
- **DDL 预览移到界面右侧面板**：双击导航器表/视图/物化视图时，右侧竖栏显示格式化 DDL（不再单击触发、不再占查询页顶部）。
- **双击打开表 = 数据网格全屏**：table 浏览 tab 不再有空白占位/分隔条，结果网格占满整个 tab；SQL 执行面板仅查询（query）页保留。
- **数据网格筛选入口常驻**：table 工具条「筛选 (Filter & Sort)」按钮始终可见（此前仅已有过滤条件时显示），点击打开多条件筛选对话框（列/运算符/值 + AND/OR + 排序），支持增删条件。右键字段值过滤保留。

### Fixed
- **PostgreSQL 数据安全与工作区生命周期**：原始 SQL 执行禁止未跟踪的事务控制；只读连接在后端拒绝非读取 SQL 和旧表格写接口。修复表设计器对未修改主键的错误拦截。断开连接会关闭其所有工作区标签；存在未保存内容时可保存 SQL 后关闭或明确丢弃，已保存的 SQL 在再次连接时自动恢复。
- **SQL 记事本归档**：查询页可将当前语句（或全文）一键保存到记事本；已选择记事本记录时换行追加，否则创建新的 SQL 记录。
- **PostgreSQL 多连接会话隔离**：查询、表格、对象、DDL 和设计器标签现在在创建时永久绑定其 `connectionId`；执行 SQL、取消查询、保存表格变更、保存视图、删除对象、刷新与分页均使用标签/对象自己的连接，而不是侧栏当前选中的连接。并在工作区工具栏显示该标签的连接名称，避免测试标签页在切换到生产连接后误向生产执行。
- **数据库对象列表截断**：对象导航器表/视图组复用 SQL 补全命令（LIMIT 100）导致 schema 超 100 张表只显示前 100 张。导航器显式传 limit 10_000（Rust clamp 放宽，补全默认 100 不变）。回归 spec：150 表 fixture 全量显示。
- **全局右键弹出浏览器默认菜单**：window 冒泡阶段 `contextmenu preventDefault`（捕获阶段会致 Radix 自定义菜单短路——已实证并规避）。空白区无原生菜单、导航器/网格自定义菜单正常。
- **右键「生成 DDL」未格式化**：`generateObjectDdl` 直接写入 catalog 原始 DDL（表/视图等单行），未走 `formatSql`（与单击 DDL 预览面板不一致）。修复：统一格式化。新增 E2E：视图「生成 DDL」→ tab 内多行格式化 CREATE OR REPLACE VIEW。
- **Excel 编辑器横向滚动条不可见**：macOS WKWebView 网页层不渲染滚动条（像素级验证）、CSS `::-webkit-scrollbar` 被忽略（平台行为）。**跨平台方案（兼容 Windows 台式机）**：Windows/Linux（WebView2/Chromium）原生滚动条常驻可见（`::-webkit-scrollbar` 生效）→ 不显示提示；macOS 仅显示保守提示文案「内容超出可视区域 · 悬停右缘或 Shift+滚轮可横向滚动」（鼠标可用，不依赖触控板）。不引入自定义滚动条组件。

### Verified
- tsc 干净 / vitest 829（93 文件）/ grid-edit、filter、b21 回归全绿
- 新 E2E：postgres-load-complete（3/3）、bugfix-contextmenu、bugfix-xlsx-scroll

## [2.10.0] - 2026-08-27

**Minor — SQL 格式化 + DDL 预览面板 + PG 表设计器 + View Builder**。Step 2（⌘⇧F SQL 格式化 / DDL 预览面板 / ⌘↩ 执行选中）+ Step 3（B23 Table Designer：声明式列编辑器、PK 复选框、约束/索引/外键折叠区、DDL 预览 dry-run + 警告确认对话框 + 事务回滚 + View Builder）。

### Added (Step 2 — SQL Formatting)

- 🎨 **⌘⇧F SQL 格式化**：sql-formatter v15.8.2（PostgreSQL dialect, uppercase keywords），Navicat 风格基线；CodeMirror 编辑器内一键格式化。
- 📋 **DDL 预览面板**：对象右键 → DDL Preview，独立面板展示 CREATE 语句。
- ▶️ **⌘↩ 执行选中**：Query 编辑器内选中 SQL 后 ⌘↩ 仅执行选中部分。

### Added (Step 3 — B23 Table Designer + View Builder)

- 🏗️ **postgres_design.rs**：3 个 Tauri 命令（`postgres_table_design_load` / `postgres_table_design_apply` / `postgres_view_save`），服务端 DDL 生成 + 标识符引用 + 事务原子性回滚（D-B23-2..7）。
- 📐 **table-design.ts**：前后端共享类型契约（1:1 镜像 Rust serde 结构体）；纯前端 `diffTableDesign` 函数（列/主键/约束/索引/外键/注释差异计算）；`dropDefault` / `dropComment` 精确 ALTER 列级操作。
- 🖥️ **table-designer-tab.tsx**：声明式表单 — 列编辑网格、PK 复选框、约束/外键折叠区、防抖 DDL 预览（dry-run）、警告确认对话框、Save/Revert/Refresh 工具栏。
- 🔗 **tool-postgres.tsx**：Designer 标签路由（table + view）、右键菜单（Design Table / Design View）、视图编辑器（CodeMirror + Save）。
- 🎯 **command-registry.ts**：新增 DESIGNER scope（第 6 个 scope）+ 5 个设计器命令 ID。
- 🌐 **i18n**：40+ 设计器键（en + zh-CN，2042 parity）。
- 🧪 **测试**：22 个 diff 单元测试（属性测试 + 定向用例）、23 个命令注册表测试、Rust build_statements 单元测试。

### Verified

- tsc: 0 errors
- vitest: 828/829 pass（1 pre-existing failure: command-history-record, unrelated）
- cargo test: pass
- cargo check: pass
- eslint: 0 errors, 2 warnings (react-hooks/set-state-in-effect, acceptable)
- i18n parity: 2042/2042

## [2.9.1] - 2026-08-26

**Patch — UX 复评修复 + Lint 基线收敛**。基于 v2.9.0 视觉复评记录（`docs/database/v291-visual-review.md`）关闭 B-1 / B-2 / M-1 / M-2 / m-1 五项遗留，并合并 Step 1 单元测试与 Lint 基线清理。

### Fixed (视觉门禁修复)

- 🍞 **B-1 Toast 小窗自适应**：sonner.tsx 的 `Toaster` 配置改为 `maxWidth: "min(320px, calc(100vw - 32px))"` + `marginTop: 56px` + `width: fit-content`；960×700 小窗下 Toast 不再横向贯穿遮挡顶部工具栏与对话框字段。
- 📜 **B-2 SQL/DDL 编辑器水平滚动**：globals.css 强制 `.cm-editor .cm-content { white-space: pre; }`，2048×1200 与小窗下长 SQL/DDL 均通过水平滚动查看，不再强制折行截断。
- 🌳 **M-1 对象树完整捕获**：v29-visual-capture.e2e.ts 截屏前显式滚动到对象树顶部并展开 `users` 表，01-object-tree.png 与 06-grouped-navigator.png 均显示完整的 `V29 ▸ V29 Visual ▸ nexterm_e2e ▸ public ▸ 表(7个) ▸ 视图 ▸ 物化视图 ▸ 函数 ▸ 序列` 五类对象分组。
- 📸 **M-2 小窗截图去重**：v29-visual-capture.e2e 显式关闭 ConnectionDialog 后才截图 `07-small-dialog-fields.png`，与 `06-small-grouped-navigator.png` MD5 分离，内容分别是真实的对话框与小窗分组导航器。
- ☀️ **m-1 浅色主题编辑器**：CodeMirror 主题跟随工作区明暗，`10-light-editor.png` / `06-light-grouped-navigator.png` 均显示纯浅色背景，不再残留 dark oneDark。

### Fixed (测试与 Lint 基线)

- 🧪 **S1-3 jump-persistence 测试竞态**：`src/lib/__tests__/jump-persistence.test.ts` 把固定 `sleep 10ms` 改为 `vi.waitFor(...)` 轮询 PG 端口异步写入完成路径，杜绝间歇性 `expect(jump_host).toBe(...)` 提前判定。
- 🧹 **Lint 基线收敛**：
  - `eslint.config.js` 把 `react-hooks/immutability`（v7 新规）由 error 改为 warn，对齐既有的 `react-hooks/set-state-in-effect` / `refs` / `purity` 三条 warning（递归 useCallback 自引用等模式存在已知误报）。
  - `tool-jar-decompiler.tsx` 把 `setTimeout(async () => …)` 改为 `setTimeout(() => { void (async () => { … })(); })`（setTimeout 需要 Timer handle，不能直接接受 Promise）；navigateRef 当前函数赋值加 `eslint-disable-next-line @typescript-eslint/no-misused-promises`（最新函数 ref 模式）。
  - `scope-router.test.ts` 移除未使用的 `vi` 导入。
  - `pnpm lint`: 0 errors / 229 warnings（warnings 全部为既有规则）。

### Verified

- **GATE**: `pnpm build` (tsc + vite) ✅ | `pnpm test`（91 files / 784 tests）✅ | `cd src-tauri && cargo test` ✅ | `pnpm lint` ✅ | `node scripts/check-i18n-parity.mjs` ✅ (1995 keys parity)
- **视觉复评三次**：基于 2026-08-26 23:15 重建 dist + 重截 13 PNG，五项视觉遗留全部关闭 PASS ✅（详见 `docs/database/v291-visual-review.md` §3.1）
- **E2E** (WDIO + debug 二进制 + PG 55432 fixture)：11 个 spec 全量实跑通过（smoke / b21-context-menu / b21-navigator-objects / b22-connections / mysql-workspace / postgres-filter / postgres-grid-edit / postgres-query-commands / postgres-visual / sqlite-workspace / v29-visual-capture）

## [2.9.0] - 2026-08-26

### 🗂️ Navigator Object Coverage & Connection Management (B21 + B22)

**Milestone M2 — 对象与设计**。导航器对象全覆盖 + 连接管理，PostgreSQL 工具箱进一步对齐 Navicat。

### Added (B21 — Navigator Object Coverage)

- 🌳 **六类对象入树**：表四子组（Columns/Indexes/Constraints/Triggers）+ Functions/Sequences 组懒加载；函数重载独立节点（签名区分）；约束类型前缀（PRIMARY KEY/FK/CHECK/UNIQUE）。
- 📖 **对象查看器**：函数/序列/索引/约束/触发器双击打开只读面板（DDL 预览 + 属性表格，权限错误通用化提示）。
- 🧭 **导航器语义**：单击选中、双击/Enter 打开（表→数据网格、列→所属表、其余→查看器）、断连缓存只读。
- 🎯 **对象菜单**：按类型启用的 Open/Copy Name/Generate DDL/Refresh/Drop；Drop 二次确认（AlertDialog + 依赖统计展示）；readOnly 下 Drop disabled；复制限定名（函数含签名/列含表限定）。
- 🔒 **后端加固**：`postgres_catalog_objects`（六 kind 参数化 + schema 白名单）、`postgres_object_props`、`postgres_object_ddl`（pg_get_viewdef/functiondef 等）、`postgres_drop_object`（白名单 kind→模板、存在性校验、confirmed dry-run、cascade 显式、readOnly 拦截、审计日志）。

### Added (B22 — Connection Management)

- 🎨 **连接颜色与虚拟分组**：color 字段迁移（PG/SQLite/MySQL 同构 + 迁移）；导航器按 group 分组渲染 + 连接节点色点/状态徽标/分组头。
- 📦 **导入/导出**：JSON 导出默认脱密（`__hasPassword` 标记）+ 可选 AES-GCM（`v1:` 信封）；导入大小/深度/字段白名单/原型键净化/分组名·颜色校验；append/overwrite 合并。
- 🧪 **批量测试/重连**：连接管理器单项+批量测试（并发≤5、结果矩阵）、断连状态徽标、Reconnect 入口（右键菜单）。
- 🔑 **11 个新命令 descriptor**（connection.test/batchTest/import/export/reconnect/manager + object.drop/generateDdl/properties + toolbar 控制）。

### Fixed

- 🔧 **B19 复合保存命令 3 个安全级 bug**（真实验证门禁抓到）：`current_setting('transaction_status')` 虚构 GUC 导致保存必失败；uuid 列 `RETURNING` 需 `::text` 否则 PK 回填失效；UPDATE 分支把 PK 写入 SET 子句 + 参数序号错位（主键可被改写风险）。
- 📐 **视觉门禁 2 Blocking**：Toast 小窗自适应（960x700 不遮挡顶栏/对话框）；SQL/DDL 编辑器默认不折行（长语句横向滚动，不截断）。

## [2.8.0] - 2026-08-26

**Milestone M1 — 日常核心 Parity 收官**。本版本聚合 B17（数据网格编辑闭环）、B18（过滤/查找/列布局）、B19（查询命令）、B20（快捷键体系）四个 Feature Batch，PostgreSQL 工具箱达到 Navicat 日常核心操作级对齐。

### ⌨️ Query Commands & Keyboard Scopes (B19 + B20)

Navicat-style query execution controls and a scoped keyboard system for the PostgreSQL toolbox.

### Added (B19 — Query Commands)

- 🚀 **Run current statement** (`Ctrl+Shift+R`) / **run selection** (`Ctrl+E`): a frontend SQL tokenizer (dollar-quoting, nested comments, string literals honoured) locates the statement under the caret; the editor selects it and the backend executes it.
- ⏹️ **Stop query** (`Ctrl+T` or toolbar button while running): cancels the in-flight query via server-side `pg_cancel_backend` over an independent connection, with a teardown fallback when the backend does not settle.
- 💬 **Toggle line comments** (`Ctrl+/`): adds/removes `--` on every line overlapping the selection, preserving indentation.
- 🧮 **Parameterized execution**: `postgres_execute_parameterized` binds values via the extended protocol (UNKNOWN-type casts); `None` = SQL NULL, `Some("")` = empty string; bounds enforced (≤256 params, ≤1 MiB/value, ≤4 MiB SQL).
- 🔐 **Transactional save hardening (M2/M3/M4)**: grid saves now run through a single `postgres_save_table_changes` command — BEGIN..COMMIT closes inside one call (no interleaving window), each update/delete validates `count == 1` (concurrent changes fail loudly instead of silently), and any failure actively ROLLBACKs server-side.
- ✂️ **Statement splitter** (Rust + TS mirrored lexers) with dollar-quote and nested-block-comment support.

### Added (B20 — Keyboard Scopes)

- 🧭 **Scope router**: DIALOG > QUERY_EDITOR/DATA_GRID > NAVIGATOR > DATABASE_WORKSPACE > GLOBAL priority routing; xterm textareas are a hard no-intercept boundary; macOS Ctrl/Cmd equivalence preserved.
- 🎯 **Navicat bindings**: 14 active groups (grid filter/save/insert/delete, query run/stop/comment, navigator open/refresh, workspace new-query/close-tab) declared on the command registry via `defaultBinding`; ER-diagram groups tracked hidden until B24.
- 🔀 **Conflict matrix**: Ctrl+N/W/Tab/Z and F5 never reach GLOBAL; Ctrl+R resolves by scope (grid filter vs query run); the legacy hand-written `onDatabaseKeyDown` paths are preserved and layered under the router contract.

### 🔍 PostgreSQL Data Grid Filter & Sort (B18 Slice A)

Navicat-style server-side filtering and sorting for PostgreSQL table data: build structured conditions in a dialog (or right-click a cell), and the grid re-queries with a fully parameterized WHERE clause. No SQL text is ever assembled on the frontend.

### Added

- 🎯 **Filter by field value**: right-click a cell to filter that column by its exact value; NULL cells filter with `IS NULL`.
- 🧰 **Custom Filter / Filter & Sort dialogs**: multi-condition AND/OR filters with the 9 supported operators (`=`, `≠`, `>`, `≥`, `<`, `≤`, `LIKE`, `IS NULL`, `IS NOT NULL`), plus multi-column ORDER BY with a primary-key tie-breaker for stable paging. Selecting `LIKE` hints at `%`/`_` wildcard support in the value placeholder.
- ⌨️ **Ctrl+R**: replays the active filter from offset 0, or refreshes the current page when no filter is applied.
- 🏷️ **Filter badge & clear**: the toolbar shows the active condition count and offers one-click clear (empty filter = clear, per A-12).
- 🔒 **Hardened backend**: `postgres_table_data` accepts a structured `filter`/`orderBy`; values bind as `$n::text::<type>` extended-protocol parameters, columns/operators/directions are whitelisted against live catalog metadata, cast types pass an ASCII character guard, and limits are enforced (≤32 conditions, ≤8 sort columns, ≤64 KiB values, offset ≤1M, 30s query timeout). The legacy `simple_query` browse path was removed.
- 📊 **Column metadata**: per-column formatted types and comments arrive alongside the result (`columnTypes`/`columnComments`) — groundwork for the column layout slice.
- ✏️ **Editing still works while filtered**: saving edits under an active filter re-queries the filtered view; the B17 transactional edit loop is unchanged.

### Notes

- Filter commands are read operations — read-only connections keep full filtering.
- Query-tab result grids expose no filter entry points.
- Native E2E for the filter loop is written but deferred pending a stable desktop environment (tracked as risk R9).

### 🖥️ PostgreSQL Data Grid Edit Loop (B17)

A transactional, Navicat-style edit loop for PostgreSQL table data: add records, edit cells, delete records with confirmation, and commit everything in a single transaction with full rollback on failure. New rows back-fill their generated primary keys so they stay editable.

### Added

- ➕ **Add Record**: toolbar button and `Insert` key stage a new row; only explicitly edited columns are submitted, so server defaults (e.g. `gen_random_uuid()`, `now()`) are preserved.
- 🗑️ **Delete Record**: row context menu with an in-app confirmation dialog; the row is visually marked and removed from the database on save.
- ✏️ **Set to Empty String / Generate UUID**: row context-menu commands alongside the existing Set NULL.
- 💾 **Transactional Save**: `Save changes` (toolbar + `Ctrl+S`) commits updates, inserts, and deletes inside one `BEGIN/COMMIT/ROLLBACK`; any failure rolls back the whole batch.
- 🧩 **New backend commands**: `postgres_table_insert` (returns generated PK values) and `postgres_table_delete` (PK-located), both with parameterized typed-cast SQL and no-PK safety guards.
- 🧹 **Dirty-tab guard**: closing a tab with unsaved edits (close button, tab menu, `Ctrl+W`) asks before discarding.
- 🧾 **Revert changes** toolbar action clears pending inserts/deletes and restores the baseline.

### Notes

- Read-only connections and tables without a usable primary key keep the existing write guards.
- The shared `DatabaseResultPane` props are backward compatible; SQLite and MySQL behavior is unchanged.

### 🔒 PostgreSQL SSH Tunnel Host-Key Trust (TOFU) & SSH Compression Removal

This batch hardens database tunnel security and removes a fragile SSH feature.

### Added

- 🔑 **PostgreSQL SSH Tunnel Host-Key Trust (TOFU)**: First connection to a PostgreSQL instance over an SSH tunnel now probes and displays the SSH server host-key fingerprint in an in-app trust dialog. Confirming persists the fingerprint; subsequent connections verify against it and are rejected on mismatch (`fail-closed`) instead of silently accepting key changes.
- 🔁 **Re-trust Action on Key Mismatch**: When a tunnel is refused because the server host-key fingerprint changed, the connection toast now offers a "Retrust SSH host key" action that re-probes and re-opens the trust dialog — no need to edit the host/port to clear the stored fingerprint.

### Changed

- 🗑️ **Removed SSH zlib Compression Option**: The advanced SSH "compression" switch and its storage/database fields were removed across the stack. SSH negotiation is hard-coded to `NONE` — jump-host zlib negotiation could crash the direct-tcpip tunnel (russh 0.62), and tunnel traffic is already encrypted, making compression redundant.
- 🪟 **In-App Host-Key Confirmation**: Host-key confirmation moved from `window.confirm` to an in-app dialog with a 30s auto-cancel timeout and proper cleanup on unmount (no hanging promises).
- 🧩 **Fingerprint Probe Algorithm Alignment**: The PostgreSQL SSH fingerprint probe now negotiates host-key algorithms with the same `PREFERRED_HOST_KEY_ALGOS` as the SSH/SFTP paths, preventing fingerprint mismatches on multi-host-key servers.

### Fixed

- 🐛 Integration test target no longer references the removed `SshConfig.compression` field (compile error fixed).
- 🧹 Removed unused `trusted` field from the fingerprint probe response.

### Notes

- Existing databases keep a historical, unread `compression` column in the connections table; it is intentionally retained (no destructive migration). No code reads or writes it.
- The `docker_pty_survives_parallel_sftp_upload` regression test (PTY session survives parallel SFTP uploads) is available locally behind `#[ignore]`; it requires a local Docker OpenSSH fixture (port 22222) and is not part of CI.

## [2.7.0] - 2026-08-08

### 🖥️ NexTerm 2.7 — Terminal-Integrated File Browser & Connections

This release integrates the file browser with the terminal by following the active terminal's working directory and adding directory downloads, makes advanced SSH and proxy options actually apply to live connections and persist across saves and reconnects, and adds password visibility toggles to the connection dialog. It also updates keyboard shortcuts with improved tab management, hardens directory downloads and legacy bash hooks, and wires the Edit menu to the active terminal.

### Added

- 🖥️ **File Browser Follows Terminal CWD**: The integrated file browser now follows the active terminal's working directory, and directories can be downloaded directly
- 👁️ **Password Visibility Toggles**: Added show/hide toggles to the password fields in the connection dialog so credentials can be reviewed before saving (#77)
- ⌨️ **Keyboard Shortcuts & Tab Management**: Updated keyboard shortcuts and improved tab management functionality

### Fixed

- 🔌 **Advanced SSH & Proxy Options on Live Connections**: Advanced SSH and proxy options are now applied to live connections instead of being dropped (#73)
- 💾 **Proxy Config Persistence**: Proxy configuration now persists across saves and reconnects (#72)
- 🖥️ **Edit Menu Targets Active Terminal**: The Edit menu commands are now wired to the active terminal
- 🔒 **Secure Directory Downloads & Legacy Bash Hooks**: Hardened directory downloads and legacy bash hooks, and polished the sync button/icon styling

### Contributors

Thanks to [@htazq](https://github.com/htazq), [@sunxiaobin89](https://github.com/sunxiaobin89), and [@GOODBOY008](https://github.com/GOODBOY008) for contributing to this release! 🙏

## [2.6.0] - 2026-07-30

### 🔗 NexTerm 2.6 — Connection Management, Clipboard & Update Flexibility

This release brings pointer-based drag-and-drop reordering to the connection sidebar (folders and connections, across parents), adds a "New Connection" entry to the folder context menu, integrates the Tauri clipboard manager plugin for more reliable cross-platform clipboard handling, and adds configurable update proxy support. It also fixes SSH file list corruption on non-GNU hosts, a number of connection-dialog and sidebar interaction bugs, and a stuck-text-selection issue in the terminal on WKWebView.

### Added

- 🖱️ **Pointer-Based Connection Reordering**: Implemented pointer-event drag-and-drop to reorder folders and connections in the sidebar, with drag ghosts, before/after/inside drop indicators, invalid-drop prevention (e.g. moving a folder into its own subtree), and success/error toasts — replacing the previous HTML5 drag-and-drop implementation
- ➕ **New Connection in Folder Context Menu**: Added a "New Connection" entry to the folder right-click menu so connections can be created directly inside a target folder (#59)
- 📋 **Tauri Clipboard Manager Integration**: Integrated the `@tauri-apps/plugin-clipboard-manager` plugin for clipboard operations, replacing `navigator.clipboard` usage for more reliable clipboard behavior on Windows and macOS
- 🔄 **Configurable Update Proxy**: Added support for a configurable update proxy so updates can be fetched through a user-defined proxy (#51)

### Changed

- 🧪 **CI Frontend Test Step**: Added a frontend Vitest step (`pnpm test`) to the test workflow matrix, excluding the integration-only `connection.test.ts` from the unit suite (#55)

### Fixed

- 🗂️ **SSH File List Corruption on Non-GNU Hosts**: Resolved file list corruption in the SSH file browser on non-GNU hosts caused by parsing incompatibilities (#68)
- 🛠️ **Edit Connection Tab Sync & Save Flow**: Improved tab synchronization, credential handling, and the save flow in the edit-connection dialog (#67)
- 🌳 **Sidebar Folder Click Selection**: Fixed folder clicks not selecting the node and right-click expanding unrelated nodes in the sidebar (#61)
- 🔢 **Connection Dialog Number Input Override**: Prevented number inputs in the connection dialog from overriding values with defaults when cleared (#62)
- ✋ **WKWebView Text Selection Stuck**: Fixed a stuck text-selection issue in the PTY terminal on WKWebView by tracking mouse-drag state and dispatching a synthetic mouseup when the native event is swallowed, and disabled right-click word selection by default

## [2.5.1] - 2026-07-16

### 🔧 NexTerm 2.5.1 — Input Hardening & UI Polish

This patch release disables browser autofill and spell-check on input fields for cleaner terminal-style input, simplifies date formatting in the integrated file browser, and refines spacing and UI consistency across the system monitor components.

### Added

- 🔒 **Disable Autofill & Spell-Check on Inputs**: Turned off browser autofill and spell-check for input fields to prevent unwanted suggestions and keep input behavior consistent with a terminal client

### Changed

- 📅 **Simplified File-Browser Date Formatting**: Simplified the date-formatting logic in the integrated file browser for improved readability and maintainability
- 🎨 **System Monitor UI Refinements**: Refined spacing and improved UI consistency across system monitor components for a more polished look

## [2.5.0] - 2026-07-01

### 🛠️ NexTerm 2.5 — Settings, Editor & File Browser Polish

This release adds a configuration export/import backup feature, user-configurable settings for the embedded code editor, a scrollable tab bar with navigation buttons in the settings modal, and improved loading overlays and styling for the file browser panels, plus a fix for theme-aware terminal background coloring.

### Added

- 💾 **Config Export/Import Backup**: Added an export/import feature in settings that lets users back up and restore their NexTerm configuration
- 📝 **Embedded Editor Settings**: Added user-configurable settings for the embedded code editor, so editor preferences can be customized from within the app
- 🧭 **Scrollable Settings Tab Bar**: Added a scrollable tab bar with navigation buttons in the settings modal for easier navigation when many options are present
- ⏳ **File Browser Loading Overlays**: Improved loading overlays for the file browser panels for clearer feedback during file operations

### Changed

- 🎨 **File Panel UI Styles**: Updated UI styles for file panels to refresh their look and feel
- 🧪 **Update-Checker Tests**: Removed Tauri runtime tests and checks from the update-checker test suite

### Fixed

- 🐛 **Terminal Background Color**: Resolved theme-aware background color handling for the terminal container so it correctly follows the active theme

## [2.4.0] - 2026-06-26

### 🌍 NexTerm 2.4 — Internationalization & Auto-Update

This release introduces full app internationalization via `react-i18next` (with English and Simplified Chinese, plus system-locale auto-detection), adds a manual update checker that reads `latest.json` from the release feed, refreshes the dark-mode scrollbar styling, and modernizes the CI runner versions.

> 🙏 **Special thanks to [@htazq](https://github.com/htazq)** for thoroughly testing the i18n feature and drafting the initial PR that kicked off this internationalization work!

### Added

- 🌍 **App Internationalization (i18n)**: Integrated `react-i18next` to support multiple languages throughout the UI, with `en` (English) as the source locale and `zh-CN` (Simplified Chinese) translations
- 🌐 **System Locale Language Preference**: Added an `AUTO` language option that detects and follows the OS locale on startup, so NexTerm launches in the user's system language by default
- 🔄 **Manual Update Check**: Added a manual update checker that reads `latest.json` published with each release, letting users check for newer versions from within the app

### Changed

- 🛠️ **CI Runner Upgrades**: Upgraded the GitHub Actions used in CI workflows to their latest versions for reliability and security
- 🔍 **i18n Key-Parity Check**: Added a lightweight CI workflow that verifies translation key parity between `en.json` and `zh-CN.json` to prevent missing translations
- 🎨 **Dark Mode Scrollbar Styling**: Improved the dark-mode scrollbar styling selectors for a more consistent native look

### Fixed

- 🐛 **AUTO Language Preference Handling**: Fixed initialization and handling of the `AUTO` language preference so the detected locale is applied reliably on first launch

## [2.3.0] - 2026-06-14

### 🖥️ NexTerm 2.3 — Tab Drag Reorder & Terminal Reliability

This release adds drag-and-drop tab reordering in the terminal bar, fixes a directory-tree ref synchronization bug, normalizes terminal scrollback across sessions, and bumps key dependencies.

### Added

- 🖱️ **Terminal Tab Drag-and-Drop Reordering**: Tabs in the terminal tab bar can now be rearranged by dragging with the pointer for a more flexible workspace layout

### Fixed

- 🗂️ **Directory Tree Ref Synchronization**: Fixed a bug where directory-tree refs could fall out of sync with component state on initial load, causing stale or missing expansion data
- 📜 **Terminal Scrollback Normalization**: Restored the default scrollback buffer to 10,000 lines and added normalization so all sessions start with a consistent scrollback limit (#34)

### Changed

- 📦 **Dependency Updates**: Bumped `openssh` and other dependencies for improved security and stability (#38)
- 📖 **README & Test Fixes**: Updated README content and resolved a unit-test issue

## [2.2.0] - 2026-06-10

### 📂 NexTerm 2.2 — OS-Native File Drag & Drop

This release adds OS-native drag-and-drop support for mixed files and folders, with reliable coordinate event fallback handling.

### Added

- 📂 **OS-Native File & Folder Drag-and-Drop**: Terminal now supports mixed file and folder drag-and-drop from the OS, with improved coordinate event fallback for cross-platform reliability

### Fixed

- 🖥️ **File Drop Coordinate Handling**: Resolved unreliable drag event coordinate extraction by implementing a multi-level `clientX`/`clientY` fallback chain across `dragOver`, `dragEnter`, and `drop` events

### Changed

- 🎨 **Right Sidebar Tab Styling**: Adjusted tabs padding and overflow styles for a cleaner sidebar appearance

## [2.1.1] - 2026-06-09

### 🖥️ NexTerm 2.1.1 — Terminal & File Browser Fixes

### Fixed

- 🖥️ **Duplicate Paste Prevention**: Terminal paste operations no longer insert duplicate content when using keyboard or middle-click paste
- 🖥️ **Terminal Background & Layout Styling**: Enhanced PTY terminal background rendering and layout for improved visual clarity
- 📁 **File Browser Layout Responsiveness**: Improved file list panel layout and resize behavior for a more consistent browsing experience

## [2.1.0] - 2026-06-04

### 🗂️ NexTerm 2.1 — Directory Tree & Terminal Stability

This release adds caching for the remote directory tree to preserve expand/collapse state and scroll position across tab switches, optimizes PTY terminal memory and flow control to prevent unbounded buffer growth, resolves keyboard shortcut conflicts, and fixes Windows SFTP upload compatibility.

### Added

- 🗂️ **Directory Tree Caching**: Remote directory tree expand/collapse state and scroll position are now cached and restored when switching between file browser tabs

### Fixed

- 🖥️ **PtyTerminal Performance & Flow Control**: Optimized terminal memory usage, implemented credit-based flow control, and added session output limits for more stable terminal behavior during heavy I/O
- ⌨️ **Keyboard Shortcut Handling**: Resolved conflicts between terminal and application-level shortcuts; editable shortcut handling is now preserved correctly across component re-renders
- 🪟 **Windows SFTP Upload**: File upload now works correctly for paths containing Windows-style basenames and folders (#24)


## [2.0.0] - 2026-05-30

### 🚀 NexTerm 2.0 — File Viewer & Performance

This major release introduces a dedicated popup window for viewing SSH files, improves OS-detection performance with concurrent-safe caching, and fixes terminal focus and scrollbar reliability.

### Added

- 🗂️ **SSH File Popup Viewer**: Remote files can now be opened in a dedicated popup window directly from the file browser, keeping the main panel uncluttered

### Changed

- ⚡ **OS Info Caching**: Remote OS detection now uses `OnceCell` for lock-free concurrent access, eliminating redundant SSH round-trips when multiple panels query system info simultaneously

### Fixed

- 🖥️ **Terminal Focus on Tab Switch**: Switching between terminal tabs now correctly restores keyboard focus to the active terminal (fix contributed via PR #13)
- 📜 **Terminal Scrollbar Visibility**: PTY terminal scrollbar is now always rendered and its visibility logic corrected so it appears reliably when content overflows


## [1.8.0] - 2026-05-21

### 🔄 NexTerm 1.8 — Smarter Recovery & Window Controls

This release improves terminal resilience with automatic PTY reconnect handling after dropped connections, and refines desktop window behavior with better drag-region double-click maximize support on non-macOS platforms.

### Added

- 🔁 **Automatic PTY Reconnect**: Interactive terminal sessions now automatically attempt reconnection after connection drops for a smoother recovery experience

### Changed

- 🪟 **Drag Region UX on Non-macOS**: Improved titlebar drag-region behavior to support double-click maximize/restore interactions more consistently on non-macOS platforms

### Fixed

- 🔌 **PTY Drop Recovery Flow**: Improved PTY connection-drop handling to reduce manual recovery steps when SSH sessions are interrupted


## [1.7.0] - 2026-05-16

### 🔖 NexTerm 1.7 — Stable Sessions

This release brings long-lived connection reliability: SSH keepalive prevents servers from silently dropping idle sessions, and the PTY terminal now detects dropped connections gracefully instead of silently replacing the shell. A new lazy-loading directory tree, improved file browser toolbar, and robust path quoting round out the update.

### Added

- 🌳 **Directory Tree**: New lazy-loading, expandable directory tree panel in the integrated file browser for fast folder navigation without changing the main view
- 🔌 **SSH Keepalive**: Client-side SSH keepalive now runs every 60 seconds (3 missed replies triggers clean disconnect), preventing SSH servers from silently timing out idle connections after hours of inactivity

### Changed

- 🖥️ **File Browser Toolbar**: Enhanced integrated file browser UI with an improved toolbar layout, clearer action grouping, and better visual hierarchy

### Fixed

- 🐛 **Path Quoting**: File listing and stat commands now correctly quote paths containing apostrophes, spaces, and other shell special characters — fixes errors browsing directories with unusual names
- 🔄 **PTY Session Loss Detection**: After a session is established, a dropped SSH connection now displays `[SSH session lost. Use right-click → Reconnect]` instead of silently spawning a fresh shell with lost state
- ⚡ **Reconnect Retry**: Implemented cancellation-aware exponential backoff for PTY reconnect attempts; permanent failures (connection not found) now fail fast instead of burning all retry attempts uselessly


## [1.6.0] - 2026-05-08

### 🍎 NexTerm 1.6 — Native macOS Experience

This release brings a native macOS menu bar, quick connect shortcuts, draggable window chrome, and improved SSH key compatibility across all platforms.

### Added

- 🍎 **Native macOS Menu Bar**: Full `NSMenu` integration with standard macOS application menus (File, Edit, View, Window, Help)
  - Provides native keyboard shortcuts and menu-driven access to all major app actions
- ⚡ **Quick Connect**: New quick-connect shortcut in the Connection Manager for one-click access to recently used hosts
- 🖱️ **Draggable Titlebar Region**: Menu bar area is now a native drag region so the window can be moved without a traditional title bar
- 🔲 **Window Maximize Button**: Added native window maximize/restore control to the menu bar

### Changed

- 🎨 **Tab Styling Refresh**: Improved tab bar visual consistency — active, hover, and inactive states now have clearer differentiation
- 📜 **Scrollbar Styling**: Updated scrollbar track and thumb colors for better visibility against dark backgrounds

### Fixed

- 🔐 **Cross-Platform SSH Key Paths**: `~/` tilde in key paths now expands correctly on all platforms (Linux, macOS, Windows)
- 🔑 **SSH Key CRLF Normalization**: Private keys with Windows-style `\r\n` line endings are now normalized before use, fixing auth failures when keys are edited on Windows


## [1.5.0] - 2026-04-30

### 🔁 NexTerm 1.5 — Reliable Reconnect

This release fixes reconnect flows that previously left the terminal permanently stuck after a network drop.

### Fixed

- 🔌 **SSH Reconnect Re-establishes Session**: Reconnect actions (tab bar button and right-click menu) now properly re-authenticate to the backend before restarting the PTY, instead of reusing the dead SSH connection
  - `handleReconnect` in `App.tsx` dispatches `RECONNECT_TAB` after a successful SSH reconnect to remount the terminal on the fresh connection
  - Tab bar Reconnect calls the full backend reconnect path (`onReconnectTab`) instead of a bare state dispatch
  - Right-click Reconnect in the PTY terminal delegates to `onReconnectTab` from context, with a WebSocket-only fallback when run outside a provider


## [1.4.0] - 2026-04-24

### 🖥️ NexTerm 1.4 — OS Detection & Distro-Aware System Monitoring

This release adds intelligent OS detection and cross-distro system monitoring, so CPU, memory, disk, and uptime metrics work correctly across different Linux distributions — not just the common case.

### Added

- 🔍 **OS Detection Module** (`os_detect`): Detects remote OS type and distribution info (distro, version, package manager) on connect
  - Caches `OsInfo` per connection in `ConnectionManager` to avoid repeated system calls
  - Supports accurate metric collection across different Linux distributions

- 🛡️ **Error Boundary Component**: New React `ErrorBoundary` wraps key UI sections to catch and display render errors gracefully instead of crashing the whole app

### Changed

- 🖥️ **Distro-Aware System Monitor**: `get_system_stats` now uses OS-specific commands for CPU, memory, disk, and uptime stats
  - Selects the correct command variant based on detected distro (e.g. handles differences between Debian, Alpine, Arch, etc.)
  - `system-monitor` component updated to pass OS context to backend commands

- ♻️ **WebSocket Server Refactored**: Improved flow control and connection lifecycle handling
- 🧹 **Code Cleanup**: Improved formatting and import organization across `commands.rs`, `ftp_client.rs`, `sftp_client.rs`, `ssh/mod.rs`, and `lib.rs`


## [1.3.1] - 2026-04-01

### Fixed

- 🔐 **RSA SSH Server Compatibility**: Resolved "No common key algorithm" connection failure for RSA-keyed SSH servers
  - Added support for `ssh-rsa` host key algorithm for compatibility with older servers
  - Fixes connection issues with legacy SSH servers that only support RSA host keys

### Changed

- 📖 **README Enhanced**: Added performance metrics and lightweight positioning documentation

### 🔄 NexTerm 1.3 — Multi-Connection Profiles & File Browser Polish

This release enables multiple simultaneous connections to the same server profile, adds a duplicate tab action, and significantly improves the SSH file browser with a unified transfer queue experience.

### Added

- 🔀 **Multi-Connection Support for Same Profile**: Open multiple tabs connecting to the same connection profile
  - Each tab gets an independent session with unique session ID
  - Automatic numeric suffixes for tab names (e.g., "my-server (2)", "my-server (3)")
  - Full lifecycle management — sessions clean up independently on tab close
  - Works across SSH, SFTP, and FTP protocols

- 📋 **Duplicate Tab Action**: Right-click context menu on tabs now includes "Duplicate Tab"
  - Quickly create a new connection to the same server
  - Supported for SSH terminals, SFTP, and FTP sessions

### Changed

- 📁 **SSH File Browser Refactored**: Major overhaul for better reliability and UX
  - Reducer-based state management for predictable behavior
  - Integrated Transfer Queue UI component for visual transfer progress
  - OS-native drag-and-drop upload support (replaces legacy byte-array logic)
  - Download workflows with native file picker dialogs for single and multi-file
  - Removed legacy SFTP panel — unified file browsing experience

### Fixed

- ⏱️ **Connection Restoration Timeouts**: Added timeout handling during session restoration to prevent indefinite hangs
- 📐 **Terminal Size Checks**: Improved terminal dimension validation to prevent layout issues

## [1.2.0] - 2026-03-16

### 🖥️ NexTerm 1.2 — Code Editor, Remote Desktop & Terminal Polish

This release adds a built-in code editor with syntax highlighting, remote desktop protocol support, and several quality-of-life improvements across the terminal and file browser.

### Added

- ✏️ **CodeMirror-Based Code Editor**: Full-featured in-app code editor for remote files
  - Syntax highlighting for 15+ languages (JavaScript, TypeScript, Python, Rust, Go, Java, C/C++, SQL, HTML, CSS, JSON, YAML, XML, Markdown, PHP)
  - One Dark theme integration matching the app's aesthetic
  - Line numbers, code folding, bracket matching, and auto-completion
  - Search and replace functionality

- 🖥️ **RDP & VNC Desktop Protocol Clients**: Remote desktop access alongside SSH terminals
  - Connect to Windows machines via RDP
  - Connect to VNC servers for graphical remote access
  - Integrated as tab types within the existing session management

- 📋 **Editor Tab Type in Connection Storage**: Persistent editor tab state
  - Editor tabs are now tracked in `ActiveConnectionState`
  - Editor sessions restore correctly on app restart

### Fixed

- ⌨️ **macOS Keyboard Shortcuts**: `Cmd` key now correctly maps as `Ctrl` equivalent
  - Layout shortcuts (`Cmd+B`, `Cmd+J`, `Cmd+M`, `Cmd+Z`) work reliably on macOS
  - Consistent cross-platform shortcut behavior

- 🎨 **Terminal Text Selection Visibility**: Theme-aware selection colors
  - Selected text in terminals now uses proper contrast colors
  - Works correctly in both light and dark themes

- 📂 **File Browser Context Menu**: Selection clears when context menu closes
  - Prevents stale selection state after dismissing the menu

## [1.1.0] - 2026-03-01

### 📂 NexTerm 1.1 — SFTP/FTP File Management & Developer Tooling

This release introduces a full-featured dual-pane file manager with SFTP and FTP support, FileZilla-style directory synchronization, a redesigned Log Monitor, and a robust ESLint v10 setup with type-aware checking.

### Added

- 📁 **Dual-Pane SFTP/FTP File Browser**: FileZilla-inspired file manager with transfer queue
  - Side-by-side local and remote pane navigation
  - Drag-and-drop file transfers between panes
  - Transfer queue with pause, resume, and cancel support
  - Progress tracking per file and overall queue

- 🔄 **FileZilla-Style Directory Synchronization**: Sync local and remote directories
  - One-way and two-way sync modes
  - Conflict detection and resolution UI
  - Dry-run preview before applying changes

- 📤 **Recursive Directory Upload/Download**: Context menu actions for bulk transfers
  - Recursively upload entire local directories to remote
  - Recursively download entire remote directories locally

- 📋 **"Open in Log Monitor" from File Browser**: Direct log file viewing from context menu
  - Right-click any remote file to open it in the Log Monitor
  - Seamless integration between file browser and log viewer

- 🗂️ **FileZilla-Style Navigation in Integrated File Browser**: Bookmark bar and breadcrumb navigation
  - Path input bar with history
  - Quick bookmarks for frequently accessed directories

- 🔍 **Redesigned Log Monitor**: Business-grade log viewer rebuilt from scratch
  - Real-time log tailing with configurable refresh intervals
  - Syntax highlighting for common log formats
  - Filtering, search, and line-range selection

- 🛡️ **ESLint v10 with Type-Aware Checking**: Full linting setup for the codebase
  - `typescript-eslint` with type-aware rules (`no-unsafe-*`)
  - `react-hooks` v7 plugin with new `set-state-in-effect`, `refs`, `purity` rules
  - `react-refresh` plugin for HMR safety
  - All existing lint errors resolved

### Fixed

- ⌨️ **Space Key & IME Input Swallowed in Terminal**: Prevented input loss during fast typing and CJK composition
  - `attachCustomKeyEventHandler` now bails out during IME composition (`isComposing`/`keyCode 229`)
  - React capture-phase `onKeyDown` no longer calls `preventDefault()` on textarea events
  - Removed `console.log` and per-keystroke allocations from the `onData` hot path

- 🔒 **FTP Credentials Anonymized in Tests**: Sensitive test credentials replaced with placeholders to prevent accidental exposure

### Changed

- 📝 **README & Welcome Screen Rewritten**: Refreshed documentation and onboarding UI for v1.0.0 feature set

## [1.0.0] - 2026-02-28

### 🎉 NexTerm 1.0 — Stable Release

This is the first stable major release of NexTerm, marking it as production-ready after months of iterative development. This release introduces a fully redesigned VS Code-style terminal group system, improved connection resilience, and a polished UI experience.

### Added

- 🖥️ **VS Code-Style Terminal Groups**: Complete rewrite of the terminal layout system
  - Split terminals horizontally and vertically with keyboard shortcuts
  - Drag-and-drop tabs between terminal groups
  - Recursive grid-based renderer for nested group layouts
  - Tab bar per group with context menu actions
  - Drop zone overlays for intuitive tab organization
  - Terminal group state serialization and restoration across sessions

- 🔄 **Reconnect from Context Menu**: Right-click any terminal tab to reconnect a disconnected session
  - Quick reconnection without opening the connection dialog
  - Available directly from the terminal tab context menu

- 📖 **AI Agent Guide (AGENTS.md)**: Comprehensive project documentation for AI coding agents
  - Full architecture overview, build instructions, and coding conventions
  - State and data flow documentation for terminal groups and connections
  - Key file index, dependency summary, and common pitfalls

### Fixed

- 🎯 **Active Group Switching**: Clicking terminal output area now correctly switches the active group focus
- 🖼️ **Welcome Screen & Sidebar Polish**: Right sidebar hides when no terminal is open; improved welcome screen layout
- 💬 **Tooltip Rendering**: Fixed tooltip content being partially obscured by arrow overlay
- 📏 **Terminal Height Measurement**: Added padding wrapper to correct FitAddon height calculation in PTY terminals
- 🔌 **WebSocket Cleanup**: Ensure WebSocket closes on disconnection to prevent stale PTY state
- ⚡ **Connection Management**: Enhanced terminal connection lifecycle and UI responsiveness

### Changed

- 🏗️ **Terminal Architecture**: Migrated from flat tab list to reducer-based terminal group state management
  - `TerminalGroupProvider` context with `useTerminalGroups()` hook
  - Actions: `ADD_TAB`, `REMOVE_TAB`, `SPLIT_GROUP`, `ACTIVATE_TAB`, `MOVE_TAB`
  - Persistent layout serialization to localStorage

- 📦 **Project Documentation**: Added AGENTS.md for AI agent onboarding and copilot-instructions.md for GitHub Copilot

## [0.7.1] - 2026-02-10

### Fixed

- 🖥️ **Terminal Padding**: Added padding to PTY terminal container for better layout and visual spacing
- 📋 **Duplicate Paste Fix**: Fixed duplicate paste being triggered when using the copy command

## [0.7.0] - 2026-02-08

### Added

- 🔄 **Auto-Update Support**: Integrated Tauri updater plugin for automatic application updates
  - Background update checking on application startup
  - Manual update check via Help menu
  - User notification system for available updates

- 🖱️ **Terminal Context Menu**: Right-click context menu for terminal operations
  - Copy, paste, select all, and clear terminal operations
  - Search functionality accessible from context menu
  - Keyboard shortcuts integration

- 📋 **Terminal Search Bar**: Enhanced terminal search capabilities
  - Find text within terminal output
  - Case-sensitive and regex search options
  - Navigation between search results

- 📂 **File Browser Sorting**: Added comprehensive sorting functionality to integrated file browser
  - Sort by name, size, or modification date
  - Ascending and descending order options
  - Visual indicators for current sort state

- 🌐 **Dynamic WebSocket Port**: Implemented dynamic port assignment for WebSocket server
  - Automatic port selection to avoid conflicts
  - Port retrieval command for frontend connection
  - Improved reliability for PTY terminal connections

### Changed

- 🔧 **Session → Connection Renaming**: Comprehensive refactoring for semantic correctness
  - Renamed all "session" references to "connection" throughout the codebase
  - Updated storage layer: `session-storage.ts` → `connection-storage.ts`
  - Automatic migration from old session storage format
  - Standardized connection ID and path parameter naming

- 💾 **GPU Memory Display**: Enhanced GPU monitoring to show memory usage in MiB for better readability

- 📖 **Documentation Updates**: Updated README with new screenshots and feature descriptions

## [0.6.4] - 2026-01-29

### Added

- 🎮 **GPU Monitoring**: Full GPU detection and monitoring functionality
  - Multi-GPU support with dropdown selection for systems with multiple GPUs
  - Real-time GPU usage, memory, and temperature monitoring
  - Combined usage history chart showing all GPUs together
  - Automatic GPU detection via system commands

- 🌐 **Network Interface Selection**: Enhanced network bandwidth monitoring
  - Dropdown selection to choose specific network interfaces
  - Monitor individual interface traffic (Wi-Fi, Ethernet, etc.)
  - Better visibility into network activity per interface

- 🔄 **Connection Reconnect**: Added reconnect functionality to connection tabs
  - Quick reconnect button for disconnected sessions
  - Reconnect count tracking to monitor connection stability
  - Improved connection recovery workflow

- 📊 **Connection Status Management**: Enhanced terminal connection status tracking
  - Real-time connection status indicators
  - Better visibility into connection health
  - Improved disconnect/reconnect handling

### Fixed

- 🎨 **CSS Syntax**: Corrected anchor tag styling syntax issue_

## [0.6.3] - 2026-01-23

### Added

- ✏️ **Connection Editing**: Added ability to edit existing connections from connection manager
  - Load existing connection details into connection dialog
  - Update connection configurations with proper form state
  - Automatically activate existing tabs when editing connections
  - Loading states and error handling for edit operations

- ⏱️ **Connection Timeout**: Added 3-second timeout for SSH client connections
  - Better error handling for unresponsive connections
  - Prevents indefinite connection attempts
  - Improved user feedback during connection failures

### Fixed

- 🖼️ **Terminal Background Image**: Fixed background images not appearing on already-opened terminals
  - Properly switches from WebGL to canvas renderer when background image is added
  - Avoids unnecessary terminal re-creation for other appearance changes
  - Fixed issue where images only showed at edges while main area remained dark
  - Smart renderer selection based on background image state

### Changed

- 🔄 **UI Terminology Update**: Renamed "Session Manager" to "Connection Manager" throughout the application
  - Updated all UI labels, tooltips, and menu items for consistency
  - Renamed SessionManager component to ConnectionManager
  - Updated keyboard shortcuts and settings to reflect new naming
  - More accurate terminology for managing SSH connections

- 🗂️ **Tab Management**: Enhanced tab handling for connection dialog
  - Updates and activates existing tabs when confirming connection
  - Hides "Save as session" option when editing existing sessions
  - Better session update workflow

- 📚 **Documentation**: Updated README to reflect connection manager naming

## [0.6.2] - 2026-01-17

### Added

- 💾 **Panel Auto-Save**: Resizable panels now automatically save their sizes to localStorage
  - Remembers panel dimensions across sessions
  - Per-panel-group persistence for customized layouts
  - Improved user experience with layout state preservation

### Fixed

- 📁 **Session Folder Selection**: Fixed folder dropdown in connection dialog
  - Now shows only valid folders from the session manager hierarchy
  - Filters out orphaned or deleted folders
  - Consistent folder display with session manager tree structure
  - Improved folder selection UI with cleaner presentation

- 🎨 **Chart Theming**: Updated chart text color to use `currentColor`
  - Better support for light/dark theme transitions
  - More consistent visual appearance across themes
  - Fixed chart text readability issues

- 🔌 **Connection Dialog State**: Reset connection state on dialog open/close
  - Improved cancel button behavior during connection attempts
  - Better state cleanup when dismissing dialog
  - Enhanced connection workflow reliability

### Changed

- 🖱️ **Resizable Panel Cursors**: Improved cursor styles for better visual feedback
  - Enhanced resize handle visibility and interaction
  - More intuitive drag experience
  - Added custom cursor styles for horizontal/vertical resize

- 🔧 **Session Storage**: Added `getValidFolders()` method to filter orphaned folders
  - Better synchronization between connection dialog and session manager
  - More reliable folder hierarchy management

## [0.6.1] - 2026-01-10

### Added

- 🍺 **Homebrew Distribution**: Official Homebrew cask support for macOS
  - Easy installation via `brew install --cask nexterm`
  - Automated release workflow with checksum generation
  - Auto-updating Homebrew tap on new releases
  - Support for both Intel and Apple Silicon Macs

### Changed

- 📦 **Release Pipeline Improvements**:
  - Added SHA256 checksum generation for all release assets
  - Automated Homebrew tap updates via GitHub Actions
  - Enhanced release workflow with proper dependency management
  - Improved release asset naming and organization

- 📚 **Documentation Updates**:
  - Updated README with Homebrew installation instructions
  - Cleaned up obsolete documentation files
  - Streamlined project documentation structure

### Infrastructure

- ✨ Created `homebrew-tap` repository for distribution
- 🔄 Automated cask formula updates on releases
- 🔐 Secure token-based repository dispatch for tap updates
- 📊 Enhanced CI/CD pipeline for release management

## [0.6.0] - 2026-01-03

### Added

- ⚡ **Quick Connect Dropdown**: Fast access to recently connected servers
  - Dropdown menu for quick reconnection to recent servers
  - Streamlined workflow for frequently used connections
  - Reduces time needed to establish common connections

- 🎨 **Terminal Background Image Support**: Customizable terminal appearance
  - Add background images to terminal windows
  - Configurable background settings in terminal preferences
  - Enhance visual customization of your workspace

- 🌓 **Enhanced Theme Management**: Comprehensive theme system with persistence
  - localStorage-based settings persistence across sessions
  - Theme preferences automatically saved and restored
  - Improved theme consistency throughout the application

- ✨ **UI Component Enhancements**:
  - Updated slider components with new color scheme
  - Updated switch components with refined styling
  - Enhanced scrollbar styles for better appearance
  - Improved visual experience in both light and dark modes
  - Dynamic terminal appearance updates based on settings changes

### Changed

- 📦 Updated @tauri-apps/api to version 2.9.1
- 📦 Updated @tauri-apps/cli to version 2.9.6
- 🎨 Improved visual consistency across all UI components
- ⚙️ Better integration between settings and terminal appearance

### Fixed

- 🐛 Theme persistence issues resolved
- 🎨 Scrollbar rendering improvements
- ✨ Settings modal synchronization with terminal display

## [0.5.0] - 2025-12-23

### Added

- 🔄 **Duplicate SSH Connection Tabs**: Right-click any active tab to duplicate it and create a new connection to the same server
  - Duplicated tabs appear right after the original tab
  - Full session state persistence - duplicates are restored on app restart
  - Maintains correct tab order and names across app restarts
  - Accessible via context menu (right-click on tab) or Session menu
  - Smart credential handling - reuses saved credentials from the original session
  - Support for chaining - can duplicate already-duplicated tabs

- 📡 **Enhanced Network Latency Monitoring**: Real-time SSH connection latency measurement
  - Live latency statistics displayed in system monitor
  - Helps identify network performance issues
  - Integrated with existing system monitoring

- 🎨 **Layout Panel Resize State Management**: Panel sizes are now remembered
  - Resizable panels maintain their size across sessions
  - Smooth resizing experience with state persistence
  - Applies to left sidebar, right sidebar, and bottom panel

- ⚡ **Improved Session Restoration**: Enhanced overlay with detailed progress
  - Real-time progress indicator showing which session is being restored
  - Current target display with host and username information
  - Visual progress bar with percentage completion
  - Better error handling and reporting for failed restorations

- 🚫 **Cancel Connection Functionality**: Ability to cancel in-progress connections
  - Stop connection attempts that are taking too long
  - Clean cancellation without leaving orphaned connections
  - Improved connection state management

### Changed

- 📊 Improved session restoration UI with more informative feedback
- 🔧 Enhanced connection handling with better error recovery
- ✨ UI polish for connection dialogs and session management

### Fixed

- 🐛 Connection stability improvements
- 🔄 Better handling of duplicate session credentials
- 📁 Session state persistence edge cases

## [0.4.0] - 2025-11-27

### Added

- 🔐 SSH key authentication support for new and saved connections.
- 🎨 Theme customization controls for light, dark, and high-contrast layouts.
- 🔍 Command history search so every session can surface previous inputs quickly.
- 🌍 Multi-language (i18n) support for the core UI.
- 🧩 Plugin system foundations that let users extend sessions and workflows.
- 🧪 Batch command execution across sessions with grouped controls.
- 🌐 Port forwarding utilities for exposing remote services locally.

### Changed

- ✨ UI polish across session tabs, the system monitor, and the toolbar to feel smoother.
- 🧰 Dependency updates that keep the frontend, Tauri backend, and terminal utilities current.

### Fixed

- 🛠 Stability and connection resiliency improvements for session management.

## [0.3.0] - 2025-11-17

### Added
- 🚀 New features and improvements
- 📦 Package updates and dependency optimizations
- 🎯 Enhanced user experience

### Changed
- 🔄 Codebase refinements and optimizations
- 📚 Documentation updates

### Fixed
- 🐛 Bug fixes and stability improvements

## [0.2.0] - 2025-11-17

### Added
- 🎨 Enhanced UI components and styling improvements
- 📋 Improved session management interface
- ✨ Better error handling and user feedback
- 🔧 Additional terminal customization options

### Changed
- ⚡ Performance optimizations for terminal rendering
- 🔄 Improved session state persistence
- 📊 Enhanced system monitoring display

### Fixed
- 🐛 Various bug fixes and stability improvements
- 🔧 Terminal display issues on some platforms
- 📁 File browser navigation edge cases

## [0.1.0] - 2025-10-30

### Added
- 🎉 Initial release of NexTerm
- 🖥️ Multi-session SSH connection management with tabbed interface
- 📁 Integrated file browser for remote file management
- 📊 Real-time system monitoring (CPU, Memory, Disk, Processes)
- ⚙️ Process management with kill functionality
- 🔐 Password-based SSH authentication
- 💾 Connection profile management (save, load, edit, delete)
- 🎨 Modern UI built with React 19, TypeScript, and Tailwind CSS
- 🦀 High-performance backend using Rust and Tauri 2
- 📱 Responsive resizable panel layout
- 🔔 Toast notifications for user feedback
- ⌨️ Terminal emulator with xterm.js
- 🔄 Session state persistence
- 📝 Comprehensive documentation and guides
- 🤖 AI-assisted development workflow
- 🎨 Figma-generated frontend components

### Technical Details
- Frontend: React 19, TypeScript, Vite, Tailwind CSS
- Backend: Rust, Tauri 2.0
- UI Components: Radix UI primitives
- Terminal: xterm.js
- Icons: Lucide React
- State Management: React hooks
- File Browser: Custom implementation with SFTP support
- System Monitor: Real-time stats via SSH commands

### Known Issues
- Process list refresh interval is fixed at 5 seconds
- No support for SSH key authentication yet
- Limited error handling for network interruptions
- Terminal history not persisted between sessions

### Development Notes
- This release demonstrates the vibing coding methodology
- Frontend UI generated from Figma designs using Figma Make
- Entire development powered by GitHub Copilot
- Experimental project exploring AI-assisted development capabilities

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to contribute to this project.

## License

This project is licensed under the MIT License - see [LICENSE](LICENSE) for details.
