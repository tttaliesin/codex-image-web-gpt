import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  unlink,
  symlink,
  copyFile,
  rename,
  readdir,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import sharp from 'sharp';
import { BridgeService } from '../../packages/core/src/service';
import { Exporter } from '../../packages/storage/src/exporter';
import { Roots } from '../../packages/storage/src/roots';
import { inspectImage } from '../../packages/storage/src/files';
import { startMcp } from '../../packages/mcp/src/server';
import { validTool } from '../../packages/contracts/src';
import { now } from '../../packages/core/src/model';
import type { ExecutionContext, ExecutionPort } from '../../packages/core/src/engine';

async function setup(port?: ExecutionPort) {
  const base = path.resolve('.local/tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'm1-'));
  const inputs = path.join(root, 'input'),
    outputs = path.join(root, 'output'),
    directory = path.join(root, 'app');
  await mkdir(inputs);
  await mkdir(outputs);
  const file = path.join(inputs, 'one.png');
  await sharp({ create: { width: 8, height: 6, channels: 4, background: '#33AAFF' } })
    .png()
    .toFile(file);
  const options = { directory, inputRoots: [inputs], exportRoots: [outputs], port };
  const service = new BridgeService(options);
  await service.ready;
  return { root, file, inputs, outputs, directory, options, service };
}
async function ok(service: BridgeService, tool: string, input: unknown): Promise<any> {
  const result = await service.call(`web_image_${tool}`, input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(validTool(`web_image_${tool}`, 'output', result));
  return result.data;
}
async function error(service: BridgeService, tool: string, input: unknown, code: string) {
  const result = await service.call(`web_image_${tool}`, input);
  assert.equal(result.ok, false);
  assert.equal((result.error as any).code, code);
  assert.ok(validTool(`web_image_${tool}`, 'output', result));
}
const submit = (file?: string) => ({
  request_id: randomUUID(),
  mode: 'generate',
  prompt: '한글 🐈\r\n  exact',
  ...(file ? { inputs: [{ path: file, role: 'reference' }] } : {}),
});

test('folder permissions change atomically and block new work during persistence', async () => {
  const { service, file, inputs, outputs } = await setup();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await assert.rejects(
      service.configureFolders([], [], async () => {
        throw Error('disk unavailable');
      }),
      /disk unavailable/,
    );
    assert.deepEqual(service.options.inputRoots, [inputs]);
    assert.deepEqual(service.options.exportRoots, [outputs]);
    const changing = service.configureFolders([], [outputs], () => barrier);
    await error(service, 'submit', submit(file), 'STATE_CONFLICT');
    await ok(service, 'status', {});
    await assert.rejects(service.configureFolders([], [], async () => {}));
    release();
    await changing;
    await error(service, 'submit', submit(file), 'PATH_DENIED');
    assert.deepEqual(service.options.exportRoots, [outputs]);
    await ok(service, 'submit', submit());
    let persisted = false;
    await assert.rejects(
      service.configureFolders([inputs], [], async () => {
        persisted = true;
      }),
    );
    assert.equal(persisted, false);
    assert.deepEqual(service.options.inputRoots, []);
    assert.deepEqual(service.options.exportRoots, [outputs]);
  } finally {
    release();
    await service.close();
  }
});

test('M1 concurrent durable acceptance, default equivalence, frozen input, request conflict and reopen', async () => {
  const env = await setup();
  let service = env.service;
  try {
    const input = submit(env.file);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ok(service, 'submit', input)),
    );
    assert.equal(new Set(results.map((r) => r.job.job_id)).size, 1);
    assert.equal(results.filter((r) => !r.deduplicated).length, 1);
    const job = results[0].job;
    const staged = service.engine.job(job.job_id).inputs[0]!;
    await writeFile(env.file, 'changed source');
    const replay = await ok(service, 'submit', {
      ...input,
      expected_output: { count: 1, strict: false, require_alpha: false },
    });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.job.job_id, job.job_id);
    assert.notEqual((await readFile(staged.path)).toString(), 'changed source');
    await error(
      service,
      'submit',
      { ...input, prompt: `${input.prompt} ` },
      'IDEMPOTENCY_CONFLICT',
    );
    await service.close();
    service = new BridgeService(env.options);
    await service.ready;
    assert.equal(
      (await ok(service, 'get', { request_id: input.request_id })).job.job_id,
      job.job_id,
    );
    assert.equal((await ok(service, 'submit', input)).deduplicated, true);
    const status = await ok(service, 'status', {});
    assert.equal(status.queue.waiting_count, 1);
    assert.equal(status.queue.dispatch_blocked, true);
    assert.equal(service.engine.job(job.job_id).request.prompt, input.prompt);
  } finally {
    await service.close();
  }
});

