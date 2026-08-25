# NexTerm Database Development Status

## Product Baseline

Navicat Premium 17.3 Enterprise is the product baseline.

PostgreSQL is the first current provider. The long-term target is a Shared Database Platform, not a PostgreSQL-only Toolbox.

## Current Architecture

- PostgreSQL-first runtime.
- Shared TypeScript Database Core is established.
- Provider Runtime Adoption is partial: Explain, Execute, and Disconnect command availability use the Shared Command Resolver.
- UI, storage, IPC, navigator, and editor remain largely PostgreSQL-specific.

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

## Last Known Verification

These are the latest known results from the completed Slice 3 verification.

| Check | Result |
| --- | --- |
| `pnpm tauri build --debug --no-bundle` | PASS |
| `pnpm e2e --spec e2e/desktop/postgres-visual.e2e.ts` | PASS |
| Live PostgreSQL | YES |
| Focused Vitest | 15 PASS |
| Renderer E2E: `tests/postgres-workspace.e2e.spec.ts` | PASS |
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
- Fixed PostgreSQL navigator hierarchy
- CodeEditor PostgreSQL dialect/completion and `postgresCatalog`
- `postgres_*` IPC and Rust `PostgresState`
- PostgreSQL-specific result contracts

Detailed analysis remains in `postgresql-coupling-report.md`.

## Explicit Status

| Area | Status |
| --- | --- |
| Generic Connection Profile | NOT STARTED |
| Generic Storage | NOT STARTED |
| Navigator Migration | NOT STARTED |
| CodeEditor Provider Migration | NOT STARTED |
| Command Execution Migration | NOT STARTED |
| PostgreSQL IPC Migration | NOT STARTED |
| Rust Runtime Migration | NOT STARTED |
| Context Menu Parity | NOT STARTED |
| Shortcut Parity | NOT STARTED |
| Additional Providers | NOT STARTED |

## Recommendation Only

Recommended Atomic Slice 5: determine the next smallest production UI consumer of the existing Shared Command Resolver after reviewing live PostgreSQL coupling.

This is a recommendation only, not active implementation.

## Permanent Architecture Constraints

- Navicat Premium 17.3 Enterprise is the product baseline.
- PostgreSQL is the first provider, not the platform architecture.
- Shared Core must not depend on PostgreSQL-specific types.
- No fake providers in the production registry.
- No abstraction without a real caller.
- Command Resolver does not execute commands.
- Browser E2E is not Native Desktop E2E.
- One Atomic Slice at a time.
- Every completed Slice updates this status file.

## Session Handoff

- What changed: Slice 1 created the Shared TypeScript foundation; Slice 2 migrated Explain toolbar availability; Slice 3 migrated Execute toolbar availability; Slice 4 migrated Disconnect toolbar availability.
- What did not change: PostgreSQL execution, IPC, profiles, storage, navigator, editor, result contracts, context menus, and shortcuts.
- Tests: see Last Known Verification; this documentation-only session does not rerun product tests.
- Real Tauri status: available, uses live PostgreSQL, last known result PASS.
- Known warnings: historical Rust warnings may remain; they were not Slice 2 build failures.
- Recommended next atomic slice: select one smallest existing PostgreSQL UI caller that can consume the Shared Command Resolver; command execution remains explicitly out of scope.

Last updated: 2026-08-25
