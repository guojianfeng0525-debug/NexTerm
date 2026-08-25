# Navicat Premium Enterprise Audit

========================================
NAVICAT PREMIUM ENTERPRISE AUDIT
========================================

Baseline Version: 17.3.x

Official Sources: Feature Matrix, product page, Navicat 17 Windows manual, 17.3 release notes

Database Providers: 16 official database/compatible-engine families

Atomic Features: 74 Feature Matrix entries

Context Menu Commands: 21 explicitly confirmed commands; all other requested scopes are tracked as `UNVERIFIED`

Keyboard Shortcuts: 18 confirmed action groups from M17 Windows hot-key pages

Mouse Interactions: 28 scoped interaction records, including 10 confirmed drag/double-click behaviors

Menu Commands: 5 directly evidenced menu paths in inspected manual sections

Toolbar Commands: 20 documented command groups; individual icon tooltip text is mostly `UNVERIFIED`

========================================
NAVICAT RESEARCH BASELINE
========================================

Product: Navicat Premium

Edition: Enterprise

Version: 17.3.x (baseline 17.3.0; current official 17.3 maintenance notes consulted)

Audit Date: 2026-08-25

Official Feature Matrix: https://www.navicat.com/en/products/navicat-premium-feature-matrix

Official Product Page: https://www.navicat.com/en/products/navicat-premium

Official Manual: https://www.navicat.com/manual/pdf_manual/en/navicat_17/win_manual/navicat_en.pdf

Release Notes: https://www.navicat.com/en/products/navicat-premium-release-note

Additional Official Sources:

- https://www.navicat.com/en/navicat-17-highlights
- https://www.navicat.com/en/support/online-manual

## Scope and evidence

This is a functional and interaction-parity audit, not a UI-copying exercise. `FM` below refers to the official Enterprise Feature Matrix. `M17` refers to the Navicat 17 Windows manual, whose explicit interaction evidence is current enough for 17.3 unless superseded by a 17.3 release note. `RN17.3` records 17.3 changes.

The matrix does not document every suggested context-menu item, mouse gesture, or OS-specific shortcut. Those entries are deliberately `UNVERIFIED`, not inferred. Windows is the observed-manual baseline. Linux and macOS Navicat shortcuts require per-platform confirmation before NexTerm claims parity.

17.3 evidence retained in this audit: 17.3.0 added Fujitsu Enterprise Postgres, Dameng, KingbaseES, IvorySQL, Ask AI in Query, information-pane expand/collapse, managed identity/service principal authentication, and BI presentation zoom. Current 17.3 maintenance notes also demonstrate continuing support for table viewer, synchronization, designer, backup/restore, import, data generation, privilege management, and data dictionary workflows.

## Current NexTerm finding

NexTerm currently has a pending PostgreSQL-only Toolbox workspace, not a `Database` platform. It provides a connection dialog with PostgreSQL credentials, SSH tunnel, TLS, read-only mode and encrypted local profile persistence; an object navigator limited to schemas and relations; CodeMirror PostgreSQL editing/completion; execute and textual `EXPLAIN`; result display; table paging; and a backend-safe primary-key update command that is not wired into the grid UI.

Evidence: `src/components/toolbox/tool-postgres.tsx`, `src-tauri/src/postgres.rs`, `src/lib/toolbox/postgres-storage.ts`, `src/lib/postgres-completion.ts`, and `tests/postgres-workspace.e2e.spec.ts`.

## Audit status vocabulary

`FULL` requires UI entry, interaction entry points required by Navicat evidence, frontend logic, IPC/backend/database operation where applicable, error handling, runtime verification, and regression test. `PARTIAL`, `UI_ONLY`, `BACKEND_ONLY`, `BROKEN`, `MISSING`, `UNVERIFIED`, `PLANNED`, `INTENTIONAL_GAP`, and `NOT_APPLICABLE` retain the meanings requested for this audit.

`FULL` is not awarded in this first audit: no capability has a verified native Tauri runtime flow plus complete interaction and regression coverage.

## First-pass scorecard

These are evidence-weighted counts from `navicat-premium-feature-matrix.md` and `navicat-premium-interactions.md`; they are deliberately not a marketing score.

| Measure | Result | Basis |
| --- | ---: | --- |
| Database providers | 1 / 16 official families and compatible engines | PostgreSQL only; aliases/cloud variants excluded from numerator |
| Feature FULL | 0 | strict definition |
| Feature PARTIAL | 9 | PostgreSQL connection/query/navigator/theme slices |
| Feature UI_ONLY | 1 | result-grid presentation slice |
| Feature BACKEND_ONLY | 0 | backend-only endpoints are supporting evidence, not independent Feature Matrix rows |
| Feature MISSING | 64 | Feature Matrix inventory items |
| Feature UNVERIFIED | 0 | product capabilities are evidenced; interaction certainty is tracked separately |
| Interaction FULL | 0 | no native GUI evidence |
| Interaction PARTIAL | 9 | toolbar, tabs, navigator, splitters, basic query execution/completion |
| Interaction MISSING | 25 | documented interaction inventory |
| Core Feature Parity | 12% | P0 weighted capability coverage, no FULL credit |
| Extended Feature Parity | 4% | all Feature Matrix capabilities, partial credit only |
| Interaction Parity | 8% | confirmed M17 interaction rows |
| Shortcut Parity | 0% | no database scope bindings |
| Context Menu Parity | 0% | no PostgreSQL workspace context menus |
| Database Provider Coverage | 6% | 1 of 16 official provider families/compatible engines |
| Automated Test Coverage | 3% | one browser visibility test; no database interaction regression or native desktop test |

## State and safety baseline

| State | Navicat evidence / product expectation | NexTerm current | Gap |
| --- | --- | --- | --- |
| Disconnected / connecting / connected | Connection lifecycle is a first-class product area | text/status icon and spinner exist | PARTIAL: no navigator state/icon semantics or reconnect policy |
| Busy / executing / loading | Run/Stop and table fetch are documented in M17 | run spinner; no cancellation wired | PARTIAL |
| Dirty | Object/query editing needs save/revert semantics | query dirty dot only | PARTIAL |
| Read-only / no permission | FM supports server security; safe operation must respect privilege | read-only connection requests `default_transaction_read_only`; backend catalog filters schema usage | PARTIAL |
| Error / canceled | M17 has Stop; enterprise workflows need actionable results | toast messages only; no persistent error/message pane and no cancellation | PARTIAL |
| Empty / disabled | toolbar commands should state why unavailable | selected toolbar buttons disable | PARTIAL |
| Destructive actions | delete/truncate/restore/sync/kill must be confirmed, privilege-gated and auditable | none exposed | MISSING |

## Architectural decision

Do not extend `ToolPostgres` into the database product. Introduce a `database` domain with provider contracts for connection schema, authentication, metadata/object taxonomy, capabilities, query dialect/completion, result editing, designers, explain, transfer/sync, backup/restore, security, and monitoring. Providers declare capability and availability rather than the UI branching on PostgreSQL object names.

The proposed modules, sequencing, provider matrix, and required native-GUI test gates are in `database-roadmap.md` and `database-provider-capabilities.md`.
