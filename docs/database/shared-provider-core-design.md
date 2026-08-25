# Shared Provider Core Design

Date: 2026-08-25

This design records the shared frontend/domain architecture validated by PostgreSQL and the experimental SQLite P0 provider. It intentionally excludes shared backend runtime/IPC, designers, import/export, backup/restore, synchronization, automation, BI, and AI.

Implementation progress and completed Feature Batches are tracked in
`docs/database/database-development-status.md`. This design document records
architecture, dependency direction, and design boundaries; it is not the
authoritative progress log.

## Current Architecture

```text
                    Shared frontend/domain
                            |
       ------------------------------------------------
       |              |             |                 |
   Profile         Navigator     Query Editor      Result Pane
       |              |             |                 |
       ------------------------------------------------
                            ^
                            |
                Provider-specific frontend hosts
                   /                         \
          ToolPostgres                    ToolSqlite
               |                              |
        postgres_* IPC                   sqlite_* IPC
               |                              |
 PostgreSQL runtime: network,       SQLite runtime: local file,
 tokio-postgres, SSH/TLS/auth       rusqlite, locking/file semantics
```

The shared profile envelope, command resolver, object model/Navigator, query-editor context/CodeEditor, and result contract/pane are implemented and validated by both providers. Workspace composition remains owned by the two provider hosts. Runtime and IPC remain provider-specific.

## Shared Workspace Composition

```text
                 DatabaseWorkspaceShell
                    UI composition only
                    /               \
                   /                 \
        ToolPostgres                 ToolSqlite
             |                           |
        postgres_* IPC              sqlite_* IPC
             |                           |
    PostgreSQL runtime             SQLite runtime
```

`DatabaseWorkspaceShell` owns only the shared toolbar host, Navigator placement, query-tab host, workspace region, and optional status region. Provider hosts supply all slot content and callbacks, so the shell does not call provider IPC, own a runtime handle, or interpret provider payloads. Provider-specific editor/result composition remains host-owned where table paging and local-file behavior differ.

## Deferred Runtime Boundary

Current architecture intentionally keeps runtime and IPC provider-specific. PostgreSQL has network sessions, `tokio-postgres`, SSH/TLS/authentication, schemas, textual Explain, `postgres_*` IPC, and `PostgresState`. SQLite has existing local-file semantics, `rusqlite`, local locking, no SSH/TLS or PostgreSQL schema hierarchy, `sqlite_*` IPC, and independent runtime state.

No generic `database_*` IPC, generic `DatabaseState`, runtime provider, session manager, or query executor is implemented or committed as a target shape. A future runtime abstraction requires evidence of meaningful duplication across real providers; shared frontend/domain adoption does not imply a shared backend runtime.

## Minimal Shared Contracts

Only the following contracts are needed by capabilities that exist today.

| Contract | Responsibility | Current PostgreSQL mapping |
| --- | --- | --- |
| `DatabaseProviderDescriptor` | ID, display metadata, connection defaults/schema, capability set, object roles, dialect contribution | `postgresql`, port 5432, current PostgreSQL fields/completion |
| `DatabaseConnectionProfile<TProviderId, TProviderConfig>` | Saved profile ID/name/group/environment/timestamps, explicit provider identity, and typed provider configuration | PostgreSQL adapter maps the existing flat persistence DTO |
| `DatabaseCapabilities` | declared support and current availability used by commands/UI | schemas, transactions, explain, relation browsing, row paging, safe row update, SSH/TLS |
| `DatabaseObjectId` / `DatabaseObjectNode` | stable ID, parent ID, display name, object role, node kind, selectable/openable flags and action capability names | connection, database, schema, object-group, relation nodes |
| `DatabaseResult` / `DatabaseTabularResult` | tabular, command, and empty result kinds; positional rows/cells, command tags, truncation, and minimal editability | PostgreSQL result adapter maps `postgres_execute`, `postgres_explain`, and `postgres_table_data` |
| `DatabaseResultColumn` / `DatabaseResultPagination` | stable ordinal column keys/labels, optional semantic/provider-native type identity, and existing offset pagination | PostgreSQL adapter maps column names, PK names, offset/limit, and `truncated` |

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
- Multi-provider Adoption: VALIDATED for PostgreSQL and the experimental SQLite P0 provider. SQLite reuses the shared profile, Navigator, query-editor context, result contracts, and command resolver; renderer and native dual-provider validation pass.
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

