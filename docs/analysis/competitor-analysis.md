# NexTerm 竞品分析报告：鼠标右键菜单 / 错误信息 / 快捷键

> 分析范围：NexTerm（SSH/SFTP/数据库工具箱，React19+TS + Tauri2+Rust，VS Code 风格多标签会话工作台）
> 本次分析【不含】AI / BI / ER 功能，仅聚焦三大方向：**鼠标右键菜单、错误信息、快捷键**。
> 调研对象：Termius、Tabby、electerm、WindTerm、XShell、SecureCRT、MobaXterm、Windows Terminal / VS Code 终端。
> 信息来源：官方文档、官方博客、GitHub 仓库与 Issue、DeepWiki 源码分析、社区教程。标注「未确认」表示未能从可靠来源确认。

---

## 一、竞品逐个分析

---

### 1. Termius（现代跨平台商业 SSH 客户端）

**产品定位**：跨平台（Win/macOS/Linux/iOS/Android）商业 SSH 客户端，以云同步 Vault、命令面板、终端协作著称，被视为"现代终端"的交互标杆。

#### 方向一：鼠标右键菜单

| 场景 | 实现 |
|---|---|
| 终端内右键 | **默认不弹上下文菜单**。右键行为由设置驱动：`Select text to copy`（选中即复制）+ `Right click to paste`（右键即粘贴）可独立开关。新版已支持"有选区则复制、无选区则粘贴"。社区用户反馈早期版本不能直接右键复制，需用 Ctrl+Shift+C/V，是新用户的主要吐槽点 |
| 连接树/列表右键 | 长按/右键 host 可编辑、删除、复制连接（移动端长按；桌面端通过列表项操作入口） |
| 标签页右键 | 水平标签栏（新版）提供关闭、重命名、跳转等（细节未确认） |

**交互细节**：无终端内原生右键菜单，而是把"右键=粘贴"作为核心心智；复制粘贴设置集中在 Terminal 设置页，默认值偏保守（右键不粘贴），需用户手动开启。

#### 方向二：错误信息

- **主机密钥确认**：首次连接弹「Host key confirmation」对话框，提供 `Add and continue`（信任并继续）/ `Cancel`。密钥变更后再次连接会提示密钥不匹配，引导用户在 SSH Keys 中删除旧记录后重连（而非直接放行）。
- **认证失败**：密码/密钥错误时提示认证失败（`Permission denied (publickey,password)`），不支持内联重试改密，需回到 Vault 编辑 host 修改凭据再连接（移动端引导路径：长按 host → Edit → 改密码 → Connect）。
- **连接超时/拒绝**：显示 `Connection timed out` / `Connection failed` 类错误；官方帮助中心给出系统化排查路径（DNS → ping → 端口 → 防火墙 → sshd 状态）。
- **诊断能力**：`Settings → Diagnostics` 提供调试日志与错误码，方便上报支持。
- **呈现形式**：连接失败以对话框/终端页内错误状态呈现（非轻量 toast）；可恢复性上，密钥类错误引导"删除后重连"，凭据类错误引导"编辑后重连"。

#### 方向三：快捷键

- 终端内：`Ctrl+Shift+C` 复制、`Ctrl+Shift+V` 粘贴、`Ctrl+Shift+A` 全选、`Ctrl+Shift+K` 清屏、`Ctrl+Shift+F` 查找、`Ctrl+L` 本地终端、`Alt+←/→` 切换标签、`Ctrl+Shift+W` 关闭标签、`Ctrl+Alt+[` 滚动模式。
- 全局/面板：`Cmd+K / Ctrl+K` **命令面板**（fuzzy 搜索 host 并连接/跳转）、`Cmd+J / Ctrl+J` 标签跳转、`Cmd+T / Ctrl+T` 新建连接、`Ctrl+Shift+N` 新建主机连接、`Ctrl+Shift+G` 新建分组、`Cmd+P` 端口映射、`Ctrl+2` SFTP。
- **快捷键在 Settings → Shortcuts 中有完整可查列表，可自定义绑定**。

#### 方向四：产品特性洞察

