import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeService } from '../../packages/core/src/service';
import { Operations } from '../../apps/desktop/src/operations';
import { ExecutionInterrupted } from '../../packages/core/src/model';
import type { ExecutionContext, ExecutionPort } from '../../packages/core/src/engine';

const request = () => ({ request_id: randomUUID(), mode: 'generate', prompt: 'M3 local fixture' });
async function call(service: BridgeService, name: string, input: unknown): Promise<any> {
  const result = await service.call(`web_image_${name}`, input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
async function setup(port?: ExecutionPort) {
  await mkdir('.local/tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('.local/tests/m3-'));
  const service = new BridgeService({ directory, inputRoots: [], exportRoots: [], port });
  await service.ready;
  return service;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('M3 condition timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
class HeldPort implements ExecutionPort {
  version = 'local-m3';
  starts = 0;
  sends = 0;
  interruptCount = 0;
  complete = false;
  private release?: () => void;
  phase: 'prepare' | 'sending' | 'confirmed' = 'confirmed';
  async run(context: ExecutionContext) {
    this.starts++;
    if (context.job().snapshot.submission_state === 'not_sent' && this.phase !== 'prepare') {
      await context.beforeSend({});
      this.sends++;
    }
    if (this.phase === 'confirmed')
      await context.confirm({
        conversation_url: `https://chatgpt.com/c/${context.job().snapshot.job_id}`,
        message_id: 'user',
      });
    await new Promise<void>((r) => {
      this.release = r;
    });
    throw new ExecutionInterrupted();
  }
  interrupt() {
    this.interruptCount++;
    this.release?.();
  }
  async remoteComplete() {
    return this.complete;
  }
}
test('M3 manual takeover fences a running worker; release rechecks; sending refuses takeover', async () => {
  const port = new HeldPort(),
    service = await setup(port);
  try {
    const job = (await call(service, 'submit', request())).job;
    await until(() => service.engine.job(job.job_id).snapshot.submission_state === 'confirmed');
    const session = service.engine.session(job.session_id);
    const manual = await call(service, 'session', {
      request_id: randomUUID(),
      action: 'takeover',
      session_id: session.session_id,
      expected_revision: session.revision,
    });
    assert.equal(manual.session.control_owner, 'manual');
    assert.equal(service.engine.job(job.job_id).snapshot.state, 'waiting_user');
    const starts = port.starts;
    await call(service, 'submit', request());
    await service.engine.idle();
    assert.equal(port.starts, starts);
    await call(service, 'session', {
      request_id: randomUUID(),
      action: 'release',
      session_id: session.session_id,
      expected_revision: manual.session.revision,
    });
    await until(() => port.starts === starts + 1);
    assert.equal(port.sends, 1);
  } finally {
    await service.close();
  }
  const sending = new HeldPort();
  sending.phase = 'sending';
  const second = await setup(sending);
  try {
    const job = (await call(second, 'submit', request())).job;
    await until(() => second.engine.job(job.job_id).snapshot.submission_state === 'sending');
    const session = second.engine.session(job.session_id);
    const rejected = await second.call('web_image_session', {
      request_id: randomUUID(),
      action: 'takeover',
      session_id: session.session_id,
      expected_revision: session.revision,
    });
    assert.equal(rejected.ok, false);
    assert.equal((rejected.error as any).code, 'STATE_CONFLICT');
  } finally {
    await second.close();
  }
});
test('M3 durable queue pause, drain admission fence, receipt replay and prompt shutdown', async () => {
  const service = await setup(),
    options = service.options;
  const operations = new Operations(service, () => {});
  await operations.command('pause-queue');
  const input = request();
  const accepted = await call(service, 'submit', input);
  const originalSession = service.engine.session(accepted.job.session_id);
  await call(service, 'session', {
    request_id: randomUUID(),
    action: 'takeover',
    session_id: originalSession.session_id,
    expected_revision: originalSession.revision,
  });
  const other = (await call(service, 'session', { request_id: randomUUID(), action: 'create' }))
    .session;
  assert.equal(
    (
      await service.call('web_image_session', {
        request_id: randomUUID(),
        action: 'takeover',
        session_id: other.session_id,
        expected_revision: other.revision,
      })
    ).ok,
    false,
  );
  assert.equal(operations.snapshot().session?.session_id, originalSession.session_id);
  await service.close();
  const restored = new BridgeService(options);
  await restored.ready;
  try {
    assert.equal(restored.engine.paused, true);
    restored.drain();
    assert.equal(restored.engine.session(originalSession.session_id).control_owner, 'manual');
    assert.equal((await call(restored, 'submit', input)).deduplicated, true);
    assert.equal((await restored.call('web_image_submit', request())).ok, false);
  } finally {
    await restored.close();
  }
  const port = new HeldPort(),
    held = await setup(port);
  await call(held, 'submit', request());
  await until(() => port.sends === 1);
  const at = Date.now();
  await held.close();
  assert.ok(Date.now() - at < 1500);
});
test('M3 suspend/resume and cancellation keep exactly one submit; canceled completion releases queue', async () => {
  const port = new HeldPort(),
    service = await setup(port),
    operations = new Operations(service, () => {});
  try {
    const job = (await call(service, 'submit', request())).job;
    await until(() => service.engine.job(job.job_id).snapshot.submission_state === 'confirmed');
    await operations.suspend('OS_SUSPENDED');
    await operations.suspend('NETWORK_OFFLINE');
    assert.equal(service.engine.job(job.job_id).snapshot.state, 'reconciling');
    await operations.resume('OS_SUSPENDED');
    assert.equal(service.engine.suspended, 'NETWORK_OFFLINE');
    await operations.resume('NETWORK_OFFLINE');
    await until(() => port.starts === 2);
    assert.equal(port.sends, 1);
    let current = service.engine.job(job.job_id).snapshot;
    await call(service, 'control', {
      request_id: randomUUID(),
      job_id: job.job_id,
      expected_revision: current.revision,
      action: 'cancel',
    });
    await service.engine.idle();
    assert.equal(service.engine.job(job.job_id).snapshot.remote_may_continue, true);
    const next = (await call(service, 'submit', request())).job;
    await service.engine.idle();
    assert.equal(port.starts, 2);
    port.complete = true;
    current = service.engine.job(job.job_id).snapshot;
    await call(service, 'control', {
      request_id: randomUUID(),
      job_id: job.job_id,
      expected_revision: current.revision,
      action: 'reconcile',
    });
    await until(() => port.starts === 3);
    assert.equal(service.engine.job(job.job_id).snapshot.state, 'canceled');
    assert.equal(service.engine.job(job.job_id).snapshot.remote_may_continue, false);
    assert.equal(service.engine.job(next.job_id).snapshot.state, 'running');
  } finally {
    await service.close();
  }
});
test('M3 evidence-less canceled submission holds the queue until the user attests release', async () => {
  const port = new HeldPort();
  port.phase = 'sending';
  const service = await setup(port),
    operations = new Operations(service, () => {});
  try {
    const job = (await call(service, 'submit', request())).job;
    await until(() => service.engine.job(job.job_id).snapshot.submission_state === 'sending');
    await operations.command('cancel');
    await service.engine.idle();
    assert.equal(service.engine.job(job.job_id).snapshot.remote_may_continue, true);
    const next = (await call(service, 'submit', request())).job;
    operations.recheckRemote();
    await service.engine.idle();
    assert.equal(service.engine.job(next.job_id).snapshot.state, 'queued');
    assert.equal((await call(service, 'status', {})).queue.dispatch_blocked, true);
    const stale = operations.snapshot();
    await call(service, 'status', {});
    await assert.rejects(
      service.releaseRemote(job.job_id, stale.job!.revision - 1),
      /REVISION_CONFLICT/,
    );
    await operations.command('release-remote', stale);
    const released = service.engine.job(job.job_id).snapshot;
    assert.equal(released.state, 'canceled');
    assert.equal(released.remote_may_continue, false);
    assert.equal(port.sends, 1);
    await until(() => service.engine.job(next.job_id).snapshot.submission_state === 'sending');
    assert.equal(port.sends, 2);
    const running = service.engine.job(next.job_id).snapshot;
    await assert.rejects(service.releaseRemote(next.job_id, running.revision), /STATE_CONFLICT/);
  } finally {
    await service.close();
  }
});
test('M3 page observation rechecks a canceled confirmed run without a new request', async () => {
  const port = new HeldPort(),
    service = await setup(port),
    operations = new Operations(service, () => {});
  try {
    const job = (await call(service, 'submit', request())).job;
    await until(() => service.engine.job(job.job_id).snapshot.submission_state === 'confirmed');
    await operations.command('cancel');
    await service.engine.idle();
    operations.recheckRemote();
    await service.engine.idle();
    assert.equal(service.engine.job(job.job_id).snapshot.remote_may_continue, true);
    port.complete = true;
    operations.recheckRemote();
    await until(() => !service.engine.job(job.job_id).snapshot.remote_may_continue);
    assert.equal(service.engine.active(), undefined);
  } finally {
    await service.close();
  }
});