test('M1 validates unknown fields, MIME, hash, roots, junctions and partial staging recovery', async () => {
  const env = await setup();
  const { service } = env;
  try {
    await error(service, 'submit', { ...submit(), unexpected: true }, 'INPUT_INVALID');
    await error(service, 'submit', submit(path.join(env.root, 'outside.png')), 'PATH_DENIED');
    await error(
      service,
      'submit',
      {
        ...submit(),
        inputs: [{ path: env.file, role: 'reference', expected_sha256: '0'.repeat(64) }],
      },
      'INPUT_INVALID',
    );
    const bad = path.join(env.inputs, 'bad.jpg');
    await writeFile(bad, 'not jpeg');
    await error(service, 'submit', submit(bad), 'INPUT_INVALID');
    const outside = path.join(env.root, 'outside');
    await mkdir(outside);
    await copyFile(env.file, path.join(outside, 'image.png'));
    await symlink(outside, path.join(env.inputs, 'junction'), 'junction');
    await error(
      service,
      'submit',
      submit(path.join(env.inputs, 'junction', 'image.png')),
      'PATH_DENIED',
    );
    const missing = path.join(env.inputs, 'later.png');
    const input = {
      ...submit(env.file),
      inputs: [
        { path: env.file, role: 'reference' },
        { path: missing, role: 'supporting' },
      ],
    };
    await error(service, 'submit', input, 'NOT_FOUND');
    await copyFile(env.file, missing);
    await writeFile(env.file, 'changed first file');
    const accepted = await ok(service, 'submit', input);
    assert.equal(service.engine.job(accepted.job.job_id).inputs.length, 2);
    assert.equal(service.engine.jobs().length, 1);
  } finally {
    await service.close();
  }
});

test('M1 session receipts, manual ownership, parent checks, revisions and wait cursors', async () => {
  const env = await setup();
  const { service } = env;
  try {
    const create = { request_id: randomUUID(), action: 'create' };
    const created = await ok(service, 'session', create),
      id = created.session.session_id;
    const takeover = {
      request_id: randomUUID(),
      session_id: id,
      action: 'takeover',
      expected_revision: 1,
    };
    const manual = await ok(service, 'session', takeover);
    assert.equal(manual.session.control_owner, 'manual');
    assert.equal((await ok(service, 'session', takeover)).deduplicated, true);
    await error(
      service,
      'session',
      { request_id: randomUUID(), session_id: id, action: 'release', expected_revision: 1 },
      'REVISION_CONFLICT',
    );
    await ok(service, 'session', {
      request_id: randomUUID(),
      session_id: id,
      action: 'release',
      expected_revision: manual.session.revision,
    });
    const job = (await ok(service, 'submit', { ...submit(), session_id: id })).job;
    await error(service, 'submit', { ...submit(), session_id: id }, 'STATE_CONFLICT');
    await error(
      service,
      'submit',
      { ...submit(), session_id: id, parent_job_id: job.job_id },
      'STATE_CONFLICT',
    );
    const wait = await ok(service, 'wait', {
      job_id: job.job_id,
      after_revision: 0,
      timeout_ms: 0,
    });
    assert.equal(wait.reason, 'changed');
    assert.equal(wait.events[0].kind, 'accepted');
    const timed = await ok(service, 'wait', {
      job_id: job.job_id,
      after_revision: 1,
      timeout_ms: 10,
    });
    assert.equal(timed.reason, 'timeout');
    assert.equal(timed.events.length, 0);
    await error(service, 'wait', { job_id: job.job_id, after_revision: 999 }, 'REVISION_CONFLICT');
    const waiting = ok(service, 'wait', {
      job_id: job.job_id,
      after_revision: 1,
      timeout_ms: 1000,
    });
    const cancel = {
      request_id: randomUUID(),
      job_id: job.job_id,
      action: 'cancel',
      expected_revision: 1,
    };
    await ok(service, 'control', cancel);
    assert.equal((await waiting).reason, 'terminal');
    assert.equal((await ok(service, 'control', cancel)).deduplicated, true);
    await error(service, 'control', { ...cancel, action: 'resume' }, 'IDEMPOTENCY_CONFLICT');
    await error(
      service,
      'control',
      { ...cancel, request_id: randomUUID(), expected_revision: 2, action: 'resume' },
      'STATE_CONFLICT',
    );
    assert.equal(
      (await ok(service, 'wait', { job_id: job.job_id, after_revision: 2 })).events.length,
      0,
    );
  } finally {
    await service.close();
  }
});

