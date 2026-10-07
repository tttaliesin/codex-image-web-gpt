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
  attachmentNamesHidden?: boolean;
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
  composer:
    '#prompt-textarea, [contenteditable="true"][role="textbox"].ProseMirror:not(#prompt-textarea):not(#prompt-textarea *)',
  file: 'input[type="file"][accept="image/*"][multiple]',
  send: 'button[data-testid="send-button"], button#composer-submit-button, button[aria-label="Send prompt"], button[aria-label="프롬프트 보내기"], form button[type="submit"]',
  attachments:
    'form button[aria-label*="제거"], form button[aria-label^="Remove"], form button[aria-label^="remove"]',
  uploading: 'form [role="progressbar"]',
  busy: 'button[data-testid="stop-button"]',
  messages: '[data-testid^="conversation-turn-"][data-turn-id], [data-chatgpt-search-message-ids]',
  messageText: '.whitespace-pre-wrap, .markdown',
  messageAttachments: '[data-testid="file-upload"], img[alt]',
  download:
    'button[aria-label="Download"], button[aria-label="다운로드"], button[aria-label="Download image"], button[aria-label="이미지 다운로드"]',
};
export const displayText = (value: string) => value.replace(/\r\n/g, '\n');

function pageElements(selector: string, root: any = (globalThis as any).document): any[] {
  return [...root.querySelectorAll(selector)].filter((element: any) => {
    // File inputs are intentionally hidden; their owning page container must be live.
    const target = element.matches('input[type="file"]') ? element.parentElement : element;
    return !!target && target.checkVisibility({ checkVisibilityCSS: true });
  });
}

function readMessageId(element: any): string {
  const legacy = element.getAttribute('data-message-id') || element.getAttribute('data-turn-id');
  if (legacy) return legacy;
  const identities = [
    ...new Set<string>(
      (element.getAttribute('data-chatgpt-search-message-ids') || '').split(/\s+/).filter(Boolean),
    ),
  ];
  return identities.length === 1 && /^[a-f0-9-]{36}$/i.test(identities[0]!) ? identities[0]! : '';
}

// The public image UI has both a dialog viewer and a full-screen viewer.
// Bind either one to the selected response image before invoking its Save UI.
function readImageViewer(source: string): any {
  const doc = (globalThis as any).document;
  const q = (selector: string, root: any = doc): any[] =>
    [...root.querySelectorAll(selector)].filter((e: any) =>
      e.checkVisibility({ checkVisibilityCSS: true }),
    );
  const dialogs = q('[role="dialog"]');
  if (dialogs.length) {
    if (dialogs.length !== 1) return null;
    const root = dialogs[0];
    const images = q('img[alt]:not([alt=""])', root);
    const saves = q('button[aria-label="저장"],button[aria-label="Save"]', root);
    if (images.length !== 1 || images[0].src !== source || saves.length !== 1) return null;
    return { root, image: images[0], save: saves[0] };
  }
  const images = q('img[class*="ZoomableImage-"]');
  if (images.length !== 1 || images[0].src !== source) return null;
  for (let root = images[0].parentElement; root; root = root.parentElement) {
    const closes = q('button[aria-label="뷰어 닫기"],button[aria-label="Close viewer"]', root);
    const saves = q('button[aria-label="다운로드"],button[aria-label="Download"]', root);
    if (closes.length === 1 && saves.length === 1)
      return { root, image: images[0], save: saves[0], close: closes[0] };
  }
  return null;
}

function readComposerText(editor: any): string {
  if (!editor) return '';
  if ('value' in editor) return editor.value;
  const plain = (node: any): string =>
    node.nodeType === 3
      ? node.nodeValue
      : [...node.childNodes]
          .map((child: any) => (child.nodeName === 'BR' ? '\n' : plain(child)))
          .join('');
  return [...editor.childNodes]
    .map((node: any) => (node.nodeName === 'P' && node.textContent === '' ? '' : plain(node)))
    .join([...editor.children].some((node: any) => node.nodeName === 'P') ? '\n' : '');
}

