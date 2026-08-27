# NexTerm 弹窗设计规范（Dialog Design System）

> 作者：UI/UX · 2026-08-27
> 范围：`src/components/**/*.tsx` 中全部 `DialogContent` / `AlertDialogContent` 实例（53 个业务弹窗，排除 `src/components/ui/` 与 `__tests__`）
> 背景：弹窗定位曾出现 BUG——`!inset-0 !m-auto` 覆盖 shadcn 默认定位导致 ①translate 未抵消跑偏 ②高度被拉伸占满全屏（实测 height=1000px 贴顶）。已修复为标准居中：`top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[520px] max-w-[90vw] max-h-[85vh] overflow-y-auto`（实测 height=184 内容自适应、精确居中）。本规范将这一结论固化为全项目标准。

---

## 1. 定位：视口居中（唯一标准）

shadcn 基础组件 `DialogContent` / `AlertDialogContent`（`src/components/ui/dialog.tsx:62`、`alert-dialog.tsx:57`）默认已内置：

```
fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)]
translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6
shadow-lg sm:max-w-lg
```

因此：

| 写法 | 判定 |
|---|---|
| **不写任何定位 class**（仅调 `max-w-*`/`p-0` 等） | ✅ 合规，依赖默认居中 |
| **显式标准写法** `top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2` | ✅ 合规，与默认等价，推荐用于自定义宽度弹窗（意图更可读） |
| `!inset-0 !m-auto` / `!top-0 !left-0 !translate-x-0 !translate-y-0` 系列 | ❌ **禁止**。`inset-0`(top/right/bottom/left:0)+`margin:auto` 与 translate 冲突 → 高度被拉伸占满、定位跑偏，且与全项目 30+ 弹窗不一致 |
| `top-[6vh] translate-y-0` / `top-[8vh] translate-y-0` | ⚠️ 特殊「顶部锚定」模式（见 §6），仅限明确设计意图的场景 |

### 通用兜底
宽度 > 512px 的弹窗必须加 `max-w-[90vw]`；任何内容可能超高的弹窗必须给 `max-h-[85vh] overflow-y-auto`（或自绘内部滚动）。

---

## 2. 宽度分级

| 类型 | 推荐宽度 | 项目实例 |
|---|---|---|
| 确认/警告（AlertDialog，无输入） | 默认 `sm:max-w-lg`(448px)，不写宽度 | 删除文件/服务/应用/隧道/笔记、放弃修改、断开连接、杀进程 |
| 简单输入 | `sm:max-w-sm`(384px) | 新建/重命名文件夹、改锁密码、导出配置密码、API 保存请求 |
| 表单编辑 | `sm:max-w-lg`(512px) + `max-h-[85vh] overflow-y-auto` | 服务/应用/隧道/编排/vault 记录表单 |
| 中复杂内容 | `w-[520px] max-w-[90vw] max-h-[85vh] overflow-y-auto` | SSH 指纹确认（TOFU）、SQL 保存到记事本 |
| 复杂内容（自绘布局） | `w-[720px] max-w-[90vw]` | 数据库连接 shell（PG/MySQL/SQLite） |
| 大型编辑器 | `w-[900px] h-[680px] max-w-[90vw] max-h-[90vh]` | 连接编辑弹窗、设置主弹窗 |
| 超宽内容 | `max-w-6xl max-h-[90vh]` | SFTP 文件传输 |

规则：
- 超过 512px 一律 `max-w-[90vw]`。
- 同一语义的弹窗全项目共用同一宽度，不各自为政。

---

## 3. 最大高度与溢出

| 内容形态 | 写法 |
|---|---|
| 短内容（确认/单输入） | 不设 max-h，内容自适应 |
| 简单内容但可能超高 | 外层 `max-h-[85vh] overflow-y-auto`（滚动条在弹窗边框上） |
| 自绘布局（头+内容+尾） | 外框 `h-[680px] max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden`，**内部**滚动区 `min-h-0 flex-1 overflow-y-auto` |
| 命令面板类 | `max-h-[80vh] overflow-y-auto` |

