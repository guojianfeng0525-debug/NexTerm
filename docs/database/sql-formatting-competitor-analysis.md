# SQL 格式化 + DDL 展示 + 执行选中：竞品分析与功能范围确认

> 作者：pm（竞品分析）｜日期：2026-08-26
> 用户需求（2026-08-26 21:08，**取代原 B24 ER 图**）：
> 1. **SQL 格式化显示**（美化/pretty-print SQL）
> 2. **DDL 点击表名立即在右侧格式化后展示**（导航器点击表/视图名 → 右侧面板立即显示格式化 DDL，非数据网格）
> 3. **支持执行选中 SQL + 相应快捷键**（选择编辑器中的 SQL 片段执行 + 快捷键）
>
> 竞品范围：主竞品 **Navicat Premium 17.3**；参考 **JetBrains DataGrip**、**DBeaver**（桌面版）。
> 本文件只做竞品分析与范围建议，不修改代码。实现范围以 team-lead 批准的批次计划为准。

---

## 0. 摘要与结论（TL;DR）

| # | 功能 | 竞品都有？ | 定性 | 推荐优先级 |
|---|---|---|---|---|
| 1 | SQL 格式化 | ✅ 三工具均有 | **Navicat parity**（行为对齐）+ 少量差异化（可配置选项持久化） | P0 |
| 2 | 点击表名 → 右侧立即展示格式化 DDL | ❌ **无直接竞品对应** | **差异化增强**（交互形态参考 Navicat 信息窗格 + DataGrip DDL 页签 + 编辑器预览） | P0 |
| 3 | 执行选中 SQL + 快捷键 | ✅ 三工具均有 | **Navicat parity**（语义）+ **快捷键并集策略**（⌘↩ DataGrip/DBeaver 系 + ⌘R/⌘⇧R Navicat 系） | P0 |

- **关键差异化**：功能 2 是三大主流工具都没有的交互，属于 NexTerm 差异化机会，且与现有 `browse()`（双击→数据网格）不冲突：**单击 = DDL 预览面板，双击 = 打开数据**。
- **关键快捷键决策**：现有 B19 的 `⌘E` 已是"运行选中或当前语句"，建议**新增 `⌘↩`（Cmd+Enter）绑定同一语义**（对齐 DataGrip/DBeaver 用户肌肉记忆），`⌘⇧R` 保留"运行当前语句"（Navicat 系）、`⌘R` 保留"运行全部"（Navicat 系）。三者互为别名不冲突，scope 路由解决。
- **技术选型建议**：格式化器用成熟库 `sql-formatter`（纯 JS、零运行时依赖、原生支持 PostgreSQL dialect、可配置 `keywordCase`/`indent`/`linesBetweenQueries`），可同时服务"查询编辑器格式化"与"DDL 面板格式化"两个入口。

---

## 1. NexTerm 现状基线（v2.9.0 代码审计，勿重复实现）

