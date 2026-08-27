# SQL ↔ 记事本 用户流程重设计

> 作者：product（产品经理）
> 状态：评审输入（未定稿）
> 关联版本：NexTerm v2.12+（当前已发布 v2.11.x）
> 输入：CTO 审计结论 + 现有代码（tool-postgres.tsx / tool-notes.tsx / note-selection.ts / toolbox-storage.ts）

---

## 0. 现状问题复盘（为什么必须改）

| 方向 | 现状 | 用户痛点 |
| --- | --- | --- |
| 保存（查询页→记事本） | 点「保存到记事本」弹窗只输标题；目标笔记**隐式**＝记事本面板当前选中项（无选中则新建） | "会保存到哪"全靠之前点过哪条笔记，完全不可预期；误追加到不相关的笔记无感知 |
| 粘贴（记事本→查询页） | 右键「粘贴到查询页」依赖编辑器工具栏的连接下拉 `quickConnectionId`；未选则报错「请先选择连接」 | 工具栏连接下拉是**快速执行**的控件，被粘贴流程借用后成为隐藏前置条件，用户常常没选就右键、撞到报错 |
| 交叉 | 保存/粘贴后无任何跳转或位置记忆 | 保存完不知道去哪验证，粘贴完不知道在哪条 tab |

**设计原则**：
1. **目标显式化**——每一个写操作，用户都能在提交前看到 SQL「将要去哪」；
2. **连接显式化**——每一个跨到查询页的操作，连接都在操作发生时选定，而非借用其他控件的隐式状态；
3. **闭环反馈**——保存/粘贴后给出可行动的反馈（跳转/定位），而不是一句 toast 就完事；
4. **最小改动**——复用现有 Dialog / ContextMenuSub / 事件总线，不引入新存储结构（NotesStorage、PostgresConnectionsStorage 数据模型不动）。

---

## 1. 功能树 + 用户故事

### 功能树

```
SQL ↔ 记事本
├── A. 保存（查询页 → 记事本）
│   ├── A1 保存弹窗显式目标选择（P0）
│   │   ├── A1.1 目标下拉：新建笔记 / 已有笔记（P0）
│   │   ├── A1.2 记忆上次目标并预填（P0）
│   │   ├── A1.3 新建时标题预填 tab.title（P0）
│   │   └── A1.4 目标信息展示：语言·行数·首行摘要（P0）
│   ├── A2 防误追加（P0）
│   │   ├── A2.1 按钮文案随目标切换（新建并保存 / 追加到该笔记）（P0）
│   │   ├── A2.2 非 SQL 笔记追加前「语言将切换」警告（P1）
│   │   └── A2.3 重复内容检测：已存在则禁用确认（P0 简化版）
│   ├── A3 保存后反馈（P0）
│   │   ├── A3.1 toast 带「查看」→ 跳转记事本并选中该笔记（P0）
│   │   └── A3.2 保存期间目标被删 → 回退新建并提示（P0）
│   ├── A4 边界（空 SQL / 无笔记 / 标题冲突）（P0/P2）
│   └── A5 查询编辑器右键入口（P0）
│       ├── A5.1 编辑器右键「保存到记事本」（与按钮共用同一弹窗/记忆/重复检测）（P0）
│       ├── A5.2 内容来源：选区 → 当前语句 → 全文（P0）
│       └── A5.3 编辑器右键基础操作（复制 P0 / 剪切粘贴 P1）
├── B. 粘贴（记事本 → 查询页）
│   ├── B1 右键菜单连接显式化（P0）
│   │   ├── B1.1 连接子菜单（ContextMenuSub，含状态点）（P0，状态点 P1）
│   │   ├── B1.2 单一连接时直接点击（P0）
│   │   └── B1.3 无连接时禁用 + 引导新建连接（P0 提示 / P1 跳转）
│   ├── B2 粘贴执行（P0）
│   │   ├── B2.1 自动建连（未连接时）+ loading/失败反馈（P0）
│   │   ├── B2.2 新 tab 标题=笔记标题、SQL 填入、聚焦文末、不自动执行（P0）
│   │   └── B2.3 连接被删/不存在 → 错误提示不建 tab（P0）
│   ├── B3 去重与多开（P1）
│   │   └── B3.1 同名同内容 tab 复用（P1）
│   └── B4 记事本编辑器选区粘贴（P0）
│       ├── B4.1 编辑器右键「将所选 SQL 粘贴到查询页」（P0）
│       ├── B4.2 选区优先，无选区回退整条笔记（P0）
│       ├── B4.3 连接子菜单与列表项右键复用（P0）
│       └── B4.4 编辑器右键基础操作（复制 P0 / 剪切粘贴 P1）
├── C. 快速执行（独立功能，仅清理耦合）
│   └── C1 保留工具栏连接下拉 + Play（现状不动）（P0）
└── D. 技术清理
    ├── D1 移除 note-selection.ts 隐式选中依赖（P1）
    └── D2 新增跨面板事件：nexterm:select-note（P0）
```

