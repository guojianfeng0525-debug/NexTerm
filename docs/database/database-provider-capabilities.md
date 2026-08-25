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

## Existing PostgreSQL migration

Move the narrow live-client registry in `src-tauri/src/postgres.rs` behind a database session service. Preserve its secure SSH fingerprint verification, TLS root/client validation, bounded query timeout, identifier quoting, and primary-key validation. Do not expose its raw `postgres_*` IPC commands as the long-term UI contract. The existing `PostgresConnection` persisted profile becomes versioned `DatabaseConnectionProfile` with `providerId: "postgresql"` and provider-owned settings.

## Safety rules

All mutation commands receive a connection identity, object identity, selected-row identity and an execution intent. Destructive operations need provider capability, evaluated privilege, read-only check, a confirmation policy, cancellable progress, an operation log, and a result/error summary. SQL text must never be constructed from unvalidated object identifiers.
