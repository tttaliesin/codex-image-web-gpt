import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, writeFile, copyFile, link, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { BridgeService } from '../../packages/core/src/service';
import { Exporter } from '../../packages/storage/src/exporter';
import { Roots } from '../../packages/storage/src/roots';
import { now } from '../../packages/core/src/model';
import type { ExecutionContext } from '../../packages/core/src/engine';

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const leftovers = async (directory: string) =>
  (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith('.part'));

async function setup() {
  await mkdir('.local/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.local/tests/cleanup-'));
  const outputs = path.join(root, 'output'),
    directory = path.join(root, 'app');
  await mkdir(outputs);
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#2266AA' } })
    .png()
    .toBuffer();
  // Each run downloads `count` files; `outside` places the last one outside the download root.
  const plan = { count: 1, outside: false };
  const run = async (context: ExecutionContext) => {
    await context.beforeSend({ fixture: true });
    await context.confirm({
      conversation_url: `https://chatgpt.com/c/cleanup-${context.job().snapshot.session_id}`,
      message_id: 'cleanup-message',
    });
    const job = context.job().snapshot;
    const downloads = path.join(directory, 'downloads', job.job_id);
    await mkdir(downloads, { recursive: true });
    const files = [];
    for (let i = 0; i < plan.count; i++) {
      const file = path.join(plan.outside && i === plan.count - 1 ? root : downloads, `${i}.png`);
      await writeFile(file, png);
      files.push({
        path: file,
        source: {
          kind: 'chatgpt_download' as const,
          session_id: job.session_id,
          conversation_url: context.session().conversation_url!,
          message_id: 'cleanup-message',
          downloaded_at: now(),
          web_model_id: null,
        },
      });
    }
    await context.complete(files);
  };
  const options = {
    directory,
    inputRoots: [],
    exportRoots: [outputs],
    port: { version: 'cleanup', run },
  };
  const service = new BridgeService(options);
  await service.ready;
  const submit = async () => {
    const result = await service.call('web_image_submit', {
      request_id: randomUUID(),
      mode: 'generate',
      prompt: 'cleanup fixture',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await service.engine.idle();
    return service.engine.job((result.data as { job: { job_id: string } }).job.job_id).snapshot;
  };
  return { root, outputs, directory, options, service, plan, submit };
}

test('artifact registration removes its staged copies on failure and its manifest once committed', async () => {
  const env = await setup();
  let service = env.service;
  try {
    const succeeded = await env.submit();
    assert.equal(succeeded.state, 'succeeded', JSON.stringify(succeeded));
    const manifest = path.join(env.directory, 'manifests', `${succeeded.job_id}.json`);
    assert.equal(await exists(manifest), false);

    // A crash between commit and cleanup leaves the manifest of a terminal job behind.
    await writeFile(manifest, '[]');
    await service.close();
    service = new BridgeService(env.options);
    await service.ready;
    assert.equal(await exists(manifest), false);
    assert.equal(service.engine.job(succeeded.job_id).snapshot.state, 'succeeded');

    // The first file is staged before the second is refused.
    env.plan.count = 2;
    env.plan.outside = true;
    const result = await service.call('web_image_submit', {
      request_id: randomUUID(),
      mode: 'generate',
      prompt: 'cleanup fixture',
    });
    await service.engine.idle();
    const failed = service.engine.job((result.data as any).job.job_id).snapshot;
    assert.equal(failed.state, 'unknown');
    assert.deepEqual(await leftovers(path.join(env.directory, 'artifacts', failed.job_id)), []);
    assert.equal(
      await exists(path.join(env.directory, 'manifests', `${failed.job_id}.json`)),
      false,
    );
  } finally {
    await service.close();
  }
});

test('export temps never outlive their item in the user folder, except as adoption evidence', async () => {
  const env = await setup();
  const { service, outputs } = env;
  try {
    const job = await env.submit();
    const artifact_id = job.artifact_ids[0]!;
    const input = {
      export_id: randomUUID(),
      artifact_ids: [artifact_id],
      destination_dir: outputs,
    };
    const refusing = async () => {
      throw Object.assign(Error('exists'), { code: 'EEXIST' });
    };
    let exporter = new Exporter(service.db, new Roots([outputs]), refusing);
    await exporter.submit(input as Parameters<Exporter['submit']>[0]);
    await exporter.idle();
    let record = service.db.get<any>('exports', input.export_id);
    assert.equal(record.snapshot.items[0].error.code, 'EXPORT_CONFLICT');
    assert.deepEqual(await leftovers(outputs), []);
    assert.deepEqual(record.temps, {});

    // A retry records a fresh temp, publishes, and removes the temp again.
    exporter = new Exporter(service.db, new Roots([outputs]));
    await exporter.submit(input as Parameters<Exporter['submit']>[0]);
    await exporter.idle();
    record = service.db.get<any>('exports', input.export_id);
    assert.equal(record.snapshot.state, 'succeeded');
    assert.deepEqual(await leftovers(outputs), []);
    assert.deepEqual(record.temps, {});
    const target = record.snapshot.items[0].path;

    // A crash after the receipt but before cleanup: startup removes the temp silently.
    const leftover = path.join(outputs, `.${input.export_id}-leftover.part`);
    await copyFile(target, leftover);
    record.temps[artifact_id] = leftover;
    service.db.put('exports', input.export_id, record);
    exporter = new Exporter(service.db, new Roots([outputs]));
    exporter.recover();
    await exporter.idle();
    const swept = service.db.get<any>('exports', input.export_id);
    assert.equal(await exists(leftover), false);
    assert.deepEqual(swept.temps, {});
    assert.equal(swept.snapshot.revision, record.snapshot.revision);

    // A temp hard-linked to the target of an unexported item is kept, then adopted.
    swept.snapshot.state = 'failed';
    swept.snapshot.items[0] = {
      ...swept.snapshot.items[0],
      state: 'failed',
      path: null,
      sha256: null,
      error: { code: 'IO_ERROR', message: 'IO_ERROR', retryable: true, next_action: 'wait' },
    };
    const evidence = path.join(outputs, `.${input.export_id}-evidence.part`);
    await link(target, evidence);
    swept.temps[artifact_id] = evidence;
    service.db.put('exports', input.export_id, swept);
    exporter = new Exporter(service.db, new Roots([outputs]));
    exporter.recover();
    await exporter.idle();
    assert.equal(await exists(evidence), true);
    await exporter.submit(input as Parameters<Exporter['submit']>[0]);
    await exporter.idle();
    const adopted = service.db.get<any>('exports', input.export_id);
    assert.equal(adopted.snapshot.state, 'succeeded');
    assert.equal(adopted.snapshot.items[0].path, target);
    assert.deepEqual(await leftovers(outputs), []);
    assert.deepEqual(await readdir(outputs), [path.basename(target)]);
  } finally {
    await service.close();
  }
});

test('downloads are removed once a job is final, and kept while a web run may continue', async () => {
  const env = await setup();
  let service = env.service;
  const eventually = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 3000;
    while (!(await check())) {
      if (Date.now() > deadline) throw Error('cleanup condition timeout');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const downloads = (jobId: string) => path.join(env.directory, 'downloads', jobId);
  try {
    const succeeded = await env.submit();
    assert.equal(succeeded.state, 'succeeded');
    await eventually(async () => !(await exists(downloads(succeeded.job_id))));
    const listed = await service.call('web_image_artifacts', { job_id: succeeded.job_id });
    assert.equal(listed.ok, true, JSON.stringify(listed));

    // The second file is refused: the job stays open with its first download on disk.
    env.plan.count = 2;
    env.plan.outside = true;
    const open = await env.submit();
    assert.equal(open.state, 'unknown');
    assert.equal(await exists(downloads(open.job_id)), true);
    const canceled = (
      (await service.call('web_image_control', {
        request_id: randomUUID(),
        job_id: open.job_id,
        expected_revision: open.revision,
        action: 'cancel',
      })) as { data: { job: { revision: number; remote_may_continue: boolean } } }
    ).data.job;
    assert.equal(canceled.remote_may_continue, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await exists(downloads(open.job_id)), true);
    await service.releaseRemote(open.job_id, canceled.revision);
    await eventually(async () => !(await exists(downloads(open.job_id))));

    // Leftovers from a crash are swept at startup; unknown directories are not touched.
    await mkdir(downloads(succeeded.job_id), { recursive: true });
    await writeFile(path.join(downloads(succeeded.job_id), 'stale.png'), 'stale');
    const foreign = [downloads('not-a-job'), downloads(randomUUID())];
    for (const directory of foreign) await mkdir(directory, { recursive: true });
    await service.close();
    service = new BridgeService(env.options);
    await service.ready;
    await eventually(async () => !(await exists(downloads(succeeded.job_id))));
    for (const directory of foreign) assert.equal(await exists(directory), true);
  } finally {
    await service.close();
  }
});
