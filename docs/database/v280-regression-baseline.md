# v2.8.0 回归基线与技术债清单

> 作者：regression（回归专家）｜2026-08-26
> 基线点：`main @ cdcf884`（FEATURE BATCH 18 Slice A 已提交）
> 目的：为 v2.8.0 冲刺提供全量回归基线数字，并整理 v2.8.0 技术债候选清单（lint 遗留 errors + B17/B18 DEFERRED 项），供 CTO 决策技术债范围。

---

## 1. 全量基线数字（HEAD = cdcf884）

| 检查项 | 命令 | 结果 |
|---|---|---|
| TypeScript 类型检查 | `pnpm exec tsc --noEmit` | **0 errors**（exit 0，无输出） |
| 前端单测（Vitest） | `pnpm test` | **86 files / 709 tests 全部通过**，0 failed（耗时 17.8s） |
| Rust 测试（cargo test） | `cd src-tauri && cargo test` | **258 passed / 0 failed / 29 ignored**（含 Doc-tests 0） |
| i18n 键位对齐 | node 扁平化比对脚本 | **en = 1927 keys，zh-CN = 1927 keys，双向差集均为空** |
| ESLint | `pnpm lint`（= `eslint src/`） | **250 problems：29 errors + 221 warnings**；其中 7 errors / 7 warnings 可 `--fix` 自动修复 |

基线结论：**除 lint errors 外全绿**。类型、单测（前端 709 + Rust 258）、i18n 均无回归；lint 的 29 个 error 全部位于 B18 未触碰的遗留文件（见 §2），不构成 v2.8.0 发布阻断，但建议作为技术债在 v2.8.0 内消化。

### 1.1 cargo test ignored 用例说明（29 个，均需外部环境）

- SSH/网络类（6）：`ssh::tests` 下 docker/真实连接相关（`test_ssh_connection`、`test_execute_command`、`docker_pty_survives_parallel_sftp_upload` 等）
- Jar 反编译类（17）：pom/jar 集成流程（`full_pipeline`、`nested_archive_flow`、`fat_jar_nested_dependency_class_decompiles`、`old_db_migrates_for_jar_db` 等）
- MySQL fixture（1）：`mysql::tests::connects_to_mysql_fixture`
- PostgreSQL fixture（1）：`postgres_integration::connects_queries_and_reads_catalog`（显式标注需本地 PG 实例）
- POM 跳板机（1）：`connect_through_jump_and_open_pty`
- 其余为 pom_end_to_end / library 流程（需 GUI 或外部 jar 环境）

以上 ignored 与历史基线一致，无新增 ignore。

### 1.2 Vitest 输出中的已知噪声（非失败）

`src/lib/__tests__/toolbox-storage.test.ts` 运行时 stderr 打印 `[db] row_upsert failed ... Cannot read properties of undefined (reading 'invoke')`——为测试环境无 Tauri invoke 的预期 mock 缺失日志，该文件 5 tests 仍全部通过，非回归。

---

## 2. Lint Errors 精确分布（文件 × 规则矩阵）

`pnpm lint`（范围 `src/`）共 29 errors，规则分布：`@typescript-eslint/no-unused-vars` ×16、`@typescript-eslint/no-unnecessary-type-assertion` ×7、`react-hooks/immutability` ×4、`@typescript-eslint/no-misused-promises` ×2。

| 文件 | errors | 规则分布（数量） | 行号 | 可 `--fix` |
|---|---|---|---|---|
| `src/components/toolbox/tool-jar-decompiler.tsx` | 22 | no-unused-vars ×15、no-unnecessary-type-assertion ×5、no-misused-promises ×2 | 16,21,26,41,463,468,472,708,720,1410,1712,2195,2370,2655,3083,3126,3311 | 5（断言类） |
| `src/components/toolbox/servers-view.tsx` | 4 | no-unnecessary-type-assertion ×1、no-unused-vars ×1、react-hooks/immutability ×2 | 319,374,414,436 | 1 |
| `src/components/toolbox/tool-sqlite.tsx` | 2 | react-hooks/immutability ×1、no-misused-promises ×1 | 57,（misused-promises 行见下） | 0 |
| `src/components/toolbox/document-better-editor.tsx` | 1 | no-unnecessary-type-assertion ×1 | 132 | 1 |
| `src/components/toolbox/tool-api-debug.tsx` | 1 | react-hooks/immutability ×1 | 554 | 0 |

**注意（与任务简报的差异，实测为准）**：

