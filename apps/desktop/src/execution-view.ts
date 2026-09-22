import type { BrowserWindow, WebContentsView } from 'electron';

export function executionVisibility(window: BrowserWindow, view: WebContentsView) {
  return (active: boolean) => {
    // Hiding the child view suspends lazy image hydration; hide the window only.
    view.setVisible(true);
    if (active) window.hide();
  };
}
