# PostgreSQL Coupling Report

Date: 2026-08-25

Product baseline: `navicat-premium-audit.md`, Feature Matrix, interaction, context-menu, shortcut, provider-capability, and roadmap documents in this directory.

## Coupling Map

| Area | File | Current Coupling | Should Become Shared? | Should Remain PostgreSQL-specific? | Migration Strategy |
| --- | --- | --- | --- | --- | --- |
| Toolbox entry | `src/App.tsx`, `src/components/toolbox/toolbox-nav.tsx`, `src/lib/toolbox/toolbox-types.ts` | Database is the hard-coded `postgres` toolbox leaf and is mounted as `ToolPostgres`. | Yes: a `database` entry and workspace host. | Provider display label/icon. | Route the database entry to a shared shell; select a profile and provider through the registry. |
| Workspace UI/state | `src/components/toolbox/tool-postgres.tsx` | One 1,114-line component owns profiles, lifecycle, tree, tabs, splitters, query, result, paging and dialog; it calls `postgres_*` IPC directly. | Yes: shell, navigator host, tabs, result pane, operation state, generic dialog frame. | PostgreSQL defaults, connection fields, labels and provider services. | Extract shared contracts/state first; make PostgreSQL a registered contribution instead of duplicating its current behavior. |
| Profile types | `src/lib/toolbox/toolbox-types.ts` | `PostgresConnection` mixes common identity/transport fields with PostgreSQL SSL settings. | Yes: versioned generic profile with provider ID and shared metadata. | SSL fallback mode and PostgreSQL driver settings. | Add `DatabaseConnectionProfile`; retain `PostgresConnection` only as a one-way migration source. |
| Persistence | `src/lib/toolbox/postgres-storage.ts`, `src/lib/toolbox/db.ts`, `src-tauri/src/db.rs` | Dedicated `postgres_connections` table and `nexterm:toolbox-changed` event kind. | Yes: database profile storage/events. | Provider settings serialized in a versioned payload. | Introduce `database_connections`; migrate existing encrypted records atomically and retain old table only for migration. |
| Global lifecycle | `src/lib/storage-init.ts`, `src/lib/config-export-import.ts`, `src/lib/reencrypt.ts` | Boot hydration, archive import/export, and re-encryption name PostgreSQL storage directly. | Yes: profile lifecycle/archive/secret metadata. | Provider-owned settings schema and encrypted-field declarations. | Drive these from the static provider registry; archive generic profiles with provider ID/version. |
| SQL editor | `src/components/code-editor.tsx`, `src/components/query-editor-codemirror.ts` | `CodeEditor` consumes a provider-neutral query context; CodeMirror provider integration is outside the shared editor component. | Shared dialect/completion host is implemented. | PostgreSQL grammar and CodeMirror bridge. | Additional providers contribute a query context and integration bridge without forking CodeEditor. |
| Completion | `src/lib/database/postgresql-query-editor.ts`, `src/lib/postgres-completion.ts` | PostgreSQL parser, static completions, and catalog IPC mapping are isolated behind the PostgreSQL query-context adapter. | Semantic completion context is shared. | PostgreSQL positioning/parser and catalog behavior. | Add provider adapters only with a real provider caller. |
| Tauri IPC/state | `src-tauri/src/postgres.rs`, `src-tauri/src/lib.rs` | `PostgresState`, raw `postgres_*` commands and `tokio_postgres::Client` map are the public frontend contract. | Yes: session registry, provider dispatch, generic request/result contracts. | Driver client, catalog SQL, SQL parser details, identifier quoting. | Add `DatabaseState` and a PostgreSQL adapter behind one generic command surface before retiring raw commands. |
| Connection security | `src-tauri/src/postgres.rs` | SSH host-key pinning, SSH auth, TLS roots/mTLS and timeouts are PostgreSQL request details. | Shared SSH/TLS descriptors and validation helpers. | PostgreSQL `allow`/`prefer`/`verify-*` semantics and driver connector mapping. | Preserve strict validation; providers translate common transport descriptors into driver options. |
| Object tree | `src/components/toolbox/tool-postgres.tsx`, `src/lib/database/postgresql-object-loader.ts`, `src-tauri/src/postgres.rs` | `ToolPostgres` mounts the provider-neutral `DatabaseNavigator`, which renders live shared nodes from the PostgreSQL object loader. | Shared object IDs, node roles, hierarchy rendering, selection, lazy child loading, and expand state are implemented. | PostgreSQL catalog requests/mapping, current relation coverage, relation-reference decoding, and `postgres_table_data` translation. | Additional providers contribute their own object loader; do not duplicate the Navigator renderer or object identity logic. |
| Results and data | `src/lib/database/result-types.ts`, `src/lib/database/postgresql-result-adapter.ts`, `src/components/toolbox/database-result-pane.tsx`, `src-tauri/src/postgres.rs` | PostgreSQL raw result DTOs are converted once into shared tabular/command/empty contracts before rendering. | Shared result kind, positional cells/rows, column keys, pagination, editability metadata, and grid host are implemented. | Raw IPC DTO mapping, PostgreSQL type metadata when available, PK discovery, casts, and update SQL. | Additional providers supply an adapter to the shared result contract; keep typed mutation validation provider-owned. |
| Query operations | `src-tauri/src/postgres.rs`, `ToolPostgres` | Backend supports transaction, Explain, update and fingerprint operations; UI only exposes execute/text Explain. | Yes: operation lifecycle, command enablement and capability gating. | Transaction syntax and Explain representation. | Model operation state centrally; surface only services that both adapter and UI support. |
| i18n | `src/locales/en.json`, `src/locales/zh-CN.json` | Database vocabulary is under `toolbox.postgres`. | Yes: `database.*` actions/state labels. | PostgreSQL display/default text. | Split common strings from provider contributions while preserving translations. |
| Dependencies | `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `package.json` | PostgreSQL driver crates and registration are application-level. | Yes: core provider registration. | PostgreSQL driver crates/module. | Keep drivers provider-scoped; only core contracts live in database modules. |
| Shortcuts/context menus | `src/lib/keyboard-shortcuts.ts`, `ToolPostgres` | No database scope registry; PostgreSQL workspace has no context menus. | Yes: command, scope, enablement and menu renderer infrastructure. | Provider/object action contributions. | Build command resolution before adding confirmed PostgreSQL P0 entries. |
| Tests | `src/lib/__tests__/postgres-*.test.ts`, `src-tauri/tests/postgres_integration.rs`, `tests/postgres-workspace.e2e.spec.ts`, `e2e/desktop/postgres-visual.e2e.ts` | Browser E2E only checks visibility; ignored Rust test bypasses Tauri; desktop test depends on external local DB and localized selectors. | Yes: contract fixtures, command/scope tests, native smoke harness. | PostgreSQL fixture assertions, TLS/SSH/catalog/PK cases. | Preserve browser E2E; add database native smoke independent of a server, then a disposable PostgreSQL fixture suite. |

## Reusable Existing Primitives

| Need | Existing source | Reuse decision |
| --- | --- | --- |
| Context menu rendering | `src/components/ui/context-menu.tsx` | Reuse Radix UI primitives; add database command-to-menu mapping above it. |
| Tab menu behavior | `src/components/connection-tabs.tsx` | Reuse interaction pattern only; do not couple database tabs to SSH connection tabs. |
| Shortcut parsing and xterm safety | `src/lib/keyboard-shortcuts.ts` | Extend with scoped database dispatch; retain editable-target and terminal protections. |
| Native desktop harness | `wdio.conf.ts`, `e2e/desktop/smoke.e2e.ts` | Reuse isolated data directory and Tauri service; add database smoke. |
| Browser harness | `playwright.config.ts`, `tests/postgres-workspace.e2e.spec.ts` | Retain as renderer regression. |

## Slice 1 Status

Infrastructure established; migration pending. `src/lib/database/` now contains a PostgreSQL descriptor, typed capabilities, a static registry, and a non-executing command resolver. This removes no runtime PostgreSQL coupling yet: `ToolPostgres`, profile storage, CodeEditor, Tauri IPC, object hierarchy, and tests still use their existing PostgreSQL-specific paths. The new core has no imports from PostgreSQL UI, storage, completion, or Rust modules, preserving the required dependency direction for the next slice.

## Slice 2 Status

`ToolPostgres` now consumes the shared resolver for the existing `database.query.explain` toolbar button. Its availability is resolved from the PostgreSQL provider descriptor's textual Explain capability and the current query-editor connection state; the existing local `running` guard remains in place. The action still calls `execute(true)` and the existing `postgres_explain` IPC path, so this slice changes only command availability, not execution, persistence, backend contracts, or workspace structure. Browser and native desktop coverage assert the disconnected and connected states respectively.

## Slice 3 Status

`ToolPostgres` now consumes the shared resolver for the existing `database.query.execute` toolbar button. Before this slice, the toolbar independently encoded `!connected`; now the PostgreSQL provider descriptor, shared Execute descriptor, and resolver determine connection-level availability. The local `running` guard remains in the Query Workspace. The empty-SQL guard remains in `execute()` and the button continues to be enabled for empty SQL, preserving the prior behavior. The action still calls `execute()` and the existing `postgres_execute` IPC path, so this slice changes availability only, not execution, persistence, backend contracts, or workspace structure. Renderer and native desktop coverage assert disconnected, connected, empty-SQL, and running states.

## Slice 4 Status

`ToolPostgres` now consumes the shared resolver for the existing `database.connection.disconnect` toolbar entry. Before this slice, the toolbar independently used its local `connected` state as the implied Disconnect availability rule; now the PostgreSQL provider descriptor, shared Disconnect descriptor, and resolver determine whether Disconnect is enabled. The existing toolbar continues to render its Connect entry while disconnected and Disconnect entry while connected. The Disconnect handler still invokes `postgres_disconnect` and performs the existing local state update, so this slice changes availability only, not disconnect execution, IPC, Rust session cleanup, persistence, backend contracts, or workspace structure. Renderer and native desktop coverage assert disconnected, connected, and post-disconnect states.

## Feature Batch 5 Status

`ToolPostgres` now consumes the shared resolver for the existing `database.workspace.newQuery` toolbar entry. The PostgreSQL descriptor, existing New Query command descriptor, and resolver determine connected/disconnected availability; the existing `newQuery()` and `openTab()` handler remains unchanged. Execute and Explain remain resolver-controlled with their local `running` guard. There are no other mature Query Toolbar lifecycle commands to migrate: Stop/cancel, transaction controls, Save Query, Run Selected, Run Current Statement, Format SQL, and Refresh Result have no current toolbar entry. This batch changes no query execution, IPC, Rust runtime, editor provider, result contract, profile, or storage coupling. Renderer and native desktop coverage assert New Query, Execute, and Explain availability across connection states, while native coverage also verifies live query execution and results.

## Navigator / Object Model Coupling

Feature Batch 6 moves the live PostgreSQL Navigator to a shared object model.

- `DatabaseNavigator` renders `DatabaseObjectNode` values and contains no PostgreSQL branch or field parsing.
- `postgresql-object-loader.ts` maps the existing `postgres_catalog_schemas` and `postgres_catalog_search` IPC responses into the current hierarchy and decodes a relation reference only for the preserved table browse handler.
- Node identity is deterministic and scopes provider, connection, catalog, schema, group, and relation. Expand and visual selection use those node IDs.
- Refresh reloads expanded nodes through the loader, issuing fresh metadata requests rather than reassigning unchanged schema state.
- Remaining PostgreSQL coupling is intentional: the adapter's catalog request/mapping, PostgreSQL connection runtime, and `postgres_table_data` table browse request.
- Single-click relation open is preserved. Explicit double-click semantics remain deferred.

## Feature Batch 8 - Result / Data Contract Coupling

- `DatabaseResultPane` receives `DatabaseResult` only and has no PostgreSQL import, raw IPC type, or PostgreSQL type-name branch.
- `postgresql-result-adapter.ts` owns the existing `postgres_execute`, `postgres_explain`, and `postgres_table_data` response shapes. It maps query results to non-editable tabular results, command tags to command results, and relation pages to tabular results with offset pagination and mapped primary-key column keys.
- The current simple-query Rust IPC serializes every cell as `string | null` and does not expose PostgreSQL column types, nullability, total count, or row identity. The shared model preserves lossless string values and SQL NULL, and can carry semantic/provider-native type metadata when a provider supplies it; it does not fabricate unavailable metadata.
- PostgreSQL table paging remains offset/limit based. `truncated` maps to shared `hasMore`; no new pagination framework or extra request is introduced.
- `postgres_table_update` remains provider-specific and unchanged. There is no current frontend editing or database-result CSV export caller to migrate, so Batch 8 does not claim either implementation.

## Risks To Preserve During Migration

- Do not weaken SSH host-key fingerprint checking, certificate validation, mTLS support, bounded timeouts, quoted identifiers, or primary-key update validation in `postgres.rs`.
- `CodeEditor` currently leaks PostgreSQL behavior into generic SQL notes/files; changing this requires a separate regression-tested slice.
- Raw `postgres_*` IPC has already become a UI contract. New generic IPC must be introduced behind an adapter, then callers migrated in one slice; it must not be a flag-day rewrite.
- If unrelated PostgreSQL or lockfile changes are present in a future worktree, architecture work must not discard or silently rewrite them.
- Native WDIO is real desktop infrastructure but existing PostgreSQL visual coverage is not a portable fixture; it cannot support a `FULL` parity claim.
