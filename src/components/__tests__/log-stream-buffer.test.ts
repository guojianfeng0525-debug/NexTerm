import { describe, expect, it } from 'vitest';
import { appendChunk, STREAM_LINE_CAP } from '../log-monitor';

describe('appendChunk — streaming line buffer', () => {
  it('splits complete lines and carries the trailing partial line', () => {
    const first = appendChunk([], '', 'hello\nwor', STREAM_LINE_CAP);
    expect(first.lines).toEqual(['hello']);
    expect(first.pending).toBe('wor');

    const second = appendChunk(first.lines, first.pending, 'ld\nnext\n', STREAM_LINE_CAP);
    expect(second.lines).toEqual(['hello', 'world', 'next']);
    expect(second.pending).toBe('');
  });

  it('handles a chunk with no newline at all', () => {
    const out = appendChunk(['a'], '', 'partial-only', STREAM_LINE_CAP);
    expect(out.lines).toEqual(['a']);
    expect(out.pending).toBe('partial-only');
  });

  it('prepends pending to the next chunk even across flush windows', () => {
    const a = appendChunk([], '', 'tail: 1', STREAM_LINE_CAP);
    const b = appendChunk(a.lines, a.pending, '00 line\n', STREAM_LINE_CAP);
    expect(b.lines).toEqual(['tail: 100 line']);
    expect(b.pending).toBe('');
  });

  it('drops the oldest lines once the cap is exceeded', () => {
    const cap = 5;
    let state = { lines: [] as string[], pending: '' };
    for (let i = 1; i <= 10; i += 1) {
      state = appendChunk(state.lines, state.pending, `line-${i}\n`, cap);
    }
    expect(state.lines).toEqual(['line-6', 'line-7', 'line-8', 'line-9', 'line-10']);
    expect(state.lines).toHaveLength(cap);
  });

  it('keeps exactly the newest window when a single chunk is huge', () => {
    const cap = 3;
    const chunk = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n';
    const out = appendChunk(['old'], '', chunk, cap);
    expect(out.lines).toEqual(['l7', 'l8', 'l9']);
    expect(out.pending).toBe('');
  });

  it('preserves empty lines between content', () => {
    const out = appendChunk([], '', 'a\n\nb\n', STREAM_LINE_CAP);
    expect(out.lines).toEqual(['a', '', 'b']);
  });
});
