import { Cdp, until } from './cdp';
import { conversationUrl } from './policy';

export interface Message {
  id: string;
  role: string;
  text: string;
  attachments: string[];
  downloads: number;
  images: number;
  outputReady?: boolean;
  completed?: boolean;
  outputCount?: number;
}
export interface Snapshot {
  url: string;
  composer: number;
  prompt: string;
  attachments: string[];
  uploading: boolean;
  busy: boolean;
  send: number;
  messages: Message[];
  login: boolean;
  challenge: boolean;
  serviceError?: 'RATE_LIMITED' | 'GENERATION_REJECTED';
}
export interface Selectors {
  composer: string;
  file: string;
  send: string;
  attachments: string;
  uploading: string;
  busy: string;
  messages: string;
  messageText: string;
  messageAttachments: string;
  download: string;
}
export const fixtureSelectors: Selectors = {
  composer: '#prompt',
  file: 'input[type=file]',
  send: '#send',
  attachments: '#attachments [data-filename]',
  uploading: '[data-uploading=true]',
  busy: '[data-generating=true]',
  messages: '[data-message-id]',
  messageText: '.text',
  messageAttachments: '[data-filename]',
  download: '[data-download]',
};
// Provisional public-UI selectors. A unique match and evidence checks are mandatory.
// Live compatibility remains unverified until an actual authorized run completes.
export const chatgptSelectors: Selectors = {
  composer: '#prompt-textarea',
  file: '#upload-photos',
  send: 'button[data-testid="send-button"]',
  attachments: 'form button[aria-label^="파일 "][aria-label*=" 제거: "]',
  uploading: 'form [role="progressbar"]',
  busy: 'button[data-testid="stop-button"]',
  messages: '[data-testid^="conversation-turn-"][data-turn-id]',
  messageText: '.whitespace-pre-wrap, .markdown',
  messageAttachments: '[data-testid="file-upload"], img[alt]',
  download:
    'button[aria-label="Download"], button[aria-label="다운로드"], button[aria-label="Download image"], button[aria-label="이미지 다운로드"]',
};
export const displayText = (value: string) => value.replace(/\r\n/g, '\n');

export class PageAdapter {
  readonly version = 'm2-ui-0.3';
  guard: () => void = () => {};
  private capturedDownload?: { messageId: string; ordinal: number; url: string; source: string };
  constructor(
    readonly cdp: Cdp,
    readonly selectors: Selectors,
    readonly fixtureOrigin?: string,
  ) {}
  async cleanupCapture() {
    this.capturedDownload = undefined;
    await this.cdp
      .evaluate(
        `(() => {const c=window.__webImageBridgeCapture;if(c){c.restore();c.deferred.forEach(u=>c.originalRevoke.call(URL,u));delete window.__webImageBridgeCapture;}})()`,
      )
      .catch(() => {});
  }

  async snapshot(): Promise<Snapshot> {
    this.guard();
    return this.cdp.evaluate(`(() => {
      const s = ${JSON.stringify(this.selectors)};
      const q = (sel, root = document) => [...root.querySelectorAll(sel)];
      const name = e => e.getAttribute('data-filename') || e.getAttribute('title') ||
        (/^파일 \\d+ 제거: (.+)$/.exec(e.getAttribute('aria-label') || '') || [])[1] || e.getAttribute('alt') || e.textContent;
      const editors = q(s.composer);
      const editor = editors[0];
      const alerts=q('[role="alert"]').map(e=>e.innerText).join(' ');
      return {
        serviceError: /rate limit|image generation limit|한도에 도달|생성 한도/i.test(alerts) ? 'RATE_LIMITED' :
          /generation rejected|could not generate|이미지를 생성할 수 없/i.test(alerts) ? 'GENERATION_REJECTED' : undefined,
        url: location.href, composer: editors.length,
        prompt: editor ? ('value' in editor ? editor.value : editor.innerText) : '',
        attachments: q(s.attachments).map(name), uploading: q(s.uploading).length > 0,
        busy: q(s.busy).length > 0, send: q(s.send).filter(e => !e.disabled && e.getAttribute('aria-disabled') !== 'true').length,
        login: !!document.querySelector('[data-testid="login-button"], a[href="/auth/login"]') ||
          /auth\\.openai\\.com/.test(location.hostname) ||
          q('button,a').some(e => /^(Log in|로그인)$/.test(e.textContent.trim())),
        challenge: !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-running'),
        messages: q(s.messages).map((e, i) => ({
          id: e.getAttribute('data-message-id') || e.getAttribute('data-turn-id') || '',
          role: e.getAttribute('data-message-author-role') || e.getAttribute('data-turn') || '',
          text: q(s.messageText, e).map(x => x.innerText).join('\\n'),
          attachments: q(s.messageAttachments, e).map(name),
          downloads: q(s.download, e).length, images: q('img', e).length,
          completed: q('[data-testid="copy-turn-action-button"],[data-response-complete="true"]',e).length > 0,
          outputCount: q('img[alt^="생성된 이미지"],img[alt^="Generated image"]',e).length || q(s.download,e).length,
          outputReady: q('img[alt^="생성된 이미지"],img[alt^="Generated image"]',e).length > 0 &&
            q('img[alt^="생성된 이미지"],img[alt^="Generated image"]',e).every(i=>i.complete && i.naturalWidth>0) &&
            q('[data-testid="copy-turn-action-button"]',e).length === 1,
        })),
      };
    })()`);
  }

