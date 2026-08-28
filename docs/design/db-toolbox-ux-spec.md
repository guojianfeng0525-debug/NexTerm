# 数据库工具箱 UI/UX 交互规范

> 版本：0.2（评审稿） ｜ 作者：uiux-designer ｜ 日期：2026-08-28
> 0.2 变更：① §2.2.2 补错误卡引导行（suggestion）/选中焦点态/toast 双写裁定；② 新增 §4.5 查询历史面板视觉（对齐 product-spec F5/L5-L6）；③ 线框 §5.7；④ 落地清单 A2/A5 范围修正、补 A11。
> 范围：PostgreSQL / MySQL / SQLite 工具箱的**右键菜单、错误信息、快捷键、状态与联动**四大交互域。AI / BI / ER 不在范围。
> 输入：竞品分析 `docs/analysis/db-tool-competitor-analysis.md`、实现审计 `docs/analysis/db-toolbox-implementation-audit.md`、`src/components/ui/*`、`src/styles/globals.css`、`src/index.css`、`tool-postgres.tsx` / `database-result-pane.tsx` / `database-navigator.tsx` 等现有实现。
> 约束：纯设计任务，不改代码；所有颜色/圆角/间距/字号引用现有 CSS 变量与 shadcn token，**不发明新主题**。落地时以本节为验收依据，类名与 token 名即实现契约。

---

## 0. 设计基线（本规范的 token 契约）

以下 token 均来自 `src/styles/globals.css` 与 `src/index.css` 的 `@theme inline` 映射，**不得引入新色值**。

| 语义 | token / 类名 | 用途 |
|---|---|---|
| 面板底 | `bg-background` / `bg-popover` | 结果面板、菜单容器 |
| 一级文字 | `text-foreground` | 菜单项、错误标题、正文 |
| 弱化文字 | `text-muted-foreground` | 快捷键标注、NULL 占位、说明性文字 |
| 高亮/选中 | `bg-primary/10 text-primary`、hover `hover:bg-accent/70` | 导航树选中、菜单项 hover 统一由 Radix 提供 `bg-accent` |
| 危险 | `text-destructive`、`bg-destructive/10`、`border-destructive/30` | 错误、破坏性动作、断线横幅 |
| 成功 | `text-success`、`bg-success/10` | 执行成功态 |
| 警告 | `text-warning`、`bg-warning/10` | 快捷键冲突、连接中 |
| 边框 | `border-border`（`--border`） | 分隔线、面板边 |
| 焦点环 | `ring-ring`（`--ring`） | 键盘焦点 |
| 状态点 | `bg-emerald-500` / `bg-amber-400` / `bg-red-500` / `bg-muted-foreground/50` | connected/connecting/error/disconnected（现有 `statusDotClass` 约定） |
| 圆角 | `rounded-sm`（菜单项）、`rounded-md`（菜单容器）、`rounded-lg`（错误区卡片） | 层级：交互单元 < 容器 < 区内卡片 |
| 字号 | 菜单项 `text-sm`；面板元信息 `text-[11px]`；网格/错误正文 `text-[12px]`；快捷键 `text-xs`；错误码 `text-[12px] font-mono` | 沿用现有密度 |
| 行高/间距 | 菜单项 `py-1.5 px-2`；分隔线 `my-1 h-px`；面板 header `h-7`/`h-8` | 沿用现有布局 |
| 阴影 | `shadow-md`（菜单）、`shadow-soft-lg`（错误区、横幅） | 浮层 |
| 动画 | `animate-in fade-in-0 zoom-in-95`（菜单由 Radix 提供）、`fade-in 0.2s`（面板切换） | 勿新增动画 |

**组件选型原则**
- 右键弹层一律用 `ContextMenu*`（`src/components/ui/context-menu.tsx`）；由按钮/图标点击触发的同类弹层用 `DropdownMenu*`，**两者共用本文的菜单形态与分组规范**。
- 勾选项用 `ContextMenuCheckboxItem` / `DropdownMenuCheckboxItem`，**禁止手写 `" ✓"` 文本**（现有 `toggleFieldType`/`toggleComment` 的 `" ✓"` 写法需要迁移）。
- 破坏性动作菜单项用 `variant="destructive"`（已有该 prop），并配合确认（`AlertDialog` 或现有 dry-run 确认路径）。
- 菜单快捷键标注用 `ContextMenuShortcut` / `DropdownMenuShortcut`（自带 `text-muted-foreground ml-auto text-xs tracking-widest`），**不要自建 span**。

---

## 1. 右键菜单交互规范

### 1.1 菜单形态规范

**1.1.1 结构与层级**
- 一级菜单 ≥ 2 项即可出现；超过 9 项必须拆子菜单（`ContextMenuSub`）。
- 子菜单最多两级（一级 → 子级），禁止三级。典型子菜单：对象树「生成 SQL ▸」、单元格「生成 INSERT/UPDATE SQL ▸」。
- 菜单项高度固定 `py-1.5`（text-sm 单行），多行标注（如「保存到记事本」的来源副文本）使用内部 `flex flex-col` + `text-[10px] text-muted-foreground` 副行，保持行高不变。

**1.1.2 分组线（语义分组）**
- 分组线用 `ContextMenuSeparator`（`bg-border -mx-1 my-1 h-px`）。
- 分组规则（三分组法）：
  1. **查看/复制组**：打开、复制、生成——只读动作，放最前；
  2. **编辑/筛选组**：改数据、筛选、布局——会改变状态的动作；
  3. **危险组**：删除、清空、Drop——必须带分隔线置于**菜单底部**，项用 `variant="destructive"`，且只允许每菜单一个危险组。
- 同组内 4–7 项为上限；超过则拆子菜单或精简。

**1.1.3 图标 + 快捷键标注排版**
- 每个菜单项带 lucide 图标（`size-4` 默认，本项目惯例 `h-3.5 w-3.5`），默认着色 `text-muted-foreground`（由 `[&_svg:not([class*='text-'])]:text-muted-foreground` 提供）；危险组图标用 `text-destructive`。
- 排版顺序（水平）：
  ```
  [icon]  菜单文案 [……副文本……]            [快捷键标注]
  ```
  图标固定最左；快捷键标注 `ml-auto` 右对齐（Radix 布局已保证）。
- 快捷键标注规则：
  - 只有**真实绑定且当下生效**的快捷键才标注，禁止标注未实现的键位；
  - macOS 显示 `⌘`/`⇧`/`⌥`/`⌫` 等符号，Windows/Linux 显示 `Ctrl+`/`Shift+` 文本（用一个 `formatShortcut(combo, platform)` 工具函数，来源为 `bindings.ts` / `command-registry.ts` 的 `defaultBinding`）；
  - 快捷键随菜单项**居中于当前 scope**（编辑器内菜单标注编辑器快捷键，网格菜单标注网格快捷键）。