1. 任务简报称 30 errors 集中在 4 文件（jar-decompiler/sqlite/better-editor/use-webview-file-drop）。实测 `pnpm lint` 为 **29 errors / 5 文件**：`use-webview-file-drop.ts` 为 0 error / 1 warning（`react-hooks/refs`），不含 error；额外 error 文件为 `servers-view.tsx`（4）与 `tool-api-debug.tsx`（1）。已按实测矩阵记录。
2. 若对全仓跑 `eslint .`（超出 `pnpm lint` 范围），另有 7 个 **parser fatal errors**（`e2e/desktop/*.e2e.ts` ×6 + `wdio.conf.ts` ×1，均为 "was not found by the project service" 的 tsconfig 解析问题）。`pnpm lint` 不含这些，v2.8.0 可选择把 e2e 纳入 lint 范围或维持现状。
3. tool-sqlite.tsx 实测 2 errors（简报记 1）：除 `react-hooks/immutability`（L57 `patchTab` 声明前访问）外，JSON 格式统计含 1 个 `no-misused-promises`。两处均需手工修。

### 2.1 按修复手段拆分（29 errors）

**可 `eslint --fix` 自动修复：7 个**（全部为 `no-unnecessary-type-assertion`）

- tool-jar-decompiler.tsx L708/720/2655/3083/3126（5）
- servers-view.tsx L319（1）
- document-better-editor.tsx L132（1）

**需手工修复：22 个**

- no-unused-vars ×16：删未用 import / 变量（tool-jar-decompiler.tsx 15 处 + servers-view.tsx 1 处 `childFolders`）。机械性高、零风险，但需人工确认删除断言不误删（如 `DecorationSet`/`ViewUpdate` 类型 import）。
- react-hooks/immutability ×4：声明前访问/JSX 前值修改（servers-view.tsx L414/436 `findNodeById`/`findNodeContext` 递归引用、tool-sqlite.tsx L57 `patchTab`、tool-api-debug.tsx L554）。需重排声明或改用函数声明提升，**有逻辑语义，需 review + 回归**。
- no-misused-promises ×2：tool-jar-decompiler.tsx L1410/1712（Promise 传给 void 期望位）。包 `void` 或改 async 处理，需按语义选择，避免吞错。

---

## 3. v2.8.0 技术债清单

### 3.1 Lint 遗留 errors（29 个）修复方案预估

| 批次建议 | 内容 | 预估成本 | 价值 |
|---|---|---|---|
| **随 v2.8.0 修（建议）** | ① `eslint --fix` 自动修 7 个断言 error；② 手工删 tool-jar-decompiler.tsx 15 个未用 import/变量 + servers-view.tsx 1 个 | 自动修 ~0 成本；删 import 为机械操作，每文件 <10 分钟 | 消除 23/29 errors，lint error 清零进度 79%；零运行时风险（tsc 已绿） |
| **随 v2.8.0 修（可选，需 review）** | servers-view.tsx 2 个 `react-hooks/immutability`（函数声明重排） | 每处 ~30 分钟含回归 | 消除潜在渲染期闭包陈旧风险；与 B18 无耦合，文件不在 B18 触碰集 |
| **推迟到 B19+** | tool-jar-decompiler.tsx 2 个 `no-misused-promises`（L1410/1712）、tool-sqlite.tsx L57 + tool-api-debug.tsx L554 immutability、tool-sqlite misused-promises | 涉及异步语义与 tab 状态机，需谨慎 review + 手工回归 | 风险/收益比一般；jar-decompiler 3300+ 行大文件本身是重构候选，宜随 B19 重构一并处理 |

### 3.2 B17/B18 遗留 DEFERRED 项汇总