| 能力 | 现状 | 位置 |
|---|---|---|
| 执行全部 | ✅ `⌘R`（query tab）→ `postgres_execute` | `tool-postgres.tsx:1677` `execute()` :752 |
| 运行当前语句 | ✅ `⌘⇧R` → `runCurrentStatement()`（复用 `currentStatementAt`） | `tool-postgres.tsx:803` |
| 运行选中/当前语句 | ✅ `⌘E` → `runSelectionOrStatement()`（有选区执行选区，无选区执行当前语句） | `tool-postgres.tsx:815` |
| 停止 | ✅ `⌘T`（运行中）→ `postgres_cancel` | `tool-postgres.tsx:789` |
| 注释切换 | ✅ `⌘/` → `toggleLineComment` | `tool-postgres.tsx:831` |
| SQL 语句 tokenizer（前端镜像 Rust lexer） | ✅ 支持 `'`/`"` 引号、`--`/`/* */` 注释、`$tag$` dollar-quote、嵌套块注释 | `src/lib/database/sql-statement-tokenizer.ts` |
| DDL 生成命令 | ✅ `postgres_object_ddl`（table/view/materializedView/function/sequence/index） | Rust `postgres_catalog.rs:862` |
| DDL 右键入口 | ✅ 右键对象 → 「生成 DDL」→ 打开只读 query tab（`generateObjectDdl` :883） | `tool-postgres.tsx:1976` |
| DDL 输出形态 | ⚠️ 表 DDL 已基础多行化（每列一行、4 空格缩进、约束/索引追加），但视图/函数依赖 `pg_get_viewdef`/`pg_get_functiondef`（单行或压缩形态），**无统一美化层** | Rust `postgres_catalog.rs:350-419` |
| SQL 格式化器 | ❌ **完全缺失**（无 sql-formatter 等依赖，无格式化入口） | — |
| 点击表名 → 右侧 DDL 面板 | ❌ 无。当前导航器单击表仅 `onSelect`（选中状态），双击 → `browse()` 数据网格 | `tool-postgres.tsx:1849/1866` |
| 命令注册器 QUERY_EDITOR scope | ✅ 已有 execute/explain/toggleComment/openFile/stop 五个命令；**无 format 命令** | `src/lib/database/command-registry.ts:268-310` |

**结论**：功能 3（执行选中）的引擎已具备 80%，本批次主要是**语义补齐（⌘↩ 绑定 + 显式"运行选中"入口）**；功能 1、2 为全新能力，共享一个格式化器 + DDL 面板即可。

---

## 2. 证据等级说明（沿用仓库 UNVERIFIED 协议）

| 标记 | 含义 |
|---|---|
| 【官方】 | 厂商官方文档/官方博客确认 |
| 【M17】 | Navicat 17 Windows 手册（仓库已审计 `navicat-premium-interactions.md` / `-shortcuts.md`） |
| 【第三方】 | 社区教程/技术博客，单点来源不可靠，**需运行时验证** |
| UNVERIFIED | 官方来源未建立该精确行为，**不得声称 parity、不得发明命令** |

> Navicat 的「格式化 SQL」快捷键在官方手册 Hot Keys（M17 p.379-381）**未收录**（仓库 shortcuts.md 已审计确认），下方 Navicat 快捷键均标【第三方】。

---

## 3. 一、SQL 格式化

### 3.1 功能矩阵

| 维度 | Navicat Premium | DataGrip | DBeaver |
|---|---|---|---|
| 菜单路径 | 格式 → 美化 SQL（Format → Format SQL）；查询编辑器工具栏「美化 SQL」按钮【第三方】 | Code → Reformat Code（SQL 场景显示 Reformat SQL）【官方】 | 右键 SQL 编辑器 → Format SQL；无独立顶级菜单【官方 Team Edition】 |
| 快捷键 | Windows `Ctrl+Shift+B` / macOS `Cmd+Shift+B`【第三方】；另有说法 `Ctrl+F7` / `Ctrl+Shift+F`【第三方，说法不一 → UNVERIFIED】 | macOS `⌘⌥L` / Win `Ctrl+Alt+L`【官方】 | macOS `⇧⌘F` / Win `Ctrl+Shift+F`【官方 Team Edition + 多个第三方一致】 |
| 前置开关 | 「工具 → 选项 → 编辑器 → SQL 格式化」勾选 Enable，**重启生效**【第三方】 | 无（内置 always-on） | 无（内置） |
| 格式化选项 | 关键字大写（Uppercase keywords）、缩进字符数（默认 4）、短括号长度（控制 `IN (1,2,3)` 是否单行）、Wrap after N 字符（80~100）【第三方】 | Settings → Editor → Code Style → SQL：关键字大小写、对齐、换行、缩进；**按数据源 dialect 分别配置**【官方】 | Preferences → Editors → SQL Editor → Formatting：关键字大小写（Default/UPPER/lower/Capitalize）、缩进大小、空行数、SELECT/JOIN/WHERE 换行规则【官方】 |
| 作用范围 | 无选中 → 全文；有选中 → 仅选中段【第三方，与另两工具一致】 | 无选中 → 整个文件/选区；有选中 → 仅选区【官方】 | 无选中 → 整个脚本；有选中 → 仅选区【官方】 |
| 输出默认形态 | 关键字大写、每子句一行、缩进换行 | 关键字大写、运算符两侧空格、SELECT 列表列对齐、WHERE 条件 2 空格对齐缩进 | 关键字大写、子句首列对齐、保留较短子句同行 |
| 第三方 formatter 插件 | ❌ 不提供（自带原生） | ✅ 内置 SQL dialect 解析器 | ✅ 可切换第三方 formatter（如 SQLFormatter） |
| 快捷键自定义 | ✅ 选项 → 快捷键（第三方） | ✅ Settings → Keymap | ✅ Preferences → General → Keys |

