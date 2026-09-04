/**
 * Hand-rolled SVG topology canvas — zero third-party graph dependencies.
 *
 * Rendering, hit-testing, panning, zooming, dragging and the automatic layout
 * are all implemented here with plain SVG + React state. The node count is
 * expected to stay below ~50, so the graph is rendered in full every time;
 * `TopologyNodeCard` is memoised to keep drags smooth.
 *
 * ── Interaction contract (Windows-first) ──────────────────────────────────
 * Every gesture below works with a mouse, a touchpad and a touch screen and
 * none of them requires multi-touch:
 *   · pan    — drag any empty area, or scroll the wheel
 *   · zoom   — Ctrl + wheel (also pinch on a trackpad), or the +/- buttons
 *   · move   — drag a node card (pointer events, not HTML5 drag & drop)
 *   · select — single click, or Tab + Enter for keyboard users
 *   · edit   — double click, Enter on a focused node, or the context menu
 */

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { EyeOff, Pencil, Trash2 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import type {
  LinkType,
  NetworkLink,
  NetworkNode,
  ProbeStatus,
} from '@/lib/network/topology-types';

/* ══ geometry & tuning ════════════════════════════════════════════════════ */

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 76;

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
const ZOOM_BUTTON_STEP = 1.25;

/** Force-directed layout tuning (see `computeAutoLayout`). */
const LAYOUT_IDEAL_DISTANCE = 300;
const LAYOUT_ITERATIONS = 120;
const LAYOUT_INITIAL_TEMPERATURE = 170;
const LAYOUT_COOLING = 0.955;
const LAYOUT_GRAVITY = 0.1;

/** Below this zoom level edge labels are hidden to avoid visual clutter. */
const LABEL_VISIBLE_ZOOM = 0.6;

/** Pointer travel (px) below which a press counts as a click, not a drag. */
const CLICK_SLOP = 4;

export interface Vec2 {
  x: number;
  y: number;
}

const LINK_COLORS: Record<LinkType, string> = {
  ssh: 'var(--chart-1)',
  http: 'var(--chart-2)',
  database: 'var(--chart-3)',
  cache: 'var(--chart-5)',
  messaging: 'var(--chart-4)',
  custom: 'var(--muted-foreground)',
  unknown: 'var(--muted-foreground)',
};

const PROBE_COLORS: Record<ProbeStatus, string> = {
  ok: 'var(--success)',
  partial: 'var(--warning)',
  failed: 'var(--destructive)',
  never: 'var(--muted-foreground)',
};

const CJK = /[ᄀ-ᇿ⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/** Rough advance width of a glyph — good enough for SVG text truncation. */
function glyphWidth(char: string, fontSize: number): number {
  return CJK.test(char) ? fontSize : fontSize * 0.56;
}

function textWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += glyphWidth(char, fontSize);
  return width;
}

function truncate(text: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0) return '';
  if (textWidth(text, fontSize) <= maxWidth) return text;
  const ellipsisWidth = glyphWidth('…', fontSize) + fontSize * 0.4;
  let out = '';
  let width = 0;
  for (const char of text) {
    const next = glyphWidth(char, fontSize);
    if (width + next > maxWidth - ellipsisWidth) break;
    out += char;
    width += next;
  }
  return `${out}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ══ automatic layout ═════════════════════════════════════════════════════ */

export interface LayoutOptions {
  /** Re-place every node, ignoring the manual coordinates already persisted. */
  readonly force?: boolean;
}

/**
 * Fruchterman–Reingold style layout.
 *
 * Nodes carrying manual coordinates act as fixed anchors (unless `force` is
 * set); the remaining nodes are seeded on a golden-angle spiral around the
 * anchors' centroid and then relaxed with repulsion + spring attraction +
 * a weak pull towards the centroid. The result is deterministic — no random
 * jitter — so re-running with the same input yields the same picture.
 */
export function computeAutoLayout(
  nodes: readonly NetworkNode[],
  links: readonly NetworkLink[],
  options: LayoutOptions = {},
): Map<string, Vec2> {
  const positions = new Map<string, Vec2>();
  const anchored = new Set<string>();

  if (!options.force) {
    for (const node of nodes) {
      if (node.posX !== null && node.posY !== null) {
        positions.set(node.id, { x: node.posX, y: node.posY });
        anchored.add(node.id);
      }
    }
  }

  const ids = nodes.map((node) => node.id);
  const free = nodes.filter((node) => !anchored.has(node.id));

  let cx = 0;
  let cy = 0;
  if (anchored.size > 0) {
    for (const id of anchored) {
      const point = positions.get(id);
      if (point) {
        cx += point.x;
        cy += point.y;
      }
    }
    cx /= anchored.size;
    cy /= anchored.size;
  }

  // Golden-angle spiral: deterministic and never places two nodes on top of
  // each other, whatever the node count.
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((node, index) => {
    if (anchored.has(node.id)) return;
    const angle = index * GOLDEN_ANGLE;
    const radius = 200 + 90 * Math.sqrt(index + 1);
    positions.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  });

  const edges: Array<readonly [string, string]> = [];
  for (const link of links) {
    if (link.sourceNodeId === link.targetNodeId) continue;
    if (positions.has(link.sourceNodeId) && positions.has(link.targetNodeId)) {
      edges.push([link.sourceNodeId, link.targetNodeId]);
    }
  }

  const total = ids.length;
  // Nothing to relax: a single node, every node anchored, or no edges at all.
  // The spiral seeding already spaces such graphs out reasonably.
  if (total < 2 || free.length === 0 || edges.length === 0) return positions;

  const disp = new Map<string, Vec2>();
  let temperature = LAYOUT_INITIAL_TEMPERATURE;

  for (let iteration = 0; iteration < LAYOUT_ITERATIONS; iteration += 1) {
    for (const id of ids) disp.set(id, { x: 0, y: 0 });

    let gx = 0;
    let gy = 0;
    for (const id of ids) {
      const point = positions.get(id);
      if (point) {
        gx += point.x;
        gy += point.y;
      }
    }
    gx /= total;
    gy /= total;

    // Repulsion between every pair.
    for (let i = 0; i < total; i += 1) {
      const a = positions.get(ids[i]);
      if (!a) continue;
      for (let j = i + 1; j < total; j += 1) {
        const b = positions.get(ids[j]);
        if (!b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const force = (LAYOUT_IDEAL_DISTANCE * LAYOUT_IDEAL_DISTANCE) / distance;
        const ux = (dx / distance) * force;
        const uy = (dy / distance) * force;
        const da = disp.get(ids[i]);
        const db = disp.get(ids[j]);
        if (da) {
          da.x += ux;
          da.y += uy;
        }
        if (db) {
          db.x -= ux;
          db.y -= uy;
        }
      }
    }

    // Spring attraction along edges.
    for (const [a, b] of edges) {
      const pa = positions.get(a);
      const pb = positions.get(b);
      if (!pa || !pb) continue;
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const force = (distance * distance) / LAYOUT_IDEAL_DISTANCE;
      const ux = (dx / distance) * force;
      const uy = (dy / distance) * force;
      const da = disp.get(a);
      const db = disp.get(b);
      if (da) {
        da.x -= ux;
        da.y -= uy;
      }
      if (db) {
        db.x += ux;
        db.y += uy;
      }
    }

    // Weak gravity keeps disconnected components from drifting away.
    for (const node of free) {
      const point = positions.get(node.id);
      const d = disp.get(node.id);
      if (!point || !d) continue;
      d.x += (gx - point.x) * LAYOUT_GRAVITY;
      d.y += (gy - point.y) * LAYOUT_GRAVITY;
    }

    // Apply, clamped by the current temperature; anchored nodes never move.
    for (const node of free) {
      const point = positions.get(node.id);
      const d = disp.get(node.id);
      if (!point || !d) continue;
      const length = Math.hypot(d.x, d.y);
      if (length > 0) {
        const step = Math.min(length, temperature);
        point.x += (d.x / length) * step;
        point.y += (d.y / length) * step;
      }
    }

    temperature = Math.max(temperature * LAYOUT_COOLING, 1);
  }

  return positions;
}

/** Human-facing node name: display name → hostname → primary IP. */
export function nodeLabel(node: NetworkNode): string {
  return node.displayName.trim() || node.hostname.trim() || node.primaryIp || node.id;
}

/* ══ edge geometry ════════════════════════════════════════════════════════ */

/** Point where the segment `center → toward` leaves the node's card. */
function rectAnchor(center: Vec2, toward: Vec2, halfWidth: number, halfHeight: number): Vec2 {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const scale = Math.min(
    halfWidth / Math.max(Math.abs(dx), 1e-6),
    halfHeight / Math.max(Math.abs(dy), 1e-6),
  );
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

interface EdgeGeometry {
  readonly d: string;
  readonly label: Vec2;
}

function edgeGeometry(from: Vec2, to: Vec2, curvature: number): EdgeGeometry {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const control: Vec2 = {
    x: (from.x + to.x) / 2 + (-dy / length) * curvature,
    y: (from.y + to.y) / 2 + (dx / length) * curvature,
  };
  const halfWidth = NODE_WIDTH / 2 + 6;
  const halfHeight = NODE_HEIGHT / 2 + 6;
  const start = rectAnchor(from, control, halfWidth, halfHeight);
  const end = rectAnchor(to, control, halfWidth, halfHeight);
  return {
    d: `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
    label: control,
  };
}

