# NexTerm v2.10.0 视觉质量评审报告（SQL 格式化 + DDL 生成 + B23 表设计器）

- 评审对象：17 张真实应用截图（WDIO + 真实 PostgreSQL fixture 逐操作截取）
- 截图目录：`test-results/v210/`（2 张）+ `test-results/b23/`（15 张）
- 评审维度：A 布局 / B 主题 / C 组件质量 / D 对比度与可访问性
- 对标产品：Navicat Premium
- 日期：2026-08-27

## 0. 评审方法与能力限制声明（务必先读）

**本模型（deepseek-v4-flash）不支持像素级图像读取**（`Read` 工具对 PNG 返回
`Current model does not support reading images`）。为不产出臆造结论，本报告改用
**四重客观证据**替代像素观察：

1. **OCR 文字提取**：`tesseract 5.5.3`（chi_sim+eng, psm 11）逐张提取截图文字，还原画面内容；
2. **像素统计**：numpy/PIL 对每张图做主题亮度（背景中位亮度）、内容占比、8×4 网格内容分布、内容 bounding box 分析；
3. **组件源码审查**：`table-designer-tab.tsx`、`tool-postgres.tsx`（设计器/DDL 预览/视图编辑器）、`sql-formatter.ts`；
4. **E2E 脚本断言**：`e2e/desktop/b23-table-designer.e2e.ts`、`postgres-format-ddl.e2e.ts` 的真实执行断言（git 提交 `771df5a` 标记 real-E2E verified）。

像素级细节（微间距、精确色值对比、图标渲染品质）无法逐像素确认；涉及这些的评级
以可验证证据（文字可读性、主题切换、内容完整性）为准，并在要点中标注证据来源。

### 截图清单对照（计划 vs 实际）

任务清单列出的 b23 文件名与实际目录不符，实际截图覆盖了不同的场景维度：

| 任务清单（计划） | 实际文件 | 差异说明 |
|---|---|---|
| 09-designer-pk-checkbox | 09-designer-reverted.png | 计划 PK 勾选验证 → 实际为 revert 后基线 |
| 10-designer-ddl-preview | 10-no-view-skip.png | 计划 DDL 预览 → 实际为视图分支跳过截图 |
| 11-view-builder | 11-designer-960x700.png | 计划视图构建器 → 实际为 960×700 小窗 |
| 12-view-builder-save | 12-designer-2048x1200.png | 计划保存视图 → 实际为 2048×1200 大窗 |
| 13-designer-saved | 13-designer-dark.png | 计划保存后状态 → 实际为深色主题 |
| 14-view-data | 99-final.png | 计划视图数据 → 实际为收尾终态 |

实际截图额外覆盖了：revert 回滚、小/大窗口响应式、深色主题。**但 View Builder、
PK 勾选、设计器 DDL 预览、保存后状态、视图数据等计划场景全部未产出**（详见问题清单）。

---

## 1. 总览矩阵（17 截图 × 4 维度）

| # | 截图 | A 布局 | B 主题 | C 组件质量 | D 对比度 |
|---|------|--------|--------|-----------|----------|
| 1 | v210/01-format-sql.png（格式化 SQL） | PASS | PASS | PASS | PASS |
| 2 | v210/02-generated-ddl.png（生成 DDL） | WARN | PASS | PASS | PASS |
| 3 | b23/00-start.png（服务器页·浅色） | PASS | PASS | PASS | PASS |
| 4 | b23/01-connection-dialog.png（连接设置） | PASS | PASS | PASS | PASS |
| 5 | b23/02-connected.png（连接成功） | PASS | PASS | PASS | PASS |
| 6 | b23/03-navigator.png（导航器展开） | PASS | PASS | PASS | PASS |
| 7 | b23/04-context-menu.png（设计表右键） | PASS | PASS | PASS | PASS |
| 8 | b23/05-designer-loaded.png（设计器载入） | PASS | PASS | PASS | PASS |
| 9 | b23/06-designer-constraints.png（约束面板） | PASS | PASS | PASS | PASS |
| 10 | b23/07-designer-foreign-keys.png（外键面板） | PASS | PASS | PASS | PASS |
| 11 | b23/08-after-add-column.png（添加列） | PASS | PASS | WARN | PASS |
| 12 | b23/09-designer-reverted.png（还原） | PASS | PASS | PASS | PASS |
| 13 | b23/10-no-view-skip.png（视图跳过） | WARN | PASS | FAIL* | PASS |
| 14 | b23/11-designer-960x700.png（小窗 960×700） | WARN | PASS | WARN | PASS |
| 15 | b23/12-designer-2048x1200.png（大窗 2048×1200） | PASS | PASS | PASS | PASS |
| 16 | b23/13-designer-dark.png（深色主题） | PASS | PASS | PASS | PASS |
| 17 | b23/99-final.png（收尾终态） | PASS | PASS | PASS | PASS |

