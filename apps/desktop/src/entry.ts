import { app, safeStorage } from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { hasPersistedEncryptionKey } from './auth-state';

// A credential helper is a separate, windowless process. Never initialize the
// browser, acquire its single-instance lock, or emit credentials to diagnostics.
if (process.argv.includes('--mcp-headers-helper')) {
  const index = process.argv.indexOf('--profile');
  const profile = index < 0 ? undefined : process.argv[index + 1];
  if (!profile || !path.isAbsolute(profile)) app.exit(2);
  else if (process.platform === 'win32' && !hasPersistedEncryptionKey(profile)) {
    // Check synchronously before app readiness can create a competing profile key.
    process.stderr.write('MCP_AUTH_NOT_READY\n');
    app.exit(1);
  } else {
    app.setName('Web Image Bridge');
    app.setPath('userData', profile);
    void app
      .whenReady()
      .then(async () => {
        if (!safeStorage.isEncryptionAvailable()) throw Error('AUTH_UNAVAILABLE');
        const encrypted = await readFile(path.join(profile, 'm1/auth/mcp-token.enc'));
        const token = safeStorage.decryptString(encrypted);
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw Error('AUTH_UNAVAILABLE');
        process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }) + '\n', () =>
          app.exit(0),
        );
      })
      .catch(() => {
        process.stderr.write('MCP_AUTH_HELPER_FAILED\n');
        app.exit(1);
      });
  }
} else require('./main');
