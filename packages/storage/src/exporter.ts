import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, link as hardLink, unlink, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ContractTypes } from '../../contracts/src';
import { Database, where } from './database';
import { Roots, noLinks } from './roots';
import { inspectImage } from './files';
import {
  Serial,
  Fault,
  digest,
  withoutKey,
  now,
  failure,
  pathDenied,
  type Artifact,
  type Export,
} from '../../core/src/model';

interface ExportRecord {
  digest: string;
  snapshot: Export;
  targets: Record<string, string>;
  temps: Record<string, string>;
  // Items published by exclusive copy because the volume refused a hard link.
  copied?: Record<string, true>;
}
export class Exporter {
  private serial = new Serial();
  private tasks = new Map<string, Promise<void>>();
  constructor(
    private db: Database,
    private roots: Roots,
    private link: (existing: string, target: string) => Promise<void> = hardLink,
  ) {}
  recover() {
    // Queued ahead of any copy, so no settled record changes while it is swept.
    void this.serial.run(() => this.sweep()).catch(() => {});
    for (const record of this.db.select<ExportRecord>('exports', where.copyingExport))
      this.kick(record.snapshot.export_id);
  }
  // Temps live in the user's folder. A crash can leave one behind a settled item; only a
  // temp still hard-linked to the target of an unexported item is kept, as adoption evidence.
  private async sweep() {
    for (const record of this.db.select<ExportRecord>('exports', where.exportTemps)) {
      if (record.snapshot.state === 'copying') continue;
      for (const [artifactId, temporary] of Object.entries(record.temps)) {
        const item = record.snapshot.items.find((i) => i.artifact_id === artifactId);
        const target = record.targets[artifactId];
        const [staged, published] = await Promise.all([
          lstat(temporary, { bigint: true }).catch(() => undefined),
          target ? lstat(target, { bigint: true }).catch(() => undefined) : undefined,
        ]);
        if (
          item?.state !== 'exported' &&
          staged &&
          published &&
          staged.ino === published.ino &&
          staged.dev === published.dev
        )
          continue;
        try {
          if (staged) {
            await this.roots.check(temporary);
            await unlink(temporary);
          }
          delete record.temps[artifactId];
        } catch {
          /* Keep the entry; a later startup retries once the folder is available. */
        }
      }
      this.db.put('exports', record.snapshot.export_id, record); // Internal only: no revision.
    }
  }
  private async discard(record: ExportRecord, artifactId: string) {
    const temporary = record.temps[artifactId];
    if (!temporary) return;
    await unlink(temporary).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    delete record.temps[artifactId];
  }
  async idle() {
    await this.serial.run(() => undefined);
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
      const destination = await this.roots.destination(input.destination_dir).catch((error) => {
        if (!(error instanceof Fault) || error.code !== 'PATH_DENIED') throw error;
        throw pathDenied(
          'destination_dir is outside the folders this app may save to, or reaches one through a link.',
          this.roots.roots,
          'Use one of them or a folder inside it, or ask the user to change 저장 폴더 in the app settings.',
        );
      });
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
  // Publish without replacing anything: an atomic hard link where the volume supports it,
  // otherwise (FAT32, exFAT and some network shares) an exclusive copy verified in place.
  private async publish(
    record: ExportRecord,
    artifactId: string,
    temporary: string,
    target: string,
    sha256: string,
  ) {
    try {
      await this.link(temporary, target);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Fault('EXPORT_CONFLICT');
    }
    record.copied = { ...record.copied, [artifactId]: true };
    this.save(record); // Mark before the target can exist so recovery knows how it was made.
    await copyFile(temporary, target, constants.COPYFILE_EXCL).catch((e) => {
      if (e.code === 'EEXIST') throw new Fault('EXPORT_CONFLICT');
      throw e;
    });
    // The exclusive copy created this file, so a failed verification may remove it.
    try {
      const handle = await open(target, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await inspectImage(target)).sha256 !== sha256) throw new Fault('IO_ERROR');
    } catch {
      await unlink(target).catch(() => {});
      throw new Fault('IO_ERROR', 'retry_export', true);
    }
  }
  private async copy(id: string) {
    const record = this.db.get<ExportRecord>('exports', id)!;
    for (const item of record.snapshot.items) {
      if (item.state === 'exported') continue;
      item.state = 'pending';
      item.error = null;
      this.save(record);
      let published = false;
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
            const reserved = this.db.select('exports', where.exportTarget, target).length > 0;
            if (!exists && !reserved) break;
            if (record.snapshot.collision === 'error') throw new Fault('EXPORT_CONFLICT');
            version++;
          }
          record.targets[item.artifact_id] = target;
          record.temps[item.artifact_id] = path.join(destination, `.${id}-${randomUUID()}.part`);
          this.save(record); // Reserve exact name and private temp before creating files.
        }
        let temporary = record.temps[item.artifact_id];
        const exists = await lstat(target).then(
          () => true,
          (e) => {
            if (e.code === 'ENOENT') return false;
            throw e;
          },
        );
        if (exists && record.copied?.[item.artifact_id]) {
          // A copy has no inode identity; adopt only exact bytes and never delete the file.
          await this.roots.check(target);
          if ((await inspectImage(target)).sha256 !== artifact.sha256)
            throw new Fault('EXPORT_CONFLICT');
        } else if (exists) {
          // Adopt only our own published hard link across a DB-commit crash gap.
          await this.roots.check(target);
          const [linked, staged] = await Promise.all([
            lstat(target, { bigint: true }),
            temporary ? lstat(temporary, { bigint: true }).catch(() => undefined) : undefined,
          ]);
          if (
            !staged ||
            linked.ino !== staged.ino ||
            linked.dev !== staged.dev ||
            (await inspectImage(target)).sha256 !== artifact.sha256
          )
            throw new Fault('EXPORT_CONFLICT');
        } else {
          if (temporary)
            await unlink(temporary).catch((e) => {
              if (e.code !== 'ENOENT') throw e;
            });
          else {
            // A failed attempt removed its temp; record a fresh one before creating it.
            temporary = path.join(destination, `.${id}-${randomUUID()}.part`);
            record.temps[item.artifact_id] = temporary;
            this.save(record);
          }
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
          await this.publish(record, item.artifact_id, temporary, target, artifact.sha256);
        }
        published = true;
        item.state = 'exported';
        item.path = target;
        item.sha256 = artifact.sha256;
        item.error = null;
        this.save(record);
        // The receipt is durable; a temp left by a failure here is swept at startup.
        await this.discard(record, item.artifact_id).catch(() => {});
        this.db.put('exports', id, record);
      } catch (error) {
        // An unpublished temp is never needed again; a published one proves adoption.
        if (!published) await this.discard(record, item.artifact_id).catch(() => {});
        item.state = 'failed';
        item.path = null;
        item.sha256 = null;
        item.error = failure(error);
        this.save(record);
      }
    }
  }
}
