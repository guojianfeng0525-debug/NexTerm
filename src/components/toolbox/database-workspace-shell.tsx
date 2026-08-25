import type { ReactNode } from "react";
import { FileCode2, X } from "lucide-react";

export interface DatabaseWorkspaceTab {
  readonly id: string;
  readonly title: string;
  readonly dirty?: boolean;
}

interface DatabaseWorkspaceShellProps {
  readonly testId: string;
  readonly toolbar: ReactNode;
  readonly toolbarTestId?: string;
  readonly navigator: ReactNode;
  readonly tabs: readonly DatabaseWorkspaceTab[];
  readonly activeTabId: string;
  readonly onActivateTab: (id: string) => void;
  readonly onCloseTab: (id: string) => void;
  readonly tabClassName: (tab: DatabaseWorkspaceTab, active: boolean) => string;
  readonly tabStripClassName?: string;
  readonly workspace: ReactNode;
  readonly status?: ReactNode;
  readonly children?: ReactNode;
}

/** UI-only workspace frame. Provider hosts retain all runtime data and callbacks. */
export function DatabaseWorkspaceShell({
  testId,
  toolbar,
  toolbarTestId,
  navigator,
  tabs,
  activeTabId,
  onActivateTab,
  onCloseTab,
  tabClassName,
  tabStripClassName = "flex h-8 shrink-0 items-end overflow-x-auto border-b bg-muted/15",
  workspace,
  status,
  children,
}: DatabaseWorkspaceShellProps) {
  return (
    <div className="h-full min-h-0 flex flex-col bg-background text-foreground" data-testid={testId}>
      <header className="flex h-10 shrink-0 items-center gap-1 border-b bg-muted/25 px-2" data-testid={toolbarTestId}>
        {toolbar}
      </header>
      <div className="flex min-h-0 flex-1">
        {navigator}
        <main className="flex min-w-0 flex-1 flex-col">
          <nav className={tabStripClassName}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onActivateTab(tab.id)}
                className={tabClassName(tab, tab.id === activeTabId)}
              >
                <FileCode2 className="h-3.5 w-3.5" />
                <span className="max-w-32 truncate">{tab.title}</span>
                {tab.dirty && <i className="h-1.5 w-1.5 rounded-full bg-primary" />}
                <X
                  className="ml-auto h-3 w-3"
                  data-testid={`database-workspace-close-${tab.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                  onCloseTab(tab.id);
                  }}
                />
              </button>
            ))}
          </nav>
          {workspace}
        </main>
      </div>
      {status}
      {children}
    </div>
  );
}
