# Navicat Premium Interaction Inventory

Sources: `M17 p.` means printed page in the Navicat 17 Windows manual. `UNVERIFIED` means the official sources examined do not establish that exact behavior. NexTerm assessments are code inspection only until native Tauri E2E evidence exists.

## Interaction Matrix

| ID | Scope | Target | Action | Mouse | Shortcut | Menu | Context menu | NexTerm | Gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IN-01 | Navigator | Database/schema | Connect/open | double-click connects | None confirmed | View > Navigation Pane | UNVERIFIED | MISSING | generic navigator event model |
| IN-02 | Navigator | Table | Default open | double-click opens viewer in List/Detail; Designer in ER view | Enter UNVERIFIED | object toolbar | UNVERIFIED | PARTIAL: single click browses | single/double/Enter semantics |
| IN-03 | Navigator | Object group | Expand/collapse | click UNVERIFIED | None confirmed | View navigation controls | UNVERIFIED | PARTIAL: single click toggles | selected/focused state |
| IN-04 | Object pane | Objects | List/detail/ER view switch | toolbar click | None confirmed | View | UNVERIFIED | MISSING | view modes |
| IN-05 | Workspace | Main toolbar | Configure appearance | right-click toolbar | None confirmed | View | Use Big Icons; Show Caption | MISSING | toolbar customization |
| IN-06 | Workspace | Splitters | Resize navigator/result | drag splitter | None confirmed | N/A | N/A | PARTIAL | persist/keyboard/a11y |
| IN-07 | Workspace | Tabs | Activate/close | click / close click | app tab shortcuts conflict | Window UNVERIFIED | tab menu UNVERIFIED | PARTIAL | dirty confirmation/context/menu |
| IN-08 | Data grid | Cell | Edit | click then type; CTRL+ENTER opens editor | CTRL+ENTER | toolbar Cell Editor | cell actions below | MISSING | editor state/value adapters |
| IN-09 | Data grid | Block | Fill compatible cells | select then type | Shift+Arrow | N/A | UNVERIFIED | MISSING | multi-cell model |
| IN-10 | Data grid | Cell/row | Select | Ctrl-click row; Shift range | Ctrl+A, Shift+Arrow | Edit UNVERIFIED | Copy/Paste | MISSING | selection state |
| IN-11 | Data grid | Cell block | Copy/paste | click/context | Ctrl+C/Ctrl+V | Edit UNVERIFIED | Copy/Paste | MISSING | clipboard + transaction warning |
| IN-12 | Data grid | Column header | Reorder/resize/best-fit | drag header; drag border; double-click border | None confirmed | Columns toolbar | Freeze, width, type/comment | MISSING | column layout subsystem |
| IN-13 | Data grid | Row header | Set row height | context click | None confirmed | N/A | Set Row Height | MISSING | grid rendering |
| IN-14 | Data grid | Record | Add/delete/save/discard/stop | toolbar/context | Ctrl+N/Insert; Ctrl+Delete; Ctrl+S; Esc; Ctrl+T | Data toolbar | Delete Record | MISSING | mutations and safety |
| IN-15 | Data grid | Value | Set empty/NULL/UUID | context click | None confirmed | N/A | Set Empty String; Set NULL; Generate UUID where supported | MISSING | typed value commands |
| IN-16 | Data grid | Cell/grid/field | Filter | context click | Ctrl+R apply | Filter & Sort | field value/custom/filter-sort | MISSING | predicate builder |
| IN-17 | Data grid | Data viewer | Find/navigation | toolbar | Ctrl+F; F3; Ctrl+G | Edit/Data | UNVERIFIED | MISSING | find/record navigation |
| IN-18 | Query editor | SQL | Execute | toolbar click | Ctrl+R; Ctrl+Shift+R current statement | Query | run context UNVERIFIED | PARTIAL: toolbar run | scoped bindings/current statement/stop |
| IN-19 | Query editor | SQL | Completion | type `.`, arrows then Tab/Enter | Tab/Enter | Query | UNVERIFIED | PARTIAL: CodeMirror completion | provider-neutral metadata |
| IN-20 | Query editor | Identifier pane | Insert identifier | drag/drop or double-click | None confirmed | Query | N/A | MISSING | identifiers pane/DnD |
| IN-21 | Query editor | Text | Edit/search/comment/zoom | editor interaction | Ctrl+F, F3, Ctrl+/, Ctrl+=, Ctrl+-, Ctrl+0 | Edit | standard edit menu UNVERIFIED | PARTIAL: editor defaults only | audited bindings |
| IN-22 | Query result | Result tabs | Switch/pin | tab click/pin toolbar | Alt+0..9 | Query | UNVERIFIED | PARTIAL: single result | multiple/pinned/message/explain tabs |
| IN-23 | Query builder | Object pane | Add table/view | drag/drop or double-click | None confirmed | Query Builder | N/A | MISSING | query canvas |
| IN-24 | Query builder | Diagram object | Alias/remove | double-click title/right-click | None confirmed | Query Builder | Remove | MISSING | AST/canvas |
| IN-25 | Query builder | Fields/join | Create/edit/remove association | drag field; double-click connector; context click | None confirmed | Query Builder | Remove/Edit Join; Add Field To | MISSING | join model |
| IN-26 | Query builder | Diagram | Zoom | context click | None confirmed | View UNVERIFIED | Zoom In/Out/100% | MISSING | canvas |
| IN-27 | ER diagram | Relation | Create/delete/design FK | drag child field to parent; right-click line | R; Delete | ER toolbar | Design/Delete Foreign Key | MISSING | ER workspace |
| IN-28 | ER diagram | Canvas | Select/move/zoom | SPACE-drag pan; Ctrl-wheel | Esc; H; Ctrl+=/-/0 | View UNVERIFIED | UNVERIFIED | MISSING | ER workspace |
| IN-29 | Connection | Connection profile | Create/edit/test/open/close/reconnect | entry points UNVERIFIED | None confirmed | connection menus UNVERIFIED | UNVERIFIED | PARTIAL | lifecycle/menus/test/reconnect |
| IN-30 | Import/export | Wizard | source/target/mapping/preview/execute/cancel | wizard | None confirmed | Tools UNVERIFIED | object menus UNVERIFIED | MISSING | workflow engine |
| IN-31 | Sync/transfer | Wizard | compare/preview/execute/progress | wizard | None confirmed | Tools UNVERIFIED | object menus UNVERIFIED | MISSING | workflow engine |
| IN-32 | Backup/restore | Profile/job | run/progress/cancel/history | wizard/job | None confirmed | Tools UNVERIFIED | object menus UNVERIFIED | MISSING | workflow engine |
| IN-33 | Designer | Object | edit/save/revert/SQL preview | tab interaction | shortcuts UNVERIFIED | object menus UNVERIFIED | UNVERIFIED | MISSING | designer platform |
| IN-34 | Model/BI | Canvas/dashboard | select, drag, zoom, presentation | drag/click | exact key map UNVERIFIED | model/BI menu UNVERIFIED | UNVERIFIED | MISSING | P2/P3 modules |