**NexTerm 建议对齐目标**：以 **DBeaver `⇧⌘F`** 为格式化主快捷键（跨工具最一致），行为采用**无选中=全文、有选中=选区**的三工具共识；默认配置采用**关键字大写 + 缩进 2~4 空格 + 子句换行**（详见 3.2）。

### 3.2 示例 SQL 格式化对比

输入（压缩形态，所有工具通用输入）：

```sql
SELECT u.id,u.name,count(o.id) AS order_count FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.status='active' AND u.created_at>='2026-01-01' GROUP BY u.id,u.name HAVING count(o.id)>0 ORDER BY order_count DESC LIMIT 10;
```

**Navicat 预期输出**（默认：关键字大写、缩进 4）【第三方还原，需真机验证】：

```sql
SELECT
    u.id,
    u.name,
    COUNT(o.id) AS order_count
FROM
    users u
    LEFT JOIN orders o ON o.user_id = u.id
WHERE
    u.status = 'active'
    AND u.created_at >= '2026-01-01'
GROUP BY
    u.id,
    u.name
HAVING
    COUNT(o.id) > 0
ORDER BY
    order_count DESC
LIMIT 10;
```

**DataGrip 预期输出**（默认 Code Style：关键字大写、SELECT 列对齐、WHERE 缩进 2）【官方行为还原】：

```sql
SELECT u.id,
       u.name,
       COUNT(o.id) AS order_count
FROM users u
         LEFT JOIN orders o ON o.user_id = u.id
WHERE u.status = 'active'
  AND u.created_at >= '2026-01-01'
GROUP BY u.id, u.name
HAVING COUNT(o.id) > 0
ORDER BY order_count DESC
LIMIT 10;
```

**DBeaver 预期输出**（默认：关键字大写、子句同行优先）【官方行为还原】：

```sql
SELECT u.id, u.name, COUNT(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.status = 'active' AND u.created_at >= '2026-01-01'
GROUP BY u.id, u.name
HAVING COUNT(o.id) > 0
ORDER BY order_count DESC
LIMIT 10;
```

**对比要点**：
1. 三工具共同点：关键字统一大写（默认）、`=` 等运算符两侧加空格、`AS` 保留、字符串/注释内容不被改写。
2. 差异集中在**换行激进程度**：Navicat 最激进（每个子句/每个 SELECT 项独立一行）；DataGrip 折中（保留行内但做列对齐）；DBeaver 最保守（短子句保持同行）。
3. **NexTerm 建议默认取 Navicat 风格**（子句换行 + 缩进），因为本产品对标 Navicat，且 DDL 面板/长 DDL 场景下 Navicat 风格可读性最好；关键字大写、缩进宽度做成可配置项（P1）。
4. 验证要求：三种"预期输出"须在真实安装（Navicat 17.3 / DataGrip 最新 / DBeaver 桌面版）跑同一段输入截图留档后再最终定稿默认配置（避免按二手来源猜测）。