**1.1.4 菜单项启停/置灰规则（全局通用）**
- 置灰实现：传 `disabled` prop，Radix 自动 `opacity-50 + pointer-events-none`。**不要用条件渲染隐藏**——置灰给用户"此动作在此语境存在但不可用"的反馈。
- 通用置灰矩阵：

| 条件 | 受影响项 |
|---|---|
| 未连接（`connectionState !== "connected"`） | 所有需要连接的项（打开数据、生成 SQL、刷新、执行……） |
| 连接处于只读（`config.readOnly`） | 全部编辑/写入类（设 NULL、生成 UUID、删除记录、Drop、设计表） |
| 无文本选中 / 编辑器无 SQL | 剪切、复制、运行选择、运行 |
| 主键列（`isPrimaryKeyColumn(columnIndex)`） | 设 NULL、设 DEFAULT、设空串、生成 UUID |
| 列不可空（`canSetNull(columnIndex) === false`） | 设为 NULL |
| 行无主键（`rowHasPrimaryKey(row) === false`） | 删除记录 |
| 无冻结列（`layout.frozenCount === 0`） | 取消冻结全部 |
| 菜单来源是 insert 行 | 筛选、导出类的仅数据行动作；insert 行只保留复制/移除 |

- 危险项置灰时仍显示完整文案，不加额外 icon；`disabled + destructive` 组合的悬停不触发任何动作。

**1.1.5 键盘导航与长列表**
- Radix 已内置：`↑/↓` 移动高亮（循环）、首字母 type-ahead、`Enter` 触发、`Esc` 关闭、`Tab` 关闭。**不要重复实现**。
- 长列表（>12 项）：`ContextMenuContent` 已含 `max-h-(--radix-context-menu-content-available-height) overflow-y-auto`，无需改动；子菜单内容超过视口时 Radix 自动翻转方向。禁止给菜单容器自定义固定 max-h（除非是"列列表"这类场景，可加 `max-h-80`）。

### 1.2 各场景菜单内容清单

> 格式：`菜单项 ｜ 图标(lucide) ｜ 快捷键标注 ｜ 置灰条件 ｜ 点击行为`。`——`表示不标注/不置灰。所有 i18n 文案沿用现有 key，新增 key 以 `toolbox.<provider>.xxx` 命名。

#### 1.2.1 导航树 · 连接节点

分组 A（连接状态）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 断开连接（已连接时）/ 重新连接（断开时） | `Unplug` / `RefreshCw` | —— | —— | `disconnect()` / `connectEstablished(connection)` |
| 新建查询 | `FilePlus2` | `Ctrl+N` | 未连接 | `createQuery()` |
| 刷新 | `RefreshCw` | `F5` | 未连接 | `refreshNavigator()` |

分组 B（管理）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 连接管理器 | `Server` | —— | —— | `setManagerOpen(true)` |
| 编辑连接 | `Pencil` | —— | —— | 打开连接配置对话框（预填当前连接） |

分组 C（危险，底部）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 删除连接（destructive） | `Trash2` | —— | —— | `AlertDialog` 确认后删除（现有 `window.confirm` 升级为 `AlertDialog`） |

#### 1.2.2 导航树 · 表 / 视图 / 物化视图

分组 A（打开与设计）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 打开数据 | `Table2` | `Enter` | 未连接 | `browse(relation)` |
| 设计表（仅 table） | `PencilRuler` | —— | 未连接 | `openDesigner(schema, table)` |
| 设计视图（仅 view） | `PencilRuler` | —— | 未连接 | `openViewDesigner(...)` |
| 设计视图（物化视图，置灰+title 说明只读） | `PencilRuler` | —— | 恒置灰 | ——（保留现有 title 提示） |

分组 B（生成与复制）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 生成 SQL ▸（子菜单） | `Braces` | —— | 未连接 | 见下表子菜单 |
| 生成 DDL | `FileCode` | —— | 未连接 | `generateObjectDdl(activeReference)` |
| 复制限定名 | `Copy` | —— | 未连接 | 复制带引号限定名（现有 `copyValue()`） |

「生成 SQL ▸」子菜单项（新增强联动）：
| 子菜单项 | 置灰 | 生成内容 |
|---|---|---|
| SELECT | 未连接 | `SELECT * FROM "schema"."name" LIMIT 1000;` |
| INSERT | 未连接 | `INSERT INTO "schema"."name" (col1, col2) VALUES (…);` 模板（列清单） |
| UPDATE | 未连接 | `UPDATE "schema"."name" SET col1 = … WHERE pk = …;` 模板 |
| DELETE | 未连接 | `DELETE FROM "schema"."name";`（危险确认文案内联注释 `-- 全表删除`） |

分组 C（维护）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 刷新 | `RefreshCw` | `F5` | 未连接 | `refreshNavigator()` |
| 新建查询 | `FilePlus2` | `Ctrl+N` | 未连接 | `createQuery()`（仅非对象节点） |
| 新建表（仅表分组节点） | `Table2` | —— | 未连接 | `openDesigner(schema, "", true)`（保留现有） |

分组 D（危险，底部）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 删除表/视图（destructive） | `Trash2` | —— | 未连接或只读 | `requestObjectDrop(activeReference)`（保留 dry-run 确认） |

#### 1.2.3 导航树 · 函数 / 序列 / 索引 / 约束 / 触发器（对象查看器入口）

| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 打开对象查看器 | `Eye` | —— | 未连接 | `openObjectViewer(objectReference)` |
| 复制限定名 | `Copy` | —— | 未连接 | `copyText(copyValue())`（函数含签名） |
| 刷新 | `RefreshCw` | `F5` | 未连接 | `refreshNavigator()` |

#### 1.2.4 导航树 · 列

| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 复制列名 | `Copy` | —— | 未连接 | 复制 `schema.table.column`（现有 `copyValue()` 的 column 分支） |
| 复制列定义 | `FileCode` | —— | 未连接 | 复制该列 DDL 片段（`ALTER TABLE … ADD COLUMN …`）※新增 |

#### 1.2.5 查询编辑器（重构现有 2639–2756）

分组 A（编辑）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 撤销 | `Undo2` | `Ctrl+Z` | 无撤销栈 | `runCmCommand(undo)` |
| 重做 | `Redo2` | `Ctrl+Shift+Z` | 无重做栈 | `runCmCommand(redo)` |
| 剪切 | `Scissors` | `Ctrl+X` | 无选中 | `cutEditorSelection()` |
| 复制 | `Copy` | `Ctrl+C` | 无选中 | `copyText(editorCopyValue())`（现有末项"复制"移入本组） |
| 粘贴 | `ClipboardPaste` | `Ctrl+V` | —— | `pasteIntoEditor()` |
| 全选 | `ListChecks` | `Ctrl+A` | —— | `runCmCommand(selectAll)` |

