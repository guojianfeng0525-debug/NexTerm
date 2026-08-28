# 数据库工具箱功能设计规格

> 版本：v1.0（MVP）
> 作者：feature-designer（架构视角）
> 日期：2026-08-28
> 输入依据：
> - 竞品分析 `docs/analysis/db-tool-competitor-analysis.md`
> - 现状审计 `docs/analysis/db-toolbox-implementation-audit.md`
> - 现有源码（行号引用全部以当前仓库为准）
>
> 范围：PostgreSQL / MySQL / SQLite 数据库工具箱的**快捷键接入、错误信息工程化、右键菜单三件套补齐、导航树生成 SQL、查询历史贯穿**。AI / BI / ER 明确不做。
> 本文是开发的直接依据：所有设计具体到 **类型 / 函数签名 / 组件 props / 事件名 / 文件行号**。MVP 边界内不引入过度设计；延后项只留接口预留点（见 §6）。

---

## 0. 总体设计原则

1. **命令单一来源**：`command-registry.ts` 的 `DatabaseCommandId` + `defaultBinding` + `bindings.ts` 的 `NAVICAT_BINDINGS` 是唯一事实源；`scope-router.routeKeyEvent` 是唯一路由引擎。手写 keydown（tool-postgres.tsx:2087-2208）在接入后收敛为「命令 → 处理函数映射表」。
2. **Provider 差异只出现在 adapter 层**：共享 UI（DatabaseNavigator / DatabaseResultPane / DatabaseWorkspaceShell / 新的共享菜单组件）接收回调 props，三工具差异通过传入不同 actions 表达。
3. **错误必须结构化 + 可定位 + 可重试**：`DatabaseResult` 增加 `error` kind，错误同时进入结果面板（持久）与 toast（瞬时，带 action）；PG 错误行号通过 CodeMirror 定位。
4. **所有跨组件联动事件遵循 `nexterm:` 前缀**（先例：`nexterm:paste-sql-note` tool-notes.tsx:227、`nexterm:paste-sql-to-query` tool-notes.tsx:246）。
5. **历史记录不复用 `lib/command-history.ts`**（面向终端命令、加密存储，审计结论 §4.2.6）；DB 查询历史独立 localStorage 存储。

---

## 1. 快捷键接入方案（P0）

### 1.1 目标

- 让 `scope-router.routeKeyEvent`（scope-router.ts:104-146）真正挂到 window keydown，使 `NAVICAT_BINDINGS`（bindings.ts:9-95）与 `command-registry` 的 `defaultBinding` 生效。
- 收敛手写 keydown（tool-postgres.tsx:2087-2208）为命令映射表。
- 补齐：F5 刷新导航树、Ctrl+Enter 执行（对齐竞品 DBeaver/Beekeeper/TablePlus，见 competitor-analysis §2.3）、DESIGNER 域（Ctrl+S / Escape）。
- MySQL / SQLite 至少接入 Ctrl+Enter 执行。

### 1.2 新建 Hook：`useDatabaseKeyboardShortcuts`

文件：`src/lib/keyboard/use-database-keyboard-shortcuts.ts`（新建）

```ts
import type { KeyboardScope, ScopeAnchors } from "./scope-router";
import type { DatabaseCommandId } from "@/lib/database/command-registry";

export type DatabaseCommandHandler = () => void;

export interface DatabaseKeyboardShortcutOptions {
  /** 当前 Tool 的 workspace 容器 testid，如 "postgres-workspace"。
   *  用于 scope anchors 与本 workspace 归属判定（三 tool 同时挂载，App.tsx:1889-1897）。 */
  readonly testId: "postgres-workspace" | "mysql-workspace" | "sqlite-workspace";
  /** 模态对话框打开时（configOpen / managerOpen / filterDialog / layoutDialog …）短路 DB 命令。 */
  readonly dialogOpen: boolean;
  /** 命令 id → 处理函数。缺失的命令不注册（MySQL/SQLite 只传 execute 等子集）。 */
  readonly handlers: Partial<Record<DatabaseCommandId, DatabaseCommandHandler>>;
  /** 仅用于 QUERY_EDITOR scope 的 CodeMirror 实例判定：activeElement 是否属于本 tool 的编辑器。 */
  readonly isOwnEditor?: (el: Element) => boolean;
}

export function useDatabaseKeyboardShortcuts(options: DatabaseKeyboardShortcutOptions): void;
```

**内部实现流程**（关键决策）：

```
window keydown (capture: true)
  └─ 1. routeKeyEvent(event, scope, effectiveBindings) === null → 放行（不 preventDefault）
  └─ 2. 命中：
        ├─ event.preventDefault()
        ├─ event.stopPropagation()
        ├─ 若命令对应 handler 存在 → 调用
        └─ 若 handler 缺失 → 仅 consume（不报错，静默）
```

**scope 解析上下文**（scope-router.ts:53-71 的 `ScopeContext`）：

```ts
const anchors: ScopeAnchors = {
  queryEditor: ".cm-editor",                                   // CodeMirror 容器（code-editor.tsx:486）
  dataGrid: `[data-testid="${testId}"] tbody`,                 // 网格行区（database-result-pane.tsx:682）
  navigator: "[data-node-id]",                                 // 导航树节点 button（database-navigator.tsx:162）
};
const scope = resolveScope({
  dialogOpen: options.dialogOpen,
  activeElement: document.activeElement,
  anchors,
});
```

**边界 1 — DIALOG 短路**：`resolveScope` 在 `dialogOpen=true` 时返回 `DIALOG`（scope-router.ts:81），但 `routeKeyEvent` 的语义是「binding rank ≤ 当前 scope rank 即匹配」（scope-router.ts:133-135），DIALOG 是最高 rank，会导致对话框打开时 Ctrl+N/Ctrl+W 等仍被消费。**Hook 必须在 scope === "DIALOG" 时直接 return**，把键盘完全交给对话框内部控件。

**边界 2 — 本 workspace 归属判定**：因为三 tool 同时挂载（App.tsx:1889-1897），activeElement 在 notes 编辑器 / 终端 / 其他 section 时，本 tool 的 hook 必须不响应。在 resolveScope 之前加：

```ts
if (!(document.activeElement instanceof Element)) return;
if (!document.activeElement.closest(`[data-testid="${testId}"]`)) return; // 焦点不在本 DB workspace
```