test('M1 sending marker persists before side effect; restart cannot resend and cancel retains profile lock', async () => {
  let sends = 0;
  const port: ExecutionPort = {
    version: 'fixture',
    async run(context, reconcile) {
      if (reconcile) {
        await assert.rejects(context.beforeSend({}), /STATE_CONFLICT/);
        throw Error('No matching evidence');
      }
      await context.beforeSend({ count: 0 });
      assert.equal(context.job().snapshot.submission_state, 'sending');
      sends++;
      throw Error('Disconnected after click');
    },
  };
  const env = await setup(port);
  let service = env.service;
  try {
    const job = (await ok(service, 'submit', submit())).job;
    await service.engine.idle();
    let current = (await ok(service, 'get', { job_id: job.job_id })).job;
    assert.equal(current.state, 'unknown');
    assert.equal(sends, 1);
    await service.close();
    service = new BridgeService(env.options);
    await service.ready;
    await ok(service, 'control', {
      request_id: randomUUID(),
      job_id: job.job_id,
      expected_revision: current.revision,
      action: 'reconcile',
    });
    await service.engine.idle();
    current = service.engine.job(job.job_id).snapshot;
    assert.equal(current.state, 'unknown');
    assert.equal(sends, 1);
    await ok(service, 'control', {
      request_id: randomUUID(),
      job_id: job.job_id,
      expected_revision: current.revision,
      action: 'cancel',
    });
    const next = (await ok(service, 'submit', submit())).job;
    await service.engine.idle();
    assert.equal(service.engine.job(next.job_id).snapshot.state, 'queued');
    assert.equal((await ok(service, 'status', {})).queue.dispatch_blocked, true);
  } finally {
    await service.close();
  }
});

test('M1 event history overflow returns resync rather than truncated success', async () => {
  const env = await setup();
  const { service } = env;
  try {
    const job = (await ok(service, 'submit', submit())).job;
    service.db.transaction(() => {
      service.engine.update(job.job_id, { state: 'running' });
      for (let i = 0; i < 102; i++)
        service.engine.update(job.job_id, { phase: i % 2 ? 'prepare' : 'attach' }, 'phase_changed');
    });
    const result = await ok(service, 'wait', {
      job_id: job.job_id,
      after_revision: 1,
      timeout_ms: 0,
    });
    assert.equal(result.resync_required, true);
    assert.equal(result.events.length, 0);
    assert.equal(result.cursor, service.engine.job(job.job_id).snapshot.revision);
  } finally {
    await service.close();
  }
});

async function completeFixture(service: BridgeService, context: ExecutionContext, png: Buffer) {
  if (context.job().snapshot.submission_state === 'not_sent')
    await context.beforeSend({ fixture: true });
  await context.confirm({
    conversation_url: `https://chatgpt.com/c/fixture-${context.job().snapshot.session_id}`,
    message_id: 'fixture-message',
  });
  await context.phase('download');
  const job = context.job().snapshot;
  const directory = path.join(service.options.directory, 'downloads', job.job_id);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'fixture.part');
  await writeFile(file, png);
  await service.artifacts.complete(job.job_id, [
    {
      path: file,
      source: {
        kind: 'chatgpt_download',
        session_id: job.session_id,
        conversation_url: context.session().conversation_url!,
        message_id: 'fixture-message',
        downloaded_at: now(),
        web_model_id: null,
      },
    },
  ]);
}

