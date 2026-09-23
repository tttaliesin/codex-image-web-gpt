import path from 'node:path';
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
        await durableJson(path.join(options.profile, 'page-probe.json'), {
          at: new Date().toISOString(),
          ...pageDiagnostics(snapshot),
        });
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
