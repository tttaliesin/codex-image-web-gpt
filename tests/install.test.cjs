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
  for (const [file, content] of Object.entries({
    'user-data': 'preserve',
    'Local State': 'isolated-fixture-encryption-state',
    'm1/auth/mcp-token.enc': 'isolated-fixture-encrypted-credential',
    'm1/jobs.sqlite': 'isolated-fixture-job-history',
    'Partitions/web-image-primary/Network/Cookies': 'isolated-fixture-login',
  })) {
    await fs.mkdir(path.dirname(path.join(profile, file)), { recursive: true });
    await fs.writeFile(path.join(profile, file), content);
  }
  const preserved = await install.files(profile);
  const first = await install.install({
    root,
    profile,
    packageDirectory: await fixture('0.1.0-first'),
  });
  const configuration = await fs.readFile(first.config);
  await install.install({ root, packageDirectory: await fixture('0.1.0-second') });
  assert.deepEqual(await install.files(profile), preserved);
  assert.equal((await install.json(path.join(root, 'current.json'))).profile, profile);
  await install.rollback({ root });
  assert.deepEqual(await install.files(profile), preserved);
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

async function sharedConfigFixture(name) {
  const root = path.join(base, name);
  const codex = path.join(root, 'codex');
  const skill = path.join(root, 'skills/imagegen');
  const bundled = path.join(root, 'bundled/SKILL.md');
  await install.install({ root, packageDirectory: await fixture(`0.2.0-${name}`) });
  await fs.mkdir(codex, { recursive: true });
  await fs.mkdir(path.dirname(bundled), { recursive: true });
  await fs.writeFile(bundled, 'upstream');
  const configFile = path.join(codex, 'config.toml');
  await fs.writeFile(configFile, '[agents]\n');
  const options = { root, codex, skill, bundled };
  await install.register(options);
  return { ...options, options, configFile };
}

test('shared config: foreign settings inside legacy markers survive connect and disconnect', async () => {
  const { root, options, configFile } = await sharedConfigFixture('foreign-in-marker');
  const text = (await fs.readFile(configFile, 'utf8'))
    .replace(
      '# BEGIN Web Image Bridge managed integration',
      '# BEGIN Web Image Bridge managed integration\nmax_depth = 2 # owned by another app',
    )
    .replace(
      '[[skills.config]]',
      '# another app comment\n[mcp_servers.another_app]\nurl = "http://localhost:9999/mcp"\n[[skills.config]]',
    );
  await fs.writeFile(configFile, text);
  await install.register(options);
  assert.equal(await fs.readFile(configFile, 'utf8'), text);
  // An idempotent registration has identical before/after text; its journal must
  // still recover as an existing registration after an interrupted receipt write.
  const receiptFile = path.join(root, 'integration.json');
  await install.atomic(receiptFile, {
    ...(await install.json(receiptFile)),
    phase: 'registering',
    before_sha256: install.hash(text),
  });
  await install.register(options);
  assert.equal((await install.json(receiptFile)).phase, 'registered');
  assert.equal(await fs.readFile(configFile, 'utf8'), text);
  await install.unregister({ root });
  const remaining = await fs.readFile(configFile, 'utf8');
  assert.equal(TOML.parse(remaining).agents.max_depth, 2);
  assert.deepEqual(TOML.parse(remaining).mcp_servers, {
    another_app: { url: 'http://localhost:9999/mcp' },
  });
  assert.match(remaining, /# owned by another app/);
  assert.match(remaining, /# another app comment/);
  assert.equal(TOML.parse(remaining).skills, undefined);
});

test('shared config: TOML reformatting and reordering do not change ownership', async () => {
  const { root, options, configFile } = await sharedConfigFixture('reformatted');
  const parsed = TOML.parse(await fs.readFile(configFile, 'utf8'));
  const text = TOML.stringify({
    notes:
      'example:\n[mcp_servers.web_image_bridge]\n# BEGIN Web Image Bridge managed integration\n',
    skills: {
      config: [
        { path: 'other.md', enabled: true },
        ...parsed.skills.config,
        { path: 'last.md', enabled: false },
      ],
    },
    agents: { max_depth: 2 },
    mcp_servers: parsed.mcp_servers,
  })
    .replace('[mcp_servers.web_image_bridge]', "[ 'mcp_servers' . 'web_image_bridge' ]")
    .replaceAll('\n', '\r\n');
  await fs.writeFile(configFile, text);
  await install.register(options);
  assert.equal(await fs.readFile(configFile, 'utf8'), text);
  await install.unregister({ root });
  const remaining = TOML.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(remaining.agents.max_depth, 2);
  assert.equal(remaining.notes, TOML.parse(text).notes);
  assert.deepEqual(remaining.skills.config, [
    { path: 'other.md', enabled: true },
    { path: 'last.md', enabled: false },
  ]);
  assert.equal(remaining.mcp_servers, undefined);
});

test('shared config: actual edits to owned settings are rejected without writes', async () => {
  const { root, options, configFile } = await sharedConfigFixture('owned-conflict');
  const original = await fs.readFile(configFile, 'utf8');
  const skillFiles = await install.files(options.skill);
  const receipt = await fs.readFile(path.join(root, 'integration.json'));
  for (const changed of [
    original.replace('43179', '43180'),
    original.replace('enabled = false', 'enabled = true'),
  ]) {
    await fs.writeFile(configFile, changed);
    await assert.rejects(install.register(options), /CONFIG_MANAGED_BLOCK_CHANGED/);
    await assert.rejects(install.unregister({ root }), /CONFIG_MANAGED_BLOCK_CHANGED/);
    assert.equal(await fs.readFile(configFile, 'utf8'), changed);
    assert.deepEqual(await install.files(options.skill), skillFiles);
    assert.deepEqual(await fs.readFile(path.join(root, 'integration.json')), receipt);
  }
});
