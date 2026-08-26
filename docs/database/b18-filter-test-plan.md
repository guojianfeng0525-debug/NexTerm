# B18 Slice A「过滤」测试计划（QA）

> 作者：qa（严过关）｜2026-08-26
> 依据：`docs/database/batch-18-browse-plan.md` §4（Slice A 过滤规格与 AC A-1…A-13）、§9（SQL 安全设计）、§11（测试矩阵）
> 配套产物：`e2e/desktop/postgres-filter.e2e.ts`（原生 WDIO E2E，初版）
> 状态：PLANNING（过滤选择器为预估，fe-dev 完成后按实际修正）

## 1. 范围

| 层 | 被测对象 | 用例形态 |
|---|---|---|
| Rust | `postgres_table_data` 的 `filter`/`orderBy` 参数化构造（`build_where_clause`/`build_order_by_clause`） | `cargo test` 单测 |
| 前端 | 过滤状态（draft/active/reducer）、Ctrl+R 语义、命令 enablement、query tab 范围守卫 | vitest 单测 |
| 端到端 | Filter by field value → 应用 → 行数变化与列值匹配 → 清除 → 恢复（真实 PG fixture） | WDIO 原生 E2E |

## 2. AC 映射

| AC | 验证层 | 说明 |
|---|---|---|
| A-1 字段值过滤（非 NULL） | E2E | spec 主流程（active 列 eq） |
| A-2 字段值过滤（NULL） | E2E（后续）+ Rust | NULL 单元格 → IS NULL；Rust 单测覆盖 `isNull` 无绑定值 |
| A-3 Custom Filter AND(eq+like) | E2E（后续） | 对话框交互；Rust 单测覆盖 like 原样绑定 |
| A-4 Filter & Sort | E2E（后续）+ Rust | Rust 覆盖多列排序 + PK 兜底 |
| A-5 过滤重置 offset=0 | E2E（后续） | 分页边界 |
| A-6 过滤态翻页 | E2E（后续） | WHERE 与 LIMIT/OFFSET 组合 |
| A-7 Ctrl+R（draft→active / 重放 / 刷新） | E2E + vitest | reducer 语义 + 焦点守卫 |
| A-8 清除过滤 | E2E | spec 主流程尾段 |
| A-9 readOnly 可用 | E2E（后续） | 读操作不拦截 |
| A-10 注入防护 | Rust 单测 | 值参数化、未知列/运算符拒绝 |
| A-11 过滤×编辑不回归 | E2E（后续） | B17 回归 |
| A-12 空条件 = 清除 | Rust 单测 | `conditions.is_empty()` → 无 WHERE |
| A-13 query tab 无过滤入口 | vitest | 范围守卫 |

## 3. Rust 单测用例（`cargo test postgres`）

对应实现：`src-tauri/src/postgres.rs` `build_where_clause` / `build_order_by_clause`。

### 3.1 条件构造（已实现，回归清单）

| # | 用例 | 断言 |
|---|---|---|
| R-1 | eq 绑定 + 类型 cast | `"name" = $1::text::text`，params=[Alice] |
| R-2 | 六类比较运算符全量（eq/neq/gt/gte/lt/lte） | 逐运算符断言 SQL 形态 |
| R-3 | OR 逻辑连接多谓词 | `a = $1 OR a = $2` |
| R-4 | isNull / isNotNull 不绑定值 | `"note" IS NULL AND "name" IS NOT NULL`，params 为空 |
| R-5 | like 模式原样绑定（含引号） | `%O'Brien%` 原样进 params |
| R-6 | 空条件列表 → 无 WHERE | clause 为空、params 为空（= A-12） |

### 3.2 安全护栏（已实现，回归清单）

| # | 用例 | 断言 |
|---|---|---|
| R-7 | 未知列拒绝 | `missing` 列 → Err("Unknown filter column") |
| R-8 | 非法运算符拒绝 | `regex` → Err("Unsupported filter operator") |
| R-9 | 非法 logic 拒绝 | `XOR` → Err |
| R-10 | 注入值 `x' OR '1'='1` 按字面绑定 | 不拼接进 SQL，仅进 params |
| R-11 | ORDER BY 列白名单 | 未知列 → Err |
| R-12 | ORDER BY direction 白名单 | 非 asc/desc → Err |
| R-13 | ORDER BY 多列 + PK 兜底 | `score DESC, name ASC, id ASC` |
| R-14 | 无 PK 且无排序 → 空 ORDER BY | 兼容现状 |

### 3.3 补充建议（若改动涉及可加）