export class PageAdapter {
  private attachmentNames = new Map<string, string>();
  readonly version = 'm2-ui-0.4';
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
    const snapshot = await this.cdp.evaluate<Snapshot & { attachment_keys: string[] }>(`(() => {
      const s = ${JSON.stringify(this.selectors)};
      const q = ${pageElements.toString()};
      const name = e => e.getAttribute('data-filename') || e.getAttribute('title') ||
        (/(?:제거|[Rr]emove)[^:]*: (.+)$/.exec(e.getAttribute('aria-label') || '') || [])[1] ||
        e.parentElement?.querySelector('img[alt]')?.getAttribute('alt') || e.getAttribute('alt') || e.textContent;
      const editors = q(s.composer);
      const editor = editors[0];
      const editorText = (${readComposerText.toString()})(editor);
      const alerts=q('[role="alert"]').map(e=>e.innerText).join(' ');
      const isUser=e=>e.getAttribute('data-message-author-role')==='user' || e.getAttribute('data-turn')==='user' ||
        e.classList.contains('group/user-message') || /:user$/.test(e.getAttribute('data-chatgpt-search-unit-key') || '');
      const textReady=e=>{
        if(!e.hasAttribute('data-chatgpt-search-message-ids') || isUser(e))return false;
        for(let parent=e.parentElement,depth=0;parent && depth<4;parent=parent.parentElement,depth++) {
          const responses=q(s.messages,parent).filter(x=>!isUser(x));
          if(responses.length!==1 || responses[0]!==e)return false;
          if(q('button[aria-label="복사"],button[aria-label="Copy"]',parent).length===1)return true;
        }
        return false;
      };
      const messages=q(s.messages);
      const latestMessage=messages.at(-1);
      const refusal=latestMessage && textReady(latestMessage) &&
        /프롬프트[\\s\\S]*(나체|성적|성애적)[\\s\\S]*방지 조치[\\s\\S]*위반|prompt[\\s\\S]*(safeguards|guardrails)[\\s\\S]*(nudity|sexual|erotic)|prompt[\\s\\S]*(nudity|sexual|erotic)[\\s\\S]*(safeguards|guardrails)/i.test(latestMessage.innerText);
      const failedCards=q('div,p,span,h1,h2,h3,h4,h5,h6').filter(e=>
        /^(이미지 생성에 실패했습니다|Image generation failed)[.!]?$/i.test(e.textContent.trim()) &&
        !e.closest('[data-message-author-role="user"],[data-turn="user"],[data-chatgpt-search-unit-key$=":user"],[class~="group/user-message"]') && !e.closest(s.composer));
      const explicitFailure=failedCards.some(e=>{
        const message=e.closest(s.messages);
        if(message)return message===latestMessage;
        for(let parent=e.parentElement, depth=0;parent && parent!==document.body && depth<8;parent=parent.parentElement,depth++)
          if(q('button',parent).some(b=>/^(다시 시도|Try again|Retry)$/i.test(b.textContent.trim())))return true;
        return false;
      });
      const generated = 'img[alt^="생성된 이미지"],img[alt^="Generated image"]';
      const galleryReady = e => q('[data-testid="generated-image-preview"]',e).length > 0 &&
        q(generated,e).length > 0 && q(generated,e).every(i=>i.complete && i.naturalWidth>0) &&
        q('button[aria-label]',e).some(b=>/^(생성된 이미지 \\d+ 편집|Edit generated image \\d+)$/i.test(b.getAttribute('aria-label'))) &&
        q('button[aria-label]',e).some(b=>/^(생성된 이미지 \\d+ 공유|Share generated image \\d+)$/i.test(b.getAttribute('aria-label')));
      return {
        serviceError: /rate limit|image generation limit|한도에 도달|생성 한도/i.test(alerts) ? 'RATE_LIMITED' :
          explicitFailure || refusal || /generation rejected|could not generate|image generation failed|이미지 생성에 실패|이미지를 생성할 수 없/i.test(alerts) ? 'GENERATION_REJECTED' : undefined,
        url: location.href, composer: editors.length,
        prompt: editorText,
        attachments: q(s.attachments).map(name), uploading: q(s.uploading).length > 0,
        attachment_keys: q(s.attachments).map(e => e.parentElement?.querySelector('img')?.getAttribute('src') || ''),
        busy: q(s.busy).length > 0, send: q(s.send).filter(e => !e.disabled && e.getAttribute('aria-disabled') !== 'true').length,
        login: !!document.querySelector('[data-testid="login-button"], a[href="/auth/login"]') ||
          /auth\\.openai\\.com/.test(location.hostname) ||
          q('button,a').some(e => /^(Log in|로그인)$/.test(e.textContent.trim())),
        challenge: !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-running'),
        messages: messages.map((e, i) => ({
          id: (${readMessageId.toString()})(e),
          role: e.getAttribute('data-message-author-role') || e.getAttribute('data-turn') ||
            (isUser(e) ? 'user' :
              e.querySelector('[data-testid="generated-image-gallery"]') || e.querySelector('[data-testid="generated-image-preview"]') || textReady(e) ? 'assistant' : ''),
          text: q(s.messageText, e).map(x => x.innerText).join('\\n') || (textReady(e) ? e.innerText : ''),
          attachments: q(s.messageAttachments, e).map(name),
          attachmentNamesHidden: e.hasAttribute('data-chatgpt-search-message-ids') && q(s.messageAttachments,e).length > 0 &&
            q(s.messageAttachments,e).every(x=>/^(사용자 첨부 파일|User-uploaded file)$/i.test(name(x))),
          downloads: q(s.download, e).length, images: q('img', e).length,
          completed: q('[data-testid="copy-turn-action-button"],[data-response-complete="true"]',e).length > 0 || galleryReady(e) || textReady(e),
          outputCount: q('img[alt^="생성된 이미지"],img[alt^="Generated image"]',e).length || q(s.download,e).length,
          outputReady: q('img[alt^="생성된 이미지"],img[alt^="Generated image"]',e).length > 0 &&
            q('img[alt^="생성된 이미지"],img[alt^="Generated image"]',e).every(i=>i.complete && i.naturalWidth>0) &&
            (q('[data-testid="copy-turn-action-button"]',e).length === 1 || galleryReady(e)),
        })),
      };
    })()`);
    snapshot.attachments = snapshot.attachments.map(
      (name, index) => this.attachmentNames.get(snapshot.attachment_keys[index] ?? '') ?? name,
    );
    const { attachment_keys: _keys, ...result } = snapshot;
    return result;
  }

  private attachmentKeys() {
    return this.cdp.evaluate<string[]>(
      `(${pageElements.toString()})(${JSON.stringify(this.selectors.attachments)}).map(e => e.parentElement?.querySelector('img')?.getAttribute('src') || '')`,
    );
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
      await until(
        () =>
          this.cdp.evaluate<number>(
            `(${pageElements.toString()})(${JSON.stringify(this.selectors.file)}).length`,
          ),
        (count) => count === 1,
        30000,
      );
      const previousKeys = await this.attachmentKeys();
      const receivedNames = await this.cdp.files(this.selectors.file, [paths[i]!]);
      if (JSON.stringify(receivedNames) !== JSON.stringify([names[i]!]))
        throw Error('PROMPT_OR_ATTACHMENTS_CHANGED');
      // Bind only a single new, stable preview after a verified one-file assignment.
      // Existing previews must retain their order; ambiguous evidence stops submission.
      const uploaded = await until(
        async () => ({ snapshot: await this.snapshot(), keys: await this.attachmentKeys() }),
        ({ snapshot, keys }) => !snapshot.uploading && keys.length === i + 1,
        120_000,
      );
      if (JSON.stringify(uploaded.snapshot.attachments) !== JSON.stringify(names.slice(0, i + 1))) {
        if (
          JSON.stringify(uploaded.keys.slice(0, i)) !== JSON.stringify(previousKeys) ||
          !uploaded.keys[i] ||
          uploaded.keys.slice(0, i).includes(uploaded.keys[i]!)
        )
          throw Error('PROMPT_OR_ATTACHMENTS_CHANGED');
        this.attachmentNames.set(uploaded.keys[i]!, names[i]!);
      }
      if (process.argv.includes('--diagnostics')) {
        await until(
          () => this.snapshot(),
          (snapshot) => !snapshot.uploading && snapshot.attachments.length === i + 1,
          30000,
        );
        const evidence = await this.cdp.evaluate(`(() => {
          const name = ${JSON.stringify(names[i])};
          return {
            body_has_name: document.body.innerText.includes(name),
            title_matches: [...document.querySelectorAll('[title]')].filter(e => e.getAttribute('title') === name).length,
            alt_matches: [...document.querySelectorAll('img[alt]')].filter(e => e.getAttribute('alt') === name).length,
            aria_contains_name: [...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label').includes(name)).length
          };
        })()`);
        console.error('ATTACHMENT_EVIDENCE', evidence);
      }
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
      const nodes = (${pageElements.toString()})(${JSON.stringify(this.selectors.composer)});
      if (nodes.length !== 1) throw Error();
      nodes[0].focus();
    })()`);
    if (!before.prompt) await this.cdp.send('Input.insertText', { text: prompt });
    const snapshot = await until(
      () => this.snapshot(),
      (value) =>
        displayText(value.prompt) === displayText(prompt) &&
        !value.uploading &&
        JSON.stringify(value.attachments) === JSON.stringify(names) &&
        value.send === 1,
      30000,
    ).catch(async (error) => {
      if (process.argv.includes('--diagnostics')) {
        const observed = await this.snapshot();
        console.error('COMPOSER_EVIDENCE', {
          prompt_equal: displayText(observed.prompt) === displayText(prompt),
          attachments_equal: JSON.stringify(observed.attachments) === JSON.stringify(names),
          send_count: observed.send,
          uploading: observed.uploading,
        });
      }
      throw error;
    });
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
      const q = ${pageElements.toString()};
      const editor = q(s.composer)[0];
      const value = (${readComposerText.toString()})(editor);
      const bindings = ${JSON.stringify(Object.fromEntries(this.attachmentNames))};
      const names = q(s.attachments).map(e => e.getAttribute('data-filename') || e.getAttribute('title') ||
        bindings[e.parentElement?.querySelector('img')?.getAttribute('src') || ''] ||
        (/(?:제거|[Rr]emove)[^:]*: (.+)$/.exec(e.getAttribute('aria-label') || '') || [])[1] ||
        e.parentElement?.querySelector('img[alt]')?.getAttribute('alt') || e.getAttribute('alt') || e.textContent);
      const ids = q(s.messages).map(e => (${readMessageId.toString()})(e));
      const buttons = q(s.send);
      if (location.href !== expected.url || value !== expected.prompt || JSON.stringify(names) !== JSON.stringify(expected.attachments) ||
          JSON.stringify(ids) !== JSON.stringify(expected.messages.map(m => m.id)) || q(s.uploading).length || q(s.busy).length ||
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
    // The new public UI hides uploaded filenames after sending. In that case only
    // the durable, ordered preflight manifest can bind its generic thumbnails.
    const verifiedHiddenNames =
      message.attachmentNamesHidden === true &&
      message.attachments.length === names.length &&
      names.length > 0 &&
      displayText(baseline.prompt) === displayText(prompt) &&
      JSON.stringify(baseline.attachments) === JSON.stringify(names) &&
      !baseline.uploading &&
      baseline.send === 1 &&
      !snapshot.prompt &&
      snapshot.attachments.length === 0;
    if (
      message.id &&
      displayText(message.text) === displayText(prompt) &&
      (JSON.stringify(message.attachments) === JSON.stringify(names) || verifiedHiddenNames)
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
          const nodes=(${pageElements.toString()})(${JSON.stringify(this.selectors.messages)}).filter(e=>(${readMessageId.toString()})(e)===${JSON.stringify(response.id)});
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
      await this.cdp.load(url);
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
      const messages = (${pageElements.toString()})(${JSON.stringify(this.selectors.messages)})
        .filter(e => (${readMessageId.toString()})(e) === ${JSON.stringify(messageId)});
      if (messages.length !== 1) throw Error();
      const buttons = messages[0].querySelectorAll(${JSON.stringify(this.selectors.download)});
      if (buttons.length === 0) {
        const images = messages[0].querySelectorAll('img[alt^="생성된 이미지"],img[alt^="Generated image"]');
        const selected=images[${ordinal}];
        if (!selected || !selected.complete || images.length>4) throw Error();
        const opener = selected.closest('button[data-testid="generated-image-preview"], [role="button"]');
        if (!opener) throw Error();
        const viewer = (${readImageViewer.toString()})(selected.src);
        if(!viewer && (${pageElements.toString()})('[role="dialog"], img[class*="ZoomableImage-"]').length) throw Error();
        if(!viewer) opener.click(); return null;
      }
      if (!buttons[${ordinal}] || buttons.length>4) throw Error();
      const link = buttons[${ordinal}].closest('a[href]');
      return link ? link.href : null;
    })()`);
    if (!target) {
      const source = await until(
        () =>
          this.cdp.evaluate<string | null>(`(() => {
        const message = (${pageElements.toString()})(${JSON.stringify(this.selectors.messages)}).find(e=>(${readMessageId.toString()})(e)===${JSON.stringify(messageId)});
        const original = message?.querySelectorAll('img[alt^="생성된 이미지"],img[alt^="Generated image"]')[${ordinal}];
        if (!original) return null;
        const viewer=(${readImageViewer.toString()})(original.src);
        return viewer?.image.complete && viewer.image.naturalWidth > 0 ? original.src : null;
      })()`),
        (value) => !!value,
        10000,
      );
      // Capture the download anchor emitted by the public Save UI. Do not fetch an
      // image source, call private APIs, or substitute the displayed thumbnail.
      await this.cdp.evaluate(`(() => {
        const source=${JSON.stringify(source)};
        const viewer=(${readImageViewer.toString()})(source);
        if (!viewer || !viewer.image.complete || window.__webImageBridgeCapture) throw Error();
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
        viewer.save.click();
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
        const viewer=(${readImageViewer.toString()})(${JSON.stringify(source)});
        if(!capture || capture.ambiguous || capture.url!==${JSON.stringify(expectedTarget)} || !viewer) throw Error();
        capture.restore(); capture.originalClick.call(capture.anchor);
        setTimeout(()=>capture.deferred.forEach(u=>capture.originalRevoke.call(URL,u)),1000);
        delete window.__webImageBridgeCapture;
      })()`);
      this.capturedDownload = undefined;
      return;
    }
    // Scope to the confirmed assistant response; never click a preceding image's button.
    await this.cdp.evaluate(`(() => {
      const messages = (${pageElements.toString()})(${JSON.stringify(this.selectors.messages)})
        .filter(e => (${readMessageId.toString()})(e) === ${JSON.stringify(messageId)});
      if (messages.length !== 1) throw Error();
      const buttons = messages[0].querySelectorAll(${JSON.stringify(this.selectors.download)});
      if (!buttons[${ordinal}] || buttons[${ordinal}].disabled || buttons.length>4) throw Error();
      buttons[${ordinal}].click();
    })()`);
  }

  async dismissViewer(messageId: string, ordinal = 0) {
    this.guard();
    await this.cdp.evaluate(`(() => {
      if(!(${pageElements.toString()})('[role="dialog"], img[class*="ZoomableImage-"]').length)return;
      const message=(${pageElements.toString()})(${JSON.stringify(this.selectors.messages)}).find(e=>(${readMessageId.toString()})(e)===${JSON.stringify(messageId)});
      const original=message?.querySelectorAll('img[alt^="생성된 이미지"],img[alt^="Generated image"]')[${ordinal}];
      const viewer=original && (${readImageViewer.toString()})(original.src);
      if(!viewer)throw Error();
      if(viewer.close){viewer.close.click();return;}
      const close=viewer.root.querySelectorAll('button[aria-label="전체 화면 닫기"],button[aria-label="Close full screen"],button[aria-label="Close fullscreen"],button[aria-label="Close"],button[aria-label="닫기"]');
      if(close.length!==1)throw Error();close[0].click();
    })()`);
    await until(
      () =>
        this.cdp.evaluate<number>(
          `(${pageElements.toString()})('[role="dialog"], img[class*="ZoomableImage-"]').length`,
        ),
      (count) => count === 0,
      2000,
    );
  }
}
