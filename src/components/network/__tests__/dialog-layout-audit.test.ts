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
        expect(tag, file).toContain('!inset-0');
        expect(tag, file).toContain('!m-auto');
        expect(tag, file).toMatch(/!(?:h-fit|h-\[\d+px\])/);
        // `h-fit` on a flex parent makes `flex-1` form bodies collapse to zero,
        // so every tall form dialog must use an explicit capped content height.
        if (tag.includes('flex-col gap-0 p-0')) {
          expect(tag, file).toMatch(/!h-\[\d+px\]/);
        }
        expect(tag, file).toContain('!translate-x-0');
        expect(tag, file).toContain('!translate-y-0');
        expect(tag, file).toContain('max-h-[85vh]');
        expect(tag, file).toContain('!w-[calc(100vw-2rem)]');
        expect(tag, file).toContain('!max-w-none');
        expect(tag, file).toMatch(/sm:!max-w-/);
        expect(tag, file).toMatch(/(?:overflow-hidden|overflow-y-auto)/);
      }
    }

    // All user-visible popups currently in the topology module:
    // TCP test, node edit/delete, server-link edit/delete, port edit,
    // port-link edit/delete, and global node/link delete confirmations.
    expect(audited).toBe(10);
  });
});