test('M1 single worker, artifact verification, followup and persistent export conflict/replay', async () => {
  let service!: BridgeService,
    png!: Buffer,
    active = 0,
    maximum = 0;
  const env = await setup({
    version: 'fixture-only',
    async run(context) {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await completeFixture(service, context, png);
      } finally {
        active--;
      }
    },
  });
  service = env.service;
  png = await readFile(env.file);
  try {
    const first = (await ok(service, 'submit', submit())).job;
    const second = (await ok(service, 'submit', submit())).job;
    await service.engine.idle();
    assert.equal(maximum, 1);
    const parent = service.engine.job(first.job_id).snapshot;
    assert.equal(parent.state, 'succeeded');
    assert.equal(service.engine.job(second.job_id).snapshot.state, 'succeeded');
    const artifact = (await ok(service, 'artifacts', { job_id: first.job_id })).artifacts[0];
    const follow = await ok(service, 'submit', {
      request_id: randomUUID(),
      mode: 'edit',
      prompt: 'fixture edit',
      session_id: parent.session_id,
      parent_job_id: parent.job_id,
      inputs: [{ artifact_id: artifact.artifact_id, role: 'edit_target' }],
      expected_output: { count: 1, width: 100, height: 100, strict: true },
    });
    await service.engine.idle();
    assert.equal(service.engine.job(follow.job.job_id).snapshot.state, 'partial');
    const exportInput = {
      export_id: randomUUID(),
      artifact_ids: [artifact.artifact_id],
      destination_dir: env.outputs,
    };
    assert.equal((await ok(service, 'export', exportInput)).export.state, 'copying');
    await service.exporter.idle();
    const exported = (await ok(service, 'export', exportInput)).export;
    assert.equal(exported.state, 'succeeded');
    assert.deepEqual(await readFile(exported.items[0].path), png);
    const versioned = { ...exportInput, export_id: randomUUID() };
    await ok(service, 'export', versioned);
    await service.exporter.idle();
    assert.match((await ok(service, 'export', versioned)).export.items[0].path, /-v2\.png$/);
    const collision = { ...exportInput, export_id: randomUUID(), collision: 'error' };
    await ok(service, 'export', collision);
    await service.exporter.idle();
    assert.equal((await ok(service, 'export', collision)).export.state, 'failed');
    await service.exporter.idle();
    await writeFile(exported.items[0].path, 'external change');
    await error(service, 'export', exportInput, 'EXPORT_CONFLICT');
    assert.equal(service.engine.job(parent.job_id).snapshot.state, 'succeeded');
    await unlink(artifact.path);
    await error(service, 'artifacts', { job_id: parent.job_id }, 'NOT_FOUND');
    assert.equal((await ok(service, 'get', { job_id: parent.job_id })).job.state, 'succeeded');
  } finally {
    await service.close();
  }
});