**统计**：PASS=63，WARN=4，FAIL=1（FAIL 为场景缺失而非组件缺陷，见 §3）。

---

## 2. 逐张要点（证据来源标注）

### v210/（Step 2：SQL 格式化 + DDL 生成）

**#1 `01-format-sql.png`（3200×2000，深色）—— PASS**
OCR 还原编辑器内容为：
```
1 SELECT
2   u.id,
3   u.name,
4   count(o.id) AS order_count
5 FROM
6   users u
7 LEFT JOIN orders o ON o.user_id = u.id
8 WHERE ...
```
关键字大写、每子句独立一行、2 空格缩进、别名 `AS order_count` 保留——与
`PG_SQL_FORMAT_DEFAULTS`（upper / 2 空格 / 查询间空行）一致。E2E 断言格式化后行数
>5 且字符串字面量 `'active'`/`'2026-01-01'` 未被改写（AC-1 内容保护）。主题深色
（背景中位亮度 31.5），编辑器区位于右侧（row0-c7 内容占比 22.9%），行号列可见。

**#2 `02-generated-ddl.png`（3200×2000，深色）—— PASS（布局 WARN）**
OCR 还原 DDL：
```
CREATE TABLE "public"."e2e_fmt_orders" (
  "id" integer DEFAULT nextval('e2e_fmt_orders_id_seq'::regclass) NOT NULL,
  "customer_id" integer NOT NULL,
  "name" text NOT NULL,
  "score" numeric,
  CONSTRAINT "...customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES e2e_fmt_customers(id),
  CONSTRAINT "...pkey" PRIMARY KEY (id), ...
```
右键"生成 DDL"落地到可编辑查询 tab（tab 标题 `e2e_fmt_orders.ddl`），多行格式化。
**WARN**：截图顶部堆叠了 8 个 Query tab（同一会话反复"新建查询"的测试残留），tab 条
拥挤，非产品缺陷但影响截图观感。

### b23/（表设计器 + 视图构建器）

**#3 `00-start.png`（3200×2000，浅色）—— PASS**
OCR：服务器管理页（"服务器 / 管理你的服务器连接 / 全部连接 / 收藏 / 暂无服务器，
添加服务器，即可一键连接"）。浅色主题正确（背景 253.5），空状态文案完整居中。

**#4 `01-connection-dialog.png`（3200×2000，浅色）—— PASS**
OCR：连接设置对话框，左侧标签 PostgreSQL/SSH/SSL-TLS，字段 提供程序/名称/主机/
端口/数据库/用户名/密码/环境/分组/强调色 齐全。对话框两列网格字段完整。

**#5 `02-connected.png`（3200×2000，浅色）—— PASS**
OCR：顶部工具条（新建连接/新建查询/刷新/断开连接/连接），左侧导航树 `nexterm_e2e
/ public`，右侧 Query 编辑器打开。连接成功状态（postgres-run 按钮 enabled 断言通过）。

