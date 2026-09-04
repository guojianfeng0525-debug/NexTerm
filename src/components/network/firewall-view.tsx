import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import type { FirewallType, NetworkFirewall, NetworkFirewallRule } from '@/lib/network/topology-types';

/** Rules can reach several hundred entries — render in pages to stay smooth. */
const PAGE_SIZE = 50;

const TYPE_KEYS = {
  firewalld: 'network.firewall.typeValue.firewalld',
  ufw: 'network.firewall.typeValue.ufw',
  iptables: 'network.firewall.typeValue.iptables',
  nftables: 'network.firewall.typeValue.nftables',
  pf: 'network.firewall.typeValue.pf',
  none: 'network.firewall.typeValue.none',
  unknown: 'network.firewall.typeValue.unknown',
} as const satisfies Record<FirewallType, string>;

export interface FirewallViewProps {
  firewall: NetworkFirewall | null;
  rules: NetworkFirewallRule[];
  onPatchPurpose: (ruleId: string, manualPurpose: string) => void;
}

export function FirewallView({ firewall, rules, onPatchPurpose }: FirewallViewProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const filtered = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return rules;
    return rules.filter(rule =>
      [rule.tableName, rule.chain, rule.action, rule.protocol, rule.src, rule.dst,
       rule.srcPort, rule.dstPort, rule.inIface, rule.outIface, rule.manualPurpose]
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    );
  }, [rules, filter]);

  const visible = filtered.slice(0, limit);

  if (!firewall) {
    return (
      <p className="px-1 py-3 text-center text-[10px] text-muted-foreground">
        {t('network.firewall.unavailable')}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {/* ── overview ───────────────────────────────────────────────────── */}
      <section className="space-y-1 rounded-lg border p-2">
        <div className="flex flex-wrap items-center gap-1">
          {firewall.active ? (
            <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <ShieldAlert className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <Badge variant="secondary" className="h-4 px-1 text-[9px]">
            {t(TYPE_KEYS[firewall.fwType] ?? TYPE_KEYS.unknown)}
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              'h-4 px-1 text-[9px]',
              firewall.active
                ? 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : 'border-transparent bg-muted text-muted-foreground',
            )}
          >
            {firewall.active ? t('network.firewall.active') : t('network.firewall.inactive')}
          </Badge>
        </div>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[10px]">
          <dt className="text-muted-foreground whitespace-nowrap">{t('network.firewall.defaultIn')}</dt>
          <dd className="truncate">{firewall.defaultInPolicy || t('network.common.na')}</dd>

          <dt className="text-muted-foreground whitespace-nowrap">{t('network.firewall.defaultOut')}</dt>
          <dd className="truncate">{firewall.defaultOutPolicy || t('network.common.na')}</dd>

          {firewall.version && (
            <>
              <dt className="text-muted-foreground whitespace-nowrap">{t('network.firewall.version')}</dt>
              <dd className="truncate font-mono">{firewall.version}</dd>
            </>
          )}

          {firewall.zones.length > 0 && (
            <>
              <dt className="text-muted-foreground whitespace-nowrap">{t('network.firewall.zones')}</dt>
              <dd className="flex flex-wrap gap-1">
                {firewall.zones.map(zone => (
                  <span key={zone} className="rounded bg-muted px-1 py-[1px] text-[9px]">
                    {zone}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>

        {firewall.detectNote && (
          <p className="rounded bg-amber-500/10 px-1.5 py-1 text-[9px] leading-relaxed text-amber-700 dark:text-amber-300">
            {t('network.firewall.detectNote')}: {firewall.detectNote}
          </p>
        )}
      </section>

      {/* ── rules ──────────────────────────────────────────────────────── */}
      <section className="space-y-1">
        <div className="flex items-center gap-1">
          <Input
            value={filter}
            onChange={event => {
              setFilter(event.target.value);
              setLimit(PAGE_SIZE); // restart paging whenever the filter changes
            }}
            placeholder={t('network.firewall.filterPlaceholder')}
            aria-label={t('network.firewall.filter')}
            className="h-6 px-1.5 text-[10px]"
          />
        </div>
        <div className="text-[9px] text-muted-foreground">
          {t('network.firewall.showing', { shown: visible.length, total: filtered.length })}
        </div>

        {filtered.length === 0 ? (
          <p className="px-1 py-3 text-center text-[10px] text-muted-foreground">
            {t('network.firewall.noRules')}
          </p>
        ) : (
          <>
            <Table className="text-[10px]">
              <TableHeader>
                <TableRow className="border-b">
                  <TableHead className="h-6 px-1 text-[9px]">{t('network.firewall.rule.table')}</TableHead>
                  <TableHead className="h-6 px-1 text-[9px]">{t('network.firewall.rule.chain')}</TableHead>
                  <TableHead className="h-6 px-1 text-[9px]">{t('network.firewall.rule.action')}</TableHead>
                  <TableHead className="h-6 px-1 text-[9px]">{t('network.firewall.rule.proto')}</TableHead>
                  <TableHead className="h-6 px-1 text-[9px]">{t('network.firewall.rule.src')}</TableHead>
                  <TableHead className="h-6 px-1 text-[9px]">{t('network.firewall.rule.dport')}</TableHead>
                  <TableHead className="h-6 w-[7rem] px-1 text-[9px]">{t('network.firewall.rule.purpose')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(rule => {
                  const stale = rule.missingSince !== null;
                  return (
                    <TableRow key={rule.id} className={cn('border-b', stale && 'opacity-50')}>
                      <TableCell className="p-1 font-mono">
                        <span className="block max-w-[4rem] truncate" title={rule.tableName}>
                          {rule.tableName || t('network.common.na')}
                        </span>
                      </TableCell>
                      <TableCell className="p-1 font-mono">
                        <span className="block max-w-[5rem] truncate" title={rule.chain}>
                          {rule.chain || t('network.common.na')}
                        </span>
                      </TableCell>
                      <TableCell className="p-1">
                        <span className="block max-w-[4rem] truncate" title={rule.action}>
                          {rule.action || t('network.common.na')}
                        </span>
                      </TableCell>
                      <TableCell className="p-1 font-mono">{rule.protocol || t('network.common.na')}</TableCell>
                      <TableCell className="p-1 font-mono">
                        <span className="block max-w-[6rem] truncate" title={rule.src}>
                          {rule.src || t('network.common.na')}
                        </span>
                      </TableCell>
                      <TableCell className="p-1 font-mono">
                        <span className="block max-w-[4rem] truncate" title={rule.dstPort}>
                          {rule.dstPort || t('network.common.na')}
                        </span>
                      </TableCell>
                      <TableCell className="p-1">
                        {stale ? (
                          <span className="text-[9px] text-muted-foreground">
                            {t('network.firewall.rule.missing')}
                          </span>
                        ) : (
                          <InlineEdit
                            value={rule.manualPurpose}
                            placeholder={t('network.firewall.rule.purposePlaceholder')}
                            label={t('network.firewall.rule.purpose')}
                            onCommit={next => onPatchPurpose(rule.id, next)}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {visible.length < filtered.length && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 w-full text-[10px]"
                onClick={() => setLimit(current => current + PAGE_SIZE)}
              >
                {t('network.firewall.showMore')}
              </Button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
