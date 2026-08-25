# Navicat Premium Shortcut and Conflict Matrix

The confirmed source is the Navicat 17 Windows manual, Hot Keys pages 379-381. macOS and Linux mappings are not mechanically inferred; they require separate official-manual or runtime confirmation. `Cmd/Ctrl` below is a NexTerm proposal, not a Navicat fact.

| Scope | Action | Windows | Linux | macOS | Navicat source | NexTerm | Conflict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Data grid | Design object | Ctrl+D | UNVERIFIED | UNVERIFIED | M17 p.380 | none | no current database binding |
| Data grid | Query object | Ctrl+Q | UNVERIFIED | UNVERIFIED | M17 p.380 | none | no current database binding |
| Data grid | Find / next / go to row | Ctrl+F / F3 / Ctrl+G | UNVERIFIED | UNVERIFIED | M17 p.380 | none | scope only |
| Data grid | Apply filter/sort | Ctrl+R | UNVERIFIED | UNVERIFIED | M17 p.380 | none | query uses Ctrl+R |
| Data grid | Open cell editor | Ctrl+Enter | UNVERIFIED | UNVERIFIED | M17 p.380 | none | scope only |
| Data grid | Add / delete record | Insert or Ctrl+N / Ctrl+Delete | UNVERIFIED | UNVERIFIED | M17 p.380 | none | Ctrl+N conflicts app new session |
| Data grid | Apply / discard / stop | Ctrl+S / Esc / Ctrl+T | UNVERIFIED | UNVERIFIED | M17 p.380 | none | Ctrl+T may be app/browser tab |
| Data grid | Selection/copy/paste | Ctrl+A, Shift+Arrow, Ctrl+C, Ctrl+V | UNVERIFIED | UNVERIFIED | M17 pp.99,380 | browser defaults | only when grid focused |
| Query | Open external file | Ctrl+O | UNVERIFIED | UNVERIFIED | M17 p.380 | none | scope only |
| Query | Select current statement | Ctrl+E | UNVERIFIED | UNVERIFIED | M17 p.380 | none | scope only |
| Query | Run / current statement / stop | Ctrl+R / Ctrl+Shift+R / Ctrl+T | UNVERIFIED | UNVERIFIED | M17 p.380 | toolbar run only | Ctrl+R duplicates grid scope; Ctrl+T risk |
| Query | Switch result tab | Alt+0 through Alt+9 | UNVERIFIED | UNVERIFIED | M17 p.380 | none | scope only |
| Query editor | Clipboard stack | Ctrl+Shift+V | UNVERIFIED | UNVERIFIED | M17 p.381 | none | platform clipboard policy |
| Query editor | Comment/uncomment | Ctrl+/ | UNVERIFIED | UNVERIFIED | M17 p.381 | CodeMirror behavior unverified | scope only |
| Query editor | Find/next | Ctrl+F / F3 | UNVERIFIED | UNVERIFIED | M17 p.381 | CodeMirror behavior unverified | scope only |
| Query editor | Zoom | Ctrl+= / Ctrl+- / Ctrl+0 | UNVERIFIED | UNVERIFIED | M17 p.381 | none | scope only |
| ER diagram | Refresh/select/move | F5 / Esc / H | UNVERIFIED | UNVERIFIED | M17 p.379 | none | F5 must not reload app |
| ER diagram | New/delete FK | R / Delete | UNVERIFIED | UNVERIFIED | M17 p.379 | none | only canvas focused |
| ER diagram | Zoom | Ctrl+=, Ctrl+- , Ctrl+0 or Ctrl+wheel | UNVERIFIED | UNVERIFIED | M17 p.379 | none | canvas focused |

## Existing NexTerm conflict audit

| Shortcut | NexTerm existing action | Navicat DB action | Conflict | Resolution |
| --- | --- | --- | --- | --- |
| Ctrl+N | New terminal session | Add grid record | Yes | bind record only in `DATA_GRID`; terminal wins in terminal scope |
| Ctrl+W | Close terminal tab | no confirmed database action | No | retain global/tab policy |
| Ctrl+Tab / Ctrl+Shift+Tab | Terminal-group tab navigation | database tab behavior proposed | Potential | route by focused workspace |
| Ctrl+B | Toggle left sidebar | none confirmed | No | retain global when no modal/editor override |
| Ctrl+J | Toggle bottom panel | none confirmed | No | retain global when not grid/editor-specific |
| Ctrl+M | Toggle right sidebar | none confirmed | No | retain global when not modal |
| Ctrl+Z | Zen mode | editor undo usually expected but not confirmed Navicat evidence | Potential | editor native undo must win in `QUERY_EDITOR` |
| Ctrl+\\ / Ctrl+Shift+\\ | Terminal split | none confirmed | No | terminal scope only |
| Ctrl+1..9 | Focus terminal group | none confirmed | No | terminal scope only |
| Ctrl+R | no registered global command found | grid apply filter/query run | No current collision | provider database scope only |

## Required shortcut architecture

Use command IDs and dispatch priority: `DIALOG`, focused editable control (`QUERY_EDITOR`, `DATA_GRID`), focused database canvas (`MODEL`, `ER_DIAGRAM`), `NAVIGATOR`, `DATABASE_WORKSPACE`, then `GLOBAL`. Register handlers only while their scope is active. Preserve terminal IME rules and never intercept keys targeting xterm textareas.