- **Command Palette（Cmd+K）** 是 Termius X 的核心亮点：所有操作可从命令面板 fuzzy 搜索触发，把"记快捷键"降维成"会搜索"。
- 主机密钥确认对话框带安全上下文文案（防止中间人），并给出明确的信任操作，是 SSH 类工具错误安全的范本。
- "选中即复制 + 右键粘贴"被社区广泛使用，说明终端用户对**无菜单式快捷操作**有强烈偏好。

---

### 2. Tabby（开源跨平台终端，Eugeny/tabby）

**产品定位**：可无限定制的开源终端（Electron + Angular + xterm.js），SSH/串口/本地 shell 一体，插件生态丰富。对 NexTerm 的**技术形态（xterm.js）与交互设计参考价值最高**。

#### 方向一：鼠标右键菜单

| 场景 | 实现 |
|---|---|
| 终端内右键 | 右键行为**四档可配**（`terminal.rightClick`）：`off` 禁用 / `menu` 显示上下文菜单 / `paste` 直接粘贴 / `clipboard` 有选区复制、无选区粘贴。Windows 默认 `clipboard`，其他平台默认 `menu` |
| 选中文本菜单 | 上下文菜单含：**Copy（复制）、Copy as HTML（复制为富文本）、Paste（粘贴）、Select All（全选）**；支持长按右键强制触发菜单；另有工具栏/搜索面板 |
| 空白区域右键 | 同上下文菜单；还支持**中键粘贴**（`pasteOnMiddleClick`，Linux 默认开启）与选中即复制（`copyOnSelect`，Windows 默认开启） |
| 标签/窗格右键 | 右键 Split 创建水平/垂直分割窗格（新窗格继承当前连接配置）；右键 **Switch Profile** 切换连接类型；工具栏提供搜索、保存输出等 |
| 会话树右键 | 新建会话、分组、编辑、复制、删除（连接管理器内） |

**交互细节**：右键菜单为原生 Angular 组件菜单，支持键盘导航（未确认）；终端内提供**悬停显示的工具栏**（默认隐藏，hover 顶部浮现，可固定）；搜索面板带滑入动画。

#### 方向二：错误信息

- **连接失败**：SSH 连接错误在**终端内直接输出**（如 `Connection failed: Authentication failed`、`Remote rejected opening a shell channel: Error: Disconnect`、`ECONNREFUSED`），同时标签/通知区可能有活动提示。
- **认证失败**：`Permission denied (publickey)` 等错误文本进入终端 buffer，可被选中复制。
- **可诊断性**：详细错误写日志文件（配置目录 logs 文件夹）；设置 `RUST_LOG=debug` 可获得 SSH 层详细日志（russh）；官方 FAQ 提供系统排查路径。
- **呈现层级**：无模态错误弹窗（避免打断），以终端内输出为主；多行粘贴有 `warnOnMultilinePaste` 警告（默认开）。

#### 方向三：快捷键

- 按功能域分类注册（`hotkeys.ts`）：Clipboard（复制/粘贴/全选）、Navigation（Home/End/词导航）、Editing（删词/删行）、View（放大/缩小/重置字号）、Scrolling（到顶/到底/翻页）、Search（打开搜索面板）、Broadcast（广播输入到多终端）。
- 全局：可配置全局热键聚焦/隐藏窗口；可选 Quake 模式（贴边终端）。
- **全部快捷键可自定义，支持 multi-chord（复合键序列）**；设置页可视化编辑。

#### 方向四：产品特性洞察

- **右键行为四档可配**是行业最佳实践：既照顾 PuTTY 老用户（粘贴），也支持现代用户（菜单），还提供"有选区复制/无选区粘贴"的智能折中。
- **Split 继承当前连接 + Switch Profile**：分屏不是空窗，而是自动复用当前会话配置，右键即可换连接。
- **长按右键强制出菜单**：解决了"右键即粘贴"与"需要菜单"的矛盾，细节极佳。
- 错误进终端 buffer 可选中复制，不打断工作流；多行粘贴警告防误执行。

---

### 3. electerm（开源多协议客户端）

**产品定位**：开源跨平台（Electron）终端/SSH/SFTP/FTP/串口/RDP/VNC 一体化客户端，带文件管理器，被大量用作 Xshell 的免费替代。对 NexTerm 的**文件传输面板交互**参考价值高。

#### 方向一：鼠标右键菜单