分组 B（执行与 SQL）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 运行 | `Play` | `Ctrl+Enter` | 未连接或无 SQL | `execute()` |
| 运行选择 | `ListPlus` | `Ctrl+Shift+Enter` | 未连接或无选中 | `runSelectionOrStatement()` |
| 解释执行计划（EXPLAIN）※新增 | `LineChart` | `Ctrl+Shift+E` | 未连接或运行中 | `execute(true)` |
| 格式化 SQL | `Wand2` | `Ctrl+Shift+F` | 未连接 | `formatSqlInEditor()` |
| 注释 / 取消注释 ※新增 | `Hash` | `Ctrl+/` | 未连接 | `toggleSqlComment()` |

分组 C（保存与复用）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 保存到记事本 | `FileCode2` | —— | 无 SQL | 现有 `openSaveToNotesFromEditorMenu`（保留 selection/statement/document 来源副文本） |
| 保存 SQL | `Save` | `Ctrl+S` | 无 SQL | `saveCurrentSql()` |

**审查调整说明**：现有"复制"孤悬菜单末尾 → 移入编辑组；现有"运行选择"的快捷键标注与手写 keydown 的 `Ctrl+E` 不一致，规范统一为 `Ctrl+Shift+Enter`（见 §3 快捷键决策）；补 EXPLAIN、注释、保存 SQL 三项。

#### 1.2.6 数据网格 · 单元格（重构现有 2898–2941）

分组 A（复制）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 复制单元格 | `Copy` | `Ctrl+C` | —— | `copyText(cell ?? "NULL")` |
| 复制行 | `CopyCheck` | `Ctrl+Shift+C` | —— | `copyText(row.join("\t"))` |
| 复制列名 | `CopyMinus` | —— | —— | `copyText(columnName)` |
| 生成 INSERT/UPDATE SQL ▸（子菜单）※新增 | `Braces` | —— | 未连接 | 见下 |

「生成 INSERT/UPDATE SQL ▸」子菜单（DBeaver 基于行生成回写脚本范式）：
| 子菜单项 | 置灰 | 行为 |
|---|---|---|
| 生成 INSERT 语句 | 未连接 | 以当前行为值生成 `INSERT INTO … (cols) VALUES (row)` |
| 生成 UPDATE 语句（按主键） | 未连接或行无主键 | `UPDATE … SET col = val … WHERE pk = …` 插入编辑器 |
| 生成 DELETE 语句（按主键） | 未连接或行无主键 | `DELETE FROM … WHERE pk = …` |

分组 B（筛选，仅 table tab）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 按字段值筛选 | `ListFilter` | —— | 非 table tab | `applyFilterByFieldValue(columnName, cell)` |
| 自定义筛选 | `Filter` | —— | 非 table tab | `setFilterDialog({ mode: "custom" })` |

分组 C（编辑，仅 table tab 且可编辑）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 设为 NULL | `Eraser` | —— | 列不可空 | `stageTableEdit(rowIndex, columnIndex, null)` |
| 设为 DEFAULT ※新增 | `RotateCcw` | —— | 主键列 | `stageTableEdit(rowIndex, columnIndex, "DEFAULT")` |
| 设为空字符串 | `RemoveFormatting` | —— | 主键列 | `stageTableEdit(rowIndex, columnIndex, "")` |
| 生成 UUID | `Fingerprint` | —— | 主键列 | `stageTableEdit(rowIndex, columnIndex, crypto.randomUUID())` |
| 删除记录 | `Trash2` | `Ctrl+Delete` | 无主键 | `requestDeleteRow(rowIndex)` |

分组 D（导出，兜底）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 导出 CSV | `FileDown` | —— | —— | `exportCsv()` |
| 导出 Excel | `FileSpreadsheet` | —— | —— | `exportExcel()` |

insert 行（`source === "insert"`）保留：复制单元格、复制行、移除记录；隐藏筛选与编辑组。

#### 1.2.7 数据网格 · 列头（重构现有 2942–2962）

分组 A（筛选排序）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 筛选与排序 | `ListFilter` | `Ctrl+R` | 非 table tab | `setFilterDialog({ mode: "filterSort" })` |

分组 B（列布局）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 冻结此列 | `Pin` | —— | 非 table tab | `freezeColumn(columnIndex)` |
| 取消冻结全部 | `PinOff` | —— | 无冻结列 | `unfreezeAllColumns()` |
| 设置列宽 | `MoveHorizontal` | —— | 非 table tab | `setLayoutDialog({ kind: "columnWidth", columnIndex })` |
| 最佳宽度 | `Shrink` | —— | 非 table tab | `bestFitColumn(columnIndex)` |

分组 C（显示，改用 CheckboxItem）：
| 菜单项 | 组件 | 选中态 | 点击行为 |
|---|---|---|---|
| 显示字段类型 | `ContextMenuCheckboxItem` | `layout.showFieldType` | `toggleFieldType()` |
| 显示注释 | `ContextMenuCheckboxItem` | `layout.showComment` | `toggleComment()` |

#### 1.2.8 数据网格 · 行 gutter（重构现有 2963–2965）

分组 A（行操作）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 添加记录 | `Plus` | `Insert` | 非 table tab 或只读 | `addRecord()` |
| 复制本行 | `CopyCheck` | `Ctrl+Shift+C` | —— | 复制行内容（TSV） |

分组 B（布局）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 设置行高 | `Rows3` | —— | 非 table tab | `setLayoutDialog({ kind: "rowHeight" })` |

#### 1.2.9 结果面板 · 消息区 / 空态 / 错误区（新增）

空态/消息区右键（挂在 `labels.ready` 容器上）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 复制消息 | `Copy` | —— | 无文本 | 复制消息文本 |
| 清空结果 | `Trash2` | —— | 无结果 | `patchTab(tab.id, { result: null })` |

错误区右键（见 §2.2.2）：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 复制错误文本 | `Copy` | —— | —— | 复制完整错误（含服务端详情） |
| 定位到出错行 | `Crosshair` | —— | 无可定位行号 | 滚动编辑器到出错行 |
| 重试 | `RotateCw` | `Ctrl+Enter` | 未连接 | `execute()` |

#### 1.2.10 表设计器（新增）

列行右键：
| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 复制列定义 | `Copy` | —— | —— | 复制该列 `ALTER TABLE …` 片段 |
| 插入列（上方/下方） | `ArrowUpToLine` / `ArrowDownToLine` | —— | readOnly | 在 draft 数组指定位置插入空列 |
| 移动（上移/下移） | `ChevronUp` / `ChevronDown` | `Alt+↑` / `Alt+↓` | readOnly 或首尾行 | 交换列顺序 |
| 删除列（destructive） | `Trash2` | `Ctrl+Delete` | readOnly | `removeColumn(i)` |

约束行右键：复制约束定义、删除约束（destructive，readOnly 置灰）。

#### 1.2.11 对象查看器（新增）

| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 复制 DDL | `Copy` | —— | 无 DDL | 复制 `ddl` 文本 |
| 在查询编辑器打开 | `FilePlus2` | —— | 无 DDL | 新查询 tab 插入 DDL |
| 刷新 | `RefreshCw` | `F5` | —— | 重新 `load()` |

#### 1.2.12 查询历史（DB 域，新增）