**边界 3 — typingInField guard**：审计指出 tool-postgres.tsx:2092/2124-2128 只 guard 了 Insert/Ctrl+F/Ctrl+R。统一规则设计为 `consumeRule(event, scope)`：

| scope | 规则 |
|---|---|
| `QUERY_EDITOR` / `DATA_GRID` | 带修饰键（Ctrl/Cmd/Alt/Shift 中至少一个）的组合 → 消费（IDE 惯例：Ctrl+Enter 执行、Ctrl+S 保存、Ctrl+/ 注释）；**无修饰键**的组合（Insert / Escape / Enter / F5）→ 仅当 target 不是 `input, textarea, [contenteditable=true]` 时才消费（对齐 tool-postgres.tsx:2089-2091 现有 guard） |
| `NAVIGATOR` / `DATABASE_WORKSPACE` | 全部消费 |
| `DIALOG` | 不消费（见边界 1） |

实现为独立纯函数 `shouldConsumeShortcut(event: KeyboardEvent, scope: KeyboardScope, typingInField: boolean): boolean`，放同文件，便于单测。

**边界 4 — 多 CodeMirror 实例**：notes 编辑器、object-viewer 的只读编辑器、query 编辑器都是 `.cm-editor`。`resolveScope` 对任何 `.cm-editor` 都返回 `QUERY_EDITOR`。归属判定（边界 2）已保证事件只来自本 workspace；但对 MySQL/SQLite 这种**没有** queryEditorViewRef 的 tool，QUERY_EDITOR scope 命中时若无对应 handler 则静默放行，CodeMirror 的默认 keymap 仍可工作（code-editor.tsx:259-291）。

**边界 5 — 与 App 级全局快捷键冲突（TERMINAL_RESERVED_COMBOS 的消费）**：

现状：全局 `useKeyboardShortcuts`（keyboard-shortcuts.ts:250-296）以 `capture: true` 注册（:293），注册时机早于 Tool（父组件先于子组件执行 useEffect），因此 `Ctrl+N`（newSession :33）、`Ctrl+W`（closeSession）、`Ctrl+1..9`（focusGroup :388-394）、`Ctrl+B/J/M/Z`（layout :39-44）会**先于** DB hook 被全局 handler 消费。

设计决策：**修改全局 hook，对 DB workspace 焦点放行**（唯一允许的全局改动点）：

```ts
// keyboard-shortcuts.ts useKeyboardShortcuts 内，isEditableTarget 检查之后（:258 附近）追加：
const isDbWorkspaceTarget =
  target instanceof Element &&
  Boolean(target.closest('[data-testid="postgres-workspace"], [data-testid="mysql-workspace"], [data-testid="sqlite-workspace"]'));
if (isDbWorkspaceTarget) return; // DB 工具箱拥有完整快捷键体系，App 级快捷键不抢占
```

这样 DB workspace 内 `Ctrl+N` 新建查询、`Ctrl+W` 关 tab 等由 DB hook 接管；`TERMINAL_RESERVED_COMBOS`（bindings.ts:117-137）因为 DB workspace 无终端，无需进一步特殊处理（xterm 硬边界由 routeKeyEvent 内部保证，scope-router.ts:74-77 / 110）。

**边界 6 — 命令与现有处理函数映射表**（PG；收敛手写 keydown 的核心映射）：

| 命令 id | 来源绑定 | PG 现有处理函数（行号） | 说明 |
|---|---|---|---|
| `database.query.execute` | Ctrl+Shift+R / Ctrl+E（bindings.ts:39-46）；**新增 Ctrl+Enter** | `runCurrentStatement`（:1177）/ `runSelectionOrStatement`（:1189） | Ctrl+Enter 对齐竞品；Ctrl+E 走 runSelectionOrStatement，Ctrl+Shift+R 走 runCurrentStatement（保持现有语义，tool-postgres.tsx:2138-2141、2163-2177） |
| `database.query.explain` | Ctrl+Shift+E | `execute(true)`（:961） | — |
| `database.query.toggleComment` | Ctrl+/ | `toggleSqlComment`（:1205） | — |
| `database.query.stop` | Ctrl+T | `stopQuery`（:1163） | 现有 :2147-2151 有 `running` 条件，映射时保留 |
| `database.query.format` | Ctrl+Shift+F | `formatSqlInEditor`（:1216） | — |
| `database.workspace.newQuery` | Ctrl+N | `createQuery`（:1739） | — |
| `database.tab.close` | Ctrl+W | `requestCloseTab(activeTab)` | 现有 :2178-2181 |
| `database.object.refresh` | F5（bindings.ts:69-72） | `refreshNavigator`（:1704） | **新增**（审计 §3.2.2） |
| `database.connection.refresh` | F5 | `refreshNavigator`（:1704） | 与上同函数 |
| `database.data.filterSort` | Ctrl+R（DATA_GRID） | `setFilterDialog({ mode: "filterSort" })` | 现有 :2187-2202 的 Ctrl+R 分支拆开 |
| `database.data.refresh` | Ctrl+R（DATABASE_WORKSPACE） | 表 tab：`browse(tableReference(), tableOffset)`；否则 `refreshNavigator()` | 现有 :2187-2202 |
| `database.data.addRecord` | Insert | `addRecord()` | 现有 :2092-2098 |
| `database.data.saveChanges` | Ctrl+S | `saveTableChanges()`（:2070 处调用点） | 现有 :2182-2186 |
| `database.data.clearFilter` | Escape | `closeFind()` / `clearFilter()`（:1561） | 语义：find 打开时关 find（现有 :2114-2123），否则清筛选。映射函数需二合一 |
| `database.design.save` | Ctrl+S（DESIGNER） | `TableDesignerTab` 内新增 `onSave` 回调 | 见 §1.3 |
| `database.design.revert` | Escape（DESIGNER） | `TableDesignerTab` 内新增 `onRevert` 回调 | 见 §1.3 |

> F3 / find 的 Escape 交互（现有 :2099-2123）不属于 command-registry 命令，作为**编辑器局部 keymap 保留在 tool 内**（不收敛），或者由 hook 的 handlers 兜底——设计为保留原实现，hook 不接管。

**effectiveBindings 来源**：`[...NAVICAT_BINDINGS, ...commandsWithBindings() 转 CommandBinding]`。`commandsWithBindings()`（command-registry.ts:573-583）已把 defaultBinding 转 `{commandId, combo}`，需要适配成 `CommandBinding`（scopes 从命令描述符取）。提供 helper：