要点：外层 `overflow-y-auto` 只用于「简单内容」；「自绘头尾布局」必须把滚动放在内部 `min-h-0 flex-1` 区域，否则 footer 会被顶出可视区。

---

## 4. 小窗口（<600px）响应式

- shadcn 默认 `max-w-[calc(100%-2rem)]` 已保证不横向溢出；项目统一再压一层 `max-w-[90vw]`。
- `DialogFooter` 默认 `sm:flex-row`，小屏自动降为 `flex-col-reverse`，主操作按钮置顶，符合移动端拇指区习惯（Tauri 桌面窗口拖窄时同样生效）。
- 顶部锚定弹窗不参与缩放，宽度用 `sm:max-w-[…]` 固定。

---

## 5. Dialog vs AlertDialog

| 场景 | 组件 | 要求 |
|---|---|---|
| 输入 / 编辑 / 浏览 / 多操作 | `Dialog` | 必须含 `DialogTitle` + `DialogDescription` |
| 单一破坏性确认（删除/覆盖/放弃），无输入 | `AlertDialog` | 危险按钮 `className="bg-destructive text-destructive-foreground hover:bg-destructive/90"` |
| 破坏性 + 备选（如「保存并断开」/「放弃并断开」） | `AlertDialog` 可放多个 Action，备选非破坏项保持默认样式 | 语义上贴近确认，可接受 |

审计发现：
- `tool-mysql.tsx:552` 用 `Dialog` 做删除确认（无输入、单一动作）→ 应改 `AlertDialog`。
- `tool-postgres.tsx:2912`（save-to-notes）缺 `DialogDescription` → 补说明文案（同时解决无障碍与引导问题）。

---

## 6. 特殊「顶部锚定」模式（允许但不推广）

| 位置 | 用途 | 写法 |
|---|---|---|
| `App.tsx:1788` | 浮动日志监视器（从侧栏 detach） | `top-[6vh] translate-y-0 sm:max-w-[80vw] h-[84vh] …` |
| `tool-jar-decompiler.tsx` 6 处 | JD-GUI 风格下拉浮层（Ctrl+T/H/L/Shift+S/P、About） | `top-[8vh] translate-y-0 sm:max-w-[320~580px] p-0 gap-0 overflow-hidden` |

规则：顶部锚定仅限「类似 IDE 命令面板 / 监视器」的产品决策场景，需保持组内一致（jar 系列 6 个弹窗已一致）；新弹窗默认仍用标准居中，不得随意新增第 3 种定位模式。

---

## 7. 全量弹窗审计清单

统计：**53 个业务弹窗实例**（28 个文件；另 `ui/command.tsx` 内部 1 个，业务未使用）。分类：✅ 合规 46 · ⚠️ 特殊顶部模式 7 · ❌ 不合规 3。

### ❌ 不合规（`!inset-0 !m-auto` BUG 写法，需修复）

> **修复状态核对（2026-08-27）**：曾有 3 处 `!inset-0 !m-auto`（connection-dialog.tsx:1540、tool-postgres.tsx:2786/2912）已在工作区改为标准居中（未提交，HEAD 仍为旧写法），实机验证 height=184/top=408/left=590 精确居中，待 QA 回归。以下 3 处为**真正未修复**的违规项（git diff 确认无改动）：

