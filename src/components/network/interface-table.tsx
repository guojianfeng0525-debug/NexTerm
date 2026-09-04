import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Cable } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { InlineEdit } from './inline-edit';
import { cn } from '@/lib/utils';
import type { NetworkInterface } from '@/lib/network/topology-types';

const MAX_VISIBLE_ADDRS = 4;

function stateClasses(state: string): string {
  const normalized = state.trim().toUpperCase();
  if (normalized === 'UP') {
    return 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  }
  if (normalized === 'DOWN') {
    return 'border-transparent bg-muted text-muted-foreground';
  }
  return 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300';
}

export interface InterfaceTableProps {
  interfaces: NetworkInterface[];
  onPatchLabel: (ifaceId: string, manualLabel: string) => void;
}

/**
 * Interfaces are rendered as compact cards rather than a wide table: each row
 * carries a variable-length IPv4/IPv6 list which does not survive the narrow
 * (15–30 % width) sidebar without excessive horizontal scrolling.
 */
export function InterfaceTable({ interfaces, onPatchLabel }: InterfaceTableProps) {
  const { t } = useTranslation();

  const sorted = useMemo(() => {
    return [...interfaces].sort((a, b) => {
      // Missing (stale) entries sink to the bottom, loopback just above them.
      const rank = (item: NetworkInterface) =>
        (item.missingSince !== null ? 2 : 0) + (item.isLoopback ? 1 : 0);
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : a.ifaceName.localeCompare(b.ifaceName);
    });
  }, [interfaces]);

  if (sorted.length === 0) {
    return (
      <p className="px-1 py-3 text-center text-[10px] text-muted-foreground">
        {t('network.interfaces.empty')}
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {sorted.map(iface => {
        const stale = iface.missingSince !== null;
        const addrs = [...iface.ipv4Addrs, ...iface.ipv6Addrs];
        const hiddenCount = addrs.length - MAX_VISIBLE_ADDRS;

        return (
          <div
            key={iface.id}
            className={cn(
              'space-y-1 rounded-lg border p-1.5',
              stale && 'opacity-50',
              iface.isLoopback && !stale && 'opacity-80',
            )}
          >
            <div className="flex items-center gap-1">
              <Cable className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium" title={iface.ifaceName}>
                {iface.ifaceName}
              </span>
              <Badge variant="outline" className={cn('h-4 shrink-0 px-1 text-[9px]', stateClasses(iface.state))}>
                {iface.state || t('network.common.na')}
              </Badge>
              {iface.isLoopback && (
                <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
                  {t('network.interfaces.loopback')}
                </Badge>
              )}
              {stale && (
                <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
                  {t('network.interfaces.missing')}
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-muted-foreground">
              <span className="whitespace-nowrap">
                {t('network.interfaces.mtu')}: {iface.mtu ?? t('network.common.na')}
              </span>
              {iface.mac && (
                <span className="truncate font-mono" title={iface.mac}>
                  MAC {iface.mac}
                </span>
              )}
            </div>

            {addrs.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {addrs.slice(0, MAX_VISIBLE_ADDRS).map(addr => (
                  <span
                    key={addr}
                    className="max-w-full truncate rounded bg-muted px-1 py-[1px] font-mono text-[9px]"
                    title={addr}
                  >
                    {addr}
                  </span>
                ))}
                {hiddenCount > 0 && (
                  <span className="rounded bg-muted px-1 py-[1px] text-[9px] text-muted-foreground">
                    +{hiddenCount}
                  </span>
                )}
              </div>
            )}

            <div className="flex items-center gap-1">
              <span className="shrink-0 text-[9px] text-muted-foreground">
                {t('network.interfaces.label')}
              </span>
              <InlineEdit
                className="min-w-0 flex-1"
                value={iface.manualLabel}
                placeholder={t('network.interfaces.labelPlaceholder')}
                label={t('network.interfaces.label')}
                onCommit={next => onPatchLabel(iface.id, next)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