### 用户故事

**P0（本次必须交付）**
- US-1（保存·显式目标）：作为用户，我在查询页点「保存到记事本」时，弹窗必须让我**明确选择**目标（新建 or 某条已有笔记），且能看到该笔记的语言与内容规模，杜绝"不知道存到哪"。
- US-2（保存·记忆）：作为用户，我上次保存到某条笔记后，下次再点保存应默认选中同一条，减少重复选择。
- US-3（保存·防误触）：作为用户，我选择已有笔记时，按钮应明确写着「追加到该笔记」，且当内容与该笔记已有内容重复时应阻止我再存一遍。
- US-4（保存·闭环）：作为用户，保存成功后我应能一键跳转去记事本查看这条笔记，确认内容落位。
- US-5（粘贴·显式连接）：作为用户，我在记事本右键 SQL 笔记「粘贴到查询页」时，应在右键菜单里直接选择目标连接，而不是靠工具栏那个跟"快速执行"绑定的下拉。
- US-6（粘贴·自动建连）：作为用户，我选择了一个未连接的连接时，应用应自动连接成功后再打开查询页，失败时明确告知原因。
- US-7（粘贴·定位）：作为用户，粘贴完成后应自动聚焦新查询页编辑器、光标在文末，且我能从 tab 标题知道这条 SQL 来自哪条笔记。
- US-14（保存·右键）：作为用户，我不想每次点工具栏按钮——在查询编辑器里选中一段 SQL 直接右键就能「保存到记事本」，且与按钮保存的是同一套目标/记忆/防重复逻辑。
- US-15（粘贴·选区）：作为用户，一条 SQL 笔记里常常混着多段语句，我只想把**选中的一部分**发到查询页，而不是整条。

**P1（下个迭代）**
- US-8：保存到非 SQL 笔记前，警告"该笔记语言将切换为 SQL"。
- US-9：重复执行同一粘贴时，复用已打开的 tab 而不是无限新建。
- US-10：无连接时右键提供「新建连接…」直接跳转 postgres 面板。

**P2（将来）**
- US-11：支持把编辑器选中文本拖拽到笔记列表。
- US-12：保存内容差异化预览（追加前高亮将写入的块）。
- US-13：最近目标 MRU 排序（比固定记忆更聪明）。

---

## 2. 保存方向：完整交互流程

### 2.1 触发

| 步骤 | 交互 | 说明 |
| --- | --- | --- |
| S0 | 用户处于查询页，编辑器中有一段非空 SQL，点击工具栏「保存到记事本」 | 按钮沿用现有 `postgres-save-to-notes`；空 SQL 时 disabled（现状保留） |
| S0.1 | 应用对**光标所在语句**与整个文档做快照（沿用 `currentStatementSql()`，`noteContentRef` 语义不变） | 快照在弹窗打开瞬间固定，弹窗期间切 tab 不影响保存内容 |

### 2.2 弹窗（升级现有 Dialog，`w-[420px]`）

```
┌─ 保存到记事本 ────────────────────────────────┐
│                                               │
│  目标笔记                                      │
│  ┌──────────────────────────────────────────┐ │
│  │ ▾ 新建笔记…                              │ │  ← 下拉：默认＝记忆（lastSaveTarget）
│  └──────────────────────────────────────────┘ │      或"新建笔记…"
│                                               │
│  标题                                        │
│  ┌──────────────────────────────────────────┐ │
│  │ <tab.title 预填，可编辑>                 │ │  ← 仅"新建"模式可编辑
│  └──────────────────────────────────────────┘ │      "已有笔记"模式禁用并显示该笔记标题
│                                               │
│  ℹ 将追加到「生产环境常用查询」· SQL · 12 行     │  ← "已有笔记"模式：语言徽标+行数+首行截断
│  ⚠ 该笔记语言将切换为 SQL                      │  ← 仅目标语言非 sql 时出现（P1）
│  ⚠ 该 SQL 已在此笔记中，无需重复保存            │  ← 仅重复检测命中时出现（P0）
│                                               │
│            [取消]   [追加到该笔记] / [新建并保存] │
└───────────────────────────────────────────────┘
```

### 2.3 目标选择交互（核心决策）

**决策 1：下拉选已有 vs 新建？**
→ **下拉二选一**（`新建笔记…` 置顶 + 已有笔记列表）。理由：
- 下拉是现有 UI 组件（tool-notes / tool-postgres 均已用 Select），零新组件；
- 比"点已有笔记再点追加"少一步，且能在下拉项里直接带语言徽标一眼区分；
- 保留「新建」主路径（现状习惯），只是从"隐式新建"变为"显式选择新建"。