/** Self-referencing links are drawn as a small loop above the card. */
function selfLoopGeometry(at: Vec2): EdgeGeometry {
  const top = at.y - NODE_HEIGHT / 2 - 6;
  return {
    d: `M ${at.x - 34} ${top} C ${at.x - 96} ${top - 78} ${at.x + 96} ${top - 78} ${at.x + 34} ${top}`,
    label: { x: at.x, y: top - 58 },
  };
}

/* ══ node card ════════════════════════════════════════════════════════════ */

interface NodeCardProps {
  readonly title: string;
  readonly subtitle: string;
  readonly footer: string;
  readonly envLabel: string;
  readonly statusColor: string;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly dimmed: boolean;
  readonly neverProbed: boolean;
}

const TopologyNodeCard = React.memo(function TopologyNodeCard({
  title,
  subtitle,
  footer,
  envLabel,
  statusColor,
  selected,
  focused,
  dimmed,
  neverProbed,
}: NodeCardProps) {
  const halfW = NODE_WIDTH / 2;
  const halfH = NODE_HEIGHT / 2;
  const envWidth = envLabel ? textWidth(envLabel, 10) + 14 : 0;
  // The environment badge shares the bottom row, so the footer yields space.
  const footerMax = NODE_WIDTH - 30 - (envWidth > 0 ? envWidth + 8 : 0);
  const titleMax = NODE_WIDTH - 28 - 12;

  return (
    <g opacity={dimmed ? 0.42 : neverProbed ? 0.62 : 1}>
      {selected && (
        <rect
          x={-halfW - 5}
          y={-halfH - 5}
          width={NODE_WIDTH + 10}
          height={NODE_HEIGHT + 10}
          rx={14}
          className="fill-none stroke-primary/45"
          strokeWidth={2}
        />
      )}
      <rect
        x={-halfW}
        y={-halfH}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={11}
        className={cn('fill-card stroke-border', selected && 'stroke-primary')}
        strokeWidth={selected ? 2.25 : 1.25}
        strokeDasharray={neverProbed ? '5 4' : undefined}
      />
      {focused && (
        <rect
          x={-halfW - 9}
          y={-halfH - 9}
          width={NODE_WIDTH + 18}
          height={NODE_HEIGHT + 18}
          rx={17}
          className="fill-none stroke-ring"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
      )}

      <circle cx={-halfW + 15} cy={-halfH + 16} r={4.5} fill={statusColor} />
      <text
        x={-halfW + 28}
        y={-halfH + 20}
        className="fill-foreground text-[13px] font-medium"
      >
        {truncate(title, titleMax, 13)}
      </text>

      <text
        x={-halfW + 15}
        y={-halfH + 41}
        className="fill-muted-foreground font-mono text-[11px]"
      >
        {truncate(subtitle, NODE_WIDTH - 30, 11)}
      </text>

      <text
        x={-halfW + 15}
        y={-halfH + 61}
        className="fill-muted-foreground text-[10px]"
      >
        {truncate(footer, footerMax, 10)}
      </text>
      {envWidth > 0 && (
        <>
          <rect
            x={halfW - 11 - envWidth}
            y={-halfH + 50}
            width={envWidth}
            height={17}
            rx={5}
            className="fill-muted stroke-border"
            strokeWidth={0.75}
          />
          <text
            x={halfW - 11 - envWidth / 2}
            y={-halfH + 62}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px]"
          >
            {truncate(envLabel, envWidth - 6, 10)}
          </text>
        </>
      )}
    </g>
  );
});

