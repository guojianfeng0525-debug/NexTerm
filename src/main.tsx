import "./lib/i18n";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { FileViewerWindow } from "./FileViewerWindow.tsx";
import "./index.css";
import "./styles/globals.css";
import { initializeTheme } from "./lib/utils";
import { hydratePreferences } from "./lib/preferences";

// Hydrate SQLite preferences (language, theme, layout, terminal/editor config,
// keyboard settings, workspace layout) before first paint, then initialize the
// theme and render. The lock screen and workspace both read these values.
void hydratePreferences().finally(() => {
  initializeTheme();

  const mode = new URLSearchParams(window.location.search).get("mode");
  const root = mode === "file-viewer" ? <FileViewerWindow /> : <App />;

  createRoot(document.getElementById("root")!).render(root);
});
