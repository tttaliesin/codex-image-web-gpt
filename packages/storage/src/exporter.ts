import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, link, unlink, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ContractTypes } from '../../contracts/src';
import { Database } from './database';
import { Roots, noLinks } from './roots';
import { inspectImage } from './files';
import {
  Serial,
  Fault,
  digest,
  withoutKey,
  now,
  failure,
  type Artifact,
  type Export,
} from '../../core/src/model';

interface ExportRecord {
  digest: string;
  snapshot: Export;
  targets: Record<string, string>;
  temps: Record<string, string>;
}
export class Exporter {
  private serial = new Serial();
  private tasks = new Map<string, Promise<void>>();
  constructor(
    private db: Database,
    private roots: Roots,
  ) {}
  recover() {
    for (const record of this.db.all<ExportRecord>('exports'))
      if (record.snapshot.state === 'copying') this.kick(record.snapshot.export_id);
  }
  async idle() {
    await Promise.all(this.tasks.values());
  }
  async submit(raw: ContractTypes['export_input']) {
    return this.serial.run(async () => {
      const input = { ...raw, collision: raw.collision ?? 'version' };
      const hash = digest(withoutKey(input, 'export_id'));
      let record = this.db.get<ExportRecord>('exports', input.export_id);
      if (record) {
        if (record.digest !== hash) throw new Fault('IDEMPOTENCY_CONFLICT');
        // Successful receipts must never silently recreate externally changed files.
        for (const item of record.snapshot.items.filter((i) => i.state === 'exported')) {
          try {
            await this.roots.check(item.path!);
            if ((await inspectImage(item.path!)).sha256 !== item.sha256)
              throw new Fault('EXPORT_CONFLICT');
          } catch {
            throw new Fault('EXPORT_CONFLICT');
          }
        }
        if (record.snapshot.state !== 'succeeded') this.kick(input.export_id);
        return { deduplicated: true, export: record.snapshot };
      }
      const destination = await this.roots.destination(input.destination_dir);
      for (const id of input.artifact_ids)
        if (!this.db.get('artifacts', id)) throw new Fault('NOT_FOUND');
      const timestamp = now();
      record = {
        digest: hash,
        targets: {},
        temps: {},
        snapshot: {
          export_id: input.export_id,
          destination_dir: destination,
          collision: input.collision,
          revision: 1,
          state: 'copying',
          created_at: timestamp,
          updated_at: timestamp,
          items: input.artifact_ids.map((artifact_id) => ({
            artifact_id,
            state: 'pending',
            path: null,
            sha256: null,
            error: null,
          })) as Export['items'],
        },
      };
      this.db.insert('exports', input.export_id, record);
      this.kick(input.export_id);
      return { deduplicated: false, export: record.snapshot };
    });
  }
  private kick(id: string) {
    if (this.tasks.has(id)) return;
    const task = this.serial.run(() => this.copy(id)).finally(() => this.tasks.delete(id));
    this.tasks.set(id, task);
    // Internal IO failures become file receipts; database failure is surfaced by idle/close.
    void task.catch(() => {});
  }
  private save(record: ExportRecord) {
    record.snapshot.revision++;
    record.snapshot.updated_at = now();
    const items = record.snapshot.items;
    record.snapshot.state = items.some((i) => i.state === 'pending')
      ? 'copying'
      : items.every((i) => i.state === 'exported')
        ? 'succeeded'
        : items.every((i) => i.state === 'failed')
          ? 'failed'
          : 'partial';
    this.db.put('exports', record.snapshot.export_id, record);
  }
  private async copy(id: string) {
    const record = this.db.get<ExportRecord>('exports', id)!;
    for (const item of record.snapshot.items) {
      if (item.state === 'exported') continue;
      item.state = 'pending';
      item.error = null;
      this.save(record);
      try {
        const artifact = this.db.get<Artifact>('artifacts', item.artifact_id);
        if (!artifact) throw new Fault('NOT_FOUND');
        await noLinks(artifact.path);
        if ((await inspectImage(artifact.path)).sha256 !== artifact.sha256)
          throw new Fault('INPUT_INVALID');
        const destination = await this.roots.check(record.snapshot.destination_dir, true);
        let target = record.targets[item.artifact_id];
        if (!target) {
          const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[
            artifact.mime_type
          ];
          let version = 1;
          for (;;) {
            target = path.join(
              destination,
              `${artifact.artifact_id}${version === 1 ? '' : `-v${version}`}${extension}`,
            );
            const exists = await lstat(target).then(
              () => true,
              (e) => {
                if (e.code === 'ENOENT') return false;
                throw e;
              },
            );
            const reserved = this.db
              .all<ExportRecord>('exports')
              .some((r) => Object.values(r.targets).includes(target!));
            if (!exists && !reserved) break;
            if (record.snapshot.collision === 'error') throw new Fault('EXPORT_CONFLICT');
            version++;
          }
          record.targets[item.artifact_id] = target;
          record.temps[item.artifact_id] = path.join(destination, `.${id}-${randomUUID()}.part`);
          this.save(record); // Reserve exact name and private temp before creating files.
        }
        const temporary = record.temps[item.artifact_id]!;
        const exists = await lstat(target).then(
          () => true,
          (e) => {
            if (e.code === 'ENOENT') return false;
            throw e;
          },
        );
        if (exists) {
          // Adopt only our own published hard link across a DB-commit crash gap.
          await this.roots.check(target);
          const [published, staged] = await Promise.all([
            lstat(target, { bigint: true }),
            lstat(temporary, { bigint: true }).catch(() => undefined),
          ]);
          if (
            !staged ||
            published.ino !== staged.ino ||
            published.dev !== staged.dev ||
            (await inspectImage(target)).sha256 !== artifact.sha256
          )
            throw new Fault('EXPORT_CONFLICT');
        } else {
          await unlink(temporary).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
          await copyFile(artifact.path, temporary, constants.COPYFILE_EXCL);
          if ((await inspectImage(temporary)).sha256 !== artifact.sha256)
            throw new Fault('IO_ERROR', 'retry_export', true);
          const handle = await open(temporary, 'r+');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          await this.roots.check(destination, true);
          await link(temporary, target).catch((e) => {
            if (e.code === 'EEXIST') throw new Fault('EXPORT_CONFLICT');
            throw e;
          });
        }
        item.state = 'exported';
        item.path = target;
        item.sha256 = artifact.sha256;
        item.error = null;
        this.save(record);
        await unlink(temporary).catch(() => {});
      } catch (error) {
        item.state = 'failed';
        item.path = null;
        item.sha256 = null;
        item.error = failure(error);
        this.save(record);
      }
    }
  }
}