The shared command resolver evaluates command IDs, scopes, capability requirements, and connection state. Provider hosts retain action callbacks and execution ownership; there is no generic command dispatcher or executor.

## Shared Result / Data Contracts

The shared result contract is intentionally positional. SQL permits duplicate output
labels, so rows are arrays aligned to ordinal `DatabaseResultColumn` keys rather
than objects indexed by column name. SQL NULL is represented by `null`; string
values remain provider-serialized to avoid precision loss for values such as
PostgreSQL `int8` and `numeric`.

```text
PostgreSQL Runtime DTO
  -> PostgreSQL Result Adapter
  -> DatabaseResult (tabular | command | empty)
  -> DatabaseResultPane
```

`DatabaseResultColumn` can carry a provider-neutral semantic type and opaque
provider-native type name. The present PostgreSQL simple-query IPC does not
provide type metadata, so its adapter deliberately emits `unknown` rather than
guessing from text values. Query results are explicitly non-editable. Table
results carry existing primary-key column references and current offset/limit/
has-more paging metadata, but provider-specific casts, PK validation, and update
execution remain outside the shared contract.

## Shared Connection Profiles

Saved connection profiles are domain data, not live connection state. The shared
envelope contains only profile metadata and a typed provider configuration:

```text
DatabaseConnectionProfile<TProviderId, TProviderConfig>
  -> PostgreSQL profile adapter
  -> existing PostgreSQL persistence/archive DTO
  -> postgres_connections
```

The envelope does not impose `host`, `port`, credentials, TLS, or SSH on every
provider. PostgreSQL owns those fields in `PostgreSQLConnectionConfig`; its
adapter maps to the existing normalized SQLite columns and flat archive v1
payload. This keeps persistence, encryption, archive compatibility, and stable
profile IDs frozen while allowing a future file-backed profile configuration to
use the same envelope. The experimental SQLite P0 implementation now does so
with a file-path configuration and separate persistence; completed renderer
and native validation proves the envelope can represent a non-network provider.

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

## Shared UI and Provider Hosts

| Shared layer | Provider-host contribution |
| --- | --- |
| Profile envelope and provider-selection connection dialog | PostgreSQL network fields and SQLite file-path fields; provider-specific persistence adapters |
| Navigator, CodeEditor, and result pane | provider object loader, query context, result adapter, and object-open callback |
| Command registry, enablement, shortcut/context-menu resolution | object action contributions and capability values |
| Workspace composition | Not yet shared. Batch 11 may extract UI-only toolbar, Navigator placement, query tabs, editor/result split, and status layout from the two hosts. |
| Runtime and IPC | `postgres_*` / PostgreSQL runtime and `sqlite_*` / SQLite runtime remain provider-specific. |
| native/browser E2E harness | PostgreSQL fixture and provider-specific assertions |

## Implementation Status

Detailed implementation progress, completed Feature Batches, verification, and
the recommended next batch are maintained exclusively in
`docs/database/database-development-status.md`.

## Architecture Guard

An experimental SQLite P0 provider now supplies those adapters and reuses the
shared profile, Navigator, CodeEditor, result pane, and command resolver.
Renderer and native validation, including the PostgreSQL regression, are
complete. This evidence justifies evaluating a UI-only workspace-shell extraction
because it has two real callers. It does not justify a generic runtime/IPC rewrite.