**决策 2：选中态预填？**
- 打开弹窗时：目标 = `localStorage['nexterm.notes.lastSaveTarget']`（存 `noteId` 或 `"__new__"`）。记忆的笔记已被删除 → 回退「新建笔记…」。
- 目标 = 新建：标题框预填当前 tab 标题（沿用现状 `setNoteTitle(tab.title)`），自动聚焦标题框。
- 目标 = 已有：标题框**禁用**并回显笔记当前标题，同时展示目标信息行（语言 · 行数 · 首行截断 40 字符），信息行让用户确认"就是这条，没点错"。

**决策 3：如何避免误追加？**
1. 确认按钮文案随目标变化：「新建并保存」 vs 「追加到该笔记」——用户提交前最后一眼看到的动词就是实际发生的动作；
2. 已有笔记模式的信息行与禁用标题，视觉上形成"这是目的地"的锚点；
3. 目标语言非 SQL 时（P1）显示「语言将切换为 SQL」警告——现状追加会强制 `language='sql'`，必须明示；
4. 重复检测（P0）：确认时比较目标笔记 content 中是否已存在与本次 `-- {title}` 块完全一致的内容，命中则**禁用确认按钮**并显示「该 SQL 已在此笔记中」，防止连点/重复保存污染笔记。

**决策 4：保存后反馈？**
- toast.success「已保存到「{目标标题}」」，并带 action 按钮「查看」→ 触发跨面板跳转（见 2.4）。
- 若回退新建（目标被删），toast 文案说明原因。

### 2.4 确认提交（confirmAppendSqlToNotes 改造）

1. 重新 `NotesStorage.load()` 校验目标仍在（弹窗打开期间笔记可能被删/改）；
2. 目标存在 → 追加：内容块格式沿用现状 `\n-- {title}\n{sql}`，强制 `language:'sql'`，更新 `updatedAt`；
3. 目标已删 → 回退为新建（用弹窗中标题），toast 提示「目标笔记已被删除，已改为新建」；
4. `NotesStorage.save()` + 派发 `nexterm:toolbox-changed`（现状保留，ToolNotes 刷新列表）；
5. 写回 `lastSaveTarget`（新建写 `"__new__"`，已有写 noteId）；
6. toast 带「查看」action：派发 `nexterm:select-note`（detail: `{ noteId }`）。

### 2.5 跳转「查看」实现

- `nexterm:select-note` 由 **ToolNotes** 监听：`setSelectedId(noteId)`（并清搜索框）；
- 由 **App 层**监听：`setSection('notes')` 切换到记事本视图（App.tsx 已持有 section state，最小改动）；
- 兜底：任意监听者都未处理（如 ToolNotes 未挂载）→ `handled` 标志位兜底，不做额外提示（P1 可 toast）。

### 2.6 保存方向流程图

```
[查询页 SQL 非空]
   │ 点「保存到记事本」
   ▼
[快照 SQL + 打开弹窗]
   │ 目标＝记忆(lastSaveTarget) 或 新建；标题预填 tab.title
   ▼
[用户切换目标]
   ├─ 新建 ──────→ 标题可编辑（预填 tab.title）
   └─ 已有笔记 ──→ 标题禁用 + 信息行（语言/行数/首行）+ 重复检测
                        │ 命中重复 → 确认禁用 + 提示
   ▼
[确认]
   ├─ 目标已删 → 回退新建 + toast 说明
   ├─ 校验通过 → 追加/新建 → save → toolbox-changed → 写 lastSaveTarget
   ▼
[toast「已保存到 xxx」+ action「查看」]
   └─ 点击 → 切记事本视图 + 选中该笔记（nexterm:select-note）
```

### 2.7 查询编辑器右键入口「保存到记事本」（增量，P0）

**现状**：查询编辑器（CodeEditor）区域目前**没有任何自定义右键菜单**，右键仅出现系统原生菜单（macOS WKWebView 默认编辑菜单）。因此该入口为全新添加，不与其他自定义项冲突。

**菜单结构**：

```
查询编辑器右键：
┌──────────────────────────────────┐
│ 💾 保存到记事本                    │  ← P0 主项
│    ↳ 将保存：所选内容 (3 行)        │     内容来源提示（右键瞬间计算）
│    ↳ 或：当前语句 / 整个文档        │
│ ──────────────────────────────── │
│ 复制                              │  ← P0（见「基础操作」）
│ 剪切 / 粘贴                       │  ← P1
└──────────────────────────────────┘
```

**内容来源优先级**（与工具栏按钮语义完全对齐）：
1. **有选区**（`selection.to > selection.from` 且 trim 非空）→ 选区文本；
2. **无选区** → 光标所在语句（`currentStatementAt`，tool-postgres 已有）；
3. 两者皆空 → 整个文档（`tab.sql`，与按钮 `currentStatementSql() || tab.sql` 一致）。

disabled 条件：`tab.sql.trim() === ''`（空编辑器不可保存）。

