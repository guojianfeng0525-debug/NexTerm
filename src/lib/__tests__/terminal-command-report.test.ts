import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOscCommandExtractor } from '../terminal-command-report';

const b64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

describe('createOscCommandExtractor', () => {
  let reported: string[];
  beforeEach(() => {
    reported = [];
  });
  const make = () => createOscCommandExtractor((command) => reported.push(command));

  it('strips a complete ST-terminated report and fires with the decoded command', () => {
    const extractor = make();
    const cleaned = extractor.push(`before\x1b]7777;${b64('echo hello')}\x1b\\after`);
    expect(cleaned).toBe('beforeafter');
    expect(reported).toEqual(['echo hello']);
  });

  it('supports the BEL terminator', () => {
    const extractor = make();
    const cleaned = extractor.push(`\x1b]7777;${b64('ls -l')}x`);
    expect(cleaned).toBe('x');
    expect(reported).toEqual(['ls -l']);
  });

  it('reassembles a report split across chunks', () => {
    const extractor = make();
    const payload = b64('git status --porcelain');
    const full = `prompt$\x1b]7777;${payload}\x1b\\`;
    const split = [full.slice(0, 10), full.slice(10, 18), full.slice(18)];
    const cleaned = split.map((chunk) => extractor.push(chunk)).join('');
    expect(cleaned).toBe('prompt$');
    expect(reported).toEqual(['git status --porcelain']);
  });

  it('handles multiple reports in one chunk', () => {
    const extractor = make();
    extractor.push(`\x1b]7777;${b64('a')}\x1b\\\x1b]7777;${b64('b')}\x07`);
    expect(reported).toEqual(['a', 'b']);
  });

  it('preserves multi-line and non-ASCII commands exactly', () => {
    const extractor = make();
    const command = "echo '第一行\n第二行' && echo 'trailing space '";
    extractor.push(`\x1b]7777;${b64(command)}\x1b\\`);
    expect(reported).toEqual([command]);
  });

  it('passes other OSC sequences through untouched for xterm to handle', () => {
    const extractor = make();
    const raw = '\x1b]0;window title\x07\x1b]7;file://host/tmp\x1b\\';
    const cleaned = extractor.push(raw);
    // Only OSC 7777 is stripped; title/cwd sequences belong to xterm.
    expect(cleaned).toBe(raw);
    expect(reported).toEqual([]);
  });

  it('drops invalid base64 payloads without emitting', () => {
    const extractor = make();
    const cleaned = extractor.push(`ok\x1b]7777;!!!not-base64!!!\x1b\\`);
    expect(cleaned).toBe('ok');
    expect(reported).toEqual([]);
  });

  it('does not treat a partial prefix at the chunk end as renderable text', () => {
    const extractor = make();
    const first = extractor.push('abc\x1b]77');
    expect(first).toBe('abc');
    const second = extractor.push(`77;${b64('cd /tmp')}\x1b\\!`);
    expect(second).toBe('!');
    expect(reported).toEqual(['cd /tmp']);
  });

  it('rejects decoded commands containing control characters', () => {
    const extractor = make();
    extractor.push(`\x1b]7777;${b64('echo\x1bell')}\x1b\\`);
    expect(reported).toEqual([]);
  });

  it('flushes nothing for an empty stream', () => {
    const extractor = make();
    expect(extractor.push('')).toBe('');
    expect(reported).toEqual([]);
  });

  it('reports once per extractor callback invocation', () => {
    const onCommand = vi.fn();
    const extractor = createOscCommandExtractor(onCommand);
    extractor.push(`\x1b]7777;${b64('true')}\x1b\\`);
    expect(onCommand).toHaveBeenCalledTimes(1);
  });
});
