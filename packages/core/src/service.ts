import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { validTool, type ContractTypes } from '../../contracts/src';
import { Database } from '../../storage/src/database';
import { Roots, stageChecked } from '../../storage/src/roots';
import { inspectImage } from '../../storage/src/files';
import { Exporter } from '../../storage/src/exporter';
import { ArtifactStore } from '../../storage/src/artifacts';
import { Engine, type ExecutionPort } from './engine';
import {
  Fault,
  digest,
  withoutKey,
  now,
  failure,
  Serial,
  type Session,
  type Job,
  type JobRecord,
  type StoredInput,
  type Submit,
  type Receipt,
  type Event,
  type Artifact,
} from './model';

interface Admission {
  digest: string;
  job_id: string;
  request: Submit;
  inputs: StoredInput[];
}
export interface AppView {
  setVisible(visible: boolean, session?: Session): void | Promise<void>;
  setManual(manual: boolean, session?: Session): void | Promise<void>;
}
export interface ServiceOptions {
  directory: string;
  inputRoots: string[];
  exportRoots: string[];
  port?: ExecutionPort;
  view?: AppView;
}
export class BridgeService {
  readonly db: Database;
  readonly engine: Engine;
  readonly exporter: Exporter;
  readonly artifacts: ArtifactStore;
  readonly ready: Promise<void>;
  readonly profileId: string;
  private readonly inputs: Roots;
  private accepting = true;
  private configuring = false;
  // Serializes submits (idempotent admission and input staging). Always taken before
  // engine.serial, never while holding it.
  private readonly admissions = new Serial();
  // Download removal in the background, awaited only by close().
  private cleanup: Promise<void> = Promise.resolve();
  async configureFolders(
    inputRoots: string[],
    exportRoots: string[],
    persist: () => Promise<void>,
  ) {
    if (this.configuring) throw new Fault('STATE_CONFLICT');
    this.configuring = true;
    try {
      // The admission lock keeps roots from changing under a submit that is still staging.
      return await this.admissions.run(() =>
        this.engine.serial.run(async () => {
          if (!this.accepting || this.engine.openJobs().some((job) => !job.snapshot.terminal))
            throw new Fault('STATE_CONFLICT');
          await this.exporter.idle();
          await persist();
          this.options.inputRoots.splice(0, this.options.inputRoots.length, ...inputRoots);
          this.options.exportRoots.splice(0, this.options.exportRoots.length, ...exportRoots);
        }),
      );
    } finally {
      this.configuring = false;
    }
  }
  draining = false;
  prepareShutdown() {
    this.accepting = false;
    this.engine.changes.emit('shutdown');
  }
  drain() {
    this.accepting = false;
    this.draining = true;
    this.engine.setPaused(true);
  }
  async drainComplete() {
    await this.engine.idle();
    await this.exporter.idle();
    return !this.engine.active();
  }
  constructor(readonly options: ServiceOptions) {
    this.db = new Database(path.join(options.directory, 'state', 'jobs.sqlite'));
    this.profileId = this.db.get<string>('metadata', 'profile') ?? randomUUID();
    this.db.put('metadata', 'profile', this.profileId);
    this.inputs = new Roots(options.inputRoots);
    this.engine = new Engine(this.db, options.port, (id, files) =>
      this.artifacts.complete(id, files),
    );
    this.exporter = new Exporter(this.db, new Roots(options.exportRoots));
    this.artifacts = new ArtifactStore(options.directory, this.engine);
    this.engine.changes.on('changed', (id: string) => {
      this.cleanup = this.cleanup.then(() => this.artifacts.discardDownloads(id));
    });
    this.engine.recover();
    this.ready = this.artifacts.recover().then(() => {
      this.engine.kick();
      this.exporter.recover();
      // Removing leftovers can take a while after an update; it never delays startup.
      this.cleanup = this.cleanup.then(() => this.artifacts.sweepDownloads());
    });
  }
  async close() {
    this.prepareShutdown();
    // A failed startup must still release the database handle.
    await this.ready.catch(() => {});
    await this.engine.stop();
    await this.exporter.idle();
    await this.admissions.run(() => undefined); // A staging submit still writes its admission.
    await this.cleanup;
    await this.engine.serial.run(() => this.db.close());
  }
  async call(name: string, value: unknown): Promise<Record<string, unknown>> {
    try {
      await this.ready;
      if (
        this.configuring &&
        ['web_image_submit', 'web_image_export', 'web_image_control', 'web_image_session'].includes(
          name,
        )
      )
        throw new Fault('STATE_CONFLICT', 'wait');
      if (!validTool(name, 'input', value)) throw new Fault('INPUT_INVALID');
      let data: unknown;
      switch (name) {
        case 'web_image_status':
          data = this.status();
          break;
        case 'web_image_session':
          data = await this.sessionCommand(value as ContractTypes['session_input']);
          break;
        case 'web_image_submit':
          data = await this.submit(value as Submit);
          break;
        case 'web_image_get': {
          const input = value as ContractTypes['get_input'];
          const job = input.job_id
            ? this.engine.job(input.job_id)
            : this.engine.byRequest(input.request_id!);
          if (!job) throw new Fault('NOT_FOUND');
          data = { job: job.snapshot };
          break;
        }
        case 'web_image_wait':
          data = await this.wait(value as ContractTypes['wait_input']);
          break;
        case 'web_image_control':
          data = await this.control(value as ContractTypes['control_input']);
          break;
        case 'web_image_artifacts': {
          const job = this.engine.job((value as ContractTypes['artifacts_input']).job_id).snapshot;
          const artifacts = await Promise.all(job.artifact_ids.map((id) => this.artifact(id)));
          data = { job_id: job.job_id, artifacts };
          break;
        }
        case 'web_image_export':
          data = await this.exporter.submit(value as ContractTypes['export_input']);
          break;
        default:
          throw new Fault('NOT_FOUND');
      }
      const result = { schema_version: '0.1', ok: true, data };
      if (!validTool(name, 'output', result)) throw Error('Internal output contract violation');
      return result;
    } catch (error) {
      return { schema_version: '0.1', ok: false, error: failure(error) };
    }
  }
  private newSession(show = false): Session {
    const session: Session = {
      session_id: randomUUID(),
      profile_id: this.profileId,
      conversation_url: null,
      control_owner: 'automation',
      revision: 1,
      window_visible: show,
      active_job_id: null,
    };
    this.db.insert('sessions', session.session_id, session);
    return session;
  }
  private replay(kind: string, key: string, hash: string): Receipt | undefined {
    const receipt = this.db.get<Receipt>('receipts', `${kind}:${key}`);
    if (receipt && receipt.digest !== hash) throw new Fault('IDEMPOTENCY_CONFLICT');
    return receipt;
  }
  private async sessionCommand(raw: ContractTypes['session_input']) {
    const input = raw.action === 'create' ? { ...raw, show: raw.show ?? false } : raw;
    const result = await this.engine.serial.run(() =>
      this.db.transaction(() => {
        const hash = digest(withoutKey(input, 'request_id'));
        const receipt = this.replay('session', input.request_id, hash);
        if (receipt)
          return {
            deduplicated: true,
            outcome: receipt.outcome,
            session: this.engine.session(receipt.target),
          };
        const active = this.engine.active();
        const manual = this.engine.manualSession();
        if (
          manual &&
          (((input.action === 'takeover' || input.action === 'show') &&
            input.session_id !== manual.session_id) ||
            (input.action === 'create' && input.show))
        )
          throw new Fault('STATE_CONFLICT');
        let session: Session;
        let outcome: 'applied' | 'no_change' = 'applied';
        if (input.action === 'create') {
          if (input.show && active) throw new Fault('STATE_CONFLICT');
          session = this.newSession(input.show);
        } else {
          session = this.engine.session(input.session_id);
          if (active && active.snapshot.session_id !== session.session_id)
            throw new Fault('STATE_CONFLICT');
          const old = JSON.stringify(session);
          if (input.action === 'takeover' || input.action === 'release') {
            const owner = input.action === 'takeover' ? 'manual' : 'automation';
            if (session.control_owner !== owner) {
              if (session.revision !== input.expected_revision)
                throw new Fault('REVISION_CONFLICT');
              if (active?.snapshot.submission_state === 'sending')
                throw new Fault('STATE_CONFLICT', 'reconcile');
              session.control_owner = owner;
              if (active && !active.snapshot.terminal) {
                if (
                  owner === 'manual' &&
                  ['running', 'reconciling'].includes(active.snapshot.state)
                )
                  this.engine.update(active.snapshot.job_id, {
                    state: 'waiting_user',
                    error: {
                      code: 'STATE_CONFLICT',
                      message: 'Manual control owns this session.',
                      retryable: false,
                      next_action: 'resume',
                    },
                  });
                if (
                  owner === 'automation' &&
                  ['waiting_user', 'unknown'].includes(active.snapshot.state)
                ) {
                  active.observation_only = active.snapshot.submission_state !== 'not_sent';
                  this.db.put('jobs', active.snapshot.job_id, {
                    ...this.engine.job(active.snapshot.job_id),
                    observation_only: active.observation_only,
                  });
                  this.engine.update(active.snapshot.job_id, { state: 'reconciling', error: null });
                }
              }
            }
          } else session.window_visible = input.action === 'show';
          if (old === JSON.stringify(session)) outcome = 'no_change';
          else session.revision++;
          this.db.put('sessions', session.session_id, session);
        }
        this.db.insert('receipts', `session:${input.request_id}`, {
          digest: hash,
          target: session.session_id,
          outcome,
        });
        return { deduplicated: false, outcome, session };
      }),
    );
    if (input.action === 'takeover') {
      this.engine.interrupt();
      await this.engine.idle();
    }
    if (
      input.action === 'show' ||
      input.action === 'hide' ||
      (input.action === 'create' && input.show)
    )
      await this.options.view?.setVisible(result.session.window_visible, result.session);
    if (input.action === 'takeover' || input.action === 'release')
      await this.options.view?.setManual(result.session.control_owner === 'manual', result.session);
    this.engine.changes.emit('operations');
    this.engine.kick();
    return result;
  }
  private async submit(raw: Submit) {
    const input = {
      ...raw,
      inputs: raw.inputs ?? [],
      expected_output: { count: 1, require_alpha: false, strict: false, ...raw.expected_output },
    } as Submit;
    // Staging copies and decodes up to 80 MB. Only other submits wait on the admission lock;
    // the running job's checkpoints and user controls keep the engine lock meanwhile.
    return this.admissions.run(async () => {
      const hash = digest(withoutKey(input, 'request_id'));
      const receipt = this.replay('submit', input.request_id, hash);
      if (receipt)
        return {
          accepted: true,
          deduplicated: true,
          job: this.engine.job(receipt.target).snapshot,
        };
      if (!this.accepting) throw new Fault('STATE_CONFLICT', 'wait');
      let admission = this.db.get<Admission>('admissions', input.request_id);
      if (admission && admission.digest !== hash) throw new Fault('IDEMPOTENCY_CONFLICT');
      this.lineage(input);
      if (!admission) {
        admission = { digest: hash, job_id: randomUUID(), request: input, inputs: [] };
        this.db.insert('admissions', input.request_id, admission);
      }
      for (let index = 0; index < input.inputs!.length; index++) {
        const existing = admission.inputs[index];
        if (existing) {
          const checked = await inspectImage(existing.path, 20971520);
          if (checked.sha256 !== existing.sha256) throw new Fault('INPUT_INVALID');
          continue;
        }
        const descriptor = input.inputs![index]!;
        const artifact = descriptor.artifact_id
          ? await this.artifact(descriptor.artifact_id)
          : undefined;
        const source = artifact?.path ?? descriptor.path!;
        const staged = await stageChecked(
          {
            ...descriptor,
            expected_sha256: descriptor.expected_sha256 ?? artifact?.sha256,
          } as ContractTypes['input'],
          source,
          artifact ? new Roots([path.join(this.options.directory, 'artifacts')]) : this.inputs,
          path.join(this.options.directory, 'inputs', admission.job_id),
          index + 1,
        );
        staged.source = descriptor;
        admission.inputs.push(staged);
        this.db.put('admissions', input.request_id, admission);
      }
      if (admission.inputs.reduce((size, entry) => size + entry.bytes, 0) > 83886080)
        throw new Fault('INPUT_INVALID');
      const job = await this.engine.serial.run(() => {
        if (!this.accepting) throw new Fault('STATE_CONFLICT', 'wait');
        return this.db.transaction(() => {
          this.lineage(input); // Checked again with the job insert, not only before staging.
          const session = input.session_id
            ? this.engine.session(input.session_id)
            : this.newSession();
          const timestamp = now();
          const job: Job = {
            job_id: admission!.job_id,
            request_id: input.request_id,
            session_id: session.session_id,
            mode: input.mode,
            state: 'queued',
            phase: 'prepare',
            submission_state: 'not_sent',
            revision: 1,
            terminal: false,
            requires_action: false,
            remote_may_continue: false,
            artifact_ids: [],
            warnings: [],
            error: null,
            created_at: timestamp,
            updated_at: timestamp,
          };
          this.db.insert('jobs', job.job_id, {
            snapshot: job,
            request: input,
            inputs: admission!.inputs,
            digest: hash,
          });
          this.db.event(job.job_id, 1, {
            revision: 1,
            at: timestamp,
            kind: 'accepted',
            state: job.state,
            phase: job.phase,
            submission_state: job.submission_state,
          });
          this.db.insert('receipts', `submit:${input.request_id}`, {
            digest: hash,
            target: job.job_id,
            outcome: 'applied',
          });
          return job;
        });
      });
      this.engine.kick();
      return { accepted: true, deduplicated: false, job };
    });
  }
  private lineage(input: Submit) {
    if (input.session_id) {
      this.engine.session(input.session_id);
      const prior = this.engine.bySession(input.session_id);
      if (prior.length && !input.parent_job_id) throw new Fault('STATE_CONFLICT');
    }
    if (input.parent_job_id) {
      const parent = this.engine.job(input.parent_job_id).snapshot;
      if (
        parent.session_id !== input.session_id ||
        !['succeeded', 'partial'].includes(parent.state)
      )
        throw new Fault('STATE_CONFLICT');
    }
  }
  private async control(input: ContractTypes['control_input']) {
    return this.engine.serial.run(() =>
      this.db.transaction(() => {
        const hash = digest(withoutKey(input, 'request_id'));
        const receipt = this.replay('control', input.request_id, hash);
        if (receipt)
          return {
            deduplicated: true,
            outcome: receipt.outcome,
            job: this.engine.job(receipt.target).snapshot,
          };
        let job = this.engine.job(input.job_id).snapshot;
        let outcome: 'applied' | 'no_change' = 'applied';
        if (job.revision !== input.expected_revision) throw new Fault('REVISION_CONFLICT');
        if (job.terminal) {
          if (input.action === 'resume') throw new Fault('STATE_CONFLICT');
          outcome = 'no_change';
        } else if (input.action === 'cancel') {
          job = this.engine.update(
            job.job_id,
            { state: 'canceled', remote_may_continue: job.submission_state !== 'not_sent' },
            'control_applied',
          );
          if (this.engine.active()?.snapshot.job_id === job.job_id) this.engine.interrupt();
        } else {
          if (!['waiting_user', 'unknown'].includes(job.state)) throw new Fault('STATE_CONFLICT');
          if (this.engine.session(job.session_id).control_owner !== 'automation')
            throw new Fault('STATE_CONFLICT');
          if (input.action === 'resume' && job.submission_state === 'unknown')
            throw new Fault('SUBMISSION_UNKNOWN', 'reconcile');
          const record = this.engine.job(job.job_id);
          record.observation_only = input.action === 'reconcile';
          this.db.put('jobs', job.job_id, record);
          job = this.engine.update(
            job.job_id,
            { state: 'reconciling', error: null },
            'control_applied',
          );
        }
        this.db.insert('receipts', `control:${input.request_id}`, {
          digest: hash,
          target: job.job_id,
          outcome,
        });
        queueMicrotask(() => this.engine.kick());
        return { deduplicated: false, outcome, job };
      }),
    );
  }
  // Desktop-only attestation: the user checked the web page and no run of this job remains.
  // Evidence-less submissions can never be observed as complete, so this is their only exit.
  async releaseRemote(jobId: string, expectedRevision: number) {
    await this.engine.serial.run(() =>
      this.db.transaction(() => {
        const job = this.engine.job(jobId).snapshot;
        if (job.revision !== expectedRevision) throw new Fault('REVISION_CONFLICT');
        if (!job.terminal || !job.remote_may_continue) throw new Fault('STATE_CONFLICT');
        this.engine.update(jobId, { remote_may_continue: false }, 'control_applied');
      }),
    );
    this.engine.changes.emit('operations');
    this.engine.kick();
  }
  private async wait(input: ContractTypes['wait_input']) {
    const after = input.after_revision ?? 0;
    const timeout = input.timeout_ms ?? 25000;
    const current = () => this.engine.job(input.job_id).snapshot;
    let job = current();
    if (after > job.revision) throw new Fault('REVISION_CONFLICT');
    if (job.revision === after && !job.terminal && !job.requires_action && timeout > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.engine.changes.off(input.job_id, done);
          this.engine.changes.off('shutdown', done);
          resolve();
        };
        const timer = setTimeout(done, timeout);
        this.engine.changes.on(input.job_id, done);
        this.engine.changes.on('shutdown', done);
        if (current().revision !== after) done();
      });
    }
    job = current();
    let events = this.db.events<Event>(input.job_id, after);
    const resync =
      job.revision > after &&
      (events.length > 100 ||
        events[0]?.revision !== after + 1 ||
        events.at(-1)?.revision !== job.revision);
    const reason = resync
      ? 'resync_required'
      : job.terminal
        ? 'terminal'
        : job.requires_action
          ? 'requires_action'
          : job.revision > after
            ? 'changed'
            : 'timeout';
    if (resync || reason === 'timeout') events = [];
    return {
      job,
      events,
      cursor: job.revision,
      reason,
      timed_out: reason === 'timeout',
      resync_required: resync,
    };
  }
  async artifact(id: string): Promise<Artifact> {
    const artifact = this.db.get<Artifact>('artifacts', id);
    if (!artifact) throw new Fault('NOT_FOUND');
    try {
      await new Roots([path.join(this.options.directory, 'artifacts')]).check(artifact.path);
      if ((await inspectImage(artifact.path)).sha256 !== artifact.sha256)
        throw new Fault('INPUT_INVALID');
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault('NOT_FOUND');
    }
    return artifact;
  }
  private status(): ContractTypes['status_data'] {
    const active = this.engine.active()?.snapshot;
    const manual = !!this.engine.manualSession();
    const capability = {
      state: 'unverified' as const,
      verified_at: null,
      adapter_version: this.options.port?.version ?? null,
      reason: 'M1 engine is not connected to the M0 web adapter.',
    };
    const observed = this.options.port?.observe?.();
    const paused = this.engine.paused || !!this.engine.suspended || this.draining;
    return {
      app_state:
        paused || !this.options.port ? 'paused' : active?.requires_action ? 'degraded' : 'ready',
      adapter_version: this.options.port?.version ?? null,
      profile: {
        profile_id: this.profileId,
        auth_state: observed?.auth_state ?? 'unknown',
        account_verified_at: observed?.verified_at ?? null,
      },
      queue: {
        waiting_count: this.engine.queued().length,
        active_job_id: active?.job_id ?? null,
        dispatch_blocked:
          !this.options.port || paused || manual || !!active?.requires_action || !!active?.terminal,
        reason: !this.options.port
          ? 'M2_ADAPTER_NOT_CONNECTED'
          : this.draining
            ? 'APP_DRAINING'
            : (this.engine.suspended ??
              (this.engine.paused
                ? 'APP_PAUSED'
                : manual
                  ? 'MANUAL_CONTROL'
                  : active?.requires_action || active?.terminal
                    ? 'RECONCILIATION_REQUIRED'
                    : null)),
      },
      active_session: active
        ? this.engine.session(active.session_id)
        : (this.engine.manualSession() ?? null),
      capabilities: observed?.capabilities ?? {
        web_generate: capability,
        web_edit: capability,
        file_attach: capability,
        hidden_execution: capability,
        original_download: capability,
      },
      limits: {
        max_inputs: 8,
        input_file_bytes: 20971520,
        input_total_bytes: 83886080,
        prompt_characters: 32768,
        max_output_count: 4,
        download_file_bytes: 104857600,
      },
    };
  }
}