> DB 域查询历史当前无记录器（审计 §4.2-6），本清单为"记录器落地后"的菜单目标形态；若本迭代不建记录器则跳过。

| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 再次执行 | `Play` | `Ctrl+Enter` | 未连接 | 新查询 tab 执行该 SQL |
| 插入到编辑器 | `FileInput` | —— | —— | 插入当前编辑器光标处 |
| 复制 SQL | `Copy` | —— | —— | 复制文本 |
| 删除本条（destructive） | `Trash2` | `Delete` | —— | 从历史移除 |
| 清空历史（destructive，列表头部） | `Trash2` | —— | 空历史 | `AlertDialog` 确认后清空 |

#### 1.2.13 工作区 Tab（补充现有 2547–2553）

| 菜单项 | 图标 | 快捷键 | 置灰 | 点击行为 |
|---|---|---|---|---|
| 关闭 | `X` | `Ctrl+W` | —— | `requestCloseTab(item.id)` |
| 关闭其他 | `PanelClose` | —— | tabs < 2 | 关闭除当前外全部 |
| 关闭全部 | `XSquare` | —— | tabs < 2 | 关闭全部 tab |

### 1.3 PG 现有菜单信息架构审查结论

对 `tool-postgres.tsx` 现有四组菜单逐条审查：

**导航树连接节点（2443–2460）**
- ✅ 断开/重连、新建查询、刷新、连接管理器、编辑、删除 全部保留。
- ⚠️ 问题 1：无分组线，6 项挤成一片 → 按 §1.2.1 三分组。
- ⚠️ 问题 2：删除用 `window.confirm` + 默认 variant → 升级 `AlertDialog` + `variant="destructive"`。
- 🆕 建议：不增加「测试连接」「复制连接信息」（低频，克制）。

**导航树对象（2495–2528）**
- ✅ 打开数据、设计表/视图、对象查看器、复制名称、生成 DDL、刷新、新建表、Drop（dry-run 确认）合理，保留。
- ⚠️ 问题 1：Drop 无 `variant="destructive"`，且与"刷新/新建表"混排 → 独立危险组放底部。
- ⚠️ 问题 2：`materializedView` 的禁用设计视图项用 `disabled title` 是**好实践**，保留并沿用（disabled 时悬停出原因提示）。
- 🆕 **补「生成 SQL ▸」（SELECT/INSERT/UPDATE/DELETE）**：竞品三家标配、审计 P1 第 4 条，且复用现有 `quoteQualifiedPostgresName`/引用模型，成本低收益高。
- 🆕 复制名称文案统一为「复制限定名」，避免与"复制列名"混淆。

**查询编辑器（2639–2756）**
- ✅ 撤销/重做、剪切/粘贴/全选、运行、运行选择、格式化、保存到记事本（来源副文本设计优秀，保留）。
- ⚠️ 问题 1：缺 EXPLAIN、注释/取消注释（两者均有快捷键实现但无菜单入口）→ 补齐。
- ⚠️ 问题 2：「复制」孤悬末位 → 移入编辑组。
- ⚠️ 问题 3：无「保存 SQL」入口 → 补齐（工具栏已有 `postgres-save-sql`）。
- 🆕 运行选择快捷键标注统一为 `Ctrl+Shift+Enter`（消除与 `Ctrl+E`/`Ctrl+Shift+R` 的混乱，见 §3.1）。

**数据网格单元格（2898–2941）**
- ✅ 复制单元格/行/列名、按字段值筛选、自定义筛选、设 NULL、设空串、生成 UUID、删除记录（PK 置灰正确）、导出 CSV/Excel 合理，保留。
- 🆕 **补「设为 DEFAULT」**：DataGrip 单元格面板标配（`Ctrl+Alt+D`），与 NULL 并列是"改数据"场景最高频语义操作。
- 🆕 **补「生成 INSERT/UPDATE/DELETE SQL ▸」**：审计 P2 第 9 条（结果集→INSERT），DBeaver/HeidiSQL 均有，联动价值最高。
- ⚠️ 问题 1：导出 CSV/Excel 出现在单元格菜单语义不纯，但作为兜底保留（无独立导出入口），未来结果面板 header 加导出按钮后移除。
- ⚠️ 问题 2：insert 行菜单与数据行菜单混用一个 renderer，条件分支混乱 → 按 §1.2.6 规范独立分组。
- ⚠️ 问题 3：设空串/生成 UUID 对 PK 置灰逻辑正确，但**缺 `canSetNull` 类的可空性检查文案**——置灰工具提示建议加 `title` 说明原因（对齐 materializedView 先例）。

**结论**：现有菜单骨架健康（已覆盖竞品 80% 高频动作），主要缺口 = 生成 SQL 联动、设为 DEFAULT、EXPLAIN/注释入口、勾选项组件化、危险分组与确认。MySQL/SQLite 按本规范 1.2 全套补齐（复用 DatabaseNavigator/DatabaseResultPane 的 render 接口）。

---

## 2. 错误信息呈现规范

### 2.1 三级呈现模型

| 级别 | 呈现 | 对应错误类型 | 位置 | 持久性 |
|---|---|---|---|---|
| L1 | 编辑器内联定位 | 语法/执行错误（可映射到 SQL 行） | 查询编辑器 | 随执行结果刷新 |
| L2 | 结果面板错误区 | SQL 执行/解释失败 | 结果面板（替代现有 message 区） | 持久，切换 tab 不丢 |
| L3 | 连接级错误横幅 | 连接失败/断线 | 工作区顶部（toolbar 下方） | 常驻直到重连 |

**L1 + L2 必须成对出现**：执行失败时编辑器打错误标记（L1），结果面板显示可操作错误卡（L2）；两者用同一错误对象关联（见 §2.2.1 数据流）。

### 2.2 视觉规格

#### 2.2.1 L1 编辑器内联（错误定位）

- **数据源**：Rust 端 `postgres.rs:828` 目前 `format!("PostgreSQL query failed: {error}")` 透传 Display。规范要求 Rust 端对 DbError 结构化输出：`{ severity, code, message, detail, hint, position, line }`（tokio-postgres `as_db_error()` 可直接取到），并含 `LINE n` 文本。MySQL 同理取 `MySqlError` 的 `code + message`；SQLite 透传字符串（无结构化）。
- **编辑器标记**：CodeMirror 用 `@codemirror/lint` 的 `lintGutter()` + `setDiagnostics`，或自绘 `Decoration`：
  - gutter 标记：错误行左侧 `▸`/`✖` 红色标记（`lint-gutter` 默认样式，前景 `--destructive`）；
  - 行内标记：错误行整行底部红色波浪下划线（`text-decoration: underline wavy`，色 `var(--destructive)`）。
