import type { DownloadItem, Session, WebContents } from 'electron';
import { mkdir, rename, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { allowedDownload } from './policy';
import { durableJson, inspectImage, readJson, type ImageInfo } from '../../storage/src/files';
import { ExecutionInterrupted } from '../../core/src/model';
import { Roots } from '../../storage/src/roots';

export interface Artifact extends ImageInfo {
  path: string;
  id: string;
  message_id: string;
  ordinal?: number;
}
export class DownloadCollector {
  private active = false;
  private accepting = false;
  constructor(
    readonly session: Session,
    readonly contents: WebContents,
    readonly fixtureOrigin?: string,
  ) {}
  async recover(directory: string, messageId: string, ordinal = 0): Promise<Artifact | undefined> {
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (!name.endsWith('.manifest.json')) continue;
      const saved = await readJson<Artifact>(path.join(directory, name));
      if (saved.message_id !== messageId || (saved.ordinal ?? 0) !== ordinal) continue;
      if (
        !/^[a-f0-9-]{36}$/.test(saved.id) ||
        name !== `${saved.id}.manifest.json` ||
        path.resolve(saved.path) !== path.resolve(directory, `${saved.id}.${saved.extension}`) ||
        !['png', 'jpg', 'webp'].includes(saved.extension)
      )
        throw Error('DOWNLOAD_FAILED');
      const exists = await stat(saved.path).then(
        () => true,
        () => false,
      );
      const source = exists ? saved.path : path.join(directory, `${saved.id}.part`);
      await new Roots([directory]).check(source);
      if ((await inspectImage(source)).sha256 !== saved.sha256) throw Error('DOWNLOAD_FAILED');
      if (!exists) await rename(source, saved.path);
      return saved;
    }
    return undefined;
  }
  async collect(
    directory: string,
    messageId: string,
    expectedUrl: string,
    click: () => Promise<void>,
    timeout = 120000,
    signal?: AbortSignal,
    ordinal = 0,
  ): Promise<Artifact> {
    if (signal?.aborted) throw new ExecutionInterrupted();
    if (this.active) throw Error('DOWNLOAD_BUSY');
    this.active = true;
    try {
      await mkdir(directory, { recursive: true });
      const id = randomUUID();
      const temporary = path.join(directory, `${id}.part`);
      await durableJson(path.join(directory, `${id}.intent.json`), {
        id,
        message_id: messageId,
        temporary,
      });
      return await new Promise<Artifact>((resolve, reject) => {
        let item: DownloadItem | undefined;
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          this.accepting = false;
          this.session.removeListener('will-download', onDownload);
        };
        const fail = (interrupted = false) => {
          if (settled) return;
          settled = true;
          cleanup();
          item?.cancel();
          reject(interrupted ? new ExecutionInterrupted() : Error('DOWNLOAD_FAILED'));
        };
        const abort = () => fail(true);
        const timer = setTimeout(fail, timeout);
        const onDownload = (
          event: Electron.Event,
          candidate: DownloadItem,
          originContents: WebContents,
        ) => {
          // Only one item may consume the armed intent. Unrelated items are canceled.
          if (
            item ||
            originContents?.id !== this.contents.id ||
            candidate.getURLChain()[0] !== expectedUrl ||
            candidate.getInitiatorOrigin() !== (this.fixtureOrigin ?? 'https://chatgpt.com') ||
            !allowedDownload(candidate.getURL(), this.fixtureOrigin) ||
            candidate.getURLChain().some((url) => !allowedDownload(url, this.fixtureOrigin))
          ) {
            event.preventDefault();
            return;
          }
          item = candidate;
          candidate.setSavePath(temporary);
          if (candidate.getTotalBytes() > 100 * 1024 * 1024) {
            fail();
            return;
          }
          candidate.on('updated', () => {
            if (candidate.getReceivedBytes() > 100 * 1024 * 1024) fail();
          });
          candidate.once('done', async (_event, state) => {
            if (settled) return;
            if (state !== 'completed') {
              fail();
              return;
            }
            try {
              const info = await inspectImage(temporary);
              if (settled) return;
              if (info.bytes !== candidate.getReceivedBytes()) throw Error();
              const final = path.join(directory, `${id}.${info.extension}`);
              const artifact = { ...info, path: final, id, message_id: messageId, ordinal };
              // Manifest precedes publication so a crash leaves reconcilable evidence.
              await durableJson(path.join(directory, `${id}.manifest.json`), artifact);
              if (settled) return;
              await rename(temporary, final);
              if (settled) return;
              settled = true;
              cleanup();
              resolve(artifact);
            } catch {
              fail();
            }
          });
        };
        this.session.on('will-download', onDownload);
        this.accepting = true;
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else void click().catch(() => fail());
      });
    } finally {
      this.active = false;
    }
  }
  get armed() {
    return this.accepting;
  }
}