  async attach(paths: string[], names: string[], approvedPrompt = '') {
    const initial = await this.snapshot();
    if (initial.login) throw Error('AUTH_REQUIRED');
    if (initial.challenge) throw Error('HUMAN_CHECK_REQUIRED');
    if (
      initial.composer !== 1 ||
      initial.busy ||
      (initial.prompt && displayText(initial.prompt) !== displayText(approvedPrompt)) ||
      JSON.stringify(initial.attachments) !==
        JSON.stringify(names.slice(0, initial.attachments.length))
    )
      throw Error('COMPOSER_NOT_EMPTY');
    // Sequential attachment waits preserve the intended order even for async upload UI.
    for (let i = initial.attachments.length; i < paths.length; i++) {
      this.guard();
      await this.cdp.files(this.selectors.file, [paths[i]!]);
      await until(
        () => this.snapshot(),
        (snapshot) =>
          !snapshot.uploading &&
          JSON.stringify(snapshot.attachments) === JSON.stringify(names.slice(0, i + 1)),
        120_000,
      );
    }
  }

  async fill(prompt: string, names: string[]) {
    const before = await this.snapshot();
    if (before.prompt && displayText(before.prompt) !== displayText(prompt))
      throw Error('PROMPT_OR_ATTACHMENTS_CHANGED');
    this.guard();
    await this.cdp.evaluate(`(() => {
      const nodes = document.querySelectorAll(${JSON.stringify(this.selectors.composer)});
      if (nodes.length !== 1) throw Error();
      nodes[0].focus();
    })()`);
    if (!before.prompt) await this.cdp.send('Input.insertText', { text: prompt });
    const snapshot = await this.snapshot();
    if (
      displayText(snapshot.prompt) !== displayText(prompt) ||
      snapshot.uploading ||
      JSON.stringify(snapshot.attachments) !== JSON.stringify(names)
    )
      throw Error('PROMPT_OR_ATTACHMENTS_CHANGED');
    return snapshot;
  }

  async clickSend(expected: Snapshot) {
    const current = await this.snapshot();
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw Error('PAGE_CHANGED_BEFORE_SEND');
    this.guard();
    await this.cdp.evaluate(`(() => {
      const s = ${JSON.stringify(this.selectors)};
      const expected = ${JSON.stringify(expected)};
      const editor = document.querySelector(s.composer);
      const value = editor && ('value' in editor ? editor.value : editor.innerText);
      const names = [...document.querySelectorAll(s.attachments)].map(e => e.getAttribute('data-filename') || e.getAttribute('title') ||
        (/^파일 \\d+ 제거: (.+)$/.exec(e.getAttribute('aria-label') || '') || [])[1] || e.getAttribute('alt') || e.textContent);
      const ids = [...document.querySelectorAll(s.messages)].map(e => e.getAttribute('data-message-id') || e.getAttribute('data-turn-id'));
      const buttons = document.querySelectorAll(s.send);
      if (location.href !== expected.url || value !== expected.prompt || JSON.stringify(names) !== JSON.stringify(expected.attachments) ||
          JSON.stringify(ids) !== JSON.stringify(expected.messages.map(m => m.id)) || document.querySelector(s.uploading) || document.querySelector(s.busy) ||
          buttons.length !== 1 || buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true') throw Error();
      buttons[0].click();
    })()`);
  }

