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
  for (const [name, value] of Object.entries({
    'runtime/WebImageBridge.exe': 'local installer fixture',
    'runtime/resources/app/package.json': '{}',
    'setup.ps1': '# fixture',
    'runtime/resources/app/scripts/windows/launch.ps1': '# fixture',
    'runtime/resources/app/scripts/windows/auth-helper.ps1': '# fixture',
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
    await click('#setup-guide [data-setup="connect"]');
    await until(async () => setup.registered && setup.checked, Boolean, 10000);
    await until(() => ui.evaluate<boolean>('!setupPending'), Boolean, 3000);
    const registered = await readFile(path.join(codex, 'config.toml'), 'utf8');
    assert.ok(registered.startsWith(original.trimEnd()));
    assert.ok(registered.includes('web_image_bridge'));
    assert.equal(shortcuts, 1);
    assert.equal(await ui.evaluate(`document.querySelector('#setup-ready').hidden`), false);
    pass('one-click-install-register-and-authenticated-eight-tool-health-check');
    const savedClipboard = await clipboard.readText();
    try {
      await click('#setup-guide [data-setup="copy-example"]');
      await until(async () => (await clipboard.readText()).includes(output), Boolean, 3000);
    } finally {
      await clipboard.writeText(savedClipboard);
    }
    await click('.nav-item[data-surface="settings"]');
    await click('[data-setup="remove-input"]');
    await until(async () => setup.configuration.input_roots.length === 0, Boolean, 3000);
    assert.deepEqual(service.options.inputRoots, []);
    await click('#settings-panel [data-setup="disconnect"]');
    await until(async () => !setup.registered, Boolean, 3000);
    assert.equal((await readFile(path.join(codex, 'config.toml'), 'utf8')).trim(), original.trim());
    await readFile(path.join(profile, 'm1/auth/mcp-token.enc'));
    pass('revoke-folder-and-disconnect-preserve-original-settings-and-login-profile');
    assert.equal(await new Cdp(view.webContents).evaluate(`typeof window.bridge`), 'undefined');
    assert.deepEqual(errors, []);
    await ui
      .evaluate(`window.bridge.setup('unsupported').then(()=>false,()=>true)`)
      .then((value) => assert.equal(value, true));
    pass('setup-ipc-rejects-unknown-commands-and-remote-page-has-no-bridge');
    await click('.nav-item[data-surface="workspace"]');
    await until(() => ui.evaluate<boolean>(`surface === 'workspace'`), Boolean, 3000);
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
