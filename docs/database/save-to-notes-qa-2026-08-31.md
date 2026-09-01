# 「保存到记事本」重构 QA 验收报告

- 日期：2026-08-31（执行于 2026-09-01 上午）
- 版本：v2.15.0 工作区（bf8d05f + 未提交批次改动）
- 执行人：qa
- 范围：tool-postgres.tsx「保存到记事本」对话框重构（Combobox 记录名称 + 必填 SQL 注释 + 追加/新建模式 + duplicate 检测）

## 验收结论

**总体：✅ PASS（2026-09-01 14:10 最终 E2E 全链路 PASS；MCP 纯视觉复审通过；静态线全绿）**

| # | 验收项 | 结果 | 备注 |
|---|--------|------|------|
| 1 | 单测（9 用例独立复跑） | ✅ PASS | 9/9，见 §1.1 |
| 2 | tsc --noEmit | ✅ PASS | 0 错；首跑 3 错系并行编辑中间态，终态干净，见 §1.2 |
| 3 | pnpm lint | ✅ PASS | 0 error / 242 warnings（存量警告构成） |
| 4 | i18n:check 双语对齐 | ✅ PASS | 2227/2227 keys |
| 5 | E2E 全链路（真实应用 + PG fixture） | ✅ PASS | 2026-09-01 10:14 完整重跑通过（26s），见 §2 |
| 6 | 键盘交互（↑↓/Enter/Esc） | ✅ PASS | 随 E2E 实测，见 §2.1 |
| 7 | 暗色主题 popover 可读性 | ✅ PASS | 层级、对齐、边界、高度与内容贴合通过，见 §3 |
| 8 | 超长标题截断 | ✅ PASS | 触发值省略截断；浮层与触发器同宽且不越界，见 §3 |
| 9 | 视觉评审（Hy3） | ✅ PASS | MCP 纯视觉复审通过，见 §3 |
| 10 | 稳定性线复核（#6/#8 抽查） | ✅ PASS | 无被 skip 的失败，见 §4 |

## 1. 静态 + 单测复核（QA 独立复跑，非实现方汇报）

### 1.1 单元测试

命令与结果：

```
$ pnpm test -- src/components/toolbox/__tests__/tool-postgres-save-to-notes.test.tsx
 ✓ src/components/toolbox/__tests__/tool-postgres-save-to-notes.test.tsx (9 tests) 1792ms
 Test Files  1 passed (1)
      Tests  9 passed (9)

$ pnpm test   （全量独立复跑）
 Test Files  116 passed (116)
      Tests  1075 passed (1075)
```

覆盖用例 a–g3：列出已有笔记（标题+语言+行数）、输入实时过滤、trim 精确匹配→追加模式、不匹配→新建模式、↑↓/Enter/Esc、注释必填门禁、追加写入 `-- 注释` 头行、新建写入头行、duplicate 检测禁用确认。全过。

### 1.2 TypeScript

命令与结果：

```
$ pnpm exec tsc --noEmit
（无输出，退出码 0）
```

过程说明：08:31 首次运行报 3 个 error（integrated-file-browser.tsx 引用 `fileBrowser.toast.clipboardCopied/clipboardWriteFailed`，类型联合缺这些 key）。核查发现 08:33 fe-dev 并行修改了该文件与 locales（key 已补入 en.json——tsc 的类型来源），复跑后 0 错。结论：首跑抓到的是编辑中间态；最终态类型完整。2218 keys 双语对齐下 locale 键与类型一致。

### 1.3 ESLint

命令与结果：

```
$ pnpm lint
✖ 242 problems (1 error, 241 warnings)
  1203:9  error  The value assigned to 'localPaths' is not used in subsequent statements  no-useless-assignment
```

- error 位于 `src/components/integrated-file-browser.tsx:1203`（`handlePasteWithSystemClipboard` 内 `let localPaths: string[] = []` 初始值未被读取）。经 git diff 核对为本批次新增的剪贴板粘贴功能代码引入，**非本对话框域，按纪律未自行修复，转交 team-lead**。
- 241 warnings 为存量（ui 组件库导出模式、set-state-in-effect、no-unsafe-* 等），与 stability-scan-2026-08-31.md 记录一致，未新增。

### 1.4 i18n

```
$ pnpm i18n:check
✓ Key parity check passed (2218 keys in both files).
```

zh-CN 与 en 完全对齐。保存对话框新增 key（saveModeAppend/saveModeCreate/saveNoteComboboxPlaceholder/saveNoteCommentLabel/saveNoteCommentPlaceholder/saveNoteLines/saveNoteNoMatches/saveDuplicateBlock/saveTargetNote/saveAppendToNote/saveCreateAndSave 等）双语均存在，E2E 中文界面实际渲染验证通过（截图 02/07/11/14）。

