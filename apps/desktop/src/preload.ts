import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('bridge', {
  action: (action: string, expected?: unknown) =>
    ipcRenderer.invoke('bridge:action', action, expected),
  status: () => ipcRenderer.invoke('bridge:status'),
  surface: (surface: string) => ipcRenderer.invoke('bridge:surface', surface),
  viewport: (bounds: unknown) => ipcRenderer.invoke('bridge:viewport', bounds),
  onSurface: (listener: (surface: string) => void) => {
    ipcRenderer.on('bridge:surface-changed', (_event, surface: string) => listener(surface));
  },
});
