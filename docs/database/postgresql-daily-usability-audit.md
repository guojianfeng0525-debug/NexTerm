# PostgreSQL Daily-Usability Audit

## Current implementation audit

| Area | Status | Evidence / limitation |
| --- | --- | --- |
| Connection management | Full | Encrypted saved profiles, create/edit/delete, connect/disconnect, visible errors/loading. |
| SSH | Full | Provider-owned SSH tunnel fields and server host-key fingerprint verification remain in `postgres.rs`. |
| TLS / read-only | Full | PostgreSQL TLS modes and server-side read-only setup remain provider-specific. |
| Navigator | Full | Connection, database, schema, and lazy table/view/materialized-view groups with stable scoped identity and explicit loading, empty, and error outcomes. |
| Object types | Partial | Databases, schemas, tables, views, and materialized views are usable. Functions, procedures, sequences, indexes, and triggers are intentionally deferred without a current caller. |
| Query workflow | Full | PostgreSQL completion, execute, single-statement Explain, query tabs, shortcut routing, and tab context actions. |
| Result / data workflow | Full | Lossless string/null cells, explicit nullable-column NULL staging, context copy, CSV export, table paging, staged non-PK edits, PK-safe save, and revert. |
| Transactions | Full | Begin, commit, and rollback are visible in query tabs with active-state availability. |
| Loading / errors | Full | Connecting and execution indicators plus operation toasts exist; Navigator child-load states distinguish loading, empty, and retryable inline errors. |

## Daily-use blockers

1. Functions, procedures, sequences, indexes, and triggers remain deferred because no current Navigator action/workspace caller consumes them.

## Interaction bindings

| Command | Binding |
| --- | --- |
| New query | Ctrl/Cmd+N |
| Execute | Ctrl/Cmd+Enter |
| Explain | Ctrl/Cmd+Shift+E |
| Close query tab | Ctrl/Cmd+W |
| Refresh navigator or active table page | Ctrl/Cmd+R |

The UI routes each action through its provider-owned PostgreSQL host and uses the shared command registry only for availability. There is no generic runtime or generic IPC.
