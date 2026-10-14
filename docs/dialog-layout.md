# Dialog layout

`DialogContent` and `AlertDialogContent` share `ui/dialog-layout.tsx`. All business
dialogs inherit a viewport that centers the content with 16px outer spacing.
Content uses its natural height, is limited to `100dvh - 32px`, and defaults to
512px maximum width for ordinary dialogs. Confirmations use 400px by default,
480px for file/dependency lists and 560px for upload comparisons, host-key
trust and multiple-action choices (see `file-management-workflow.md`).
The viewport owns positioning: do not add `fixed`, `inset`,
`top`, `left`, translation, auto margins or responsive maximum-width overrides
to Content. Mixing these with the old transform centering caused stretched or
displaced confirmations in WKWebView.

- Compact dialogs set only a maximum width, such as `max-w-sm`.
- Long ordinary forms inherit scrolling from Content.
- Large forms with a fixed header/footer use an explicit capped height, e.g.
  `h-[680px] max-w-[900px] flex flex-col gap-0 overflow-hidden p-0`. Their body
  must use `min-h-0 flex-1 overflow-y-auto`. Headers and footers do not shrink.
- Never put `h-fit` on a dialog with a `flex-1` body.
- Alert headers and optional bodies scroll independently; the Cancel/Confirm
  footer stays visible. File deletion keeps the full target path in its list.
- Use the local `useDialogRequest` hook for asynchronous confirmation or input
  requests. Supply page activity, an immutable scope key and an ownership check
  for file operations. Closing the owner, changing the server/directory, or
  unmounting resolves pending requests as cancellation. Recheck ownership after
  awaiting before executing an operation.
- Native operating-system file pickers retain the platform layout.

The source inventory covers all business Dialog/AlertDialog call sites and
rejects page-level positioning and browser `confirm`/`prompt`/`alert`. Browser
regressions render actual components with a mocked Tauri bridge; they never
connect to a server or execute remote commands.

```sh
pnpm test
pnpm exec playwright install chromium webkit
pnpm exec playwright test --config playwright.dialogs.config.ts --workers=2
```

The browser suite checks Chromium and WebKit at 1280×800, 900×600, 640×480 and
375×480, including bulk-delete long paths, small confirmations, connection and
settings tabs, database forms, topology editing, log commands, directory-sync
comparison, resize, nested dialogs, cancellation focus and outside clicks.
