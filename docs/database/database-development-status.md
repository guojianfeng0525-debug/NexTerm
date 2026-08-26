# NexTerm Database Development Status

## Product Baseline

Navicat Premium 17.3 Enterprise is the product baseline.

PostgreSQL is the first current provider. The long-term target is a Shared Database Platform, not a PostgreSQL-only Toolbox.

## Current Architecture

- Shared frontend/domain adoption: VALIDATED with PostgreSQL, experimental SQLite P0, and experimental MySQL P0. The shared provider core, command resolver, profile envelope, provider-selection connection dialog, object model/Navigator, query-editor context/CodeEditor, result contracts, and result pane have three real providers.
- Shared Workspace Shell: IMPLEMENTED for toolbar host, Navigator placement, query-tab host, workspace region, and optional status region. `ToolPostgres`, `ToolSqlite`, and `ToolMySql` retain provider runtime orchestration and provider-specific workspace slots.
- Shared Connection Dialog Shell: IMPLEMENTED as `DatabaseConnectionDialogShell` for modal geometry, header, section rail, scrollable content viewport, form grid, and fixed footer. `ToolPostgres`, `ToolSqlite`, and `ToolMySql` provide their own fields, available sections, validation semantics, primary-action semantics, and runtime behavior.
- Provider runtime and IPC: PROVIDER-SPECIFIC. PostgreSQL retains `postgres_*` IPC and `PostgresState`; SQLite retains `sqlite_*` IPC and independent `rusqlite` runtime state; MySQL retains `mysql_*` IPC and `MysqlState` using `mysql_async`.
- Generic runtime, generic `database_*` IPC, and generic `DatabaseState`: NOT IMPLEMENTED / DEFERRED.

## Completed Atomic Slices

### Atomic Slice 1 - COMPLETE

- `DatabaseProviderDescriptor`
- `DatabaseCapabilities`
- Static Provider Registry
- PostgreSQL Provider Descriptor
- Database Command Descriptor
- Database Command Resolver

Constraints:

- At Slice 1, the production registry contained only PostgreSQL. It now contains PostgreSQL and experimental SQLite P0.
- Explain capability is `none | text | visual`; PostgreSQL declares `text`.
- The resolver resolves availability only and does not execute commands.

### Atomic Slice 2 - COMPLETE

`database.query.explain` toolbar availability now follows:

```text
PostgreSQL Provider Descriptor
  -> Explain Capability
  -> Shared Command Descriptor
  -> Shared Command Resolver
  -> ToolPostgres Query Toolbar
```

Not migrated:

- `execute(true)`
- `postgres_explain`
- `postgres_*` IPC
- Rust execution
- Generic command execution

### Atomic Slice 3 - COMPLETE

`database.query.execute` toolbar availability now follows:

```text
PostgreSQL Provider Descriptor
  -> Shared Command Descriptor
  -> Shared Command Resolver
  -> ToolPostgres Query Toolbar
```

The resolver owns connection-level availability. The Query Workspace retains its local `running` guard. The existing empty-SQL guard remains in `execute()` and the existing Run button stays enabled for empty SQL, preserving behavior.

Not migrated:

- `execute()` and `execute(true)`
- `postgres_execute` and `postgres_*` IPC
- Rust execution
- Generic command execution

### Atomic Slice 4 - COMPLETE

`database.connection.disconnect` toolbar availability now follows:

```text
PostgreSQL Provider Descriptor
  -> Shared Command Descriptor
  -> Shared Command Resolver
  -> ToolPostgres Connection Toolbar Disconnect
```

The resolver owns Disconnect availability. The existing connected/disconnected toolbar rendering remains unchanged: the connected view shows Disconnect and the disconnected view shows the existing Connect entry. The Disconnect handler still invokes `postgres_disconnect` and then updates the existing local connection state.

Not migrated:

- Disconnect execution
- `postgres_disconnect` and `postgres_*` IPC
- Rust execution and session cleanup
- Generic command execution

## Feature Batches