| # | 项 | 来源 | 内容 | 原归属 |
|---|---|---|---|---|
| D1 | E2E 补跑（G-1） | B18 QA 报告 §2/§3 | WDIO 桌面 E2E 因 R9 环境不稳定整体 DEFERRED；spec 自带 2 个必失败缺陷：E2E-BUG-1（clear 按钮 testid 预估错：spec 用 `postgres-filter-clear`，实际 `postgres-clear-filter`）、E2E-BUG-2（`rowCount()` 等 4 helper 的 `browser.execute` 闭包引用外层常量序列化后 undefined）；FilterSortDialog 无 data-testid，A-3/A-4 落地前需补选择器契约 | B19（R9 环境依赖） |
| D2 | 安全 Low-1：超时后连接状态集成测试 | B18 安全审查 | QUERY_TIMEOUT 30s 已包裹（postgres.rs:1123），但超时后「连接可继续用」无集成测试（需真实 PG + 慢查询）；建议并入 E2E A-10 顺带覆盖 | B19 |
| D3 | 安全 Medium：LIKE 通配符 UI 提示文案 | B18 安全审查条件项 | `%`/`_` 通配语义无 UI 提示，用户可能当字面量输入；文案级修改 | B19 或文案热修 |
| D4 | 架构 MINOR-2：双 toast | B18 架构审查 | `saveTableChanges` 保存成功后重查失败时，browse 内部吞错自行 toast.error（:726-729），叠加外层无条件 toast.success（:1186-1187），出现「error+success」双提示语义混淆 | batch 台账跟踪 |
| D5 | 架构 MINOR-3：空串 value 校验 | B18 架构审查 | FilterSortDialog `apply()` 仅校验 column 非空，1 参数操作符 + 空 value 提交 `col = ''` 空串等值查询，用户困惑（服务端语义合法，无安全影响） | B19（UX 边界） |
| D6 | QA G-3：applyFilter/clearFilter tab 状态迁移组件测试 | B18 QA 报告 §3 | draft→active、offset 归 0、徽标条件数派生的副作用路径无自动化（需组件测试基建或 RTL；仓库仅 2 个 .test.tsx） | B19 |
| D7 | QA G-4：Ctrl+R 焦点守卫纯函数化 | B18 QA 报告 §3 | `typingInField` 提前 return 内联于 `onDatabaseKeyDown`（tool-postgres.tsx:1266-1270），无单测；逻辑仅 3 行，风险低 | B19 |
| D8 | QA G-5：query tab 反证 + 人工视觉复核 | B18 QA 报告 §3 | 过滤 shortcut 在 query tab 不生效的反证用例 + AC-A13 视觉门禁人工复核 | B19 |

> 已核对：QA G-2（`buildFieldValueFilter` NULL→isNull 纯函数 + 单测）**已随 B18 Slice A 落地**（`src/lib/database/table-filter.ts` + `src/lib/__tests__/table-filter.test.ts`，9 tests 全过），不计入债清单。

### 3.3 随修 / 推迟建议汇总

**建议随 v2.8.0 一起修（低成本高价值）：**

1. lint 第一梯队：`--fix` 7 个断言 + 删 16 个未用 vars（23/29，error 清零 79%，零风险）
2. D3 LIKE 通配符 UI 提示文案（纯文案 + i18n 两侧键，<30 分钟，直接消除用户可感知困惑）
3. D5 MINOR-3 空串 value 校验（对话框对 needsValue 操作符校验 value 非空/禁用 Apply，小改动；注意与 D3 同文件，可一次提交）
4. E2E-BUG-1/2 的 spec 修复（testid 更正 + 闭包常量内联，两处机械修复，为 B19 补跑扫清障碍）

**建议明确推迟（B19+）：**

1. react-hooks/immutability ×4 与 no-misused-promises ×2（lint 第二梯队，语义敏感需 review；tool-jar-decompiler 3300 行大文件宜随 B19 重构处理）
2. D1 E2E 批量补跑（硬依赖 R9 WDIO 环境稳定）
3. D2 超时集成测试（依赖真实 PG 环境构造慢查询，与 D1 的 E2E A-10 合并执行）
4. D6 G-3 组件测试基建（需引入 RTL 惯例，超出 v2.8.0 范围）
5. D4 MINOR-2 双 toast（低概率场景，涉及 browse 吞错语义调整，改动面大于收益）
6. D7 G-4 / D8 G-5（低风险观察项，随 B19 测试批次）
7. e2e/wdio 的 7 个 parser errors（若 CTO 决策将 e2e 纳入 lint 范围，可加 tsconfig include 或独立 script；本身不是代码缺陷）

---

## 4. 回归判定

以 `cdcf884` 为 v2.8.0 冲刺起点的全量基线：**tsc 0 error、前端 709/709、Rust 258 passed/0 failed、i18n 1927=1927 完全对齐**。唯一的红灯是 lint 29 errors，全部位于 B17/B18 未触碰的 5 个遗留文件，与 B18 Slice A 变更无因果关系（B17/B18 触碰文件 tool-postgres.tsx / database-result-pane.tsx / filter-sort-dialog.tsx / postgres.rs 均 0 error）。**无阻断，v2.8.0 冲刺可在干净基线上启动。**
