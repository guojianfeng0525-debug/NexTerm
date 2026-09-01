import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../components/ui/context-menu';

// Mirrors the nested structure in integrated-file-browser.tsx: an outer
// empty-area ContextMenuTrigger wrapping the scroll region contains a
// per-row ContextMenuTrigger for each file entry.
function NestedMenus({
  outerMouseDown,
}: {
  outerMouseDown?: React.MouseEventHandler<HTMLDivElement>;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-testid="outer-area" onMouseDown={outerMouseDown}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              {/* The row stops the contextmenu from bubbling so only the
                  row menu opens — same as the file browser rows. */}
              <div
                data-testid="inner-row"
                onContextMenu={(e) => e.stopPropagation()}
              >
                file.txt
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem>Row item</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Outer item</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

describe('ContextMenuTrigger nested dispatch', () => {
  it('dispatches only one synthetic contextmenu for a right-click inside nested triggers', () => {
    // Capture phase: React's stopPropagation() on a synthetic event also
    // stops the native bubble phase, so a bubble-phase document listener
    // would miss dispatched events. A capture listener sees every
    // contextmenu dispatched anywhere, before any handler can stop it.
    const contextmenuSpy = vi.fn();
    const listener = (e: Event) => contextmenuSpy(e);
    document.addEventListener('contextmenu', listener, true);

    render(<NestedMenus />);

    fireEvent.mouseDown(screen.getByTestId('inner-row'), { button: 2 });

    // Exactly one synthetic contextmenu must be dispatched (by the inner
    // trigger). Without the stopPropagation fix the outer trigger wrapper
    // would dispatch a second one and stack two menus.
    expect(contextmenuSpy).toHaveBeenCalledTimes(1);

    document.removeEventListener('contextmenu', listener, true);
  });

  it('opens exactly one menu for a right-click on the nested row', async () => {
    render(<NestedMenus />);

    fireEvent.mouseDown(screen.getByTestId('inner-row'), { button: 2 });

    // The row menu opens...
    await waitFor(() => {
      expect(screen.getByText('Row item')).toBeTruthy();
    });
    // ...and only one menu is open (the outer menu must stay closed).
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(screen.queryByText('Outer item')).toBeNull();
  });

  it('opens the outer menu for a contextmenu on the empty area', async () => {
    render(<NestedMenus />);

    fireEvent.contextMenu(screen.getByTestId('outer-area'));

    await waitFor(() => {
      expect(screen.getByText('Outer item')).toBeTruthy();
    });
  });

  it('does not dispatch a synthetic contextmenu or block bubbling for left clicks', () => {
    const contextmenuSpy = vi.fn();
    const captureListener = (e: Event) => contextmenuSpy(e);
    document.addEventListener('contextmenu', captureListener, true);
    const outerMouseDown = vi.fn();

    render(<NestedMenus outerMouseDown={outerMouseDown} />);

    fireEvent.mouseDown(screen.getByTestId('inner-row'), { button: 0 });

    // No synthetic contextmenu for the primary button...
    expect(contextmenuSpy).toHaveBeenCalledTimes(0);
    // ...and the mousedown still bubbles to the outer container.
    expect(outerMouseDown).toHaveBeenCalledTimes(1);

    document.removeEventListener('contextmenu', captureListener, true);
  });

  it('stops the right-button mousedown from reaching outer trigger handlers', () => {
    const outerMouseDown = vi.fn();
    render(<NestedMenus outerMouseDown={outerMouseDown} />);

    fireEvent.mouseDown(screen.getByTestId('inner-row'), { button: 2 });
    expect(outerMouseDown).toHaveBeenCalledTimes(0);
  });
});