### Feature Batch 5 - Query Command Adoption - COMPLETE

`database.workspace.newQuery` toolbar availability now follows:

```text
PostgreSQL Provider Descriptor
  -> Shared Command Descriptor
  -> Shared Command Resolver
  -> ToolPostgres New Query Toolbar Entry
```

The existing `newQuery()` and `openTab()` handler path is unchanged. New Query is disabled while disconnected and enabled when connected, as defined by the existing shared command descriptor. `database.query.execute` and `database.query.explain` remain resolver-controlled, with their existing local `running` guards.

Not migrated:

- Query execution, IPC, and Rust runtime
- Stop/cancel, transactions, save, format, selected/current-statement execution, and result refresh: no mature Query Toolbar entry exists
- Generic command execution

### Feature Batch 6 - Navigator / Object Model Provider Migration - COMPLETE

- Added live `DatabaseObjectNode`, provider-aware opaque object references, and deterministic scoped node IDs.
- Added a PostgreSQL object loader that maps existing `postgres_catalog_schemas` and `postgres_catalog_search` responses into `connection -> catalog -> schema -> group -> relation` nodes.
- `ToolPostgres` now uses the shared `DatabaseNavigator` renderer. PostgreSQL metadata hierarchy construction and metadata IPC are outside the renderer.
- Shared live object model: YES. `DatabaseNavigator` and the PostgreSQL object loader are in production.
- Expand and selection state use stable shared node IDs. Refresh reloads expanded Navigator nodes through the loader and issues fresh metadata requests.
- PostgreSQL table opening remains on the existing `postgres_table_data` path after the adapter decodes the relation reference.
- Single-click relation open remains preserved; explicit double-click semantics are deferred.

### Feature Batch 7 - Query Provider / CodeEditor Integration - COMPLETE

- Added provider-neutral `DatabaseQueryEditorContext`, query language identity, and semantic completion contracts.
- `ToolPostgres` now creates a PostgreSQL query context through `postgresql-query-editor.ts`; `CodeEditor` receives only that shared context.
- CodeMirror PostgreSQL dialect/completion integration is isolated in `query-editor-codemirror.ts`; `CodeEditor` has no PostgreSQL imports or PostgreSQL-specific props.
- Query execution, Explain execution, IPC, Rust, profiles, storage, Navigator, and result architecture remain unchanged.

### Feature Batch 8 - Shared Result / Data Contract - COMPLETE

- Added provider-neutral tabular, command, and empty result contracts, positional row/cell values, column metadata, pagination metadata, and minimal editability metadata.
- Added the production PostgreSQL result adapter. Existing `postgres_execute`, `postgres_explain`, and `postgres_table_data` responses now cross this boundary once before reaching the shared result pane.
- `DatabaseResultPane` renders only shared result contracts. It has no PostgreSQL imports, raw IPC DTOs, or PostgreSQL type branches.
- Current IPC serializes all cells as `string | null`; the contract preserves that serialization exactly, including SQL NULL and large numeric strings. Type metadata is representable but remains `unknown`/absent until an existing IPC supplies it.
- Existing offset paging now uses shared `offset`, `limit`, and `hasMore` metadata derived from PostgreSQL's existing `truncated` response signal. Query results remain non-editable; table results retain existing primary-key metadata as shared column keys.
- Execution, IPC, Rust, profiles/storage, Navigator, and CodeEditor architecture are unchanged. No database-result CSV export or frontend editable-grid caller exists in the current source, so neither was introduced.

### Feature Batch 9 - Connection Profile Platform - COMPLETE

- Added `DatabaseConnectionProfile<TProviderId, TProviderConfig>` and typed `PostgreSQLConnectionConfig`; host, credentials, read-only, TLS, and SSH remain exclusively provider configuration.
- Added a production PostgreSQL profile adapter between the shared envelope and the existing flat PostgreSQL persistence/archive DTO.
- `PostgresConnectionsStorage`, `ToolPostgres`, the connection dialog, Navigator projection, and config archive flow now consume shared PostgreSQL profiles. Connected runtime state remains separate and unchanged.
- `postgres_connections`, its columns, encryption format, app-lock/re-encryption flow, and archive v1 `postgresConnections` format are intentionally unchanged. Existing flat rows/archives adapt on read; new saves/exports retain the existing format.

