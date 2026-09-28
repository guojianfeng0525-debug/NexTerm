import { describe, expect, it } from 'vitest';
import { makeLink, makeNode } from '@/lib/network/__tests__/fixtures';
import { computeAutoLayout } from '../topology-layout';

describe('topology layout', () => {
  const nodes = Array.from({ length: 24 }, (_, index) => makeNode({
    id: 'node-' + index.toString().padStart(2, '0'),
    posX: null,
    posY: null,
  }));
  const links = nodes.slice(1).map((node, index) => makeLink({
    id: 'link-' + index,
    sourceNodeId: nodes[0].id,
    targetNodeId: node.id,
  }));

  it('keeps dense discovered neighborhoods apart and remains deterministic', () => {
    const layout = computeAutoLayout(nodes, links, { force: true });
    const reversed = computeAutoLayout([...nodes].reverse(), [...links].reverse(), { force: true });
    for (const node of nodes) expect(layout.get(node.id)).toEqual(reversed.get(node.id));
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = layout.get(nodes[i].id)!;
        const b = layout.get(nodes[j].id)!;
        expect(Math.abs(a.x - b.x) >= 190 + 40 || Math.abs(a.y - b.y) >= 76 + 40).toBe(true);
      }
    }
  });

  it('retains manually placed nodes while finding space for new discoveries', () => {
    const anchored = nodes.map((node, index) => index === 0
      ? { ...node, posX: 1000, posY: -250 }
      : node);
    const layout = computeAutoLayout(anchored, links);
    expect(layout.get(nodes[0].id)).toEqual({ x: 1000, y: -250 });
    expect(layout.size).toBe(nodes.length);
    expect(layout.get(nodes[1].id)).not.toEqual(layout.get(nodes[0].id));
  });
});