**右键菜单项交互**：
- 右键瞬间计算内容来源，菜单项副行显示「将保存：所选内容 (N 行) / 当前语句 / 整个文档」，让用户在点击前就确认将保存什么；
- 点击「保存到记事本」→ 调用与按钮**完全相同**的 `openSaveToNotes(content)`（快照 → 打开弹窗 → 记忆 → 重复检测 → toast「查看」）。按钮与右键**并存**，按钮行为不变。

**基础操作（替换原生菜单的等价物）**：
- 接管编辑器右键后系统原生菜单不再出现，为避免丢失基础编辑能力，菜单内置：
  - **复制**（P0）：`view.state.doc.sliceString(from, to)` → `navigator.clipboard.writeText`（tool-notes 已有同款先例），无选区时 disabled；
  - **剪切 / 粘贴**（P1）：粘贴用 `navigator.clipboard.readText()` + `view.dispatch` 插入；或保留系统行为做 P1 评估。

**实现方案**（二选一）：
- **方案 i（推荐，CodeEditor 零改动）**：在查询 tab 的 CodeEditor 外层用现有 `ContextMenu` 包裹（ContextMenuTrigger asChild 挂在编辑器容器 div 上，CodeMirror 内部右键事件冒泡到容器）。菜单项 `onSelect` 时通过 `queryEditorViewRef`（tool-postgres 已持有）读取选区/语句。disabled 与副行信息在 trigger 的 `onContextMenu` 时计算进 state/ref。改动集中在 tool-postgres.tsx，约 30 行。
- **方案 ii（可选，通用性强）**：CodeEditor 增加可选 prop `contextMenu?: (view, event) => ReactNode`，内部用 `EditorView.domEventHandlers({ contextmenu })` 实现（return true 阻止原生菜单）。查询编辑器与记事本编辑器一次实现、两处复用。若方案 i 在实测中出现 CodeMirror 事件被吞或定位错位，再升级到方案 ii。

> 决策建议：实现时先做方案 i（最小改动）；记事本编辑器（§3.5）同样用方案 i 包裹。两个编辑器需求一致，若后续发现方案 i 有缺陷，方案 ii 作为统一升级点。

### 2.8 保存方向（含右键）流程图

```
[查询编辑器]
   ├─ 工具栏按钮「保存到记事本」 ──→ 内容＝currentStatementSql() || tab.sql
   └─ 右键「保存到记事本」 ──────→ 内容＝选区 || currentStatementSql() || tab.sql
   （两条路径汇合）
   ▼
[openSaveToNotes(content)：快照 + 打开保存弹窗]
   （目标下拉 / 记忆 / 重复检测 / toast 查看跳转，全部与 §2.1~2.6 一致）
```

---

## 3. 粘贴方向：完整交互流程

### 3.1 入口改造（右键菜单）

```
SQL 笔记右键：
┌─────────────────────────┐
│ ▸ 粘贴到查询页          │
│   ▸ 生产 · 订单库        │   ← ContextMenuSub 连接子菜单
│   ▸ 开发 · localhost     │      每项：连接名 + 数据库名
│   ▸ 测试 · staging       │
└─────────────────────────┘
```

- **连接选择显式化**：粘贴不再读取 `quickConnectionId`；改为右键菜单内直接展开连接子菜单（`ContextMenuSub` / `SubTrigger` / `SubContent` 组件已存在，见 context-menu.tsx:65-121）。`quickConnectionId` 仅继续服务「快速执行」（Play 按钮，见 §4）。
- **单一连接简化**：连接数 == 1 时子菜单收起，「粘贴到查询页」直接可点，点击即用该唯一连接（减少一步无意义的点选）。
- **无连接**：「粘贴到查询页」disabled，hover/toast 提示「无可用连接」；子菜单中提供「新建连接…」项（P1：派发事件切到 postgres 面板并打开新建连接对话框）。
- **空内容**：SQL 语言笔记 content 为空 → 菜单项 disabled。
- 连接项排序与分组沿用现有 `groupConnectionsByGroup` / `PostgresConnectionsStorage.load()`。

### 3.2 粘贴执行

| 步骤 | 交互 | 实现 |
| --- | --- | --- |
| P1 | 用户点击「粘贴到查询页 → {某连接}」 | `pasteSqlToQuery(content, connectionId, sourceTitle)` 改造签名，不再读 quickConnectionId |
| P2 | 派发 `nexterm:paste-sql-to-query`，detail 增加 `sourceTitle` | detail: `{ content, connectionId, sourceTitle: note.title }` |
| P3 | ToolPostgres 监听收到 | 查 `connections`：连接不存在（被删）→ toast「连接不存在，请重新选择」，终止 |
| P4 | 目标连接状态判断 | 已连接（`connected && draft.id === connection.id`）→ 直接开 tab；否则 `connectEstablished(connection)` 自动建连（现状逻辑） |
| P5 | 建连中反馈 | toast「正在连接 {连接名}…」（P0 用 toast 进度；若需菜单内 loading 属 P1） |
| P6 | 建连失败 | 错误 toast（沿用 hostKeyMismatch / connectFailed 处理），**不**开 tab |
| P7 | 建连成功 / 已连接 | `openTab` 新 query tab：**标题 = 笔记标题**（sourceTitle，超长截断），sql = 内容，`dirty: true`，激活 |
| P8 | 粘贴后定位 | 激活 tab 后 CodeMirror 光标定位到文末；**不自动执行** SQL（沿用现状） |
| P9 | 完成反馈 | toast「已打开查询页：{连接名}」 |

