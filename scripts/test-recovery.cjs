const { spawn, execFile } = require('node:child_process');
const { mkdir, readFile, writeFile, stat, readdir } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { recoveryServer } = require('../tests/recovery/server.cjs');
const root = path.resolve(__dirname, '..'),
  base = path.join(root, '.local/tests', `recovery-${Date.now()}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) =>
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}
async function main() {
  const server = await recoveryServer();
  const evidence = [];
  try {
    const cases = process.argv.slice(2);
    for (const name of cases.length
      ? cases
      : [
          'before-marker',
          'marker',
          'after-click',
          'confirmed',
          'download-mid',
          'download-published',
          'artifact-published',
          'export-published',
          'export-first',
          'shutdown-download',
        ]) {
      const profile = path.join(base, name),
        directory = path.join(profile, 'app'),
        output = path.join(profile, 'output');
      await mkdir(output, { recursive: true });
      const configFile = path.join(profile, 'config.json');
      let before = [];
      for (const stage of ['crash', 'recover']) {
        await writeFile(
          configFile,
          JSON.stringify({ name, stage, profile, directory, output, origin: server.origin }),
        );
        const child = spawn(
          require('electron'),
          [path.join(root, 'dist/tests/recovery/entry.js'), configFile],
          { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        );
        let logs = '';
        child.stdout.on('data', (x) => (logs += x));
        child.stderr.on('data', (x) => (logs += x));
        const ended = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        });
        try {
          const deadline = Date.now() + 30000;
          if (stage === 'crash') {
            while (
              !(await stat(path.join(profile, 'barrier.json')).then(
                () => true,
                () => false,
              ))
            ) {
              if (child.exitCode !== null || Date.now() > deadline)
                throw Error(`${name} barrier failed: ${logs}`);
              await new Promise((r) => setTimeout(r, 50));
            }
            before = await Promise.all(
              (await readdir(output))
                .filter((x) => !x.startsWith('.'))
                .map(async (x) => ({
                  name: x,
                  hash: createHash('sha256')
                    .update(await readFile(path.join(output, x)))
                    .digest('hex'),
                  mtime: (await stat(path.join(output, x))).mtimeMs,
                })),
            );
            if (name === 'shutdown-download') assert.equal(await ended, 0);
            else {
              await kill(child);
              await ended;
            }
          } else {
            const timer = setTimeout(() => void kill(child), 30000);
            const code = await ended;
            clearTimeout(timer);
            if (code !== 0) throw Error(`${name} recovery failed (${code}): ${logs}`);
            for (const file of before) {
              assert.equal(
                createHash('sha256')
                  .update(await readFile(path.join(output, file.name)))
                  .digest('hex'),
                file.hash,
              );
              assert.equal((await stat(path.join(output, file.name))).mtimeMs, file.mtime);
            }
          }
        } finally {
          await kill(child);
        }
      }
      const result = JSON.parse(await readFile(path.join(profile, 'result.json'), 'utf8'));
      const counts = server.counts(name);
      assert.equal(counts.sends, name === 'marker' ? 0 : 1, `${name} duplicated send`);
      assert.equal(
        counts.downloads,
        ['marker', 'after-click'].includes(name)
          ? 0
          : ['download-mid', 'shutdown-download'].includes(name) || name.startsWith('export-')
            ? 2
            : 1,
        `${name} download count`,
      );
      const barrier = JSON.parse(await readFile(path.join(profile, 'barrier.json'), 'utf8'));
      evidence.push({
        ...result,
        ...counts,
        preserved_exports: before.length,
        ...(barrier.graceful ? { shutdown_ms: barrier.elapsed_ms } : {}),
      });
      console.log('PASS m3-recovery-' + name);
    }
    await writeFile(
      path.join(base, 'results.json'),
      JSON.stringify({ result: 'passed', checks: evidence }, null, 2),
    );
    console.log('Evidence: ' + base);
  } finally {
    await server.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
