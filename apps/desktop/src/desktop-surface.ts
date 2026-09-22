import type { BrowserWindow, WebContentsView } from 'electron';

export type Surface = 'workspace' | 'browser' | 'settings';

/** Owns the local dashboard/native page boundary; never navigates the remote page. */
export class DesktopSurface {
  selected: Surface = 'workspace';

  constructor(
    readonly window: BrowserWindow,
    readonly page: WebContentsView,
    private busy: () => boolean,
  ) {
    window.on('hide', () => this.syncVisibility());
    window.on('show', () => this.syncVisibility());
    window.on('resize', () => this.resize());
    this.resize();
  }

  syncVisibility() {
    if (this.window.isDestroyed() || this.page.webContents.isDestroyed()) return;
    // Hidden-window hydration must continue; a visible dashboard must remain unobstructed.
    this.page.setVisible(!this.window.isVisible() || (this.selected === 'browser' && !this.busy()));
  }

  select(value: string) {
    if (value !== 'workspace' && value !== 'browser' && value !== 'settings')
      throw Error('INPUT_INVALID');
    this.selected = value;
    this.syncVisibility();
  }

  show(browser = false) {
    if (this.window.isDestroyed()) return;
    if (browser) {
      this.select('browser');
      this.window.webContents.send('bridge:surface-changed', this.selected);
    }
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.syncVisibility();
    this.window.moveTop();
    this.window.focus();
  }

  viewport(bounds: Electron.Rectangle) {
    const [width, height] = this.window.getContentSize();
    if (
      !bounds ||
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isInteger) ||
      bounds.x < 180 ||
      bounds.y < 96 ||
      bounds.width < 1 ||
      bounds.height < 1 ||
      bounds.x + bounds.width > width! ||
      bounds.y + bounds.height > height!
    )
      throw Error('INPUT_INVALID');
    if (this.selected === 'browser') {
      this.page.setBounds(bounds);
      this.syncVisibility();
    }
  }

  private resize() {
    const [width = 1360, height = 900] = this.window.getContentSize();
    const x = (width <= 1120 ? 210 : 232) + 23;
    this.page.setBounds({
      x,
      y: 160,
      width: Math.max(1, width - x - 23),
      height: Math.max(1, height - 195),
    });
  }
}
