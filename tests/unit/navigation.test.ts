import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { Cdp } from '../../packages/browser/src/cdp';
import { PageAdapter, fixtureSelectors, type Snapshot } from '../../packages/browser/src/adapter';
import { BrowserExecution } from '../../packages/browser/src/execution';
import type { DownloadCollector } from '../../packages/browser/src/download';
import { BridgeService } from '../../packages/core/src/service';
import type { ExecutionContext } from '../../packages/core/src/engine';
import type { SubmissionAttempt } from '../../packages/core/src/model';

// Electron rejects loadURL with an Error carrying the net error name as `code`.
const netError = (code: string) => Object.assign(Error(`${code} loading`), { code });
function page(load: (url: string) => Promise<void>) {
  const contents = { url: 'about:blank', getURL: () => contents.url, loadURL: load };
  return contents;
}

test('page load tolerates a superseded navigation and names real load failures', async () => {
  const aborted = page(async () => {
    throw netError('ERR_ABORTED');
  });
  await new Cdp(aborted as unknown as WebContents).load('https://chatgpt.com/');
  const offline = page(async () => {
    throw netError('ERR_INTERNET_DISCONNECTED');
  });
  await assert.rejects(
    new Cdp(offline as unknown as WebContents).load('https://chatgpt.com/'),
    /^Error: PAGE_LOAD_FAILED$/,
  );
});

async function run(load: (contents: { url: string }, url: string) => Promise<void>) {
  await mkdir('.local/tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('.local/tests/navigation-'));
  const contents = page(async (url) => load(contents, url));
  const cdp = new Cdp(contents as unknown as WebContents);
  cdp.connect = () => {};
  cdp.evaluate = async () => {
    throw Error('UI_CHANGED');
  };
  const adapter = new PageAdapter(cdp, fixtureSelectors);
  const ready: Snapshot = {
    url: 'https://chatgpt.com/',
    composer: 1,
    prompt: '',
    attachments: [],
    uploading: false,
    busy: false,
    send: 0,
    messages: [],
    login: false,
    challenge: false,
  };
  adapter.snapshot = async () => ({ ...ready, url: contents.url });
  // Stop right after navigation: this test is only about reaching the page.
  adapter.attach = async () => {
    throw Error('STOP_AFTER_NAVIGATION');
  };
  const execution = new BrowserExecution(adapter, {} as DownloadCollector, {
    directory,
    busy: () => {},
    attention: () => {},
    hidden: () => true,
    readyTimeout: 2000,
  });
  const service = new BridgeService({
    directory,
    inputRoots: [],
    exportRoots: [],
    port: execution,
  });
  await service.ready;
  try {
    const submitted = await service.call('web_image_submit', {
      request_id: randomUUID(),
      mode: 'generate',
      prompt: 'navigation fixture',
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await service.engine.idle();
    const job = (submitted.data as { job: { job_id: string } }).job;
    return service.engine.job(job.job_id).snapshot;
  } finally {
    await service.close();
  }
}

test('execution continues after a redirected load and reports an offline load as resumable', async () => {
  const redirected = await run(async (contents, url) => {
    contents.url = url;
    throw netError('ERR_ABORTED');
  });
  assert.equal(redirected.state, 'waiting_user');
  assert.equal(redirected.phase, 'attach');
  assert.equal(redirected.submission_state, 'not_sent');

  const offline = await run(async () => {
    throw netError('ERR_INTERNET_DISCONNECTED');
  });
  assert.equal(offline.state, 'waiting_user');
  assert.equal(offline.phase, 'prepare');
  assert.equal(offline.submission_state, 'not_sent');
  assert.equal(offline.error?.code, 'ADAPTER_UNAVAILABLE');
  assert.equal(offline.error?.retryable, true);
  assert.equal(offline.error?.next_action, 'resume');
});

test('unknown submission recovers only the matching already-open conversation without sending', async () => {
  await mkdir('.local/tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('.local/tests/open-reconcile-'));
  const service = new BridgeService({ directory, inputRoots: [], exportRoots: [] });
  await service.ready;
  try {
    const submitted = await service.call('web_image_submit', {
      request_id: randomUUID(),
      mode: 'generate',
      prompt: 'exact fixture',
    });
    assert.equal(submitted.ok, true);
    const id = (submitted.data as { job: { job_id: string } }).job.job_id;
    const baseline: Snapshot = {
      url: 'https://chatgpt.com/',
      composer: 1,
      prompt: 'exact fixture',
      attachments: [],
      uploading: false,
      busy: false,
      send: 1,
      messages: [],
      login: false,
      challenge: false,
    };
    for (const matches of [true, false]) {
      const record = service.engine.job(id);
      record.snapshot.submission_state = 'unknown';
      const current: Snapshot = {
        ...baseline,
        url: 'https://chatgpt.com/c/existing',
        prompt: '',
        send: 0,
        messages: [
          {
            id: 'existing-user',
            role: 'user',
            text: matches ? baseline.prompt : 'different',
            attachments: [],
            downloads: 0,
            images: 0,
          },
        ],
      };
      const contents = page(async () => {
        throw Error('unexpected navigation');
      });
      contents.url = current.url;
      const cdp = new Cdp(contents as unknown as WebContents);
      cdp.connect = () => {};
      const adapter = new PageAdapter(cdp, fixtureSelectors);
      adapter.snapshot = async () => current;
      adapter.generation = async () => {
        throw Error('RATE_LIMITED');
      };
      let confirmed = 0;
      const checkpoints: unknown[] = [];
      const context: ExecutionContext = {
        job: () => record,
        session: () => service.engine.session(record.snapshot.session_id),
        parent: () => undefined,
        check: () => {},
        attempt: () => ({ baseline }) as SubmissionAttempt,
        checkpoint: async (value) => {
          checkpoints.push(structuredClone(value));
        },
        beforeSend: async () => {
          throw Error('must never send');
        },
        confirm: async (evidence) => {
          assert.equal(evidence.message_id, 'existing-user');
          confirmed++;
          record.snapshot.submission_state = 'confirmed';
        },
        phase: async () => {},
        complete: async () => {
          throw Error('unexpected completion');
        },
        fail: async () => {
          throw Error('unexpected final failure');
        },
        waitForUser: async () => {},
      };
      const execution = new BrowserExecution(adapter, {} as DownloadCollector, {
        directory,
        busy: () => {},
        attention: () => {},
        hidden: () => true,
      });
      if (matches) {
        await execution.run(context, true);
        assert.equal(confirmed, 1);
        assert.deepEqual(checkpoints[0], { conversation_url: current.url });
      } else {
        await assert.rejects(execution.run(context, true), /SUBMISSION_UNKNOWN/);
        assert.equal(confirmed, 0);
        assert.equal(checkpoints.length, 0);
      }
    }
  } finally {
    await service.close();
  }
});