```ts
// use-database-keyboard-shortcuts.ts 内
function buildEffectiveBindings(): readonly CommandBinding[] {
  return [
    ...NAVICAT_BINDINGS,
    ...commandsWithBindings().map(({ commandId, combo }) => {
      const descriptor = getDatabaseCommand(commandId);
      return { commandId, combo, scopes: toKeyboardScopes(descriptor?.scopes ?? []) };
    }),
  ];
}
```
`toKeyboardScopes` 把 `DatabaseCommandScope`（DATABASE/NAVIGATOR/WORKSPACE/QUERY_EDITOR/DATA_GRID/DESIGNER）映射到 `KeyboardScope`（DATABASE_WORKSPACE / NAVIGATOR / QUERY_EDITOR / DATA_GRID）。**DESIGNER 映射为独立判断**（见 §1.3）。此函数是 §6.2 快捷键自定义面板的读取入口。

> 新增绑定：`bindings.ts` 的 `NAVICAT_BINDINGS` 中给 `database.query.execute` 增加 `Ctrl+Enter` 条目（scopes: ["QUERY_EDITOR"]）；`command-registry.ts` 中 `database.query.execute` 的 `defaultBinding` 保持 `Ctrl+Shift+R`（自定义面板显示的主绑定，Ctrl+Enter 作为别名写进 NAVICAT_BINDINGS）。`database.design.save`/`revert` 的 defaultBinding 已存在（command-registry.ts:510/518）。

### 1.3 DESIGNER 域接入

表设计器（table-designer-tab.tsx）目前无任何 keydown（审计 §3.2.6）。设计：

- **给容器加 testid**：`TableDesignerTab` 根节点（:97 附近）加 `data-testid="table-designer"`，作为 DESIGNER scope anchor。
- **组件改造**：`TableDesignerTabProps`（:47-68）新增可选回调：

```ts
interface TableDesignerTabProps {
  // ...现有字段
  readonly onSaveShortcut?: () => void;   // Ctrl+S → doApply()（:175）
  readonly onRevertShortcut?: () => void; // Escape → 重置 draft 为 design
}
```

- **Hook 支持 DESIGNER**：`resolveScope` 无 DESIGNER 概念。设计为 hook 在 resolveScope 前做一次快速判定：

```ts
if (activeElement.closest('[data-testid="table-designer"]')) {
  // 仅处理 database.design.save / revert，其余放行
}
```

实现上：在 `useDatabaseKeyboardShortcuts` 中把 DESIGNER 作为独立分支（`resolveDesignerScope`），命中的命令直接调用 `handlers["database.design.save"]`。由于 DESIGNER 只在 PG 出现，MySQL/SQLite 的 hook 不传这两个 handler 即可。

- **TableDesignerTab 内部加原生 keydown** 或复用 hook：设计为 **TableDesignerTab 自己调用一个轻量 `useDesignerShortcuts(onSave, onRevert)`**（同文件内），不依赖 window capture，直接在容器上 `onKeyDown`（React 合成事件），简单可靠，避免与 workspace 级 hook 的 scope 纠缠：

```ts
// table-designer-tab.tsx 内
function useDesignerShortcuts(onSave?: () => void, onRevert?: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const typingInField = e.target instanceof Element && Boolean(e.target.closest("input, textarea, [contenteditable='true']"));
      if (e.key === "s" && (e.metaKey || e.ctrlKey) && !e.altKey) { e.preventDefault(); onSave?.(); }
      else if (e.key === "Escape" && !typingInField) { onRevert?.(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSave, onRevert]);
}
```

### 1.4 MySQL / SQLite 接入

- `tool-mysql.tsx`：`useDatabaseKeyboardShortcuts({ testId: "mysql-workspace", dialogOpen, handlers: { "database.query.execute": () => void execute(), "database.workspace.newQuery": addQuery } })`（:203 execute、:229 addQuery）。
- `tool-sqlite.tsx`：同理，handlers 至少 `execute`（:98）。
- 这两者的 CodeEditor 需要 `editorRef` 以支持后续 format/comment 与 §5 历史插入，MVP 先加 `editorRef={(view) => { queryEditorViewRef.current = view; }}` 并声明 `useRef<EditorView | null>(null)`（不实现 handler 也保留 ref，为 §4 插入 SQL 铺垫）。

### 1.5 测试要求

- `src/lib/keyboard/__tests__/use-database-keyboard-shortcuts.test.ts`：
  - scope 解析正确性（editor/grid/navigator/workspace/DIALOG 短路/跨 tool 归属）。
  - `shouldConsumeShortcut` 规则表全量断言（含 typingInField 组合）。
  - 命中命令 → handler 被调用且 `preventDefault` 被调；未命中 → 不 preventDefault。
  - DESIGNER 分支只路由 design.save/revert。
- 回归：`scope-router.test.ts` 现有用例必须保持绿（不改路由核心）。
- 新增 `bindings.ts` 的 Ctrl+Enter 后，检查 `TERMINAL_RESERVED_COMBOS` 测试（:160-166）不回归。

---

## 2. 错误信息工程化（P0）

### 2.1 目标

- 错误文本从 Rust 端 String 解析出 `message / code / lineNumber / position / hint`。
- PG 错误行号在编辑器中定位 + 高亮 + 滚动。
- `DatabaseResult` 增加 `error` kind，错误内联进结果面板（持久），toast 带重试 action（瞬时 + 可恢复动作，对齐 competitor-analysis §2.2 TablePlus/Beekeeper 范式）。
- provider-registry 层提供统一错误解析入口。

### 2.2 统一错误结构

文件：`src/lib/database/database-error.ts`（新建）

```ts
export type DatabaseErrorSource = "postgres" | "mysql" | "sqlite" | "unknown";

export interface ParsedDatabaseError {
  /** 提取后的核心错误文本（去掉 "LINE n:"、前缀、堆栈等噪声）。 */
  readonly message: string;
  /** 原始完整文本（用于复制/诊断）。 */
  readonly fullText: string;
  /** SQLSTATE（PG）/ 数值错误码（MySQL）。 */
  readonly code?: string;
  /** PG DbError.position：1-based 字符偏移（当前 Display 不输出，保留给 Rust 结构化返回）。 */
  readonly position?: number;
  /** 从 "LINE n:" 解析的 1-based 相对行号（相对发送的 SQL 文本第一行）。 */
  readonly lineNumber?: number;
  /** 出错行原文（"LINE 1: SELEC * FROM users" 中的语句文本）。 */
  readonly lineText?: string;
  readonly source: DatabaseErrorSource;
}

/** provider 错误解析器注册表。 */
export type DatabaseErrorParser = (raw: string) => ParsedDatabaseError;

const parsers: Record<string, DatabaseErrorParser> = {
  postgres: parsePostgresError,
  mysql: parseMySQLError,
  sqlite: parseSQLiteError,
};

/** 统一入口：provider-registry 层的归一化接口。 */
export function parseProviderError(providerId: string, raw: string): ParsedDatabaseError;
export function databaseErrorResult(error: ParsedDatabaseError): DatabaseErrorResult;
```