test('M1 real SDK HTTP discovery and tools; auth, host and origin checks; disconnect does not cancel job', async () => {
  let service!: BridgeService, release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const env = await setup({
    version: 'fixture-only',
    async run(context) {
      entered();
      await gate;
      await completeFixture(service, context, await readFile(env.file));
    },
  });
  service = env.service;
  const token = 'fixture-only-secret-'.repeat(3);
  const server = await startMcp(service, token, 0);
  const client = new Client({ name: 'm1-integration', version: '1' });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 8);
    for (const tool of listed.tools) {
      assert.ok(tool.inputSchema.$defs);
      assert.ok(tool.outputSchema?.$defs);
    }
    const status = await client.callTool({ name: 'web_image_status', arguments: {} });
    assert.equal((status.structuredContent as any).ok, true);
    assert.equal(JSON.parse((status.content[0] as any).text).schema_version, '0.1');
    const result = await client.callTool({ name: 'web_image_submit', arguments: submit() });
    const job = (result.structuredContent as any).data.job;
    await started;
    await client.close();
    release();
    await service.engine.idle();
    assert.equal(service.engine.job(job.job_id).snapshot.state, 'succeeded');
    const reconnected = new Client({ name: 'm1-reconnected', version: '1' });
    await reconnected.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const invoke = async (name: string, args: Record<string, unknown>) => {
        const result = await reconnected.callTool({ name: `web_image_${name}`, arguments: args });
        const payload = result.structuredContent as any;
        assert.equal(payload.ok, true, JSON.stringify(payload));
        return payload.data;
      };
      await invoke('session', { action: 'create', request_id: randomUUID() });
      const fetched = await invoke('get', { job_id: job.job_id });
      assert.equal(fetched.job.state, 'succeeded');
      assert.equal(
        (
          await invoke('wait', {
            job_id: job.job_id,
            after_revision: fetched.job.revision,
            timeout_ms: 0,
          })
        ).events.length,
        0,
      );
      const artifacts = await invoke('artifacts', { job_id: job.job_id });
      await invoke('export', {
        export_id: randomUUID(),
        artifact_ids: [artifacts.artifacts[0].artifact_id],
        destination_dir: env.outputs,
      });
      assert.equal(
        (
          await invoke('control', {
            request_id: randomUUID(),
            job_id: job.job_id,
            expected_revision: fetched.job.revision,
            action: 'cancel',
          })
        ).outcome,
        'no_change',
      );
      const invalid = await reconnected.callTool({
        name: 'web_image_get',
        arguments: { job_id: randomUUID() },
      });
      assert.equal(invalid.isError, true);
      assert.equal((invalid.structuredContent as any).error.code, 'NOT_FOUND');
      await assert.rejects(reconnected.callTool({ name: 'missing_tool', arguments: {} }));
    } finally {
      await reconnected.close();
    }
    assert.equal((await fetch(server.url)).status, 401);
    for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
      assert.equal(
        (
          await fetch(server.url, {
            method,
            headers: { Authorization: `Bearer ${token}`, Origin: 'https://chatgpt.com' },
          })
        ).status,
        403,
      );
    }
    const hostStatus = await new Promise<number>((resolve) => {
      const req = httpRequest(
        server.url,
        { headers: { Host: 'attacker.example', Authorization: `Bearer ${token}` } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      req.end();
    });
    assert.equal(hostStatus, 403);
    await assert.rejects(startMcp(service, token, Number(new URL(server.url).port)), /EADDRINUSE/);
  } finally {
    release();
    await client.close();
    await server.close();
    await service.close();
  }
});

test('M1 partial export retries only missing item, persists completed paths, and checks allowed destination', async () => {
  let service!: BridgeService, png!: Buffer;
  const env = await setup({
    version: 'fixture',
    run: (context) => completeFixture(service, context, png),
  });
  service = env.service;
  png = await readFile(env.file);
  try {
    const a = (await ok(service, 'submit', submit())).job,
      b = (await ok(service, 'submit', submit())).job;
    await service.engine.idle();
    const first = (await ok(service, 'artifacts', { job_id: a.job_id })).artifacts[0];
    const second = (await ok(service, 'artifacts', { job_id: b.job_id })).artifacts[0];
    const saved = `${second.path}.saved`;
    await rename(second.path, saved);
    const input = {
      export_id: randomUUID(),
      artifact_ids: [first.artifact_id, second.artifact_id],
      destination_dir: env.outputs,
    };
    await ok(service, 'export', input);
    await service.exporter.idle();
    const partial = (await ok(service, 'export', input)).export;
    await service.exporter.idle();
    assert.equal(partial.state, 'partial');
    const completedPath = partial.items[0].path;
    await rename(saved, second.path);
    await service.close();
    service = new BridgeService({ ...env.options, port: undefined });
    await service.ready;
    await ok(service, 'export', input);
    await service.exporter.idle();
    const resumed = (await ok(service, 'export', input)).export;
    assert.equal(resumed.state, 'succeeded');
    assert.equal(resumed.items[0].path, completedPath);
    assert.equal((await readdir(env.outputs)).filter((name) => name.endsWith('.png')).length, 2);
    await error(service, 'export', { ...input, destination_dir: env.root }, 'IDEMPOTENCY_CONFLICT');
    await error(
      service,
      'export',
      { ...input, export_id: randomUUID(), destination_dir: env.root },
      'PATH_DENIED',
    );
  } finally {
    await service.close();
  }
});

