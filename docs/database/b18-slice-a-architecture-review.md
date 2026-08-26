# B18 Slice A「数据网格过滤与排序」架构评审报告（实现后复核）

> 评审人：architect（高见远）｜2026-08-26
> 性质：**只读评审**，未改动任何产品代码。唯一产出为本文件。
> 对照依据：`b18-filter-architecture-constraints.md`（实现前约束，下称"约束文档"）、`batch-18-browse-plan.md` §4/§9（规格 AC）。
> 评审对象：`tool-postgres.tsx`、`filter-sort-dialog.tsx`、`table-filter.ts`、`result-types.ts`、`postgresql-result-adapter.ts`、`command-registry.ts`。

---

## 1. 评审范围与方法

逐条对照约束文档的 12 条决策与规格 Slice A AC，阅读实现代码的调用链（browse / applyFilter / clearFilter / saveTableChanges / onDatabaseKeyDown / FilterSortDialog），重点复核 team-lead 指定的四项：决策 1/2 状态与查询路径、决策 3 保存链路、组件边界、B17 兼容性。

---

## 2. 决策比对

### 决策 1：filter/activeFilter 状态放 WorkspaceTab，不建全局 store —— **符合**

| 证据 | 位置 |
|---|---|
| `WorkspaceTab` 含 `filter?`（draft）与 `activeFilter?`，注释语义正确，与 B17 的 `baseline/dirty/pendingInserts/pendingDeleteRows` 同层 | tool-postgres.tsx:156-159 |
| 写入统一走 `patchTab`，无 context/hook/store，无第二个消费方 | tool-postgres.tsx:310-313 |
| 对话框开/关为组件级局部 state（`filterDialog`），不进 WorkspaceTab | tool-postgres.tsx:290-293 |
| tab 关闭无过滤特殊清理，自然随 tab 丢弃（符合决策 12 不持久化） | tool-postgres.tsx:614-619 |

### 决策 2：browse 单一查询路径 —— **符合**

`browse(reference, offset = 0, filterOverride?)`（tool-postgres.tsx:645-650）。第三参语义细化为：`undefined` → 沿用 tab 的 `activeFilter`；传 state → 应用；`null` → 清除。这是对约束签名 `filter?(TableFilterState)` 的合理实现细化（区分"未指定"与"清除"），且 `filterOverride === undefined` 时从 `tabs` 重读 activeFilter 的原因有注释说明（:681-682，规避 patchTab 未重渲染的 stale 闭包）。

全部查询场景均走同一路径，无并行 `invoke("postgres_table_data")`（该 invoke 全文件仅 browse 内一处，:688）：

| 场景 | 调用 | 位置 |
|---|---|---|
| 打开表 / Open Data | `browse(relation)` | :1497, :1530 |
| Refresh 按钮 | `browse(ref, tableOffset)`（保持当前页，隐式带 activeFilter） | :1589 |
| 翻页 prev/next | `browse(ref, tableOffset ± pageSize)`（过滤态自动携带 activeFilter，A-6） | :1628-1651 |
| 应用过滤 | `browse(ref, 0, next)`（offset 归 0，A-5） | :753 |
| 清除过滤 | `browse(ref, 0, null)` | :775 |
| 保存后重查（过滤态） | `browse(ref, tableOffset, tab.activeFilter)`（不跳页） | :1186 |
| Ctrl+R 三态 | apply/replay → `browse(ref, 0, …)`；refresh → `browse(ref, tableOffset)` | :1302-1314 |

`tableOffset` 推导不动（:324-325）；`hasMore` 信任 Rust `truncated`（postgresql-result-adapter.ts:80），前端不自算。决策 4/5 均符合。

**偏离点（并入问题 MAJOR-1）**：约束决策 2 规定"对话框 Apply 只更新 draft，不立即查询，统一由 Ctrl+R 应用"。实现中对话框 Apply 直接调 `applyFilter` **立即查询并写 activeFilter**（filter-sort-dialog.tsx:121-135 → tool-postgres.tsx:744-754）。该偏离与规格一致（A-3 "Apply → 结果与预期 SQL 语义一致；徽标更新"、A-5 以 Apply 触发 offset 归 0），且三个过滤入口行为统一、UX 更优。详见 §3 MAJOR-1 的裁定建议。