### 3.3 与「粘贴到活动编辑器」的关系（保留现状）

- 记事本编辑器工具栏的 Send 图标 = `pasteSqlContent` → `nexterm:paste-sql-note`，作用是把内容**覆盖**到已打开的活动查询 tab（不建连不建 tab）。**本次不动**，仅优化失败文案（无活动查询 tab 时提示「请先在查询页打开一个标签」）。
- 两个入口语义区分：
  - Send 图标：灌入**当前正在看**的查询页；
  - 右键「粘贴到查询页」：**新建**查询页并明确选连接。

### 3.4 粘贴方向流程图

```
[记事本选中一条 SQL 笔记]
   │ 右键
   ▼
[粘贴到查询页]
   ├─ 无连接 ────────→ 菜单 disabled + 「无可用连接」提示（P1: 新建连接…跳转）
   ├─ 仅 1 个连接 ──→ 直接可点
   └─ 多连接 ───────→ 子菜单选择目标连接（含状态点，P1）
   ▼
[点击连接] 派发 nexterm:paste-sql-to-query{content, connectionId, sourceTitle}
   ▼
[ToolPostgres 处理]
   ├─ 连接不存在 ──→ toast 错误，终止
   ├─ 未连接 ──────→ 自动建连（toast 连接中）→ 失败则错误 toast 终止
   └─ 已连接/建连成功
         ▼
   [openTab：标题=笔记标题, sql=内容, dirty]
         ▼
   [激活 tab + 光标文末 + toast 反馈]（不自动执行）
```

### 3.5 记事本编辑器选区右键「将选中 SQL 粘贴到查询页」（增量，P0）

**现状**：记事本编辑区（CodeEditor）同样没有自定义右键菜单（仅系统原生菜单）；现有右键菜单只挂在**笔记列表项**上（粘贴到查询页 / 快速执行）。本次新增**编辑器内**右键，与列表项右键并存。

**菜单结构**（仅 SQL 语言笔记；其他语言不出现 SQL 粘贴项）：

```
记事本编辑器右键（SQL 笔记）：
┌──────────────────────────────────┐
│ ▸ 将所选 SQL 粘贴到查询页           │  ← P0：有选区时
│   ▸ 生产 · 订单库                  │     连接子菜单（与列表项右键完全复用）
│   ▸ 开发 · localhost               │
│ ▸ 将当前笔记粘贴到查询页            │  ← P0：无选区时（回退整条）
│   ▸ 生产 · 订单库                  │
│   ▸ 开发 · localhost               │
│ ──────────────────────────────── │
│ 复制                              │  ← P0
│ 剪切 / 粘贴                       │  ← P1
│ ──────────────────────────────── │
│ 粘贴到活动查询页（Send 图标同款）   │  ← P1（快捷入口，行为同工具栏 Send）
│ 快速执行（Play 图标同款）           │  ← P1
└──────────────────────────────────┘
```

**选区优先规则**：
1. 有选区且 `sliceString(from,to).trim()` 非空 → 菜单标题「将**所选** SQL 粘贴到查询页」，内容＝选区文本；
2. 无选区 / 选区为空白 → 菜单标题「将**当前笔记**粘贴到查询页」，内容＝整条笔记 content；
3. 内容（选区或整条）trim 为空 → SQL 粘贴子菜单 disabled。

**连接子菜单复用**：列表项右键与编辑器右键的「连接子菜单」抽为同一渲染函数（`renderNoteConnectionMenu(content, sourceTitle)`，tool-notes.tsx 内部 helper）。行为一致：多连接展开子菜单、单连接直接点击、无连接 disabled + 「无可用连接」提示、空内容 disabled。

**点击连接后的行为**：与列表项右键完全相同 → 派发 `nexterm:paste-sql-to-query`，detail `{ content（选区或整条）, connectionId, sourceTitle: 笔记标题 }` → tool-postgres 自动建连/开 tab/聚焦文末/不自动执行（§3.2 全流程）。sourceTitle 一律用笔记标题（不因选区改变，保持简单；P2 可选加「（选区）」后缀）。

**与 CodeMirror 原生右键共存**：编辑器右键被自定义菜单接管（preventDefault），菜单内置「复制/剪切/粘贴」基础操作作为原生菜单的等价替代（复制 P0，剪切粘贴 P1，实现同 §2.7「基础操作」）。记事本编辑器无其他既有右键项，无冲突。