test('M1 export falls back to an exclusive verified copy where hard links are unavailable', async () => {
  let service!: BridgeService, png!: Buffer;
  const env = await setup({
    version: 'fixture',
    run: (context) => completeFixture(service, context, png),
  });
  service = env.service;
  png = await readFile(env.file);
  // FAT32 and exFAT refuse CreateHardLinkW; libuv reports ERROR_INVALID_FUNCTION as EISDIR.
  const noLinks = async () => {
    throw Object.assign(Error('link unsupported'), { code: 'EISDIR' });
  };
  try {
    const job = (await ok(service, 'submit', submit())).job;
    await service.engine.idle();
    const artifact = (await ok(service, 'artifacts', { job_id: job.job_id })).artifacts[0];
    let exporter = new Exporter(service.db, new Roots([env.outputs]), noLinks);
    const input: Parameters<Exporter['submit']>[0] = {
      export_id: randomUUID(),
      artifact_ids: [artifact.artifact_id],
      destination_dir: env.outputs,
    };
    await exporter.submit(input);
    await exporter.idle();
    const exported = (await exporter.submit(input)).export;
    assert.equal(exported.state, 'succeeded');
    const published = exported.items[0].path!;
    assert.equal((await inspectImage(published)).sha256, artifact.sha256);
    assert.deepEqual(await readdir(env.outputs), [path.basename(published)]);

    // A crash after the copy but before the receipt commit adopts the exact file once.
    const record = service.db.get<any>('exports', input.export_id);
    record.snapshot.state = 'copying';
    record.snapshot.items[0] = { ...record.snapshot.items[0], state: 'pending', path: null };
    service.db.put('exports', input.export_id, record);
    exporter = new Exporter(service.db, new Roots([env.outputs]), noLinks);
    exporter.recover();
    await exporter.idle();
    const adopted = service.db.get<any>('exports', input.export_id).snapshot;
    assert.equal(adopted.state, 'succeeded');
    assert.equal(adopted.items[0].path, published);
    assert.deepEqual(await readdir(env.outputs), [path.basename(published)]);

    // Different bytes at a copied target are someone else's file: conflict, never delete.
    service.db.put('exports', input.export_id, record);
    const foreign = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer();
    await writeFile(published, foreign);
    exporter = new Exporter(service.db, new Roots([env.outputs]), noLinks);
    exporter.recover();
    await exporter.idle();
    const conflict = service.db.get<any>('exports', input.export_id).snapshot;
    assert.equal(conflict.items[0].state, 'failed');
    assert.equal(conflict.items[0].error.code, 'EXPORT_CONFLICT');
    assert.deepEqual(await readFile(published), foreign);
  } finally {
    await service.close();
  }
});

test('M1 read-only reconcile cannot authorize a fresh submit; explicit resume can prepare again', async () => {
  let entered = 0;
  const env = await setup({
    version: 'fixture',
    async run(context, reconcile) {
      entered++;
      if (reconcile && context.job().observation_only)
        await assert.rejects(context.beforeSend({}), /STATE_CONFLICT/);
      else if (reconcile) await context.beforeSend({ fixture: 'explicit-resume' });
      await context.waitForUser({
        code: 'AUTH_REQUIRED',
        message: 'fixture requires intervention',
        retryable: true,
        next_action: 'open_app',
      });
    },
  });
  try {
    const job = (await ok(env.service, 'submit', submit())).job;
    await env.service.engine.idle();
    const current = env.service.engine.job(job.job_id).snapshot;
    await ok(env.service, 'control', {
      request_id: randomUUID(),
      job_id: job.job_id,
      expected_revision: current.revision,
      action: 'reconcile',
    });
    await env.service.engine.idle();
    assert.equal(entered, 2);
    assert.equal(env.service.engine.job(job.job_id).snapshot.submission_state, 'not_sent');
    assert.equal(env.service.db.get('attempts', job.job_id), undefined);
    const waiting = env.service.engine.job(job.job_id).snapshot;
    await ok(env.service, 'control', {
      request_id: randomUUID(),
      job_id: job.job_id,
      expected_revision: waiting.revision,
      action: 'resume',
    });
    await env.service.engine.idle();
    assert.equal(entered, 3);
    assert.equal(env.service.engine.job(job.job_id).snapshot.submission_state, 'sending');
  } finally {
    await env.service.close();
  }
});