### 2.3 各 Provider 解析函数

**PG** — `src/lib/database/parsers/postgres-error.ts`（新建）

Rust 端格式（src-tauri/src/postgres.rs:828）：`PostgreSQL query failed: {error}`，`{error}` 为 tokio-postgres Error Display，典型输出：

```
PostgreSQL query failed: db error: ERROR: syntax error at or near "SELEC"
LINE 1: SELEC * FROM users
        ^
```

```ts
export function parsePostgresError(raw: string): ParsedDatabaseError {
  // 1. 剥离前缀 "PostgreSQL query failed: " 与 "db error: "
  // 2. 定位 "ERROR: " 行 → message（"ERROR: " 后至行尾）
  // 3. /LINE\s+(\d+):\s*(.*)/ → lineNumber / lineText（首行匹配即可）
  // 4. /^LINE \d+: (\s*)\^/ 上下文行 → 可推算 position（= LINE 行号 offset + "^" 的列偏移）：
  //    position = lineStartOffset + caretColumn（caret 前导空格数 + 1）
  // 5. message 中若含 SQLSTATE 形如 "23505"（Display 偶发）→ code
}
```

> 说明：tokio-postgres 的 `DbError` 才有权威 `position()`（1-based 字符偏移），当前 Rust 只返回 String。设计上 `position` 字段两路供给：
> - **路线 A（MVP，纯前端）**：从 `LINE n:` + 下一行 `^` 的缩进推算行内列位置（`caretColumn = lineText 长度 - 去掉"^"前的空格数`），换算为字符偏移。
> - **路线 B（Rust 结构化，P1 可选）**：`postgres_execute` 错误时 Rust 返回 `{ message, code, position }` JSON（`DbError` 提供 `code()/position()/message()`），前端 adapter 直接透传 `position`。当前不改 Rust，仅在 `ParsedDatabaseError` 预留字段。

**MySQL** — `src/lib/database/parsers/mysql-error.ts`（新建）

Rust 端格式假设（需开发时对照 `src-tauri/src/mysql.rs`）：`MySQL query failed: Error 1064 (42000): You have an error in your SQL syntax...`。

```ts
export function parseMySQLError(raw: string): ParsedDatabaseError {
  // /Error\s+(\d+)(?:\s*\(([^)]+)\))?[:：]\s*(.*)/s → code=1064, message=rest
  // 无行号（MySQL 客户端错误不携带行号）→ lineNumber undefined
}
```

**SQLite** — `src/lib/database/parsers/sqlite-error.ts`（新建）

Rust 端格式（rusqlite）：`SQLite query failed: error returned from database: near "SELEC": syntax error`。

```ts
export function parseSQLiteError(raw: string): ParsedDatabaseError {
  // 剥离 "SQLite query failed: " 与 "error returned from database: "
  // message = 剩余文本（rusqlite 错误无行号）
}
```

**fallback**：`parseProviderError` 对未注册 provider 返回 `{ message: raw, fullText: raw, source: "unknown" }`。

### 2.4 DatabaseResult 增加 error kind

文件：`src/lib/database/result-types.ts`

```ts
export interface DatabaseErrorResult {
  readonly kind: "error";
  readonly error: ParsedDatabaseError; // import type from database-error.ts
}

export type DatabaseResult =
  | DatabaseTabularResult
  | DatabaseCommandResult
  | DatabaseEmptyResult
  | DatabaseErrorResult;   // 新增（result-types.ts:100-103 后追加）
```

**消费点改造**（错误进入结果面板）：

- `tool-postgres.tsx`：
  - `execute` catch（:983-991）、`runSql` catch（:1257-1260）、`browse` catch（:1523-1526）→ 改为：

    ```ts
    } catch (error) {
      const parsed = parseProviderError("postgres", String(error));
      patchTab(tab.id, { result: databaseErrorResult(parsed) });   // 持久进面板
      showQueryErrorToast(t, parsed, { onRetry: () => void runSql(tab.sql) }); // 瞬时 + 重试
    }
    ```
  - 若 `parsed.lineNumber` 有值且 `tab.type === "query"` → 调用 §2.5 的 `revealEditorLine(lineNumber, statementRange)`。
- `tool-mysql.tsx` catch（:217-220）、`tool-sqlite.tsx` catch（:102）：同样接入，MySQL/SQLite 无行号定位。

### 2.5 编辑器出错行定位与高亮

文件：`src/lib/database/editor-error-reveal.ts`（新建，纯 CodeMirror 逻辑，可单测）

```ts
import type { EditorView } from "@codemirror/view";

/**
 * 把编辑器滚动定位到出错行并设置 selection。
 * @param view 目标 CodeMirror 实例（tool 的 queryEditorViewRef）
 * @param statementRange 发送语句在文档中的 [start,end]（runSql 场景用 currentStatementAt 得到，:1181-1183）
 * @param relativeLine 服务端返回的 LINE n（相对发送语句的第一行）
 */
export function revealEditorLine(
  view: EditorView,
  statementRange: { start: number; end: number } | null,
  relativeLine: number,
): void;
```

实现：
1. 绝对行号换算：`const docLine = view.state.doc.lineAt(statementRange?.start ?? 0); const absLine = docLine.number + (relativeLine - 1);`
2. `const target = view.state.doc.line(absLine);`（越界则 clamp 到 1..doc.lines）
3. `view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });`
4. `view.focus();`

**高亮**：MVP 用 selection 跳行 + `highlightActiveLine`（code-editor.tsx:308 已启用）足够；如需更醒目的错误底纹，预留装饰扩展接口（§6.3 说明，不实现）。**不做** DataGrip 式实时红波浪线（MVP 边界外）。

### 2.6 结果面板内联错误区组件