| 文件:行号 | 用途 | 当前 className | 建议 |
|---|---|---|---|
| `src/components/sync-dialog.tsx:428` | 目录同步弹窗 | `!top-0 !left-0 !translate-x-0 !translate-y-0 !inset-0 !m-auto !flex !flex-col sm:!max-w-3xl !max-h-[85vh] overflow-hidden`（条件拼接 `!h-[85vh]`/`!h-fit`） | 标准居中：`w-[768px] max-w-[90vw] max-h-[85vh] overflow-y-auto flex flex-col` |
| `src/components/directory-transfer-dialog.tsx:411` | 目录传输进度弹窗 | `!inset-0 !m-auto !top-0 !left-0 !translate-x-0 !translate-y-0 !flex !flex-col sm:!max-w-md !h-fit !max-h-[60vh] overflow-hidden` | 标准居中：`w-[448px] max-w-[90vw] max-h-[85vh] overflow-y-auto flex flex-col` |
| `src/components/toolbox/database-connection-dialog-shell.tsx:49` | PG/MySQL/SQLite 连接 shell（被 3 个工具复用） | `!inset-0 !m-auto flex max-h-[min(560px,calc(100vh-32px))] !w-[720px] !max-w-[calc(100vw-32px)] !translate-x-0 !translate-y-0 flex-col gap-0 overflow-hidden rounded-md p-0` | 保留自绘结构，仅定位改标准：`w-[720px] max-w-[90vw] max-h-[85vh] flex flex-col gap-0 overflow-hidden rounded-md p-0` + `top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2` |

> 注：三个文件均可安全保留原有「自绘头尾/内部滚动」布局，只需把定位收敛为标准居中写法，删除所有 `!` 覆盖类。

### ⚠️ 特殊顶部锚定模式（有设计意图，保留）

| 文件:行号 | 用途 | className |
|---|---|---|
| `src/App.tsx:1788` | 浮动日志监视器 | `top-[6vh] translate-y-0 sm:max-w-[80vw] h-[84vh] p-0 gap-0 flex flex-col overflow-hidden` |
| `src/components/toolbox/tool-jar-decompiler.tsx:2428` | 打开类型 (Ctrl+T) | `top-[8vh] translate-y-0 sm:max-w-[540px] p-0 gap-0 overflow-hidden` |
| `…tool-jar-decompiler.tsx:2560` | 类型层级 (Ctrl+H) | `top-[8vh] translate-y-0 sm:max-w-[500px] p-0 gap-0 overflow-hidden` |
| `…tool-jar-decompiler.tsx:2670` | 跳转行 (Ctrl+L) | `top-[8vh] translate-y-0 sm:max-w-[320px] p-0 gap-0 overflow-hidden` |
| `…tool-jar-decompiler.tsx:2712` | 常量池搜索 (Ctrl+Shift+S) | `top-[8vh] translate-y-0 sm:max-w-[580px] p-0 gap-0 overflow-hidden` |
| `…tool-jar-decompiler.tsx:2821` | 偏好设置 (Ctrl+Shift+P) | `top-[8vh] translate-y-0 sm:max-w-[360px] p-0 gap-0 overflow-hidden` |
| `…tool-jar-decompiler.tsx:2894` | 关于 (F1) | `top-[8vh] translate-y-0 sm:max-w-[360px] p-0 gap-0 overflow-hidden` |

### ✅ 合规 A：显式标准居中写法（17 处）

| 文件:行号 | 用途 | className（节选） |
|---|---|---|
| `connection-dialog.tsx:800` | 连接编辑大弹窗 | `top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[900px] h-[680px] max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0` |
| `connection-dialog.tsx:1540` | SSH 指纹确认 | `… w-[520px] max-w-[90vw] max-h-[85vh] overflow-y-auto` |
| `settings-modal.tsx:365` | 设置主弹窗 | `… w-[900px] h-[680px] max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0` |
| `settings-modal.tsx:1340 / 1398` | 改锁密码 / 导出配置密码 | `… sm:max-w-sm` |
| `tool-postgres.tsx:2786` | PG SSH 指纹确认 | `… w-[520px] max-w-[90vw] max-h-[85vh] overflow-y-auto` |
| `tool-postgres.tsx:2912` | 保存到记事本 | `… w-[420px] max-w-[90vw] max-h-[85vh] overflow-y-auto` |
| `servers-view.tsx:1288 / 1317` | 新建 / 重命名文件夹 | `… sm:max-w-sm` |
| `tool-api-debug.tsx:1762` | API 保存请求 | `… sm:max-w-sm` |
| `tool-api-debug.tsx:1803` | API 文档 | `… sm:max-w-2xl max-h-[85vh] overflow-y-auto` |
| `tool-api-debug.tsx:1932` | 环境管理 | `… sm:max-w-lg max-h-[80vh] overflow-y-auto` |
| `tool-vault.tsx:475` | 记录表单 | `… max-h-[85vh] overflow-y-auto sm:max-w-lg` |
| `tool-service-orchestrations.tsx:592` | 编排表单 | `… max-h-[85vh] overflow-y-auto sm:max-w-lg` |
| `tool-services.tsx:597` | 服务表单 | `… max-h-[85vh] overflow-y-auto sm:max-w-lg` |
| `tool-tunnels.tsx:590` | 隧道表单 | `… max-h-[85vh] overflow-y-auto sm:max-w-lg` |
| `tool-apps.tsx:391` | 应用表单 | `… max-h-[85vh] overflow-y-auto sm:max-w-lg` |