test('M1/M3 download manifest recovers across manual interruption without a new submission', async () => {
  const env = await setup();
  let service = env.service;
  try {
    const job = (await ok(service, 'submit', submit())).job;
    service.db.transaction(() => {
      service.engine.update(job.job_id, { state: 'running' });
      service.engine.update(job.job_id, { submission_state: 'sending', remote_may_continue: true });
      service.engine.update(job.job_id, { submission_state: 'confirmed', phase: 'download' });
      const session = service.engine.session(job.session_id);
      session.conversation_url = 'https://chatgpt.com/c/fixture-recovery';
      service.db.put('sessions', session.session_id, session);
    });
    const directory = path.join(env.directory, 'downloads', job.job_id);
    await mkdir(directory, { recursive: true });
    const downloaded = path.join(directory, 'fixture.part');
    await copyFile(env.file, downloaded);
    const original = service.engine.update.bind(service.engine);
    service.engine.update = (id, patch, kind) => {
      if (patch.state === 'succeeded') throw Error('FIXTURE_DB_COMMIT_FAILURE');
      return original(id, patch, kind);
    };
    await assert.rejects(
      service.artifacts.complete(job.job_id, [
        {
          path: downloaded,
          source: {
            kind: 'chatgpt_download',
            session_id: job.session_id,
            conversation_url: 'https://chatgpt.com/c/fixture-recovery',
            message_id: 'fixture',
            downloaded_at: now(),
            web_model_id: null,
          },
        },
      ]),
      /FIXTURE_DB_COMMIT_FAILURE/,
    );
    service.engine.update = original;
    const manifest = JSON.parse(
      await readFile(path.join(env.directory, 'manifests', `${job.job_id}.json`), 'utf8'),
    );
    // Simulate the earlier crash boundary where the manifest exists but final rename has not happened.
    await rename(manifest[0].path, `${manifest[0].path}.part`);
    service.db.transaction(() => {
      service.engine.update(job.job_id, {
        state: 'waiting_user',
        error: {
          code: 'STATE_CONFLICT',
          message: 'Manual fixture interruption',
          retryable: false,
          next_action: 'resume',
        },
      });
      const session = service.engine.session(job.session_id);
      session.control_owner = 'manual';
      session.revision++;
      service.db.put('sessions', session.session_id, session);
    });
    await service.close();
    service = new BridgeService(env.options);
    await service.ready;
    assert.equal(service.engine.job(job.job_id).snapshot.state, 'succeeded');
    assert.equal(
      (await ok(service, 'artifacts', { job_id: job.job_id })).artifacts[0].sha256,
      manifest[0].sha256,
    );
    assert.equal(service.engine.jobs().length, 1);
    assert.equal(service.engine.session(job.session_id).control_owner, 'manual');
  } finally {
    await service.close();
  }
});

test('M1 an unrecoverable artifact manifest holds only its job instead of blocking startup', async () => {
  const env = await setup();
  let service = env.service;
  try {
    const job = (await ok(service, 'submit', submit())).job;
    service.db.transaction(() => {
      service.engine.update(job.job_id, { state: 'running' });
      service.engine.update(job.job_id, { submission_state: 'sending', remote_may_continue: true });
      service.engine.update(job.job_id, { submission_state: 'confirmed', phase: 'download' });
      const session = service.engine.session(job.session_id);
      session.conversation_url = 'https://chatgpt.com/c/fixture-lost';
      service.db.put('sessions', session.session_id, session);
    });
    const directory = path.join(env.directory, 'downloads', job.job_id);
    await mkdir(directory, { recursive: true });
    const downloaded = path.join(directory, 'fixture.part');
    await copyFile(env.file, downloaded);
    const original = service.engine.update.bind(service.engine);
    service.engine.update = (id, patch, kind) => {
      if (patch.state === 'succeeded') throw Error('FIXTURE_DB_COMMIT_FAILURE');
      return original(id, patch, kind);
    };
    await assert.rejects(
      service.artifacts.complete(job.job_id, [
        {
          path: downloaded,
          source: {
            kind: 'chatgpt_download',
            session_id: job.session_id,
            conversation_url: 'https://chatgpt.com/c/fixture-lost',
            message_id: 'fixture',
            downloaded_at: now(),
            web_model_id: null,
          },
        },
      ]),
      /FIXTURE_DB_COMMIT_FAILURE/,
    );
    service.engine.update = original;
    const manifests = path.join(env.directory, 'manifests');
    const manifest = JSON.parse(await readFile(path.join(manifests, `${job.job_id}.json`), 'utf8'));
    // Both the published file and its staging copy are gone, e.g. removed by another program.
    await unlink(manifest[0].path);
    await writeFile(path.join(manifests, `${randomUUID()}.json`), JSON.stringify(manifest));
    await writeFile(path.join(manifests, 'truncated.json'), '[{');
    await service.close();

    service = new BridgeService(env.options);
    await service.ready;
    const held = service.engine.job(job.job_id).snapshot;
    assert.equal(held.state, 'waiting_user');
    assert.equal(held.submission_state, 'confirmed');
    assert.equal(held.error?.code, 'DOWNLOAD_FAILED');
    assert.equal(held.error?.next_action, 'retry_download');
    assert.equal((await ok(service, 'status', {})).queue.active_job_id, job.job_id);
    const resumed = await ok(service, 'control', {
      request_id: randomUUID(),
      job_id: job.job_id,
      expected_revision: held.revision,
      action: 'resume',
    });
    assert.equal(resumed.job.state, 'reconciling');

    // A later startup that still cannot verify the file stays idempotent.
    await service.close();
    service = new BridgeService(env.options);
    await service.ready;
    assert.equal(service.engine.job(job.job_id).snapshot.state, 'waiting_user');
  } finally {
    await service.close();
  }
});

