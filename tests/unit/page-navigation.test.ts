import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { loadPageDocument } from '../../apps/desktop/src/page-navigation';

test('startup continues at DOM readiness while remote subresources remain pending', async () => {
  let rejectNavigation!: (error: Error) => void;
  const navigation = new Promise<void>((_resolve, reject) => {
    rejectNavigation = reject;
  });
  const page = Object.assign(new EventEmitter(), { loadURL: () => navigation });
  const ready = loadPageDocument(page, 'https://chatgpt.com/', 1000);
  page.emit('dom-ready');
  assert.equal(await ready, true);
  assert.equal(page.listenerCount('dom-ready'), 0);
  // A later failed resource must be handled without changing the settled result.
  rejectNavigation(Error('late navigation failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('startup failure and missing DOM readiness are bounded and remove listeners', async () => {
  const failed = Object.assign(new EventEmitter(), {
    loadURL: async () => {
      throw Error('network unavailable');
    },
  });
  assert.equal(await loadPageDocument(failed, 'https://chatgpt.com/'), false);
  assert.equal(failed.listenerCount('dom-ready'), 0);
  const pending = Object.assign(new EventEmitter(), { loadURL: () => new Promise<void>(() => {}) });
  assert.equal(await loadPageDocument(pending, 'https://chatgpt.com/', 20), false);
  assert.equal(pending.listenerCount('dom-ready'), 0);
});