---

## 4. 二、DDL 展示

### 4.1 功能矩阵（「查看 DDL」在竞品中的真实入口）

| 维度 | Navicat Premium | DataGrip | DBeaver |
|---|---|---|---|
| 双击表（List/Detail 视图） | 打开 **Table Viewer（数据网格）**；ER 视图下双击 → 表设计器【M17 IN-02】 | 打开表查看器（Table Viewer，数据网格 + 内容/DDL/权限页签）【官方】 | 打开数据编辑器（Data Editor）【官方】 |
| 查看完整 DDL | 表设计器右下角 **SQL 预览（DDL 预览）**【M17 间接】；右键 → 对象信息（Object Info）查看属性（非完整 DDL）【UNVERIFIED】 | 右键表 → SQL 生成器 → **生成 DDL**（Generate DDL，写入编辑器）【官方】；`⌘B`/`⌘↓` **转到定义**（跳转 DDL 文件）【官方】 | 右键表 → **生成 SQL → DDL**（Generate SQL → DDL，打开 SQL 编辑器）【官方】；`F4` 实体属性 |
| 单击表名 → 右侧立即显示 DDL | ❌ 无。单击仅选中；最接近是**信息窗格（Information Pane，View → 信息窗格）**显示对象属性摘要（非 DDL）【M17 UNVERIFIED】 | ❌ 无。单击选中，双击打开；但**表查看器含 DDL 页签**（打开后右侧多页签查看）【官方】 | ❌ 无。单击选中，双击打开数据【官方】 |
| 视图/物化视图 DDL | 同表（设计器 SQL 预览）【UNVERIFIED】 | Generate DDL 支持 view【官方】 | Generate SQL → DDL 支持 view【官方】 |
| 函数/序列/索引 DDL | 函数设计器 / 对象信息【UNVERIFIED】 | `⌘B` / Generate DDL【官方】 | Generate SQL → DDL【官方】 |

**结论**：三大工具**均没有「单击导航器表名 → 右侧面板立即展示 DDL」的交互**。「立即查看 DDL」最接近的三条路径是：Navicat 设计器 SQL 预览（需进入设计器）、DataGrip 表查看器 DDL 页签（需双击打开）、DBeaver 右键生成 DDL（需右键+弹编辑器）。三者都是**多步操作**，用户诉求"点击即见"是无竞品对应的**效率型差异化**。

### 4.2 「点击表名 → 右侧格式化 DDL」差异化方案建议

**交互形态**（推荐）：

```
┌──────────────┬──────────────────────────────────────────┐
│  导航器树     │  右侧面板（复用现有 workspace 区域）        │
│  ▸ 连接       │  ┌─ DDL 预览：public.users ───────────┐  │
│   ▸ public   │  │  [复制] [刷新] [在查询编辑器打开]     │  │
│    ▸ 表      │  │  CREATE TABLE "public"."users" (     │  │
│     ▸ users←│  │    "id" serial NOT NULL,             │  │
│     ▸ orders │  │    "name" varchar(100),             │  │
│    ▸ 视图     │  │    CONSTRAINT users_pkey PRIMARY ... │  │
│             │  │  );                                  │  │
│             │  │  （只读 CodeMirror + SQL 高亮）         │  │
└──────────────┴──────────────────────────────────────────┘
```

