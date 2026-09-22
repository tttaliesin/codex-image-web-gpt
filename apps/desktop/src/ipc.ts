import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';

/** All renderer commands share one sender/frame boundary. The remote page has no bridge. */
export function handleDesktopCommand(
  window: BrowserWindow,
  channel: string,
  handler: (...args: any[]) => unknown,
) {
  const listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error('DENIED');
    return handler(...args);
  };
  ipcMain.handle(channel, listener);
  window.once('closed', () => ipcMain.removeHandler(channel));
}
