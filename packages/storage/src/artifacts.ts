import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, rename, open, readdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { validDefinition } from '../../contracts/src';
import { Engine } from '../../core/src/engine';
import {
  Fault,
  now,
  type Artifact,
  type DownloadedFile,
  type JobRecord,
} from '../../core/src/model';
import { inspectImage, durableJson, readJson } from './files';
import { Roots } from './roots';

export type { DownloadedFile } from '../../core/src/model';
export class ArtifactStore {
  constructor(
    private directory: string,
    private engine: Engine,
  ) {}
  // Internal adapter boundary only. MCP does not expose file registration.
  async complete(jobId: string, files: DownloadedFile[]) {
    if (!files.length || files.length > 4) throw new Fault('INPUT_INVALID');
    const initial = this.engine.job(jobId).snapshot;
    if (initial.state !== 'running' || initial.submission_state !== 'confirmed')
      throw new Fault('STATE_CONFLICT');
    const session = this.engine.session(initial.session_id);
    const manifest = path.join(this.directory, 'manifests', `${jobId}.json`);
    const artifacts: Artifact[] = [];
    const staged: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        if (
          file.source.session_id !== session.session_id ||
          file.source.conversation_url !== session.conversation_url
        )
          throw new Fault('STATE_CONFLICT');
        const source = await new Roots([path.join(this.directory, 'downloads', jobId)]).check(
          file.path,
        );
        const info = await inspectImage(source);
        const id = randomUUID();
        const directory = path.join(this.directory, 'artifacts', jobId);
        await mkdir(directory, { recursive: true });
        const target = path.join(directory, `${id}.${info.extension}`);
        const temporary = `${target}.part`;
        staged.push(temporary); // The exclusive copy below creates it, even if only in part.
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        if ((await inspectImage(temporary)).sha256 !== info.sha256) throw new Fault('IO_ERROR');
        const handle = await open(temporary, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const artifact = {
          artifact_id: id,
          job_id: jobId,
          ordinal: index + 1,
          path: target,
          sha256: info.sha256,
          mime_type: info.mime,
          size_bytes: info.bytes,
          width: info.width,
          height: info.height,
          has_alpha: info.has_alpha,
          has_transparency: info.has_transparency,
          verified_at: now(),
          source: file.source,
        } as Artifact;
        if (!validDefinition('artifact', artifact)) throw new Fault('INPUT_INVALID');
        artifacts.push(artifact);
      }
      // Persist recovery intent before any final file becomes visible.
      await durableJson(manifest, artifacts);
    } catch (error) {
      // Without a manifest nothing refers to these copies; a retry stages new ones.
      await Promise.all(staged.map((file) => unlink(file).catch(() => {})));
      throw error;
    }
    for (const artifact of artifacts) await rename(`${artifact.path}.part`, artifact.path);
    await this.commit(jobId, artifacts);
    await unlink(manifest).catch(() => {}); // Committed: the receipt now lives in the database.
  }
  async recover() {
    const directory = path.join(this.directory, 'manifests');
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const jobId = name.slice(0, -5);
      // One unrecoverable manifest must not keep the app, and every other job, from starting.
      try {
        await this.recoverManifest(jobId, path.join(directory, name));
      } catch {
        await this.holdForUser(jobId);
      }
    }
  }
  // The response already exists on the web, so collecting it again never resubmits.
  private holdForUser(jobId: string) {
    return this.engine.serial.run(() =>
      this.engine.db.transaction(() => {
        const job = this.engine.db.get<JobRecord>('jobs', jobId)?.snapshot;
        if (job?.state !== 'reconciling' || job.submission_state !== 'confirmed') return;
        this.engine.update(
          jobId,
          {
            state: 'waiting_user',
            error: {
              code: 'DOWNLOAD_FAILED',
              message: 'Saved output could not be verified at startup; collect it again.',
              retryable: true,
              next_action: 'retry_download',
            },
          },
          'error_changed',
        );
      }),
    );
  }
  private async recoverManifest(jobId: string, file: string) {
    const job = this.engine.job(jobId).snapshot;
    // Left by a crash between commit and cleanup; the database already holds the receipt.
    if (job.terminal) return void (await unlink(file).catch(() => {}));
    if (job.submission_state !== 'confirmed') return;
    const artifacts = await readJson<Artifact[]>(file);
    if (!artifacts.length || artifacts.length > 4) throw new Fault('INPUT_INVALID');
    for (const artifact of artifacts) {
      if (!validDefinition('artifact', artifact) || artifact.job_id !== jobId)
        throw new Fault('INPUT_INVALID');
      try {
        await new Roots([path.join(this.directory, 'artifacts', jobId)]).check(artifact.path);
      } catch (error) {
        if (!(error instanceof Fault) || error.code !== 'NOT_FOUND') throw error;
        await new Roots([path.join(this.directory, 'artifacts', jobId)]).check(
          `${artifact.path}.part`,
        );
        if ((await inspectImage(`${artifact.path}.part`)).sha256 !== artifact.sha256)
          throw new Fault('INPUT_INVALID');
        await rename(`${artifact.path}.part`, artifact.path);
      }
      await new Roots([path.join(this.directory, 'artifacts', jobId)]).check(artifact.path);
      if ((await inspectImage(artifact.path)).sha256 !== artifact.sha256)
        throw new Fault('INPUT_INVALID');
    }
    await this.commit(jobId, artifacts);
    await unlink(file).catch(() => {});
  }
  private commit(jobId: string, artifacts: Artifact[]) {
    return this.engine.serial.run(() =>
      this.engine.db.transaction(() => {
        const record = this.engine.job(jobId);
        if (record.snapshot.terminal) return;
        if (record.snapshot.submission_state !== 'confirmed') throw new Fault('STATE_CONFLICT');
        const session = this.engine.session(record.snapshot.session_id);
        if (
          artifacts.some(
            (a) =>
              a.source.session_id !== session.session_id ||
              a.source.conversation_url !== session.conversation_url,
          )
        )
          throw new Fault('STATE_CONFLICT');
        // A completed, verified file may be registered after manual takeover or an
        // observation interruption. No browser side effect is needed for this recovery.
        if (['waiting_user', 'unknown'].includes(record.snapshot.state))
          this.engine.update(jobId, { state: 'reconciling' });
        if (this.engine.job(jobId).snapshot.state === 'reconciling')
          this.engine.update(jobId, { state: 'running' });
        if (this.engine.job(jobId).snapshot.state !== 'running') throw new Fault('STATE_CONFLICT');
        const expected = record.request.expected_output!;
        const warnings = artifacts.some(
          (a) =>
            (expected.width && (a.width !== expected.width || a.height !== expected.height)) ||
            (expected.require_alpha && (!a.has_alpha || !a.has_transparency)),
        )
          ? [
              {
                code: 'OUTPUT_MISMATCH' as const,
                message: 'Downloaded output does not match requested dimensions or transparency.',
                retryable: false,
                next_action: 'none' as const,
              },
            ]
          : [];
        const partial =
          artifacts.length !== expected.count || (expected.strict && warnings.length > 0);
        for (const artifact of artifacts)
          this.engine.db.put('artifacts', artifact.artifact_id, artifact);
        this.engine.update(
          jobId,
          {
            state: partial ? 'partial' : 'succeeded',
            remote_may_continue: false,
            artifact_ids: artifacts.map((a) => a.artifact_id),
            warnings,
            error: partial
              ? {
                  code: 'OUTPUT_MISMATCH',
                  message: 'Collection finished with fewer outputs or a strict mismatch.',
                  retryable: false,
                  next_action: 'none',
                }
              : null,
          },
          'artifact_added',
        );
      }),
    );
  }
}
