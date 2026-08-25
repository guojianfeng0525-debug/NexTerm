# NexTerm Database Platform Roadmap

This sequence follows dependencies and the audited implementation, not the order of Navicat screens. Approval is required before implementation. Each approved item is one atomic capability: implement, run native Tauri, verify interaction, add E2E, then update all audit ledgers.

## Phase 0: Shared Database Core (P0)

Deliver the provider registry, versioned generic connection profile, capability/permission model, database command registry with scopes, stable metadata object IDs, workspace/tab state, operation state machine, and native Tauri test fixture. Migrate PostgreSQL without behavior regression. This unblocks every subsequent provider and prevents PostgreSQL leakage into shared UI.

Exit criteria: PostgreSQL is registered through the generic contract; connect/disconnect/test/reconnect states are visible; scoped command dispatch cannot conflict with terminal shortcuts; native E2E opens a real PostgreSQL connection.

## Phase 1: PostgreSQL Core Completion (P0)

Complete connection management, navigator objects, selection/default-open behavior, workspace tabs, query execution/current-statement/cancel, transactions, result/message/explain tabs, and the safe editable data grid. Implement only M17-confirmed grid and query interactions first. Add context menus and keyboard bindings with provider/permission enablement.

Exit criteria: table single/double/right click, Enter, scoped Delete, refresh, query run/current/stop, grid copy/paste/select/edit/save/discard, dirty confirmation, and error/permission states have native E2E evidence.

## Phase 2: Shared Query and Data Editor (P0)

Extract the PostgreSQL result/grid/editor into shared components with typed-cell viewers, grid/form modes, filter/sort/find, paging, profiles, result pinning, SQL formatting/minification, snippets and parameter queries. Add query builder design only after a provider-neutral query AST and dialect serializer exist.

## Phase 3: Shared Object Designer and ER (P1)

Build declarative object designer forms, validation, SQL preview/diff/revert, table designer, basic view designer, and reverse-engineered ER diagrams. Then add provider extensions for functions, procedures, triggers, sequences, types, users and roles. M17-confirmed ER relation drag, pan, zoom and context commands are required.

## Phase 4: MySQL/MariaDB and SQLite Providers (P1)

These have the strongest component reuse after Phase 2/3. Deliver one provider at a time: connection/auth, metadata, dialect, data editor, designer, backup/import/export and capability tests. SQLite is deliberately after MySQL/MariaDB because local-file lifecycle requires its own profile and safety decisions.

SQLite P0 architecture validation was completed early as an experimental provider: it validates shared frontend/domain contracts with renderer and native evidence, not full Phase 4 feature parity. The next evaluated extraction is a shared workspace UI composition shell; provider runtime and IPC remain out of scope.

## Phase 5: Import/Export and Backup/Restore Platform (P1)

Add stream-based wizard profiles, mapping/preview/error policy, TXT/CSV/JSON/XML first, then Excel/DBF/ODBC where platform support is justified. Add provider-owned backup/restore adapters, progress/cancel/history and explicit destructive confirmation. Do not shell out to provider tools without argument escaping, availability checks, logs, cancellation and credential protections.

## Phase 6: SQL Server and Oracle Providers (P1)

Add provider-specific authentication, object/security/design features and platform restrictions. Windows/AD authentication remains explicitly conditional. Add debugger feasibility research before committing to PL/SQL/PLpgSQL debugger work.

## Phase 7: Transfer, Synchronization, Generation, Dictionary (P2)

Build reusable operation profiles, mapping, schema/data comparison, generated DDL preview, conflict policy, progress/cancel/resume where safely feasible, deterministic data generation, and data dictionary PDF/export. Cross-provider copying uses a typed interchange model, never untyped clipboard text alone.

## Phase 8: MongoDB and Redis Providers (P2)

These are provider extensions, not relational-provider forks. MongoDB needs collections, schema analysis, aggregation pipeline and document views; Redis needs keys/data tree, console, Pub/Sub, ACL and monitoring. Deliver each separately with its own interaction matrix.

## Phase 9: Models, Automation, Server Management (P2)

Implement conceptual/logical/physical model workspaces, compare/reverse/forward synchronization, model export and data dictionary integration. Add persisted schedules, a local job runner, privilege-aware monitor operations, safe session termination confirmation, history and notifications.

## Phase 10: BI, Collaboration, AI (P3)

These are separate products/features with explicit privacy, tenancy, credential and cost decisions. BI needs immutable data-source/query contracts. Collaboration needs server/cloud architecture and conflict resolution. AI needs opt-in provider credentials, disclosed schema/context sharing, review-before-apply, audit logs and no automatic destructive execution.

## Permanent audit gates

Every atomic capability must update `navicat-premium-feature-matrix.md`, `navicat-premium-interactions.md`, `navicat-premium-context-menus.md`, `navicat-premium-shortcuts.md`, and the test matrix below.

| Test category | Required evidence |
| --- | --- |
| Unit | command scope, enablement, serializers, provider capability decisions |
| Integration | Tauri IPC against disposable provider fixture; errors and permissions |
| Browser component | grid/editor/tab rendering only; not sufficient for parity |
| Native GUI E2E | right click, double click, keyboard, drag splitter/canvas, dialogs, tab dirty behavior |
| Safety | confirmation, read-only rejection, privilege denial, cancellation and error recovery |