要点：
1. **单击（single-click）表/视图/物化视图** → 右侧内嵌只读 `CodeEditor`（`readOnly`，已有能力）显示格式化 DDL；**双击仍走 `browse()` 数据网格**，不破坏现有交互（对齐 M17 IN-02 双击语义）。
2. **防抖 300ms** 避免在连接/schema 上快速移动时频繁请求；仅 relation 类型触发，连接/schema/函数等不触发（P1 再扩展到函数/序列/索引）。
3. 数据来源复用现有 `postgres_object_ddl`（Rust 已就绪），前端过同一 formatter（与功能 1 共用 `sql-formatter`）后渲染——**"格式化 DDL"不再依赖 Rust 输出形态**（解决 §1 现状：视图/函数 DDL 目前是单行压缩的）。
4. 面板操作：`复制`（写剪贴板）、`刷新`（重查 catalog）、`在查询编辑器打开`（调用现有 `generateObjectDdl` 打开可编辑 query tab，面板保持只读）。
5. 面板状态：加载中（骨架/spinner）、错误（显示错误 + 重试按钮）、空态（未连接/未选中对象时提示）。
6. **持久化**：面板开关/宽度随现有 splitter/workspace 布局持久化机制（P2）。

**差异化价值**：`SELECT` 快速核对表结构 → 无需双击打开数据页、无需右键三级菜单；这是 NexTerm 相对 Navicat/DataGrip/DBeaver 的可宣传差异点（"点一下看 DDL"），在后续 marketing/功能矩阵中标记为 **Differentiator**。

---

## 5. 三、执行选中 SQL

### 5.1 功能矩阵（执行相关行为）

| 维度 | Navicat Premium | DataGrip | DBeaver |
|---|---|---|---|
| 运行全部 | `⌘R`（Windows Ctrl+R）【M17 确认】；工具栏 Run | Run 'query file' `Ctrl+Shift+F10`【官方】 | Execute Script `⌥X`（Win Alt+X）【官方 Team Edition】 |
| 运行当前语句 | `⌘⇧R`（Windows Ctrl+Shift+R）【M17 确认】 | 无独立键；⌘↩ 无选中时执行当前语句【官方】 | `⌘↩`/`⌃↩`（Win Ctrl+Enter）无选中时执行当前语句【官方】 |
| **运行选中** | 工具栏「运行选中」按钮；菜单 Query → Run Selected；**官方快捷键 UNVERIFIED**（第三方说法 `F9`/`Ctrl+Enter`） | `⌘↩`（Cmd+Enter）：有选区执行选区（Execute Selection），**多语句弹建议列表**，待执行语句高亮【官方】 | `⌘↩`/`⌃↩`：有选区执行选区【官方】 |
| 停止 | `⌘T`（Windows Ctrl+T）【M17 确认】 | 停止/取消 ⌘F2（调试系）【官方】 | 无绑定（依赖连接取消）【官方】 |
| 选中当前语句 | `⌘E`（Windows Ctrl+E，**仅选中不执行**）【M17 确认】 | — | — |
| 执行反馈 | 结果区显示 | 执行中语句**编辑器内高亮**；多结果 Tab【官方】 | 结果面板多 Tab【官方】 |

### 5.2 快捷键冲突矩阵（macOS）

NexTerm 现状 = B19 已注册绑定（`tool-postgres.tsx:1583-1693`）。`⌘` 为 macOS 主修饰键（仓库决策：macOS 用 ⌘ 等价映射，非 Navicat 官方事实，见 shortcuts.md）。