| 场景 | 实现 |
|---|---|
| 终端内右键 | 未确认是否有终端内上下文菜单；以快捷键操作为主 |
| SFTP 文件区右键 | **右键菜单丰富**：上传/下载、删除、重命名、新建文件/目录、**属性（可视化修改 chmod 权限 755/644）**；Shift/Ctrl 多选后支持批量下载/删除/重命名 |
| 远程文件 | **双击直接用本地默认编辑器编辑远程文件**，保存后自动同步回远端 |
| 标签页 | 多选标签 → 右键「批量输入」向多个会话广播命令（batch-op） |

**交互细节**：SFTP 与终端可同屏（v1.37.0+，Split Panel，拖拽可调比例）；拖拽上传/下载；文件拖动到终端可生成 SCP 命令；传输中断自动续传。

#### 方向二：错误信息

- 连接失败：SSH 连接错误通过终端内输出 + 界面提示呈现（未确认具体弹窗/ toast 形式）。
- 传输失败：SFTP 传输中断时**自动续传**（以恢复为导向而非报错）。
- 社区 FAQ 提供结构化排查清单（网络 → sshd → 防火墙 → 凭据），说明错误信息本身引导性一般，靠知识库补足。

#### 方向三：快捷键

- `Ctrl+N` 新建 SSH、`Ctrl+/` 分屏、`Ctrl+W` 关闭连接、`Ctrl+T` 新建标签、`Ctrl+Tab` 切换标签、`Ctrl+D` 垂直分屏、`Ctrl+Shift+D` 水平分屏、`Ctrl+F` 搜索、`Ctrl+,` 设置。
- **全局快捷键**：`Ctrl+2` 显示/隐藏窗口（Guake 风格下拉终端）。
- **所有快捷键可在设置中自定义**（配置文件 src/client/components/shortcuts/）。

#### 方向四：产品特性洞察

- **SFTP 右键即"文件操作完整闭环"**：上传/下载/重命名/删/权限/双击编辑一应俱全，右键菜单是文件区的主交互入口。
- **批量输入**：多选标签广播命令，运维场景刚需。
- **双击远程文件直接编辑并回写**：比"下载→改→上传"少三个动作。
- 传输自动续传体现"可恢复操作优先于错误提示"的设计哲学。

---

### 4. WindTerm（开源高性能终端）

**产品定位**：开源（部分源码）高性能 SSH/Telnet/Serial/tmux 终端，主打低内存、快，功能密度极高。会话树、Explorer Pane、Shell Pane 多面板布局与 NexTerm 相似。

#### 方向一：鼠标右键菜单

| 场景 | 实现 |
|---|---|
| 终端内右键 | **行为三档可配**：`无操作`（默认，防误粘贴的安全策略）/ `上下文菜单` / `粘贴剪贴板内容`；支持**长按右键粘贴**；新版支持"有选区则复制、无选区则粘贴"（Copy text if selected, otherwise paste） |
| 发送到远程 | 可勾选「右键单击事件」将右键事件**发送到远程程序**（如 tmux），此时不再弹菜单——解决了终端工具与远程鼠标协议的冲突 |
| 标签页右键 | **Duplicate tab（复制标签）、Split Vertically/Horizontally（分屏）、Split to left/right/top/bottom、Move to tab group、关闭标签**、关闭右侧标签、标签着色 |
| 会话树右键 | New Session、**Move To...**（移动节点）、复制分组及子节点、删除；节点状态联动（会话删除后显示删除线） |
| 终端右键增强 | **Select Command（Ctrl+Shift+/）** 快速选中命令；对选中文本**在线搜索**（Google/Bing/GitHub/Stackoverflow/Wikipedia/DuckDuckGo）；高亮当前选区所有实例 |

**交互细节**：右键菜单项**支持图标与快捷键标注**（如 Select Command 标注 Ctrl+Shift+/）；会话树支持拖拽移动节点；Explorer Pane 空白区域右键可弹出菜单；隐藏鼠标光标（打字时）等细节丰富。

#### 方向二：错误信息

