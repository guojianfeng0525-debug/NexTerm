# Navicat Premium Enterprise Master Feature Matrix

Source legend: `FM` is the official Enterprise Feature Matrix; `PP` is the official product page; `RN17.3` is the release notes. NexTerm status reflects the audited worktree on 2026-08-25. `UI`, `Backend`, `Runtime`, and `Test` use Yes/Partial/No.

| ID | Domain | Navicat Feature | Enterprise | Provider / limitation | Source | NexTerm | UI | Backend | Runtime | Test | Gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DB-01 | Support | MySQL 3.21+ | Yes | MySQL compatible clouds | FM | MISSING | No | No | No | No | Provider |
| DB-02 | Support | PostgreSQL 7.3+ | Yes | Fujitsu Enterprise Postgres separately listed | FM | PARTIAL | Yes | Yes | No | Partial | Complete provider/workspace |
| DB-03 | Support | SQL Server 2000+ | Yes | Windows auth Windows only | FM | MISSING | No | No | No | No | Provider |
| DB-04 | Support | Oracle 8.1+ | Yes | macOS starts at 9i | FM | MISSING | No | No | No | No | Provider |
| DB-05 | Support | SQLite 2 and 3 | Yes | local database | FM | MISSING | No | No | No | No | Provider |
| DB-06 | Support | MariaDB 5.1+ | Yes | SQL family | FM | MISSING | No | No | No | No | Provider |
| DB-07 | Support | MongoDB 3.0+ | Yes | document | FM | MISSING | No | No | No | No | Provider |
| DB-08 | Support | Redis 2.8+, Cluster, Sentinel, Garnet | Yes | key-value | FM | MISSING | No | No | No | No | Provider |
| DB-09 | Support | Snowflake | Yes | cloud warehouse | FM | MISSING | No | No | No | No | Provider |
| DB-10 | Support | OceanBase, GaussDB, TiDB, Fujitsu EP, Dameng, KingbaseES, IvorySQL | Yes | platform restrictions in FM | FM/RN17.3 | MISSING | No | No | No | No | Provider families |
| DB-11 | Cloud | AWS database services | Yes | RDS, Aurora, Redshift, DocumentDB, ElastiCache | PP/FM | MISSING | No | No | No | No | Cloud presets/auth |
| DB-12 | Cloud | Azure database services | Yes | SQL, MySQL, PostgreSQL, MariaDB, Redis, Garnet | PP/FM | MISSING | No | No | No | No | Cloud presets/auth |
| DB-13 | Cloud | Google Cloud services | Yes | Cloud SQL and Memorystore | PP/FM | MISSING | No | No | No | No | Cloud presets/auth |
| DB-14 | Cloud | Oracle, Atlas, Redis Enterprise Cloud | Yes | vendor-specific | PP/FM | MISSING | No | No | No | No | Cloud presets/auth |
| DB-15 | Cloud | Alibaba, Tencent, Huawei, OceanBase, PingCAP, Dameng, Fujitsu, Kingbase, HighGo | Yes | listed vendor variants | PP | MISSING | No | No | No | No | Compatibility policy |
| CN-01 | Connection | SSH, HTTP Tunnel, SSL/TLS | Yes | provider dependent | FM | PARTIAL | Yes | SSH/TLS only | No | Partial | HTTP tunnel, reusable transport |
| CN-02 | Connection | PAM, LDAP, Kerberos | Yes | provider dependent | FM | MISSING | No | No | No | No | Auth adapters |
| CN-03 | Connection | SQL Server Windows/AD authentication | Yes | Windows only | FM | MISSING | No | No | No | No | Provider auth |
| CN-04 | Connection | Centralized connection management | Yes | all providers | FM/PP | PARTIAL | Yes | local PostgreSQL profiles | No | Partial | cross-provider manager, batch operations |
| CN-05 | Connection | Connection profiles | Yes | all providers | FM/RN17 | PARTIAL | Yes | Yes | No | Partial | generic profile model |
| CN-06 | Connection | Connection coloring | Yes | all providers | FM/PP | MISSING | No | No | No | No | metadata UI |
| CN-07 | Connection | Import/export connection settings | Yes | all providers | FM | PARTIAL | No | config export includes PostgreSQL profiles | No | Partial | user-facing database flow |
| CN-08 | Connection | URI open / object URI | Yes | all providers | FM/PP | MISSING | No | No | No | No | URI routing |
| CO-01 | Collaboration | Projects and members | Yes | Navicat Collaboration service | FM | MISSING | No | No | No | No | P3 product decision |
| CO-02 | Collaboration | Sync connections, queries, snippets, virtual groups | Yes | cloud/on-prem collaboration | FM/PP | MISSING | No | No | No | No | P3 |
| CO-03 | Collaboration | Sync BI/model workspaces and aggregation pipelines | Yes | Enterprise | FM | MISSING | No | No | No | No | P3 |
| DE-01 | Data editor | Grid view | Yes | RDBMS/document/key-value variants | FM/M17 | PARTIAL | Yes | PG insert/update/delete | No | B17 edit loop | selection/edit/navigation, form view |
| DE-02 | Data editor | Form view | Yes | listed separately | FM | MISSING | No | No | No | No | shared editor |
| DE-03 | Data editor | Tree and JSON views | Yes | document/key-value relevant | FM | MISSING | No | No | No | No | document editor |
| DE-04 | Data editor | Data profiling | Yes | visual interactive analysis | FM/PP | MISSING | No | No | No | No | analytics module |
| DE-05 | Data editor | Text, hex, image, web, BFile viewer/editor | Yes | provider/type dependent | FM | MISSING | No | No | No | No | value viewers |
| DE-06 | Data editor | Foreign-key data selection | Yes | relational | FM | MISSING | No | No | No | No | editor adapter |
| DE-07 | Data editor | Filter, sort, find/replace | Yes | all data viewers | FM/M17 | PARTIAL | Yes | PG table tab filter (field value/custom/& sort), find bar, sort | No | B18 filter/find implemented; query-tab & cross-page find deferred | grid platform |
| DE-08 | Data editor | Table profile and datatype colors | Yes | relational | FM/PP | MISSING | No | No | No | No | persistence/theming |
| QY-01 | Query | Syntax-highlighted editor | Yes | dialect dependent | FM | PARTIAL | Yes | Yes | No | Partial | generic dialect host |
| QY-02 | Query | Code completion and snippets | Yes | provider metadata | FM/M17 | PARTIAL | completion only | catalog query | No | Partial | snippets, provider abstraction |
| QY-03 | Query | Query Builder | Yes | relational | FM/M17 | MISSING | No | No | No | No | visual query AST |
| QY-04 | Query | Find Builder and Aggregate Builder | Yes | relational | FM | MISSING | No | No | No | No | query builders |
| QY-05 | Query | Visual Explain | Yes | provider dependent | FM/PP/RN17 | PARTIAL | text result | PostgreSQL EXPLAIN | No | No | analyzed/visual plan adapter |
| QY-06 | Query | Pin query result | Yes | query | FM/PP | MISSING | No | No | No | No | immutable result store |
| QY-07 | Query | SQL beautifier/minifier and find/replace | Yes | query | FM | MISSING | No | No | No | No | editor commands |
| QY-08 | Query | Parameter queries and console | Yes | query | FM | MISSING | No | No | No | No | parameter/console model |
| OD-01 | Object design | Database object design tools | Yes | provider-specific objects | FM/PP | MISSING | No | No | No | No | designer platform |
| OD-02 | Object design | PL/SQL and PL/pgSQL debugger | Yes | Oracle/PostgreSQL | FM | MISSING | No | No | No | No | debugger adapter |
| OD-03 | Object design | View Builder and SQL preview | Yes | relational | FM | MISSING | No | No | No | No | designer/query AST |
| AI-01 | AI | Multi-model AI Assistant, context, compare, rooms | Yes | named models in FM | FM/PP | MISSING | No | No | No | No | P3, consent/security |
| AI-02 | AI | Ask AI: explain/tune/format/convert/fix/pin actions | Yes | Query integration since 17.3.0 | FM/PP/RN17.3 | MISSING | No | No | No | No | P3, explicit approval |
| BI-01 | BI | Charts, live data, calculated fields, multipage dashboard, controls, presentation | Yes | Enterprise | FM/PP | MISSING | No | No | No | No | P3 BI product |
| MO-01 | Model | Conceptual/logical/physical models | Yes | Enterprise | FM | MISSING | No | No | No | No | model domain |
| MO-02 | Model | Relational/dimensional/data vault methods | Yes | Enterprise | FM/PP | MISSING | No | No | No | No | model methods |
| MO-03 | Model | Reverse/forward sync, compare, SQL export | Yes | provider dependent | FM/PP | MISSING | No | No | No | No | model diff engine |
| MO-04 | Model | Auto-layout; vertices/layers/images/notes/labels/shapes; PDF/graphic print | Yes | Enterprise | FM/PP | MISSING | No | No | No | No | diagram canvas/export |
| IE-01 | Import/export | TXT, CSV, XML, JSON import/export | Yes | formats | FM | MISSING | No | No | No | No | wizard/streaming |
| IE-02 | Import/export | ODBC, Excel, Access, DBF import | Yes | Access Windows only | FM | MISSING | No | No | No | No | format adapters |
| IE-03 | Import/export | Excel, DBF, Access export | Yes | Access Windows only | FM | MISSING | No | No | No | No | format adapters |
| IE-04 | Import/export | MongoImport/MongoExport | Yes | MongoDB | FM | MISSING | No | No | No | No | provider adapter |
| SY-01 | Migration | Structure synchronization | Yes | provider dependent | FM | MISSING | No | No | No | No | schema comparison |
| SY-02 | Migration | Data transfer, same/cross server type | Yes | cross-provider | FM/PP | MISSING | No | No | No | No | mapping/streaming |
| SY-03 | Migration | Data synchronization | Yes | provider dependent | FM | MISSING | No | No | No | No | comparison/conflict |
| SY-04 | Migration | Data generation | Yes | constraints/referential integrity | FM/PP | MISSING | No | No | No | No | generators |
| SY-05 | Migration | Data dictionary | Yes | PDF automation in PP | FM/PP | MISSING | No | No | No | No | documentation generator |
| SY-06 | Migration | Copy/paste data across databases | Yes | cross-provider workflow | FM | MISSING | No | No | No | No | typed interchange |
| BR-01 | Backup | Backup/restore MySQL, MariaDB, PostgreSQL, Redis, SQLite | Yes | provider tools | FM | MISSING | No | No | No | No | profile/executor |
| BR-02 | Backup | Convert backup to SQL; dump/execute SQL; Redis command file | Yes | provider dependent | FM | MISSING | No | No | No | No | tooling |
| BR-03 | Backup | MongoDump/MongoRestore, Oracle Data Pump, SQL Server backup/restore | Yes | provider utilities | FM/PP | MISSING | No | No | No | No | provider tooling |
| AU-01 | Automation | Schedules for query, backup, transfer, sync, generation, dictionary, pipeline, BI, model, import/export, Mongo and MapReduce | Yes | listed tasks | FM | MISSING | No | No | No | No | scheduler/job runner |
| AU-02 | Automation | Multi-server batch jobs and email export attachment | Yes | Enterprise | FM | MISSING | No | No | No | No | job history/notifications |
| SM-01 | Server | Manage users | Yes | provider-specific security | FM | MISSING | No | No | No | No | security adapter |
| SM-02 | Server | Server monitor and command monitor | Yes | provider-specific | FM/RN17 | MISSING | No | No | No | No | safe monitoring |
| OT-01 | Other | ER diagram view | Yes | relational | FM/M17 | MISSING | No | No | No | No | ER workspace |
| OT-02 | Other | Aggregation pipeline and schema analysis | Yes | MongoDB | FM/PP | MISSING | No | No | No | No | MongoDB provider |
| OT-03 | Other | Redis Pub/Sub | Yes | Redis | FM/PP | MISSING | No | No | No | No | Redis provider |
| OT-04 | Other | Virtual grouping, database-wide search, favorites | Yes | all providers | FM/PP | MISSING | No | No | No | No | workspace metadata |
| OT-05 | Other | Focus mode and dark mode | Yes | native UI | FM/PP | PARTIAL | app theme/layout exists | N/A | No | Existing app tests | database-specific behavior |

## Explicitly excluded assumptions

The official matrix establishes capability availability, not a universal implementation for every provider or a detailed menu command list. Fine-grained objects, menus, shortcuts, and gestures therefore live in the interaction documents with scope and evidence level.