| 组合键 | Navicat（macOS 映射） | DataGrip | DBeaver | NexTerm 现状 | 冲突评估与决策 |
|---|---|---|---|---|---|
| `⌘R` | 运行全部【M17】 | 替换（编辑器内 Replace） | 刷新数据（数据网格） | ✅ 运行全部（query）/ 刷新（table/navigator） | **低**：scope 路由（QUERY_EDITOR 内=运行，其余保持现状） |
| `⌘⇧R` | 运行当前语句【M17】 | 运行上下文配置（run） | — | ✅ 运行当前语句 | **低**，保留 |
| `⌘E` | 选中当前语句【M17】 | **最近文件**（Recent Files） | 切换编辑器 | ✅ 运行选中或当前语句 | **中**：DataGrip/DBeaver 用户会误触"最近文件"。但 NexTerm 语义≈Navicat `⌘E`（选中当前语句）的强化版，**保留**；在文档中明示差异 |
| `⌘↩` | 网格单元格编辑器（Ctrl+Enter）【M17】 | **执行**（Execute） | **执行**（Execute） | ⚠️ query tab 绑定为「运行全部」`execute()` | **中**：与 DataGrip/DBeaver 肌肉记忆冲突（他们期待⌘↩=执行选中或当前）。**建议改为执行选中或当前语句**（与 `⌘E` 同语义），`⌘R` 继续承载"运行全部" |
| `⌘⇧F` | 格式化（第三方说法，UNVERIFIED） | 在文件中查找 | **格式化 SQL** | 未绑定 | **建议绑定为格式化 SQL**（与 DBeaver 一致）；无全局占用 |
| `⌘⌥L` | — | 重新格式化代码 | — | 未绑定 | 可选：绑定格式化（DataGrip parity 别名） |
| `⌥X` | — | — | 执行脚本（Execute Script） | 未绑定 | 可选：绑定"运行全部"别名（DBeaver parity） |
| `⌘T` | 停止【M17】 | 重构此代码 | — | ✅ 停止（仅 running 时） | **低**，保留 |
| `⌘/` | 注释【M17】 | 行注释 | 行注释 | ✅ 注释切换 | **低**，保留 |
| `⌘⇧B` | 格式化（第三方说法，UNVERIFIED） | — | — | 未绑定 | **不采用**（与 VS Code build/部分 IDE 冲突风险，且与 `⌘⇧F` 重复） |
| `⌘N` | 新增记录（网格）/ 新建查询【M17】 | 生成 | 新建 SQL 编辑器 | ✅ 新建查询 | **低**，保留 |
| `⌘⇧E` | — | — | 显示执行计划（DBeaver） | ✅ EXPLAIN | 与 DBeaver `⌘⇧E`=执行计划 **语义恰好一致**，保留 |

**冲突解决总则**（延续 master plan D2 / shortcuts.md）：所有键按 scope 路由 `QUERY_EDITOR > DATA_GRID > NAVIGATOR > GLOBAL`；xterm textarea 永不拦截；非 QUERY_EDITOR 聚焦时新绑定一律不注册。

**本批次建议的最终快捷键表（macOS）**：

| 动作 | 主绑定 | 别名 | 对应竞品 |
|---|---|---|---|
| 格式化 SQL（全文/选区） | `⌘⇧F` | `⌘⌥L`（可选） | DBeaver / DataGrip |
| 运行选中或当前语句 | `⌘↩`（**新增**） | `⌘E`（已有） | DataGrip / DBeaver / Navicat ⌘E 语义 |
| 运行当前语句 | `⌘⇧R`（已有） | — | Navicat |
| 运行全部 | `⌘R`（已有） | `⌥X`（可选） | Navicat / DBeaver |
| 停止 | `⌘T`（已有） | — | Navicat |
| 注释切换 | `⌘/`（已有） | — | 三工具 |

> ⚠️ 注意：将 `⌘↩` 从"运行全部"改为"执行选中或当前语句"是**行为变更**，需要回归 B19 的查询快捷键 E2E（`postgres-query-commands.e2e.ts`）并同步更新 shortcuts 台账。此决策建议在批次评审中显式确认。

---

## 6. 功能确认建议（P0 / P1 / P2 + AC 草案）

### 6.1 功能 1：SQL 格式化（P0）

**范围**：
- P0-1 查询编辑器「格式化」：工具栏按钮 + `⌘⇧F`；无选中=全文，有选中=仅选区；默认规则 = 关键字大写、子句换行、2~4 空格缩进（3.2 Navicat 风格）、dollar-quote/字符串/注释内容不变。
- P0-2 注册 `database.query.format` 命令（QUERY_EDITOR scope，command-registry 补命令）。
- P1-1 格式化选项对话框：关键字大小写、缩进宽度（2/4/tab）、换行宽度、查询间空行；持久化到 `editor-config`（复用 `EDITOR_CONFIG_CHANGED_EVENT` 机制）。
- P2-1 压缩/反压缩切换（minify ↔ pretty）；多 dialect 配置（MySQL/SQLite 跟随 provider）。

