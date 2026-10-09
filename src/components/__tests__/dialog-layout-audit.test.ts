import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('application dialog layout inventory', () => {
  it('keeps page-level dialogs on the shared viewport and avoids native browser prompts', () => {
    const root = join(process.cwd(), 'src');
    let count = 0;
    for (const entry of readdirSync(root, { recursive: true })) {
      const file = String(entry);
      if (!file.endsWith('.tsx') || /(?:__tests__|\.test\.)/.test(file)) continue;
      const source = readFileSync(join(root, file), 'utf8');
      for (const [tag] of source.matchAll(/<(?:Dialog|AlertDialog)Content\b[\s\S]*?>/g)) {
        count++;
        expect(tag, file).not.toMatch(/(?:!inset-|top-\[|left-\[|translate-[xy]|h-fit|sm:!?max-w-|!max-w-none)/);
      }
      // The request hook is scoped and cancellable; browser dialogs are not.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(code, file).not.toMatch(/(?:window\.)?(?:confirm|prompt|alert)\s*\(/);
    }
    expect(count).toBeGreaterThanOrEqual(65);
  });
});
