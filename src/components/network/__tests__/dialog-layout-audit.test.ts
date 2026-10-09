import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const NETWORK_COMPONENT_DIR = join(process.cwd(), 'src/components/network');
const AUDITED_FILES = [
  ...readdirSync(NETWORK_COMPONENT_DIR, { recursive: true })
    .filter((file): file is string => typeof file === 'string' && file.endsWith('.tsx'))
    .map((file) => join(NETWORK_COMPONENT_DIR, file)),
  join(process.cwd(), 'src/components/toolbox/tool-topology.tsx'),
];

function dialogOpeningTags(source: string): string[] {
  return [...source.matchAll(/<(?:Dialog|AlertDialog)Content\b[\s\S]*?>/g)].map((match) => match[0]);
}

describe('network topology dialog layout audit', () => {
  it('keeps every Radix popup centered, viewport-bounded, and scrollable', () => {
    let audited = 0;
    for (const file of AUDITED_FILES) {
      const tags = dialogOpeningTags(readFileSync(file, 'utf8'));
      for (const tag of tags) {
        audited += 1;
        // Position and viewport bounds belong to the shared DialogViewport.
        // Per-page positioning used to conflict with the primitive's transform.
        expect(tag, file).not.toMatch(/(?:!inset-|top-\[|left-\[|translate-|h-fit|!max-w-none)/);
        expect(tag, file).toMatch(/max-w-/);
        if (tag.includes('flex-col')) {
          expect(tag, file).toMatch(/h-\[\d+px\]/);
          expect(tag, file).toContain('overflow-hidden');
        }
      }
    }

    // All user-visible popups currently in the topology module:
    // Node edit/delete, server-link edit/delete, port edit, port-link
    // edit/delete, global node/link delete confirmations, and batch-node
    // delete confirmation.
    expect(audited).toBe(10);
  });
});
