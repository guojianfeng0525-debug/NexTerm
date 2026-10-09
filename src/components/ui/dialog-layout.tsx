import type { ReactNode } from 'react';

// Center the content in a separate viewport. Mixing inset: 0, auto margins,
// fit-content and translate(-50%) on Content stretches/misplaces WKWebView
// dialogs. Content can now size naturally, or use an explicit height for a
// flex layout, without changing its positioning.
export function DialogViewport({ children }: { children: ReactNode }) {
  return (
    <div data-slot="dialog-viewport" className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
      {children}
    </div>
  );
}

export const dialogContentLayout =
  'pointer-events-auto relative min-h-0 min-w-0 w-full max-w-lg max-h-[calc(100dvh-2rem)] overscroll-contain [overflow-wrap:anywhere]';