/* ══ imperative view controls ═════════════════════════════════════════════ */

export interface TopologyGraphHandle {
  zoomIn(): void;
  zoomOut(): void;
  fitToView(): void;
}

interface ViewState {
  x: number;
  y: number;
  k: number;
}

type DragState =
  | {
      readonly kind: 'pan';
      readonly pointerId: number;
      readonly startClientX: number;
      readonly startClientY: number;
      readonly originX: number;
      readonly originY: number;
      moved: boolean;
    }
  | {
      readonly kind: 'node';
      readonly pointerId: number;
      readonly id: string;
      readonly startClientX: number;
      readonly startClientY: number;
      readonly originX: number;
      readonly originY: number;
      moved: boolean;
    };

interface HoverLink {
  readonly link: NetworkLink;
  readonly x: number;
  readonly y: number;
}

export interface TopologyGraphProps {
  /** Nodes to draw. The parent is responsible for search / hidden filtering. */
  readonly nodes: NetworkNode[];
  /** Links to draw. Endpoints missing from `nodes` are skipped. */
  readonly links: NetworkLink[];
  readonly selectedNodeId: string | null;
  readonly selectedLinkId: string | null;
  /** Bump to invalidate the memoised automatic layout. */
  readonly layoutSeed: number;
  readonly onSelectNode: (id: string | null) => void;
  readonly onSelectLink: (id: string | null) => void;
  readonly onEditNode: (id: string) => void;
  readonly onEditLink: (id: string) => void;
  readonly onHideNode: (id: string) => void;
  readonly onRequestDeleteNode: (id: string) => void;
  readonly onMoveNode: (id: string, x: number, y: number) => void;
  readonly ref?: React.Ref<TopologyGraphHandle>;
}

