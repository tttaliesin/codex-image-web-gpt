import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { inspectImage, stageInput } from '../../packages/storage/src/files';

test('image inspection decodes bytes, rejects disguised/truncated/oversized files and preserves staged bytes', async () => {
  await mkdir('.local/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.local/tests/images-'));
  const png = path.join(root, 'image.png');
  await writeFile(
    png,
    await sharp({
      create: { width: 7, height: 9, channels: 4, background: { r: 30, g: 40, b: 50, alpha: 0.5 } },
    })
      .png()
      .toBuffer(),
  );
  const info = await inspectImage(png);
  assert.equal(info.width, 7);
  assert.equal(info.height, 9);
  assert.equal(info.has_alpha, true);
  assert.equal(info.has_transparency, true);
  const staged = await stageInput(png, path.join(root, 'staged'), 0);
  assert.equal(staged.sha256, info.sha256);
  await assert.rejects(inspectImage(png, 1), /INPUT_INVALID/);
  const spoof = path.join(root, 'spoof.png');
  await writeFile(spoof, '<html>not an image</html>');
  await assert.rejects(inspectImage(spoof), /INPUT_INVALID/);
  const broken = path.join(root, 'broken.png');
  await writeFile(broken, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await assert.rejects(inspectImage(broken), /INPUT_INVALID/);
});
