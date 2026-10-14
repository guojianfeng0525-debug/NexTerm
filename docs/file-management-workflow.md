# File management behavior and confirmation audit

The approved interaction rules apply to the terminal file browser and the
standalone local/remote file manager.

## Selection and operation ownership

Single click selects, double click opens, Ctrl/Cmd toggles selection and Shift
selects a range. Right-clicking a selected item preserves the full selection;
closing the menu preserves it too. Batch copy, cut, download and deletion use
the selected collection. Rename and duplicate remain single-item operations.
Folder paste targets that folder; background paste targets the current path.
File deletion displays the immutable server and full path list before execution.
Cross-panel drop events are accepted only by their owning visible workspace.

## Terminal following

Each terminal tab already owns a distinct connection/session ID. New PTY
sessions clear the last directory report; resumed sessions retain it. Bash
startup profiles load before a prompt hook emits OSC 7. The hook never passes
through readline and never becomes a shell-history entry.

Manual navigation pauses following until it is explicitly resumed. Hidden
workspaces do not follow background terminal prompts. A failed follow leaves
the last successful listing intact and offers a retry. Paths and listings
commit together after a successful load; stale responses cannot replace a
newer directory. Missing directory reports are shown explicitly rather than
claiming the browser is synchronized. Shells without OSC 7 reporting remain
available for manual browsing.

## Upload authorization and recovery

All active upload entry points use `useUploadPlanner`: toolbar, clipboard,
native drops, cross-panel transfers, recursive directory transfers and sync.
Inspection is batched by remote parent directory. A permission/listing error
is never treated as an absent file. Folder creation follows conflict approval;
existing folders merge, and incompatible destination types are rejected.

One conflict dialog groups the file conflicts in a batch. Each item defaults
to Skip. Replace requires a regular file; directory, symbolic-link and
same-batch name collisions allow Keep both or Skip. Bulk choices apply only to
that batch and never enable replacement for an incompatible type. The dialog
shows local/remote size and modification time without treating matching
metadata as proof of identical content.

Connection and destination paths remain fixed after planning. Hidden pending
requests remain pending without opening a modal. Changing the connection,
closing the owner or cancelling a waiting task cannot approve an old request.
Queue summaries distinguish checking, waiting, committing, skipped, cancelled,
failed and completed work. Retry expires any earlier overwrite approval.

The backend independently rechecks the approved destination metadata both
before transport and immediately before publication. Same-connection uploads
are serialized, including uploads from different views. Keep both allocates an
available numbered name and returns its actual destination to the queue.

Transport writes to a staging file. Replacement moves the old destination to
a uniquely named backup, publishes the staged file, then removes the backup.
If publication fails it restores the original. If restoration also fails, the
error reports the retained backup path. Cancellation applies to transport;
the short publish/restore transaction completes once started. This fallback
is recoverable, but does not provide a cross-client atomic conditional replace
on every FTP/SFTP server. Process interruption may leave a named backup for
manual recovery.

## Confirmation size inventory

All business AlertDialog call sites inherit the shared viewport with 16px
outer spacing and a `100dvh - 32px` maximum height. The header/body scroll while
the action footer stays visible. Dimensions are maximum widths; short dialogs
retain natural height.

| Maximum width | Confirmation families |
| --- | --- |
| 400px | Ordinary delete/clear/reset/discard prompts; connection folders; services, applications, tunnels, orchestrations, vault, documents, notes, API requests, command/query history, topology, process termination, database rows/connections, table changes; shared asynchronous confirmations |
| 480px | Shared single/bulk file deletion, directory-sync deletion lists, PostgreSQL object deletion with dependent-object details |
| 560px | Upload conflict comparison, SSH/database host-key trust, unsaved SQL disconnect choices, Windows exit/tray choices |

Legacy confirmations built with Dialog in MySQL, saved log commands and the
three topology editors are also explicitly bounded to 400px. Input forms and
editors retain their own size tiers. Native file pickers retain platform sizing.

Validation combines the source inventory with Chromium/WebKit rendering at
1280x800, 900x600, 640x480 and 375x480, including long paths, batch lists,
multiple actions, nested dialogs, cancellation focus and resizing. Additional
browser flows exercise actual file-browser selection, directory following and
upload approval through a mocked Tauri bridge. They do not mutate a real server.

Local Bash startup tests verify profile preservation, directory encoding and
history isolation. Rust upload tests exercise authorization and rollback.
Real FTP/SFTP interoperability and the Docker SSH fixture require a running
test server and remain separate integration checks.
