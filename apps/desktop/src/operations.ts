import { randomUUID } from 'node:crypto';
import type { BridgeService } from '../../../packages/core/src/service';
import { Fault } from '../../../packages/core/src/model';

export class Operations {
  private interruptions = new Set<string>();
  private suspended = Promise.resolve();
  private checkingDrain = false;
  constructor(
    readonly service: BridgeService,
    private quit: () => void,
  ) {}
  snapshot() {
    const sessions =
      this.service.db.all<import('../../../packages/core/src/model').Session>('sessions');
    const manual = sessions.find((session) => session.control_owner === 'manual');
    const job =
      this.service.engine.active()?.snapshot ??
      (manual
        ? this.service.engine
            .jobs()
            .filter((job) => job.snapshot.session_id === manual.session_id)
            .at(-1)?.snapshot
        : this.service.engine.jobs().at(-1)?.snapshot) ??
      null;
    const session = job
      ? this.service.engine.session(job.session_id)
      : (manual ?? sessions.at(-1) ?? null);
    return {
      job,
      session,
      paused: this.service.engine.paused,
      suspended: this.service.engine.suspended,
      draining: this.service.draining,
      waiting_count: this.service.engine.jobs().filter((j) => j.snapshot.state === 'queued').length,
    };
  }
  async command(action: string, expected = this.snapshot()) {
    const current = this.snapshot();
    if (
      ['takeover', 'release', 'cancel', 'resume-job', 'reconcile', 'release-remote'].includes(
        action,
      ) &&
      (expected.job?.job_id !== current.job?.job_id ||
        expected.job?.revision !== current.job?.revision ||
        expected.session?.session_id !== current.session?.session_id ||
        expected.session?.revision !== current.session?.revision)
    )
      throw new Fault('REVISION_CONFLICT');
    let result: Record<string, unknown> | undefined;
    if (action === 'pause-queue') this.service.engine.setPaused(true);
    else if (action === 'resume-queue') {
      if (this.service.draining) throw new Fault('STATE_CONFLICT');
      this.service.engine.setPaused(false);
    } else if (action === 'takeover' || action === 'release') {
      if (!current.session) throw new Fault('NOT_FOUND');
      result = await this.service.call('web_image_session', {
        action,
        request_id: randomUUID(),
        session_id: current.session.session_id,
        expected_revision: current.session.revision,
      });
    } else if (['cancel', 'resume-job', 'reconcile'].includes(action)) {
      if (!current.job) throw new Fault('NOT_FOUND');
      result = await this.service.call('web_image_control', {
        action: action === 'resume-job' ? 'resume' : action,
        request_id: randomUUID(),
        job_id: current.job.job_id,
        expected_revision: current.job.revision,
      });
    } else if (action === 'release-remote') {
      if (!current.job) throw new Fault('NOT_FOUND');
      await this.service.releaseRemote(current.job.job_id, current.job.revision);
    } else if (action === 'quit-after') {
      this.service.drain();
      void this.checkDrain();
    } else if (action === 'quit-now') {
      this.service.prepareShutdown();
      this.quit();
    } else throw new Fault('INPUT_INVALID');
    if (result && !result.ok) throw new Fault((result.error as any).code);
  }
  // A canceled web run may finish later; recheck it instead of waiting for the next request.
  recheckRemote() {
    const job = this.service.engine.active()?.snapshot;
    if (job?.terminal && job.remote_may_continue) this.service.engine.kick();
  }
  async checkDrain() {
    if (!this.service.draining || this.checkingDrain) return;
    this.checkingDrain = true;
    try {
      if (await this.service.drainComplete()) this.quit();
    } finally {
      this.checkingDrain = false;
    }
  }
  async suspend(reason: string) {
    this.interruptions.add(reason);
    this.suspended = this.service.engine.suspend(reason);
    await this.suspended;
    if (reason === 'ADAPTER_UNAVAILABLE')
      await this.service.engine.serial.run(() =>
        this.service.db.transaction(() => {
          const job = this.service.engine.active()?.snapshot;
          if (job && !job.terminal && job.state === 'reconciling')
            this.service.engine.update(job.job_id, {
              state: 'waiting_user',
              error: {
                code: 'ADAPTER_UNAVAILABLE',
                message: 'Reconnect the app debugger before reconciliation.',
                retryable: true,
                next_action: 'reconcile',
              },
            });
        }),
      );
  }
  async resume(reason: string) {
    this.interruptions.delete(reason);
    await this.suspended;
    if (reason === 'ADAPTER_UNAVAILABLE')
      await this.service.engine.serial.run(() =>
        this.service.db.transaction(() => {
          const job = this.service.engine.active()?.snapshot;
          if (
            job?.state === 'waiting_user' &&
            job.error?.code === 'ADAPTER_UNAVAILABLE' &&
            this.service.engine.session(job.session_id).control_owner === 'automation'
          )
            this.service.engine.update(job.job_id, { state: 'reconciling', error: null });
        }),
      );
    if (!this.interruptions.size) this.service.engine.resume();
    else this.service.engine.suspended = [...this.interruptions][0]!;
  }
}