### Feature Batch 10 - SQLite Architecture Validation - COMPLETE

- A real experimental SQLite P0 provider is registered alongside PostgreSQL. It uses the shared profile envelope with `SQLiteConnectionConfig`, isolated `database_sqlite_connections` persistence, and an existing-file-only `rusqlite` runtime.
- SQLite owns `sqlite_connect`, `sqlite_disconnect`, `sqlite_execute`, and `sqlite_catalog_objects`; PostgreSQL IPC and `PostgresState` remain unchanged.
- SQLite maps its metadata, query context/completion, and runtime results into the shared `DatabaseObjectNode`, `DatabaseNavigator`, `CodeEditor`, `DatabaseResult`, `DatabaseResultPane`, and command resolver.
- The experimental SQLite toolbox entry includes a file-picker flow. SQLite profiles persist in the isolated `database_sqlite_connections` table because SQLite reserves the `sqlite_` table-name prefix.
- The shared provider-selection connection dialog and SQLite profile create/edit/delete UI are implemented. Focused frontend tests, both renderer E2E suites, SQLite Rust tests, i18n, debug Tauri build, and native desktop E2E for both providers pass.

### Feature Batch 11 - Shared Database Workspace Shell - COMPLETE

- Added production `DatabaseWorkspaceShell`, used by both `ToolPostgres` and `ToolSqlite`. It owns only the shared toolbar host, Navigator placement, query-tab host, workspace region, and optional status region.
- Provider hosts keep all runtime calls, metadata loading, query context construction, result adaptation, connection/profile dialogs, and provider-specific UI. `postgres_*`, `sqlite_*`, Rust, and persistence are unchanged.
- Focused shell/SQLite tests, PostgreSQL and SQLite renderer tests, debug Tauri build, and sequential PostgreSQL live-fixture plus SQLite real-file native tests pass.

### Feature Batch 12 - MySQL Provider Vertical Slice - COMPLETE

- Added an experimental MySQL P0 provider with an independent `mysql_async` runtime, `MysqlState`, and `mysql_*` IPC. No generic runtime, `database_*` IPC, or `DatabaseState` was added.
- MySQL profiles use isolated encrypted persistence. Its provider host maps MySQL Navigator metadata, query-editor context/completion, runtime results, and commands through the existing shared frontend/domain contracts.
- SSH, TLS, Explain, result editing, and expanded paging remain deferred and are not declared as MySQL product capabilities.
- Final verification passed focused tests, all three renderer suites, debug Tauri build, i18n, affected-file lint, MySQL Rust format/tests, and sequential PostgreSQL live-Docker, SQLite real-file, and MySQL live-Docker native suites. MySQL native verifies lossless `9007199254740993` BIGINT and `1234567890.123456789` DECIMAL rendering.

### Feature Batch 13 - Database UI Visual Consistency & Polish - COMPLETE

- Completed a real Tauri visual audit using populated PostgreSQL live-Docker, SQLite real-file, and MySQL live-Docker fixtures. Dark populated workspaces and connection dialogs were inspected for all three providers; PostgreSQL also captured light and 960x700 compact-window evidence.
- Normalized shared Navigator active/focus treatment, icon color, compact result rows, tab active/focus treatment, and Navigator scroll behavior. Successful zero-row result sets now retain table context and show the existing ready message.
- SQLite and MySQL connection dialogs now use the same bounded, Tauri-safe header/content/footer shell as PostgreSQL, including a scrollable content area and fixed action footer. PostgreSQL TLS text fields now use tokenized input background/focus treatment.
- Native visual evidence is captured under the ignored `test-results/database-visual/` directory: populated PostgreSQL, SQLite, and MySQL workspaces; all three connection dialogs; PostgreSQL light and compact-window views.
- No runtime, IPC, Rust, profile, persistence, or query execution changes were made. Remaining intentional provider differences are limited to existing capabilities: PostgreSQL retains its filter, resizable Navigator/results, pagination, status bar, and SSH/TLS pages.