- **行号换算**：Rust 端返回的 `position`（字符偏移）由前端用 `EditorState.doc.lineAt(pos)` 换算成编辑器行号；`LINE n`（服务端相对语句的伪行号）配合现有 `currentStatementAt`（`sql-statement-tokenizer.ts:159-168`）换算成编辑器绝对行号。
- **交互**：
  - 执行失败后自动 `scrollIntoView` 出错行 + 临时高亮（`temporaryHighlight` Decoration，2s 渐隐）；
  - 错误卡点击「定位」→ 再次滚动并高亮；
  - 错误标记在**下一次成功执行或编辑文档**时清除（`EditorView.updateListener` 里 docChanged 即清）。

线框（§5.3）。

#### 2.2.2 L2 结果面板错误区

- **数据模型**：`DatabaseResult`（`src/lib/database/result-types.ts`）新增 `kind: "error"` 分支：
  ```ts
  interface DatabaseErrorResult {
    kind: "error";
    /** 展示标题，如 "查询失败" */
    title: string;
    /** 服务端错误码，如 "42P01" / "1064"（可空） */
    code?: string;
    /** 一句话摘要（Display 第一行） */
    message: string;
    /** 服务端详情（detail/hint/完整原文），可折叠 */
    detail?: string;
    /** 可定位的编辑器行号（1-based，可空） */
    editorLine?: number;
    /** 重试句柄：是否可重试（未连接时 false） */
    retryable: boolean;
  }
  ```
- **视觉结构**（复用现有面板：顶部 `h-7` header + 内容区）：
  - header 保持现状，内容区替换为错误卡；
  - 错误卡：`m-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 shadow-soft-lg`；
  - 第一行：`CircleAlert`（`size-4 text-destructive`）+ 标题 `text-[12px] font-medium text-foreground`；
  - 错误码行：`text-[12px] font-mono text-foreground`，格式 `CODE: message`（如 `42P01: relation "users" does not exist`）；无 code 时只显示 message；
  - 引导行（suggestion，`StructuredQueryError.suggestion` 非空时显示）：`mt-1 flex items-center gap-1 text-[11px] text-muted-foreground`，前缀 `Lightbulb size-3.5 text-warning`，单行截断；错误码不在知识库时不显示此空行（对齐 product-spec F2-能力4 验收）；
  - 服务端详情：`Collapsible`（已有组件）折叠，展开后 `whitespace-pre-wrap text-[12px] font-mono text-muted-foreground` 显示完整原文（`rawMessage`，含服务端 `LINE n`/光标列）；
  - 操作按钮行（`mt-2 flex gap-2`，`Button size="sm" variant="outline" h-6 rounded-sm px-2 text-[11px]`）：
    - `重试`（`RotateCw`，`retryable` 为 false 时 disabled，label 建议复用现有「运行」）；
    - `复制错误`（`Copy`）；
    - `定位到编辑器`（`Crosshair`，`editorLine` 为空时隐藏）；
  - 全卡 `select-text`（错误文本可选中复制，选中色用全局 `::selection` = `--terminal-selection`）。
- **选中/焦点态**：
  - 错误卡非交互容器，不设 tabIndex；交互元素只有三个按钮与详情折叠触发器，均走全局 `:focus-visible`（`outline: 2px solid var(--ring)`）；
  - 详情折叠触发器：默认 `text-[11px] text-muted-foreground hover:text-foreground`，展开态 `ChevronRight` 旋转 90°；展开后内容区 `max-h-40 overflow-auto`（长详情可滚动不被截断，对齐 F2-能力2"可滚动/可全选"）；
  - 键盘可达：按钮/折叠均可 `Tab` 聚焦、`Enter`/`Space` 触发，`Esc` 收起详情折叠（如已展开）。
- **toast 双写裁定**（对齐 product-spec F2 裁定 3）：执行失败时**保留轻量 toast**，但：
  - toast 正文只显示 `message`（精炼摘要，≤2 行），**禁止**承载 `rawMessage` 原始全文——原始错误只出现在结果面板错误区；
  - 应用场景：结果面板不可见时的兜底提示（如记事本「快速执行」、后台命令）；结果面板可见时 toast 仅作冗余提醒，自动 4s 消失，信息不依赖它；
  - 结果面板错误区是**唯一**的完整错误呈现点，切换 Tab 不丢（`kind:"error"` 随 tab 状态持久）。
- **错误区右键**：见 §1.2.9。

线框（§5.4）。

#### 2.2.3 L3 连接级错误横幅

- **位置**：`DatabaseWorkspaceShell` 的 toolbar 正下方、内容区之上，全宽横条，`h-9`。
- **视觉**：`flex h-9 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 text-[12px]`；图标 `CircleAlert size-4 text-destructive`；文本 `text-foreground`（如"数据库已断开连接"）；右端动作按钮 `Button variant="outline" size="sm" h-6 rounded-sm px-2 text-[11px]`（"重新连接"，点击 `connectEstablished`）。
- **行为**：
  - 断线（连接失败、运行中报 `Connection closed`、host-key 变更）时出现；重连成功即消失（**fade-in 0.2s**）；
  - 非模态、不打断输入，仅横条提示；
  - host-key 变更场景沿用现有 toast action（"重新信任"），横幅文本提示"主机密钥已变更"。
- **常驻原则**：横幅 = 需要动作的连接错误，**不复用 toast**（toast 4s 自动消失会丢信息）。

线框（§5.5）。

### 2.3 toast 与内联的分工原则

| 场景 | 用 toast | 用内联（L1/L2/L3） |
|---|---|---|
| 连接成功、SQL 已保存、导出完成 | ✅ `toast.success` | |
| 瞬时非关键失败（保存记事本失败、视图保存失败） | ✅ `toast.error`（带 description） | |
| SQL 执行/解释失败 | ❌ 不再用 toast | ✅ 结果面板错误区 + 编辑器标记 |
| 连接失败/断线 | ❌ | ✅ 顶部横幅（host-key 场景保留 toast action 作为补充） |
| 危险操作确认 | 不用 | ✅ `AlertDialog` |

规则一句话：**toast = 瞬时、无需动作、不丢失也无妨；内联 = 需要动作（重试/复制/定位/重连）、必须持久**。现有 `execute()` 里 `toast.error(queryFailed)`（983–991）是本迭代必改点。

### 2.4 错误文案规范（模板）

- **标题**：`<动作>失败`，动词开头 4–6 字（查询失败 / 解释失败 / 连接失败 / 保存失败）。
- **摘要（message）**：`错误码: 一句话服务端原因`；错误码用等宽字（`font-mono`）；无码则直接一句话。
- **详情（detail）**：服务端原文 + `LINE n` + 光标列位置，`font-mono` 原样保留，**不翻译不润色**（排查时原文最可信）。
- **动作按钮文案**：动词（重试 / 重新连接 / 复制错误 / 定位到编辑器），不用"确定/OK"。
- **引导性文案（可选）**：常见错误码（MySQL 1045/1130/2003/2059、PG 认证/权限）在详情折叠区底部加一行 `text-[11px] text-muted-foreground`："常见原因：权限不足 · 请检查用户与主机授权"——静态映射表，不进知识库系统。

---

## 3. 快捷键呈现规范

### 3.1 快捷键体系决策（对齐竞品 + 现状收敛）

