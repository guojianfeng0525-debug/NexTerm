import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Loader2, PlugZap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { InlineEdit } from './inline-edit';
import { cn } from '@/lib/utils';
import type { NetworkPort, ReachabilityStatus } from '@/lib/network/topology-types';

/** Colour mapping follows design doc §5 — never reassign these casually. */
const REACHABILITY_CLASSES: Record<ReachabilityStatus, string> = {
  reachable: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  blocked: 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300',
  not_listening: 'border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-300',
  unreachable: 'border-transparent bg-muted text-muted-foreground',
  unexpected_open: 'border-transparent bg-purple-500/15 text-purple-700 dark:text-purple-300',
  dns_error: 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300',
  error: 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300',
  untested: 'border-transparent bg-muted text-muted-foreground',
};

const REACHABILITY_KEYS = {
  reachable: 'network.statusReachable',
  blocked: 'network.statusBlocked',
  not_listening: 'network.statusNotListening',
  unreachable: 'network.statusUnreachable',
  unexpected_open: 'network.statusUnexpectedOpen',
  dns_error: 'network.statusDnsError',
  error: 'network.statusError',
  untested: 'network.statusUntested',
} as const satisfies Record<ReachabilityStatus, string>;

export interface ReachabilityInfo {
  status: ReachabilityStatus;
  latencyMs: number | null;
}

export interface ReachabilityBadgeProps {
  status: ReachabilityStatus;
  latencyMs?: number | null;
  className?: string;
}

export function ReachabilityBadge({ status, latencyMs, className }: ReachabilityBadgeProps) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      className={cn('h-4 shrink-0 px-1 text-[9px]', REACHABILITY_CLASSES[status], className)}
      title={latencyMs !== null && latencyMs !== undefined ? t('network.ports.latency', { ms: latencyMs }) : undefined}
    >
      {t(REACHABILITY_KEYS[status])}
      {latencyMs !== null && latencyMs !== undefined && (
        <span className="ml-1 font-mono opacity-70">{latencyMs}ms</span>
      )}
    </Badge>
  );
}

export interface PortTableProps {
  ports: NetworkPort[];
  /** Latest known verdict for a port: live TCP result wins over the stored one. */
  reachabilityOf: (port: NetworkPort) => ReachabilityInfo | undefined;
  onPatch: (portId: string, patch: Partial<Pick<NetworkPort, 'serviceName' | 'purpose' | 'hidden'>>) => void;
  onTestConnectivity: () => void;
  testing: boolean;
  /** True when there is no usable host to connect to. */
  tcpDisabled: boolean;
}

export function PortTable({
  ports,
  reachabilityOf,
  onPatch,
  onTestConnectivity,
  testing,
  tcpDisabled,
}: PortTableProps) {
  const { t } = useTranslation();
  const [showHidden, setShowHidden] = useState(false);

  const { visible, hiddenCount } = useMemo(() => {
    const sorted = [...ports].sort((a, b) => {
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      if (a.protocol !== b.protocol) return a.protocol === 'tcp' ? -1 : 1;
      return a.port - b.port;
    });
    return {
      visible: sorted.filter(port => showHidden || !port.hidden),
      hiddenCount: sorted.filter(port => port.hidden).length,
    };
  }, [ports, showHidden]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 min-w-0 flex-1 gap-1 px-1.5 text-[10px]"
          onClick={onTestConnectivity}
          disabled={testing || tcpDisabled}
          title={tcpDisabled ? t('network.tcp.noHost') : t('network.ports.testButton')}
        >
          {testing ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : (
            <PlugZap className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">{t('network.ports.testButton')}</span>
        </Button>
        {hiddenCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            aria-label={showHidden ? t('network.ports.hideHidden') : t('network.ports.showHidden', { count: hiddenCount })}
            title={showHidden ? t('network.ports.hideHidden') : t('network.ports.showHidden', { count: hiddenCount })}
            onClick={() => setShowHidden(current => !current)}
          >
            {showHidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </Button>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="px-1 py-3 text-center text-[10px] text-muted-foreground">
          {t('network.ports.empty')}
        </p>
      ) : (
        <Table className="text-[10px]">
          <TableHeader>
            <TableRow className="border-b">
              <TableHead className="h-6 px-1 text-[9px]">{t('network.ports.port')}</TableHead>
              <TableHead className="h-6 px-1 text-[9px]">{t('network.ports.listenAddr')}</TableHead>
              <TableHead className="h-6 px-1 text-[9px]">{t('network.ports.process')}</TableHead>
              <TableHead className="h-6 w-[5rem] px-1 text-[9px]">{t('network.ports.serviceName')}</TableHead>
              <TableHead className="h-6 w-[6rem] px-1 text-[9px]">{t('network.ports.purpose')}</TableHead>
              <TableHead className="h-6 px-1 text-[9px]">{t('network.ports.reachability')}</TableHead>
              <TableHead className="h-6 w-6 px-1" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map(port => {
              const info = reachabilityOf(port);
              const stale = port.missingSince !== null;

              return (
                <TableRow key={port.id} className={cn('border-b', stale && 'opacity-50')}>
                  <TableCell className="p-1">
                    <div className="flex items-center gap-1">
                      <span className="font-mono">{port.port}</span>
                      <span className="text-[9px] uppercase text-muted-foreground">{port.protocol}</span>
                    </div>
                  </TableCell>
                  <TableCell className="p-1 font-mono">
                    <span className="block max-w-[7rem] truncate" title={port.listenAddr}>
                      {port.listenAddr || t('network.common.na')}
                    </span>
                  </TableCell>
                  <TableCell className="p-1">
                    <span
                      className="block max-w-[6rem] truncate"
                      title={[port.processName, port.pid !== null ? `PID ${port.pid}` : '', port.processUser]
                        .filter(Boolean)
                        .join(' · ')}
                    >
                      {port.processName || t('network.common.na')}
                      {port.pid !== null && (
                        <span className="ml-1 text-muted-foreground">#{port.pid}</span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="p-1">
                    <InlineEdit
                      value={port.serviceName}
                      placeholder={t('network.ports.servicePlaceholder')}
                      label={t('network.ports.serviceName')}
                      onCommit={next => onPatch(port.id, { serviceName: next })}
                    />
                  </TableCell>
                  <TableCell className="p-1">
                    <InlineEdit
                      value={port.purpose}
                      placeholder={t('network.ports.purposePlaceholder')}
                      label={t('network.ports.purpose')}
                      onCommit={next => onPatch(port.id, { purpose: next })}
                    />
                  </TableCell>
                  <TableCell className="p-1">
                    <ReachabilityBadge
                      status={info?.status ?? (port.reachability || 'untested')}
                      latencyMs={info?.latencyMs ?? null}
                    />
                  </TableCell>
                  <TableCell className="p-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4"
                      aria-label={port.hidden ? t('network.ports.unhide') : t('network.ports.hide')}
                      title={port.hidden ? t('network.ports.unhide') : t('network.ports.hide')}
                      onClick={() => onPatch(port.id, { hidden: !port.hidden })}
                    >
                      {port.hidden ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