### Feature Batch 14 - Shared Database Connection Dialog Shell - COMPLETE

- Implemented `DatabaseConnectionDialogShell`, shared by PostgreSQL, SQLite, and MySQL. It owns modal geometry, header, section rail, scrollable content viewport, shared form grid primitives, and fixed footer.
- Provider hosts retain field content, section availability, validation semantics, primary-action semantics, and runtime behavior. Dialog composition is shared; provider configuration, validation, runtime, and IPC remain provider-specific.
- Real Tauri visual review: PASS. PostgreSQL Dark, Light, and Small 960x700: PASS. SQLite Dark, Light, and Small 960x700: PASS. MySQL Dark, Light, and Small 960x700: PASS. Cross-provider consistency: PASS. Prior P1 dialog inconsistency: RESOLVED.
- Focused tests: PASS. PostgreSQL, SQLite, and MySQL renderer suites: PASS. Debug Tauri build: PASS. PostgreSQL, SQLite, and MySQL native suites: PASS sequentially. No product changes were made during final visual closure.
- Runtime, IPC, Rust, persistence, profile contracts, query runtime, and provider capability claims are unchanged. Screenshot captures remain ignored runtime evidence under `test-results/database-visual/`.

### Feature Batch 15 - PostgreSQL Native Stability - COMPLETE

- Fixed an incorrect frontend disconnect transition: selecting the current PostgreSQL connection node previously set local `connected` state to `false`, despite retaining the backend session. Browse then short-circuited on local disconnected state and could render no rows.
- Connection-node selection now preserves the active connection state. Table paging is scoped to each active result tab rather than shared across table identities.
- PostgreSQL nullable-column metadata now comes from `pg_attribute`; editable nullable cells can explicitly stage SQL `NULL`, independently from empty strings.
- Native acceptance uses semantic enabled/row waits rather than fixed connection or browse delays. PostgreSQL completed three consecutive live-fixture passes, followed sequentially by SQLite and MySQL passes on the same debug binary.

### Feature Batch 16 - PostgreSQL Navigator & Object Coverage - COMPLETE

- Scope was derived from the Navigator's current data/query workflows, not a PostgreSQL catalog inventory. Tables, views, and already-browseable materialized views now have distinct PostgreSQL-correct groups and stable identities.
- Functions, procedures, sequences, indexes, constraints, triggers, columns, and administration objects remain deferred because no current Navigator caller or workspace action consumes them.
- The PostgreSQL catalog adapter preserves `relkind`; the shared Navigator renders explicit loading, empty, and error states. Relation copy-name now uses a quoted schema-qualified identity.
- Native PostgreSQL E2E creates a view, refreshes the Navigator, verifies its Views group, and opens the view data. SQLite and MySQL native regressions pass sequentially.

## Last Known Verification

These are the latest known results from Feature Batch 15 verification.