### ✅ 合规 B：默认定位（无 className / 仅调宽度，shadcn 自带居中，25 处）

| 文件:行号 | 用途 |
|---|---|
| `tool-vault.tsx:555` · `tool-service-orchestrations.tsx:702` · `tool-services.tsx:703` · `tool-tunnels.tsx:784` · `tool-apps.tsx:556` · `tool-documents.tsx:414` · `tool-notes.tsx:410` · `tool-command-history.tsx:174` | 各类删除/清空确认 |
| `integrated-file-browser.tsx:2016` · `system-monitor.tsx:1473` · `table-designer-tab.tsx:759` | 删除文件 / 杀进程 / 表设计确认 |
| `connection-manager.tsx:982 / 1017 / 1035` | 新建/删除/重命名文件夹 |
| `servers-view.tsx:1346 / 1367` | 删除文件夹/服务器确认 |
| `tool-api-debug.tsx:1782` | 删除请求确认 |
| `tool-postgres.tsx:2812 / 2833 / 2863 / 2884` | 删除记录 / 删除对象 / 放弃修改 / 断开确认 |
| `tool-sqlite.tsx:151` | 删除 SQLite 连接 |
| `tool-mysql.tsx:552` | 删除 MySQL 连接（⚠️ 建议改 AlertDialog） |
| `postgres-connection-manager.tsx:390` | PG 连接管理（`max-w-2xl`） |
| `filter-sort-dialog.tsx:148` | 过滤/排序（`max-w-lg`） |
| `sftp-panel.tsx:354` | SFTP 传输（`max-w-6xl max-h-[90vh] overflow-hidden`） |
| `tool-postgres.tsx:3011` | 布局数值输入（`max-w-xs`） |
| `ui/command.tsx:47` | CommandDialog（ui 内部，业务未引用） |

---

## 8. save-to-notes 对话框 UX 评审（tool-postgres.tsx:2911-2917）

**现状**：SQL 工具栏「保存到记事本」→ 弹窗 = 标题 Input（autoFocus，预填 tab 标题）+ 取消/保存。保存逻辑：全局有选中笔记（`getSelectedNoteId()`，模块级内存变量）→ **追加** SQL 到该笔记，输入值仅作为 `-- 标题` 注释行插入；无选中 → 新建笔记，输入值成为笔记标题。

**问题**：
1. **目标不透明**——弹窗完全没告诉用户 SQL 会「追加到当前选中的笔记」还是「新建笔记」。用户可能在笔记列表选了一篇后点保存，完全不知情。
2. **「标题」语义分裂**——同一输入框：追加模式下只是章节注释名（不改笔记标题）；新建模式下才是笔记标题。同一交互两种含义。
3. **缺 `DialogDescription`**——Radix 无障碍要求 + 失去解释机会。
4. **空标题静默失败**——保存按钮未按空值禁用，点了无反应（`confirmAppendSqlToNotes` 中 `if (!title…) return`）。
5. **成功反馈弱**——toast 仅「已保存到记事本」，不显示落点。

