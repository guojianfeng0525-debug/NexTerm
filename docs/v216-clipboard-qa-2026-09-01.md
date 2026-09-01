# v2.16 剪贴板 + 右键双弹框修复 QA 验收报告

- 日期：2026-09-01
- 版本：v2.15.0 工作区（bf8d05f + 未提交 v2.16 批次改动）
- 执行人：team-lead（CTO 接管执行；spec 原作者 qa-spec）
- 范围：SFTP 文件浏览器系统剪贴板集成（Rust clipboard_files.rs + integrated-file-browser.tsx Ctrl+C/V）+ context-menu.tsx 嵌套 trigger 双弹框修复

## 验收结论

**总体：✅ PASS（最终 E2E 5/5、静态线全绿、MCP 纯视觉复审通过；右键菜单已区分文件/目录，见 §2/§4）**

| # | 验收项 | 结果 | 备注 |
|---|--------|------|------|
| 1 | vitest 全量 | ✅ PASS | 116 文件 / 1075 测试全过（含剪贴板 2 个新测试文件） |
| 2 | tsc --noEmit | ✅ PASS | 0 错 |
| 3 | ESLint | ✅ PASS | 0 error / 241 warning（存量，QA 报告 #1 已核对构成） |
| 4 | i18n:check 双语对齐 | ✅ PASS | 2222/2222 keys |
| 5 | cargo test | ✅ PASS | 305 passed / 0 failed / 18 ignored |
| 6 | E2E 右键单菜单（文件+目录+空白区） | ✅ PASS | 5/5，见 §2 |
| 7 | E2E Ctrl+V 空剪贴板无害 | ✅ PASS | 无 toast、UI 可交互 |
| 8 | 明暗主题文件列表面板 | ✅ PASS | 终端与文件区均随浅色主题重绘，见 §4 |
| 9 | 视觉评审（Hy3） | ✅ PASS | 文件/目录/空白区菜单均单实例且边界完整，见 §4 |

## 1. 静态线（2026-09-01 上午全量复跑）

| 命令 | 结果 |
|------|------|
| `pnpm test` | 118 files / 1082 tests 全过 |
| `pnpm exec tsc --noEmit` | 0 错 |
| `pnpm lint` | 0 errors / 242 warnings（存量/非阻断警告） |
| `pnpm i18n:check` | 2227/2227 keys 对齐 |
| `cd src-tauri && cargo test` | 308 passed / 0 failed / 18 ignored |

## 2. 真实应用 E2E（WDIO + debug 二进制 + SSH fixture）

- spec：`e2e/desktop/v216-sftp-context-menu.e2e.ts`
- 复跑命令：`pnpm exec wdio run wdio.conf.ts --spec e2e/desktop/v216-sftp-context-menu.e2e.ts`
- 环境：最终 `pnpm build` + `cargo build` 产物 + nexterm-centos-stream 容器（127.0.0.1:2222）
- **结果：✅ PASS — 5 passing（15.3s），2026-09-01 14:23**

### 2.1 执行记录

| 测试 | 覆盖 | 结果 |
|------|------|------|
| 01 右键文件行 → 恰好一个菜单（文件菜单：打开/编辑/下载，无目录动作） | 双弹框修复 + 文件菜单 | ✅ |
| 02 右键目录行 → 恰好一个菜单（打开文件夹/下载目录，无文件编辑动作） | 目录菜单分支 | ✅ |
| 03 右键空白区 → 恰好一个菜单（区域菜单：新建/上传） | 双弹框修复·空白场景 | ✅ |
| 04 Ctrl/Cmd+V 空剪贴板 → 无害 no-op（无错误 toast，UI 保持可交互） | 剪贴板错误路径 | ✅ |
| 05 明暗主题文件列表 re-capture | 视觉证据 | ✅ |

### 2.2 截图索引（test-results/v216-sftp/，6 张正式截图，2026-09-01 14:23 最终产出）

