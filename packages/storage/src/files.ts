import { Worker } from 'node:worker_threads';
import { copyFile, mkdir, open, readFile, realpath, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface ImageInfo {
  bytes: number;
  sha256: string;
  mime: string;
  extension: string;
  width: number;
  height: number;
  has_alpha: boolean;
  has_transparency: boolean;
}
export function inspectImage(file: string, maxBytes = 100 * 1024 * 1024): Promise<ImageInfo> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'image-worker.js'), {
      workerData: { path: file, maxBytes },
    });
    worker.once('message', (result) =>
      result.error ? reject(Error(result.error)) : resolve(result.value),
    );
    worker.once('error', () => reject(Error('IMAGE_WORKER_FAILED')));
    worker.once('exit', (code) => {
      if (code !== 0) reject(Error('IMAGE_WORKER_FAILED'));
    });
  });
}
export async function durableJson(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function stageInput(source: string, directory: string, ordinal: number) {
  if (!path.isAbsolute(source)) throw Error('INPUT_NOT_LOCAL');
  await mkdir(directory, { recursive: true });
  const previous = (await readdir(directory, { withFileTypes: true })).filter((entry) =>
    entry.name.startsWith(`${ordinal + 1}-`),
  );
  if (previous.length > 1 || previous.some((entry) => !entry.isFile()))
    throw Error('INPUT_STAGING_CONFLICT');
  if (previous.length === 1) {
    const name = previous[0]!.name;
    const staged = path.join(directory, name);
    const info = await inspectImage(staged, 20 * 1024 * 1024);
    if (name !== `${ordinal + 1}-${info.sha256.slice(0, 16)}.${info.extension}`)
      throw Error('INPUT_CHANGED');
    return { path: staged, name, ...info };
  }
  const actual = await realpath(source);
  const before = await inspectImage(actual, 20 * 1024 * 1024);
  await mkdir(directory, { recursive: true });
  const staged = path.join(
    directory,
    `${ordinal + 1}-${before.sha256.slice(0, 16)}.${before.extension}`,
  );
  const temporary = path.join(directory, `.${randomUUID()}.part`);
  await copyFile(actual, temporary, constants.COPYFILE_EXCL);
  const after = await inspectImage(temporary, 20 * 1024 * 1024);
  if (before.sha256 !== after.sha256) throw Error('INPUT_CHANGED');
  await rename(temporary, staged);
  return { path: staged, name: path.basename(staged), ...after };
}
