import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dialog, clipboard, type BrowserWindow, type WebContentsView } from 'electron';
import { Cdp, until } from '../../packages/browser/src/cdp';
import type { BridgeService } from '../../packages/core/src/service';
import { durableJson } from '../../packages/storage/src/files';

export async function setupSelfTest(
  window: BrowserWindow,
  view: WebContentsView,
  setup: any,
  service: BridgeService,
  profile: string,
) {
  const ui = new Cdp(window.webContents);
  ui.connect();
  const installer = require(path.resolve(__dirname, '../../../scripts/lib/installation.cjs'));
  const packageDirectory = path.join(profile, 'package');
  const codex = path.join(profile, 'codex');
  const skill = path.join(profile, 'skills/imagegen');
  const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
  // Exercise the real windowless Electron auth helper against this isolated profile.
  // The fixture package's executable is intentionally not an installable runtime.
  const authHelper = [
    "$ErrorActionPreference = 'Stop'",
    "$bridgeState = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'current.json') -Raw | ConvertFrom-Json",
    'Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
    `& ${psLiteral(process.execPath)} ${psLiteral(path.resolve(__dirname, '../../..'))} --mcp-headers-helper --profile $bridgeState.profile`,
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('\n');
  for (const [name, value] of Object.entries({
    'runtime/WebImageBridge.exe': 'local installer fixture',
    'runtime/resources/app/package.json': '{}',
    'setup.ps1': '# fixture',
    'runtime/resources/app/scripts/windows/launch.ps1': '# fixture',
    'runtime/resources/app/scripts/windows/auth-helper.ps1': authHelper,
    'runtime/resources/app/skills/imagegen/SKILL.md':
      '---\nname: imagegen\ndescription: isolated fixture\n---\nTest',
  })) {
    const file = path.join(packageDirectory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  await require('original-fs').promises.copyFile(
    path.join(path.dirname(process.execPath), 'resources/default_app.asar'),
    path.join(packageDirectory, 'runtime/resources/default_app.asar'),
  );
  await installer.atomic(path.join(packageDirectory, 'manifest.json'), {
    product: 'web-image-bridge',
    build: '0.1.0-setup-test',
    version: '0.1.0',
    platform: 'win32-x64',
    files: await installer.files(packageDirectory),
  });
  await mkdir(codex, { recursive: true });
  const original = '# Existing user settings\nmodel = "preserve-this-model"\n';
  await writeFile(path.join(codex, 'config.toml'), original);
  let shortcuts = 0;
  Object.assign(setup.options, {
    packageDirectory,
    codex,
    skill,
    bundled: path.join(codex, 'absent-imagegen/SKILL.md'),
    shortcut: async () => {
      shortcuts++;
    },
  });
  const input = path.join(profile, 'input');
  const output = path.join(profile, 'output');
  await mkdir(input);
  await mkdir(output);
  const checks: string[] = [];
  const pass = (name: string) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  const errors: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) errors.push(message);
  });
  const click = async (selector: string) => {
    await until(
      () =>
        ui.evaluate<boolean>(
          `!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
        ),
      Boolean,
      5000,
    );
    await ui.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`,
    );
    const point = await ui.evaluate<{ x: number; y: number }>(
      `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    );
    await ui.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await ui.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    });
  };
  window.showInactive();
  await ui.evaluate('update()');
  assert.equal(await ui.evaluate(`document.querySelector('#setup-guide').hidden`), false);
  assert.equal(
    await ui.evaluate(`document.querySelector('#mcp-summary').textContent`),
    '연결 필요',
  );
  pass('first-run-guide-does-not-confuse-server-ready-with-codex-registration');
  const originalDialog = dialog.showOpenDialog;
  let selection: string[] | null = null;
  dialog.showOpenDialog = (async () => ({
    canceled: selection === null,
    filePaths: selection ?? [],
  })) as typeof dialog.showOpenDialog;
  try {
    await click('#setup-guide [data-setup="pick-input"]');
    await until(() => ui.evaluate<boolean>('!setupPending'), Boolean, 3000);
    assert.deepEqual(setup.configuration.input_roots, []);
    selection = [input];
    await click('#setup-guide [data-setup="pick-input"]');
    await until(async () => setup.configuration.input_roots.includes(input), Boolean, 3000);
    selection = [output];
    await click('#setup-guide [data-setup="pick-output"]');
    await until(async () => setup.configuration.export_roots.includes(output), Boolean, 3000);
    assert.deepEqual(JSON.parse(await readFile(setup.options.config, 'utf8')).export_roots, [
      output,
    ]);
    assert.deepEqual(service.options.inputRoots, [input]);
    pass('native-folder-picker-cancel-select-persist-and-live-permissions');
    // A foreign imagegen skill in the target slot is shown with its path, never moved silently.
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: imagegen\n---\nforeign skill');
    const foreignSkill = await installer.files(skill);
    await click('#setup-guide [data-setup="connect"]');
    await until(async () => setup.snapshot().skill_conflict === skill, Boolean, 25000);
    await until(() => ui.evaluate<boolean>('!setupPending'), Boolean, 3000);
    await ui.evaluate('update()');
    assert.equal(
      await ui.evaluate(
        `document.querySelector('#setup-guide [data-setup="replace-skill"]').hidden`,
      ),
      false,
    );
    assert.ok(
      (
        await ui.evaluate<string>(`document.querySelector('#setup-codex-hint').textContent`)
      ).includes(skill),
    );
    assert.ok(
      (await ui.evaluate<string>(`document.querySelector('#setup-feedback').textContent`)).includes(
        '기존 스킬 백업 후 연결',
      ),
    );
    assert.deepEqual(await installer.files(skill), foreignSkill);
    await ui.evaluate(
      `document.querySelector('#setup-codex').scrollIntoView({block:'center'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    await writeFile(
      path.join(profile, 'skill-conflict.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    const originalMessageBox = dialog.showMessageBox;
    let confirmations: string[] = [];
    let answer = 1;
    dialog.showMessageBox = (async (_window: unknown, options: Electron.MessageBoxOptions) => {
      confirmations.push(options.detail ?? '');
      return { response: answer, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    try {
      await click('#setup-guide [data-setup="replace-skill"]');
      await until(async () => confirmations.length === 1, Boolean, 3000);
      await until(() => ui.evaluate<boolean>('!setupPending'), Boolean, 3000);
      assert.ok(confirmations[0]!.includes(skill));
      assert.equal(setup.registered, false);
      assert.deepEqual(await installer.files(skill), foreignSkill);
      answer = 0;
      await click('#setup-guide [data-setup="replace-skill"]');
      await until(async () => setup.registered && setup.checked, Boolean, 25000);
    } finally {
      dialog.showMessageBox = originalMessageBox;
      confirmations = [];
    }
    assert.equal(setup.snapshot().skill_conflict, null);
    pass('foreign-skill-conflict-shows-path-and-replaces-only-after-native-confirmation');
    await until(() => ui.evaluate<boolean>('!setupPending'), Boolean, 3000);
    const registered = await readFile(path.join(codex, 'config.toml'), 'utf8');
    assert.ok(registered.startsWith(original.trimEnd()));
    assert.ok(registered.includes('web_image_bridge'));
    assert.equal(shortcuts, 1);
    assert.equal(await ui.evaluate(`document.querySelector('#setup-ready').hidden`), false);
    pass('one-click-install-register-and-authenticated-eight-tool-health-check');
    const foreignSettings = '\n[agents]\nmax_depth = 2 # another app\n';
    await writeFile(
      path.join(codex, 'config.toml'),
      registered.replace(
        '# BEGIN Web Image Bridge managed integration',
        '[agents]\n# BEGIN Web Image Bridge managed integration\nmax_depth = 2 # another app',
      ),
    );
    const sharedConfig = await readFile(path.join(codex, 'config.toml'), 'utf8');
    await setup.connect();
    await setup.check();
    assert.equal(await readFile(path.join(codex, 'config.toml'), 'utf8'), sharedConfig);
    assert.equal(setup.snapshot().checked, true);
    pass('shared-config-edit-survives-reconnect-and-real-authenticated-mcp-check');
    const helperFile = path.join(setup.options.root, 'auth-helper.ps1');
    const savedHelper = await readFile(helperFile);
    try {
      await writeFile(
        helperFile,
        "ConvertTo-Json -Compress @{ Authorization = ('Bearer ' + ('x' * 43)) }\n",
      );
      await assert.rejects(setup.check(), /MCP_CHECK_FAILED/);
      assert.equal(setup.snapshot().checked, false);
      await ui.evaluate('update()');
      assert.equal(await ui.evaluate(`document.querySelector('#setup-ready').hidden`), true);
      pass('wrong-codex-credentials-fail-real-http-auth-and-clear-connected-ui');
      await writeFile(helperFile, 'exit 1\n');
      await assert.rejects(setup.check(), /CODEX_AUTH_HELPER_FAILED/);
      assert.equal(setup.snapshot().checked, false);
      pass('failed-helper-never-falls-back-to-app-credentials');
    } finally {
      await writeFile(helperFile, savedHelper);
    }
    await setup.check();
    await ui.evaluate('update()');
    const savedClipboard = await clipboard.readText();
    try {
      await click('#setup-guide [data-setup="copy-example"]');
      await until(async () => (await clipboard.readText()).includes(output), Boolean, 3000);
    } finally {
      await clipboard.writeText(savedClipboard);
    }
    // Finished setup leaves the workspace; only an update or old install comes back as a notice.
    await click('#setup-guide [data-guide="close"]');
    await until(
      () => ui.evaluate<boolean>(`document.querySelector('#setup-guide').hidden`),
      Boolean,
      3000,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).setup_guide,
      false,
    );
    assert.equal(await ui.evaluate(`document.querySelector('#setup-notice').hidden`), true);
    assert.deepEqual(
      await ui.evaluate(`(() => { refreshing = true;
        render({...latest, setup: {...latest.setup, update_available: true}});
        const notice = document.querySelector('#setup-notice');
        const result = [document.querySelector('#setup-guide').hidden, notice.hidden,
          notice.querySelector('[data-setup="connect"]').hidden,
          notice.querySelector('[data-setup="connect"]').textContent,
          document.querySelector('#integration-setting').textContent];
        refreshing = false; render(latest); return result; })()`),
      [true, false, false, '앱 업데이트', '새 버전 설치 대기 중 · 앱 업데이트를 눌러 주세요.'],
    );
    pass('closed-setup-guide-persists-and-update-shows-as-workspace-notice');
    await click('.nav-item[data-surface="settings"]');
    await click('[data-setup="remove-input"]');
    await until(async () => setup.configuration.input_roots.length === 0, Boolean, 3000);
    assert.deepEqual(service.options.inputRoots, []);
    await click('#settings-panel [data-setup="disconnect"]');
    await until(async () => !setup.registered, Boolean, 3000);
    assert.deepEqual(
      require('smol-toml').parse(await readFile(path.join(codex, 'config.toml'), 'utf8')),
      require('smol-toml').parse(original + foreignSettings),
    );
    await readFile(path.join(profile, 'm1/auth/mcp-token.enc'));
    assert.deepEqual(await installer.files(skill), foreignSkill);
    pass('revoke-folder-and-disconnect-preserve-original-settings-and-login-profile');
    assert.equal(await new Cdp(view.webContents).evaluate(`typeof window.bridge`), 'undefined');
    assert.deepEqual(errors, []);
    await ui
      .evaluate(`window.bridge.setup('unsupported').then(()=>false,()=>true)`)
      .then((value) => assert.equal(value, true));
    pass('setup-ipc-rejects-unknown-commands-and-remote-page-has-no-bridge');
    await click('#settings-panel [data-guide="open"]');
    await until(() => ui.evaluate<boolean>(`surface === 'workspace'`), Boolean, 3000);
    await until(
      () => ui.evaluate<boolean>(`!document.querySelector('#setup-guide').hidden`),
      Boolean,
      3000,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).setup_guide,
      true,
    );
    pass('settings-reopen-setup-guide-in-workspace');
    await ui.evaluate(`document.querySelector('#workspace-panel').scrollTop=0`);
    await ui.evaluate(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    await writeFile(
      path.join(profile, 'setup.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    // Public screenshots use explicitly synthetic folder paths and local fixture state.
    await ui.evaluate(`refreshing = true; clearTimeout(toastTimer);
      document.querySelector('#action-message').hidden = true;
      text('#setup-feedback', '');
      render({...latest, surface:'workspace', settings:{...latest.settings,
        input_roots:['C:/Images/references'], export_roots:['C:/Images/outputs']}});
      setSurface('workspace');`);
    await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 200 });
    await ui.evaluate(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    await writeFile(
      path.join(profile, 'readme-setup.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    window.setSize(980, 760);
    await ui.evaluate(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    assert.equal(
      await ui.evaluate(
        `document.querySelector('#workspace-panel').scrollWidth <= document.querySelector('#workspace-panel').clientWidth`,
      ),
      true,
    );
    pass('setup-guide-fits-minimum-window-width');
    await durableJson(path.join(profile, 'self-test-setup.json'), { result: 'passed', checks });
  } finally {
    dialog.showOpenDialog = originalDialog;
  }
}
