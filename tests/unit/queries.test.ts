import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BridgeService } from '../../packages/core/src/service';
import { where, type Lookup } from '../../packages/storage/src/database';

async function setup() {
  await mkdir('.local/tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('.local/tests/queries-'));
  const service = new BridgeService({ directory, inputRoots: [], exportRoots: [] });
  await service.ready;
  return { directory, service };
}
async function submit(service: BridgeService) {
  const result = await service.call('web_image_submit', {
    request_id: randomUUID(),
    mode: 'generate',
    prompt: 'query fixture',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result.data as { job: { job_id: string; request_id: string; session_id: string } }).job;
}

test('indexed job lookups keep queue order and match full scans', async () => {
  const { service } = await setup();
  try {
    const jobs = [await submit(service), await submit(service), await submit(service)];
    const ids = jobs.map((job) => job.job_id);
    assert.deepEqual(
      service.engine.queued().map((j) => j.snapshot.job_id),
      ids,
    );
    assert.deepEqual(
      service.engine.latest(2).map((j) => j.snapshot.job_id),
      [ids[2], ids[1]],
    );
    // Updating a job must not move it in rowid order.
    service.db.transaction(() => service.engine.update(ids[0]!, { state: 'running' }));
    assert.deepEqual(
      service.engine.queued().map((j) => j.snapshot.job_id),
      ids.slice(1),
    );
    assert.equal(service.engine.active()?.snapshot.job_id, ids[0]);
    assert.equal(service.engine.byRequest(jobs[1]!.request_id)?.snapshot.job_id, ids[1]);
    assert.equal(service.engine.byRequest(randomUUID()), undefined);
    assert.deepEqual(
      service.engine.bySession(jobs[2]!.session_id).map((j) => j.snapshot.job_id),
      [ids[2]],
    );
    service.db.transaction(() =>
      service.engine.update(ids[0]!, { state: 'canceled' }, 'control_applied'),
    );
    assert.equal(service.engine.active(), undefined);
    assert.equal(service.engine.openJobs().length, 2);
    assert.equal(service.engine.jobs().length, 3);
    const status = await service.call('web_image_status', {});
    assert.equal((status.data as any).queue.waiting_count, 2);
    assert.equal(service.engine.manualSession(), undefined);
    const session = service.engine.session(jobs[2]!.session_id);
    session.control_owner = 'manual';
    service.db.put('sessions', session.session_id, session);
    assert.equal(service.engine.manualSession()?.session_id, session.session_id);
  } finally {
    await service.close();
  }
});

test('hot lookups use their indexes instead of scanning every row', async () => {
  const { directory, service } = await setup();
  await service.close();
  const db = new DatabaseSync(path.join(directory, 'state', 'jobs.sqlite'), { readOnly: true });
  try {
    // INDEXED BY raises "no query solution" when a predicate stops matching its index.
    const plan = (table: string, lookup: Lookup, ...params: string[]) =>
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT value FROM ${table} INDEXED BY ${lookup.index} WHERE ${lookup.sql} ORDER BY rowid`,
        )
        .all(...params)
        .map((row) => String(row['detail']))
        .join(' | ');
    assert.match(plan('jobs', where.openJob), /USING INDEX job_open/);
    assert.match(plan('jobs', where.jobSession, 'x'), /USING INDEX job_session/);
    assert.match(plan('jobs', where.jobRequest, 'x'), /USING INDEX job_request/);
    assert.match(plan('sessions', where.manualSession), /USING INDEX session_manual/);
    assert.match(plan('exports', where.copyingExport), /USING INDEX export_copying/);
    assert.throws(
      () =>
        plan('jobs', {
          sql: "json_extract(value, '$.snapshot.state') = 'queued'",
          index: 'job_open',
        }),
      /no query solution/,
    );
  } finally {
    db.close();
  }
});
