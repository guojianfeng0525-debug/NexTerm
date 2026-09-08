import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MenuBar } from '@/components/menu-bar';

// jsdom's default platform is not macOS, which is exactly the Windows/Linux
// code path that renders NexTerm's in-window menu bar.
describe('MenuBar — Windows top-left menus', () => {
  afterEach(cleanup);

  it('keeps only Servers and Terminal', () => {
    render(<MenuBar />);

    expect(screen.getByRole('button', { name: 'Servers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeTruthy();

    for (const removed of ['Apps', 'Vault', 'Tunnels', 'Services', 'Notes', 'Network Topology']) {
      expect(screen.queryByRole('button', { name: removed })).toBeNull();
    }
  });
});