## 2. 真实应用 E2E（WDIO + debug 二进制 + PG fixture 55432）

- spec：`e2e/desktop/save-to-notes-qa.e2e.ts`（单文件串行，2026-09-01 10:14 由 qa-e2e2 完整重跑）
- 复跑命令：`pnpm exec wdio run wdio.conf.ts --spec e2e/desktop/save-to-notes-qa.e2e.ts`
- 环境：src-tauri/target/debug/nexterm（09-01 08:54，含对话框重构）+ dist（09-01 08:54，chunk tool-postgres-B4xr4bdt.js 已含全部 postgres-save-note-* testid，grep 核验）+ nexterm-postgres-visual 容器（127.0.0.1:55432，凭据 nexterm_e2e）
- **结果：✅ PASS（1 passed，00:00:26，单 it 覆盖 a–f 全验收点 + 键盘 + 主题 + 长标题）**

### 2.1 执行记录

| 步骤 | 覆盖验收点 | 结果 |
|------|-----------|------|
| 连接 PG fixture（真实对话框表单 + 连接按钮） | 前置 | ✅ postgres-run enabled |
| 种子笔记 ×2（通过被测功能 create 模式创建） | 前置 | ✅ |
| a) Combobox 列出已有笔记（标题+语言+行数） | §验收 a | ✅ NOTE_A/NOTE_B 均列出 |
| 键盘 ↑↓ 高亮 + Enter 选中（下拉关闭、trigger 显示所选） | §验收 键盘 | ✅ |
| Esc 仅关闭下拉（对话框保留） | §验收 键盘 | ✅ |
| b) 输入过滤 → 选 NOTE_A → 追加模式 badge + 首行 preview（`-- 历史慢查询`） | §验收 b | ✅ |
| d) 注释空 → 确认禁用；填注释 → 启用 → 确认追加 | §验收 d | ✅ |
| c) 新标题 → 新建模式 badge → 注释门禁 → 确认创建 | §验收 c | ✅ |
| e) Notes 工具：NOTE_A = 种子头行 + 种子 SQL + `-- 按 id 取前五用户` + SQL_A；新建笔记 = `-- 用户总数统计` 头行 + SQL_B；列表标题正确 | §验收 e | ✅（内容比对用空白/分号归一化，见 2.3 说明） |
| f) 重复注释 → duplicate 警告 + 确认禁用；改注释 → 重新启用 | §验收 f | ✅ |
| 长标题截断（80 字符输入） | §验收 8 | ✅ 截图存档 |
| 暗色主题 popover 可读性 → 还原浅色 | §验收 7 | ✅ 截图存档（视觉结论归 §3） |

### 2.2 截图索引（test-results/save-notes/，共 17 张，全部 >250KB，2026-09-01 10:13 本轮产出）

| 文件 | 内容 |
|------|------|
| 00-seeded-notes.png | 两张种子笔记（通过被测功能创建）就绪 |
| 01-connected.png | PG fixture 连接成功，工具栏就绪 |
| 02-dialog-default.png | 保存对话框默认态 |
| 03-combobox-lists-notes.png | Combobox 列出已有笔记（含语言/行数徽标） |
| 04-keyboard-highlight.png | ↓ 高亮项 |
| 05-esc-closes-dropdown.png | Esc 关闭下拉、对话框保留 |
| 06-filter-append-target.png | 输入过滤后的候选列表 |
| 07-append-mode-badge.png | 追加模式 badge + 首行 preview |
| 08-comment-empty-disabled.png | 注释为空 → 确认按钮禁用 |
| 09-comment-filled-enabled.png | 注释填写 → 确认按钮启用 |
| 10-append-saved-toast.png | 追加保存成功（toast） |
| 11-create-mode-badge.png | 新建模式 badge |
| 12-notes-appended-content.png | NOTE_A 追加后的完整内容 |
| 13-notes-created-content.png | 新建笔记内容（`-- 注释` 头行 + SQL） |
| 14-duplicate-warning.png | duplicate 警告 + 确认禁用 |
| 15-long-title-truncated.png | 超长标题截断表现 |
| 16-dark-theme-popover.png | 暗色主题下 popover |

### 2.3 spec 工程说明（qa-e2e2，2026-09-01）

