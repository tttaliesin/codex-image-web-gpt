import path from 'node:path';
import { lstat, realpath, open, mkdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { inspectImage } from './files';
import { Fault, type Input, type StoredInput } from '../../core/src/model';

function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
// Reject reparse points at every existing component, including configured roots.
export async function noLinks(file: string): Promise<void> {
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  for (const segment of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Fault('PATH_DENIED');
  }
}
export class Roots {
  constructor(readonly roots: string[]) {}
  async check(file: string, directory = false): Promise<string> {
    if (
      !path.isAbsolute(file) ||
      file.startsWith('\\\\') ||
      file.startsWith('//') ||
      file.slice(2).includes(':')
    )
      throw new Fault('INPUT_NOT_LOCAL');
    const candidate = path.resolve(file);
    const root = this.roots.find(
      (root) => path.isAbsolute(root) && within(path.resolve(root), candidate),
    );
    if (!root) throw new Fault('PATH_DENIED');
    try {
      await noLinks(candidate);
      const [actual, base, stat] = await Promise.all([
        realpath(candidate),
        realpath(root),
        lstat(candidate),
      ]);
      if (!within(base, actual) || (directory ? !stat.isDirectory() : !stat.isFile()))
        throw new Fault('PATH_DENIED');
      return actual;
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault('NOT_FOUND');
    }
  }
  async destination(directory: string): Promise<string> {
    if (!path.isAbsolute(directory)) throw new Fault('PATH_DENIED');
    const candidate = path.resolve(directory);
    const root = this.roots.find((root) => within(path.resolve(root), candidate));
    if (!root) throw new Fault('PATH_DENIED');
    let current = await this.check(root, true);
    for (const segment of path
      .relative(path.resolve(root), candidate)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, segment);
      try {
        await mkdir(current);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      await this.check(current, true);
    }
    return this.check(current, true);
  }
}
export async function stageChecked(
  input: Input,
  source: string,
  roots: Roots,
  directory: string,
  ordinal: number,
): Promise<StoredInput> {
  const actual = await roots.check(source);
  const handle = await open(actual, 'r');
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${randomUUID()}.part`);
  try {
    const initial = await handle.stat({ bigint: true });
    const resolved = await roots.check(source);
    const named = await lstat(resolved, { bigint: true });
    if (named.dev !== initial.dev || named.ino !== initial.ino || !initial.isFile())
      throw new Fault('PATH_DENIED');
    if (initial.size < 1n || initial.size > 20971520n) throw new Fault('INPUT_INVALID');
    const output = await open(temporary, 'wx');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let total = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > 20971520) throw new Fault('INPUT_INVALID');
        await output.writeFile(buffer.subarray(0, bytesRead));
      }
      await output.sync();
    } finally {
      await output.close();
    }
    const after = await handle.stat({ bigint: true });
    if (
      initial.size !== after.size ||
      initial.mtimeNs !== after.mtimeNs ||
      initial.ctimeNs !== after.ctimeNs
    )
      throw new Fault('INPUT_INVALID');
    await roots.check(source);
    const info = await inspectImage(temporary, 20971520).catch(() => {
      throw new Fault('INPUT_INVALID');
    });
    if (input.expected_sha256 && input.expected_sha256 !== info.sha256)
      throw new Fault('INPUT_INVALID');
    const target = path.join(directory, `${ordinal}-${info.sha256}.${info.extension}`);
    await rename(temporary, target);
    return {
      ordinal,
      role: input.role,
      source: input,
      path: target,
      sha256: info.sha256,
      bytes: info.bytes,
    };
  } finally {
    await handle.close();
    await unlink(temporary).catch(() => {});
  }
}