- **可恢复导向**：出现 `Remote channel is closed` 错误时**直接提示"按 Enter 重新连接"**，把重连动作降为一次按键。
- 会话状态在会话树上以**颜色/样式变化**呈现（如删除后删除线、状态变化变色）。
- 传输准备阶段显示**文件/文件夹扫描进度**。
- 提供锁屏主密码保护已保存凭据（安全相关错误与恢复策略）。

#### 方向三：快捷键

- `Ctrl+Shift+C` 复制、`Ctrl+Shift+/` 选中命令、`Ctrl++` / `Ctrl+-` 字体缩放、`Alt+T` 系列（时间戳/折叠标记/行号/符号）、Shift+Enter 切换本地/远程 vim 模式。
- **Command Palette**（类 VS Code）统一搜索命令。
- Sync Input（同步输入）、Free Type Mode、Focus Mode 等模式切换。
- 自定义鼠标动作：标签页可配置双击/动作（如 Duplicate SSH channel）。

#### 方向四：产品特性洞察

- **「右键事件可转发到远程」**是终端类工具独有且关键的细节——解决 tmux/vim 鼠标协议冲突。
- **长按右键粘贴 + 短按出菜单**（或反之）的双态设计。
- 会话树节点状态**视觉化**（删除线/变色）而非弹窗通知。
- 错误直接给「一键恢复动作」（Enter 重连）而非让用户自己想办法。
- 选中文本即搜（多引擎）把右键菜单变成"行动面板"。

---

### 5. XShell（传统商业 SSH 客户端）

**产品定位**：Windows 平台最流行的商业 SSH 客户端，会话管理成熟，与 Xftp 深度联动。代表传统企业工具的设计语言。

#### 方向一：鼠标右键菜单

| 场景 | 实现 |
|---|---|
| 会话管理器 | 右键会话：**属性（编辑连接）**、新建会话、连接/断开、复制、移动、导入导出等 |
| 标签页右键 | **关闭、重命名、复制会话** |
| 终端内右键 | 以粘贴为主；新版 Xshell 8 曾因 Win11 22H2 更新出现"右键菜单空白"兼容性 Bug，说明其右键菜单依赖系统 Shell API |

**交互细节**：菜单偏传统 Win32 风格；图标与快捷键标注未确认。核心交互仍是"会话管理器 + 双击连接"。

#### 方向二：错误信息

- 连接失败：终端/连接对话框内输出原始错误，如 `Could not connect to '192.168.x.x' (port 22): Connection failed`、`Connection refused`。
- 加密协商失败：`Unable to negotiate with ... no matching key exchange method found`（引导用户手动改 Kex 算法，进阶但门槛高）。
- 官方支持中心提供"检查用户名密码 → ping → telnet 端口 → 检查 sshd"的排查清单。
- 错误呈现偏"原文直出"，**无错误码、无重试按钮、不区分可恢复/不可恢复**（未确认）。

#### 方向三：快捷键

- `Alt+1` 会话管理器、`Ctrl+Alt+1` 会话热键（可为常用会话绑定自定义热键）、「发送键输入到所有会话」广播。
- 终端内：`Ctrl+Shift+C/V` 复制粘贴（未完全确认默认绑定）。
- 快捷键自定义能力较弱，无命令面板。

#### 方向四：产品特性洞察

- **会话热键（Ctrl+Alt+N 直连指定会话）**：老牌工具对"快速连接"的答案。
- **发送键输入到所有会话**：广播能力是运维刚需。
- 与 Xftp 的**无缝联动**（从会话一键拉起文件传输，免重复认证）值得 NexTerm 学习（SFTP 与 SSH 会话打通）。

---

### 6. SecureCRT（VanDyke 商业终端）

**产品定位**：老牌商业终端，强调安全、脚本化（VBScript）、协议广泛。与 SecureFX 联动。

#### 方向一：鼠标右键菜单

| 场景 | 实现 |
|---|---|
| 终端内右键 | **默认「选中自动复制，右键粘贴」**（PuTTY 心智）；`Global Options → Terminal` 可取消 "Use right mouse button as menu" 切换为菜单模式 |
| 会话列表 | 右键会话可编辑/克隆/组织（未确认菜单全貌） |

**交互细节**：右键行为全局可配；无内建命令面板（依赖脚本与快捷键）。

#### 方向二：错误信息

