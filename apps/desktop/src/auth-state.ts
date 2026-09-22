import path from 'node:path';
import { readFileSync } from 'node:fs';

// Windows safeStorage shares the encrypted profile key through Chromium's Local State.
// A second Electron process must not initialize that profile before the key is persisted.
export function hasPersistedEncryptionKey(profile: string) {
  try {
    const state = JSON.parse(readFileSync(path.join(profile, 'Local State'), 'utf8'));
    return (
      typeof state.os_crypt?.encrypted_key === 'string' && state.os_crypt.encrypted_key.length > 0
    );
  } catch {
    return false;
  }
}

export async function waitForEncryptionKey(profile: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!hasPersistedEncryptionKey(profile)) {
    if (Date.now() >= deadline) throw Error('AUTH_STORAGE_NOT_READY');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