### 决策 3：过滤态可编辑，保存后重查 —— **符合**

- `tableEditingEnabled`（:353-357）不因 activeFilter 存在而变化；双击编辑、Set NULL/Empty/UUID、Insert/Delete、Ctrl+S 在过滤态全部照常（右键菜单 :1682-1700 不检查 activeFilter）。
- `saveTableChanges` 成功分支以 `tab.activeFilter && tab.object` 为开关（:1181）：
  - **有 activeFilter** → `await browse(reference, tableOffset, tab.activeFilter)` 重查当前 offset 过滤视图（不跳页，符合决策 8 注意点）；browse 成功即清 pendingInserts/pendingDeleteRows、重置 baseline/dirty（:715-725），满足 §4.4.6"INSERT 行落在过滤集外不在网格显示"，且不额外 toast。
  - **无 activeFilter** → B17 本地合并路径逐行保留（:1188-1206），零回归。
- **保存后 activeFilter 保留**：browse 的成功 patchTab（:715-725）不含 activeFilter 键，重查也不传 null；保存前后过滤态稳定。✓
- Filter by field value：NULL 单元格发 `isNull`、非 NULL 发 `eq`（:756-769），符合决策 6 的安全红线（禁止 `eq + null`）。

### 附带决策快查（4-12）

| 决策 | 结论 | 证据 |
|---|---|---|
| 4 offset 重置 | 符合 | 应用/清除/Ctrl+R apply/replay 一律 offset=0 |
| 5 hasMore=truncated | 符合 | adapter :80 未改 |
| 6 IPC 契约 / 类型层 | 符合 | `TableFilterState/FilterCondition/SortClause/FilterOperator` 在 result-types.ts:33-55；`providerType/providerComment` 已落地（:23-25）|
| 7 过滤态不拦截编辑 | 符合 | 见决策 3 |
| 8 保存后刷新过滤视图 | 符合 | :1181-1187 |
| 9 焦点守卫补 select | 符合 | :1232 `"input, textarea, select, [contenteditable='true']"`；且 table tab + typingInField 提前 return（:1270）拦截对话框内 Ctrl+R |
| 10 Ctrl+R 三态 | 符合（含简化，见 MINOR-1） | `resolveFilterShortcut` 纯函数 + :1302-1314；query tab 保持 refreshNavigator |
| 11 命令注册仅声明 | 符合 | command-registry.ts:42-45, :277-303 共 4 条 DATA_GRID 命令 |
| 12 不持久化过滤 | 符合 | 无 localStorage 写入，tab 关闭即丢 |

### 组件边界 —— **清晰，符合**

- **filter-sort-dialog.tsx**：纯展示组件。props 进（columns/initialFilter/includeSort/labels）、callbacks 出（onApply/onClear/onOpenChange）；内部仅本地编辑 useState + 打开时 useEffect 水合（:92-109）；无 invoke、无 patchTab、无业务状态写入。Custom Filter 与 Filter & Sort 共用单组件，`includeSort` prop 控制排序区（约束 §6 第 2 条），未建两个对话框。✓
- **table-filter.ts**：26 行纯函数模块——`resolveFilterShortcut`（A-7 三态决策）与 `isEmptyFilter`（A-12 空条件等价清除），无 IO，可独立单测。未引入状态管理库或 dispatch 框架（约束 §6 第 4 条）。✓
- **前端不拼 SQL**：browse 只传结构化 filter（:695-710），SQL 构造全在 Rust。✓

### B17 兼容性（"翻页清空 pending"）—— **无回归**

browse 成功后统一 `pendingInserts: []`、`pendingDeleteRows: []`、`baseline: result`、`dirty: false`（:715-725），注释保留 B17 评审确立的理由（pendingDeleteRows 行索引随重载失效，保留会删错行）。B18 未改动该块语义；过滤应用/清除/重放/保存重查全部复用同一段收敛逻辑，翻页与过滤态行为一致，无"翻页保留 stale pending"回归。无过滤分支的保存本地合并（:1188-1205）与 B17 逐行等价。

---

## 3. 问题清单

### Blocking

无。

### Major

**MAJOR-1：draft（tab.filter）机制与实际流程脱节，约束决策 2 与规格 A-3 存在文档矛盾，需裁定并收敛**

