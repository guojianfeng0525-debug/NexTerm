import "./lib/i18n";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { FileViewerWindow } from "./FileViewerWindow.tsx";
import "./index.css";
import "./styles/globals.css";
import { initializeTheme } from "./lib/utils";
import { hydratePreferences } from "./lib/preferences";

// Suppress the WebKit/browser default context menu app-wide (macOS shows a
// native selection menu on right-click).
//
// IMPORTANT: registered in the BUBBLE phase, NOT capture. Radix context menus
// compose their onContextMenu handlers with `composeEventHandlers`, which
// short-circuits when `event.defaultPrevented` is already true — a capture-phase
// preventDefault would silently disable every custom menu. React's event
// delegation runs on the root container before the event bubbles up to
// `window`, so Radix triggers still open their menus (and call preventDefault
// themselves); this bubble-phase handler only cancels the native menu for
// areas with no custom handler. Registered here so both entry roots (App and
// FileViewerWindow) are covered.
window.addEventListener('contextmenu', (event) => event.preventDefault());

// Hydrate SQLite preferences (language, theme, layout, terminal/editor config,
// keyboard settings, workspace layout) before first paint, then initialize the
// theme and render. The lock screen and workspace both read these values.
void hydratePreferences().finally(() => {
  initializeTheme();

  const mode = new URLSearchParams(window.location.search).get("mode");
  const root = mode === "file-viewer" ? <FileViewerWindow /> : <App />;

  createRoot(document.getElementById("root")!).render(root);
});