| Check | Result |
| --- | --- |
| `pnpm tauri build --debug --no-bundle` | PASS |
| `pnpm e2e --spec e2e/desktop/postgres-visual.e2e.ts` | PASS: live dedicated Docker fixture |
| `pnpm e2e --spec e2e/desktop/sqlite-workspace.e2e.ts` | PASS: temporary real SQLite file |
| Live PostgreSQL | YES: dedicated Docker fixture |
| Focused Vitest: `database-command-registry.test.ts` | 13 PASS |
| Renderer E2E: `tests/postgres-workspace.e2e.spec.ts` | PASS |
| Feature Batch 6 focused Vitest | 20 PASS |
| Feature Batch 6 renderer E2E | PASS |
| Feature Batch 6 native Tauri E2E | PASS |
| Feature Batch 7 focused completion tests | PASS |
| Feature Batch 7 renderer E2E | PASS |
| Feature Batch 7 native Tauri E2E | PASS |
| Feature Batch 8 focused Vitest | 4 PASS |
| Feature Batch 8 renderer E2E | PASS |
| Feature Batch 8 native Tauri E2E | PASS, live PostgreSQL |
| Feature Batch 8 `pnpm tauri build --debug --no-bundle` | PASS |
| Feature Batch 8 touched-file lint and `git diff --check` | PASS |
| Feature Batch 9 focused profile/encryption/archive Vitest | 13 PASS |
| Feature Batch 9 renderer E2E | PASS |
| Feature Batch 9 native Tauri E2E | PASS, live PostgreSQL |
| Feature Batch 9 `pnpm tauri build --debug --no-bundle` | PASS |
| Feature Batch 9 touched-file lint and `git diff --check` | PASS |
| Feature Batch 9 full `pnpm lint` | PRE-EXISTING FAILURES outside Batch 9 files |
| Full `pnpm lint` | PRE-EXISTING FAILURES outside Batch 8 files |
| `git diff --check` | PASS |
| SQLite Rust focused tests | PASS |
| `pnpm build` with SQLite | PASS |
| `pnpm tauri build --debug --no-bundle` with SQLite | PASS |
| SQLite i18n parity and touched new-file lint | PASS |
| SQLite frontend focused tests | PASS: 34 focused tests across provider contracts and SQLite profile UI |
| SQLite renderer E2E | PASS |
| PostgreSQL renderer regression after SQLite | PASS |
| SQLite native desktop E2E | PASS: profile persistence, connect, Navigator, query, result, disconnect |
| PostgreSQL native regression after SQLite | PASS: profile persistence, connect, Navigator, query, result, Explain, disconnect |
| Feature Batch 13 renderer E2E | PASS: PostgreSQL, SQLite, MySQL workspace suites |
| Feature Batch 13 debug Tauri build | PASS |
| Feature Batch 13 native desktop E2E | PASS sequentially: PostgreSQL live Docker, SQLite real file, MySQL live Docker |
| Feature Batch 14 focused tests | PASS |
| Feature Batch 14 renderer E2E | PASS: PostgreSQL, SQLite, MySQL workspace suites |
| Feature Batch 14 debug Tauri build | PASS |
| Feature Batch 14 native desktop E2E | PASS sequentially: PostgreSQL live Docker, SQLite real file, MySQL live Docker |
| Feature Batch 14 real Tauri visual review | PASS: PostgreSQL, SQLite, and MySQL dialogs in dark, light, and 960x700 small-window views; cross-provider consistency PASS; prior P1 resolved |
| Repository-wide Rust formatter check | PRE-EXISTING REPOSITORY DIFFERENCES |
| Feature Batch 15 `pnpm tauri build --debug --no-bundle` | PASS |
| Feature Batch 15 PostgreSQL native desktop E2E | PASS x3 consecutively: live fixture, connection/context menus, query result, refresh/table browse, explicit disconnect |
| Feature Batch 15 SQLite native desktop E2E | PASS: sequentially after PostgreSQL on same debug binary |
| Feature Batch 15 MySQL native desktop E2E | PASS: sequentially after SQLite on same debug binary |

## Native Tauri Desktop E2E

- Status: PASS
- Tests: `e2e/desktop/postgres-visual.e2e.ts`, `e2e/desktop/sqlite-workspace.e2e.ts`
- Uses Real PostgreSQL: YES, dedicated Docker fixture
- Uses Real SQLite: YES, deterministic temporary file fixture
- Last Known Result: both provider suites PASS

Browser E2E remains a renderer-regression layer and is not Native Desktop E2E.

## Current Remaining Coupling

- `ToolPostgres` execution, query-editor, navigator, result, and storage paths
- PostgreSQL profile adapter and intentionally preserved `postgres_connections` persistence/archive DTO
- PostgreSQL-specific TLS/SSH/read-only settings and provider validation
- PostgreSQL object loader and table browse translation
- PostgreSQL completion semantics, catalog IPC mapping, and CodeMirror bridge
- `postgres_*` IPC and Rust `PostgresState`
- PostgreSQL result adapter and raw `postgres_*` result IPC DTOs; current IPC has no column type/nullability metadata

