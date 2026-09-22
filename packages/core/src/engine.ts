import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { stateModel, validDefinition } from '../../contracts/src';
import { Database } from '../../storage/src/database';
import {
  Fault,
  Serial,
  now,
  ExecutionInterrupted,
  type Job,
  type Session,
  type JobRecord,
  type Event,
  type BridgeError,
  type DownloadedFile,
  type SubmissionAttempt,
} from './model';
import type { ContractTypes } from '../../contracts/src';

export interface ExecutionContext {
  job(): JobRecord;
  session(): Session;
  parent(): JobRecord | undefined;
  check(): void;
  attempt(): SubmissionAttempt | undefined;
  checkpoint(value: unknown): Promise<void>;
  complete(files: DownloadedFile[]): Promise<void>;
  fail(error: BridgeError): Promise<void>;
  phase(phase: Job['phase']): Promise<void>;
  beforeSend(baseline: unknown): Promise<string>;
  confirm(evidence: { conversation_url: string; message_id: string }): Promise<void>;
  waitForUser(error: BridgeError): Promise<void>;
}
export interface ExecutionPort {
  version: string;
  run(context: ExecutionContext, recovering: boolean): Promise<void>;
  interrupt?(): void;
  remoteComplete?(job: JobRecord, session: Session, attempt?: SubmissionAttempt): Promise<boolean>;
  observe?(): Pick<ContractTypes['status_data'], 'capabilities'> & {
    auth_state: ContractTypes['status_data']['profile']['auth_state'];
    verified_at: string | null;
  };
}
export class Engine {
  readonly serial = new Serial();
  readonly changes = new EventEmitter();
  private working: Promise<void> | undefined;
  private stopping = false;
  private requested = false;
  suspended: string | null = null;
  get paused() {
    return this.db.get<boolean>('metadata', 'dispatch_paused') ?? false;
  }
  setPaused(value: boolean) {
    this.db.put('metadata', 'dispatch_paused', value);
    this.changes.emit('operations');
    if (!value) this.kick();
  }
  async suspend(reason: string) {
    this.suspended = reason;
    this.port?.interrupt?.();
    await this.idle();
    this.changes.emit('operations');
  }
  resume() {
    this.suspended = null;
    this.changes.emit('operations');
    this.kick();
  }
  interrupt() {
    this.port?.interrupt?.();
  }
  constructor(
    readonly db: Database,
    readonly port?: ExecutionPort,
    private readonly complete?: (id: string, files: DownloadedFile[]) => Promise<void>,
  ) {
    this.changes.setMaxListeners(0);
  }
  job(id: string): JobRecord {
    const value = this.db.get<JobRecord>('jobs', id);
    if (!value) throw new Fault('NOT_FOUND');
    return value;
  }
  session(id: string): Session {
    const value = this.db.get<Session>('sessions', id);
    if (!value) throw new Fault('NOT_FOUND');
    return value;
  }
  jobs(): JobRecord[] {
    return this.db.all<JobRecord>('jobs');
  }
  active(): JobRecord | undefined {
    return this.jobs().find(
      (j) =>
        (!j.snapshot.terminal && j.snapshot.state !== 'queued') || j.snapshot.remote_may_continue,
    );
  }
  update(id: string, patch: Partial<Job>, kind: Event['kind'] = 'state_changed'): Job {
    const record = this.job(id),
      old = record.snapshot;
    const next = { ...old, ...patch } as Job;
    if (
      next.state !== old.state &&
      !stateModel.transitions.some((t) => t.from === old.state && t.to === next.state)
    )
      throw new Fault('STATE_CONFLICT');
    if (
      next.submission_state !== old.submission_state &&
      !stateModel.submission_transitions.some(
        (t) => t.from === old.submission_state && t.to === next.submission_state,
      )
    )
      throw new Fault('STATE_CONFLICT');
    next.terminal = stateModel.terminal.includes(next.state);
    next.requires_action = next.state === 'waiting_user' || next.state === 'unknown';
    if (next.terminal) next.phase = 'complete';
    if (JSON.stringify(next) === JSON.stringify(old)) return old;
    next.revision = old.revision + 1;
    next.updated_at = now();
    if (!validDefinition('job', next)) throw Error('Invalid internal job transition');
    record.snapshot = next;
    this.db.put('jobs', id, record);
    this.db.event(id, next.revision, {
      revision: next.revision,
      at: next.updated_at,
      kind,
      state: next.state,
      phase: next.phase,
      submission_state: next.submission_state,
    });
    const session = this.session(next.session_id);
    const active = !next.terminal || next.remote_may_continue;
    if (!active && session.active_job_id === id) {
      session.active_job_id = null;
      session.revision++;
      this.db.put('sessions', session.session_id, session);
    }
    // Notification is deferred until the surrounding synchronous transaction commits.
    queueMicrotask(() => {
      this.changes.emit(id);
      this.changes.emit('changed', id);
    });
    return next;
  }
  recover() {
    this.db.transaction(() => {
      for (const { snapshot: job } of this.jobs()) {
        if (job.state === 'running') this.update(job.job_id, { state: 'reconciling' });
        if (job.submission_state === 'sending' && !job.terminal) {
          this.update(
            job.job_id,
            { submission_state: 'unknown', remote_may_continue: true },
            'submission_changed',
          );
        }
      }
    });
  }
  kick() {
    if (this.stopping || !this.port) return;
    this.requested = true;
    if (this.working) return;
    this.working = Promise.resolve()
      .then(async () => {
        do {
          this.requested = false;
          await this.dispatch();
        } while (this.requested && !this.stopping);
      })
      .finally(() => {
        this.working = undefined;
        if (this.requested && !this.stopping) this.kick();
      });
  }
  async idle() {
    while (this.working) await this.working;
  }
  async stop() {
    this.stopping = true;
    this.port?.interrupt?.();
    await this.working;
  }
  private async dispatch() {
    while (!this.stopping && !this.suspended) {
      const selected = await this.serial.run(() =>
        this.db.transaction(() => {
          const active = this.active();
          if (
            active?.snapshot.terminal &&
            active.snapshot.remote_may_continue &&
            this.port?.remoteComplete &&
            this.session(active.snapshot.session_id).control_owner === 'automation'
          )
            return { id: active.snapshot.job_id, reconcile: true, canceled: true };
          if (active && active.snapshot.state !== 'reconciling') return;
          if (this.db.all<Session>('sessions').some((s) => s.control_owner === 'manual')) return;
          if (!active && this.paused) return;
          const record = active ?? this.jobs().find((j) => j.snapshot.state === 'queued');
          if (!record) return;
          const id = record.snapshot.job_id;
          const session = this.session(record.snapshot.session_id);
          if (session.active_job_id !== id) {
            session.active_job_id = id;
            session.revision++;
            this.db.put('sessions', session.session_id, session);
          }
          if (record.snapshot.state === 'queued') this.update(id, { state: 'running' });
          return { id, reconcile: record.snapshot.state === 'reconciling' };
        }),
      );
      if (!selected) return;
      const { id, reconcile } = selected;
      if ('canceled' in selected) {
        const record = this.job(id);
        const complete = await this.port!.remoteComplete!(
          record,
          this.session(record.snapshot.session_id),
          this.db.get('attempts', id),
        ).catch(() => false);
        if (!complete) return;
        await this.serial.run(() =>
          this.db.transaction(() => {
            if (this.job(id).snapshot.terminal) this.update(id, { remote_may_continue: false });
          }),
        );
        continue;
      }
      try {
        await this.port!.run(this.context(id), reconcile);
      } catch {
        await this.serial.run(() =>
          this.db.transaction(() => {
            const j = this.job(id).snapshot;
            if (j.terminal || j.requires_action) return;
            if (this.stopping || this.suspended) {
              if (j.state === 'running') this.update(id, { state: 'reconciling' });
              if (j.submission_state === 'sending')
                this.update(id, { submission_state: 'unknown', remote_may_continue: true });
              return;
            }
            if (j.submission_state !== 'not_sent') {
              if (j.state === 'running') this.update(id, { state: 'reconciling' });
              this.update(id, {
                state: 'unknown',
                submission_state: j.submission_state === 'confirmed' ? 'confirmed' : 'unknown',
                remote_may_continue: true,
                error: {
                  code: 'SUBMISSION_UNKNOWN',
                  message: 'Existing submission needs reconciliation.',
                  retryable: false,
                  next_action: 'reconcile',
                },
              });
            } else
              this.update(id, {
                state: 'waiting_user',
                error: {
                  code: 'ADAPTER_UNAVAILABLE',
                  message: 'Adapter could not complete preparation.',
                  retryable: true,
                  next_action: 'resume',
                },
              });
          }),
        );
      }
      if (this.stopping || this.suspended) return;
      // An adapter that returns without finishing must not spin or silently start another job.
      if (
        this.job(id).snapshot.state === 'running' ||
        this.job(id).snapshot.state === 'reconciling'
      ) {
        await this.context(id).waitForUser({
          code: 'ADAPTER_UNAVAILABLE',
          message: 'Adapter did not finish observation.',
          retryable: true,
          next_action: 'resume',
        });
      }
    }
  }
  private context(id: string): ExecutionContext {
    const guard = () => {
      const job = this.job(id).snapshot;
      if (
        this.stopping ||
        this.suspended ||
        job.terminal ||
        job.requires_action ||
        this.session(job.session_id).control_owner !== 'automation'
      )
        throw new ExecutionInterrupted();
      return job;
    };
    return {
      job: () => this.job(id),
      session: () => this.session(this.job(id).snapshot.session_id),
      parent: () => {
        const parent = this.job(id).request.parent_job_id;
        return parent ? this.job(parent) : undefined;
      },
      check: () => {
        guard();
      },
      attempt: () => this.db.get<SubmissionAttempt>('attempts', id),
      checkpoint: (value) =>
        this.serial.run(() =>
          this.db.transaction(() => {
            guard();
            const record = this.job(id);
            record.browser_state = value;
            this.db.put('jobs', id, record);
          }),
        ),
      complete: async (files) => {
        guard();
        if (!this.complete) throw new Fault('ADAPTER_UNAVAILABLE');
        await this.complete(id, files);
      },
      fail: (error) =>
        this.serial.run(() =>
          this.db.transaction(() => {
            guard();
            this.update(id, { state: 'failed', remote_may_continue: false, error });
          }),
        ),
      phase: (phase) =>
        this.serial.run(() =>
          this.db.transaction(() => {
            guard();
            this.update(id, { phase }, 'phase_changed');
          }),
        ),
      beforeSend: (baseline) =>
        this.serial.run(() =>
          this.db.transaction(() => {
            const job = guard();
            if (
              this.job(id).observation_only ||
              job.submission_state !== 'not_sent' ||
              this.db.get('attempts', id)
            )
              throw new Fault('STATE_CONFLICT');
            const attempt = randomUUID();
            this.db.insert('attempts', id, {
              attempt_id: attempt,
              baseline,
              at: now(),
              prompt_sha256: createHash('sha256')
                .update(this.job(id).request.prompt, 'utf8')
                .digest('hex'),
              inputs: this.job(id).inputs.map((i) => ({ ordinal: i.ordinal, sha256: i.sha256 })),
            });
            if (job.state === 'reconciling') this.update(id, { state: 'running' });
            this.update(
              id,
              { phase: 'submit', submission_state: 'sending', remote_may_continue: true },
              'submission_changed',
            );
            return attempt;
          }),
        ),
      confirm: (evidence) =>
        this.serial.run(() =>
          this.db.transaction(() => {
            const job = guard();
            if (
              !validDefinition('conversation_url', evidence.conversation_url) ||
              !evidence.message_id
            )
              throw new Fault('STATE_CONFLICT');
            const attempt = this.db.get<Record<string, unknown>>('attempts', id);
            if (!attempt) throw new Fault('STATE_CONFLICT');
            if (attempt.evidence && JSON.stringify(attempt.evidence) !== JSON.stringify(evidence))
              throw new Fault('STATE_CONFLICT');
            const session = this.session(job.session_id);
            if (session.conversation_url && session.conversation_url !== evidence.conversation_url)
              throw new Fault('STATE_CONFLICT');
            if (session.conversation_url !== evidence.conversation_url) {
              session.conversation_url = evidence.conversation_url;
              session.revision++;
              this.db.put('sessions', session.session_id, session);
            }
            this.db.put('attempts', id, { ...attempt, evidence });
            if (job.state === 'reconciling') this.update(id, { state: 'running' });
            this.update(
              id,
              { submission_state: 'confirmed', phase: 'generate' },
              'submission_changed',
            );
          }),
        ),
      waitForUser: (error) =>
        this.serial.run(() =>
          this.db.transaction(() => {
            const job = this.job(id).snapshot;
            if (!job.terminal) this.update(id, { state: 'waiting_user', error }, 'error_changed');
          }),
        ),
    };
  }
}
