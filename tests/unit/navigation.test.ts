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