**实现方案**：与 §2.7 相同的方案 i —— 记事本 CodeEditor 外层包 ContextMenu，菜单项 onSelect 时通过**新增的 editorRef** 读取选区（tool-notes 当前未持有 EditorView，需在 CodeEditor 上加 `editorRef={(view) => noteEditorViewRef.current = view}`，CodeEditor 组件本身无需改动）。

---

## 4. 快速执行（现状保留，仅语义解耦）

- 记事本编辑器工具栏的「连接下拉 + Play」= 快速执行，本次**保持现状**（`quickConnectionId` + `nexterm:quick-execute-postgres`）。
- 解耦后收益：`quickConnectionId` 的语义从「既快速执行又粘贴」收敛为「仅快速执行」，消除隐藏前置条件；后续若要做「右键菜单快速执行」可再独立设计（P2）。

---

## 5. 状态与边界

| # | 边界场景 | 设计行为 | 分级 |
| --- | --- | --- | --- |
| B1 | 保存：无任何笔记 | 目标下拉仅有「新建笔记…」，标题预填 tab.title 并自动聚焦 | P0 |
| B2 | 保存：空 SQL | 保存按钮 disabled（现状保留） | P0 |
| B3 | 保存：内容与目标笔记重复 | 确认按钮禁用 + 提示「该 SQL 已在此笔记中」 | P0 |
| B4 | 保存：目标笔记在弹窗期间被删 | 确认时重新 load 校验 → 回退新建 + toast 说明 | P0 |
| B5 | 保存：目标语言非 SQL | 追加时强制 SQL（现状）；P1 在弹窗内警告「语言将切换为 SQL」 | P1 |
| B6 | 保存：新建标题与已有笔记重名 | 允许重名（现状），P2 可加同名提示 | P2 |
| B7 | 保存：记忆的目标被删 | 打开弹窗时回退「新建笔记…」 | P0 |
| B8 | 粘贴：无连接 | 菜单 disabled + 提示；P1 提供「新建连接…」跳转 | P0/P1 |
| B9 | 粘贴：选中连接被删/不存在 | toast「连接不存在，请重新选择」，不建 tab | P0 |
| B10 | 粘贴：连接未建立 | 自动建连；连接中反馈 + 失败错误 toast，不建 tab | P0 |
| B11 | 粘贴：SSH host key mismatch | 沿用现有重信任流程（toast action → probeSshFingerprint） | P0 |
| B12 | 粘贴：重复粘贴同一条 | 每次新建独立 tab（现状）；P1 复用同名同 SQL 的未运行 tab | P1 |
| B13 | 粘贴：内容为空 | 菜单 disabled | P0 |
| B14 | 粘贴：SQL 笔记中混有 shell | 仅 language=sql 的笔记出现粘贴菜单（现状保留） | P0 |
| B15 | 快速执行：未选连接 | Play disabled（现状保留） | P0 |
| B16 | 右键保存：无选区 | 回退保存光标所在语句；仍无 → 回退全文 | P0 |
| B17 | 右键保存：空编辑器 | 菜单项 disabled | P0 |
| B18 | 右键粘贴：选区为空白 | 回退整条笔记 | P0 |
| B19 | 编辑器右键替换原生菜单 | 菜单内置「复制」（P0）作为等价替代，不丢失基础能力 | P0 |
| B20 | 右键保存/粘贴：内容来源标注 | 菜单项副行显示「所选内容 (N 行) / 当前语句 / 整个文档」 | P0 |

---

## 6. 验收标准（Acceptance Criteria，可测试）

### A. 保存方向

| # | 场景 | 步骤 | 预期 |
| --- | --- | --- | --- |
| AC-S1 | 弹窗结构 | 查询页有 SQL → 点「保存到记事本」 | 弹窗含「目标笔记」下拉与「标题」输入；下拉默认值 = 上次记忆（首次为「新建笔记…」） |
| AC-S2 | 新建路径 | 目标=新建 → 输入标题「T」→ 保存 | 新建一条 title=T、language=sql 的笔记，content 以 `-- T` 开头，toast「已保存到 T」 |
| AC-S3 | 追加路径 | 目标=已有笔记 X → 保存 | 内容追加到 X 末尾（`\n-- {标题}\n{sql}`），X 的 updatedAt 更新，toast「已保存到 X」 |
| AC-S4 | 标题预填/禁用 | 目标=新建 | 标题框预填当前查询 tab 标题且可编辑；切换目标=已有 X → 标题框禁用并显示 X 的标题 |
| AC-S5 | 按钮文案 | 目标=新建 | 确认按钮为「新建并保存」；目标=已有 X → 「追加到该笔记」 |
| AC-S6 | 目标信息行 | 目标=已有 X | 弹窗显示 X 的语言徽标、内容行数、首行截断摘要 |
| AC-S7 | 重复检测 | X 已含相同 SQL → 目标= X | 确认按钮禁用，提示「该 SQL 已在此笔记中」；内容不重复写入 |
| AC-S8 | 目标被删回退 | 弹窗打开期间删除 X → 确认 | 自动改新建，toast 说明，不写坏数据 |
| AC-S9 | 记忆 | 保存到 X → 重新打开弹窗 | 默认目标 = X |
| AC-S10 | 跳转查看 | 保存成功 → 点 toast「查看」 | 界面切到记事本视图，且该笔记被选中（列表高亮） |
| AC-S11 | 无笔记 | 记事本为空 → 保存 | 下拉仅「新建笔记…」，标题自动聚焦 |
| AC-S12 | 空 SQL | 编辑器为空 | 保存按钮 disabled |
| AC-S13 | 右键入口存在 | 查询编辑器右键 | 菜单含「保存到记事本」项，副行标注内容来源 |
| AC-S14 | 右键保存选区 | 选中文本 → 右键保存 | 弹窗打开、标题预填、确认后保存内容＝选区 |
| AC-S15 | 右键保存语句/全文 | 无选区 → 右键保存 | 内容＝光标语句；文档空则菜单 disabled |
| AC-S16 | 按钮/右键并存 | 两入口分别使用 | 工具栏按钮行为不变，右键新增且逻辑一致 |

