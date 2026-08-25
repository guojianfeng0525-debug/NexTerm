# NexTerm Database Development Status

## Product Baseline

Navicat Premium 17.3 Enterprise is the product baseline.

PostgreSQL is the first current provider. The long-term target is a Shared Database Platform, not a PostgreSQL-only Toolbox.

## Current Architecture

- PostgreSQL-first runtime.
- Shared TypeScript Database Core is established.
- Provider Runtime Adoption has started, but only for one command's availability.
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

## Last Known Verification

These are the latest known results from the completed Slice 2 verification, not verification rerun in every later documentation-only session.

| Check | Result |
| --- | --- |
| `pnpm tauri build --debug --no-bundle` | PASS |
| `pnpm e2e --spec e2e/desktop/postgres-visual.e2e.ts` | PASS |
| Live PostgreSQL | YES |
| Focused Vitest | 11 PASS |
| `git diff --check` | PASS |

## Native Tauri Desktop E2E

- Status: AVAILABLE
- Test: `e2e/desktop/postgres-visual.e2e.ts`
- Uses Real PostgreSQL: YES
- Last Known Result: PASS

Browser E2E remains a renderer-regression layer and is not Native Desktop E2E.

## Current Remaining Coupling

- `ToolPostgres`
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
| Context Menu Parity | NOT STARTED |
| Shortcut Parity | NOT STARTED |
| Additional Providers | NOT STARTED |

## Recommendation Only

Recommended Atomic Slice 3: migrate `database.query.execute` toolbar availability to the Shared Database Command Resolver.

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

- What changed: Slice 1 created the Shared TypeScript foundation; Slice 2 migrated Explain toolbar availability only.
- What did not change: PostgreSQL execution, IPC, profiles, storage, navigator, editor, result contracts, context menus, and shortcuts.
- Tests: see Last Known Verification; this documentation-only session does not rerun product tests.
- Real Tauri status: available, uses live PostgreSQL, last known result PASS.
- Known warnings: historical Rust warnings may remain; they were not Slice 2 build failures.
- Recommended next atomic slice: migrate Query Execute toolbar availability, because it has an adjacent real caller and preserves execution behavior.

Last updated: 2026-08-25
