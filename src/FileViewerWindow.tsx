import { useMemo } from "react";
import { FileEditorView } from "./components/file-editor-view";
import { ErrorBoundary } from "./components/error-boundary";
import { useTranslation } from "react-i18next";

/**
 * Standalone file viewer rendered in a dedicated Tauri window.
 * Reads connection info from the window's URL search params:
 *   ?mode=file-viewer&connectionId=...&filePath=...&fileName=...
 *
 * URLSearchParams.get() already decodes the percent-encoding applied by the
 * sender (encodeURIComponent), so the values are used as-is — decoding again
 * would corrupt names containing '%' and throw URIError on names like "50%.txt".
 */
export function FileViewerWindow() {
  const { t } = useTranslation();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const connectionId = params.get("connectionId") ?? "";
  const filePath = params.get("filePath") ?? "";
  const fileName = params.get("fileName") ?? "Untitled";

  return (
    <ErrorBoundary label={t("app.fileViewer")}>
      <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
        <FileEditorView
          connectionId={connectionId}
          filePath={filePath}
          fileName={fileName}
          isConnected={true}
        />
      </div>
    </ErrorBoundary>
  );
}