### B. 粘贴方向

| # | 场景 | 步骤 | 预期 |
| --- | --- | --- | --- |
| AC-P1 | 连接子菜单 | SQL 笔记右键 | 「粘贴到查询页」展开连接子菜单，列出全部连接（名称+数据库） |
| AC-P2 | 单连接简化 | 仅 1 个连接 | 「粘贴到查询页」直接可点，点击即用该连接 |
| AC-P3 | 无连接 | 0 个连接 | 菜单 disabled，提示「无可用连接」 |
| AC-P4 | 已连接粘贴 | 目标连接已连接 → 点击 | 新建 query tab（标题=笔记标题，sql=内容，dirty），激活，光标文末，不执行 |
| AC-P5 | 自动建连 | 目标未连接 → 点击 | toast「正在连接…」→ 成功后开 tab；失败则错误 toast 且不开 tab |
| AC-P6 | 连接被删 | 目标连接不存在 → 点击 | toast「连接不存在，请重新选择」，不建 tab |
| AC-P7 | 空内容 | SQL 笔记内容为空 | 菜单 disabled |
| AC-P8 | 来源标题 | 粘贴完成 | tab 标题为该笔记标题，不是「Quick Query」 |
| AC-P9 | 快速执行不受影响 | 工具栏连接下拉 + Play | 行为与现状一致 |
| AC-P10 | 选区粘贴 | SQL 笔记中选中一段文本 → 右键「将所选 SQL 粘贴到查询页」→ 选连接 | 新建 tab，内容＝**选区文本**（非整条），标题＝笔记标题，聚焦文末不执行 |
| AC-P11 | 无选区回退 | SQL 笔记无选区 → 右键 | 菜单显示「将当前笔记粘贴到查询页」，内容＝整条 |
| AC-P12 | 空白选区回退 | 选中的是空白/换行 → 右键 | 视为无选区，回退整条 |
| AC-P13 | 右键复制 | 两个编辑器右键菜单 | 均含「复制」；选中文本 → 复制 → 剪贴板内容正确 |
| AC-P14 | 右键保存来源 | 查询编辑器选中文本 → 右键「保存到记事本」 | 保存内容＝选区文本；无选区时＝光标语句；空编辑器菜单 disabled |
| AC-P15 | 右键/按钮共用逻辑 | 右键保存与按钮保存 | 目标下拉、记忆、重复检测、toast 查看跳转行为完全一致 |
| AC-P16 | 连接子菜单复用 | 列表项右键与编辑器右键 | 连接子菜单项（连接名+数据库、单连接直点、无连接禁用）行为一致 |

### C. 回归（不改坏）

- AC-R1：`nexterm:paste-sql-note`（Send 图标覆盖活动 tab）行为不变；
- AC-R2：`nexterm:quick-execute-postgres` 行为不变；
- AC-R3：无任何改动时全量现有 postgres/notes e2e 通过。

---

## 7. 涉及改动点清单（供实现估算）

### 7.1 保存方向

