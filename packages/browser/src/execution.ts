import path from 'node:path';
import { PageAdapter, type Snapshot } from './adapter';
import { until } from './cdp';
import { conversationUrl } from './policy';
import { DownloadCollector } from './download';
import { inspectImage, durableJson, readJson } from '../../storage/src/files';
import type { ExecutionPort, ExecutionContext } from '../../core/src/engine';
import {
  Fault,
  now,
  ExecutionInterrupted,
  type DownloadedFile,
  type BridgeError,
  type JobRecord,
  type Session,
  type SubmissionAttempt,
} from '../../core/src/model';
import type { ContractTypes } from '../../contracts/src';

interface BrowserState {
  conversation_url?: string;
  response_id?: string;
  downloads?: (DownloadedFile & { sha256: string })[];
}
interface Options {
  directory: string;
  busy(active: boolean): void;
  attention(code: string): void;
  hidden(): boolean;
  generationTimeout?: number;
  readyTimeout?: number;
  // Only injected by local fixture tests; production always uses chatgpt.com.
  fixtureEntry?: string;
}
export class BrowserExecution implements ExecutionPort {
  readonly version = 'm3-execution-0.1';
  busy = false;
  private auth: ContractTypes['status_data']['profile']['auth_state'] = 'unknown';
  private authAt: string | null = null;
  private verified: Record<string, string> = {};
  private controller?: AbortController;
  interrupt() {
    this.controller?.abort();
  }
  async remoteComplete(record: JobRecord, session: Session, attempt?: SubmissionAttempt) {
    if (
      !attempt?.baseline ||
      session.control_owner !== 'automation' ||
      !record.snapshot.remote_may_continue
    )
      return false;
    if (!session.conversation_url || !attempt.evidence) return false;
    const snapshot = await this.adapter.snapshot();
    const message = this.adapter.findSubmission(
      snapshot,
      attempt.baseline as Snapshot,
      record.request.prompt,
      record.inputs.map((i) => path.basename(i.path)),
    );
    if (
      !message ||
      message.id !== attempt.evidence.message_id ||
      snapshot.busy ||
      snapshot.login ||
      snapshot.challenge ||
      this.publicUrl(snapshot.url) !== session.conversation_url
    )
      return false;
    const following = snapshot.messages.slice(
      snapshot.messages.findIndex((m) => m.id === message.id) + 1,
    );
    const response = following[0];
    return (
      following.length === 1 &&
      response?.role === 'assistant' &&
      !!response.completed &&
      (((!!response.outputReady || response.downloads > 0) && !!response.outputCount) ||
        (response.images === 0 && !!response.text.trim()))
    );
  }
  constructor(
    readonly adapter: PageAdapter,
    readonly downloads: DownloadCollector,
    readonly options: Options,
  ) {}
  async restoreCapabilities() {
    const stored = await readJson<{ version: string; verified: Record<string, string> }>(
      path.join(this.options.directory, 'capabilities.json'),
    ).catch(() => undefined);
    if (stored?.version === this.version && !this.adapter.fixtureOrigin)
      this.verified = stored.verified;
  }
  observe() {
    const capabilities = Object.fromEntries(
      ['web_generate', 'web_edit', 'file_attach', 'hidden_execution', 'original_download'].map(
        (name) => [
          name,
          {
            state: this.verified[name] && !this.adapter.fixtureOrigin ? 'supported' : 'unverified',
            verified_at: this.verified[name] ?? null,
            adapter_version: this.version,
            reason: this.adapter.fixtureOrigin
              ? 'Local fixture only.'
              : this.verified[name]
                ? null
                : 'No live evidence for this adapter version yet.',
          },
        ],
      ),
    ) as ContractTypes['status_data']['capabilities'];
    return { auth_state: this.auth, verified_at: this.authAt, capabilities };
  }
  observePage(snapshot: Snapshot) {
    this.auth = snapshot.challenge
      ? 'human_check_required'
      : snapshot.login
        ? 'auth_required'
        : snapshot.composer === 1
          ? 'authenticated'
          : 'unknown';
    this.authAt = this.auth === 'authenticated' ? now() : null;
  }
  private publicUrl(url: string) {
    return this.adapter.fixtureOrigin
      ? url.replace(this.adapter.fixtureOrigin, 'https://chatgpt.com')
      : url;
  }
  private pageUrl(url: string) {
    return this.adapter.fixtureOrigin
      ? url.replace('https://chatgpt.com', this.adapter.fixtureOrigin)
      : url;
  }
  private assertPage(snapshot: Snapshot) {
    this.observePage(snapshot);
    if (snapshot.login) throw new Fault('AUTH_REQUIRED', 'open_app');
    if (snapshot.challenge) throw new Fault('HUMAN_CHECK_REQUIRED', 'open_app');
    if (snapshot.serviceError) throw new Fault(snapshot.serviceError, 'wait');
    if (snapshot.composer !== 1) throw new Fault('UI_CHANGED', 'update_adapter');
  }
  private async navigate(url: string, context: ExecutionContext) {
    context.check();
    const expectedOrigin = this.adapter.fixtureOrigin ?? 'https://chatgpt.com';
    if (new URL(url).origin !== expectedOrigin) throw new Fault('STATE_CONFLICT');
    if (this.adapter.cdp.contents.getURL() !== url) await this.adapter.cdp.load(url);
    return until(
      () => this.adapter.snapshot(),
      (snapshot) => {
        this.observePage(snapshot);
        if (snapshot.login || snapshot.challenge) this.assertPage(snapshot);
        return snapshot.url === url && snapshot.composer === 1;
      },
      this.options.readyTimeout ?? 30000,
    );
  }
  async run(context: ExecutionContext, _recovering: boolean) {
    if (this.busy) throw new Fault('STATE_CONFLICT');
    this.busy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.options.busy(true);
    this.adapter.guard = this.adapter.cdp.guard = () => {
      if (signal.aborted) throw new ExecutionInterrupted();
      context.check();
    };
    let state = (context.job().browser_state ?? {}) as BrowserState;
    const save = async () => context.checkpoint(state);
    try {
      this.adapter.cdp.connect();
      const record = context.job();
      const names = record.inputs.map((input) => path.basename(input.path));
      for (const input of record.inputs)
        if ((await inspectImage(input.path, 20971520)).sha256 !== input.sha256)
          throw new Fault('INPUT_INVALID');
      if (record.snapshot.submission_state === 'not_sent') {
        if (record.observation_only) throw new Fault('STATE_CONFLICT', 'resume');
        const sessionUrl = context.session().conversation_url;
        const destination = sessionUrl
          ? this.pageUrl(sessionUrl)
          : (this.options.fixtureEntry ?? 'https://chatgpt.com/');
        const initial = await this.navigate(destination, context);
        this.assertPage(initial);
        if (initial.busy) throw new Fault('STATE_CONFLICT', 'reconcile');
        if (!sessionUrl && (new URL(initial.url).pathname !== '/' || initial.messages.length))
          throw new Fault('STATE_CONFLICT');
        if (sessionUrl) {
          if (
            !conversationUrl(initial.url, this.adapter.fixtureOrigin) ||
            !record.request.parent_job_id ||
            !initial.messages.length
          )
            throw new Fault('STATE_CONFLICT');
          const parent = context.parent()?.browser_state as BrowserState | undefined;
          if (!parent?.response_id || parent.conversation_url !== initial.url)
            throw new Fault('STATE_CONFLICT');
          // Another message, such as a canceled request, now follows the parent result, so
          // an edit here would build on something other than the parent image.
          if (initial.messages.at(-1)?.id !== parent.response_id) throw Error('FOLLOWUP_DIVERGED');
        }
        await context.phase('attach');
        await this.adapter.attach(
          record.inputs.map((input) => input.path),
          names,
          record.request.prompt,
        );
        const baseline = await this.adapter.fill(record.request.prompt, names);
        this.assertPage(baseline);
        if (
          baseline.url !== initial.url ||
          JSON.stringify(baseline.messages.map((m) => m.id)) !==
            JSON.stringify(initial.messages.map((m) => m.id)) ||
          baseline.send !== 1
        )
          throw new Fault('UI_CHANGED');
        await context.beforeSend(baseline);
        context.check();
        await this.adapter.clickSend(baseline);
      } else {
        // A submitted job may only return to its saved conversation, never to a new root.
        const evidence = context.attempt()?.evidence;
        const location =
          state.conversation_url ??
          (evidence ? this.pageUrl(evidence.conversation_url) : undefined);
        if (!location) throw new Fault('SUBMISSION_UNKNOWN', 'reconcile');
        await this.navigate(location, context);
      }
      const attempt = context.attempt();
      if (!attempt?.baseline) throw new Fault('SUBMISSION_UNKNOWN', 'reconcile');
      const confirmed = await this.adapter.confirm(
        attempt.baseline as Snapshot,
        record.request.prompt,
        names,
      );
      const url = confirmed.snapshot.url;
      if (state.conversation_url && state.conversation_url !== url)
        throw new Fault('SUBMISSION_UNKNOWN', 'reconcile');
      state.conversation_url = url;
      await save();
      await context.confirm({
        conversation_url: this.publicUrl(url),
        message_id: confirmed.message.id,
      });
      const response = await this.adapter.generation(
        confirmed.message.id,
        url,
        this.options.generationTimeout,
      );
      if (state.response_id && state.response_id !== response.id)
        throw new Fault('SUBMISSION_UNKNOWN', 'reconcile');
      state.response_id = response.id;
      state.downloads ??= [];
      await save();
      await context.phase('download');
      const count = response.outputCount ?? response.downloads;
      if (!count || count > 4 || state.downloads.length > count) throw new Fault('UI_CHANGED');
      for (const file of state.downloads)
        if ((await inspectImage(file.path)).sha256 !== file.sha256)
          throw new Fault('INPUT_INVALID');
      for (let ordinal = state.downloads.length; ordinal < count; ordinal++) {
        context.check();
        const directory = path.join(this.options.directory, 'downloads', record.snapshot.job_id);
        let artifact = await this.downloads.recover(directory, response.id, ordinal);
        if (!artifact) {
          const target = await this.adapter.downloadTarget(response.id, ordinal);
          artifact = await this.downloads.collect(
            directory,
            response.id,
            target,
            () => {
              context.check();
              return this.adapter.download(response.id, target, url, ordinal);
            },
            120000,
            signal,
            ordinal,
          );
        }
        state.downloads.push({
          path: artifact.path,
          sha256: artifact.sha256,
          source: {
            kind: 'chatgpt_download',
            session_id: record.snapshot.session_id,
            conversation_url: this.publicUrl(url),
            message_id: response.id,
            downloaded_at: now(),
            web_model_id: null,
          },
        });
        await save();
        await this.adapter.dismissViewer(response.id, ordinal);
      }
      const wasHidden = this.options.hidden();
      await context.complete(state.downloads);
      if (!this.adapter.fixtureOrigin) {
        const at = now();
        this.verified[record.request.mode === 'edit' ? 'web_edit' : 'web_generate'] = at;
        if (record.inputs.length) this.verified.file_attach = at;
        if (wasHidden) this.verified.hidden_execution = at;
        this.verified.original_download = at;
        await durableJson(path.join(this.options.directory, 'capabilities.json'), {
          version: this.version,
          verified: this.verified,
        });
      }
    } catch (error) {
      if (signal.aborted || error instanceof ExecutionInterrupted) throw error;
      if (context.job().snapshot.terminal) return;
      // If the click returned ambiguously, salvage only a matching existing user message.
      if (context.job().snapshot.submission_state === 'sending') {
        const record = context.job(),
          attempt = context.attempt();
        const snapshot = await this.adapter.snapshot().catch(() => undefined);
        const candidate =
          snapshot && attempt?.baseline
            ? this.adapter.findSubmission(
                snapshot,
                attempt.baseline as Snapshot,
                record.request.prompt,
                record.inputs.map((i) => path.basename(i.path)),
              )
            : undefined;
        if (candidate) {
          state.conversation_url = snapshot!.url;
          await save();
          await context.confirm({
            conversation_url: this.publicUrl(snapshot!.url),
            message_id: candidate.id,
          });
        } else {
          this.options.attention('SUBMISSION_UNKNOWN');
          throw new Fault('SUBMISSION_UNKNOWN', 'reconcile');
        }
      }
      const code = error instanceof Fault ? error.code : (error as Error)?.message;
      if (code === 'SUBMISSION_UNKNOWN' || code === 'SESSION_CHANGED') {
        this.options.attention('SUBMISSION_UNKNOWN');
        throw new Fault('SUBMISSION_UNKNOWN', 'reconcile');
      }
      const mapping: Record<string, BridgeError> = {
        AUTH_REQUIRED: {
          code: 'AUTH_REQUIRED',
          message: 'Sign in on the same app page.',
          retryable: false,
          next_action: 'open_app',
        },
        HUMAN_CHECK_REQUIRED: {
          code: 'HUMAN_CHECK_REQUIRED',
          message: 'Complete the human check on the same app page.',
          retryable: false,
          next_action: 'open_app',
        },
        RATE_LIMITED: {
          code: 'RATE_LIMITED',
          message: 'The page reports a limit.',
          retryable: false,
          next_action: 'wait',
        },
        GENERATION_REJECTED: {
          code: 'GENERATION_REJECTED',
          message: 'The page reports generation rejection.',
          retryable: false,
          next_action: 'fix_input',
        },
        TEXT_RESPONSE: {
          code: 'UI_CHANGED',
          message:
            'The response contains text or a clarification instead of an image. Review it in the app.',
          retryable: false,
          next_action: 'open_app',
        },
        DOWNLOAD_FAILED: {
          code: 'DOWNLOAD_FAILED',
          message: 'Existing output download needs recovery.',
          retryable: true,
          next_action: 'retry_download',
        },
        ADAPTER_UNAVAILABLE: {
          code: 'ADAPTER_UNAVAILABLE',
          message: 'Reconnect the app debugger and reconcile this page.',
          retryable: true,
          next_action: 'reconcile',
        },
        PAGE_LOAD_FAILED: {
          code: 'ADAPTER_UNAVAILABLE',
          message: 'The ChatGPT page could not be loaded. Check the connection and try again.',
          retryable: true,
          // Nothing unsent needs reconciliation; a sent request must never be prepared again.
          next_action:
            context.job().snapshot.submission_state === 'not_sent' ? 'resume' : 'reconcile',
        },
        FOLLOWUP_DIVERGED: {
          code: 'STATE_CONFLICT',
          message:
            'The conversation has newer messages after the parent result, so this follow-up was not sent. Submit a new request without session_id, using the parent artifact as an input.',
          retryable: false,
          next_action: 'fix_input',
        },
        OBSERVATION_TIMEOUT: {
          code: 'ADAPTER_UNAVAILABLE',
          message: 'Observation timed out; generation outcome is not known.',
          retryable: true,
          next_action: 'reconcile',
        },
      };
      const reason =
        mapping[code] ??
        ({
          code: error instanceof Fault ? error.code : 'UI_CHANGED',
          message: 'The page or stored input needs inspection.',
          retryable: false,
          next_action: 'open_app',
        } as BridgeError);
      // Final outcomes fail at once: waiting would only hold the queue for a job that cannot
      // succeed. A diverged follow-up sent nothing, so no web run is left behind.
      if (
        (code === 'GENERATION_REJECTED' &&
          context.job().snapshot.submission_state === 'confirmed') ||
        (code === 'FOLLOWUP_DIVERGED' && context.job().snapshot.submission_state === 'not_sent')
      )
        await context.fail(reason);
      else await context.waitForUser(reason);
      this.options.attention(reason.code);
    } finally {
      this.adapter.guard = this.adapter.cdp.guard = () => {};
      await this.adapter.cleanupCapture();
      this.controller = undefined;
      this.busy = false;
      this.options.busy(false);
    }
  }
}