- 实现：对话框 Apply 立即写 activeFilter 并查询（applyFilter :744-754），Cancel 仅关对话框不丢弃 draft；对话框没有任何"保存 draft 不应用"的出口。
- 后果：`tab.filter` 唯一被写入的位置是列头右键打开 Filter & Sort 前的预填 `patchTab(tab.id, { filter: tab.filter ?? tab.activeFilter })`（:1707-1713）。该预填在无 draft 时把 activeFilter 复制进 draft，使下一次 Ctrl+R 走 `apply` 分支而非 `replay`（行为等同，无害但语义污染）；此后 draft 永远 == activeFilter，"有未应用 draft → Ctrl+R 应用"（A-7 第一态、约束决策 2 的核心流程）在 UI 上**不可达**，`resolveFilterShortcut` 的 apply 分支近乎死代码路径。
- 定性：产品行为符合规格 AC（A-1/A-2/A-3/A-5/A-12 均可达且正确），偏离的是约束文档决策 2 的字面规定；而约束决策 2 本身与规格 A-3"Apply → 结果一致、徽标更新"矛盾（对 A-7 的过度推断）。属于**架构文档与实现状态模型不一致**，会误导 B20 及后续维护者。
- 建议（二选一，倾向 a）：
  - **(a) 接受"立即应用"为实现语义**：修订约束文档决策 2/10；同时删除 :1710 的 draft 预填（对话框 `initialFilter` 已有 `tab.filter ?? tab.activeFilter` fallback，:1858，预填冗余），并将 `tab.filter`/`resolveFilterShortcut` 简化为 activeFilter 单状态二态（apply 分支删除或保留纯函数供单测），消除死路径。
  - (b) 恢复 draft 语义：对话框 Apply 只写 draft，加"应用"出口交给 Ctrl+R——不推荐，与 A-3/A-5 的 E2E 语义冲突且多一步操作。

### Minor

**MINOR-1：`resolveFilterShortcut` 未实现约束决策 10 的"draft ≠ activeFilter"判定**

`if (draft) return { kind: "apply", ... }`（table-filter.ts:18）不比较 draft 与 active。叠加 MAJOR-1 的预填，存在 draft==active 走 apply 的路径（效果等同 replay）。行为无害；若按 MAJOR-1(a) 收敛则此问题一并消失。

**MINOR-2：保存成功但保存后重查失败时出现"error + success"双 toast**

`saveTableChanges` 过滤分支 `await browse(...)` 后无条件 `toast.success`（:1186-1187），而 browse 内部吞错自行 `toast.error`（:726-729）不抛出。低概率场景（保存成功瞬间连接断开/权限变化）下用户同时看到保存失败样式的错误与保存成功提示，语义混淆。建议：browse 返回布尔或抛出，成功 toast 依赖重查结果；或将成功 toast 移至重查之前并调整文案。非本批必须。

**MINOR-3：对话框允许 1 参数操作符携带空串 value 提交**

`apply()` 的 nonEmpty 过滤只校验 column 非空，`eq + value:""` 会以 `col = ''` 查询（filter-sort-dialog.tsx:121-135；browse 侧 `value: condition.value ?? null` :702 不拦截空串）。用户留空 value 时得到意外的空串等值查询而非报错/忽略。属 UX 边界，建议对话框对 needsValue 操作符校验 value 非空（空则禁用 Apply 或提示），与 qa 测试计划协同覆盖。非架构问题。

---

## 4. 架构结论

# PASS WITH FIXES

三条核心决策（状态归属、单一查询路径、过滤态保存重查）**全部符合**，组件边界清晰，B17 编辑闭环无回归，安全红线（isNull 而非 eq+null、结构化过滤、前端不拼 SQL）在架构层面遵守。唯一需要处理的是 MAJOR-1：draft 机制已成不可达路径且约束文档与规格矛盾——按建议 (a) 修订约束文档并删除冗余预填/死分支即可，属小改动，不影响 Slice A 功能正确性。3 条 Minor 可并入后续批次。

> 后续动作建议：MAJOR-1 的文档修订由 architect（我）在约束文档更新时执行；代码收敛（删 :1710 预填 + 简化 resolveFilterShortcut）建议交 fe-dev 随 Slice A 收尾处理，MINOR-2/3 记入 batch 台账跟踪。