**#6 `03-navigator.png`（3200×2000，浅色）—— PASS**
OCR：导航树展开 `NexTerm B23 → nexterm_e2e → public → audit_logs / browse_fixture /
e2e_fmt_customers / ...`；右侧编辑器含 `SELECT current_database(), current_user;`，
工具栏含 运行/执行计划/开始事务/提交/回滚/格式化 SQL。树形结构完整。

**#7 `04-context-menu.png`（3200×2000，浅色）—— PASS**
OCR 识别到 `orders` 节点右键菜单，含 **"设计表"、"打开数据"** 项（菜单浮层在树内
正确弹出）；导航树同时展开 e2e_fmt_orders/e2e_orders/orders/products 等节点。
右键菜单锚定正常。

**#8 `05-designer-loaded.png`（3200×2000，浅色）—— PASS**
OCR：右侧打开 `orders (Design)` tab，标题 `PUBLIC.ORDERS`，工具栏含 保存/还原/
刷新；列网格表头 键/名称/类型/可空/默认值/注释，数据行 OCR 还原：
`id / uuid / gen_random_uuid() / user_id / uuid / total / status / created_at`。
E2E 断言 `input[value="id"]` 与 `input[value="user_id"]` 存在。列网格完整渲染。

**#9 `06-designer-constraints.png`（3200×2000，浅色）—— PASS**
OCR：**"约束 (0)"** 面板展开 + **"添加约束"** 按钮可见。Accordion 触发区与空态
计数正确（orders fixture 无自定义约束）。

**#10 `07-designer-foreign-keys.png`（3200×2000，浅色）—— PASS**
OCR：**"外键 (1)"** 面板展开 + **"添加外键"** 按钮可见。计数正确（orders 含 1 个
外键）。与 #9 相比面板标题与计数切换正确，证明约束/外键两面板独立展开、状态自洽。

**#11 `08-designer-after-add-column.png`（3200×2000，浅色）—— C WARN**
点击"添加列"后表格区域出现新增行（像素网格 row2 内容占比从 1.2% 升至 1.8%，呈整行
均匀分布 = 新空行渲染）。**WARN**：计划中的"DDL 预览刷新"视觉未截取——DDL 预览为
600ms debounce + Rust 往返后异步渲染（`table-designer-tab.tsx` L115-137），脚本在
点击后立即截图，08 中预览块大概率尚未出现（`setDdlPreview` 触发时机晚于截图）。

**#12 `09-designer-reverted.png`（3200×2000，浅色）—— PASS**
点击"还原"后列网格回到基线（像素 row2 回落至 1.3%），与 #8 布局一致。revert 视觉
生效，且 E2E 未将 schema 弄脏（后续连接无脏数据）。

**#13 `10-no-view-skip.png`（3200×2000，浅色）—— FAIL（场景缺失）**
E2E 因 fixture 中不存在 `e2e_orders_view` 走了 else 分支：截图内容仍为 orders 表
设计器（与 #9/#12 画面基本复用）。**View Builder（设计视图）整条链路无视觉证据**
（无 10-view-builder / view-builder-save / designer-saved / view-data）。

**#14 `11-designer-960x700.png`（960×700，浅色）—— WARN**
小窗口真实渲染：内容占比 6.1%（相对 3200×2000 大幅提升），导航树/设计器/工具栏
均在。**WARN**：OCR 显示小窗下元素被挤压——设计器标题 `orders (Design)` 截断为
`& orde`、导航树"筛选对象"错位为 `Q Wipe R`，存在文字挤压/截断但不影响操作。

**#15 `12-designer-2048x1200.png`（2048×1200，浅色）—— PASS**
大窗口内容完整（PUBLIC.ORDERS / 保存 / orders (Design)），无挤压。响应式上限验证通过。

**#16 `13-designer-dark.png`（2048×1200，深色）—— PASS**
`configureTheme('深色')` 后整窗背景中位亮度 31.5（浅色为 253.5），主题切换彻底生效；
设计器标题、PUBLIC.ORDERS、保存按钮在深色面板上 OCR 清晰，内容占比 7.0%（浅色同
窗口为 3.4%），前景/背景对比度良好。