文件：`src/components/toolbox/database-result-error.tsx`（新建）

```tsx
export interface DatabaseResultErrorPaneLabels {
  readonly error: string;          // "执行失败" 标题
  readonly line: (n: number) => string; // "第 {n} 行"
  readonly copy: string;
  readonly retry: string;
  readonly jumpToLine: string;     // "跳转到出错行"
}

interface DatabaseResultErrorPaneProps {
  readonly error: ParsedDatabaseError;
  readonly labels: DatabaseResultErrorPaneLabels;
  readonly onRetry?: () => void;
  readonly onCopy?: () => void;          // 复制 fullText
  readonly onGoToLine?: () => void;      // 调用 revealEditorLine（当 lineNumber 存在时显示）
}
```

渲染要点：
- `select-text`（错误文本可选中复制，竞品共识 competitor-analysis §2.2.4）。
- message 醒目（`text-destructive`），`fullText` 以 `<pre>` 折叠显示（点击展开，避免长错误撑爆面板）。
- code badge（若有）、`LINE n` 徽标 + 「跳转」按钮（onGoToLine）。
- Retry 按钮（onRetry）。

**接入**：`database-result-pane.tsx` 的 `DatabaseResultPane` 增加分支——在 `tabularResult` 判空后（:541 `tabularResult ? ... : ...`），先判断 `result?.kind === "error"`：

```ts
const errorResult = result?.kind === "error" ? result : null;
// :533-540 头部区不变；errorResult 时渲染 <DatabaseResultErrorPane>，跳过 grid/empty 分支
```

新 props：

```ts
readonly renderError?: (error: ParsedDatabaseError) => ReactNode; // 或直接传 labels + onRetry/onGoToLine
```

设计为**渲染函数注入**（`renderError`），保持 DatabaseResultPane 通用（不 import database-error 类型到共享组件）。三个 tool 各传自己的错误面板（带 i18n labels 与回调）。

### 2.7 toast 带重试/复制 action

文件：`src/lib/database/error-handling.ts`（新建）

```ts
export function showQueryErrorToast(
  t: TFunction,
  error: ParsedDatabaseError,
  options?: { onRetry?: () => void },
): void {
  toast.error(t("toolbox.common.queryFailed"), {
    description: error.message,          // 面板内已有 fullText，toast 用 message 保持紧凑
    ...(options?.onRetry ? { action: { label: t("common.retry"), onClick: options.onRetry } } : {}),
  });
}
```

复用 sonner `action` 先例（tool-postgres.tsx:762-768 连接错误重信任）。MVP 单 action 给重试；复制能力由结果面板内联区提供（toast 描述文本本身可选中）。

### 2.8 provider 归一化接口落点

- `provider-registry.ts` 不直接加字段（`DatabaseProviderDescriptor` 是共享类型，避免为 UI 服务加元数据）。归一化入口集中在 `database-error.ts` 的 `parseProviderError(providerId, raw)`。
- 各 tool 的 `import { postgresqlProvider }` 等已存在（provider-registry.ts:3/27/50），parse 用 providerId 字符串分发，不引入新依赖。

### 2.9 测试要求

- `src/lib/database/__tests__/database-error.test.ts`：
  - PG：LINE 行号/文本/`^` 列偏移解析；无 LINE 的纯 message；SQLSTATE code（若有）；前缀剥离。
  - MySQL：code 提取（1064 (42000)）；无 code 兜底。
  - SQLite：`near "X"` message；前缀剥离。
  - `databaseErrorResult` 工厂。
- `editor-error-reveal`：用 CodeMirror `EditorState` + `EditorView` 在 jsdom 单测（或纯函数拆出 `resolveAbsoluteLineNumber(doc, statementRange, relativeLine)` 测 offset 换算，view 部分留集成测试）。
- 组件测试：`database-result-error.test.tsx` 渲染 labels/按钮回调。

---

## 3. MySQL / SQLite 右键三件套补齐（P0）

### 3.1 复用 vs 复制决策

- **直接复用（零改动组件）**：`DatabaseNavigator`（database-navigator.tsx:95 `renderContextMenu` 已支持）、`DatabaseResultPane`（database-result-pane.tsx:52-67 三个 render* 已支持）、`DatabaseWorkspaceShell`（database-workspace-shell.tsx:24 `renderTabContextMenu` 已支持）。三者只需传 prop。
- **共享渲染函数（新建）**：右键菜单内容是纯 JSX，抽成接收 actions 的渲染函数，三工具共用。PG 保留自己的完整菜单（设计表/Drop/DDL 等 PG 专属），MySQL/SQLite 用共享精简版。
- **不做的**：把 PG 整个 renderContextMenu 逻辑抽象成通用组件——PG 菜单强依赖 PG 状态（quoteQualifiedPostgresName、openDesigner、requestObjectDrop 等，tool-postgres.tsx:2427-2530），抽象收益 < 回归风险。

### 3.2 新建共享菜单文件

文件：`src/components/toolbox/db-context-menus.tsx`（新建）

```tsx
/** 导航树关系对象（table/view/relation）右键菜单。 */
export interface NavigatorRelationMenuActions {
  readonly openData: () => void;          // 打开数据（PG: browse / MySQL·SQLite: 生成 SELECT tab）
  readonly copyName: () => void;          // 复制限定名
  readonly generateSelect: () => void;    // §4
  readonly generateInsert: () => void;    // §4（仅 table）
  readonly generateUpdate: () => void;    // §4（仅 table）
  readonly refresh: () => void;
  readonly newQuery: () => void;
  readonly disabled: boolean;             // 未连接
}
export function NavigatorRelationMenu({ actions }: { actions: NavigatorRelationMenuActions }): ReactNode;

/** 数据网格单元格右键（表 tab 的只读子集）。 */
export interface ResultCellMenuActions {
  readonly copyCell: () => void;
  readonly copyRow: () => void;
  readonly copyColumnName: () => void;
  readonly exportCsv?: () => void;
  readonly exportExcel?: () => void;
}
export function ResultCellMenu({ actions, source }: {
  actions: ResultCellMenuActions;
  source: "row" | "insert";
}): ReactNode;

/** 查询编辑器右键（精简版）。 */
export interface QueryEditorMenuActions {
  readonly execute: () => void;
  readonly runSelection: () => void;
  readonly formatSql: () => void;
  readonly toggleComment: () => void;
  readonly saveToNotes?: () => void;
  readonly copy: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly cut: () => void;
  readonly paste: () => void;
  readonly selectAll: () => void;
  readonly disabledExecute: boolean;
}
export function QueryEditorMenu({ actions }: { actions: QueryEditorMenuActions }): ReactNode;
```

