import { parentPort, workerData } from 'node:worker_threads';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

async function inspect() {
  const file = await stat(workerData.path);
  if (!file.isFile() || file.size === 0 || file.size > workerData.maxBytes)
    throw Error('INPUT_INVALID');
  const bytes = await readFile(workerData.path);
  if (bytes.length !== file.size) throw Error('INPUT_INVALID');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) throw Error('INPUT_INVALID');
  const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 });
  const meta = await decoder.metadata();
  if (meta.pages && meta.pages !== 1) throw Error('INPUT_INVALID');
  const stats = await decoder.stats();
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mime: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp',
    extension: png ? 'png' : jpeg ? 'jpg' : 'webp',
    width: meta.width,
    height: meta.height,
    has_alpha: !!meta.hasAlpha,
    has_transparency: !stats.isOpaque,
  };
}
inspect()
  .then((value) => parentPort!.postMessage({ value }))
  .catch(() => parentPort!.postMessage({ error: 'INPUT_INVALID' }));
