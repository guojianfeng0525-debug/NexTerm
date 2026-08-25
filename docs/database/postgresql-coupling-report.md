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
| SQL editor | `src/components/code-editor.tsx` | Every SQL note and `.sql` file uses the PostgreSQL CodeMirror dialect and completion; prop is `postgresCatalog`. | Yes: dialect/completion host. | PostgreSQL grammar, static completions, catalog lookup. | Rename the prop to a generic database completion/dialect service; do not force non-database notes to PostgreSQL. |
| Completion | `src/lib/postgres-completion.ts` | PostgreSQL keywords, types, functions and catalog requests are embedded in generic editor use. | Host protocol only. | Parser and PostgreSQL completion source. | Register it as the PostgreSQL dialect service. |
| Tauri IPC/state | `src-tauri/src/postgres.rs`, `src-tauri/src/lib.rs` | `PostgresState`, raw `postgres_*` commands and `tokio_postgres::Client` map are the public frontend contract. | Yes: session registry, provider dispatch, generic request/result contracts. | Driver client, catalog SQL, SQL parser details, identifier quoting. | Add `DatabaseState` and a PostgreSQL adapter behind one generic command surface before retiring raw commands. |
| Connection security | `src-tauri/src/postgres.rs` | SSH host-key pinning, SSH auth, TLS roots/mTLS and timeouts are PostgreSQL request details. | Shared SSH/TLS descriptors and validation helpers. | PostgreSQL `allow`/`prefer`/`verify-*` semantics and driver connector mapping. | Preserve strict validation; providers translate common transport descriptors into driver options. |
| Object tree | `src/components/toolbox/tool-postgres.tsx`, `src-tauri/src/postgres.rs` | JSX and local `treeRow(...)` hard-code connection -> database -> schema -> tables group -> relation. It directly calls `postgres_catalog_schemas` and `postgres_catalog_search`; table opening requires local `CatalogItem`, `schema`, and `postgres_table_data`. | Yes: object IDs, node roles, hierarchy, selection, lazy child loading, actions and capabilities. | PostgreSQL schema/catalog query implementation, `CatalogItem` mapping, relation subtype mapping, and table-data request translation. | Introduce a live provider-aware object-node contract and PostgreSQL adapter, rather than having the Navigator synthesize schema/table levels. |
| Results and data | `src/components/toolbox/tool-postgres.tsx`, `src-tauri/src/postgres.rs` | Result values are `string | null`; table paging and update safety depend on PostgreSQL primary-key lookup. | Yes: page/result/cell/row identity contracts and grid host. | PostgreSQL casts, PK discovery and update SQL. | Keep provider responsible for typed values and mutation validation. Do not expose editing until generic grid state exists. |
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

Navigator / Object Model Provider Migration is NOT STARTED. The current
Navigator runtime is still a PostgreSQL-specific implementation in
`ToolPostgres`, not a consumer of live shared object nodes.

- The tree is built directly in JSX through `treeRow(...)`, rather than from a
  shared node contract or provider child loader.
- Metadata loads directly through `postgres_catalog_schemas` and
  `postgres_catalog_search`.
- Table open/browse depends on the PostgreSQL-only local `CatalogItem`, its
  `schema`, and `postgres_table_data`.
- Tree identity is insufficiently scoped: the connection uses
  `connection:${connection.id}`, while database is `database`, schemas use
  `schema:${name}`, the tables group is `tables`, and relations use
  `object:${object.name}`. These keys do not consistently include connection,
  database, schema, and object hierarchy, creating cross-connection or
  cross-schema collision risk.
- Selection is split between `selectedId` and `schema`; no shared selected
  Navigator-node model exists.
- Expand/collapse state is a local `Record<string, boolean>` whose keys are
  not consistently full object identities.
- Toolbar refresh calls `setSchema(schema)`. When the value is unchanged this
  does not guarantee a metadata reload, so it is not a reliable provider
  metadata refresh path.
- There is no explicit `onDoubleClick` or double-click command. The current
  native E2E's apparent double-click table-open success can result from the
  same click handler running twice; double-click interaction parity is not
  implemented.

## Risks To Preserve During Migration

- Do not weaken SSH host-key fingerprint checking, certificate validation, mTLS support, bounded timeouts, quoted identifiers, or primary-key update validation in `postgres.rs`.
- `CodeEditor` currently leaks PostgreSQL behavior into generic SQL notes/files; changing this requires a separate regression-tested slice.
- Raw `postgres_*` IPC has already become a UI contract. New generic IPC must be introduced behind an adapter, then callers migrated in one slice; it must not be a flag-day rewrite.
- If unrelated PostgreSQL or lockfile changes are present in a future worktree, architecture work must not discard or silently rewrite them.
- Native WDIO is real desktop infrastructure but existing PostgreSQL visual coverage is not a portable fixture; it cannot support a `FULL` parity claim.