每个函数返回 `ContextMenuItem / ContextMenuSeparator` 片段，调用方包裹 `<ContextMenuContent>`（对齐 PG 现有结构 tool-postgres.tsx:2669-2755）。

> PG 迁移（可选，P0 不强制）：PG 的编辑器右键**保持现状**（tool-postgres.tsx:2639-2756），避免回归；仅网格单元格菜单（:2898-2941）若实现时发现与共享版高度重合，可改为 `ResultCellMenu` + PG 专属扩展项。设计上**PG 网格菜单不动**，MySQL/SQLite 用共享版。

### 3.3 各文件修改清单

| 文件 | 改动 | 接口 |
|---|---|---|
| `src/components/toolbox/db-context-menus.tsx` | **新建** | §3.2 |
| `tool-mysql.tsx` | navigator 传 `renderContextMenu`（:347 DatabaseNavigator 处）；编辑器外包 `ContextMenu` + `QueryEditorMenu`（:399-421 处）；`DatabaseResultPane` 传 `renderContextMenu` = `ResultCellMenu`（:422-438 处）；shell 传 `renderTabContextMenu`（:372-375 处） | 依赖 §3.2；需补 actions（openData=生成 SELECT tab、copyName、generateSelect） |
| `tool-sqlite.tsx` | 同上（navigator :143、workspace :149） | 同上 |
| `tool-postgres.tsx` | 不改（已有完整菜单） | — |
| `database-workspace-shell.tsx` | 不改（已支持 renderTabContextMenu） | — |
| `database-navigator.tsx` / `database-result-pane.tsx` | 不改 | — |

**MySQL/SQLite 的 `generateSelect` 动作**：目前 `onOpen` 里已生成 `SELECT * FROM ... LIMIT 100;` 并新开 tab（tool-mysql.tsx:359-367、tool-sqlite.tsx:143）。右键「生成 SELECT」复用同一逻辑但**插入当前编辑器**（§4）。

### 3.4 测试要求

- `db-context-menus.test.tsx`：三组菜单按 actions 渲染对应项；disabled 态。
- `tool-sqlite.test.tsx` 扩展：导航树右键打开菜单项存在（现有测试文件已存在，:26 导入 ToolSqlite）。
- 新增 `tool-mysql.test.tsx`（目前无）：连接态渲染 + 右键触发点（`data-testid="database-navigator-context-menu"`）。

---

## 4. 导航树生成 SQL（P0）

### 4.1 生成函数

文件：`src/lib/database/sql-generation.ts`（新建，纯函数）

```ts
export interface SqlGenerationOptions {
  /** provider 方言标识符引用（PG: `"x"`；MySQL: `` `x` ``；SQLite: `"x"`）。 */
  readonly quoteIdentifier: (id: string) => string;
  /** SELECT 默认行数。PG 表浏览用 100（与 pageSize 对齐 tool-postgres.tsx:253），MySQL/SQLite 用 100。 */
  readonly selectLimit?: number;
}

/** 列元数据输入：复用现有 object-loader 的列结构。 */
export interface ColumnMetadata {
  readonly name: string;
  /** PG 列定义（postgresql-object-loader.ts:16-27 PostgresCatalogObjectItem.dataType）。 */
  readonly dataType?: string;
  readonly nullable?: boolean;
  readonly default?: string;
}

export function generateSelectSql(
  qualifier: string,          // PG: "schema"; MySQL/SQLite: 库名 或 ""（无库时省略）
  table: string,
  columns: readonly ColumnMetadata[] | null, // null → SELECT *
  options: SqlGenerationOptions,
): string;

export function generateInsertSql(
  qualifier: string,
  table: string,
  columns: readonly ColumnMetadata[],
  options: SqlGenerationOptions,
): string;

export function generateUpdateSql(
  qualifier: string,
  table: string,
  columns: readonly ColumnMetadata[],
  primaryKeyColumns: readonly string[],  // 主键列名（WHERE 条件）
  options: SqlGenerationOptions,
): string;
```

**列元数据来源**（不新写 loader，复用现有）：
- PG：`postgres_catalog_objects { kind: "columns", schema, relation }`（postgresql-object-loader.ts:467-471 已有调用）→ `PostgresCatalogObjectItem[]`（name/dataType/nullable/default）。
- MySQL：`mysql-object-loader.ts` 现状需确认是否提供列级加载（若没有，MVP 退化为 `columns: null` → `SELECT *`，INSERT/UPDATE 菜单项禁用，并注明接口预留）。
- SQLite：`sqlite-object-loader.ts` 同理；退化规则相同。

**输出示例**（PG，`quoteIdentifier = (s) => '"' + s.replace(/"/g,'""') + '"'`，对齐 tool-postgres.tsx:283-286）：

```sql
-- generateSelectSql
SELECT "id", "name" FROM "public"."users" LIMIT 100;

-- generateInsertSql
INSERT INTO "public"."users" ("id", "name") VALUES ('', '');

-- generateUpdateSql
UPDATE "public"."users" SET "name" = '' WHERE "id" = <id>;
```

### 4.2 插入编辑器行为

所有工具统一 `insertGeneratedSql(sql)`：

```ts
// 各 tool 内实现（PG 已有效果相同的先例：nexterm:paste-sql-to-query 处理函数 tool-postgres.tsx:830-836 用 requestAnimationFrame + view.dispatch + view.focus）
const insertGeneratedSql = (sql: string) => {
  const view = queryEditorViewRef.current;   // MySQL/SQLite 需先补 editorRef（§1.4）
  if (!view) return;
  const doc = view.state.doc;
  const insertAt = doc.length;
  const needsLeadingNewline = insertAt > 0 && doc.sliceString(insertAt - 1, insertAt) !== "\n";
  const insertText = (needsLeadingNewline ? "\n" : "") + sql + "\n";
  view.dispatch({ changes: { from: insertAt, to: insertAt, insert: insertText } });
  view.dispatch({ selection: { anchor: insertAt, head: insertAt + insertText.length } }); // 选中插入内容
  view.focus();
  patchTab(tab.id, { dirty: true });
};
```

### 4.3 导航树右键挂载点

