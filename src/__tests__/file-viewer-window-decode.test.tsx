import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

/**
 * P1-3 regression: FileViewerWindow must use URLSearchParams values as-is.
 * The sender encodeURIComponent-encodes once; URLSearchParams.get() decodes
 * once. A second decodeURIComponent used to corrupt names containing '%' and
 * throw URIError (white screen) on names like "50%.txt".
 */

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

const { FileViewerWindow } = await import('../FileViewerWindow');

function renderWithSearch(search: string) {
  // jsdom allows mutating location.search via window.history.replaceState.
  window.history.replaceState(null, '', `/${search}`);
  return render(<FileViewerWindow />);
}

describe('FileViewerWindow query param decoding', () => {
  it('keeps literal percent signs intact (a%20b.txt stays a%20b.txt)', () => {
    const { container } = renderWithSearch(
      '?mode=file-viewer&connectionId=c1&filePath=' + encodeURIComponent('/tmp/a%20b.txt') + '&fileName=' + encodeURIComponent('a%20b.txt'),
    );
    // Should render without throwing and without double-decoding.
    expect(container.innerHTML).not.toContain('a b.txt');
  });

  it('does not throw URIError on names like 50%.txt', () => {
    expect(() =>
      renderWithSearch(
        '?mode=file-viewer&connectionId=c1&filePath=' + encodeURIComponent('/tmp/50%.txt') + '&fileName=' + encodeURIComponent('50%.txt'),
      ),
    ).not.toThrow();
  });

  it('decodes ordinary percent-encoded paths exactly once', () => {
    const { container } = renderWithSearch(
      '?mode=file-viewer&connectionId=c1&filePath=' + encodeURIComponent('/tmp/my file.txt') + '&fileName=' + encodeURIComponent('my file.txt'),
    );
    // Encoding round-trips: encoded "%20" → decoded space (visible once).
    expect(container.innerHTML).toContain('my file.txt');
  });
});
