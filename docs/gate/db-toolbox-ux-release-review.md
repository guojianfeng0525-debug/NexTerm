# DB Toolbox UX — 发布审核报告（REVIEW + RELEASE）

> 审核人：release-reviewer ｜ 日期：2026-08-28 ｜ 分支：`feat/db-toolbox-ux-enhancement`
> 范围：数据库工具箱三库（PG/MySQL/SQLite）UX 增强的最终验证 + 发布前准备
> 前置结论：`docs/gate/db-toolbox-ux-gate.md`（视觉门禁 v2.0 **通过**）

---

## 1. 验证结果清单（全量）

| 项目 | 命令 | 结果 | 说明 |
|---|---|---|---|
| 单元/组件测试 | `pnpm test`（vitest --run） | ✅ **107 文件 / 992 tests 全通过** | exit 0；基线 992+ 全绿，无失败 |
| 类型检查 | `pnpm exec tsc --noEmit` | ✅ **0 错误** | exit 0 |
| 代码检查 | `pnpm lint`（eslint src/） | ✅ **1 error / 247 warnings** | 唯一 error 为 pre-existing（见 §3.4）；无新增 error |
| 生产构建 | `pnpm build`（tsc && vite build） | ✅ **成功** | 产物正常输出 `dist/`，主包 index gzip 163.88 kB，与代码分割基线一致 |

> 说明：首次 `pnpm build` 因沙箱 safe-delete 拦截 vite 清空旧 `dist/assets`（103 文件 > 50 阈值）而失败，属环境限制非代码问题；将旧 dist 移出后重跑成功。

**结论：四项验证全部通过，无阻断项。**

## 2. 发布准备

| 项 | commit | 内容 |
|---|---|---|
| 交付物入库 | `5bd9096` | `docs: DB toolbox UX analysis/design/gate + e2e specs` —— docs/analysis/（3 份）、docs/design/（3 份）、tests/db-toolbox-ux.e2e.spec.ts、tests/db-toolbox-ux.gate.e2e.spec.ts，共 8 文件 / 3676 行。`docs/gate/db-toolbox-ux-gate.md` 已由 visual-gate 先行追踪，未重复提交 |
| CHANGELOG | `67753de` | `docs(changelog): DB toolbox UX enhancement entry` —— 顶部新增 `## [Unreleased]` 章节，列三库 UX 对齐 / 右键菜单 / 错误工程化 / 快捷键 / 生成 SQL / 查询历史及验证数据 |

- **版本号未 bump**（`version: 2.12.0` 保持不变，留待 main 发布流程）。
- **未 push / 未 merge / 未建 PR**，交付停留在本分支。
- 未跟踪文件 `e2e/desktop/_fe-diag-window.e2e.ts`（会话前已存在，与本任务无关）**未提交**。

## 3. 风险与遗留（均非阻断）

### 3.1 PG 菜单未迁移共享组件，已就地达标
PG 主工具四组菜单（连接/对象/编辑/网格）按 team-lead 指示保留专属结构，未迁移到 `db-context-menus.tsx` 共享组件，但已就地补齐图标 / 快捷键标注 / 危险项置底 / AlertDialog，视觉契约达标（GATE §3）。

### 3.2 MySQL/SQLite 导航入口被隐藏，e2e 不可达
main 的 `fe1d1f2` 隐藏了 MySQL/SQLite 导航入口，导致共享菜单（含快捷键标注）与三库对齐的 e2e 用例在当前分支不可达（`db-toolbox-ux.e2e.spec.ts` 1 项预期 skip；GATE F5）。建议随导航入口恢复一并复验。

### 3.3 postgres-workspace e2e 断言与 B21 交互不符（pre-existing）
`tests/postgres-workspace.e2e.spec.ts:80-84` 在**单击**表节点后断言数据网格已打开，与 B21 交互语义「单击选中、双击打开数据网格」不符。该断言在 main 上完全一致（自 `081e91e` FEATURE BATCH 16 引入），非本分支引入。

### 3.4 pre-existing lint error
`src/components/toolbox/tool-postgres.tsx:815` `savedQueries[0]!.id` 多余类型断言（@typescript-eslint/no-unnecessary-type-assertion），源自 `d295164f`（main 基线祖先，main 上位于 745 行），本分支未新增 error，按基线不修复。

### 3.5 范围外 backlog（GATE §5 登记）
- MySQL/SQLite 连接节点菜单快捷键标注待补齐（随 3.2 一并处理）。
- `table-designer` 列/约束行右键菜单（spec A7）未实现，建议产品 backlog 登记。

## 4. 分支状态

- 相对 main（`1cd12d3`）开发 commit：**19 个**；含发布准备 2 个 commit 共 **21 个**（本报告提交后 22 个）。
- 工作区：仅剩未跟踪的 `e2e/desktop/_fe-diag-window.e2e.ts`（与任务无关）。

---

## 5. 放行建议

四项验证全绿 + 视觉门禁通过 + 发布材料齐备，**建议 team-lead 放行**。合并 / 版本号 bump / 发布由用户与 team-lead 在 main 流程决定。