现状冲突（审计 §3）：`bindings.ts` 为 Navicat 风格（`Ctrl+Shift+R`/`Ctrl+E` 执行、`Ctrl+R` 筛选/刷新、`F5` 刷新），手写 keydown（2087–2208）为 VS Code 风格（`Ctrl+Enter` 执行、`Ctrl+Shift+F` 格式化、`Ctrl+/` 注释）。**两者并存且互相打架**。

本迭代快捷键基准（主表，供菜单标注与速查表共用）：

| 命令 | 快捷键 | scope | 说明 |
|---|---|---|---|
| 运行 / 运行选择 | `Ctrl+Enter` | QUERY_EDITOR | 对齐 DBeaver/Beekeeper/VS Code 心智（竞品分析 C1） |
| 解释执行计划 | `Ctrl+Shift+E` | QUERY_EDITOR | 对齐 DBeaver |
| 格式化 SQL | `Ctrl+Shift+F` | QUERY_EDITOR | 对齐 DBeaver/Beekeeper |
| 注释 / 取消注释 | `Ctrl+/` | QUERY_EDITOR | 全行业默认 |
| 保存 SQL | `Ctrl+S` | QUERY_EDITOR | 现已有 |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Shift+Z` | QUERY_EDITOR | CodeMirror 默认 |
| 复制单元格 | `Ctrl+C` | DATA_GRID | |
| 复制行 | `Ctrl+Shift+C` | DATA_GRID | |
| 添加记录 | `Insert` | DATA_GRID | 现有 |
| 删除记录 | `Ctrl+Delete` | DATA_GRID | bindings 已定义 |
| 筛选与排序 | `Ctrl+R` | DATA_GRID | bindings 已定义；**与 data.refresh 的 Ctrl+R 冲突，refresh 改 F5** |
| 刷新导航树 | `F5` | NAVIGATOR | bindings 已定义；VS Code 用户直觉 |
| 新建查询 | `Ctrl+N` | DATABASE_WORKSPACE | 现有；**终端保留该键，scope 路由保证不抢** |
| 关闭 Tab | `Ctrl+W` | DATABASE_WORKSPACE | 现有 |
| 查找（网格） | `Ctrl+F` / `F3` / `Esc` | DATA_GRID | 现有 |

- **菜单标注一致性**：所有菜单项标注的快捷键必须来自上表；上表之外的旧绑定（`Ctrl+E`、`Ctrl+Shift+R`、`Ctrl+Shift+Enter`）**从菜单标注中移除**（可保留代码兼容但不再示人）。
- 实现层仍建议收敛到 B20 `scope-router`（审计 P0 第 3 条），但本规范只约束**呈现层一致性**，路由实现由 feature-designer 决定。

### 3.2 菜单快捷键标注视觉规格

- 组件：`ContextMenuShortcut`（自带 `text-muted-foreground ml-auto text-xs tracking-widest`）。
- 平台符号：macOS `⌘⇧E` / Windows `Ctrl+Shift+E`，统一由工具函数生成（`formatShortcut(combo, platform)`，combo 来源 = `command-registry.ts` 的 `defaultBinding`）。
- 禁止项：
  - 不标注未实现的快捷键；
  - 不标注同一 combo 在多个 scope 有歧义的键（如编辑器的 `Ctrl+C` 与网格的 `Ctrl+C` 分属不同菜单，各自 scope 内标注没问题，但**不得**跨 scope 混标）；
  - 危险组（Drop/删除）不标注快捷键。

### 3.3 快捷键冲突提示样式

冲突来源两类：
1. **绑定内冲突**：同一 combo 映射到多个命令（现有真实案例：`Ctrl+R` 同时绑 `database.data.filterSort` 与 `database.data.refresh`；`F5` 同时绑 object.refresh 与 connection.refresh——后者的 scope 一致时需合并）；
2. **保留键冲突**：与 `TERMINAL_RESERVED_COMBOS`（`bindings.ts:117-137`）交叠。

冲突呈现（速查表与未来设置面板通用）：
- 冲突项行背景 `bg-warning/10` + 行首 `TriangleAlert size-3.5 text-warning`；
- 冲突说明一行 `text-[11px] text-warning`："与 <其他命令名> 冲突" / "终端保留键，未生效"；
- 冲突优先级：scope 高者生效（scope-router 规则），速查表用"（生效）"标注生效者。

### 3.4 快捷键速查表（Help / 设置内）

**信息架构**（新增 Help 菜单项「键盘快捷键参考」或设置页签）：
```
┌──────────────────────────────────────────────┐
│ 快捷键参考                        [搜索框____] │
│ ┌ 查询编辑器 ──────────────────────────────┐  │
│ │ 运行 / 运行选择        Ctrl+Enter        │  │
│ │ 解释执行计划           Ctrl+Shift+E      │  │
│ │ …                                       │  │
│ └──────────────────────────────────────────┘  │
│ ┌ 数据网格 ──────────────────────────────┐   │
│ │ 复制单元格             Ctrl+C           │   │
│ │ 筛选与排序             Ctrl+R   ⚠ 冲突   │  │
│ └──────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```
- 按 scope 分组（查询编辑器 / 数据网格 / 导航器 / 工作区），组间 `border-b`，行高 `h-7`，快捷键右对齐 `text-muted-foreground`，等宽显示。
- 顶部搜索框过滤动作名；空结果显示空态。
- 数据源：`NAVICAT_BINDINGS + command-registry.defaultBinding` 合并去重后展示，**单一来源**，杜绝手抄。
- 冲突项按 §3.3 呈现。

### 3.5 降级方案（本迭代不做可视化自定义）

明确声明：**本迭代不做"设置面板重绑快捷键"**（需要表单 + 持久化 + 冲突校验，成本高）。降级方案：
1. **菜单标注 + 静态速查表**（§3.2/§3.4）双通道，覆盖"发现快捷键"这一最高频需求；
2. 快捷键绑定仍由代码（bindings + keydown）决定，速查表与菜单标注保持一致即可；
3. 冲突检测只做**只读呈现**（§3.3），不做交互式改键；
4. 为未来设置面板预留数据契约：所有命令的 label + defaultBinding 集中在 command-registry，速查表直接消费，届时仅需加一个可写表单。

---

## 4. 状态与联动视觉

### 4.1 导航树节点状态

- 现有状态点（`statusDotClass`）保留：connected `bg-emerald-500` / connecting `bg-amber-400 animate-pulse` / error `bg-red-500` / disconnected `bg-muted-foreground/50`。
- **生成 SQL / 生成 DDL 后反馈**：
  - 成功：`toast.success("已生成并插入编辑器")` + 新查询 tab 打开 + 光标插入语句首字符 + **语句整体高亮 2s 渐隐**（见 §4.4）；
  - 失败：结果面板错误区（L2）或 toast（瞬时），二者择一按 §2.3。
- 加载子节点失败：沿用 `errorLabel` 内联 `text-destructive text-[11px]`，**补一个"重试"行内按钮**（`text-[11px] text-primary`，点击重载该分组）。
- Drop 进行中：节点行 `opacity-60 pointer-events-none`，完成后自动刷新父分组。

### 4.2 结果面板四态视觉

| 状态 | 触发 | 视觉 |
|---|---|---|
| 执行中 | `running === true` | header 右侧 `Loader2 size-3.5 animate-spin text-muted-foreground` + 文案「执行中…」；网格区保持旧结果并叠加 `opacity-60 pointer-events-none` 遮罩（防误点）；停止按钮 `Square` 可点 |
| 成功（tabular） | `result.kind === "tabular"` | 正常网格；header 显示 `N 行 · 用时`（`text-muted-foreground`） |
| 成功（command/empty） | `kind === "command"` / `"empty"` | header 显示 commandTags；空态区：居中图标 + `labels.ready`（升级为 `flex h-24 items-center justify-center gap-2 text-muted-foreground` + `Inbox` 图标，右键见 §1.2.9） |
| 错误 | `kind === "error"` | §2.2.2 错误卡 |

- 四态转换动画统一 `fade-in 0.2s`；执行中不销毁旧结果（视觉连续性）。

### 4.3 查询历史记录项交互态（DB 域）

- 行 hover：`hover:bg-accent/60` + 右侧浮现操作按钮（沿用 `tool-command-history.tsx:156` 的 `opacity-0 group-hover:opacity-100` 模式）：`再次执行`（Play）、`复制`（Copy）；
- 右键：§1.2.12 菜单；
- 键盘：`↑/↓` 在列表间移动，`Enter` 再次执行（焦点在列表内时）；
- 选中执行态：行 `bg-primary/10`，执行失败时行尾 `TriangleAlert size-3.5 text-destructive`（可点击查看错误卡）。

### 4.4 联动链路可发现性

| 联动 | 可发现性设计 |
|---|---|
| 对象树 → 生成 SQL/DDL → 编辑器 | 新 tab 激活 + 光标插入 + **语句 2s 高亮**（CodeMirror `Decoration`，`bg-primary/10` 或 `bg-yellow-200/40`，复用网格 find 高亮色） |
| 网格行 → 生成 INSERT/UPDATE → 编辑器 | 同上；失败 toast 提示"未找到主键" |
| 保存到记事本 | toast.success 带 action「查看」→ 打开记事本工具并滚动到该条 |
| 错误 → 编辑器定位 | §2.2.1（滚动 + 波浪线 + 临时高亮） |
| DDL 预览 → 编辑器 | 现有「在编辑器中打开」保留，落地后同样加 2s 高亮 |
| 历史 → 编辑器插入 | 插入后光标置于插入文本尾部 |

高亮 Decoration 统一封装一个 `flashEditorRange(view, from, to)` 工具：`bg-primary/10` 覆盖 + 2s 后移除（`temporaryHighlight` 或定时 dispatch 清理）。

### 4.5 查询历史面板视觉（DB 域，对齐 product-spec F5 / 联动 L5-L6）

> 数据模型契约（product-spec F5 裁定 1）：`{ id, connectionId, providerId, sql, executedAt, status: "success"|"error", elapsedMs? }`，localStorage 按 `connectionId` 隔离，每连接上限 200 条。**历史不存错误详情**——错误徽标仅表达"该条执行失败"，点击不跳错误详情（详情在 F2 结果面板错误区，执行当刻可见）。

**入口与打开方式**
- 查询 Tab 工具栏加 `ToolButton`「历史」（`History` 图标，label 复用 `toolbox.<provider>.history`），位置在「保存到记事本」之后、「停止」按钮之前（tool-postgres.tsx:2558-2606 工具栏现有序列）。
- 点击在结果面板区域**切换视图**：结果视图 ↔ 历史视图（VS Code panel 心智，不引入浮层/对话框）。再次点击或历史视图内「×」/ `Esc` 返回结果视图。
- 打开/关闭切换加 `fade-in 0.2s`。

**面板结构**（复用结果面板视觉语言）：
```
┌ 历史 · <连接名> ────────────── (h-7 header，同结果面板 header)
│ [搜索…]        [清空本连接历史]      (右侧动作)
├───────────────────────────────────────────
│ [✓] 21:30:12   SELECT * FROM "public"."users" LIMIT 100;   (2.3s)  [▶]
│ [⚠] 21:31:02   UPDATE "orders" SET status='x' WHERE id=1;  [⋯]
│ ...
│ 空态: 居中 Inbox 图标 + 「暂无查询历史」+ 副文案
```

**条目形态**（每行 `flex h-7 items-center gap-2 rounded-sm px-2 text-[12px]`）：
- 状态徽标（最左，12px 宽，对齐 `statusDotClass` 色板）：
  - 成功：`size-2 rounded-full bg-emerald-500`；
  - 错误：`size-2 rounded-full bg-red-500`（悬停 `title` =「执行失败」）。
- 时间：`w-16 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums`（`executedAt` 的 HH:mm:ss，跨日显示 `MM-DD HH:mm`）。
- SQL 摘要：`flex-1 min-w-0 truncate font-mono`；摘要规则=首个非空行，截断超 96 字符加 `…`；悬停 `title` 显示完整 SQL（多行保留换行）。
- 耗时（可选，成功条目标尾）：`shrink-0 text-[10px] text-muted-foreground tabular-nums`，格式 `(1.2s)`，`elapsedMs < 500` 时不显示。
- hover 浮现操作（沿用 `tool-command-history.tsx:156` 模式）：`▶ 再次执行`（Play，`opacity-0 group-hover:opacity-100`）+ `⋯` 不设——右键已覆盖其余动作，**只保留一个再次执行按钮**，避免行内按钮过载。

**交互态**
- hover：`hover:bg-accent/60`；键盘选中（↑/↓）：`bg-primary/10 text-primary`；执行中（再次执行后）：行尾 `Loader2 size-3 animate-spin`；
- 再次执行失败：行尾 `TriangleAlert size-3.5 text-destructive`（仅当次刷新，不持久写入条目标态）；
- 键盘：焦点在列表内时 `↑/↓` 移动、`Enter` 再次执行、`Esc` 关闭面板；
- 右键菜单：§1.2.12 清单（再次执行 / 插入编辑器 / 复制 / 删除本条 / 清空本连接）。

**空态与筛选**
- 空态：`flex h-24 items-center justify-center gap-2 text-muted-foreground` + `Inbox size-5` + 「暂无查询历史」+ 副文案（text-[11px]）「执行过的 SQL 会出现在这里」；
- 顶部搜索框（可选，MVP 可不做）：`Input h-6 w-40 text-[12px]`，过滤 SQL 摘要；空结果显示空态变体「无匹配记录」。

线框（§5.7）。

---

## 5. 关键 spec 线框（ASCII）

### 5.1 查询编辑器右键菜单（§1.2.5）

```
┌───────────────────────────────────┐
│  ↩ 撤销                Ctrl+Z     │   ← 编辑组
│  ↪ 重做              Ctrl+Shift+Z │
│ ───────────────────────────────── │
│  ✂ 剪切                Ctrl+X     │
│  ⧉ 复制                Ctrl+C     │
│  📋 粘贴               Ctrl+V     │
│  ☑ 全选                Ctrl+A     │
│ ───────────────────────────────── │
│  ▶ 运行              Ctrl+Enter   │   ← 执行组
│  + 运行选择      Ctrl+Shift+Enter │
│  📈 解释执行计划     Ctrl+Shift+E  │
│  ✨ 格式化 SQL       Ctrl+Shift+F  │
│  # 注释/取消注释         Ctrl+/    │
│ ───────────────────────────────── │
│  ⧉ 保存到记事本                    │   ← 保存组
│     └ 来源: 当前语句 (4 行)        │
│  💾 保存 SQL             Ctrl+S    │
└───────────────────────────────────┘
```

### 5.2 数据网格单元格右键菜单（§1.2.6）

```
┌───────────────────────────────────┐
│  ⧉ 复制单元格           Ctrl+C     │
│  ✓ 复制行            Ctrl+Shift+C │
│  ⧉ 复制列名                        │
│  { } 生成 SQL ▸                    │   ← 子菜单
│      ├ 生成 INSERT 语句             │
│      ├ 生成 UPDATE 语句(按主键)      │
│      └ 生成 DELETE 语句(按主键)      │
│ ───────────────────────────────── │
│  ⛨ 按字段值筛选                     │   ← 仅 table tab
│  ⛨ 自定义筛选                      │
│ ───────────────────────────────── │
│  ⌫ 设为 NULL               (灰)    │   ← 仅可编辑
│  ⟲ 设为 DEFAULT             (灰)    │
│  ⬜ 设为空字符串            (灰)     │
│  ⬚ 生成 UUID                (灰)    │
│  🗑 删除记录          Ctrl+Delete   │
│ ───────────────────────────────── │
│  ↓ 导出 CSV                        │
│  ⬇ 导出 Excel                      │
└───────────────────────────────────┘
```

### 5.3 编辑器错误行内联定位（L1，§2.2.1）

```
  12  SELECT *
  13  FROM users u
  14  WHERE u.age = 'abc' ~~~~~~~      ← 红色波浪线
   ▲  (gutter 红色 ✖ 标记, 聚焦后滚动+高亮)
  15  ORDER BY u.id;
