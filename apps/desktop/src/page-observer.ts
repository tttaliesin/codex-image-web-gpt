import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Cdp } from '../../../packages/browser/src/cdp';
import type { PageAdapter, Snapshot } from '../../../packages/browser/src/adapter';
import type { BrowserExecution } from '../../../packages/browser/src/execution';
import { durableJson } from '../../../packages/storage/src/files';
import type { Operations } from './operations';

export type PageStatus = 'loading' | 'ready' | 'login' | 'challenge' | 'unavailable';

export function pageStatus(snapshot: Snapshot | null): PageStatus {
  if (!snapshot) return 'unavailable';
  if (snapshot.challenge) return 'challenge';
  if (snapshot.login) return 'login';
  return snapshot.composer === 1 ? 'ready' : 'unavailable';
}

// Diagnostics contain counts and fixed enums only. Prompts, attachment names,
// page labels, message IDs, conversation paths and response text stay out.
export function pageDiagnostics(snapshot: Snapshot) {
  return {
    origin: new URL(snapshot.url).origin,
    composer: snapshot.composer,
    login: snapshot.login,
    challenge: snapshot.challenge,
    service_error: snapshot.serviceError ?? null,
    busy: snapshot.busy,
    uploading: snapshot.uploading,
    attachment_count: snapshot.attachments.length,
    messages: snapshot.messages.map((message) => ({
      role: ['user', 'assistant'].includes(message.role) ? message.role : 'other',
      images: message.images,
      downloads: message.downloads,
      completed: message.completed,
      output_ready: message.outputReady,
      output_count: message.outputCount,
    })),
  };
}

interface ObserverOptions {
  adapter: PageAdapter;
  cdp: Cdp;
  profile: string;
  diagnostics: boolean;
  captureDiagnostic?: () => Promise<Buffer>;
  execution?: BrowserExecution;
  operations?: Operations;
  busy: () => boolean;
  phase: () => string;
  status: (phase: string) => void;
  pageStatus: (status: PageStatus) => void;
  refreshTray: () => void;
}

