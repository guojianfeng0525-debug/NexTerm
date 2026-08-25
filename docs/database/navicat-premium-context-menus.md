# Navicat Premium Context Menu Inventory

This matrix only claims explicit menu items found in the Navicat 17 Windows manual. The Feature Matrix does not define universal right-click menus. Broad object-menu examples without manual evidence remain `UNVERIFIED`; they must be tested in a licensed 17.3 Enterprise build before becoming the NexTerm parity baseline.

| Scope | Object | Menu item | Condition | Navicat behavior / evidence | NexTerm | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Main toolbar | toolbar background | Use Big Icons | toolbar right-click | toggle icon size, M17 p.27 | none | MISSING |
| Main toolbar | toolbar background | Show Caption | toolbar right-click | toggle captions, M17 p.27 | none | MISSING |
| Data grid | selected record | Delete Record | selected record | delete record, M17 p.95 | none | MISSING |
| Data grid | selected cell | Set to Empty String | selected cell | assign empty string, M17 p.95 | none | MISSING |
| Data grid | selected cell | Set to NULL | selected cell | assign NULL, M17 p.95 | none | MISSING |
| Data grid | selected cell | Generate UUID | supporting provider/type | generate UUID, M17 p.95 | none | MISSING |
| Data grid | selected cell | Filter by field value | cell has value | builds field-value filter, M17 p.98 | none | MISSING |
| Data grid | grid | Custom Filter | grid right-click | opens custom filter, M17 p.98 | none | MISSING |
| Data grid | field | Filter & Sort | field context | opens filter/sort, M17 p.98 | none | MISSING |
| Data grid | selected block | Copy / Paste | selection | clipboard commands, M17 p.99 | browser default only | PARTIAL |
| Data grid | column header | Freeze Column | header context | freeze selected column, M17 p.101 | none | MISSING |
| Data grid | column header | Unfreeze All Columns | header context | remove frozen state, M17 p.101 | none | MISSING |
| Data grid | column header | Set Column Width | header context | exact width, M17 p.101 | none | MISSING |
| Data grid | column header | Show Field Type / Show Comment | header context | metadata display, M17 p.102 | none | MISSING |
| Data grid | row header | Set Row Height | header context | row height, M17 p.101 | none | MISSING |
| Query builder | diagram object | Remove | object right-click | removes table/view, M17 p.132 | none | MISSING |
| Query builder | join | Remove / Edit Join | join right-click | manipulate association, M17 p.132 | none | MISSING |
| Query builder | field | Add Field To WHERE/GROUP BY/ORDER BY ASC/DESC | field right-click | add clause entry, M17 p.133 | none | MISSING |
| Query builder | diagram | Zoom In / Zoom Out / 100% | diagram right-click | canvas zoom, M17 p.132 | none | MISSING |
| ER diagram | relation line | Design Foreign Key | relation right-click | opens FK designer, M17 p.30 | none | MISSING |
| ER diagram | relation line | Delete Foreign Key | relation right-click | removes relation, M17 p.30 | none | MISSING |
| Navigator | connection/database/schema/table/view/function/procedure/sequence/trigger/index/query/model/BI/backup/user-role | full object menu | object right-click | UNVERIFIED in examined official sources | none | UNVERIFIED |
| Object list | blank/single/multi selection | full object menu | right-click | UNVERIFIED in examined official sources | none | UNVERIFIED |
| Query editor | text/selection | full editor menu | right-click | UNVERIFIED in examined official sources | browser/editor default only | UNVERIFIED |
| Workspace tabs | tab | tab menu | right-click | UNVERIFIED in examined official sources | none | UNVERIFIED |

## Required verification protocol

For every `UNVERIFIED` row, record Navicat 17.3 edition, OS, provider, selected object type, enabled/disabled commands, screenshots/video, and the exact state prerequisite. NexTerm must not implement an invented command merely to fill a menu.
