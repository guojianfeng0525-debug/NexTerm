# PostgreSQL Daily-Usability Audit

## Current implementation audit

| Area | Status | Evidence / limitation |
| --- | --- | --- |
| Connection management | Full | Encrypted saved profiles, create/edit/delete, connect/disconnect, visible errors/loading. |
| SSH | Full | Provider-owned SSH tunnel fields and server host-key fingerprint verification remain in `postgres.rs`. |
| TLS / read-only | Full | PostgreSQL TLS modes and server-side read-only setup remain provider-specific. |
| Navigator | Partial | Connection, database, schema, and relation hierarchy; relation metadata currently does not classify views separately. |
| Object types | Partial | Databases, schemas, and relations are usable. Functions, procedures, sequences, indexes, and triggers are not surfaced. |
| Query workflow | Full | PostgreSQL completion, execute, single-statement Explain, query tabs, shortcut routing, and tab context actions. |
| Result / data workflow | Full | Lossless string/null cells, explicit nullable-column NULL staging, context copy, CSV export, table paging, staged non-PK edits, PK-safe save, and revert. |
| Transactions | Full | Begin, commit, and rollback are visible in query tabs with active-state availability. |
| Loading / errors | Partial | Connecting and execution indicators plus operation toasts exist; Navigator child-load failure currently resolves to an empty branch without an inline error. |

## Daily-use blockers

1. Navigator currently groups tables and views as relations, so view-specific discovery is partial.
2. Navigator metadata does not yet expose functions, procedures, sequences, indexes, or triggers.

## Interaction bindings

| Command | Binding |
| --- | --- |
| New query | Ctrl/Cmd+N |
| Execute | Ctrl/Cmd+Enter |
| Explain | Ctrl/Cmd+Shift+E |
| Close query tab | Ctrl/Cmd+W |
| Refresh navigator or active table page | Ctrl/Cmd+R |

The UI routes each action through its provider-owned PostgreSQL host and uses the shared command registry only for availability. There is no generic runtime or generic IPC.
