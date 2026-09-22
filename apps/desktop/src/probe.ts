import path from 'node:path';
import { mkdir, open, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { until } from '../../../packages/browser/src/cdp';
import { PageAdapter, type Snapshot } from '../../../packages/browser/src/adapter';
import { conversationUrl } from '../../../packages/browser/src/policy';
import { DownloadCollector, type Artifact } from '../../../packages/browser/src/download';
import {
  durableJson,
  readJson,
  stageInput,
  inspectImage,
} from '../../../packages/storage/src/files';

export interface ProbeRequest {
  id: string;
  prompt: string;
  inputs: { path: string; role: 'reference' | 'edit_target' | 'supporting' }[];
  parent_id?: string;
}
export interface ProbeRecord {
  id: string;
  phase: string;
  submission: 'not_sent' | 'sending' | 'confirmed' | 'unknown';
  prompt_sha256: string;
  request: ProbeRequest;
  names: string[];
  baseline?: Snapshot;
  conversation_url?: string;
  user_id?: string;
  artifact?: Artifact;
  error?: string;
}
export function validateRequest(value: unknown): asserts value is ProbeRequest {
  const request = value as ProbeRequest;
  if (
    !request ||
    typeof request.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(request.id) ||
    typeof request.prompt !== 'string' ||
    !request.prompt.length ||
    [...request.prompt].length > 32768 ||
    !Array.isArray(request.inputs) ||
    request.inputs.length > 8 ||
    request.inputs.some(
      (input) =>
        !input ||
        typeof input.path !== 'string' ||
        !path.isAbsolute(input.path) ||
        !['reference', 'edit_target', 'supporting'].includes(input.role),
    ) ||
    (request.parent_id !== undefined &&
      (typeof request.parent_id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.parent_id)))
  )
    throw Error('INPUT_INVALID');
}

