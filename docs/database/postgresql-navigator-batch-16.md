# PostgreSQL Navigator Batch 16

Date: 2026-08-26

## Design Intent

The Navigator locates and contextualizes provider objects. The workspace operates
on opened data and queries; object designers and server administration remain
separate future products. PostgreSQL metadata stays behind its provider loader
and `postgres_*` IPC; the shared Navigator renderer remains catalog-agnostic.

## Business Workflow Map

| Workflow | Required objects | Existing destination | Result |
| --- | --- | --- | --- |
| Browse and edit table data | table | existing table result tab | supported |
| Discover and query a view | view | existing data/query workspace | supported |
| Use a discovered relation in SQL | table/view | existing copy-name/context-menu workflow | schema-qualified name copied |
| Continue after external DDL | expanded schema groups | scoped Navigator refresh | supported |

## Coverage Decision

| Object | Classification | Batch 16 decision |
| --- | --- | --- |
| Tables | Required now | separate group and stable table identity |
| Views | Required now | separate group and stable view identity |
| Materialized views | Useful next, existing caller | retain discovery and open-data path in a separate group to avoid misclassifying them as tables |
| Functions, procedures, sequences | No current Navigator caller | deferred |
| Indexes, constraints, triggers, columns | Designer dependent | deferred |
| Users, roles, server objects | Administration dependent | deferred |

## Design / Implementation Drift

The previous status documentation said that Navigator context menus and editable
grid wiring were not started. The production host already supplied Navigator
menus, qualified-name copying infrastructure, and safe staged table edits. Batch
16 treats those as current product workflows and updates documentation; it does
not introduce a generic command dispatcher, generic runtime, or designer.

## Implementation

- Preserved PostgreSQL `relkind` across the catalog IPC boundary.
- Added table, view, and materialized-view object/icon roles with group-scoped,
  connection/catalog/schema-safe IDs.
- Kept lazy catalog requests scoped to an expanded group and refresh limited to
  expanded nodes; no per-object catalog load was introduced.
- Added explicit Navigator loading, empty, and error branch states.
- Changed relation copy-name to a correctly escaped, schema-qualified PostgreSQL
  identifier.

## Verification

- Focused Vitest object-model and command-registry tests: PASS, 20 tests.
- Renderer PostgreSQL workspace E2E: PASS.
- `pnpm build`: PASS.
- `pnpm i18n:check`: PASS.
- `cargo test postgres --lib`: PASS.
- `pnpm tauri build --debug --no-bundle`: PASS.
- Native PostgreSQL E2E: PASS with a live fixture; creates a view, refreshes the
  Navigator, verifies it under Views, and opens its data.
- Native SQLite and MySQL regression E2E: PASS.
- Native PostgreSQL test captures dark, light, and 960x700 visual evidence.

`cargo fmt --check` still reports pre-existing formatting differences outside
this batch; no broad formatting rewrite was performed in the dirty worktree.

## Business Validation

Design Followed: YES

Business Workflows Improved:
- Table and view discovery now match the existing data and query workflows.
- External-DDL refresh has explicit loading, empty, and error outcomes.

Objects Added Because Of Real Workflow:
- Views; materialized views retain the already-supported browse workflow without
  being mislabeled as tables.

Objects Explicitly Deferred:
- Functions, procedures, sequences, indexes, constraints, triggers, columns,
  designer and server-management objects.

No-current-caller Objects Avoided:
- All deferred objects above.

Navigator Responsibility Preserved: YES

Workspace Responsibility Preserved: YES

Designer/Admin Scope Leakage: NONE

Daily PostgreSQL Value: HIGH

Technical Object Count Added: 2 roles (view and materialized view)

User-visible Workflow Improvement:
- Users can distinguish tables from views, open either with the existing data
  workflow, copy an unambiguous SQL identifier, and refresh changed schemas.