| 文件/位置 | 改动 | 工作量(相对) |
| --- | --- | --- |
| `src/components/toolbox/tool-postgres.tsx`（约 961-991、2911-2917） | ① 保存 Dialog 升级：加入目标笔记 Select、目标信息行、重复检测提示、动态按钮文案；② `appendSqlToNotes`：读 NotesStorage 构建下拉数据、读 lastSaveTarget 记忆、预填与聚焦；③ `confirmAppendSqlToNotes`：改为携带目标 noteId（null=新建）、重载校验目标存在、重复检测、回退新建、写记忆、toast 带「查看」action | 中（组件 + 逻辑，复用现有 Select/Dialog） |
| `src/lib/toolbox/toolbox-storage.ts` 或直接 `localStorage` | 新增 key `nexterm.notes.lastSaveTarget`（noteId 或 `"__new__"`），读写封装（可直接放 tool-postgres 内工具函数，最小改动） | 小 |
| `src/App.tsx`（约 109、1660） | 监听 `nexterm:select-note` → `setSection('notes')` | 小 |
| `src/components/toolbox/tool-notes.tsx` | 监听 `nexterm:select-note` → `setSelectedId(noteId)` + 清空搜索 | 小 |
| i18n | 新增文案：新建笔记、追加到该笔记、目标信息行、语言切换警告、重复提示、目标被删说明、查看、连接不存在等（`toolbox.postgres.*` / `toolbox.notes.*`） | 小 |
| `src/lib/toolbox/note-selection.ts` | P1 清理：确认保存方向不再读 `getSelectedNoteId()` 后移除该模块及 import | P1，小 |
| `src/components/toolbox/tool-postgres.tsx`（查询编辑器区域，约 2400-2428） | **增量**：查询 CodeEditor 外层包 ContextMenu（方案 i）；「保存到记事本」右键项 → 内容＝选区‖语句‖全文 → 复用 `openSaveToNotes(content)`；右键瞬间计算内容来源副行；「复制」菜单项 | 小-中 |
| 测试 | vitest（append 逻辑）+ e2e（保存→查看跳转、右键保存、选区保存） | 中 |

### 7.2 粘贴方向

| 文件/位置 | 改动 | 工作量(相对) |
| --- | --- | --- |
| `src/components/toolbox/tool-notes.tsx`（约 204-217、300-307） | ① 右键菜单：SQL 笔记加入 ContextMenuSub 连接子菜单（读 PostgresConnectionsStorage，groupConnectionsByGroup 排序）；② `pasteSqlToQuery` 签名改 `(content, connectionId, sourceTitle)`，移除 quickConnectionId 依赖与「请先选择连接」报错；③ 无连接/空内容 disabled 逻辑 | 中 |
| `src/components/toolbox/tool-postgres.tsx`（约 781-800） | ① `pasteToQuery` 监听：接收 `sourceTitle`，tab 标题=笔记标题；② 建连中 toast 反馈；③ 激活后聚焦编辑器文末；④ 连接不存在分支 | 小-中 |
| `src/components/ui/context-menu.tsx` | 无需改动（Sub/SubTrigger/SubContent 已存在，65-121） | 0 |
| `src/components/toolbox/tool-notes.tsx`（编辑器区域，约 316-403） | **增量**：记事本 CodeEditor 外层包 ContextMenu（方案 i）；新增「将所选/当前笔记 SQL 粘贴到查询页」→ 选区优先 → 连接子菜单（抽 `renderNoteConnectionMenu(content, sourceTitle)` helper 与列表项右键复用）；新增 `editorRef` 持有 noteEditorViewRef 读取选区；「复制」菜单项 | 中 |
| `src/components/code-editor.tsx` | 方案 i 下零改动；仅当升级方案 ii 时加 `contextMenu?` prop（P1 评估） | 0（或小） |
| i18n | 新增文案：无可用连接、正在连接、连接不存在、已打开查询页等 + 右键菜单文案（保存到记事本、将所选 SQL 粘贴到查询页、将当前笔记粘贴到查询页、复制、所选内容/当前语句/整个文档 来源副行） | 小 |
| 测试 | e2e：右键→选连接→tab 打开（含自动建连、失败分支）、选区粘贴（选区优先/无选区回退）、右键保存（选区/语句/空禁用） | 中 |

### 7.3 事件契约（新增）

| 事件 | payload | 发起 | 监听 |
| --- | --- | --- | --- |
| `nexterm:select-note` | `{ noteId: string; handled?: boolean }` | tool-postgres（保存 toast「查看」action） | tool-notes（选中）、App（切 section） |
| `nexterm:paste-sql-to-query`（扩展现有） | 增加 `sourceTitle: string` | tool-notes（右键子菜单） | tool-postgres |

### 7.4 不做/延后

- NotesStorage / PostgresConnectionsStorage 数据模型：**零改动**；
- 快速执行入口：零改动；
- DnD、差异预览、MRU：P2，不排期。

---

## 8. P0 / P1 / P2 汇总

**P0（本次必须）**：A1.1-A1.3、A2.1/A2.3、A3.1/A3.2、A5 全项、B1.1/B1.2/B1.3(提示)、B2 全项、B3(空内容)、B4 全项、D2；对应 AC-S1~AC-S16、AC-P1~AC-P16、AC-R1~R3。

**P1（下个迭代）**：A2.2（语言切换警告）、B1.3（新建连接跳转）、B1.1（连接状态点）、B3.1（tab 去重）、D1（note-selection.ts 清理）、B11（菜单内建连 loading）、A5.3/B4.4（剪切/粘贴、编辑器菜单快捷入口）。

**P2（将来）**：B6（重名提示）、US-11~13（DnD、差异预览、MRU）。
