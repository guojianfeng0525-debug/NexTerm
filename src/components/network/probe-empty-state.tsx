import { useTranslation } from 'react-i18next';
import { Radar } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ProbeEmptyStateProps {
  className?: string;
}

/**
 * Shown when the current server has never been probed.
 *
 * The copy deliberately states that probing is a manual, single-server action
 * so the user is never surprised by background network activity.
 */
export function ProbeEmptyState({ className }: ProbeEmptyStateProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center',
        className,
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Radar className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-xs font-medium">{t('network.empty.title')}</p>
      <p className="max-w-[15rem] text-[10px] leading-relaxed text-muted-foreground">
        {t('network.empty.description')}
      </p>
      <p className="max-w-[15rem] text-[10px] leading-relaxed text-muted-foreground/70">
        {t('network.empty.hint')}
      </p>
    </div>
  );
}