- PG：`renderContextMenu`（:2427）的 relation 分支（:2495-2497 之后）插入「生成 SQL」子菜单，动作直接调 `insertGeneratedSql(generateSelectSql(...))`。
- MySQL/SQLite：`NavigatorRelationMenu`（§3.2）的 `generateSelect/generateInsert/generateUpdate` 动作。

### 4.4 测试要求

- `sql-generation.test.ts`：三函数输出断言（含 quote 转义、LIMIT、INSERT/UPDATE 列序、主键 WHERE）。
- 退化路径：`columns: null` → `SELECT *`。
- 插入行为集成：`insertGeneratedSql` 的换行/选中逻辑在 tool 测试中验证。

---

## 5. 查询历史贯穿（P0）

### 5.1 存储设计

文件：`src/lib/database/query-history.ts`（新建）

```ts
export interface QueryHistoryEntry {
  readonly id: string;
  readonly sql: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly providerId: "postgresql" | "mysql" | "sqlite";
  readonly executedAt: number;
  readonly success: boolean;
}

const HISTORY_KEY_PREFIX = "nexterm.dbQueryHistory.";   // 按 provider 隔离
const MAX_ENTRIES = 200;

export function loadQueryHistory(providerId: string): readonly QueryHistoryEntry[];
export function addQueryHistory(entry: Omit<QueryHistoryEntry, "id" | "executedAt">): void; // 去重（相同 sql+connectionId 更新成功态并置顶）+ 截断
export function removeQueryHistory(providerId: string, id: string): void;
export function clearQueryHistory(providerId: string): void;
```

**不复用 command-history**（lib/command-history.ts 面向终端、加密、无连接语义，审计 §4.2.6）。localStorage 明文存 SQL（与已存活的 `nexterm.postgres.savedQueries.*` tool-postgres.tsx:217-219 一致，SQL 非机密凭据）。

### 5.2 记录时机

- 各 tool 的 `execute` / `runSql` / `execute()` 成功与失败均记录（`success` 区分）：
  - PG：`runSql`（:1237-1265）与 `execute`（:961-996）调用 `addQueryHistory({ sql: tab.sql, connectionId, connectionName, providerId, success })`。
  - MySQL `execute`（:203-224）、SQLite `execute`（:98-104）同样。
- 记录后 dispatch `nexterm:db-query-history-changed`（detail: `{ providerId }`）。

### 5.3 历史 UI

文件：`src/components/toolbox/query-history-dialog.tsx`（新建）

```tsx
interface QueryHistoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providerId: "postgresql" | "mysql" | "sqlite";
  readonly labels: QueryHistoryLabels;  // 标题/空态/复制/再次执行/插入编辑器/删除/时间
}
```

- 复用 `Dialog`（对齐 filter-sort-dialog.tsx / 现有 Dialog 用法）。
- 列表项：时间、连接名、SQL（截断）、success 红/绿点。
- **列表项右键菜单**（对齐竞品 TablePlus 历史右键 competitor-analysis §1.4）：
  - 复制 SQL
  - 再次执行 → dispatch `nexterm:db-query-history-execute`
  - 插入编辑器 → dispatch `nexterm:db-query-history-insert`
  - 删除单条 → `removeQueryHistory` + refresh
  - 清空全部 → `clearQueryHistory`（带 confirm，对齐 tool-command-history.tsx:173-188 的 AlertDialog 模式）

**入口**：三 tool 的 toolbar 各加一个 History 图标 ToolButton（PG 在 :2214 工具栏区域；MySQL :268 区域；SQLite :134 区域）。

### 5.4 与编辑器联动事件

| 事件 | detail | 消费方（各 tool 内 useEffect 监听） |
|---|---|---|
| `nexterm:db-query-history-execute` | `{ providerId, sql, connectionId }` | 校验 providerId/connectionId 归属 → `runSql(sql)` / `execute()`（先 `patchTab(tab.id, { sql })`） |
| `nexterm:db-query-history-insert` | `{ providerId, sql }` | `insertGeneratedSql(sql)`（§4.2） |
| `nexterm:db-query-history-changed` | `{ providerId }` | 历史对话框刷新（同 tool-command-history.tsx:52-59 的监听模式） |

事件命名遵循 `nexterm:` 前缀惯例。MySQL/SQLite 也监听（provider 过滤，对齐 `nexterm:paste-sql-note` 的 provider 过滤 tool-mysql.tsx:114）。

### 5.5 测试要求

- `query-history.test.ts`：add 去重/置顶/截断、remove、clear、localStorage 隔离。
- `query-history-dialog.test.tsx`：右键菜单动作（再次执行/插入/删除）dispatch 正确事件。

---

## 6. 延后项接口预留（不实现）

### 6.1 命令面板（预留）

- 数据源：`DATABASE_COMMAND_IDS`（command-registry.ts:18-74）+ `commandsWithBindings()`（:573-583）即可枚举全部可执行命令与默认绑定。
- 预留 hook 签名（**不实现**，仅记录在案）：

```ts
// src/lib/database/command-palette.ts（P2）
export function queryDatabaseCommands(filter: string): Array<{ commandId: DatabaseCommandId; labelKey: string; combo?: string }>;
```

### 6.2 快捷键自定义面板（预留）

- `useDatabaseKeyboardShortcuts` 的绑定来源抽象为 `buildEffectiveBindings()`（§1.2）已就位，未来自定义只需把它改为读 overrides：

```ts
// src/lib/database/shortcut-settings.ts（P2）
export interface ShortcutOverride { commandId: string; combo: string; }
export function loadShortcutOverrides(): readonly ShortcutOverride[];
export function saveShortcutOverride(override: ShortcutOverride): void;   // 冲突检测用 TERMINAL_RESERVED_COMBOS + 全局键位
export function resolveEffectiveBindings(): readonly CommandBinding[];     // overrides 合并 NAVICAT_BINDINGS
```

### 6.3 INSERT 文本 ↔ 表格编辑（预留）

- 事件名预留：`nexterm:edit-insert-as-table`（detail: `{ providerId, connectionId, insertSql }`）。
- `DatabaseResultPane` 预留 prop：`onEditInsertAsTable?: (insertSql: string) => void`（P2 实现）。

### 6.4 编辑器错误装饰扩展点（预留）

- `editor-error-reveal.ts` 的高亮可升级为 StateField 装饰（当前用 selection），预留 `createErrorLineDecoration()` 函数位（P1）。

---

## 7. 任务拆解（开发执行顺序）