  findSubmission(
    snapshot: Snapshot,
    baseline: Snapshot,
    prompt: string,
    names: string[],
  ): Message | undefined {
    if (!conversationUrl(snapshot.url, this.fixtureOrigin)) return;
    if (conversationUrl(baseline.url, this.fixtureOrigin) && baseline.url !== snapshot.url) return;
    const old = new Set(baseline.messages.map((message) => message.id));
    if (baseline.messages.some((message, i) => snapshot.messages[i]?.id !== message.id)) return;
    const newUsers = snapshot.messages.filter(
      (message) => !old.has(message.id) && message.role === 'user',
    );
    if (newUsers.length !== 1) return;
    const message = newUsers[0]!;
    if (
      message.id &&
      displayText(message.text) === displayText(prompt) &&
      JSON.stringify(message.attachments) === JSON.stringify(names)
    )
      return message;
  }

  async confirm(baseline: Snapshot, prompt: string, names: string[]) {
    const snapshot = await until(
      () => this.snapshot(),
      (value) => !!this.findSubmission(value, baseline, prompt, names),
      15000,
    );
    return { snapshot, message: this.findSubmission(snapshot, baseline, prompt, names)! };
  }

  async generation(
    userId: string,
    url: string,
    timeout = 20 * 60 * 1000,
    allowIdentityRefresh = true,
  ): Promise<Message> {
    const snapshot = await until(
      async () => {
        const value = await this.snapshot();
        const index = value.messages.findIndex((message) => message.id === userId);
        const response = index >= 0 ? value.messages[index + 1] : undefined;
        if (
          value.url === url &&
          response?.role === 'assistant' &&
          response.images &&
          !response.outputReady
        ) {
          // Native lazy images can remain unloaded in a hidden window. Ask the browser
          // to render this response's existing UI images, without fetching/exporting them.
          this.guard();
          await this.cdp.evaluate(`(() => {
          if(location.href!==${JSON.stringify(url)})throw Error();
          const nodes=[...document.querySelectorAll(${JSON.stringify(this.selectors.messages)})].filter(e=>(e.getAttribute('data-message-id')||e.getAttribute('data-turn-id'))===${JSON.stringify(response.id)});
          if(nodes.length!==1)throw Error();
          for(const image of nodes[0].querySelectorAll('img[loading="lazy"]'))image.loading='eager';
        })()`);
        }
        return value;
      },
      (value) => {
        if (value.login) throw Error('AUTH_REQUIRED');
        if (value.challenge) throw Error('HUMAN_CHECK_REQUIRED');
        if (value.serviceError) throw Error(value.serviceError);
        if (value.url !== url) throw Error('SESSION_CHANGED');
        const index = value.messages.findIndex((message) => message.id === userId);
        if (index < 0) throw Error('SUBMISSION_UNKNOWN');
        const following = value.messages.slice(index + 1);
        if (following.some((message) => message.role === 'user')) throw Error('SESSION_CHANGED');
        const responses = following.filter((message) => message.role === 'assistant');
        if (value.busy || !responses.length) return false;
        if (responses.length !== 1) throw Error('UI_CHANGED');
        const response = responses[0]!;
        // The web UI can expose its completed controls before the image hydrates.
        if (response.completed && response.images === 0 && response.text.trim())
          throw Error('TEXT_RESPONSE');
        if ((!response.outputReady && response.downloads === 0) || response.images === 0)
          return false;
        if (!response.outputCount || response.outputCount > 4) throw Error('UI_CHANGED');
        return true;
      },
      timeout,
    );
    const response = snapshot.messages
      .slice(snapshot.messages.findIndex((message) => message.id === userId) + 1)
      .find((message) => message.role === 'assistant')!;
    if (!this.fixtureOrigin && response.id.startsWith('request-')) {
      if (!allowIdentityRefresh) throw Error('OUTPUT_IDENTITY_UNSTABLE');
      await this.cdp.contents.loadURL(url);
      await until(
        () => this.snapshot(),
        (value) => value.url === url && value.messages.some((message) => message.id === userId),
        15000,
      );
      return this.generation(userId, url, 60000, false);
    }
    return response;
  }

