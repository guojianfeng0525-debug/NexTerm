# NexTerm 稳定性全量验证扫描报告

- 日期：2026-08-31
- 版本：v2.15.0
- 执行人：stability-dev
- 复现环境：macOS (Darwin 24.6.0, arm64)，pnpm 9.15.4，Node + Rust 工具链为仓库当前锁定版本

## 扫描结果总览

| # | 验证项 | 复现命令 | 结果 | 失败/错误数 |
|---|--------|----------|------|-------------|
| 1 | 前端单元测试（vitest） | `pnpm test` | ✅ 通过 | 0（113 文件 / 1051 测试全部通过） |
| 2 | TypeScript 类型检查 | `pnpm exec tsc --noEmit` | ✅ 通过 | 0 |
| 3 | ESLint | `pnpm lint` | ✅ 通过（0 errors） | 0 error / 241 warning |
| 4 | i18n key 对齐 | `pnpm i18n:check` | ✅ 通过 | 0（zh-CN 与 en 各 2212 keys，完全对齐） |
| 5 | Rust 后端测试 | `cd src-tauri && cargo test` | ✅ 通过 | 0（305 passed / 18 ignored / 0 failed） |

**结论：全量扫描未发现任何 error 级失败，无测试失败、无类型错误、无 i18n 缺 key。**

## 详细记录

### 1. pnpm test（vitest）

- 结果：`Test Files 113 passed (113)`，`Tests 1051 passed (1051)`，耗时约 19s。
- 测试输出中的 `Native menu sync skipped: Error: unexpected invoke: update_menu_language` 为 i18n 测试在 mock IPC 环境下的预期 stderr 日志（src/lib/i18n.ts syncNativeMenu 的降级路径），不影响测试结果，相关测试均通过。

### 2. tsc --noEmit

- 退出码 0，无任何输出，无类型错误。

### 3. pnpm lint

- 退出码 0，`0 errors, 241 warnings`。
- warning 构成（均为 warning 级，按纪律默认不处理）：
  - `react-refresh/only-export-components`：ui 组件库文件（badge/button/form/navigation-menu/sidebar/toggle 等）导出常量/工具函数。
  - `react-hooks/set-state-in-effect`：多处（如 tool-vault.tsx:105、ui/carousel.tsx:98、ui/use-mobile.ts:16）。
  - `@typescript-eslint/no-unsafe-*`：chart.tsx、connections-io.ts、toolbox-storage.ts 等处的 any 使用。
  - `@typescript-eslint/no-floating-promises`：src/lib/i18n.ts:83、112。
- 无 eslint error。

### 4. i18n key 对齐

- `node scripts/check-i18n-parity.mjs` 输出：`✓ Key parity check passed (2212 keys in both files.)`。
- zh-CN.json 与 en.json key 集合完全一致，无缺 key、无多余 key。

### 5. cargo test

- 全部测试目标通过：合计 305 passed / 0 failed / 18 ignored。
- ignored 的 18 个为需要显式配置外部环境的集成测试（本地 PostgreSQL、跳板机连接、POM 端到端等），属预期行为。
- 编译期有 6 条 `unused import` warning（详见下节），非测试失败。

## 发现的 warning 级问题清单（低风险，本次顺带修复）

| # | 文件 | 位置 | 问题 | 风险评估 |
|---|------|------|------|----------|
| W1 | src-tauri/src/postgres.rs | 2576 | unused import: `skip_leading_noise` | 删除未使用 import，零行为影响 |
| W2 | src-tauri/tests/jar_migration.rs | 4 | unused import: `std::path::Path` | 同上 |
| W3 | src-tauri/tests/jar_e2e.rs | 10 | unused import: `std::path::Path` | 同上 |
| W4 | src-tauri/tests/jar_decompile_cmd.rs | 5 | unused import: `std::path::Path` | 同上 |
| W5 | src-tauri/tests/jar_decompile_cmd.rs | 9 | unused import: `jar_db` | 同上 |
| W6 | src-tauri/tests/jar_chain.rs | 7 | unused imports: `PathBuf` and `Path` | 同上 |

以上均为"明显低风险"warning（纯删除未使用 import），符合修复纪律中"warning 级不动，除非明显低风险"的例外条件，已随任务 #2 修复。

## 修复记录（任务 #2）

- 修复内容：删除 6 处 unused import（W1–W6），无任何行为改动。
- 验证证据：重跑 `cd src-tauri && cargo test`，结果 `305 passed / 0 failed / 18 ignored`，与修复前完全一致；编译期 unused import warning 由 6 条降为 0 条，退出码 0。
- 前端验证（pnpm test / tsc / lint / i18n:check）未受影响——本次未改动任何前端文件，扫描时已全绿。
- E2E 未运行（纪律约定归 team-lead 调度）。

## 前端 lint warning（241 条，未修复，仅记录）

按纪律"warning 级不动"，前端 241 条 eslint warning 本次不处理。分布概览：
- `react-refresh/only-export-components`（ui 组件库模式，shadcn 风格固有）
- `react-hooks/set-state-in-effect`（多处 hook 模式）
- `no-unsafe-*` / `no-floating-promises`（any 与浮动 Promise）

如需治理需单独立项（涉及模式重构，超出本轮保守修复范围）。

## 备注

- E2E（WDIO / 4445 端口）按纪律未运行，归 team-lead 调度。
- src/components/toolbox/tool-postgres.tsx 与 src/locales/ 未做任何改动（fe-dev 文件域）。
