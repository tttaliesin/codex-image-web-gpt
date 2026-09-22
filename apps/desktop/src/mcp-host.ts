import { app, safeStorage, clipboard } from 'electron';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BridgeService, type AppView } from '../../../packages/core/src/service';
import { startMcp } from '../../../packages/mcp/src/server';
import type { ExecutionPort } from '../../../packages/core/src/engine';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { durableJson } from '../../../packages/storage/src/files';
import { waitForEncryptionKey } from './auth-state';

export interface McpConfiguration {
  input_roots: string[];
  export_roots: string[];
  port?: number;
  web_execution?: boolean;
}
export async function hostMcp(
  directory: string,
  configuration: McpConfiguration,
  view: AppView,
  execution?: ExecutionPort,
) {
  if (
    !Array.isArray(configuration.input_roots) ||
    !Array.isArray(configuration.export_roots) ||
    [...configuration.input_roots, ...configuration.export_roots].some(
      (root) => typeof root !== 'string' || !path.isAbsolute(root),
    ) ||
    (configuration.web_execution !== undefined &&
      typeof configuration.web_execution !== 'boolean') ||
    (configuration.web_execution && !execution) ||
    (configuration.port !== undefined &&
      (!Number.isInteger(configuration.port) ||
        configuration.port < 1 ||
        configuration.port > 65535))
  )
    throw Error('Invalid MCP configuration');
  if (!safeStorage.isEncryptionAvailable()) throw Error('MCP token encryption unavailable');
  if (process.platform === 'win32') await waitForEncryptionKey(app.getPath('sessionData'));
  const auth = path.join(directory, 'auth');
  await mkdir(auth, { recursive: true });
  const file = path.join(auth, 'mcp-token.enc');
  let token: string;
  try {
    token = safeStorage.decryptString(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('base64url');
    await writeFile(file, safeStorage.encryptString(token), { flag: 'wx' });
  }
  const service = new BridgeService({
    directory,
    inputRoots: configuration.input_roots,
    exportRoots: configuration.export_roots,
    view,
    port: configuration.web_execution ? execution : undefined,
  });
  try {
    await service.ready;
    const server = await startMcp(service, token, configuration.port);
    const validating = new Map<string, Promise<void>>();
    return {
      service,
      url: server.url,
      copyToken() {
        clipboard.writeText(token);
      },
      validate(file: string, id: string) {
        if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('INVALID_VALIDATION_ID');
        const existing = validating.get(id);
        if (existing) return existing;
        const task = (async () => {
          const raw = await readFile(file, 'utf8');
          const command = JSON.parse(raw);
          const hash = createHash('sha256').update(raw).digest('hex');
          const target = path.join(directory, 'validation', `${id}.json`);
          const prior = await readFile(target, 'utf8')
            .then(JSON.parse)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
              return undefined;
            });
          if (prior) {
            if (prior.command_sha256 !== hash) throw Error('VALIDATION_CONFLICT');
            return;
          }
          const client = new Client({ name: 'web-image-bridge-validation', version: '0.2.0' });
          try {
            await client.connect(
              new StreamableHTTPClientTransport(new URL(server.url), {
                requestInit: { headers: { Authorization: `Bearer ${token}` } },
              }),
            );
            const result = await client.callTool(command, { timeout: 40000 });
            await durableJson(target, { command_sha256: hash, result: result.structuredContent });
          } finally {
            await client.close();
          }
        })().finally(() => validating.delete(id));
        validating.set(id, task);
        return task;
      },
      async close() {
        service.prepareShutdown();
        await service.engine.stop();
        await Promise.allSettled(validating.values());
        await server.close();
        await service.close();
      },
    };
  } catch (error) {
    await service.close();
    throw error;
  }
}