  async downloadTarget(messageId: string, ordinal = 0): Promise<string> {
    this.guard();
    if (
      this.capturedDownload?.messageId === messageId &&
      this.capturedDownload.ordinal === ordinal
    ) {
      const live = await this.cdp.evaluate<string | null>(
        'window.__webImageBridgeCapture?.url || null',
      );
      if (live === this.capturedDownload.url) return this.capturedDownload.url;
      this.capturedDownload = undefined;
    }
    const target = await this.cdp.evaluate<string | null>(`(() => {
      const messages = [...document.querySelectorAll(${JSON.stringify(this.selectors.messages)})]
        .filter(e => (e.getAttribute('data-message-id') || e.getAttribute('data-turn-id')) === ${JSON.stringify(messageId)});
      if (messages.length !== 1) throw Error();
      const buttons = messages[0].querySelectorAll(${JSON.stringify(this.selectors.download)});
      if (buttons.length === 0) {
        const images = messages[0].querySelectorAll('img[alt^="생성된 이미지"],img[alt^="Generated image"]');
        const selected=images[${ordinal}];
        if (!selected || !selected.complete || images.length>4) throw Error();
        const opener = selected.closest('[role="button"]');
        if (!opener) throw Error();
        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        if(dialogs.length>0 && (dialogs.length!==1 || dialogs[0].querySelector('img[alt]:not([alt=""])')?.src!==selected.src)) throw Error();
        if(dialogs.length===0) opener.click(); return null;
      }
      if (!buttons[${ordinal}] || buttons.length>4) throw Error();
      const link = buttons[${ordinal}].closest('a[href]');
      return link ? link.href : null;
    })()`);
    if (!target) {
      const source = await until(
        () =>
          this.cdp.evaluate<string | null>(`(() => {
        const message = [...document.querySelectorAll(${JSON.stringify(this.selectors.messages)})].find(e=>(e.getAttribute('data-message-id')||e.getAttribute('data-turn-id'))===${JSON.stringify(messageId)});
        const original = message?.querySelectorAll('img[alt^="생성된 이미지"],img[alt^="Generated image"]')[${ordinal}];
        const dialogs=[...document.querySelectorAll('[role="dialog"]')];
        if (!original || dialogs.length!==1) return null;
        const display=dialogs[0].querySelectorAll('img[alt]:not([alt=""])');
        const image=display.length===1?display[0]:null;
        const save=dialogs[0].querySelectorAll('button[aria-label="저장"],button[aria-label="Save"]');
        return image?.complete && image.src===original.src && save.length===1 ? original.src : null;
      })()`),
        (value) => !!value,
        10000,
      );
      // Capture the download anchor emitted by the public Save UI. Do not fetch an
      // image source, call private APIs, or substitute the displayed thumbnail.
      await this.cdp.evaluate(`(() => {
        const source=${JSON.stringify(source)};
        const dialog=document.querySelector('[role="dialog"]');
        if (!dialog || dialog.querySelector('img[alt]:not([alt=""])')?.src!==source || window.__webImageBridgeCapture) throw Error();
        const save=dialog.querySelectorAll('button[aria-label="저장"],button[aria-label="Save"]');
        if(save.length!==1) throw Error();
        const originalClick=HTMLAnchorElement.prototype.click;
        const originalRevoke=URL.revokeObjectURL;
        const capture={anchor:null,url:null,source,ambiguous:false,deferred:[],originalClick,originalRevoke,timer:null,
          restore(){HTMLAnchorElement.prototype.click=originalClick;URL.revokeObjectURL=originalRevoke;clearTimeout(this.timer);}};
        window.__webImageBridgeCapture=capture;
        HTMLAnchorElement.prototype.click=function(){
          if (!this.hasAttribute('download')) return originalClick.call(this);
          if(capture.anchor){capture.ambiguous=true;return;}
          capture.anchor=this;capture.url=this.href;
        };
        URL.revokeObjectURL=function(url){if(url===capture.url)capture.deferred.push(url);else originalRevoke.call(URL,url);};
        capture.timer=setTimeout(()=>{capture.restore();capture.deferred.forEach(u=>originalRevoke.call(URL,u));delete window.__webImageBridgeCapture;},30000);
        save[0].click();
      })()`);
      try {
        const captured = await until(
          () =>
            this.cdp.evaluate<{ url: string | null; ambiguous: boolean }>(
              `({url:window.__webImageBridgeCapture?.url||null,ambiguous:!!window.__webImageBridgeCapture?.ambiguous})`,
            ),
          (value) => !!value.url || value.ambiguous,
          15000,
        );
        if (captured.ambiguous || !captured.url) throw Error('DOWNLOAD_TARGET_UNVERIFIED');
        this.capturedDownload = { messageId, ordinal, url: captured.url, source: source! };
        return captured.url;
      } catch (error) {
        await this.cdp
          .evaluate(
            `(() => {const c=window.__webImageBridgeCapture;if(c){c.restore();c.deferred.forEach(u=>c.originalRevoke.call(URL,u));delete window.__webImageBridgeCapture;}})()`,
          )
          .catch(() => {});
        throw error;
      }
    }
    return target;
  }