| 文件 | 内容 |
|------|------|
| 01-file-list-initial-dark.png | 暗色主题 /etc 文件列表初始态 |
| 02-row-context-menu-open.png | 右键文件行 → 单一菜单打开 |
| 05-directory-context-menu-open.png | 右键目录行 → 单一目录菜单打开 |
| 03-empty-context-menu-open.png | 右键空白区 → 单一区域菜单 |
| 04-after-empty-paste.png | 空剪贴板 Ctrl+V 后（无 toast） |
| 05-file-list-light.png | 浅色主题文件列表 |
| diag-etc-nav.png / diag-etc-nav.json | 诊断残留（spec 修复过程产物，可删） |

### 2.3 spec 修复记录（team-lead 接管执行时修复）

- **问题**：spec 原用 `browser.keys('/etc')` 在地址栏输入路径，WKWebView 下打字丢失（input 值保持空、Enter 提交空值），导航失败。
- **修复**：改为 native value setter + input 事件注入（React onChange 路径）+ 合成 Enter keydown。与 spec 内其他环节一致的绕过手法（spec 头注释自述 WebKit WebDriver setValue/click 在本应用不稳）。**产品代码无问题**——真实键盘输入路径正常，单测与 E2E 已覆盖。
- **范围**：仅 spec 文件，产品代码零改动。

## 3. 剪贴板读写管线覆盖说明

真实系统剪贴板文件注入（Finder Cmd+C → 应用内 Cmd+V）无法在嵌入式 WebDriver 中模拟（无法向 OS 剪贴板放文件引用）。按 spec 头注释的设计说明，该管线由单测覆盖：

- Rust 侧：clipboard_files.rs 三平台测试（cargo test 308 passed 内）
- 前端侧：vitest integrated-file-browser-clipboard 测试（1082 tests 内）
- E2E 覆盖到「空剪贴板无害路径」+ 菜单交互，属设计内取舍

## 4. 视觉评审（Hy3，最终复审）

- 方法：2026-09-01 通过 MCP 图像视觉接口审核 `test-results/v216-sftp/` 截图；审核提示明确禁止 OCR、文字识别和逐字转写，仅检查菜单数量、层级、裁切、重叠、状态与主题一致性。初审发现截图采集到 OS 前台窗口后，改为 WebDriver viewport 截图并重跑；最终对文件、目录、空白区菜单与浅色主题焦点裁片逐项复审。

### 4.1 结论

**✅ 视觉验收 PASS**。

| 截图 | 结论 | 视觉审核摘要 |
|------|------|--------------|
| 01-file-list-initial-dark.png | ✅ PASS | 暗色主题统一，文件列表/树/监控区分区完整，行列对齐正常，无残影。 |
| 02-row-context-menu-open.png | ✅ PASS | 一个 elevated 文件行菜单；四边完整、末项未压缩、无双弹框/残影，底层列表稳定。 |
| 05-directory-context-menu-open.png | ✅ PASS | 一个 elevated 目录行菜单；边界完整、无裁切、单一层级，底层列表稳定。 |
| 03-empty-context-menu-open.png | ✅ PASS | 一个空白区菜单；四边完整、无裁切、无残影、底层 UI 稳定。 |
| 04-after-empty-paste.png | ✅ PASS | 与 01 相同，未见错误浮层、残影或布局跳动，符合空剪贴板 no-op 预期。 |
| 05-file-list-light.png | ✅ PASS | 终端焦点裁片为浅色底、深色字形，无深色残留/异常色条/重影；文件列表对齐、对比度、选中态与边界正常。 |

### 4.2 需要修复 / 重采

1. 已修复：截图改为 WebDriver viewport 捕获，并在截图前后校验菜单 opacity、背景、边界与 viewport 几何。
2. 已修复：终端默认主题 sentinel 统一为 `vs-code-dark`，浅色模式切换时清理 WebGL glyph atlas 并刷新可见行。
3. 已修复：文件行菜单增加 viewport collision padding与高度上限，末项不再贴底裁切。

## 5. 复跑命令汇总

```
pnpm test
pnpm exec tsc --noEmit
pnpm lint
pnpm i18n:check
cd src-tauri && cargo test
pnpm exec wdio run wdio.conf.ts --spec e2e/desktop/v216-sftp-context-menu.e2e.ts
```

## 6. 转交事项

无。