- **认证失败弹对话框**：弹出 `Authentication Failed` 提示（模态）。
- 协议版本不匹配：明确提示 `Received version was 2.0`（告知协商到的版本号，可定位问题）。
- 提供**会话日志 + 详细日志级别 + `/debug` 启动参数**，可捕获数据包级诊断；官方支持要求上报版本号/OS/错误信息/复现步骤。
- 错误码：未确认。

#### 方向三：快捷键

- 新建会话 `Ctrl+Alt+N`、快速连接 `Alt+C`、复制 `Ctrl+Insert`、粘贴 `Shift+Insert`（保留传统 Ctrl+Insert/Shift+Insert 映射）。
- 支持为命令/脚本绑定快捷键；脚本自动化能力强（VBScript）。

#### 方向四：产品特性洞察

- **`Received version was 2.0` 这类"带上下文的错误"**：告知服务端实际返回的协议版本，比泛化错误好定位得多。
- **日志体系分级**：日常会话日志 + 调试日志 + /debug 数据包捕获，三级递进排查。
- 复制/粘贴支持传统 `Ctrl+Insert` / `Shift+Insert`，兼容老用户肌肉记忆。

---

### 7. MobaXterm（多协议终端 + X server）

**产品定位**：Windows 全能终端，集成 SSH/X11/RDP/VNC/SFTP + 文件管理器 + 宏，免费版限制 12 会话/2 通道。

#### 方向一：鼠标右键菜单

| 场景 | 实现 |
|---|---|
| 终端内右键 | **默认「右键即粘贴」**（Paste using right-click）；设置 `Settings → Configuration → Terminal` 可取消勾选改回上下文菜单；**按住 Ctrl+右键 也可弹出菜单**（保留右键粘贴的同时获得菜单） |
| 会话列表右键 | 编辑会话（Edit Session）、复制、属性（修改 Charset 编码等） |
| 选中文本 | 选中即复制（左键选择自动复制） |

**交互细节**：`Ctrl+右键` 弹菜单是"MobaXterm 式"的解决方案，兼顾粘贴效率与菜单可达性。

#### 方向二：错误信息

- 连接失败：**终端内输出** `Network error: Connection timed out` / `Access Denied`（密码错误，提示密码/大小写/NumLock/输入法全角问题）。
- 断开：会话区显示 `连接已终止`；SSH keepalive 未开启是断连常见原因（设置页可勾选）。
- 密码管理：`Save sessions passwords` 三态（Always/Never/Ask），Ask 态在连接时询问保存。
- 呈现层级：终端内文本为主，无 toast/错误码（未确认）。

#### 方向三：快捷键

- 选中即复制、右键粘贴 / `Shift+Insert` 粘贴、`F11` 全屏、`Ctrl+滚轮` 字号缩放、拖拽标签分离成独立窗口。
- 宏与快捷键绑定能力（Advanced/未确认细节）。

#### 方向四：产品特性洞察

- **`Ctrl+右键` 同时满足"粘贴党"与"菜单党"**——成本极低、收益直接。
- 密码保存三态策略（Always/Never/Ask）平衡便利与安全，Ask 态值得借鉴。
- 断连引导明确指向 keepalive 配置，错误与设置项直接挂钩。

---

### 8. Windows Terminal / VS Code 终端（现代交互基准）

**产品定位**：两者是"现代终端交互"的事实标准——Windows Terminal 侧重终端本体，VS Code 侧重与编辑器协同。NexTerm 整体布局即 VS Code 风格，应以此类为标准。

#### 方向一：鼠标右键菜单

**Windows Terminal**：
- 右键行为默认 `paste`（直接粘贴）；`experimental.rightClickContextMenu` 打开后显示上下文菜单；可用 `showContextMenu` action 随时强制弹出。
- 菜单项：**Copy、Paste、Find（查找）、Duplicate tab（复制标签）、Split pane（分屏）、Web search（搜索选中文本，默认 Bing，可配 URL）、Settings、Close tab**。

**VS Code 终端**：
- 右键行为**分平台**（`terminal.integrated.rightClickBehavior`）：Linux 显示菜单；macOS 选中单词+显示菜单；Windows 有选区复制并丢弃选择、否则粘贴。
- 终端标签右键：**Split、Move Terminal to New Window（移到新窗口）、Kill、Rename、Unsplit**。
- 资源管理器右键 `Open in Integrated Terminal`（在文件夹处开终端）。