  async download(messageId: string, expectedTarget: string, conversation: string, ordinal = 0) {
    if (
      (await this.snapshot()).url !== conversation ||
      (await this.downloadTarget(messageId, ordinal)) !== expectedTarget
    )
      throw Error('SESSION_CHANGED');
    if (this.capturedDownload) {
      const source = this.capturedDownload.source;
      await this.cdp.evaluate(`(() => {
        const capture=window.__webImageBridgeCapture;
        const dialog=document.querySelector('[role="dialog"]');
        if(!capture || capture.ambiguous || capture.url!==${JSON.stringify(expectedTarget)} || dialog?.querySelector('img[alt]:not([alt=""])')?.src!==${JSON.stringify(source)}) throw Error();
        capture.restore(); capture.originalClick.call(capture.anchor);
        setTimeout(()=>capture.deferred.forEach(u=>capture.originalRevoke.call(URL,u)),1000);
        delete window.__webImageBridgeCapture;
      })()`);
      this.capturedDownload = undefined;
      return;
    }
    // Scope to the confirmed assistant response; never click a preceding image's button.
    await this.cdp.evaluate(`(() => {
      const messages = [...document.querySelectorAll(${JSON.stringify(this.selectors.messages)})]
        .filter(e => (e.getAttribute('data-message-id') || e.getAttribute('data-turn-id')) === ${JSON.stringify(messageId)});
      if (messages.length !== 1) throw Error();
      const buttons = messages[0].querySelectorAll(${JSON.stringify(this.selectors.download)});
      if (!buttons[${ordinal}] || buttons[${ordinal}].disabled || buttons.length>4) throw Error();
      buttons[${ordinal}].click();
    })()`);
  }

  async dismissViewer(messageId: string, ordinal = 0) {
    this.guard();
    await this.cdp.evaluate(`(() => {
      const dialogs=[...document.querySelectorAll('[role="dialog"]')]; if(!dialogs.length)return;
      const message=[...document.querySelectorAll(${JSON.stringify(this.selectors.messages)})].find(e=>(e.getAttribute('data-message-id')||e.getAttribute('data-turn-id'))===${JSON.stringify(messageId)});
      const original=message?.querySelectorAll('img[alt^="생성된 이미지"],img[alt^="Generated image"]')[${ordinal}];
      if(dialogs.length!==1 || !original || dialogs[0].querySelector('img[alt]:not([alt=""])')?.src!==original.src)throw Error();
      const close=dialogs[0].querySelectorAll('button[aria-label="전체 화면 닫기"],button[aria-label="Close full screen"],button[aria-label="Close fullscreen"],button[aria-label="Close"],button[aria-label="닫기"]');
      if(close.length!==1)throw Error();close[0].click();
    })()`);
    await until(
      () => this.cdp.evaluate<number>('document.querySelectorAll(\'[role="dialog"]\').length'),
      (count) => count === 0,
      2000,
    );
  }
}
