import type { NetworkLink, NetworkNode } from '@/lib/network/topology-types';

export interface Vec2 { x: number; y: number }
export interface LayoutOptions { readonly force?: boolean }

const COLUMN_GAP = 340;
const ROW_GAP = 148;
const CARD_WIDTH = 190;
const CARD_HEIGHT = 76;
const COMPONENT_GAP = 220;

/** Deterministic, component-aware layout with room for cards and edge labels. */
export function computeAutoLayout(
  nodes: readonly NetworkNode[],
  links: readonly NetworkLink[],
  options: LayoutOptions = {},
): Map<string, Vec2> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const adjacency = new Map(nodes.map(node => [node.id, new Set<string>()]));
  for (const link of links) {
    if (link.sourceNodeId === link.targetNodeId) continue;
    adjacency.get(link.sourceNodeId)?.add(link.targetNodeId);
    adjacency.get(link.targetNodeId)?.add(link.sourceNodeId);
  }
  const degree = (id: string) => adjacency.get(id)?.size ?? 0;
  const byImportance = (a: string, b: string) => degree(b) - degree(a) || a.localeCompare(b);
  const unseen = new Set(byId.keys());
  const components: string[][] = [];
  while (unseen.size) {
    const start = [...unseen].sort(byImportance)[0];
    const queue = [start];
    unseen.delete(start);
    const component: string[] = [];
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i];
      component.push(id);
      for (const neighbor of [...(adjacency.get(id) ?? [])].sort(byImportance)) {
        if (unseen.delete(neighbor)) queue.push(neighbor);
      }
    }
    components.push(component);
  }
  components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));

  const positions = new Map<string, Vec2>();
  const estimatedArea = components.reduce((sum, component) => sum + component.length * COLUMN_GAP * ROW_GAP, 0);
  const shelfWidth = Math.max(1100, Math.sqrt(estimatedArea) * 1.5);
  let shelfX = 0;
  let shelfY = 0;
  let shelfHeight = 0;

  for (const component of components) {
    const root = [...component].sort(byImportance)[0];
    const levels = new Map<string, number>([[root, 0]]);
    const queue = [root];
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i];
      for (const neighbor of [...(adjacency.get(id) ?? [])].sort(byImportance)) {
        if (!levels.has(neighbor)) {
          levels.set(neighbor, (levels.get(id) ?? 0) + 1);
          queue.push(neighbor);
        }
      }
    }
    const columns: string[][] = [];
    for (const id of component) {
      const level = levels.get(id) ?? 0;
      (columns[level] ??= []).push(id);
    }
    const ranks = new Map<string, number>();
    columns.forEach((column, level) => {
      column.sort((a, b) => {
        const barycenter = (id: string) => {
          const parents = [...(adjacency.get(id) ?? [])].filter(other => levels.get(other) === level - 1);
          return parents.length ? parents.reduce((sum, other) => sum + (ranks.get(other) ?? 0), 0) / parents.length : 0;
        };
        return barycenter(a) - barycenter(b) || byImportance(a, b);
      });
      column.forEach((id, index) => ranks.set(id, index));
    });

    const star = columns.length === 2 && columns[1].every(id => degree(id) === 1);
    const rings: Array<{ id: string; radius: number; angle: number }> = [];
    if (star) {
      let remaining = [...columns[1]];
      for (let radius = 420; remaining.length; radius += 330) {
        const capacity = Math.max(1, Math.floor(2 * Math.PI * radius / (CARD_WIDTH + 85)));
        const ring = remaining.slice(0, capacity);
        remaining = remaining.slice(capacity);
        ring.forEach((id, index) => rings.push({
          id,
          radius,
          angle: -Math.PI / 2 + 2 * Math.PI * index / ring.length,
        }));
      }
    }
    const outerRadius = rings.at(-1)?.radius ?? 0;
    const width = star
      ? 2 * outerRadius + CARD_WIDTH
      : (columns.length - 1) * COLUMN_GAP + CARD_WIDTH;
    const height = star
      ? 2 * outerRadius + CARD_HEIGHT
      : Math.max(...columns.map(column => (column.length - 1) * ROW_GAP + CARD_HEIGHT));
    if (shelfX > 0 && shelfX + width > shelfWidth) {
      shelfX = 0;
      shelfY += shelfHeight + COMPONENT_GAP;
      shelfHeight = 0;
    }
    if (star) {
      const cx = shelfX + width / 2;
      const cy = shelfY + height / 2;
      positions.set(root, { x: cx, y: cy });
      for (const ring of rings) {
        positions.set(ring.id, {
          x: cx + ring.radius * Math.cos(ring.angle),
          y: cy + ring.radius * Math.sin(ring.angle),
        });
      }
    } else {
      columns.forEach((column, level) => column.forEach((id, index) => {
        positions.set(id, {
          x: shelfX + CARD_WIDTH / 2 + level * COLUMN_GAP,
          y: shelfY + height / 2 + (index - (column.length - 1) / 2) * ROW_GAP,
        });
      }));
    }
    shelfX += width + COMPONENT_GAP;
    shelfHeight = Math.max(shelfHeight, height);
  }

  if (!options.force) {
    for (const component of components) {
      const anchors = component.filter(id => byId.get(id)?.posX != null && byId.get(id)?.posY != null);
      if (anchors.length === 0) continue;
      const offset = anchors.reduce((sum, id) => {
        const node = byId.get(id)!;
        const point = positions.get(id)!;
        return { x: sum.x + node.posX! - point.x, y: sum.y + node.posY! - point.y };
      }, { x: 0, y: 0 });
      for (const id of component) {
        const point = positions.get(id)!;
        point.x += offset.x / anchors.length;
        point.y += offset.y / anchors.length;
      }
      for (const id of anchors) {
        const node = byId.get(id)!;
        positions.set(id, { x: node.posX!, y: node.posY! });
      }
    }
  }

  // Manual anchors may pull generated cards into each other. Separate free
  // cards while retaining the exact coordinates the user placed manually.
  const ids = [...positions.keys()].sort();
  const fixed = new Set(options.force ? [] : nodes.filter(node => node.posX != null && node.posY != null).map(node => node.id));
  for (let pass = 0; pass < 80; pass += 1) {
    let moved = false;
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
      const a = positions.get(ids[i])!;
      const b = positions.get(ids[j])!;
      const overlapX = CARD_WIDTH + 44 - Math.abs(a.x - b.x);
      const overlapY = CARD_HEIGHT + 44 - Math.abs(a.y - b.y);
      if (overlapX <= 0 || overlapY <= 0 || (fixed.has(ids[i]) && fixed.has(ids[j]))) continue;
      const horizontal = overlapX < overlapY;
      const delta = (horizontal ? overlapX : overlapY) / (fixed.has(ids[i]) || fixed.has(ids[j]) ? 1 : 2) + 1;
      const sign = horizontal ? (a.x <= b.x ? -1 : 1) : (a.y <= b.y ? -1 : 1);
      if (!fixed.has(ids[i])) { if (horizontal) a.x += sign * delta; else a.y += sign * delta; }
      if (!fixed.has(ids[j])) { if (horizontal) b.x -= sign * delta; else b.y -= sign * delta; }
      moved = true;
    }
    if (!moved) break;
  }
  return positions;
}
