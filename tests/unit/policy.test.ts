import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedNavigation,
  allowedDownload,
  conversationUrl,
} from '../../packages/browser/src/policy';
import { validateRequest } from '../../apps/desktop/src/probe';

test('navigation and download boundaries reject lookalikes, local resources and foreign blob origins', () => {
  for (const value of [
    'file:///C:/Windows/a',
    'javascript:alert(1)',
    'https://chatgpt.com.evil.test/',
    'http://chatgpt.com/',
    'https://evil.test/chatgpt.com',
    'https://user:pass@chatgpt.com/',
  ]) {
    assert.equal(allowedNavigation(value), false);
    assert.equal(allowedDownload(value), false);
  }
  assert.equal(allowedNavigation('https://auth.openai.com/'), true);
  assert.equal(allowedDownload('blob:https://chatgpt.com/abc'), true);
  assert.equal(allowedDownload('blob:https://evil.test/abc'), false);
  assert.equal(allowedDownload('https://files.oaiusercontent.com/image'), true);
  assert.equal(conversationUrl('https://chatgpt.com/c/abcd-123'), true);
  assert.equal(conversationUrl('https://chatgpt.com/?conversation=abc'), false);
});

test('probe IDs cannot traverse app storage and request preserves prompt and array order', () => {
  const request = {
    id: 'approved-1',
    prompt: '두개 합치라',
    inputs: [
      { path: 'C:/images/first.png', role: 'reference' },
      { path: 'C:/images/second.jpg', role: 'supporting' },
    ],
  };
  const original = JSON.stringify(request);
  validateRequest(request);
  assert.equal(JSON.stringify(request), original);
  assert.throws(() => validateRequest({ ...request, id: '../escape' }), /INPUT_INVALID/);
  assert.throws(() => validateRequest({ ...request, id: 123 }), /INPUT_INVALID/);
  assert.throws(() => validateRequest({ ...request, parent_id: '../escape' }), /INPUT_INVALID/);
  assert.throws(() => validateRequest({ ...request, prompt: '' }), /INPUT_INVALID/);
});
