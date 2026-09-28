let captureCurrentWorkspace: (() => void) | null = null;

/** Keep the window close path independent of workspace hydration. */
export function registerWorkspaceWindowSnapshot(snapshot: () => void): () => void {
  captureCurrentWorkspace = snapshot;
  return () => {
    if (captureCurrentWorkspace === snapshot) captureCurrentWorkspace = null;
  };
}

export function snapshotWorkspaceForWindowAction(): void {
  captureCurrentWorkspace?.();
}