// M0 probe journal, deliberately separate from the M1 public Job/MCP contract.
// One process owns this runner. Existing records are inspection/recovery only.
export class ProbeRunner {
  busy = false;
  constructor(
    readonly root: string,
    readonly adapter: PageAdapter,
    readonly downloads: DownloadCollector,
    readonly status: (phase: string) => void,
  ) {}
  async run(request: ProbeRequest, hide: () => void): Promise<ProbeRecord> {
    validateRequest(request);
    if (this.busy) throw Error('STATE_CONFLICT');
    this.busy = true;
    let directory = '';
    let journal = '';
    let record: ProbeRecord | undefined;
    try {
      directory = path.join(this.root, request.id);
      journal = path.join(directory, 'probe.json');
      const exists = await stat(journal).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (exists) {
        record = await readJson<ProbeRecord>(journal);
        if (JSON.stringify(record.request) !== JSON.stringify(request))
          throw Error('IDEMPOTENCY_CONFLICT');
        if (record.submission !== 'not_sent')
          return await this.reconcile(record, journal, directory);
        // Only a proven pre-send interruption can resume preparation with its immutable inputs.
        const markerExists = await stat(path.join(directory, 'sending.marker')).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        );
        if (markerExists) throw Error('SUBMISSION_UNKNOWN');
      }
      await mkdir(this.root, { recursive: true });
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === request.id) continue;
        const previous = await readJson<ProbeRecord>(
          path.join(this.root, entry.name, 'probe.json'),
        );
        if (!previous.artifact && previous.submission !== 'not_sent')
          throw Error('UNRESOLVED_PROBE');
      }
      let initial = await this.adapter.snapshot();
      if (request.parent_id) {
        const parent = await readJson<ProbeRecord>(
          path.join(this.root, request.parent_id, 'probe.json'),
        );
        if (!parent.artifact || !parent.conversation_url) throw Error('PARENT_MISMATCH');
        initial = await until(
          () => this.adapter.snapshot(),
          (value) =>
            value.url === parent.conversation_url &&
            !value.busy &&
            value.messages.some((message) => message.id === parent.artifact!.message_id),
          15000,
        );
      }
      if (initial.login) throw Error('AUTH_REQUIRED');
      if (initial.challenge) throw Error('HUMAN_CHECK_REQUIRED');
      if (
        !request.parent_id &&
        (new URL(initial.url).origin !== (this.adapter.fixtureOrigin ?? 'https://chatgpt.com') ||
          conversationUrl(initial.url, this.adapter.fixtureOrigin) ||
          new URL(initial.url).pathname !== '/')
      )
        throw Error('NEW_CONVERSATION_REQUIRED');
      if (initial.messages.length) {
        if (!request.parent_id) throw Error('NEW_CONVERSATION_REQUIRED');
        const parent = await readJson<ProbeRecord>(
          path.join(this.root, request.parent_id, 'probe.json'),
        );
        if (
          !parent.artifact ||
          parent.conversation_url !== initial.url ||
          !request.inputs.some(
            (input) =>
              input.role === 'edit_target' &&
              path.resolve(input.path) === path.resolve(parent.artifact!.path),
          )
        )
          throw Error('PARENT_MISMATCH');
      } else if (request.parent_id) throw Error('PARENT_MISMATCH');
      record ??= {
        id: request.id,
        request,
        phase: 'prepare',
        submission: 'not_sent',
        names: [],
        prompt_sha256: createHash('sha256').update(request.prompt).digest('hex'),
      };
      await mkdir(directory, { recursive: true });
      await durableJson(journal, record);
      const stored: Awaited<ReturnType<typeof stageInput>>[] | undefined = exists
        ? await readJson<Awaited<ReturnType<typeof stageInput>>[]>(
            path.join(directory, 'inputs.json'),
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          })
        : undefined;
      const staged = stored ?? [];
      if (stored) {
        if (staged.length !== request.inputs.length) throw Error('INPUT_INVALID');
        for (const input of staged)
          if ((await inspectImage(input.path)).sha256 !== input.sha256)
            throw Error('INPUT_CHANGED');
      } else {
        for (let i = 0; i < request.inputs.length; i++)
          staged.push(await stageInput(request.inputs[i]!.path, path.join(directory, 'inputs'), i));
      }
      if (staged.reduce((total, image) => total + image.bytes, 0) > 80 * 1024 * 1024)
        throw Error('INPUT_INVALID');
      record.names = staged.map((image) => image.name);
      await durableJson(
        path.join(directory, 'inputs.json'),
        staged.map((image, i) => ({ ...image, ordinal: i, role: request.inputs[i]!.role })),
      );
      this.status('attach');
      record.phase = 'attach';
      await durableJson(journal, record);
      await this.adapter.attach(
        staged.map((image) => image.path),
        record.names,
        request.prompt,
      );
      record.baseline = await this.adapter.fill(request.prompt, record.names);
      if (
        !request.parent_id &&
        (record.baseline.messages.length > 0 ||
          record.baseline.url !== initial.url ||
          new URL(record.baseline.url).pathname !== '/')
      )
        throw Error('NEW_CONVERSATION_REQUIRED');
      if (
        request.parent_id &&
        (record.baseline.url !== initial.url ||
          JSON.stringify(record.baseline.messages.map((m) => m.id)) !==
            JSON.stringify(initial.messages.map((m) => m.id)))
      )
        throw Error('SESSION_CHANGED');
      if (record.baseline.send !== 1) throw Error('UI_CHANGED');
      record.phase = 'submit';
      record.submission = 'sending';
      await durableJson(journal, record);
      // Exclusive, flushed marker: the click is unreachable a second time for this probe ID.
      const marker = await open(path.join(directory, 'sending.marker'), 'wx');
      try {
        await marker.writeFile(record.prompt_sha256);
        await marker.sync();
      } finally {
        await marker.close();
      }
      hide();
      await this.adapter.clickSend(record.baseline);
      const confirmed = await this.adapter.confirm(record.baseline, request.prompt, record.names);
      record.submission = 'confirmed';
      record.user_id = confirmed.message.id;
      record.conversation_url = confirmed.snapshot.url;
      await durableJson(journal, record);
      return await this.finish(record, journal, directory);
    } catch (error) {
      if (record && (error as Error).message !== 'IDEMPOTENCY_CONFLICT') {
        if (record.submission === 'sending') {
          record.submission = 'unknown';
          // Capture an observed identity if transport recovered, without retrying the click.
          const observed = await this.adapter.snapshot().catch(() => undefined);
          const candidate =
            observed && record.baseline
              ? this.adapter.findSubmission(
                  observed,
                  record.baseline,
                  record.request.prompt,
                  record.names,
                )
              : undefined;
          if (candidate) {
            record.conversation_url = observed!.url;
            record.user_id = candidate.id;
          }
        }
        record.error = safeError(error);
        record.phase = 'waiting_user';
        await durableJson(journal, record);
      }
      this.status(safeError(error));
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private async reconcile(record: ProbeRecord, journal: string, directory: string) {
    if (record.artifact) return record;
    if (!record.baseline || record.submission === 'not_sent') throw Error('REVIEW_REQUIRED');
    if (!record.conversation_url) throw Error('SUBMISSION_UNKNOWN');
    const snapshot = await until(
      () => this.adapter.snapshot(),
      (value) => {
        if (record.conversation_url && value.url !== record.conversation_url)
          throw Error('SESSION_CHANGED');
        return !!this.adapter.findSubmission(
          value,
          record.baseline!,
          record.request.prompt,
          record.names,
        );
      },
      15000,
    );
    if (record.conversation_url && snapshot.url !== record.conversation_url)
      throw Error('SESSION_CHANGED');
    const message = this.adapter.findSubmission(
      snapshot,
      record.baseline,
      record.request.prompt,
      record.names,
    );
    if (!message) throw Error('SUBMISSION_UNKNOWN');
    if (record.user_id && message.id !== record.user_id) throw Error('SUBMISSION_UNKNOWN');
    // Without a saved conversation identity, a restart/manual navigation cannot prove ownership.
    if (!record.conversation_url) throw Error('SUBMISSION_UNKNOWN');
    record.user_id = message.id;
    record.conversation_url = snapshot.url;
    record.submission = 'confirmed';
    await durableJson(journal, record);
    return this.finish(record, journal, directory);
  }
  private async finish(record: ProbeRecord, journal: string, directory: string) {
    record.phase = 'generate';
    delete record.error;
    this.status(record.phase);
    await durableJson(journal, record);
    const response = await this.adapter.generation(record.user_id!, record.conversation_url!);
    record.phase = 'download';
    this.status(record.phase);
    await durableJson(journal, record);
    const target = await this.adapter.downloadTarget(response.id);
    record.artifact = await this.downloads.collect(
      path.join(directory, 'artifacts'),
      response.id,
      target,
      () => this.adapter.download(response.id, target, record.conversation_url!),
    );
    record.phase = 'complete';
    await durableJson(journal, record);
    this.status(record.phase);
    return record;
  }
}
export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,60}$/.test(message) ? message : 'IO_OR_ADAPTER_ERROR';
}
