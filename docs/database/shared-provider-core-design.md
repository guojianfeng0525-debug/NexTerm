# Shared Provider Core Design

Date: 2026-08-25

This design implements only the roadmap's shared core and migration of current PostgreSQL P0 capability. It intentionally excludes new providers, designers, import/export, backup/restore, synchronization, automation, BI, and AI.

Implementation progress and completed Feature Batches are tracked in
`docs/database/database-development-status.md`. This design document records
architecture, dependency direction, and design boundaries; it is not the
authoritative progress log.

## Architecture Before

```text
Toolbox postgres view
  -> ToolPostgres monolith
  -> PostgresConnectionsStorage / PostgresConnection
  -> postgres_* Tauri commands
  -> PostgresState + tokio-postgres client map
```

The frontend owns a PostgreSQL schema/table hierarchy and directly selects PostgreSQL behavior. One backend module is both driver adapter and platform boundary.

## Architecture After

```text
Toolbox database view
  -> DatabaseWorkspaceShell
  -> Database command registry + shortcut/context-menu adapters
  -> static DatabaseProvider registry
  -> selected PostgreSQL provider contribution
  -> generic Tauri database_* commands
  -> DatabaseState dispatches to PostgreSQLProvider
  -> PostgreSQL driver, catalog SQL and dialect services
```

This is a static in-process registry, not a dynamic plugin system. Adding a provider later must add one provider contribution and adapter, not a second shell, tab system, result grid, command resolver, context menu or shortcut system.

## Minimal Shared Contracts

Only the following contracts are needed by capabilities that exist today.

| Contract | Responsibility | Current PostgreSQL mapping |
| --- | --- | --- |
| `DatabaseProviderDescriptor` | ID, display metadata, connection defaults/schema, capability set, object roles, dialect contribution | `postgresql`, port 5432, current PostgreSQL fields/completion |
| `DatabaseConnectionProfile` | Profile ID, provider ID, label/group/environment/read-only, common transport and versioned provider settings | migrate `PostgresConnection` |
| `DatabaseCapabilities` | declared support and current availability used by commands/UI | schemas, transactions, explain, relation browsing, row paging, safe row update, SSH/TLS |
| `DatabaseObjectId` / `DatabaseObjectNode` | stable ID, parent ID, display name, object role, node kind, selectable/openable flags and action capability names | connection, database, schema, object-group, relation nodes |
| `DatabaseSession` / `DatabaseOperation` | connection state and scoped busy/error/cancellation state | `PostgresState.clients`, `connecting`, `running` |
| `DatabaseQueryRequest` / `DatabaseQueryResult` | execution text, selected-range intent, result sets/message metadata, page limits | `postgres_execute`, `postgres_explain` |
| `DatabasePageRequest` / `DatabasePageResult` | provider object reference, cursor/offset, typed cells, columns, row identity and editability | `postgres_table_data` |

`DatabaseCapabilities` starts small and concrete:

```text
schemas
transactions
explain
relations
rowPaging
rowUpdate
sshTunnel
tls
readOnlyConnection
```

Future capability names listed in `database-provider-capabilities.md` (materialized views, functions, procedures, sequences, users, roles, backup, restore, visual explain, and so on) are added only with a shared caller and a real provider implementation. No speculative provider interface is created now.

### Slice 1 implementation

Slice 1 implements the TypeScript-only foundation in `src/lib/database/`: `DatabaseProviderDescriptor`, typed `DatabaseCapabilities`, the static PostgreSQL-only registry, and command descriptor/resolution types. The implemented capability set is schemas, transactions, textual Explain, backend-supported result editing, pagination, SSH tunneling, TLS, read-only connections, code completion, and relations. `explain` is structured as `none | text | visual`; PostgreSQL reports `text` and does not claim visual Explain.

The resolver is intentionally non-executing. It resolves `enabled`, `disabled`, or `hidden` from a command ID, active scope, connection state, and provider capability requirements. Its six initial IDs cover connect, disconnect, new query, object open, query execute, and query Explain. There is no UI, IPC, context-menu, shortcut, or executor integration in this slice.

## Provider Boundary

The Rust core should define one `DatabaseProvider` adapter with methods for current P0 operations:

```text
connect / disconnect
metadata hierarchy
execute / cancel when supported
begin / commit / rollback when supported
explain when supported
read page
update row when supported
```

It returns the shared contracts above. The PostgreSQL adapter retains all `pg_catalog` SQL, PostgreSQL quoting/casts, `single_statement` parsing, `tokio-postgres` driver objects, and TLS fallback semantics. It is not split into `ConnectionAdapter`, `MetadataProvider`, `ObjectProvider`, `QueryProvider`, `DataProvider`, and `ExplainProvider`: those would all have one implementation and create ceremony without a present caller.

`DesignerProvider`, `ImportExportProvider`, `BackupProvider`, `SecurityProvider`, and `MonitorProvider` are not introduced in this phase. Their product requirements remain documented in the audit; future work can extend the single provider boundary when one has a shared consumer.

## Provider-Aware Object Model

### Current Implementation

The current PostgreSQL Navigator consumes the Shared Object Model:

```text
Existing PostgreSQL Metadata
  -> PostgreSQL Object Loader / Adapter
  -> Shared DatabaseObjectNode
  -> DatabaseNavigator
  -> Existing PostgreSQL Object Open Runtime
```

The shared foundation includes `DatabaseObjectNode`, `DatabaseObjectNodeId`,
`DatabaseObjectReference`, `createDatabaseObjectNodeId`,
`postgresql-object-loader.ts`, and `DatabaseNavigator`. The PostgreSQL loader
owns `postgres_catalog_*` mapping and relation-reference decoding for the
existing `postgres_table_data` object-open path. The renderer does not inspect
PostgreSQL fields or construct the PostgreSQL hierarchy.

### Future Architecture

Additional providers should contribute their own object loader/adapter and
reuse `DatabaseNavigator`; they must not copy the tree renderer, identity,
selection, or expand/collapse behavior. More object kinds and Navicat
interaction parity are future work, not current implementation.

```text
DatabaseObjectNode
  id: { providerId, connectionId, kind, path }
  parentId?: DatabaseObjectId
  kind: connection | catalog | schema | group | object
  objectRole?: relation | view | materializedView | function | procedure | sequence | ...
  displayName
  iconRole
  hasChildren
  capabilities: action IDs
```

PostgreSQL will initially contribute `connection -> catalog(database) -> schema
-> group(relations) -> relation`. The common model supports a flat SQLite file,
MongoDB collection tree, or Redis key hierarchy later without encoding them
now. Object roles are display/action hints, not a PostgreSQL enum used by the
shell.

The intended dependency direction is:

```text
Shared Navigator Renderer
  -> Shared Provider-aware Object Node Contract
  -> Provider Object Adapter / Child Loader
  -> PostgreSQL Metadata Runtime
```

The shared renderer must not branch on `if (provider === "postgresql")` or
interpret a PostgreSQL schema/table hierarchy to load children.

### Foundation Scope

- Navigator / Object Model Shared Foundation: IMPLEMENTED.
- PostgreSQL Runtime Adoption: IMPLEMENTED.
- Multi-provider Adoption: NOT YET IMPLEMENTED.
- Extended Object Type Coverage: PARTIAL.
- Navicat Interaction Parity: INCOMPLETE.

## Command Architecture

## Provider-Aware Query Editor

`DatabaseQueryEditorContext` is the shared semantic editor contract. It carries
provider identity when present, query language identity, scoped connection/catalog/schema
metadata, and an optional semantic completion resolver. It has no CodeMirror or
PostgreSQL dependency. PostgreSQL creates this context through its query-editor
adapter; CodeMirror dialect and completion conversion live in the editor integration
layer. Generic SQL files use an explicit provider-free SQL context.

Every UI entry invokes `database.dispatch(commandId, context)`. A command has an ID, permitted scopes, capability requirements, state/permission predicate, destructive/confirmation metadata, label/shortcut metadata, and one handler. The handler is the only business action path.

Initial command set, limited to present PostgreSQL P0 and confirmed interaction work:

| Command ID | Scope | Preconditions | Entries |
| --- | --- | --- | --- |
| `database.connection.new` | DATABASE | provider registry available | toolbar/menu |
| `database.connection.edit` | NAVIGATOR | selected connection | context/menu |
| `database.connection.connect` | NAVIGATOR, DATABASE | profile valid, disconnected | double-click/context/toolbar |
| `database.connection.disconnect` | NAVIGATOR, DATABASE | connected | context/toolbar |
| `database.connection.refresh` | NAVIGATOR | connected | context/toolbar |
| `database.workspace.newQuery` | DATABASE, NAVIGATOR | connected | toolbar/object context |
| `database.object.open` | NAVIGATOR | node is openable, connected | table double-click, context, Enter |
| `database.object.refresh` | NAVIGATOR | node refresh capability | context/toolbar |
| `database.object.copyName` | NAVIGATOR | object selected | PostgreSQL P0 context |
| `database.query.execute` | QUERY_EDITOR | connected, SQL present, not running | toolbar/shortcut |
| `database.query.executeSelection` | QUERY_EDITOR | connected, selection present, not running | toolbar/shortcut |
| `database.query.explain` | QUERY_EDITOR | `explain`, single statement, not running | toolbar |
| `database.query.stop` | QUERY_EDITOR | cancellable operation running | toolbar/shortcut, only after backend support |
| `database.transaction.begin|commit|rollback` | DATABASE | `transactions`, connected | future P0 UI entry; backend already exists |
| `database.data.refresh` | DATA_GRID | selected table/page | toolbar/context |
| `database.tab.activate|close` | WORKSPACE | tab exists; close checks dirty state | tab click/close/context |

`database.object.design` is deliberately absent: current PostgreSQL code has no Table Designer. It must not become a fake command. Confirmation policy is required now in the command descriptor even though no destructive database command is exposed in the first slice.

## Context Menu Infrastructure

The existing Radix menu primitives remain rendering-only. A database context-menu resolver receives:

```text
scope, target node/cell/tab, provider capabilities, connection state,
read-only state, effective permission flags, selection count
```

It filters command descriptors and returns label, icon, shortcut display, enabled reason, destructive style and confirmation requirement. It does not contain operation callbacks. The first PostgreSQL menus must be restricted to evidence-supported/current actions: connection connect/disconnect/edit/refresh, table open/refresh/copy name, and grid copy only when the shared selection model exists. Any Navicat command marked `UNVERIFIED` stays absent.

## Shortcut Infrastructure

Extend the existing shortcut parser/hook with a database registry rather than registering window handlers inside workspace components. Dispatch priority remains:

```text
DIALOG -> QUERY_EDITOR or DATA_GRID -> MODEL/ER_DIAGRAM -> NAVIGATOR
-> DATABASE_WORKSPACE -> GLOBAL
```

Registry entries carry `windows`, `linux`, and `macos` bindings independently; unknown Navicat mappings remain undefined, rather than mechanically converting Ctrl to Command. It checks existing application/terminal bindings before registration. It preserves the existing editable-target and `.xterm` protections. The first bindings are only M17-confirmed Windows query/grid commands after their matching commands exist; `Ctrl+N` remains grid-only because it conflicts with terminal new-session globally.

## Shared UI and PostgreSQL Layer

| Shared layer | PostgreSQL contribution |
| --- | --- |
| Database shell, toolbar host, navigator host, tab strip, query layout, result-grid host, status bar | default profile values, PostgreSQL connection fields, provider icon/name |
| Command registry, enablement, shortcut/context-menu resolution | object action contributions and capability values |
| profile lifecycle and secret envelope | provider settings serialization and SSL-mode mapping |
| generic IPC DTOs and database session registry | driver client, SSH/TLS mapping, catalog SQL, completion, query/explain/table adapters |
| native/browser E2E harness | PostgreSQL fixture and provider-specific assertions |

## Implementation Status

Detailed implementation progress, completed Feature Batches, verification, and
the recommended next batch are maintained exclusively in
`docs/database/database-development-status.md`.

## Architecture Guard

After slice 4, a second SQL provider needs only a descriptor, profile settings serializer, connection/metadata/query/page adapter, dialect contribution and provider-specific tests. It must not copy the database shell, workspace tabs, query layout, result grid, command infrastructure, shortcut system, context-menu system or native test harness.
