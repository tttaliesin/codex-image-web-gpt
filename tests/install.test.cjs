const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const TOML = require('smol-toml');
const install = require('../scripts/lib/installation.cjs');
const base = path.resolve('.local/tests', `m4-install-${Date.now()}`);
async function fixture(build) {
  const root = path.join(base, build);
  const content = {
    'runtime/WebImageBridge.exe': 'fixture',
    'runtime/resources/app/package.json': '{}',
    'setup.ps1': '# fixture',
    'runtime/resources/app/scripts/windows/launch.ps1': '# launch',
    'runtime/resources/app/scripts/windows/auth-helper.ps1': '# helper',
    'runtime/resources/app/skills/imagegen/SKILL.md':
      '---\nname: imagegen\ndescription: fixture\n---\nfixture',
  };
  for (const [name, text] of Object.entries(content)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  await install.atomic(path.join(root, 'manifest.json'), {
    product: 'web-image-bridge',
    build,
    version: '0.1.0',
    platform: 'win32-x64',
    files: await install.files(root),
  });
  return root;
}
test('M4 install, update and rollback preserve profile, configuration and old version', async () => {
  const root = path.join(base, 'installed'),
    profile = path.join(base, 'existing-profile');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'user-data'), 'preserve');
  const first = await install.install({
    root,
    profile,
    packageDirectory: await fixture('0.1.0-first'),
  });
  const configuration = await fs.readFile(first.config);
  await install.install({ root, packageDirectory: await fixture('0.1.0-second') });
  await install.rollback({ root });
  assert.equal((await install.json(path.join(root, 'current.json'))).build, first.build);
  assert.deepEqual(await fs.readFile(first.config), configuration);
  assert.equal(await fs.readFile(path.join(profile, 'user-data'), 'utf8'), 'preserve');
  await fs.stat(path.join(root, 'versions/0.1.0-second/runtime/WebImageBridge.exe'));
});
test('M4 register/unregister preserve unrelated TOML edits and upstream skill', async () => {
  const root = path.join(base, 'registration'),
    codex = path.join(base, 'codex'),
    skill = path.join(base, 'skills/imagegen'),
    bundled = path.join(base, 'bundled/SKILL.md');
  await install.install({ root, packageDirectory: await fixture('0.1.0-register') });
  await fs.mkdir(codex, { recursive: true });
  await fs.mkdir(path.dirname(bundled), { recursive: true });
  await fs.writeFile(bundled, 'original');
  const original =
    '# preserve comment\nmodel = "unchanged"\n[features]\nsome_flag = true\n[[skills.config]]\npath = "unrelated.md"\nenabled = false\n';
  await fs.writeFile(path.join(codex, 'config.toml'), original);
  await install.register({ root, codex, skill, bundled });
  let text = await fs.readFile(path.join(codex, 'config.toml'), 'utf8');
  assert.ok(text.startsWith(original.trimEnd()));
  assert.equal(TOML.parse(text).mcp_servers.web_image_bridge.url, 'http://127.0.0.1:43179/mcp');
  await install.register({ root, codex, skill, bundled });
  await fs.appendFile(path.join(codex, 'config.toml'), '\n[unrelated_after_install]\nvalue = 42\n');
  await install.unregister({ root });
  text = await fs.readFile(path.join(codex, 'config.toml'), 'utf8');
  assert.equal(TOML.parse(text).unrelated_after_install.value, 42);
  assert.equal(TOML.parse(text).skills.config.length, 1);
  assert.equal(await fs.readFile(bundled, 'utf8'), 'original');
  assert.equal(
    await fs.stat(skill).then(
      () => true,
      () => false,
    ),
    false,
  );
});
test('M4 rejects modified packages, unmanaged settings and edited installed skills', async () => {
  const packageDirectory = await fixture('0.1.0-tamper');
  await fs.appendFile(path.join(packageDirectory, 'runtime/WebImageBridge.exe'), 'changed');
  await assert.rejects(
    install.install({ root: path.join(base, 'bad'), packageDirectory }),
    /CHECKSUM/,
  );
  const root = path.join(base, 'conflict'),
    codex = path.join(base, 'conflict-codex'),
    skill = path.join(base, 'conflict-skills/imagegen'),
    bundled = path.join(base, 'bundled/SKILL.md');
  await install.install({ root, packageDirectory: await fixture('0.1.0-conflict') });
  await fs.mkdir(codex, { recursive: true });
  await fs.writeFile(
    path.join(codex, 'config.toml'),
    '[mcp_servers.web_image_bridge]\nurl = "http://example.invalid"\n',
  );
  await assert.rejects(
    install.register({ root, codex, skill, bundled }),
    /EXISTING_CONFIG_CONFLICT/,
  );
  await fs.writeFile(path.join(codex, 'config.toml'), '');
  await install.register({ root, codex, skill, bundled });
  await fs.appendFile(path.join(skill, 'SKILL.md'), randomUUID());
  const before = await fs.readFile(path.join(codex, 'config.toml'));
  await assert.rejects(install.unregister({ root }), /INSTALLED_SKILL_CHANGED/);
  assert.deepEqual(await fs.readFile(path.join(codex, 'config.toml')), before);
});
test('M4 interrupted registration and removal can resume from their journal', async () => {
  const root = path.join(base, 'journal'),
    codex = path.join(base, 'journal-codex'),
    skill = path.join(base, 'journal-skills/imagegen'),
    bundled = path.join(base, 'bundled/SKILL.md');
  await install.install({ root, packageDirectory: await fixture('0.1.0-journal') });
  await fs.mkdir(codex, { recursive: true });
  const configuration = path.join(codex, 'config.toml'),
    receiptFile = path.join(root, 'integration.json');
  await fs.writeFile(configuration, '# original\n');
  await install.register({ root, codex, skill, bundled });
  let receipt = await install.json(receiptFile);
  await fs.writeFile(configuration, '# original\n');
  await install.atomic(receiptFile, {
    ...receipt,
    phase: 'registering',
    before_sha256: install.hash('# original\n'),
  });
  await install.register({ root, codex, skill, bundled });
  receipt = await install.json(receiptFile);
  const text = await fs.readFile(configuration, 'utf8'),
    remaining = text.replace(receipt.block, '');
  await install.atomic(receiptFile, {
    ...receipt,
    phase: 'unregistering',
    after_sha256: install.hash(remaining),
    savedSkill: path.join(root, 'backups/interrupted-skill'),
  });
  await fs.writeFile(configuration, remaining);
  await install.unregister({ root });
  assert.equal((await install.json(receiptFile)).active, false);
  assert.equal(await fs.readFile(configuration, 'utf8'), remaining);
});