#### 方向二：错误信息

- VS Code：shell integration 在命令左侧显示**装饰与滚动条标记**；任务终端在标签图标显示 **✓/✗**（无错/出错），hover 可读状态与动作——**错误信号融入 UI 而非弹窗**。
- Windows Terminal：**多行粘贴警告**（`multiLinePasteWarning`，默认开）——粘贴含换行的多行文本前确认，防误执行。
- 均为终端内文本错误 + UI 徽标，无模态错误弹窗。

#### 方向三：快捷键

**Windows Terminal**：
- `Ctrl+Shift+` 新建、`Ctrl+Shift+5` 分屏、`Alt+Shift+D/V/H` 分屏、`Alt+方向键` 移动焦点、`Alt+Shift+方向键` 调整窗格、`Ctrl+Shift+F` 搜索、`Ctrl+滚轮` 缩放、`Ctrl+Shift+滚轮` 调透明度、`Ctrl+,` 设置。
- **Actions 设置页列出所有动作及其快捷键，可逐个重绑**；`sendInput` 可自定义命令绑定；settings.json 全配置化。
- 焦点模式（隐藏标题栏/标签）、Quake 模式（贴顶下拉）。

**VS Code**：
- `Ctrl+`` 切换终端、`Ctrl+Shift+`` 新建、`Ctrl+Shift+5` 分屏、`Ctrl+PageDown/Up` 组间切换、`Alt+←/→` 组内切换、`Ctrl+F` 查找。
- `terminal.integrated.commandsToSkipShell` 声明哪些快捷键交给应用而非 shell；**全部快捷键可在 Keyboard Shortcuts 面板搜索/重绑**。

#### 方向四：产品特性洞察

- **右键菜单 = 高频操作行动面板**：复制/粘贴/查找/分屏/复制标签/网页搜索一次到位，且项都带图标与快捷键提示。
- **Web search** 把"选中文本"直接变成搜索入口。
- 错误用**非侵入式 UI 状态**（徽标/装饰/滚动条）承载，不打断终端流。
- 快捷键体系**完全可配置 + 可视化查看**，是最低学习成本方案。
- `copyOnSelect`、多行粘贴警告、Ctrl+点击开链接等均为"小而实用"细节。

---

## 二、三方向对比矩阵

### 2.1 鼠标右键菜单对比

| 维度 | Termius | Tabby | electerm | WindTerm | XShell | SecureCRT | MobaXterm | WinTerm/VS Code |
|---|---|---|---|---|---|---|---|---|
| 终端内默认右键 | 粘贴（可配） | 菜单/clipboard（平台差异） | 未确认 | 无操作（默认，安全） | 粘贴为主 | 粘贴 | 粘贴 | 粘贴（WT）/分平台（VSC） |
| 右键行为可配置 | ✓ | **四档（off/menu/paste/clipboard）** | 未确认 | **三档+长按粘贴+转发远程** | 未确认 | ✓ | ✓ | ✓（设置项） |
| 有选区/无选区智能 | ✓（新） | ✓（clipboard 档） | — | ✓ | — | — | — | ✓（VSC Win） |
| 标签页右键 | 有 | 有 | 未确认 | **最全（复制/分屏/移动/着色/关闭）** | 关闭/重命名/复制 | 未确认 | 未确认 | **全（split/kill/rename/move）** |
| 连接树右键 | 有 | 有 | 有 | **全（Move To/复制分组/删除）** | 有 | 有 | 有 | — |
| SFTP/文件区右键 | 未确认 | 有 | **最全（含权限/双击编辑）** | 有 | 未确认 | 未确认 | 有 | — |
| 菜单内快捷键标注 | 未确认 | 未确认 | 未确认 | ✓ | 未确认 | 未确认 | 未确认 | ✓（VSC） |
| 在线搜索选中文本 | — | 插件 | — | **✓ 多引擎** | — | — | — | ✓（WT） |

### 2.2 错误信息对比

