// Installer checksums and copies physical ASAR bytes, including from the desktop GUI.
const fs = process.versions.electron
  ? require('original-fs').promises
  : require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const TOML = require('smol-toml');
const product = 'web-image-bridge';
const begin = '# BEGIN Web Image Bridge managed integration';
const end = '# END Web Image Bridge managed integration';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async (file) =>
  fs.stat(file).then(
    () => true,
    (e) => {
      if (e.code === 'ENOENT') return false;
      throw e;
    },
  );
function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw Error('INSTALL_PATH_REJECTED');
  return path.resolve(file);
}
async function noLinks(file) {
  let current = path.resolve(file);
  while (true) {
    const st = await fs.lstat(current).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    if (st?.isSymbolicLink()) throw Error('INSTALL_LINK_REJECTED');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function atomic(file, value) {
  await noLinks(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try {
    await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
}
async function files(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = inside(root, path.join(directory, entry.name));
      if (entry.isSymbolicLink()) throw Error('INSTALL_LINK_REJECTED');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile())
        result.push({
          path: path.relative(root, file).replaceAll('\\', '/'),
          sha256: hash(await fs.readFile(file)),
        });
      else throw Error('INSTALL_FILE_REJECTED');
    }
  }
  await visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
async function verifyPackage(directory) {
  await noLinks(directory);
  const manifest = await json(path.join(directory, 'manifest.json'));
  if (
    manifest.product !== product ||
    manifest.platform !== 'win32-x64' ||
    !/^[0-9][a-zA-Z0-9.-]+$/.test(manifest.build) ||
    !Array.isArray(manifest.files)
  )
    throw Error('PACKAGE_INVALID');
  const actual = (await files(directory)).filter((x) => x.path !== 'manifest.json');
  const expected = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
  if (!isDeepStrictEqual(actual, expected)) throw Error('PACKAGE_CHECKSUM_MISMATCH');
  for (const file of [
    'runtime/WebImageBridge.exe',
    'runtime/resources/app/package.json',
    'setup.ps1',
  ])
    if (!expected.some((x) => x.path === file)) throw Error('PACKAGE_INCOMPLETE');
  return manifest;
}
function validateConfig(config) {
  if (
    !Array.isArray(config.input_roots) ||
    !Array.isArray(config.export_roots) ||
    [...config.input_roots, ...config.export_roots].some(
      (x) => typeof x !== 'string' || !path.isAbsolute(x),
    ) ||
    config.web_execution !== true ||
    !Number.isInteger(config.port ?? 43179) ||
    (config.port ?? 43179) < 1 ||
    (config.port ?? 43179) > 65535
  )
    throw Error('MCP_CONFIG_INVALID');
}
async function install({ root, packageDirectory, profile, config }) {
  root = path.resolve(root);
  await noLinks(root);
  const manifest = await verifyPackage(packageDirectory);
  const stateFile = path.join(root, 'current.json');
  const previous = (await exists(stateFile)) ? await json(stateFile) : null;
  if (previous && previous.product !== product) throw Error('INSTALL_ROOT_CONFLICT');
  const selectedProfile = path.resolve(profile || previous?.profile || path.join(root, 'profile'));
  if (previous && selectedProfile !== previous.profile)
    throw Error('PROFILE_CHANGE_REQUIRES_NEW_INSTALL');
  const configFile = path.join(root, 'mcp-config.json');
  const configuration = config
    ? await json(config)
    : (await exists(configFile))
      ? await json(configFile)
      : { input_roots: [], export_roots: [], port: 43179, web_execution: true };
  validateConfig(configuration);
  if (previous && !isDeepStrictEqual(configuration, await json(configFile)))
    throw Error('CONFIG_UPDATE_REQUIRES_EXPLICIT_EDIT');
  const destination = inside(root, path.join(root, 'versions', manifest.build));
  await noLinks(destination);
  await noLinks(selectedProfile);
  if (await exists(destination)) {
    if (!isDeepStrictEqual(await verifyPackage(destination), manifest))
      throw Error('BUILD_ID_CONFLICT');
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(packageDirectory, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await verifyPackage(destination);
  }
  if (!(await exists(configFile))) await atomic(configFile, configuration);
  const appRoot = path.join(destination, 'runtime/resources/app');
  for (const name of ['launch.ps1', 'auth-helper.ps1']) {
    const target = path.join(root, name),
      content = await fs.readFile(path.join(appRoot, 'scripts/windows', name), 'utf8');
    if ((await exists(target)) && !previous) throw Error('INSTALL_WRAPPER_CONFLICT');
    await atomic(target, content);
  }
  const history =
    previous && previous.build !== manifest.build
      ? [...(previous.history || []), { ...previous, history: undefined }]
      : previous?.history || [];
  const state = {
    product,
    build: manifest.build,
    directory: destination,
    exe: path.join(destination, 'runtime/WebImageBridge.exe'),
    profile: selectedProfile,
    config: configFile,
    history,
  };
  await atomic(stateFile, state);
  return state;
}
function stripManaged(text, expectedBlock) {
  const start = text.indexOf(begin),
    finish = text.indexOf(end);
  if (start < 0 && finish < 0) {
    if (expectedBlock) throw Error('CONFIG_MANAGED_BLOCK_MISSING');
    return text;
  }
  if (
    start < 0 ||
    finish < start ||
    text.indexOf(begin, start + begin.length) >= 0 ||
    text.indexOf(end, finish + end.length) >= 0
  )
    throw Error('CONFIG_MANAGED_BLOCK_CONFLICT');
  const last = finish + end.length;
  const block = text.slice(start, last);
  if (!expectedBlock || block !== expectedBlock) throw Error('CONFIG_MANAGED_BLOCK_CHANGED');
  return text.slice(0, start) + text.slice(last);
}
function integrationBlock({ root, state, bundled }) {
  const config = {
    mcp_servers: {
      web_image_bridge: {
        url: `http://127.0.0.1:${state.port}/mcp`,
        http_headers_helper: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${path.join(root, 'auth-helper.ps1')}"`,
        startup_timeout_sec: 20,
        tool_timeout_sec: 45,
        enabled: true,
      },
    },
    ...(bundled ? { skills: { config: [{ path: bundled, enabled: false }] } } : {}),
  };
  return `${begin}\n${TOML.stringify(config).trim()}\n${end}`;
}
async function register({ root, codex, skill, bundled }) {
  root = path.resolve(root);
  codex = path.resolve(codex);
  skill = path.resolve(skill);
  bundled = bundled ? path.resolve(bundled) : null;
  if (
    path.basename(skill) !== 'imagegen' ||
    (bundled &&
      (path.basename(bundled) !== 'SKILL.md' || path.resolve(skill, 'SKILL.md') === bundled))
  )
    throw Error('SKILL_PATH_REJECTED');
  await noLinks(codex);
  await noLinks(skill);
  if (bundled) await noLinks(bundled);
  const state = await json(path.join(root, 'current.json'));
  if (state.product !== product) throw Error('INSTALL_ROOT_CONFLICT');
  const configFile = path.join(codex, 'config.toml');
  const text = await fs.readFile(configFile, 'utf8').catch((e) => {
    if (e.code !== 'ENOENT') throw e;
    return '';
  });
  const receiptFile = path.join(root, 'integration.json');
  const prior = (await exists(receiptFile)) ? await json(receiptFile) : null;
  if (
    prior?.active &&
    (prior.codex !== codex || prior.skill !== skill || prior.bundled !== bundled)
  )
    throw Error('INTEGRATION_TARGET_CONFLICT');
  const recoveringRegistration =
    prior?.active &&
    prior.phase === 'registering' &&
    !text.includes(begin) &&
    hash(text) === prior.before_sha256;
  const base = recoveringRegistration
    ? text
    : stripManaged(text, prior?.active ? prior.block : undefined);
  const parsed = TOML.parse(base, { integersAsBigInt: 'asNeeded' });
  if (
    parsed.mcp_servers?.web_image_bridge ||
    (bundled && parsed.skills?.config?.some((x) => path.resolve(x.path) === bundled))
  )
    throw Error('EXISTING_CONFIG_CONFLICT');
  const source = path.join(state.directory, 'runtime/resources/app/skills/imagegen');
  const sourceFiles = await files(source);
  if (await exists(skill)) {
    if (!prior?.active || !isDeepStrictEqual(await files(skill), prior.skillFiles))
      throw Error('EXISTING_SKILL_CONFLICT');
    if (!isDeepStrictEqual(sourceFiles, prior.skillFiles))
      throw Error('SKILL_UPDATE_REQUIRES_UNREGISTER');
  }
  const config = await json(state.config);
  validateConfig(config);
  const block = integrationBlock({ root, state: { port: config.port ?? 43179 }, bundled });
  const updated = base.replace(/\s*$/, '') + '\n\n' + block + '\n';
  const check = TOML.parse(updated, { integersAsBigInt: 'asNeeded' });
  delete check.mcp_servers.web_image_bridge;
  if (!Object.keys(check.mcp_servers).length && !parsed.mcp_servers) delete check.mcp_servers;
  if (bundled) {
    check.skills.config.pop();
    if (!check.skills.config.length && !parsed.skills?.config) delete check.skills.config;
    if (!Object.keys(check.skills).length && !parsed.skills) delete check.skills;
  }
  if (!isDeepStrictEqual(parsed, check)) throw Error('UNRELATED_CONFIG_CHANGED');
  const backup = path.join(root, 'backups', `codex-${Date.now()}-${randomUUID()}.toml`);
  await atomic(backup, text);
  if (!(await exists(skill))) {
    await fs.mkdir(path.dirname(skill), { recursive: true });
    await fs.cp(source, skill, { recursive: true, force: false, errorOnExist: true });
  }
  if (
    (await fs
      .readFile(configFile, 'utf8')
      .catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)))) !== text
  )
    throw Error('CONFIG_CONCURRENT_EDIT');
  const receipt = {
    product,
    active: true,
    phase: 'registering',
    before_sha256: hash(text),
    codex,
    skill,
    bundled,
    bundled_sha256: bundled ? hash(await fs.readFile(bundled)) : null,
    skillFiles: sourceFiles,
    block,
    backup,
  };
  // Save recovery information before changing configuration.
  await atomic(receiptFile, receipt);
  await atomic(configFile, updated);
  await atomic(receiptFile, { ...receipt, phase: 'registered' });
  return { registered: true, config: configFile, skill, backup };
}
async function unregister({ root }) {
  root = path.resolve(root);
  const receiptFile = path.join(root, 'integration.json'),
    receipt = await json(receiptFile);
  if (receipt.product !== product) throw Error('INTEGRATION_RECEIPT_INVALID');
  if (!receipt.active) return { registered: false };
  const configFile = path.join(receipt.codex, 'config.toml'),
    text = await fs.readFile(configFile, 'utf8');
  const recoveringRemoval =
    receipt.phase === 'unregistering' &&
    !text.includes(begin) &&
    hash(text) === receipt.after_sha256;
  const updated = recoveringRemoval ? text : stripManaged(text, receipt.block);
  TOML.parse(updated, { integersAsBigInt: 'asNeeded' });
  await noLinks(receipt.skill);
  const savedSkill = inside(
    root,
    receipt.phase === 'unregistering'
      ? receipt.savedSkill
      : path.join(root, 'backups', `imagegen-${Date.now()}-${randomUUID()}`),
  );
  const currentSkill = (await exists(receipt.skill)) ? receipt.skill : savedSkill;
  if (!isDeepStrictEqual(await files(currentSkill), receipt.skillFiles))
    throw Error('INSTALLED_SKILL_CHANGED');
  await noLinks(savedSkill);
  await fs.mkdir(path.dirname(savedSkill), { recursive: true });
  await atomic(receiptFile, {
    ...receipt,
    phase: 'unregistering',
    after_sha256: hash(updated),
    savedSkill,
  });
  await atomic(configFile, updated);
  if (currentSkill !== savedSkill) await fs.rename(path.resolve(receipt.skill), savedSkill);
  await atomic(receiptFile, { ...receipt, active: false, phase: 'unregistered', savedSkill });
  return { registered: false, preserved_profile: true, savedSkill };
}
async function rollback({ root }) {
  root = path.resolve(root);
  const file = path.join(root, 'current.json'),
    state = await json(file);
  if (state.product !== product || !state.history?.length) throw Error('NO_PREVIOUS_VERSION');
  const history = [...state.history],
    previous = history.pop();
  inside(root, previous.directory);
  await verifyPackage(previous.directory);
  if (previous.profile !== state.profile || previous.config !== state.config)
    throw Error('ROLLBACK_PROFILE_CONFLICT');
  await atomic(file, { ...previous, history });
  return { build: previous.build, preserved_profile: true };
}
module.exports = {
  install,
  register,
  unregister,
  rollback,
  verifyPackage,
  files,
  inside,
  atomic,
  json,
  hash,
  validateConfig,
};
