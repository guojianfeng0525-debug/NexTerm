import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('application dialog layout inventory', () => {
  it('assigns all confirmation call sites to the approved width tiers', () => {
    const root = join(process.cwd(), 'src/components');
    expect(readFileSync(join(root, 'ui/alert-dialog.tsx'), 'utf8')).toContain('max-w-[400px]');
    for (const entry of readdirSync(root, { recursive: true })) {
      const file = String(entry);
      if (!file.endsWith('.tsx') || /(?:__tests__|\.test\.|^ui\/)/.test(file)) continue;
      for (const [tag] of readFileSync(join(root, file), 'utf8').matchAll(/<AlertDialogContent\b[\s\S]*?>/g)) {
        const explicitWidth = tag.match(/max-w-\[(\d+)px\]/);
        if (explicitWidth) expect([400, 480, 560], file).toContain(Number(explicitWidth[1]));
        else expect(tag, file).not.toContain('max-w-');
      }
    }
    for (const file of ['log-command-manager.tsx', 'network/topology-node-dialog.tsx', 'network/port-link-editor-dialog.tsx', 'network/link-editor-dialog.tsx', 'toolbox/tool-mysql.tsx']) {
      expect(readFileSync(join(root, file), 'utf8'), file).toContain('max-w-[400px]');
    }
  });
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
