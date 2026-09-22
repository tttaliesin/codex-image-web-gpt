const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const root = path.resolve(__dirname, '..');
if (process.argv[2])
  throw Error('Run integration tests from source; release packages exclude fixtures.');
const profile = path.join(root, '.local', 'tests', `electron-${Date.now()}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
async function launch(stage, extra = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      require('electron'),
      [
        root,
        stage === 'setup'
          ? '--setup-test'
          : stage === 'operations'
            ? '--operations-test'
            : '--self-test',
        '--profile',
        ['operations', 'setup'].includes(stage) ? path.join(profile, stage) : profile,
        '--stage',
        stage,
        ...extra,
      ],
      { env, stdio: 'inherit', windowsHide: true },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(Error('Electron test timeout'));
    }, 90000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(Error(`Electron test exit ${code}`));
    });
  });
}
(async () => {
  await mkdir(profile, { recursive: true });
  await launch('first');
  await launch('restart');
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const configuration = path.join(profile, 'operations-config.json');
  await writeFile(
    configuration,
    JSON.stringify({ input_roots: [], export_roots: [profile], port, web_execution: true }),
  );
  await launch('operations', ['--mcp-config', configuration]);
  const setupConfiguration = path.join(profile, 'setup/desktop/mcp-config.json');
  await mkdir(path.dirname(setupConfiguration), { recursive: true });
  await writeFile(
    setupConfiguration,
    JSON.stringify({ input_roots: [], export_roots: [], port, web_execution: true }),
  );
  await launch('setup', ['--mcp-config', setupConfiguration]);
  console.log(`Evidence: ${profile}`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
