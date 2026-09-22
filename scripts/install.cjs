// Electron's Node mode still virtualizes .asar paths. Installers must hash and
// copy the archive bytes, not traverse the virtual archive filesystem.
process.noAsar = true;
const path = require('node:path');
const os = require('node:os');
const operations = require('./lib/installation.cjs');
const args = process.argv.slice(2),
  action = args.shift();
function option(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
}
async function main() {
  const root = path.resolve(
    option('root', path.join(process.env.LOCALAPPDATA || os.homedir(), 'WebImageBridge')),
  );
  const codex = path.resolve(
    option('codex', process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
  );
  const options = {
    root,
    codex,
    packageDirectory: option('package'),
    profile: option('profile'),
    config: option('config'),
    skill: option('skill', path.join(os.homedir(), '.agents/skills/imagegen')),
    bundled: option('bundled', path.join(codex, 'skills/.system/imagegen/SKILL.md')),
  };
  if (action === 'verify') {
    const manifest = await operations.verifyPackage(options.packageDirectory);
    console.log(
      JSON.stringify({ verified: true, build: manifest.build, files: manifest.files.length }),
    );
  } else if (action === 'status')
    console.log(JSON.stringify(await operations.json(path.join(root, 'current.json')), null, 2));
  else if (['install', 'register', 'unregister', 'rollback'].includes(action))
    console.log(JSON.stringify(await operations[action](options), null, 2));
  else throw Error('Use install, register, unregister, rollback, status or verify.');
}
main().catch((error) => {
  console.error(error.code || (/^[A-Z_]+$/.test(error.message) ? error.message : 'INSTALL_FAILED'));
  process.exitCode = 1;
});
