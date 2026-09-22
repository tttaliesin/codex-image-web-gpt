const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const install = require('./installation.cjs');

async function optionalJson(file) {
  try {
    return await install.json(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function folderPath(value) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//') ||
    value.slice(2).includes(':')
  )
    throw Error('FOLDER_UNAVAILABLE');
  const resolved = path.resolve(value);
  let current = path.parse(resolved).root;
  try {
    for (const segment of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if ((await fs.lstat(current)).isSymbolicLink()) throw Error('FOLDER_LINK_REJECTED');
    }
    if (!(await fs.stat(resolved)).isDirectory()) throw Error('FOLDER_UNAVAILABLE');
    return await fs.realpath(resolved);
  } catch (error) {
    if (error.message === 'FOLDER_LINK_REJECTED') throw error;
    throw Error('FOLDER_UNAVAILABLE');
  }
}

class DesktopSetup {
  constructor(options) {
    this.options = options;
    this.working = false;
    this.registered = false;
    this.checked = false;
    this.integrationError = null;
    this.updateAvailable = false;
  }
  async initialize() {
    this.configuration = await optionalJson(this.options.config);
    if (!this.configuration) {
      this.configuration = {
        input_roots: [],
        export_roots: [],
        port: this.options.port ?? 43179,
        web_execution: true,
      };
      await install.atomic(this.options.config, this.configuration);
    }
    install.validateConfig(this.configuration);
    await this.refresh();
  }
  snapshot() {
    return {
      available: !!this.options.packageDirectory,
      registered: this.registered,
      checked: this.checked,
      working: this.working,
      error: this.integrationError,
      update_available: this.updateAvailable,
    };
  }
  async refresh() {
    if (this.options.packageDirectory) {
      const current = await optionalJson(path.join(this.options.root, 'current.json'));
      const manifest = await install.json(
        path.join(this.options.packageDirectory, 'manifest.json'),
      );
      this.updateAvailable = !!current && current.build !== manifest.build;
    }
    const receipt = await optionalJson(path.join(this.options.root, 'integration.json'));
    this.registered = false;
    this.integrationError = null;
    if (!receipt?.active) return;
    try {
      if (receipt.product !== 'web-image-bridge' || receipt.phase !== 'registered')
        throw Error('INTEGRATION_NEEDS_REPAIR');
      const config = await fs.readFile(path.join(receipt.codex, 'config.toml'), 'utf8');
      if (!config.includes(receipt.block)) throw Error('CONFIG_MANAGED_BLOCK_CHANGED');
      const actual = await install.files(receipt.skill);
      if (JSON.stringify(actual) !== JSON.stringify(receipt.skillFiles))
        throw Error('INSTALLED_SKILL_CHANGED');
      this.registered = true;
    } catch (error) {
      this.checked = false;
      this.integrationError = /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'INTEGRATION_NEEDS_REPAIR';
    }
  }
  async exclusive(run) {
    if (this.working) throw Error('SETUP_BUSY');
    this.working = true;
    try {
      return await run();
    } finally {
      this.working = false;
    }
  }
  async setFolders(kind, picked) {
    if (!['input', 'export'].includes(kind)) throw Error('INPUT_INVALID');
    if (picked === null) return { canceled: true };
    if (!Array.isArray(picked) || picked.length > 32) throw Error('INPUT_INVALID');
    return this.exclusive(async () => {
      const roots = [...new Set(await Promise.all(picked.map(folderPath)))];
      const next = { ...this.configuration, [`${kind}_roots`]: roots };
      const persist = () => install.atomic(this.options.config, next);
      if (this.options.configureFolders) await this.options.configureFolders(next, persist);
      else await persist();
      // Runtime Roots objects retain these arrays; changes apply without restarting jobs or login.
      this.configuration.input_roots.splice(
        0,
        this.configuration.input_roots.length,
        ...next.input_roots,
      );
      this.configuration.export_roots.splice(
        0,
        this.configuration.export_roots.length,
        ...next.export_roots,
      );
      this.checked = false;
      return { saved: true };
    });
  }
  async connect() {
    return this.exclusive(async () => {
      if (!this.options.packageDirectory) throw Error('PACKAGED_APP_REQUIRED');
      if (!this.configuration.export_roots.length) throw Error('OUTPUT_FOLDER_REQUIRED');
      if (path.resolve(this.options.config) !== path.resolve(this.options.root, 'mcp-config.json'))
        throw Error('INTEGRATION_TARGET_CONFLICT');
      const state = await install.install({
        root: this.options.root,
        packageDirectory: this.options.packageDirectory,
        profile: this.options.profile,
      });
      if (path.resolve(state.config) !== path.resolve(this.options.config))
        throw Error('INTEGRATION_TARGET_CONFLICT');
      const codex =
        this.options.codex ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
      const skill = this.options.skill ?? path.join(os.homedir(), '.agents/skills/imagegen');
      const bundledFile =
        this.options.bundled ?? path.join(codex, 'skills/.system/imagegen/SKILL.md');
      const bundled = await fs.stat(bundledFile).then(
        () => bundledFile,
        (e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        },
      );
      await install.register({ root: this.options.root, codex, skill, bundled });
      await this.options.shortcut?.(state);
      await this.refresh();
      this.checked = false;
      return { registered: this.registered, restart_required: true };
    });
  }
  async disconnect() {
    return this.exclusive(async () => {
      await install.unregister({ root: this.options.root });
      this.checked = false;
      await this.refresh();
      return { registered: false, restart_required: true };
    });
  }
  async check() {
    return this.exclusive(async () => {
      this.checked = false;
      await this.refresh();
      if (!this.registered) throw Error('CODEX_NOT_REGISTERED');
      const result = await this.options.health();
      if (result.tools !== 8) throw Error('MCP_CHECK_FAILED');
      this.checked = true;
      return { verified: true, tools: result.tools };
    });
  }
}
function launchContext(options) {
  let previous;
  if (options.packaged) {
    try {
      previous = JSON.parse(readFileSync(path.join(options.root, 'current.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (
      previous &&
      (previous.product !== 'web-image-bridge' ||
        !path.isAbsolute(previous.profile) ||
        !path.isAbsolute(previous.config))
    )
      throw Error('INSTALL_ROOT_CONFLICT');
  }
  return {
    ...options,
    profile: path.resolve(
      options.profile ?? previous?.profile ?? path.join(options.root, 'profile'),
    ),
    config: path.resolve(
      options.config ?? previous?.config ?? path.join(options.root, 'mcp-config.json'),
    ),
    packageDirectory: options.packaged ? path.resolve(options.appRoot, '../../..') : undefined,
  };
}
module.exports = { DesktopSetup, launchContext };
