# Database Provider Capability Architecture

## Product boundary

The target hierarchy is `NexTerm > Database > shared platform > Providers`, not `NexTerm > PostgreSQL`. A provider is a capability declaration plus implementations; UI commands ask whether a provider supports a capability and whether the active connection has permission.

## Provider contract

The shared Rust/TypeScript boundary should use provider-neutral IDs and typed requests. The minimum provider contract is:

- Connection definition, validation, secrets/authentication options, transport options, and test/connect/disconnect lifecycle.
- Metadata tree and stable object identifiers; object types, properties, DDL, and permission-aware availability.
- Dialect services: lexical language, completion catalog, parameter binding, execution, cancellation, transaction semantics, and explain formats.
- Data services: typed row values, primary/unique identity, paging/cursors, mutation safety, filters, sorting, import/export mapping, and viewers.
- Design services: editable object schemas, validation, SQL preview, diff/apply/revert.
- Operations: backup/restore, transfer, data/structure sync, generation, security, monitoring, and automation descriptors.

No shared frontend component may branch on `if (postgres)` for its core behavior. A provider may expose an extension contribution for non-relational primitives such as MongoDB pipelines or Redis Pub/Sub.

## Initial capability matrix

Legend: `T` target capability, `P` provider-specific/phase-later, `-` not applicable. This is NexTerm's planned architecture, not a statement that Navicat implements every feature for every engine.

| Capability | PostgreSQL | MySQL/MariaDB | SQLite | SQL Server | Oracle | MongoDB | Redis | Snowflake |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Schemas/catalogs | T | T | P | T | T | P | - | T |
| Transactions | T | T | T | T | T | P | P | T |
| Tables/views | T | T | T | T | T | P collections | - | T |
| Foreign keys | T | T | T | T | T | - | - | P |
| Procedures/functions | T | T | - | T | T | P server functions | - | P |
| Triggers | T | T | T | T | T | - | - | P |
| Materialized views | T | P | - | P | T | - | - | T |
| Object designer | T | T | T | T | T | P collection/schema | P ACL/key | P |
| Visual explain | T | T | P | T | T | P | - | T |
| Backup/restore | T | T | T | T | T | T | T | P |
| Import/export | T | T | T | T | T | T | T | T |
| Data/structure sync | T | T | T | T | T | P | P | P |
| Model/ER | T | T | T | T | T | P document model | - | P |
| User/security | T | T | - | T | T | T | T | P |
| Server/command monitor | T | T | - | T | T | T | T | P |

## Current Provider Coverage

- PostgreSQL: PRODUCTION BASELINE.
- SQLite: EXPERIMENTAL / P0 / VALIDATED. Renderer and native desktop validation use a deterministic temporary real file.
- MySQL: EXPERIMENTAL / P0 / VALIDATED. Renderer and native desktop validation use an isolated live Docker fixture.
- Future providers: NOT IMPLEMENTED.

The shared frontend/domain layer, `DatabaseWorkspaceShell`, and `DatabaseConnectionDialogShell` are validated by all three current providers. The dialog shell shares composition only; provider capabilities, configuration, validation, runtime, and IPC remain provider-specific.

## Experimental SQLite P0

SQLite is a real production-registered experimental P0 provider, not a full
Navicat parity claim. The current implementation supports existing local file
open, read-only open mode, table/view metadata, SQL execution, table-name
completion, and shared result rendering. It does not expose schemas,
transactions, Explain, result editing, paging, SSH, or TLS. Renderer and
native dual-provider validation are complete.

## Experimental MySQL P0

MySQL is a real production-registered experimental P0 provider, not a PostgreSQL
core-parity claim. The current implementation supports encrypted profile
persistence, network connect/disconnect, Navigator metadata, MySQL query-editor
context/completion at the current scope, query execution, shared result rendering,
and `DatabaseWorkspaceShell`. SSH, TLS, read-only connection semantics, Explain,
result editing, expanded paging, and transactions UI remain unsupported or
deferred. Renderer and native desktop validation are complete.

## Current Runtime Boundary

PostgreSQL retains its narrow live-client registry in `src-tauri/src/postgres.rs`, SSH tunneling with explicit first-use host-key trust and persisted profile fingerprint pinning, TLS root/client validation, bounded query timeout, identifier quoting, primary-key validation, `postgres_*` IPC, and `PostgresState`. A PostgreSQL SSH tunnel never opens without a trusted fingerprint, and a changed key is rejected. SQLite retains its existing-file `rusqlite` runtime and `sqlite_*` IPC. MySQL retains its independent `mysql_async` runtime, `mysql_*` IPC, and `MysqlState`.

PostgreSQL, SQLite, and MySQL each adapt provider-owned settings to the shared `DatabaseConnectionProfile` envelope while retaining isolated persistence. A generic backend session service, generic IPC, `DatabaseState`, and a unified runtime facade are deferred: the real providers have material runtime differences, and no generic target API has been selected.

## Safety rules

All mutation commands receive a connection identity, object identity, selected-row identity and an execution intent. Destructive operations need provider capability, evaluated privilege, read-only check, a confirmation policy, cancellable progress, an operation log, and a result/error summary. SQL text must never be constructed from unvalidated object identifiers.
