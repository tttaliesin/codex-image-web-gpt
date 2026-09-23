import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { Cdp } from '../../packages/browser/src/cdp';
import {
  PageAdapter,
  fixtureSelectors,
  type Message,
  type Snapshot,
} from '../../packages/browser/src/adapter';
import { BrowserExecution } from '../../packages/browser/src/execution';
import type { DownloadCollector } from '../../packages/browser/src/download';
import { BridgeService } from '../../packages/core/src/service';

const conversation = 'https://chatgpt.com/c/fixture-thread';
const message = (id: string, role: string): Message => ({
  id,
  role,
  text: '',
  attachments: [],
  downloads: 0,
  images: 0,
});

// Runs a follow-up of a succeeded parent whose response is `r1` on a page showing `messages`.
async function followUp(messages: Message[]) {
  await mkdir('.local/tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('.local/tests/followup-'));
  const contents = { url: conversation, getURL: () => contents.url, loadURL: async () => {} };
  const cdp = new Cdp(contents as unknown as WebContents);
  cdp.connect = () => {};
  cdp.evaluate = async () => {
    throw Error('UI_CHANGED');
  };
  const adapter = new PageAdapter(cdp, fixtureSelectors);
  const page: Snapshot = {
    url: conversation,
    composer: 1,
    prompt: '',
    attachments: [],
    uploading: false,
    busy: false,
    send: 0,
    messages,
    login: false,
    challenge: false,
  };
  adapter.snapshot = async () => page;
  // Stop right after the follow-up checks: this test is only about whether they pass.
  adapter.attach = async () => {
    throw Error('STOP_AFTER_FOLLOWUP_CHECKS');
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
    const session = randomUUID(),
      parent = randomUUID(),
      at = new Date().toISOString();
    service.db.insert('sessions', session, {
      session_id: session,
      profile_id: service.profileId,
      conversation_url: conversation,
      control_owner: 'automation',
      revision: 1,
      window_visible: false,
      active_job_id: null,
    });
    service.db.insert('jobs', parent, {
      snapshot: {
        job_id: parent,
        request_id: randomUUID(),
        session_id: session,
        mode: 'generate',
        state: 'succeeded',
        phase: 'complete',
        submission_state: 'confirmed',
        revision: 5,
        terminal: true,
        requires_action: false,
        remote_may_continue: false,
        artifact_ids: [randomUUID()],
        warnings: [],
        error: null,
        created_at: at,
        updated_at: at,
      },
      request: { request_id: randomUUID(), mode: 'generate', prompt: 'parent', inputs: [] },
      inputs: [],
      digest: 'fixture',
      browser_state: { conversation_url: conversation, response_id: 'r1' },
    });
    const submitted = await service.call('web_image_submit', {
      request_id: randomUUID(),
      mode: 'generate',
      prompt: 'follow-up fixture',
      session_id: session,
      parent_job_id: parent,
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await service.engine.idle();
    const id = (submitted.data as { job: { job_id: string } }).job.job_id;
    return { job: service.engine.job(id).snapshot, active: service.engine.active() };
  } finally {
    await service.close();
  }
}

test('a follow-up whose conversation moved on fails unsent and releases the queue', async () => {
  const { job, active } = await followUp([
    message('u1', 'user'),
    message('r1', 'assistant'),
    message('u2', 'user'),
  ]);
  assert.equal(job.state, 'failed');
  assert.equal(job.submission_state, 'not_sent');
  assert.equal(job.remote_may_continue, false);
  assert.equal(job.error?.code, 'STATE_CONFLICT');
  assert.equal(job.error?.next_action, 'fix_input');
  assert.match(job.error!.message, /newer messages after the parent result/);
  assert.equal(active, undefined);
});

test('a follow-up whose parent result is still last passes the conversation check', async () => {
  const { job } = await followUp([message('u1', 'user'), message('r1', 'assistant')]);
  assert.equal(job.phase, 'attach');
  assert.equal(job.state, 'waiting_user');
  assert.notEqual(job.error?.next_action, 'fix_input');
});