依赖关系：**T1 → T2/T3（并行）→ T4 → T5/T6（并行）→ T7/T8（并行）→ T9**。每条 ≤1 文件主改。

### T1. 错误解析内核（无依赖，最先做）

- **主改文件**：`src/lib/database/database-error.ts`（新建）+ `src/lib/database/parsers/{postgres,mysql,sqlite}-error.ts`（新建）
- **依赖**：无
- **测试**：§2.9 database-error.test.ts 全量
- **并行性**：可与 T2 并行

### T2. 错误接入结果面板（依赖 T1）

- **主改文件**：`src/lib/database/result-types.ts`（error kind）
- **依赖**：T1（ParsedDatabaseError 类型）
- **测试**：类型编译 + adapter 回归（现有 result-* 测试）

### T3. DatabaseResultPane 错误分支 + 错误面板组件（依赖 T1）

- **主改文件**：`src/components/toolbox/database-result-error.tsx`（新建）+ `src/components/toolbox/database-result-pane.tsx`（error 分支 + `renderError` prop）
- **依赖**：T1
- **测试**：`database-result-error.test.tsx`；DatabaseResultPane 现有测试回归
- **并行性**：与 T2 并行

### T4. 编辑器行定位（依赖 T1）

- **主改文件**：`src/lib/database/editor-error-reveal.ts`（新建，含 `resolveAbsoluteLineNumber` 纯函数）
- **依赖**：T1（lineNumber 来源）
- **测试**：offset 换算纯函数单测；CodeMirror dispatch 集成
- **并行性**：与 T2/T3 并行

### T5. useDatabaseKeyboardShortcuts hook + 全局放行点（依赖 T3 的 testid 无、可独立）

- **主改文件**：`src/lib/keyboard/use-database-keyboard-shortcuts.ts`（新建）+ `src/lib/keyboard/bindings.ts`（Ctrl+Enter 条目）+ `src/lib/keyboard-shortcuts.ts`（DB workspace 放行）
- **依赖**：无（command-registry/scope-router 已就绪）
- **测试**：§1.5 全量 + scope-router.test.ts 回归
- **并行性**：与 T2-T4 并行（无类型耦合）

### T6. PG 手写 keydown 收敛（依赖 T5）

- **主改文件**：`src/components/toolbox/tool-postgres.tsx`（删除 :2087-2208 手写 keydown，替换为 hook 调用 + 映射表；execute/runSql/browse catch 接入 T1/T4）
- **依赖**：T1、T4、T5
- **测试**：tool-postgres-tofu.test.tsx 回归（:107 等）；F5 刷新导航树手测 + 单测

### T7. MySQL/SQLite 三件套 + Ctrl+Enter（依赖 T5，部分依赖 T8）

- **主改文件**：`src/components/toolbox/db-context-menus.tsx`（新建）+ `tool-mysql.tsx` + `tool-sqlite.tsx`
- **依赖**：T5（hook）；菜单 actions 的 generateSelect 依赖 T8 的 sql-generation（可先禁用该项）
- **测试**：§3.4；`tool-mysql.test.tsx` 新建
- **并行性**：与 T6 并行

### T8. 导航树生成 SQL（依赖 T1 无关，可独立）

- **主改文件**：`src/lib/database/sql-generation.ts`（新建）
- **依赖**：无
- **测试**：§4.4 sql-generation.test.ts
- **并行性**：与 T5-T7 并行；供 T7 的 generateSelect 与 PG 导航树菜单接入

### T9. PG 导航树「生成 SQL」接入（依赖 T8）

- **主改文件**：`src/components/toolbox/tool-postgres.tsx`（relation 分支 + insertGeneratedSql）
- **依赖**：T8、T6
- **测试**：右键菜单项出现 + 插入行为

### T10. 查询历史（依赖 T1/T6/T7 的记录时机）

- **主改文件**：`src/lib/database/query-history.ts`（新建）+ `src/components/toolbox/query-history-dialog.tsx`（新建）+ 三 tool toolbar 入口
- **依赖**：T6/T7（记录点）；insertGeneratedSql（§4.2）
- **测试**：§5.5
- **并行性**：T6/T7 完成后即可

### T11. DESIGNER 域快捷键（依赖 T5）

- **主改文件**：`src/components/toolbox/table-designer-tab.tsx`（testid + useDesignerShortcuts + props）
- **依赖**：T5（约定映射）、T6（PG 传入 onSave/onRevert 回调）
- **测试**：designer 内 Ctrl+S/Escape 手测 + 单测
- **并行性**：与 T7 并行

### 汇总表

| 任务 | 主改文件数 | 前置 | 可并行组 |
|---|---|---|---|
| T1 | 1（+2 parser） | — | A 组 |
| T2 | 1 | T1 | B 组（T1 后） |
| T3 | 1+1 | T1 | B 组 |
| T4 | 1 | T1 | B 组 |
| T5 | 1（+2 小改） | — | A 组 |
| T6 | 1 | T1/T4/T5 | C 组 |
| T7 | 1+2 | T5（+T8 可选） | C 组 |
| T8 | 1 | — | A 组 |
| T9 | 1 | T8/T6 | D 组 |
| T10 | 1+1+3 | T6/T7 | D 组 |
| T11 | 1 | T5/T6 | C 组 |

---

## 8. 验收要点（GATE 检查项）

1. 三工具均可在查询编辑器按 **Ctrl+Enter** 执行；PG 在导航树焦点时 **F5** 刷新；表设计器内 **Ctrl+S** 应用、**Escape** 放弃。
2. PG 语法错误 toast 显示核心 message + 结果面板内联错误区（可复制、可跳行、可重试）；行号跳转后光标落在出错行。
3. MySQL/SQLite 导航树 / 编辑器 / 网格 / Tab 右键菜单齐全，无 PG 专属项泄漏（如「设计表」不应出现）。
4. 导航树右键「生成 SELECT/INSERT/UPDATE」插入当前编辑器且选中插入文本。
5. 历史对话框：再次执行 / 插入编辑器 / 删除单条 / 清空全部生效，按 provider 隔离。
6. App 级 Ctrl+N/Ctrl+W 在 DB workspace 内不再新建 SSH 会话（回归点）。
7. `scope-router.test.ts`、`tool-postgres-tofu.test.tsx`、`tool-sqlite.test.tsx` 全绿。

---

*本文档由 feature-designer 输出，作为开发实现与验收的直接依据。*