**弹窗层建议**（承接产品重设计流程）：
- 弹窗内显示保存落点：`将追加到笔记「{当前选中笔记名}」` 或 `将新建一篇笔记`，并说明「SQL 将以 `-- {标题}` 注释插入」。
- 追加模式下标题语义改为「章节名（可选）」；新建模式下才必填「笔记标题」。若产品流程已含「选择目标笔记」，此弹窗应展示并承接选择结果。
- 空标题禁用保存按钮，Enter 可提交；补 `DialogDescription`。
- 保存成功 toast 带上目标笔记名。

---

## 9. 指纹确认框（TOFU）UX 评审

**两处实现**：
- `tool-postgres.tsx:2786`：结构化 `<dl>`（host / port / fingerprint），fingerprint 用 `break-all font-mono text-xs`。
- `connection-dialog.tsx:1540`：整段 `hostKeyPrompt` 字符串 + `whitespace-pre-line break-words font-mono text-xs`，无结构化。

**评审结论**：
1. **一致性差**——同一 TOFU 信任场景两套展示（结构化 vs 原始文本），用户跨入口（SSH 直连 vs PG 隧道）看到不同样式，影响信任核对体验。应统一为 `tool-postgres` 的 `<dl>` 网格结构。
2. **可核对性**——指纹应 `font-mono` 且字号 ≥13px（`text-xs` 过小），`break-all` 防止换行截断，并建议 `select-all` 便于复制与服务器输出比对；单独高亮算法前缀（SHA256:/ED25519）。
3. **算法展示（安全同事建议）**——当前两处均只显示 `SHA256:base64` 指纹串，未显示主机密钥算法（ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp256）。建议在指纹行旁标注算法名，便于用户识别算法轮换。
4. **复制指纹按钮（安全同事建议）**——两处均无「复制指纹」，用户核对需手工抄录。建议指纹行尾加复制按钮（非安全必需，属可用性增强）。
5. **安全引导**——TOFU 场景应附加「首次连接，请与服务器管理员核对指纹」类提示，降低盲点「信任」概率。
6. **图标**——connection-dialog 有 `Shield` 图标、tool-postgres 无；建议统一 `Shield`/`KeyRound` + 警示色（amber）。
7. **按钮语义**——tool-postgres 用「信任并连接」更明确；connection-dialog 用 `common.confirm` 偏弱，建议统一为「信任并连接」。

**扩展发现：SSH host key mismatch 缺 retrust 入口（安全同事提出，已核实）**
- `connection-dialog.tsx:600-630`：SSH 连接失败一律 `toast.error`，**未检测** `host key fingerprint changed`，无「重新信任」入口，用户只能手动改 host/清 fingerprint。
- `tool-postgres.tsx:730-744`：已有 mismatch 检测（`message.includes("host key fingerprint changed")`）+ toast action「重新信任主机密钥」→ `probeSshFingerprint()` 重新走 TOFU 弹窗。
- **建议**：SSH 直连侧补齐同一流程——连接失败时检测 mismatch，toast action 触发「重新信任」，复用 TOFU 指纹确认弹窗（先比对 → 确认 → 更新存储）。

---

## 10. 修复优先级

| 优先级 | 事项 |
|---|---|
| P0 | 3 个 `!inset-0 !m-auto` 弹窗改标准居中（sync-dialog / directory-transfer-dialog / database-connection-dialog-shell，均确认**未修复**） |
| P0 | SSH 直连补齐 host key mismatch →「重新信任」流程（connection-dialog.tsx:600-630，对齐 tool-postgres.tsx:730-744） |
| P1 | tool-mysql 删除确认 Dialog → AlertDialog；save-to-notes 补落点说明 + Description + 空值禁用 |
| P2 | TOFU 指纹两处统一结构化展示；指纹行加复制按钮；标注密钥算法（ssh-ed25519 等）；顶部锚定模式在代码注释中标注设计意图 |

> 已修复项（待 QA 回归）：connection-dialog.tsx:1540、tool-postgres.tsx:2786/2912 三处曾为 `!inset-0 !m-auto`，工作区已改标准居中（未提交）。
