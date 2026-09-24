import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('bridge', {
  action: (action: string, expected?: unknown) =>
    ipcRenderer.invoke('bridge:action', action, expected),
  status: () => ipcRenderer.invoke('bridge:status'),
  setup: (action: string, index?: number) => ipcRenderer.invoke('bridge:setup', action, index),
  surface: (surface: string) => ipcRenderer.invoke('bridge:surface', surface),
  language: (language: string) => ipcRenderer.invoke('bridge:language', language),
  viewport: (bounds: unknown) => ipcRenderer.invoke('bridge:viewport', bounds),
  onSurface: (listener: (surface: string) => void) => {
    ipcRenderer.on('bridge:surface-changed', (_event, surface: string) => listener(surface));
  },
});
