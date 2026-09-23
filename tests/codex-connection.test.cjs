const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const TOML = require('smol-toml');
const install = require('../scripts/lib/installation.cjs');
const {
  DesktopSetup,
  launchContext,
  readCodexHeaders,
} = require('../scripts/lib/desktop-setup.cjs');

const base = path.resolve('.local/tests', `codex-connection-${Date.now()}`);
async function registeredSetup(name, overrides = {}) {
  const root = path.join(base, name);
  const profile = path.join(root, 'preserved-profile');
  const codex = path.join(root, 'codex');
  const skill = path.join(root, 'skills/imagegen');
  const config = path.join(root, 'mcp-config.json');
  const server = {
    url: 'http://127.0.0.1:43179/mcp',
    http_headers_helper: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${path.join(root, 'auth-helper.ps1')}"`,
    startup_timeout_sec: 20,
    tool_timeout_sec: 45,
    enabled: true,
  };
  const block = TOML.stringify({ mcp_servers: { web_image_bridge: server } }).trim();
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), 'isolated test skill');
  await install.atomic(config, {
    input_roots: [],
    export_roots: [],
    port: 43179,
    web_execution: true,
  });
  await install.atomic(path.join(root, 'current.json'), {
    product: 'web-image-bridge',
    profile,
    config,
  });
  await install.atomic(path.join(codex, 'config.toml'), block);
  await install.atomic(path.join(root, 'integration.json'), {
    product: 'web-image-bridge',
    active: true,
    phase: 'registered',
    codex,
    skill,
    skillFiles: await install.files(skill),
    block,
  });
  const setup = new DesktopSetup({
    root,
    profile,
    config,
    readHeaders: async () => ({ Authorization: 'Bearer isolated-fixture-credential' }),
    health: async () => ({ tools: 8 }),
    ...overrides,
  });
  await setup.initialize();
  return { setup, root, profile, config, server };
}

test('connection check sends the registered Codex credentials to the MCP probe', async () => {
  let connection;
  const { setup, server } = await registeredSetup('credentials', {
    health: async (value) => {
      connection = value;
      return { tools: 8 };
    },
  });
  await setup.check();
  assert.deepEqual(connection, {
    url: server.url,
    headers: { Authorization: 'Bearer isolated-fixture-credential' },
  });
  assert.equal(setup.snapshot().checked, true);
});

test('connection status tolerates another app inserting settings inside legacy markers', async () => {
  const { setup, root } = await registeredSetup('shared-config');
  const receiptFile = path.join(root, 'integration.json');
  const receipt = await install.json(receiptFile);
  receipt.block =
    '# BEGIN Web Image Bridge managed integration\n' +
    receipt.block +
    '\n# END Web Image Bridge managed integration';
  await install.atomic(receiptFile, receipt);
  await fs.writeFile(
    path.join(receipt.codex, 'config.toml'),
    '[agents]\n' +
      receipt.block.replace(
        '[mcp_servers.web_image_bridge]',
        'max_depth = 2\n[ mcp_servers . web_image_bridge ]',
      ),
  );
  await setup.check();
  assert.equal(setup.snapshot().registered, true);
  assert.equal(setup.snapshot().checked, true);
});

test('failed Codex helper clears an earlier success instead of using internal auth', async () => {
  let probes = 0;
  const { setup } = await registeredSetup('helper-failure', {
    readHeaders: async () => {
      throw Error('CODEX_AUTH_HELPER_FAILED');
    },
    health: async () => {
      probes++;
      return { tools: 8 };
    },
  });
  setup.checked = true;
  await assert.rejects(setup.check(), /CODEX_AUTH_HELPER_FAILED/);
  assert.equal(probes, 0);
  assert.equal(setup.snapshot().checked, false);
  assert.equal(setup.snapshot().error, 'CODEX_AUTH_HELPER_FAILED');
});

test('a running profile different from the installation fails before probing', async () => {
  const { setup, root } = await registeredSetup('profile-mismatch');
  setup.options.profile = path.join(root, 'different-profile');
  setup.checked = true;
  await assert.rejects(setup.check(), /CODEX_PROFILE_MISMATCH/);
  assert.equal(setup.snapshot().checked, false);
  assert.equal(setup.snapshot().error, 'CODEX_PROFILE_MISMATCH');
});

test('MCP authentication failure is visible and never cached as a successful check', async () => {
  const { setup } = await registeredSetup('rejected', {
    health: async () => {
      throw Error('MCP_CHECK_FAILED');
    },
  });
  await assert.rejects(setup.check(), /MCP_CHECK_FAILED/);
  assert.equal(setup.snapshot().checked, false);
  assert.equal(setup.snapshot().error, 'MCP_CHECK_FAILED');
});

test('removing registration also removes an earlier successful connection status', async () => {
  const { setup, root } = await registeredSetup('removed');
  await setup.check();
  await install.atomic(path.join(root, 'integration.json'), { active: false });
  await setup.refresh();
  assert.equal(setup.snapshot().registered, false);
  assert.equal(setup.snapshot().checked, false);
});

test('helper output is validated and its execution is bounded without a shell', async () => {
  const root = path.join(base, 'install with spaces');
  const authorization = `Bearer ${'x'.repeat(43)}`;
  const headers = await readCodexHeaders(root, async (command, args, options) => {
    assert.equal(command, 'powershell.exe');
    assert.equal(args.at(-1), path.join(root, 'auth-helper.ps1'));
    assert.equal(options.cwd, root);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 15000);
    assert.equal(options.shell, undefined);
    return { stdout: JSON.stringify({ Authorization: authorization }) };
  });
  assert.deepEqual(headers, { Authorization: authorization });
  for (const stdout of ['not-json', '{}', '{"Authorization":"invalid"}']) {
    await assert.rejects(
      readCodexHeaders(root, async () => ({ stdout })),
      /CODEX_AUTH_HELPER_FAILED/,
    );
  }
});

test('helper failures do not expose child stdout or stderr', async () => {
  await assert.rejects(
    readCodexHeaders(base, async () => {
      throw Object.assign(Error('isolated-private-output'), {
        stdout: 'isolated-private-output',
        stderr: 'isolated-private-output',
      });
    }),
    (error) => {
      assert.equal(error.message, 'CODEX_AUTH_HELPER_FAILED');
      assert.equal(error.stdout, undefined);
      assert.equal(error.stderr, undefined);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test('stale shortcut arguments cannot replace the installed profile and configuration', async () => {
  const root = path.join(base, 'installed');
  const previous = {
    product: 'web-image-bridge',
    profile: path.join(base, 'preserved-profile'),
    config: path.join(root, 'mcp-config.json'),
  };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'current.json'), JSON.stringify(previous));
  const selected = launchContext({
    root,
    packaged: true,
    appRoot: path.join(root, 'new-package/runtime/resources/app'),
    profile: path.join(base, 'stale-profile'),
    config: path.join(base, 'stale-config.json'),
  });
  assert.equal(selected.profile, previous.profile);
  assert.equal(selected.config, previous.config);
});