Detailed analysis remains in `postgresql-coupling-report.md`.

## Explicit Status

| Area | Status |
| --- | --- |
| Shared Frontend / Domain | VALIDATED for PostgreSQL + experimental SQLite P0 + experimental MySQL P0 |
| Shared Workspace Shell | COMPLETE: UI-only shell used by PostgreSQL + SQLite + MySQL |
| Shared Connection Dialog Shell | COMPLETE: `DatabaseConnectionDialogShell` used by PostgreSQL + SQLite + MySQL |
| Provider Runtime / IPC | PROVIDER-SPECIFIC: `postgres_*` / `PostgresState`, `sqlite_*` / SQLite runtime, and `mysql_*` / `MysqlState` |
| Generic Runtime / IPC | NOT IMPLEMENTED / DEFERRED |
| Generic Connection Profile | COMPLETE for PostgreSQL + SQLite + MySQL saved-profile envelope adoption |
| Generic Storage | NOT STARTED |
| Navigator Migration | COMPLETE for PostgreSQL, SQLite P0, and MySQL P0 provider object loaders |
| CodeEditor Provider Migration | COMPLETE for PostgreSQL, SQLite, and MySQL query-editor contexts |
| Shared Result / Data Contract | COMPLETE for PostgreSQL, SQLite P0, and MySQL P0 runtime adapters |
| Command Execution Migration | NOT STARTED |
| PostgreSQL IPC Migration | NOT STARTED |
| Rust Runtime Migration | NOT STARTED |
| Context Menu Parity | NOT STARTED |
| Shortcut Parity | NOT STARTED |
| Second Provider | COMPLETE: experimental SQLite P0 implemented and natively validated |
| Third Provider | COMPLETE: experimental MySQL P0 implemented and natively validated |
| Future Additional Providers | NOT STARTED |

## Next Target

MySQL remains EXPERIMENTAL / P0. The recommended next batch is MySQL Connection Security Parity, focused on evidence-backed SSH and TLS transport support. Runtime remains provider-specific; generic runtime and IPC remain deferred.

## Permanent Architecture Constraints

- Navicat Premium 17.3 Enterprise is the product baseline.
- PostgreSQL is the first provider, not the platform architecture.
- Shared Core must not depend on PostgreSQL-specific types.
- No fake providers in the production registry.
- No abstraction without a real caller.
- Command Resolver does not execute commands.
- Browser E2E is not Native Desktop E2E.
- Keep each feature batch narrowly scoped and independently verified.
- Every completed feature batch updates this status file.

## Permanent Visual Quality Gate

Every database batch that changes visible UI must include a real Tauri visual review with populated data, dark-theme evidence, light-theme evidence when affected, a small-window check, cross-provider consistency review, and screenshots. Functional renderer and native E2E remain required and do not substitute for visual acceptance.

## Session Handoff

- What changed: Feature Batch 14 added `DatabaseConnectionDialogShell` for PostgreSQL, SQLite, and MySQL dialog composition. Native E2E captures ignored dialog evidence for dark, light, and 960x700 small-window views.
- What did not change: provider runtime/IPC, query execution, profiles/storage, `PostgresState`, SQLite/MySQL runtime state, frontend mutation UI, CSV export, context menus, shortcuts, generic runtime/IPC design, and provider capability claims.
- Tests: focused shell tests, all three renderer suites, debug Tauri build, and sequential PostgreSQL, SQLite, and MySQL native suites pass.
- Real Tauri status: PostgreSQL and MySQL use isolated live Docker fixtures; SQLite uses a temporary real file. Visual review passes for all three dialogs in dark, light, and 960x700 small-window views; the prior P1 dialog inconsistency is resolved.
- Known warnings: historical Rust warnings may remain; they were not Slice 2 build failures.
- Generic command execution remains explicitly out of scope.

Last updated: 2026-08-26
