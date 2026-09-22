import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hasPersistedEncryptionKey, waitForEncryptionKey } from '../../apps/desktop/src/auth-state';

test('fresh profile cannot be shared with an auth helper until its encryption state is persisted', async () => {
  const base = path.resolve('.local/tests');
  await mkdir(base, { recursive: true });
  const profile = await mkdtemp(path.join(base, 'auth-state-'));
  const file = path.join(profile, 'Local State');
  assert.equal(hasPersistedEncryptionKey(profile), false);
  await writeFile(file, '{');
  assert.equal(hasPersistedEncryptionKey(profile), false);
  await assert.rejects(waitForEncryptionKey(profile, 0), /AUTH_STORAGE_NOT_READY/);
  const waiting = waitForEncryptionKey(profile, 2000);
  const state = JSON.stringify({ os_crypt: { encrypted_key: 'fixture-encrypted-key' } });
  await writeFile(file, state);
  await waiting;
  assert.equal(hasPersistedEncryptionKey(profile), true);
  assert.equal(await readFile(file, 'utf8'), state);
});
