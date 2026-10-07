import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { ProbeRunner, type ProbeRecord } from '../../apps/desktop/src/probe';
import { PageAdapter, fixtureSelectors, type Snapshot } from '../../packages/browser/src/adapter';
import type { Cdp } from '../../packages/browser/src/cdp';
import type { DownloadCollector } from '../../packages/browser/src/download';
import { durableJson, readJson } from '../../packages/storage/src/files';

test('hidden filenames require an exact ordered preflight manifest and unique submission', () => {
  const adapter = new PageAdapter({} as Cdp, fixtureSelectors);
  const baseline: Snapshot = {
    url: 'https://chatgpt.com/',
    composer: 1,
    prompt: 'exact\n\nprompt',
    attachments: ['first.png', 'second.png'],
    uploading: false,
    busy: false,
    send: 1,
    messages: [],
    login: false,
    challenge: false,
  };
  const message = {
    id: 'unique-message',
    role: 'user',
    text: baseline.prompt,
    attachments: ['사용자 첨부 파일', '사용자 첨부 파일'],
    attachmentNamesHidden: true,
    downloads: 0,
    images: 2,
  };
  const sent: Snapshot = {
    ...baseline,
    url: 'https://chatgpt.com/c/existing',
    prompt: '',
    attachments: [],
    messages: [message],
  };
  const names = baseline.attachments;
  assert.equal(adapter.findSubmission(sent, baseline, baseline.prompt, names), message);
  assert.equal(
    adapter.findSubmission(
      sent,
      { ...baseline, attachments: [...names].reverse() },
      baseline.prompt,
      names,
    ),
    undefined,
  );
  assert.equal(
    adapter.findSubmission(sent, { ...baseline, uploading: true }, baseline.prompt, names),
    undefined,
  );
  assert.equal(
    adapter.findSubmission(
      { ...sent, messages: [message, { ...message, id: 'another' }] },
      baseline,
      baseline.prompt,
      names,
    ),
    undefined,
  );
  assert.equal(
    adapter.findSubmission({ ...sent, prompt: baseline.prompt }, baseline, baseline.prompt, names),
    undefined,
  );
  assert.equal(
    adapter.findSubmission(
      { ...sent, messages: [{ ...message, attachments: [message.attachments[0]!] }] },
      baseline,
      baseline.prompt,
      names,
    ),
    undefined,
  );
});

test('reconcile preserves the confirmed conversation and message identity', async () => {
  await mkdir('.local/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.local/tests/reconcile-'));
  const baseline: Snapshot = {
    url: 'https://chatgpt.com/',
    composer: 1,
    prompt: 'same',
    attachments: [],
    uploading: false,
    busy: false,
    send: 1,
    messages: [],
    login: false,
    challenge: false,
  };
  let snapshot: Snapshot = {
    ...baseline,
    url: 'https://chatgpt.com/c/other',
    messages: [
      {
        id: 'different-message',
        role: 'user',
        text: 'same',
        attachments: [],
        downloads: 0,
        images: 0,
      },
    ],
  };
  const adapter = new PageAdapter({} as Cdp, fixtureSelectors);
  adapter.snapshot = async () => snapshot;
  const runner = new ProbeRunner(root, adapter, {} as DownloadCollector, () => {});
  const record: ProbeRecord = {
    id: 'saved',
    phase: 'generate',
    submission: 'confirmed',
    prompt_sha256: 'synthetic',
    names: [],
    request: { id: 'saved', prompt: 'same', inputs: [] },
    baseline,
    conversation_url: 'https://chatgpt.com/c/original',
    user_id: 'original-message',
  };
  const journal = path.join(root, 'saved/probe.json');
  await durableJson(journal, record);
  await assert.rejects(
    runner.run(record.request, () => {}),
    /SESSION_CHANGED/,
  );
  let saved = await readJson<ProbeRecord>(journal);
  assert.equal(saved.conversation_url, record.conversation_url);
  assert.equal(saved.user_id, record.user_id);
  snapshot = { ...snapshot, url: record.conversation_url! };
  await assert.rejects(
    runner.run(record.request, () => {}),
    /SUBMISSION_UNKNOWN/,
  );
  saved = await readJson<ProbeRecord>(journal);
  assert.equal(saved.user_id, record.user_id);
  assert.equal(runner.busy, false);
  await assert.rejects(
    runner.run({ ...record.request, id: 123 } as unknown as typeof record.request, () => {}),
    /INPUT_INVALID/,
  );
  assert.equal(runner.busy, false);
});
