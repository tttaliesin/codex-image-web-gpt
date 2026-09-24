const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const run = promisify(execFile);
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('WINDOWS_X64_REQUIRED');
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  const build = `${version}-${Date.now()}`;
  const destination = path.join(root, '.local/releases', `web-image-bridge-${build}`);
  const runtime = path.join(destination, 'runtime');
  const staging = path.join(root, '.local/package-staging', build);
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await fs.access(compiler).catch(() => {
    throw Error('WINDOWS_DOTNET_FRAMEWORK_COMPILER_REQUIRED');
  });
  await fs.mkdir(staging, { recursive: true });
  try {
    const beforeModules = await fs.readFile(path.join(root, 'node_modules/.modules.yaml'));
    for (const item of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      ...require('../package.json').files,
    ])
      await fs.cp(path.join(root, item), path.join(staging, item), {
        recursive: true,
        dereference: true,
      });
    await run(
      process.env.npm_execpath || 'pnpm',
      [
        '--dir',
        staging,
        'install',
        '--prod',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--ignore-workspace',
        '--node-linker=hoisted',
      ],
      { cwd: staging, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    if (!beforeModules.equals(await fs.readFile(path.join(root, 'node_modules/.modules.yaml'))))
      throw Error('DEVELOPMENT_INSTALL_CHANGED');
    await fs.mkdir(destination, { recursive: true });
    await fs.cp(path.dirname(require('electron')), runtime, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    });
    for (const item of ['package.json', ...require('../package.json').files, 'node_modules']) {
      await fs.cp(path.join(staging, item), path.join(runtime, 'resources/app', item), {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
        filter: (source) =>
          ![
            '.bin',
            '.pnpm',
            '.modules.yaml',
            '.package-map.json',
            '.pnpm-workspace-state-v1.json',
          ].includes(path.basename(source)),
      });
    }
    await fs.rename(path.join(runtime, 'electron.exe'), path.join(runtime, 'WebImageBridge.exe'));
    const packagedApp = path.join(runtime, 'resources/app');
    await run(
      path.join(runtime, 'WebImageBridge.exe'),
      [
        '-e',
        'const r=require("node:module").createRequire(process.argv[1]+"/package.json");for(const name of Object.keys(r("./package.json").dependencies))r(name);if(r("./dist/packages/contracts/src").toolDefinitions.length!==8)throw Error("CONTRACT_MISSING")',
        packagedApp,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    await fs.copyFile(
      path.join(root, 'scripts/windows/setup.ps1'),
      path.join(destination, 'setup.ps1'),
    );
    // The project license and third-party notices also sit where someone unzipping will look.
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
      await fs.copyFile(path.join(root, name), path.join(destination, name));
    // Windows supplies the .NET Framework compiler; the GUI entry point needs no shell.
    const png = await require('sharp')(path.join(root, 'apps/desktop/ui/icon.png'))
      .resize(256, 256)
      .png()
      .toBuffer();
    const ico = Buffer.alloc(22);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(1, 4);
    ico.writeUInt16LE(1, 10);
    ico.writeUInt16LE(32, 12);
    ico.writeUInt32LE(png.length, 14);
    ico.writeUInt32LE(22, 18);
    const icon = path.join(staging, 'launcher.ico');
    await fs.writeFile(icon, Buffer.concat([ico, png]));
    await run(
      compiler,
      [
        '/nologo',
        '/target:winexe',
        '/platform:x64',
        '/optimize+',
        '/reference:System.Windows.Forms.dll',
        `/win32icon:${icon}`,
        `/out:${path.join(destination, 'WebImageBridge.exe')}`,
        path.join(root, 'scripts/windows/launcher.cs'),
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const entries = [];
    async function visit(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile())
          entries.push({
            path: path.relative(destination, file).replaceAll('\\', '/'),
            sha256: createHash('sha256')
              .update(await fs.readFile(file))
              .digest('hex'),
          });
        else throw Error('PACKAGE_LINK_REJECTED');
      }
    }
    await visit(destination);
    if (
      entries.some((x) =>
        /(?:^|\/)\.(?:local|codex|agents)(?:\/|$)|(?:^|\/)outputs\/|mcp-token|jobs\.sqlite/.test(
          x.path,
        ),
      )
    )
      throw Error('PRIVATE_PACKAGE_CONTENT');
    if (entries.some((x) => x.path.startsWith('runtime/resources/app/dist/tests/')))
      throw Error('TEST_CODE_IN_PACKAGE');
    await fs.writeFile(
      path.join(destination, 'manifest.json'),
      JSON.stringify(
        { product: 'web-image-bridge', build, version, platform: 'win32-x64', files: entries },
        null,
        2,
      ),
    );
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(destination, 'setup.ps1'),
        '-Action',
        'verify',
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    await run('tar.exe', ['-a', '-c', '-f', `${destination}.zip`, '-C', destination, '.'], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const checksum = createHash('sha256')
      .update(await fs.readFile(`${destination}.zip`))
      .digest('hex');
    await fs.writeFile(
      `${destination}.zip.sha256`,
      `${checksum}  ${path.basename(destination)}.zip\n`,
    );
    await fs.writeFile(
      path.join(root, '.local/latest-package.json'),
      JSON.stringify(
        { directory: destination, archive: `${destination}.zip`, build, sha256: checksum },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        result: 'packaged',
        directory: destination,
        archive: `${destination}.zip`,
        files: entries.length,
        sha256: checksum,
      }),
    );
  } finally {
    // Remove only this invocation's generated staging tree; never profiles or releases.
    const stagingRoot = await fs.realpath(path.join(root, '.local/package-staging'));
    const target = await fs.realpath(staging);
    const relative = path.relative(stagingRoot, target);
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      target !== path.resolve(staging)
    )
      throw Error('STAGING_CLEANUP_PATH_REJECTED');
    await fs.rm(target, { recursive: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