## Data Grid Interaction Matrix

| Action | Navicat trigger | Shortcut | Mouse | Context menu | NexTerm | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Single cell edit | select field and type | Ctrl+Enter opens editor | click then type | UNVERIFIED | read-only cell | MISSING |
| Multi-cell fill | select compatible block then type | Shift+Arrow expands | drag selection UNVERIFIED | UNVERIFIED | none | MISSING |
| Row range selection | select rows | Ctrl+A, Shift+Arrow | Ctrl-click; Shift range | UNVERIFIED | none | MISSING |
| Copy/paste | selected block | Ctrl+C / Ctrl+V | selection | Copy / Paste | browser selection only | PARTIAL |
| Add/delete/save/discard | navigation bar | Ctrl+N/Insert; Ctrl+Delete; Ctrl+S; Esc | toolbar click | Delete Record | none | MISSING |
| NULL/empty/UUID | selected cell | None confirmed | right-click | Set to NULL / Empty / UUID | none | MISSING |
| Filter | selected field/cell/grid | Ctrl+R applies | right-click | Field Value / Custom / Filter & Sort | none | MISSING |
| Reorder/resize/best fit | header manipulation | None confirmed | drag header/border; double-click border | width/freeze controls | none | MISSING |
| Record navigation | navigation bar | Ctrl+G; page keys UNVERIFIED | navigation click | UNVERIFIED | table paging buttons | PARTIAL |

## Mouse Interaction Inventory