export async function observePage(options: ObserverOptions) {
  let inspecting = false;
  let stopped = false;
  const inspect = async () => {
    if (stopped || inspecting) return;
    inspecting = true;
    try {
      const snapshot = await options.adapter.snapshot();
      if (stopped) return;
      options.pageStatus(pageStatus(snapshot));
      const operations = options.operations;
      if (operations) {
        const online = await options.cdp.evaluate<boolean>('navigator.onLine');
        if (!online && operations.service.engine.suspended !== 'NETWORK_OFFLINE') {
          await operations.suspend('NETWORK_OFFLINE');
        } else if (online && operations.service.engine.suspended === 'NETWORK_OFFLINE') {
          await operations.resume('NETWORK_OFFLINE');
        }
        options.refreshTray();
        operations.recheckRemote();
        await operations.checkDrain();
      }
      options.execution?.observePage(snapshot);
      const active = operations?.service.engine.active()?.snapshot;
      if (!options.busy() && active?.requires_action) {
        options.status(active.error?.code ?? active.state);
      } else if (
        !options.busy() &&
        [
          'ready',
          'AUTH_REQUIRED',
          'HUMAN_CHECK_REQUIRED',
          'UI_CHANGED',
          'PAGE_LOAD_FAILED',
        ].includes(options.phase())
      ) {
        options.status(
          snapshot.challenge
            ? 'HUMAN_CHECK_REQUIRED'
            : snapshot.login
              ? 'AUTH_REQUIRED'
              : snapshot.composer === 1
                ? 'ready'
                : 'UI_CHANGED',
        );
      }
      if (options.diagnostics) {
        const structure = await options.cdp.evaluate(`(() => ({
          ready_state: document.readyState,
          textarea_count: document.querySelectorAll('textarea').length,
          submit_button_count: document.querySelectorAll('form button[type="submit"]').length,
          enabled_submit_button_count: [...document.querySelectorAll('form button[type="submit"]')].filter(e => !e.disabled && e.getAttribute('aria-disabled') !== 'true').length,
          file_input_count: document.querySelectorAll('input[type="file"]').length,
          image_file_input_count: document.querySelectorAll('input[type="file"][accept*="image"]').length,
          file_inputs: [...document.querySelectorAll('input[type="file"]')].map(e => ({
            accepts_images: /image/.test(e.getAttribute('accept') ?? ''),
            image_only: e.getAttribute('accept') === 'image/*',
            capture: e.hasAttribute('capture'),
            multiple: e.hasAttribute('multiple')
          })),
          upload_photos_count: document.querySelectorAll('#upload-photos').length,
          upload_files_count: document.querySelectorAll('#upload-files').length,
          remove_controls: [...document.querySelectorAll('button[aria-label]')]
            .filter(e => /remove|제거/i.test(e.getAttribute('aria-label') ?? ''))
            .map(e => ({
              in_form: !!e.closest('form'),
              korean_file: /^파일 /.test(e.getAttribute('aria-label') ?? ''),
              english_file: /^Remove file/i.test(e.getAttribute('aria-label') ?? ''),
              english_image: /^Remove image/i.test(e.getAttribute('aria-label') ?? ''),
              has_colon: (e.getAttribute('aria-label') ?? '').includes(': '),
              parent_has_image: !!e.parentElement?.querySelector('img[alt]'),
              has_title: !!e.getAttribute('title')
            })),
          editable_count: document.querySelectorAll('[contenteditable="true"]').length,
          textbox_editable_count: document.querySelectorAll('[contenteditable="true"][role="textbox"]').length,
          prose_mirror_count: document.querySelectorAll('[contenteditable="true"].ProseMirror').length,
          body_present: !!document.body,
          body_text_length: document.body?.innerText.length ?? 0,
          script_count: document.scripts.length,
          frame_count: document.querySelectorAll('iframe').length
        }))()`);
        await durableJson(path.join(options.profile, 'page-probe.json'), {
          at: new Date().toISOString(),
          ...pageDiagnostics(snapshot),
          structure,
        });
        if (options.captureDiagnostic) {
          const directory = path.join(options.profile, 'diagnostics');
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, 'page.png'), await options.captureDiagnostic());
          const identity = await options.cdp.evaluate(`(() => ({
            url: location.href,
            visible_controls: [...document.querySelectorAll('button,[role="button"]')].filter(e=>e.getClientRects().length>0).map(e=>({tag:e.tagName,label:e.getAttribute('aria-label'),testid:e.getAttribute('data-testid'),class:e.className,ancestors:(()=>{const list=[];for(let x=e.parentElement,i=0;x&&i<3;x=x.parentElement,i++)list.push({tag:x.tagName,class:x.className,attributes:[...x.attributes].map(a=>a.name)});return list;})()})),
            image_ancestors: [...document.querySelectorAll('img')].map(e => {
              const list=[]; for(let node=e, i=0; node && i<10; node=node.parentElement, i++) {
                list.push({tag:node.tagName, class:node.className, attributes:[...node.attributes].map(a=>a.name),testid:node.getAttribute('data-testid'),role:node.getAttribute('role')});
              } return list;
            }),
            nodes: [...document.querySelectorAll('article, [data-message-author-role], [data-testid^="conversation-turn-"], [data-chatgpt-search-message-ids]')].map(e => ({
              tag: e.tagName,
              class: e.className,
              search_ids: e.getAttribute('data-chatgpt-search-message-ids'),
              search_key: e.getAttribute('data-chatgpt-search-unit-key'),
              role: e.getAttribute('data-message-author-role') || e.getAttribute('data-turn'),
              has_message_id: e.hasAttribute('data-message-id'),
              has_turn_id: e.hasAttribute('data-turn-id'),
              child_roles: [...e.querySelectorAll('[data-message-author-role]')].map(x=>x.getAttribute('data-message-author-role')),
              markdown_count: e.querySelectorAll('.markdown').length,
              text_count: e.querySelectorAll('.whitespace-pre-wrap').length,
              image_count: e.querySelectorAll('img').length,
              copy_count: e.querySelectorAll('[data-testid="copy-turn-action-button"]').length,
              download_count: e.querySelectorAll('button[aria-label*="다운로드"], button[aria-label*="Download"]').length,
              content_nodes: [...e.querySelectorAll('div,p,span')].filter(x=>[...x.childNodes].some(n=>n.nodeType===3 && n.textContent.trim())).map(x=>({tag:x.tagName,class:x.className,attributes:[...x.attributes].map(a=>a.name)})),
              images: [...e.querySelectorAll('img')].map(x=>({alt:x.alt,testid:x.parentElement?.getAttribute('data-testid'),opener_label:x.parentElement?.getAttribute('aria-label')})),
              controls: [...e.querySelectorAll('button')].map(x=>({label:x.getAttribute('aria-label'),testid:x.getAttribute('data-testid')})),
              ancestors: (()=>{const list=[];for(let x=e.parentElement,i=0;x&&i<4;x=x.parentElement,i++)list.push({tag:x.tagName,class:x.className,attributes:[...x.attributes].map(a=>a.name)});return list;})()
            }))
          }))()`);
          await durableJson(path.join(directory, 'structure.json'), identity);
        }
      }
    } catch {
      if (!stopped) options.pageStatus('unavailable');
    } finally {
      inspecting = false;
    }
  };
  await inspect();
  const timer = setInterval(() => {
    void inspect();
  }, 5000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