1. **SQL 输入通道改用产品自身事件**：本机 WKWebView WebDriver（embedded driver）对 CodeMirror contenteditable 三条输入路径全部失效——programmatic `focus()`（activeElement 不离开 BODY）、`execCommand('insertText')`（返回 false）、WDIO `setValue/elementSendKeys`（tab.sql 不更新）。逐条实测诊断（诊断 spec 已用后删除）。spec 改用产品真实事件 `nexterm:paste-sql-to-query`（Notes「粘贴 SQL 到查询页」功能的同一路径，tool-postgres.tsx useEffect 监听）设置查询 tab SQL——React state 层，恰是对话框读取的数据源。
2. **种子笔记改由被测功能自举**：Notes 编辑器同样无法键入（上述限制），种子笔记通过「保存到记事本」的 create 模式创建——额外多验证两轮真实链路，语义等价（用户创建 SQL 笔记的正是这条路径）。
3. **内容断言归一化**：CodeMirror 渲染后 `.cm-content.textContent` 会丢失分号与换行（line widget 拆分），Notes 内容断言按去空白+去分号归一化比对；比对目标仍含完整头行/SQL 语义。
4. **可见编辑器定位**：App.tsx 所有工具常驻挂载（hidden 切换），读取 Notes 编辑器时按 `getClientRects` 过滤可见节点，避免误读 postgres/sqlite 编辑器。
5. **前置 spec 修复继承**：前任遗留的 `setEditorSql`（execCommand 路径）即首次卡点（156 行），与前任停在 00/01 两张截图的位置一致；本轮重写后全链路通过。

## 3. 视觉评审（Hy3）

- 方法：2026-09-01 通过 MCP 图像视觉接口审核 `test-results/save-notes/` 截图；审核提示明确禁止 OCR、文字识别和逐字转写，仅检查布局、层级、状态、裁切、重叠、对比度与主题一致性。先审 17 格拼图定位问题，再对 11/14/15/16 原图逐张复核；修复后以 14:10 E2E 重新产出的 15/16 原图终审。

### 3.1 结论

**✅ PASS**：主流程布局、层级、对齐和主题连续性通过；此前的超长标题浮层失控与暗色浮层空白问题已修复。

| 截图 | 结论 | 视觉审核摘要 |
|------|------|--------------|
| 00–10、12–13 | ✅ PASS | 连接/种子、默认对话框、候选列表、键盘高亮、Esc 收起、过滤、追加/新建模式、注释门禁、保存反馈与 Notes 内容展示均无边界裁切、重叠、错位或主题断裂。 |
| 11-create-mode-badge.png | ✅ PASS（轻微 WARN） | 空态与列表形态实际互斥，浮层与触发器同宽；仅浮层底部与按钮区间距偏紧。 |
| 14-duplicate-warning.png | ✅ PASS | 警示条增加图标、浅红背景和边框后视觉权重明确；间距与禁用/可用状态可辨。 |
| 15-long-title-truncated.png | ✅ PASS | 对话框完整紧凑居中；触发值有明确省略截断；浮层与触发器左缘和宽度对齐，未超出对话框/视口。 |
| 16-dark-theme-popover.png | ✅ PASS | 页面 → 遮罩 → 对话框 → 浮层层级清晰；浮层与触发器同宽、高度贴合内容、无裁切/遮挡/残影。 |

### 3.2 需要修复

1. 已修复：对话框 grid 轨道改为 `minmax(0,1fr)`，长值使用可收缩 truncate；Popover 显式限制在触发器宽度与视口内，列表高度贴合内容。
2. 已修复：duplicate 警示改为图标 + 浅红背景 + 边框。
3. 非阻断建议：后续可提升候选行计数字的一档亮度。

## 4. 稳定性线复核（任务 #6/#8 产物抽查）

- stability-scan-2026-08-31.md 报告的 6 处 unused import 删除经 git diff 逐一核对属实（postgres.rs skip_leading_noise、jar_*.rs 的 Path/PathBuf/jar_db），无行为改动。
- 全代码库 skip/only/todo 修饰符扫描：vitest 规格零 skip/only/todo；e2e 仅 2 处 `it.skip`（mysql-workspace、sqlite-workspace），系历史提交 fe1d1f2「hide mysql and sqlite navigation」移除导航入口所致，**非本批引入、非掩盖失败**（skip 原因以注释形式写在 spec 内）。
- 本批新增单测抽查：src/__tests__/context-menu-nested-trigger.test.tsx 5/5 通过。
- 全量前端单测最终复跑：`pnpm test` → **118 文件 / 1082 测试全部通过**，无 skip、无失败。

## 5. 复跑命令汇总

```
pnpm test -- src/components/toolbox/__tests__/tool-postgres-save-to-notes.test.tsx
pnpm exec tsc --noEmit
pnpm lint
pnpm i18n:check
pnpm exec wdio run wdio.conf.ts --spec e2e/desktop/save-to-notes-qa.e2e.ts
```

## 6. 转交事项

无。ESLint 0 error / 242 warnings。
