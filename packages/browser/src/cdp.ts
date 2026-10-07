import type { WebContents } from 'electron';

export class Cdp {
  guard: () => void = () => {};
  constructor(readonly contents: WebContents) {}
  connect() {
    if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3');
  }
  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    this.guard();
    if (!this.contents.debugger.isAttached()) throw new Error('ADAPTER_UNAVAILABLE');
    return this.contents.debugger.sendCommand(method, params);
  }
  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.exceptionDetails) throw new Error('UI_CHANGED');
    return reply.result.value as T;
  }
  // Callers observe readiness themselves. A client-side redirect that supersedes the load
  // (ERR_ABORTED) is not a failure; any other load error is reported as PAGE_LOAD_FAILED.
  async load(url: string) {
    this.guard();
    await this.contents.loadURL(url).catch((error: { code?: string } | undefined) => {
      if (error?.code !== 'ERR_ABORTED') throw new Error('PAGE_LOAD_FAILED');
    });
  }
  async files(selector: string, paths: string[]) {
    const reply = await this.send('Runtime.evaluate', {
      expression: `(() => { const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.parentElement?.checkVisibility({checkVisibilityCSS:true})); if (nodes.length !== 1) throw Error(); return nodes[0]; })()`,
      returnByValue: false,
    });
    const objectId = reply.result?.objectId;
    if (reply.exceptionDetails || !objectId) throw new Error('UI_CHANGED');
    try {
      await this.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          this.__bridgeFileCapture = () => { this.__bridgeReceivedNames = [...this.files].map(file => file.name); };
          this.addEventListener('change', this.__bridgeFileCapture, {capture: true});
        }`,
      });
      await this.send('DOM.setFileInputFiles', { objectId, files: paths });
      const observed = await this.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration:
          'function() { return this.__bridgeReceivedNames ?? [...this.files].map(file => file.name); }',
        returnByValue: true,
      });
      if (observed.exceptionDetails) throw new Error('UI_CHANGED');
      return observed.result.value as string[];
    } finally {
      await this.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          this.removeEventListener('change', this.__bridgeFileCapture, {capture: true});
          delete this.__bridgeFileCapture; delete this.__bridgeReceivedNames;
        }`,
      }).catch(() => {});
      await this.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }
  async click(selector: string) {
    await this.evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      if (nodes.length !== 1 || nodes[0].disabled || nodes[0].getAttribute('aria-disabled') === 'true') throw Error();
      nodes[0].click();
    })()`);
  }
}

export async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error('OBSERVATION_TIMEOUT');
}