```

### 5.4 结果面板错误区（L2，§2.2.2）

```
┌ 结果 ────────────────────────────────────────┐
│ ⚠ 查询失败                                    │
│ 42P01: relation "users" does not exist        │  ← font-mono
│ ▸ 服务端详情 (Collapsible)                     │
│   ERROR: relation "users" does not exist       │
│   LINE 3: FROM users;                          │
│   HINT: Perhaps you meant...                   │
│ ───────────────────────────────────────────── │
│ [⟲ 重试]  [⧉ 复制错误]  [⌖ 定位到编辑器]        │  ← 按钮行
└───────────────────────────────────────────────┘
```

### 5.5 连接级错误横幅（L3，§2.2.3）

```
┌─ toolbar ──────────────────────────────────────┐
│ ⚠ 数据库已断开连接                 [🔄 重新连接] │  ← h-9 常驻横幅
├─ 内容区 ───────────────────────────────────────┤
│                                                │
```

### 5.6 快捷键速查表（§3.4）

```
┌ 快捷键参考 ────────────────────────────────────┐
│ [搜索…                        ]                │
│ ┌ 查询编辑器 ────────────────────────────────┐ │
│ │ 运行 / 运行选择         Ctrl+Enter         │ │
│ │ 解释执行计划            Ctrl+Shift+E       │ │
│ │ 注释 / 取消注释           Ctrl+/           │ │
│ └────────────────────────────────────────────┘ │
│ ┌ 数据网格 ──────────────────────────────────┐ │
│ │ ⚠ 筛选与排序      Ctrl+R 与"刷新"冲突       │ │  ← 冲突标注
│ │ 添加记录                 Insert            │ │
│ └────────────────────────────────────────────┘ │
└────────────────────────────────────────────────┘
```

### 5.7 查询历史面板（§4.5）

```
┌ 历史 · localhost:5432 ────────────────────────┐
│ 21:30:12  [✓] SELECT * FROM "public"."users"  │  ← h-7 条目
│                 LIMIT 100;                    │
│ 21:31:02  [⚠] UPDATE "orders" SET status='x'  │  ← hover 浮现 ▶
│                 WHERE id = 1;          (1.2s) │
│ ───────────────────────────────────────────── │
│                    🗂 暂无查询历史              │  ← 空态
│                   执行过的 SQL 会出现在这里     │
└───────────────────────────────────────────────┘
```

---

## 附录 A：实现落地清单（按优先级）

| # | 项 | 位置/契约 |
|---|---|---|
| A1 | `DatabaseResult` 增加 `error` kind + `StructuredQueryError` | `src/lib/database/result-types.ts` |
| A2 | 执行失败 → L1+L2 成对呈现；toast 降级为轻量摘要（≤2 行 message，不带 rawMessage） | `tool-postgres.tsx:983-991` 等三端 |
| A3 | Rust 端 DbError/MySqlError 结构化（severity/code/message/detail/hint/position） | `src-tauri/src/postgres.rs:828`、mysql.rs |
| A4 | PG 菜单重构（分组 + 图标 + 快捷键 + destructive + CheckboxItem） | `tool-postgres.tsx:2427-2530, 2639-2965` |
| A5 | 新增菜单：生成 SQL ▸（**树级** SELECT/INSERT/UPDATE，对齐 F4 MVP；行级 DML 延后）、设为 DEFAULT、EXPLAIN、注释、保存 SQL | 同上 |
| A6 | MySQL/SQLite 三件套补齐（复用导航器/结果面板 render 接口） | `tool-mysql.tsx`、`tool-sqlite.tsx` |
| A7 | 表设计器/对象查看器右键 | `table-designer-tab.tsx`、`object-viewer-tab.tsx` |
| A8 | 连接错误横幅 + 重连 | `DatabaseWorkspaceShell` / 各 tool |
| A9 | 快捷键速查表 + 冲突只读呈现 + `formatShortcut` 工具 | 新增页面 + `src/lib/keyboard/` |
| A10 | `flashEditorRange` / 错误定位 Decoration 工具 | `src/lib/database/` |
| A11 | 查询历史面板（入口按钮 + 列表视图 + 状态徽标 + 右键菜单 + 空态，对齐 §4.5） | `query-history-panel.tsx`（新增）+ 三端工具栏 |

## 附录 B：本规范明确不做（防蔓延）

- 可视化快捷键自定义（§3.5 降级方案）；
- 命令面板（Cmd+K）——属于全局功能，另行立项；
- 错误码知识库系统（仅静态映射提示，§2.4）；
- Safe mode / 只读生产库防护开关（连接配置域，另行设计）；
- AI/BI/ER 相关一切联动。
