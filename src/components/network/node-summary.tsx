import { useTranslation } from 'react-i18next';
import { Server } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { InlineEdit } from './inline-edit';
import type { NetworkNode, NodeRoleHint } from '@/lib/network/topology-types';

const ROLE_KEYS = {
  web: 'network.roleHint.web',
  database: 'network.roleHint.database',
  cache: 'network.roleHint.cache',
  gateway: 'network.roleHint.gateway',
  messaging: 'network.roleHint.messaging',
  general: 'network.roleHint.general',
  unknown: 'network.roleHint.unknown',
} as const satisfies Record<NodeRoleHint, string>;

export interface NodeSummaryProps {
  node: NetworkNode;
  interfaceCount: number;
  portCount: number;
  /**
   * Applies a manual-field patch. Re-probes must never overwrite these, so the
   * parent routes this straight to `upsertNode`.
   */
  onPatch: (
    patch: Partial<Pick<NetworkNode, 'displayName' | 'nodeType' | 'environment' | 'notes'>>,
  ) => void;
}

export function NodeSummary({ node, interfaceCount, portCount, onPatch }: NodeSummaryProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      {/* ── auto-collected ─────────────────────────────────────────────── */}
      <section className="space-y-1 rounded-lg border p-2">
        <div className="flex items-center gap-1.5">
          <Server className="h-3 w-3 shrink-0" />
          <h3 className="text-xs font-medium truncate">{t('network.summary.autoTitle')}</h3>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10px]">
          <dt className="text-muted-foreground whitespace-nowrap">{t('network.summary.hostname')}</dt>
          <dd className="truncate font-mono" title={node.hostname}>
            {node.hostname || t('network.common.na')}
          </dd>

          <dt className="text-muted-foreground whitespace-nowrap">{t('network.summary.os')}</dt>
          <dd className="truncate" title={node.osName}>
            {node.osName || t('network.common.na')}
          </dd>

          <dt className="text-muted-foreground whitespace-nowrap">{t('network.summary.primaryIp')}</dt>
          <dd className="truncate font-mono" title={node.primaryIp}>
            {node.primaryIp || t('network.common.na')}
          </dd>

          <dt className="text-muted-foreground whitespace-nowrap">{t('network.summary.roleHint')}</dt>
          <dd>
            <Badge variant="secondary" className="h-4 px-1 text-[9px]">
              {t(ROLE_KEYS[node.roleHint] ?? ROLE_KEYS.unknown)}
            </Badge>
          </dd>

          <dt className="text-muted-foreground whitespace-nowrap">{t('network.summary.counts')}</dt>
          <dd className="truncate">
            {t('network.summary.countsValue', { interfaces: interfaceCount, ports: portCount })}
          </dd>
        </dl>
      </section>

      {/* ── manual fields (never overwritten by a probe) ───────────────── */}
      <section className="space-y-1.5 rounded-lg border p-2">
        <div className="flex items-center justify-between gap-1">
          <h3 className="text-xs font-medium truncate">{t('network.summary.manualTitle')}</h3>
          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
            {t('network.summary.manualBadge')}
          </Badge>
        </div>

        <div className="space-y-0.5">
          <div className="text-[10px] text-muted-foreground">{t('network.field.displayName')}</div>
          <InlineEdit
            value={node.displayName}
            placeholder={t('network.field.displayNamePlaceholder')}
            label={t('network.field.displayName')}
            onCommit={next => onPatch({ displayName: next })}
          />
        </div>

        <div className="space-y-0.5">
          <div className="text-[10px] text-muted-foreground">{t('network.field.nodeType')}</div>
          <InlineEdit
            value={node.nodeType}
            placeholder={t('network.field.nodeTypePlaceholder')}
            label={t('network.field.nodeType')}
            onCommit={next => onPatch({ nodeType: next })}
          />
        </div>

        <div className="space-y-0.5">
          <div className="text-[10px] text-muted-foreground">{t('network.field.environment')}</div>
          <InlineEdit
            value={node.environment}
            placeholder={t('network.field.environmentPlaceholder')}
            label={t('network.field.environment')}
            onCommit={next => onPatch({ environment: next })}
          />
        </div>

        <div className="space-y-0.5">
          <div className="text-[10px] text-muted-foreground">{t('network.field.notes')}</div>
          <Textarea
            // Remount whenever the persisted value changes so the uncontrolled
            // textarea always reflects storage without a sync effect.
            key={`${node.id}:${node.notes}`}
            defaultValue={node.notes}
            placeholder={t('network.field.notesPlaceholder')}
            rows={2}
            className="min-h-0 resize-none px-1.5 py-1 text-[10px]"
            onBlur={event => {
              const next = event.target.value;
              if (next !== node.notes) onPatch({ notes: next });
            }}
          />
        </div>
      </section>
    </div>
  );
}