export function TopologyGraph({
  ref,
  nodes,
  links,
  selectedNodeId,
  selectedLinkId,
  layoutSeed,
  onSelectNode,
  onSelectLink,
  onEditNode,
  onEditLink,
  onHideNode,
  onRequestDeleteNode,
  onMoveNode,
}: TopologyGraphProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const didInitialFitRef = useRef(false);

  const [view, setView] = useState<ViewState>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ width: 960, height: 640 });
  const [dragNode, setDragNode] = useState<{ id: string; x: number; y: number } | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hoverLink, setHoverLink] = useState<HoverLink | null>(null);

  /* ── layout ───────────────────────────────────────────────────────────── */

  const nodeSignature = useMemo(
    () => nodes.map((node) => `${node.id}:${node.posX ?? ''},${node.posY ?? ''}`).join('|'),
    [nodes],
  );
  const linkSignature = useMemo(
    () => links.map((link) => `${link.sourceNodeId}>${link.targetNodeId}`).sort().join('|'),
    [links],
  );

  // `nodeSignature` / `linkSignature` are the real inputs; `nodes` and `links`
  // are read through refs-free closure capture inside the memo, which is safe
  // because a changed signature always accompanies a changed array.
  const positions = useMemo(
    () => computeAutoLayout(nodes, links),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeSignature, linkSignature, layoutSeed],
  );

  const positionOf = useCallback(
    (node: NetworkNode): Vec2 => {
      if (dragNode && dragNode.id === node.id) return { x: dragNode.x, y: dragNode.y };
      return positions.get(node.id) ?? { x: 0, y: 0 };
    },
    [dragNode, positions],
  );

  const nodeById = useMemo(() => {
    const map = new Map<string, NetworkNode>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);

  const labelOf = useCallback(
    (id: string): string => {
      const node = nodeById.get(id);
      return node ? nodeLabel(node) : '—';
    },
    [nodeById],
  );

  /* ── viewport ─────────────────────────────────────────────────────────── */

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const applyZoom = useCallback((factor: number, anchor?: Vec2) => {
    const element = containerRef.current;
    const px = anchor?.x ?? (element ? element.clientWidth / 2 : 480);
    const py = anchor?.y ?? (element ? element.clientHeight / 2 : 320);
    setView((current) => {
      const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
      if (k === current.k) return current;
      return {
        k,
        x: px - (px - current.x) * (k / current.k),
        y: py - (py - current.y) * (k / current.k),
      };
    });
  }, []);

  const fitToView = useCallback(() => {
    if (nodes.length === 0 || size.width === 0) {
      setView({ x: 0, y: 0, k: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      const point = positions.get(node.id);
      if (!point) continue;
      minX = Math.min(minX, point.x - NODE_WIDTH / 2);
      minY = Math.min(minY, point.y - NODE_HEIGHT / 2);
      maxX = Math.max(maxX, point.x + NODE_WIDTH / 2);
      maxY = Math.max(maxY, point.y + NODE_HEIGHT / 2);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      setView({ x: 0, y: 0, k: 1 });
      return;
    }
    const padding = 72;
    const k = clamp(
      Math.min(size.width / (maxX - minX + padding), size.height / (maxY - minY + padding)),
      MIN_ZOOM,
      1.15,
    );
    setView({
      k,
      x: size.width / 2 - ((minX + maxX) / 2) * k,
      y: size.height / 2 - ((minY + maxY) / 2) * k,
    });
  }, [nodes, positions, size.height, size.width]);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => applyZoom(ZOOM_BUTTON_STEP),
      zoomOut: () => applyZoom(1 / ZOOM_BUTTON_STEP),
      fitToView,
    }),
    [applyZoom, fitToView],
  );

  // Fit once, as soon as the first nodes have a measurable container.
  useEffect(() => {
    if (didInitialFitRef.current || nodes.length === 0 || size.width === 0) return;
    didInitialFitRef.current = true;
    fitToView();
  }, [nodes.length, size.width, fitToView]);

  // Native listener: React attaches wheel handlers passively, so the page
  // would scroll behind the canvas without `preventDefault` here.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        applyZoom(Math.exp(-event.deltaY * 0.0025), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      } else {
        setView((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
      }
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [applyZoom]);

  /* ── pointer interaction ──────────────────────────────────────────────── */

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      const nodeElement = target?.closest?.('[data-node-id]') ?? null;
      svgRef.current?.setPointerCapture(event.pointerId);
      if (nodeElement) {
        const id = nodeElement.getAttribute('data-node-id');
        if (!id) return;
        const origin = positions.get(id) ?? { x: 0, y: 0 };
        dragRef.current = {
          kind: 'node',
          pointerId: event.pointerId,
          id,
          startClientX: event.clientX,
          startClientY: event.clientY,
          originX: origin.x,
          originY: origin.y,
          moved: false,
        };
        setDragNode({ id, x: origin.x, y: origin.y });
        return;
      }
      dragRef.current = {
        kind: 'pan',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originX: view.x,
        originY: view.y,
        moved: false,
      };
    },
    [positions, view.x, view.y],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startClientX;
      const dy = event.clientY - drag.startClientY;
      if (!drag.moved && Math.hypot(dx, dy) > CLICK_SLOP) drag.moved = true;
      if (!drag.moved) return;
      if (drag.kind === 'pan') {
        setView((current) => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }));
      } else {
        setDragNode({
          id: drag.id,
          x: drag.originX + dx / view.k,
          y: drag.originY + dy / view.k,
        });
      }
    },
    [view.k],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (svgRef.current?.hasPointerCapture(event.pointerId)) {
        svgRef.current.releasePointerCapture(event.pointerId);
      }
      if (!drag.moved) {
        // A press without travel counts as a click on the canvas background.
        if (drag.kind === 'node') {
          onSelectNode(drag.id);
          onSelectLink(null);
        } else {
          onSelectNode(null);
          onSelectLink(null);
        }
      } else if (drag.kind === 'node' && dragNode) {
        onMoveNode(drag.id, Math.round(dragNode.x), Math.round(dragNode.y));
      }
      setDragNode(null);
    },
    [dragNode, onMoveNode, onSelectLink, onSelectNode],
  );

  /* ── derived render data ──────────────────────────────────────────────── */

  const renderedLinks = useMemo(() => {
    const hasReverse = new Set<string>();
    for (const link of links) hasReverse.add(`${link.targetNodeId}>${link.sourceNodeId}`);
    return links.flatMap((link) => {
      const from = nodeById.get(link.sourceNodeId);
      const to = nodeById.get(link.targetNodeId);
      if (!from) return [];
      const selfLoop = link.sourceNodeId === link.targetNodeId;
      if (!to && !selfLoop) return [];
      const a = positionOf(from);
      const reverse = hasReverse.has(`${link.sourceNodeId}>${link.targetNodeId}`);
      const geometry = selfLoop || !to
        ? selfLoopGeometry(a)
        : edgeGeometry(a, positionOf(to), reverse ? 26 : 12);
      return [{ link, geometry }];
    });
  }, [links, nodeById, positionOf]);

  const showLabels = view.k >= LABEL_VISIBLE_ZOOM;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-background">
      <svg
        ref={svgRef}
        className={cn(
          'h-full w-full touch-none select-none outline-none',
          dragNode ? 'cursor-grabbing' : 'cursor-grab',
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(event) => event.preventDefault()}
      >
        <defs>
          <pattern
            id="topology-grid"
            width={28}
            height={28}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${view.x} ${view.y}) scale(${view.k})`}
          >
            <circle cx={1.5} cy={1.5} r={1.1} className="fill-border" />
          </pattern>
          {(Object.keys(LINK_COLORS) as LinkType[]).map((type) => (
            <marker
              key={type}
              id={`topology-arrow-${type}`}
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={7}
              markerHeight={7}
              orient="auto"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill={LINK_COLORS[type]} />
            </marker>
          ))}
        </defs>

        <rect width="100%" height="100%" className="fill-background" />
        <rect width="100%" height="100%" fill="url(#topology-grid)" opacity={0.55} />

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {/* Edges first so cards paint on top of them. */}
          <g>
            {renderedLinks.map(({ link, geometry }) => {
              const selected = selectedLinkId === link.id;
              const color = LINK_COLORS[link.linkType] ?? LINK_COLORS.unknown;
              const dashed = link.source === 'auto';
              return (
                <g
                  key={link.id}
                  data-link-id={link.id}
                  opacity={link.hidden ? 0.32 : 1}
                  className="cursor-pointer"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectLink(link.id);
                    onSelectNode(null);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    onEditLink(link.id);
                  }}
                  onPointerEnter={(event) => {
                    const rect = containerRef.current?.getBoundingClientRect();
                    setHoverLink({
                      link,
                      x: rect ? event.clientX - rect.left : 0,
                      y: rect ? event.clientY - rect.top : 0,
                    });
                  }}
                  onPointerLeave={() =>
                    setHoverLink((current) => (current?.link.id === link.id ? null : current))
                  }
                >
                  {/* Invisible fat stroke: comfortable hit area for thin lines. */}
                  <path d={geometry.d} fill="none" stroke="transparent" strokeWidth={16} />
                  <path
                    d={geometry.d}
                    fill="none"
                    stroke={color}
                    strokeWidth={selected ? 2.75 : 1.6}
                    strokeDasharray={dashed ? '7 5' : undefined}
                    markerEnd={`url(#topology-arrow-${link.linkType})`}
                  />
                  {showLabels && (
                    <g transform={`translate(${geometry.label.x} ${geometry.label.y})`}>
                      <rect
                        x={-30}
                        y={-9}
                        width={60}
                        height={18}
                        rx={5}
                        className="fill-background/90 stroke-border"
                        strokeWidth={0.75}
                      />
                      <text
                        textAnchor="middle"
                        y={4}
                        className="fill-muted-foreground font-mono text-[10px]"
                      >
                        {truncate(
                          `${link.protocol.toUpperCase()} ${link.port ?? ''}`.trim(),
                          54,
                          10,
                        )}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>

          {/* Node cards. */}
          <g>
            {nodes.map((node) => {
              const point = positionOf(node);
              const title = nodeLabel(node);
              const roleLabel = t(`topology.role.${node.roleHint}`, {
                defaultValue: node.roleHint,
              });
              const typeLabel = t(`topology.nodeType.${node.nodeType}`, {
                defaultValue: node.nodeType,
              });
              const envLabel = t(`topology.environment.${node.environment}`, {
                defaultValue: node.environment,
              });
              return (
                <ContextMenu key={node.id}>
                  <ContextMenuTrigger asChild>
                    <g
                      data-node-id={node.id}
                      transform={`translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`}
                      tabIndex={0}
                      role="button"
                      aria-label={title}
                      focusable="true"
                      className="cursor-grab outline-none"
                      onFocus={() => setFocusedId(node.id)}
                      onBlur={() =>
                        setFocusedId((current) => (current === node.id ? null : current))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onEditNode(node.id);
                        }
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        onEditNode(node.id);
                      }}
                    >
                      <TopologyNodeCard
                        title={title}
                        subtitle={node.primaryIp || '—'}
                        footer={[typeLabel, roleLabel].filter(Boolean).join(' · ')}
                        envLabel={envLabel}
                        statusColor={PROBE_COLORS[node.lastProbeStatus] ?? PROBE_COLORS.never}
                        selected={selectedNodeId === node.id}
                        focused={focusedId === node.id}
                        dimmed={node.hidden}
                        neverProbed={node.lastProbeStatus === 'never'}
                      />
                    </g>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => onEditNode(node.id)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      {t('topology.editNode')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onHideNode(node.id)}>
                      <EyeOff className="mr-2 h-3.5 w-3.5" />
                      {node.hidden ? t('topology.unhideNode') : t('topology.hideNode')}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => onRequestDeleteNode(node.id)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      {t('topology.deleteNode')}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </g>
        </g>
      </svg>

      {hoverLink && (
        <div
          className="pointer-events-none absolute z-20 max-w-[320px] rounded-lg border border-border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur-sm"
          style={{
            left: Math.min(hoverLink.x + 16, Math.max(size.width - 336, 8)),
            top: Math.min(hoverLink.y + 16, Math.max(size.height - 168, 8)),
          }}
        >
          <p className="text-xs font-medium text-foreground">
            {t(`topology.linkType.${hoverLink.link.linkType}`, {
              defaultValue: hoverLink.link.linkType,
            })}
            <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
              {hoverLink.link.protocol.toUpperCase()}
              {hoverLink.link.port !== null ? ` ${hoverLink.link.port}` : ''}
            </span>
          </p>
          {hoverLink.link.manualLabel && (
            <p className="mt-0.5 text-[11px] text-foreground">{hoverLink.link.manualLabel}</p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {labelOf(hoverLink.link.sourceNodeId)}
            {' → '}
            {labelOf(hoverLink.link.targetNodeId)}
          </p>
          {hoverLink.link.description && (
            <p className="mt-1 text-[11px] text-foreground">{hoverLink.link.description}</p>
          )}
          {hoverLink.link.evidence && (
            <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
              {hoverLink.link.evidence}
            </p>
          )}
          <p className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: LINK_COLORS[hoverLink.link.linkType] ?? LINK_COLORS.unknown }}
            />
            {t(`topology.source.${hoverLink.link.source}`, {
              defaultValue: hoverLink.link.source,
            })}
            {' · '}
            {t(`topology.linkStatus.${hoverLink.link.status}`, {
              defaultValue: hoverLink.link.status,
            })}
          </p>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm">
        {t('topology.canvasHint')}
      </div>
    </div>
  );
}