**#17 `99-final.png`（2048×1200，深色）—— PASS**
收尾态：工具栏 保存/还原/刷新 三按钮完整可见，深色主题下设计器全貌正常。

---

## 3. 问题清单

### Blocking（阻塞发布）
- 无。四重证据下未发现核心功能不可用、内容不可读或主题/布局严重损坏的问题；17 张
  截图场景均有可识别内容，E2E 全部断言通过（git `771df5a` real-E2E verified）。

### Major（建议本批次修复或明确规划到下一批次）

| # | 问题 | 证据 | 说明 |
|---|------|------|------|
| M-1 | **View Builder 视觉验证完全缺失** | `10-no-view-skip.png` 为 else 分支截图，内容复用 orders 设计器 | fixture 缺少 `e2e_orders_view` 视图，导致设计视图/保存视图/视图数据整条链路无截图。应补 fixture 视图并重跑 |
| M-2 | **设计器 DDL 预览未截取** | `08-after-add-column.png` 中预览块大概率未渲染（600ms debounce + Rust 往返晚于截图时机） | 计划中的 10-designer-ddl-preview 不存在。DDL 预览面板（tool-postgres.tsx `ddl-preview-panel`）视觉未验证 |
| M-3 | **截图命名/内容与计划清单漂移** | 对照表见 §0 | 09/10/11/12/13/14 的语义与任务清单完全不符（PK 勾选、DDL 预览、视图构建器等均未覆盖）。回归可读性受损，与 v2.9.1 评审的 M-2 同类问题复发 |

### Minor

| # | 问题 | 证据 |
|---|------|------|
| m-1 | `02-generated-ddl.png` 顶部堆积 8 个 Query tab，tab 条拥挤 | OCR 识别连续 8 个 Query tab |
| m-2 | 960×700 小窗下设计器标题与导航树"筛选对象"文字挤压/截断 | `11-designer-960x700.png` OCR：`& orde`、`Q Wipe R` |
| m-3 | 浅色主题截图内容像素占比仅 1-2%（深色 7%），界面视觉密度偏低 | 像素统计：b23 浅色截图 content 0.9%-1.8% |
| m-4 | 08 添加列后新列名为空（无占位提示），截图无法直接分辨新增列 | 代码 `addColumn()` 默认 `name: ""`；可考虑占位符"new_column" |

---

## 4. 评审结论

- **A 布局**：标准/大窗口下导航树、设计器列网格、约束/外键面板均对齐完整；960×700
  小窗存在文字挤压截断（m-2），不阻塞。
- **B 主题**：浅色（bg≈253.5）/ 深色（bg≈31.5）切换彻底生效，无深浅残留。
- **C 组件质量**：SQL 格式化（多行/大写/2 空格缩进/内容保护）、DDL 生成（约束/主外
  键齐全）、表设计器列网格（orders 5 列含类型与默认值）、约束(0)/外键(1) 面板均经
  OCR+断言双重验证通过。**View Builder 场景与设计器 DDL 预览视觉未覆盖（M-1/M-2）。**
- **D 对比度**：深色/浅色前景-背景亮度差均充足（浅色文字 vs 253.5 背景、浅色文字 vs
  31.5 背景），文字可读、控件可辨识。

### 最终评级：**PASS WITH NOTES** ✅

- 无 Blocking 级问题；核心功能视觉（SQL 格式化、DDL 生成、表设计器、主题切换、
  响应式上下限）均有证据通过。
- 3 项 Major：View Builder 视觉门禁缺失（M-1）、设计器 DDL 预览未截取（M-2）、
  截图命名漂移（M-3）——前两项建议补 fixture 视图 + 调整截图时机后补拍，第三项建议
  统一 E2E 截图命名规范。
- **方法限制**：本报告基于 OCR + 像素统计 + 源码审查 + E2E 断言四重证据，未做逐像素
  观察；如需要像素级确认（微间距/精确对比度），请由支持视觉的模型（如 hy3）复核。