test('M1 input staging waits only for other submits, never blocks engine commands', async () => {
  const env = await setup();
  const { service } = env;
  let release!: () => void;
  const staging = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const queued = (await ok(service, 'submit', submit())).job;
    // Stand in for a long input copy that holds the admission lock.
    const held = (
      service as unknown as { admissions: { run(work: () => unknown): Promise<unknown> } }
    ).admissions.run(() => staging);
    let settled = false;
    const pending = service.call('web_image_submit', submit(env.file)).then((result) => {
      settled = true;
      return result;
    });
    await ok(service, 'status', {});
    await ok(service, 'session', { request_id: randomUUID(), action: 'create' });
    const canceled = await ok(service, 'control', {
      request_id: randomUUID(),
      job_id: queued.job_id,
      expected_revision: queued.revision,
      action: 'cancel',
    });
    assert.equal(canceled.job.state, 'canceled');
    assert.equal(settled, false);
    release();
    await held;
    const accepted = await pending;
    assert.equal(accepted.ok, true, JSON.stringify(accepted));

    // Shutdown that starts during staging waits for the admission and refuses the job.
    let finish!: () => void;
    const late = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const blocking = (
      service as unknown as { admissions: { run(work: () => unknown): Promise<unknown> } }
    ).admissions.run(() => late);
    const refused = service.call('web_image_submit', submit(env.file));
    service.drain();
    finish();
    await blocking;
    assert.equal(((await refused).error as { code: string }).code, 'STATE_CONFLICT');
  } finally {
    release();
    await service.close();
  }
});

test('M1 a refused path tells the caller which folders are allowed and what to do instead', async () => {
  const env = await setup();
  const { service } = env;
  const refusal = async (tool: string, input: unknown) => {
    const result = await service.call(`web_image_${tool}`, input);
    assert.equal(result.ok, false);
    assert.ok(validTool(`web_image_${tool}`, 'output', result));
    const failure = result.error as { code: string; message: string; next_action: string };
    assert.equal(failure.code, 'PATH_DENIED');
    assert.equal(failure.next_action, 'fix_input');
    return failure.message;
  };
  try {
    const outside = path.join(env.root, 'outside.png');
    let message = await refusal('submit', submit(outside));
    assert.match(message, /^Input 1 is outside the folders this app may read/);
    assert.ok(message.includes(`Allowed: ${env.inputs}.`));
    assert.match(message, /artifact_id/);
    assert.ok(!message.includes(outside), 'the refused path itself is not echoed back');

    message = await refusal('export', {
      export_id: randomUUID(),
      artifact_ids: [randomUUID()],
      destination_dir: env.root,
    });
    assert.match(message, /^destination_dir is outside the folders this app may save to/);
    assert.ok(message.includes(`Allowed: ${env.outputs}.`));

    await service.configureFolders([], [env.outputs], async () => {});
    assert.match(await refusal('submit', submit(outside)), /Allowed: none configured\./);

    // Many long folders still fit the contract's 1024-character message limit.
    service.options.inputRoots.push(
      ...Array.from({ length: 40 }, (_, i) => path.join(env.root, `folder-${i}-${'x'.repeat(40)}`)),
    );
    message = await refusal('submit', submit(outside));
    assert.ok(message.length <= 1024);
    assert.match(message, /…\. Pass an earlier result by artifact_id/);
  } finally {
    await service.close();
  }
});
