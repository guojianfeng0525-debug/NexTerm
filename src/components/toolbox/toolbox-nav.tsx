import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Globe,
  TerminalSquare,
  AppWindow,
  KeyRound,
  ArrowLeftRight,
  Server,
  StickyNote,
  History as HistoryIcon,
  Brackets,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolboxViewId } from '@/lib/toolbox/toolbox-types';

/** Workspace sections: connection workspace, terminal-only view, or a toolbox tool. */
export type WorkspaceSection = 'connection' | 'terminal' | 'api' | ToolboxViewId;

interface NavEntry {
  id: WorkspaceSection;
  icon: typeof Globe;
  labelKey:
    | 'menuBar.servers'
    | 'menuBar.terminal'
    | 'toolbox.apps.title'
    | 'toolbox.vault.title'
    | 'toolbox.tunnels.title'
    | 'toolbox.services.title'
    | 'toolbox.notes.title'
    | 'toolbox.history.title'
    | 'toolbox.apiDebug.title';
}

const NAV_ENTRIES: NavEntry[] = [
  { id: 'connection', icon: Globe, labelKey: 'menuBar.servers' },
  { id: 'terminal', icon: TerminalSquare, labelKey: 'menuBar.terminal' },
  { id: 'apps', icon: AppWindow, labelKey: 'toolbox.apps.title' },
  { id: 'vault', icon: KeyRound, labelKey: 'toolbox.vault.title' },
  { id: 'tunnels', icon: ArrowLeftRight, labelKey: 'toolbox.tunnels.title' },
  { id: 'services', icon: Server, labelKey: 'toolbox.services.title' },
  { id: 'notes', icon: StickyNote, labelKey: 'toolbox.notes.title' },
  { id: 'history', icon: HistoryIcon, labelKey: 'toolbox.history.title' },
  { id: 'api', icon: Brackets, labelKey: 'toolbox.apiDebug.title' },
];

interface ToolboxNavProps {
  section: WorkspaceSection;
  onSelect: (section: WorkspaceSection) => void;
}

/**
 * The page's directory bar — a persistent icon rail on the far left that
 * switches the main area between the connection workspace, a terminal-only
 * view, and the five toolbox tools.
 */
export function ToolboxNav({ section, onSelect }: ToolboxNavProps) {
  const { t } = useTranslation();

  return (
    <TooltipProvider delayDuration={200}>
      <nav
        className="w-11 shrink-0 border-r border-border bg-muted/30 flex flex-col items-center gap-1 py-2"
        aria-label={t('toolbox.nav.label')}
      >
        {NAV_ENTRIES.map(({ id, icon: Icon, labelKey }) => {
          const active = section === id;
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelect(id)}
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
                    active
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                  aria-label={t(labelKey)}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon className="h-[18px] w-[18px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                {t(labelKey)}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>
    </TooltipProvider>
  );
}
