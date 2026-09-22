import assert from 'node:assert/strict';
import test from 'node:test';
import { pageDiagnostics, pageStatus } from '../../apps/desktop/src/page-observer';
import type { Snapshot } from '../../packages/browser/src/adapter';

test('page diagnostics omit prompt, file names, message content and conversation identity', () => {
  const snapshot: Snapshot = {
    url: 'https://chatgpt.com/c/private-conversation',
    composer: 1,
    prompt: 'private prompt',
    attachments: ['private-photo.png'],
    uploading: false,
    busy: false,
    send: 1,
    login: false,
    challenge: false,
    messages: [
      {
        id: 'private-message',
        role: 'assistant',
        text: 'private response',
        attachments: ['private-output.png'],
        downloads: 1,
        images: 1,
      },
    ],
  };
  const safe = pageDiagnostics(snapshot);
  assert.equal(JSON.stringify(safe).includes('private'), false);
  assert.equal(safe.origin, 'https://chatgpt.com');
  assert.equal(safe.attachment_count, 1);
  assert.equal(safe.messages[0]!.images, 1);
  assert.equal(pageStatus(snapshot), 'ready');
  assert.equal(pageStatus({ ...snapshot, login: true }), 'login');
  assert.equal(pageStatus({ ...snapshot, login: true, challenge: true }), 'challenge');
  assert.equal(pageStatus(null), 'unavailable');
});
