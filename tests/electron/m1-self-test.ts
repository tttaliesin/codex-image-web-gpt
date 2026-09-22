import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { safeStorage } from 'electron';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { hostMcp } from '../../apps/desktop/src/mcp-host';
import { durableJson, readJson } from '../../packages/storage/src/files';

export async function m1SelfTest(
  profile: string,
  stage: string,
  images: string[],
  pass: (name: string) => void,
) {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const directory = path.join(profile, 'm1');
  const host = await hostMcp(
    directory,
    { input_roots: [path.dirname(images[0]!)], export_roots: [profile], port: address.port },
    { setVisible() {}, setManual() {} },
  );
  const client = new Client({ name: 'electron-m1-fixture', version: '1' });
  try {
    const encrypted = await readFile(path.join(directory, 'auth/mcp-token.enc'));
    const token = safeStorage.decryptString(encrypted);
    assert.ok(token.length >= 32);
    assert.equal(encrypted.includes(Buffer.from(token)), false);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 8);
    const requestFile = path.join(profile, 'm1-test-request.json');
    const input =
      stage === 'first'
        ? {
            request_id: randomUUID(),
            mode: 'generate',
            prompt: 'local fixture only',
            inputs: images.map((file) => ({ path: file, role: 'reference' })),
          }
        : await readJson<Record<string, unknown>>(requestFile);
    if (stage === 'first') await durableJson(requestFile, input);
    const submitted = await client.callTool({ name: 'web_image_submit', arguments: input });
    const result = submitted.structuredContent as any;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.deduplicated, stage === 'restart');
    assert.equal(result.data.job.state, 'queued');
    assert.equal(host.service.engine.jobs().length, 1);
    await client.close();
    assert.equal(host.service.engine.jobs().length, 1);
    const validationId = randomUUID();
    const validationFile = path.join(profile, 'validation command.json');
    await durableJson(validationFile, { name: 'web_image_status', arguments: {} });
    await Promise.all([
      host.validate(validationFile, validationId),
      host.validate(validationFile, validationId),
    ]);
    const validated = await readJson<any>(
      path.join(directory, 'validation', `${validationId}.json`),
    );
    assert.equal(validated.result.ok, true);
    await host.validate(validationFile, validationId);
    await durableJson(validationFile, {
      name: 'web_image_get',
      arguments: { job_id: result.data.job.job_id },
    });
    await assert.rejects(host.validate(validationFile, validationId), /VALIDATION_CONFLICT/);
    pass('m1-owning-process-sdk-validation-concurrent-replay-and-conflict');
    pass(
      stage === 'first'
        ? 'm1-electron-sqlite-encrypted-token-http-sdk-and-durable-admission'
        : 'm1-electron-process-restart-token-and-job-receipt-replay',
    );
  } finally {
    await client.close();
    await host.close();
  }
}