| 维度 | Termius | Tabby | electerm | WindTerm | XShell | SecureCRT | MobaXterm | WinTerm/VS Code |
|---|---|---|---|---|---|---|---|---|
| 连接失败呈现 | 对话框/页内 | 终端内输出 | 终端内+提示 | 终端内 | 终端内原文 | 对话框 | 终端内 | 终端内 |
| 认证失败后续动作 | 引导改凭据重连 | 终端内可复制文本 | 未确认 | 未确认 | 人工排查 | 模态弹窗 | 提示检查凭据 | — |
| 主机密钥确认 | **✓ Add and continue** | 未确认 | 未确认 | 未确认 | 未确认 | 未确认 | 未确认 | — |
| 一键重连恢复 | — | — | 自动续传(SFTP) | **✓ Enter 重连** | — | — | — | — |
| 错误可复制 | 部分 | ✓ | 未确认 | ✓ | ✓ | 未确认 | ✓ | ✓ |
| 错误码 | ✓（Diagnostics） | 日志/RUST_LOG | 未确认 | 未确认 | 无 | 无 | 无 | 无 |
| 日志体系 | ✓ | ✓ | 未确认 | ✓ | ✓ | **✓ 三级（会话/详细/debug）** | ✓ | ✓ |
| 非侵入式状态信号 | — | — | — | ✓ 会话树样式 | — | — | — | **✓ 徽标/装饰** |
| 多行粘贴警告 | — | ✓ | — | 未确认 | — | — | — | **✓ WT** |

### 2.3 快捷键对比