**AC 草案**：
- AC-1 查询编辑器粘贴压缩多语句 SQL → `⌘⇧F` → 全文按默认规则美化；字符串/`'...'`、注释 `--`/`/* */`、`$tag$...$tag$` 内容不被改写（用 `sql-statement-tokenizer` 的 lexer 规则做格式化后断言）。
- AC-2 选中部分 SQL → 格式化只作用于选区，选区外文本逐字节不变。
- AC-3 格式化前后 `splitSqlStatements` 切出的语句集合一致（语句边界不被破坏）。
- AC-4 P1：修改关键字大小写/缩进设置 → 重新格式化生效且设置重启后保留。
- AC-5 焦点在终端/网格/对话框时 `⌘⇧F` 不触发；readOnly 编辑器无格式化入口。

**parity/差异化**：行为 parity（三工具共识）；差异化 = 选项持久化 + 与 DDL 面板共用引擎。

### 6.2 功能 2：DDL 点击展示面板（P0）

**范围**：
- P0-1 导航器**单击**表/视图/物化视图 → 右侧只读面板展示**格式化 DDL**（复用 `postgres_object_ddl` + 功能 1 formatter）；双击行为不变（数据网格）。
- P0-2 面板操作：复制 / 刷新 / 在查询编辑器打开；加载/错误/空三态。
- P1-1 300ms debounce + 导航选择切换即时更新；函数/序列/索引 DDL 预览。
- P2-1 面板开关与宽度持久化；面板内折叠（表体/索引/注释分节）；跟随 schema 过滤。

**AC 草案**：
- AC-1 连接后单击表名 → 面板 ≤ 1s 内显示该表格式化 `CREATE TABLE` DDL（含列、默认值、NOT NULL、约束、索引）。
- AC-2 单击视图 → 显示 `CREATE OR REPLACE VIEW`；单击物化视图同理。
- AC-3 双击表 → 仍打开数据网格 tab（回归现有 `browse` E2E）。
- AC-4 「复制」写入剪贴板完整 DDL；「在查询编辑器打开」落到可编辑 query tab 且面板不变。
- AC-5 catalog 查询失败 → 面板显示错误 + 重试按钮；导航器其他操作不受影响。
- AC-6 DDL 输出经过前端 formatter（关键字大写/换行），即使 Rust 侧返回单行也展示为多行。

**parity/差异化**：**差异化增强（Differentiator）**——无直接竞品对应；交互形态复用 Navicat 信息窗格的位置心智 + DataGrip DDL 页签的内容心智。

### 6.3 功能 3：执行选中 SQL + 快捷键（P0）

**范围**：
- P0-1 `⌘↩` 绑定为「运行选中或当前语句」（与 `⌘E` 同语义），并在工具栏/右键菜单增加显式「运行选中」入口（当前仅有 `⌘E` 隐式入口）。
- P0-2 保持 `⌘R` 运行全部 / `⌘⇧R` 运行当前语句 / `⌘T` 停止（B19 已有）。
- P1-1 执行时**编辑器内高亮当前语句/选区**（DataGrip 反馈）；多语句选区按序执行并分别展示结果。
- P2-1 执行历史、参数化执行、结果 Tab 复用（Alt+0..9）。

**AC 草案**：
- AC-1 选中一段 SQL → `⌘↩` → 仅执行选区，结果区只显示选区结果；选区外语句不执行。
- AC-2 无选区、光标在某语句内 → `⌘↩` 执行该语句（复用 `currentStatementAt`，现有 tokenizer）。
- AC-3 多语句全选 → `⌘↩` 顺序执行全部并展示各结果（P1 高亮）；`⌘R` 行为不变（运行全部）。
- AC-4 运行中 `⌘T` 可停止（已有）；readOnly/未连接时命令禁用。
- AC-5 QUERY_EDITOR scope 外（终端/网格/对话框）`⌘↩`/`⌘E` 不拦截；网格内 `⌘↩` 仍是单元格编辑器（scope 路由）。

