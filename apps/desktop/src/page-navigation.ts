interface DocumentLoader {
  once(event: 'dom-ready', listener: () => void): unknown;
  removeListener(event: 'dom-ready', listener: () => void): unknown;
  loadURL(url: string): Promise<unknown>;
}

/** The local app must not wait for every remote subresource before starting MCP. */
export function loadPageDocument(contents: DocumentLoader, url: string, timeoutMs = 15000) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.removeListener('dom-ready', onReady);
      resolve(ready);
    };
    const onReady = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    contents.once('dom-ready', onReady);
    try {
      void contents.loadURL(url).then(
        () => finish(true),
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
}