| 维度 | Termius | Tabby | electerm | WindTerm | XShell | SecureCRT | MobaXterm | WinTerm/VS Code |
|---|---|---|---|---|---|---|---|---|
| 复制/粘贴 | Ctrl+Shift+C/V | Ctrl+Shift+C/V | 未确认 | Ctrl+Shift+C | Ctrl+Shift+C/V | Ctrl+Insert/Shift+Insert | 右键/Shift+Insert | Cmd/Ctrl+C/V（VSC） |
| 搜索 | Ctrl+Shift+F | ✓ | Ctrl+F | ✓ | 未确认 | 未确认 | 未确认 | Ctrl+Shift+F（WT） |
| 新标签/关闭 | Ctrl+Shift+W 关 | ✓ | Ctrl+T/Ctrl+W | ✓ | ✓ | Ctrl+Alt+N | ✓ | Ctrl+Shift+` |
| 切换标签 | Alt+←/→ | ✓ | Ctrl+Tab | ✓ | 未确认 | 未确认 | 拖拽分离 | Ctrl+PageUp/Dn |
| 分屏 | ✓ | ✓ | Ctrl+/、Ctrl+D | ✓ | — | — | ✓ | Ctrl+Shift+5 |
| 字体缩放 | ✓ | ✓ | 未确认 | Ctrl+± | 未确认 | 未确认 | Ctrl+滚轮 | Ctrl+滚轮 |
| 全局热键 | ✓ | ✓ | **✓ Ctrl+2** | — | — | — | — | ✓ |
| 命令面板 | **✓ Cmd+K** | ✓ | — | **✓** | — | — | — | ✓（VSC） |
| 广播/批量输入 | — | **✓** | **✓ 批量输入** | **✓ Sync Input** | **✓ 发送到所有会话** | — | ✓ 宏 | — |
| 快捷键自定义 | ✓ | **✓ multi-chord** | ✓ | ✓ | 弱 | ✓ 脚本 | 弱 | **✓ 可视化** |

---

## 三、可借鉴洞察清单（按优先级）

### A. 鼠标右键菜单

1. **右键行为做成可配置，且提供"智能档"**（Tabby/WindTerm/VS Code 共识）：`菜单 / 粘贴 / 有选区复制·无选区粘贴` 三态 + 默认值按平台给（macOS 菜单、Windows 智能档）。这能同时照顾两类用户，且避免"右键无反应"的困惑。
2. **长按右键=菜单、短按=粘贴 或 Ctrl+右键=菜单**（WindTerm/MobaXterm）：在"右键即粘贴"的心智下仍能抵达完整菜单，是终端场景特有且极实用的一招。
3. **右键菜单做成"行动面板"**（Windows Terminal/VSCode/WindTerm）：复制、粘贴、查找、分屏、复制标签、**搜索选中文本**、设置，图标 + 快捷键标注齐全，让菜单成为高频操作入口而非逃生通道。
4. **标签页右键 = 会话管理中枢**（WindTerm/VSCode）：复制标签、水平/垂直分屏、移动标签组、着色、关闭右侧、重命名、Kill/断开，一次右键完成所有会话编排。
5. **SFTP 文件区右键闭环**（electerm/WindTerm）：上传/下载/重命名/删除/新建/属性(权限)/双击编辑回写，多选批量操作——文件区右键是独立于终端的重要交互面。
6. **终端内右键事件可转发到远程**（WindTerm）：与 tmux/vim 鼠标协议兼容，专业用户的隐藏刚需。

### B. 错误信息

1. **区分"可恢复/不可恢复"，可恢复的给一键动作**（WindTerm `Enter 重连`、electerm 自动续传）：错误提示的第一要务是让用户以最少操作回到工作状态。
2. **主机密钥确认对话框带安全语境与明确操作**（Termius `Add and continue`）：SSH 特有的信任决策要讲清后果，而不是一个干巴巴的 yes/no。
3. **错误信号融入 UI 状态而非弹窗**（VSCode 标签 ✗/✓、WindTerm 会话树删除线/变色）：非侵入式，不打断终端流；细节错误（如 `Received version was 2.0`）给出可定位的上下文。
4. **多行粘贴警告**（Windows Terminal/Tabby，默认开）：防止粘贴的多行命令立即执行，是终端安全的低成本高收益项。
5. **认证失败给出明确后续路径**（Termius 引导改凭据重连；MobaXterm 提示密码/大小写/NumLock/全角）：错误后接"下一步做什么"。
6. **分级日志 + 可复制错误文本**（SecureCRT 三级日志、Tabby RUST_LOG、Termius Diagnostics）：错误可选中复制 + 有诊断入口，是支持体系的地基。

### C. 快捷键

1. **命令面板（Cmd+K）作为一切操作入口**（Termius/WindTerm/VSCode）：fuzzy 搜索连接、标签、命令，把记忆负担降到最低——对会话多的工具价值极高。
2. **全局热键 + Quake 式下拉**（electerm `Ctrl+2`、Tabby、WT Quake）：一键呼出/隐藏终端，桌面工具专属优势。
3. **广播/同步输入**（XShell 发送到所有会话、Tabby broadcast、electerm 批量输入、WindTerm Sync Input）：多服务器运维刚需，几乎全员标配，NexTerm 必须考虑。
4. **快捷键可视化自定义**（VS Code Keyboard Shortcuts 面板、WT Actions 页）：搜索 + 逐个重绑 + 冲突检测，是"可配置"的正确形态。
5. **`commandsToSkipShell` 机制**（VSCode）：明确哪些快捷键归应用、哪些放行给 shell，是终端快捷键冲突问题的标准解法。
6. **会话热键直连**（XShell Ctrl+Alt+N）：为高频会话绑定一键连接，老派但有效。

---

## 附：NexTerm 落点建议（简）

结合 NexTerm 现状（xterm.js 终端、VS Code 布局、双栏文件管理器、已有分屏/拖拽标签/会话恢复），本次三大方向的优先落地项：

| 方向 | 建议（按优先级） |
|---|---|
| 右键 | ① 终端右键行为可配置（菜单/粘贴/智能档）；② 标签页右键：复制标签/分屏/断开重连/关闭其他/重命名；③ SFTP 双栏右键：上传下载/新建/重命名/删除/属性；④ 连接树右键：连接/编辑/复制/删除/分组/Move To |
| 错误 | ① 连接失败分类型呈现（超时/拒绝/认证/密钥），可恢复错误提供「重试/重连」一键动作；② 主机密钥确认对话框（Add and continue 范式）；③ 错误文本可选中复制 + 状态徽标（标签/树节点）；④ 多行粘贴警告；⑤ 分级日志入口 |
| 快捷键 | ① Cmd+K 命令面板（连接/标签/操作）；② 快捷键可视化自定义面板；③ 广播输入到多会话；④ 全局热键（显示/隐藏、新建连接）；⑤ commandsToSkipShell 式冲突声明 |

---

*报告完成时间：2026-08-27。信息来源以官方文档/仓库/社区资料为准，标注「未确认」处建议产品验收阶段实地验证。*