**parity/差异化**：执行选中语义为 parity；差异化 = **双绑定并集**（`⌘↩` DataGrip/DBeaver 系 + `⌘⇧R` Navicat 系）+ 执行语句高亮反馈。

### 6.4 parity vs 差异化总表

| 功能 | 定性 | 对标来源 | 差异化点 |
|---|---|---|---|
| SQL 格式化 | Navicat parity | Navicat/DBeaver `⇧⌘F`、无选中全文/有选中选区、关键字大写默认 | 选项持久化（P1）、与 DDL 面板共用引擎 |
| 点击表名 → 右侧 DDL | **差异化增强** | 无直接对应；参考 Navicat 信息窗格 + DataGrip DDL 页签 | 单击即见、只读预览面板、防抖切换 |
| 执行选中 SQL | Navicat parity | Navicat `⌘⇧R`/`⌘R` + DataGrip/DBeaver `⌘↩` | 双绑定并集、执行语句高亮（P1） |

---

## 7. 风险与待验证项

| # | 项 | 等级 | 处置 |
|---|---|---|---|
| R-1 | Navicat 格式化快捷键/选项均来自【第三方】，官方手册 M17 未收录 | 中 | 文档已标注；实现对齐以 DBeaver/DataGrip【官方】为准，Navicat 侧待 17.3 真机截图留档 |
| R-2 | 3.2 三种"预期输出"为按默认配置的合理还原，非真机证据 | 中 | 发布前用同一输入在三工具实机跑一次，截图入档后冻结默认配置 |
| R-3 | `⌘↩` 从「运行全部」改为「运行选中或当前」是行为变更 | 中 | 批次评审显式确认；回归 `postgres-query-commands` E2E；更新 shortcuts 台账 |
| R-4 | 单击表 → DDL 面板会对导航器快速移动产生请求风暴 | 低 | 300ms debounce + 仅 relation 类型触发 + 结果缓存（同一 schema.name 不重查） |
| R-5 | `sql-formatter` 对 PostgreSQL 专有语法（`::`cast、dollar-quote、`ILIKE`、分区表）的覆盖 | 中 | 引入前跑语法样例矩阵单测；必要时 fallback 到最小规则集（纯缩进/大小写不做结构重排） |
| R-6 | DDL 面板与现有 `generateObjectDdl`（右键→query tab）并存可能造成入口重复 | 低 | 明确分工：单击=只读预览，右键「生成 DDL」=可编辑 tab；两者共用同一 Rust 命令 |

---

## 附录 A：建议改动文件清单（供后续批次参考，非本文件交付物）

| 文件 | 预期改动 |
|---|---|
| `package.json` | 新增 `sql-formatter` 依赖 |
| `src/lib/database/sql-formatter.ts`（新） | 包装 sql-formatter + PG dialect 配置 + 选项读取 |
| `src/lib/database/command-registry.ts` | 新增 `database.query.format`（QUERY_EDITOR scope） |
| `src/components/code-editor.tsx` | 暴露 format 触发入口（或经 editorRef 由上层调用） |
| `src/components/toolbox/tool-postgres.tsx` | `⌘↩` 改绑定、工具栏「格式化」「运行选中」按钮、DDL 预览面板 + debounce |
| `src/components/toolbox/database-navigator.tsx` | `onSelect` 扩展 relation 预览回调（或在上层监听） |
| `src/lib/editor-config.ts` | 格式化选项持久化键 |
| `e2e/desktop/postgres-query-commands.e2e.ts` | 回归 + 新增格式化/DDL 面板用例 |
| 台账 | shortcuts.md / interactions.md / master-plan（B24 替换说明）/ development-status |
