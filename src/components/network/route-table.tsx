import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Route as RouteIcon } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { InlineEdit } from './inline-edit';
import { cn } from '@/lib/utils';
import type { NetworkRoute } from '@/lib/network/topology-types';

export interface RouteTableProps {
  routes: NetworkRoute[];
  onPatchNote: (routeId: string, manualNote: string) => void;
}

export function RouteTable({ routes, onPatchNote }: RouteTableProps) {
  const { t } = useTranslation();

  const sorted = useMemo(() => {
    return [...routes].sort((a, b) => {
      // Default routes first, then stale entries last.
      const rank = (item: NetworkRoute) =>
        (item.missingSince !== null ? 2 : 0) + (item.routeType === 'default' ? -1 : 0);
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return (a.metric ?? Number.MAX_SAFE_INTEGER) - (b.metric ?? Number.MAX_SAFE_INTEGER);
    });
  }, [routes]);

  if (sorted.length === 0) {
    return (
      <p className="px-1 py-3 text-center text-[10px] text-muted-foreground">
        {t('network.routes.empty')}
      </p>
    );
  }

  return (
    <Table className="text-[10px]">
      <TableHeader>
        <TableRow className="border-b">
          <TableHead className="h-6 px-1 text-[9px]">{t('network.routes.destination')}</TableHead>
          <TableHead className="h-6 px-1 text-[9px]">{t('network.routes.gateway')}</TableHead>
          <TableHead className="h-6 px-1 text-[9px]">{t('network.routes.genmask')}</TableHead>
          <TableHead className="h-6 px-1 text-[9px]">{t('network.routes.flags')}</TableHead>
          <TableHead className="h-6 px-1 text-[9px] text-right">{t('network.routes.metric')}</TableHead>
          <TableHead className="h-6 px-1 text-[9px]">{t('network.routes.iface')}</TableHead>
          <TableHead className="h-6 w-[7rem] px-1 text-[9px]">{t('network.routes.note')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map(route => {
          const isDefault = route.routeType === 'default';
          const stale = route.missingSince !== null;

          return (
            <TableRow
              key={route.id}
              className={cn(
                'border-b',
                isDefault && !stale && 'bg-accent/60',
                stale && 'opacity-50',
              )}
            >
              <TableCell className="p-1">
                <div className="flex items-center gap-1">
                  {isDefault && <RouteIcon className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />}
                  <span className="truncate font-mono" title={route.destination}>
                    {route.destination || t('network.common.na')}
                  </span>
                  {isDefault && (
                    <Badge variant="secondary" className="h-3.5 shrink-0 px-1 text-[8px]">
                      {t('network.routes.default')}
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="p-1 font-mono" title={route.gateway}>
                <span className="block max-w-[6rem] truncate">{route.gateway || t('network.common.na')}</span>
              </TableCell>
              <TableCell className="p-1 font-mono">
                <span className="block max-w-[6rem] truncate" title={route.genmask}>
                  {route.genmask || t('network.common.na')}
                </span>
              </TableCell>
              <TableCell className="p-1 font-mono">
                <span className="block max-w-[3.5rem] truncate" title={route.flags}>
                  {route.flags || t('network.common.na')}
                </span>
              </TableCell>
              <TableCell className="p-1 text-right font-mono">
                {route.metric ?? t('network.common.na')}
              </TableCell>
              <TableCell className="p-1 font-mono">
                <span className="block max-w-[4rem] truncate" title={route.iface}>
                  {route.iface || t('network.common.na')}
                </span>
              </TableCell>
              <TableCell className="p-1">
                {stale ? (
                  <span className="text-[9px] text-muted-foreground">
                    {t('network.routes.missing')}
                  </span>
                ) : (
                  <InlineEdit
                    value={route.manualNote}
                    placeholder={t('network.routes.notePlaceholder')}
                    label={t('network.routes.note')}
                    onCommit={next => onPatchNote(route.id, next)}
                  />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