| Scope | Target | Single Click | Double Click | Right Click | Drag | Modifier Click | NexTerm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Navigator | database/schema | UNVERIFIED | connect | UNVERIFIED | UNVERIFIED | UNVERIFIED | click toggles/selects inconsistently |
| Navigator | table | UNVERIFIED | viewer or designer by current object view | UNVERIFIED | UNVERIFIED | UNVERIFIED | click opens data |
| Data grid | cell/row | select/edit flow | UNVERIFIED | typed actions/filter | select block UNVERIFIED | Ctrl row / Shift range | static read-only table |
| Data grid | column header | select UNVERIFIED | best-fit at border | layout actions | reorder/resize | UNVERIFIED | none |
| Query editor | identifier | UNVERIFIED | inserts identifier | UNVERIFIED | inserts identifier | UNVERIFIED | no identifier pane |
| Query builder | object/field | select UNVERIFIED | add/alias/join-type according target | edit/remove | add object/create join | UNVERIFIED | missing |
| ER diagram | canvas/relation | select UNVERIFIED | UNVERIFIED | relation design/delete | Space pan; field relation | Ctrl-wheel zoom | missing |
| Workspace | splitter | N/A | UNVERIFIED | UNVERIFIED | resize | N/A | navigator/result resize exists |
| Workspace | tab | activate | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | activate/close only |

## Double Click Matrix

| Target | Single Click | Double Click | Right Click | Enter Key |
| --- | --- | --- | --- | --- |
| Connection | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Database/schema | UNVERIFIED | connect | UNVERIFIED | UNVERIFIED |
| Table in List/Detail | UNVERIFIED | open Table Viewer | UNVERIFIED | UNVERIFIED |
| Table in ER diagram view | UNVERIFIED | open Table Designer | UNVERIFIED | UNVERIFIED |
| Query builder object | select UNVERIFIED | set alias | Remove | UNVERIFIED |
| Query identifiers pane item | UNVERIFIED | insert identifier | UNVERIFIED | UNVERIFIED |
| Query builder connector | select UNVERIFIED | change join type | Remove/Edit Join | UNVERIFIED |
| Grid column-border | N/A | best fit | layout actions | N/A |
| Workspace tab / tree group / row / cell / model | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |

## Menu Command Matrix

Only the following menu paths are directly established in the inspected M17 sections. The top-level File/Edit/Favorites/Tools/Window/Help map needs a dedicated 17.3 runtime capture before parity claims.

| Menu | Submenu | Command | Shortcut | Enabled condition | NexTerm |
| --- | --- | --- | --- | --- | --- |
| View | Navigation Pane | Show Navigation Pane | None confirmed | workspace | app layout only |
| View | Navigation Pane | Flatten Connection | None confirmed | navigator | missing |
| View | Object pane | List / Detail / ER Diagram views | None confirmed | object pane | missing |
| Query | Query Designer | Run / current statement / selected / Stop | Ctrl+R / Ctrl+Shift+R / Ctrl+T | connection/query state | toolbar run only |
| Data | Data editor | Cell Editor / Filter & Sort / Columns / Profiling / Import / Export | mixed, see shortcut matrix | selected object/capability | missing |

## Toolbar Matrix

| Workspace | Group | Button | Dropdown | Tooltip | Shortcut | Enable rule | NexTerm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Main | global | connections, users, tables, collections, backup, automation | UNVERIFIED | UNVERIFIED | None confirmed | provider/license/context | PostgreSQL-only new connection/query/tables/refresh |
| Data editor | data | Cell Editor, Filter & Sort, Columns, Data Profiling, Import, Export | UNVERIFIED | UNVERIFIED | see shortcuts | table/capability | missing |
| Data editor | navigation | add/delete/apply/discard/refresh/stop/page/record navigation | UNVERIFIED | UNVERIFIED | see shortcuts | grid mutation/loading state | paging only |
| Query | execution | Run, Run Current Statement, Run Selected, Stop | Run menu documented | UNVERIFIED | Ctrl+R/Ctrl+Shift+R/Ctrl+T | connected/running/selection | Run and text Explain; no stop/current/selected |
| ER diagram | canvas | New Foreign Key / select/move/refresh/zoom | UNVERIFIED | UNVERIFIED | R/Esc/H/F5/zoom | relational diagram state | missing |
