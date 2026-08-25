# NexTerm Database Development Status

## Product Baseline

Navicat Premium 17.3 Enterprise is the product baseline.

PostgreSQL is the first current provider. The long-term target is a Shared Database Platform, not a PostgreSQL-only Toolbox.

## Current Architecture

- PostgreSQL-first runtime.
- Shared TypeScript Database Core is established.
- Provider Runtime Adoption is partial: New Query, Explain, Execute, and Disconnect command availability use the Shared Command Resolver.
- UI, storage, and IPC remain largely PostgreSQL-specific. The Navigator and result UI consume shared provider-aware contracts through PostgreSQL adapters.

## Completed Atomic Slices

### Atomic Slice 1 - COMPLETE

- `DatabaseProviderDescriptor`
- `DatabaseCapabilities`
- Static Provider Registry
- PostgreSQL Provider Descriptor
- Database Command Descriptor
- Database Command Resolver

Constraints:

- The production registry contains only PostgreSQL.
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

## Last Known Verification

These are the latest known results from Feature Batch 8 verification.

| Check | Result |
| --- | --- |
| `pnpm tauri build --debug --no-bundle` | PASS |
| `pnpm e2e --spec e2e/desktop/postgres-visual.e2e.ts` | PASS |
| Live PostgreSQL | YES |
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
| Full `pnpm lint` | PRE-EXISTING FAILURES outside Batch 8 files |
| `git diff --check` | PASS |

## Native Tauri Desktop E2E

- Status: AVAILABLE
- Test: `e2e/desktop/postgres-visual.e2e.ts`
- Uses Real PostgreSQL: YES
- Last Known Result: PASS

Browser E2E remains a renderer-regression layer and is not Native Desktop E2E.

## Current Remaining Coupling

- `ToolPostgres` execution, query-editor, navigator, result, and storage paths
- `PostgresConnection` and `postgres_connections`
- Configuration import/export and encryption/re-encryption
- PostgreSQL object loader and table browse translation
- PostgreSQL completion semantics, catalog IPC mapping, and CodeMirror bridge
- `postgres_*` IPC and Rust `PostgresState`
- PostgreSQL result adapter and raw `postgres_*` result IPC DTOs; current IPC has no column type/nullability metadata

Detailed analysis remains in `postgresql-coupling-report.md`.

## Explicit Status

| Area | Status |
| --- | --- |
| Generic Connection Profile | NOT STARTED |
| Generic Storage | NOT STARTED |
| Navigator Migration | COMPLETE for PostgreSQL connection/catalog/schema/relation runtime |
| CodeEditor Provider Migration | COMPLETE for PostgreSQL query-editor context |
| Shared Result / Data Contract | COMPLETE for PostgreSQL query and table browse runtime |
| Command Execution Migration | NOT STARTED |
| PostgreSQL IPC Migration | NOT STARTED |
| Rust Runtime Migration | NOT STARTED |
| Context Menu Parity | NOT STARTED |
| Shortcut Parity | NOT STARTED |
| Additional Providers | NOT STARTED |

## Recommendation Only

Recommended next Feature Batch: Connection Profile Platform.

This is a recommendation only, not active implementation.

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

## Session Handoff

- What changed: Shared provider commands, Navigator nodes, query-editor context, and result/data contracts are each live through PostgreSQL adapters. Query/table result rendering now uses `DatabaseResult` and `DatabaseResultPane`.
- What did not change: PostgreSQL execution, IPC, Rust, profiles, storage, frontend mutation UI, CSV export, context menus, and shortcuts.
- Tests: Feature Batch 8 focused contract tests, renderer E2E, debug Tauri build, and native desktop E2E with live PostgreSQL pass.
- Real Tauri status: available, uses live PostgreSQL, last known result PASS.
- Known warnings: historical Rust warnings may remain; they were not Slice 2 build failures.
- Recommended next feature batch: Connection Profile Platform; generic command execution remains explicitly out of scope.

Last updated: 2026-08-25