| # | 用例 | 说明 |
|---|---|---|
| R-15 | eq 空字符串值 | `value: Some("")` 绑定 `$1` 为空串，SQL 不变形 |
| R-16 | 值含 `%`/`_` 的 like | 确认原样绑定（不转义，用户自书写） |
| R-17 | 列名含引号（如 `we"ird`）| `quote_identifier` 转义为 `"we""ird"` |
| R-18 | 多条件混合逻辑 + isNull 混排 | 参数序号连续无空洞（`$1,$2` 顺序与条件顺序一致） |

## 4. vitest 用例清单

### 4.1 过滤状态 reducer（前端过滤 draft/active 状态）

| # | 用例 | 断言 |
|---|---|---|
| V-1 | `filterByFieldValue(col, value)` | 构造单条件 eq、logic=AND，覆盖旧 active，offset 归 0 |
| V-2 | NULL 值 → isNull 运算符 | 值 null 时运算符为 isNull（A-2 前端侧） |
| V-3 | Apply draft → active | draft 转 active 并触发重查（A-7 前半） |
| V-4 | 无 draft 有 active → 重放 | Ctrl+R 重放 active（A-7 中段） |
| V-5 | 二者皆无 → 保持现状 | 不重查 / 刷新当前页（A-7 尾段，兼容现状） |
| V-6 | Clear / 空条件 Apply | 等价清除，active 置空（A-12） |
| V-7 | 徽标条件数 | 条件数派生正确 |

### 4.2 命令与范围守卫

| # | 用例 | 断言 |
|---|---|---|
| V-8 | `database.data.filterByFieldValue` 等命令 enablement | table tab + DATA_GRID scope 可用；readOnly 不拦截（A-9） |
| V-9 | query tab 不注册过滤命令 | query tab 结果网格无过滤入口（A-13） |
| V-10 | Ctrl+R 焦点守卫 | input/textarea/CodeMirror 聚焦时不接管（R-B18-2） |

## 5. E2E 场景（`e2e/desktop/postgres-filter.e2e.ts`）

初版覆盖 Slice A 主链路（对应 A-1/A-8）：

1. app-lock 解锁 → 打开 PostgreSQL 工具箱 → 连接 fixture（127.0.0.1:55432 / nexterm_e2e / users 表）
2. 打开 users 表 → 记录当前行数 N（grid-edit 残留行不计较，相对断言）
3. 右键 `active` 列某非 NULL 单元格 → 菜单出现 **Filter by field value** → 点击
4. 等待行数 < N（offset 归 0 重查）；断言所有行 `active` 单元格文本 = 该单元格原值（列值匹配）
5. 清除过滤（徽标/清除入口）→ 等待行数恢复 N

后续可扩展（标注 TODO，不阻塞初版）：A-2 NULL 过滤、A-3 Custom Filter、A-4 Filter & Sort、A-5/A-6 分页边界、A-9 readOnly、A-11 编辑回归。

### 5.1 选择器预估（协作点）

fe-dev 实现未完成，下列 testid 为预估；fe-dev 完成后按实际 DOM 修正（见 §6）。

| 预估 testid | 用途 |
|---|---|
| `postgres-filter-badge` | 工具栏过滤徽标（条件数） |
| `postgres-filter-clear` | 清除过滤按钮 |
| `postgres-filter-dialog` | Filter & Sort / Custom Filter 对话框容器 |
| `postgres-filter-apply` / `postgres-filter-cancel` / `postgres-filter-clear-all` | 对话框按钮 |
| `postgres-filter-condition-row` | 对话框条件行容器 |
| 菜单项「Filter by field value」 | 右键菜单文本定位（i18n 中文） |

### 5.2 稳健性约束（WDIO 桌面已知不稳定）

- `switchWindow` 重试 4 次（冷启动慢）
- 行数断言用 `browser.execute` 页面内计算，避免 stale element 旋转
- `waitUntil` + 长超时；整体 `this.timeout(150000)`
- 唯一值 `Date.now()` 避免跨 run 碰撞
- 不做硬编码行数绝对值，只做相对断言（先 N，后 <N，再恢复 N）

## 6. 协作点与风险

| 项 | 说明 |
|---|---|
| testid 契约 | spec 初版按 §5.1 预估；fe-dev 落地后由 qa 按实际 DOM 修正选择器（本次为初版，不阻塞实现） |
| B17 残留行 | 既有 e2e_b17i_* 残留不影响相对断言；不清理历史残留，仅清理当次失败运行产生的行 |
| 环境不稳定 | WDIO WebKit 冷启动/doubleClick 已知问题；失败先查 DB 判定产品 vs 环境 |
| A-2/A-3/A-4 | 依赖对话框 UI 落地，排期后续；Rust 侧对应单测已先行覆盖语义 |
