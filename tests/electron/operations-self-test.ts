import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { BrowserWindow, Tray, WebContentsView } from 'electron';
import type { BridgeService } from '../../packages/core/src/service';
import { Cdp, until } from '../../packages/browser/src/cdp';
import { durableJson } from '../../packages/storage/src/files';

export async function operationsSelfTest(
  window: BrowserWindow,
  tray: Tray,
  service: BridgeService,
  profile: string,
  view: WebContentsView,
) {
  const ui = new Cdp(window.webContents);
  ui.connect();
  const errors: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) errors.push(message);
  });
  const checks: string[] = [];
  const pass = (name: string) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  const capture = async (name: string) => {
    await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 60 });
    await ui.evaluate(
      `Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))`,
    );
    await ui.evaluate(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`,
    );
    await writeFile(path.join(profile, name), (await window.webContents.capturePage()).toPNG());
  };
  // Public README screenshots show a registered Codex connection; the fixture never registers one.
  // Each is captured in Korean and English; only the page switches, the saved choice stays.
  const readmeCapture = async (name: string, language = 'ko') => {
    await until(
      () =>
        ui.evaluate<boolean>(`!refreshing && (refreshing = true, render({...latest,
          language: '${language}', setup_guide: false,
          setup: latest.setup && {...latest.setup, registered: true, checked: true}}), true)`),
      Boolean,
      3000,
    );
    await capture(name);
    await ui.evaluate(`refreshing = false; update()`);
  };
  await until(
    () => ui.evaluate<boolean>(`!document.querySelector('#operations').hidden`),
    Boolean,
    3000,
  );
  window.showInactive();
  assert.equal(await ui.evaluate(`document.querySelector('#empty-history').hidden`), false);
  assert.equal(
    await ui.evaluate(`document.querySelector('#session-summary').textContent`),
    '로그인됨',
  );
  assert.equal(view.getVisible(), false);
  pass('dashboard-empty-state-observed-auth-and-native-view-hidden');
  const navigate = async (surface: string) => {
    const point = await ui.evaluate<{ x: number; y: number }>(
      `(() => { const r=document.querySelector('.nav-item[data-surface="${surface}"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
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
    await until(
      () => ui.evaluate<boolean>(`!document.querySelector('#${surface}-panel').hidden`),
      Boolean,
      3000,
    );
  };
  await navigate('settings');
  assert.equal(view.getVisible(), false);
  assert.equal(await ui.evaluate(`document.querySelector('#legacy-controls').hidden`), true);
  await capture('settings.png');
  await navigate('browser');
  await until(async () => view.getVisible(), Boolean, 3000);
  const pageId = view.webContents.id;
  const checkViewport = async () => {
    await until(
      async () => ({
        actual: view.getBounds(),
        expected: await ui.evaluate<any>(
          `(() => {const r=document.querySelector('#browser-viewport').getBoundingClientRect();return {x:Math.round(r.x+1),y:Math.round(r.y+1),width:Math.round(r.width-2),height:Math.round(r.height-2)};})()`,
        ),
      }),
      (pair) =>
        (['x', 'y', 'width', 'height'] as const).every(
          (key) => pair.actual[key] === pair.expected[key],
        ),
      3000,
    );
    assert.equal(view.webContents.id, pageId);
  };
  await checkViewport();
  assert.equal(
    await ui.evaluate(`window.bridge.surface('invalid').then(()=>false,()=>true)`),
    true,
  );
  assert.equal(
    await ui.evaluate(
      `window.bridge.viewport({x:0,y:0,width:99999,height:1}).then(()=>false,()=>true)`,
    ),
    true,
  );
  await checkViewport();
  pass('dashboard-navigation-real-pointer-native-bounds-and-ipc-validation');
  for (const [width, height] of [
    [980, 680],
    [1360, 900],
  ]) {
    window.setSize(width!, height!);
    await checkViewport();
    await navigate('workspace');
    assert.equal(view.getVisible(), false);
    assert.equal(
      await ui.evaluate(
        `document.querySelector('#workspace-panel').scrollWidth <= document.querySelector('#workspace-panel').clientWidth`,
      ),
      true,
    );
    assert.equal(
      await ui.evaluate(
        `document.querySelectorAll('button').values().some(b=>{if(!b.getClientRects().length)return false;const r=b.getBoundingClientRect();return r.left<0||r.right>innerWidth;})`,
      ),
      false,
    );
    // Step labels stay on one line beside their number circle.
    assert.equal(
      await ui.evaluate(
        `[...document.querySelectorAll('.progress-track li > span:last-child')].every(s=>{const r=s.getBoundingClientRect();return r.height<20&&r.width>22;})`,
      ),
      true,
    );
    await capture(`workspace-${width}.png`);
    await navigate('browser');
  }
  pass('dashboard-980-and-1360-width-no-overflow-same-page');
  window.hide();
  assert.equal(view.getVisible(), true);
  window.showInactive();
  await navigate('workspace');
  pass('dashboard-hidden-window-keeps-web-page-rendered');
  await readmeCapture('readme-workspace.png');
  await readmeCapture('readme-workspace-en.png', 'en');
  await ui.click('[data-action="pause-queue"]');
  await until(async () => service.engine.paused, Boolean, 3000);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await service.call('web_image_submit', {
          request_id: randomUUID(),
          mode: 'generate',
          prompt: 'M3 management fixture',
        })
      ).ok,
      true,
    );
  await until(
    () => ui.evaluate<string>(`document.querySelector('#queue').textContent`),
    (s) => s.includes('대기 2건'),
    3000,
  );
  assert.equal(
    await ui.evaluate(`document.querySelector('[data-action="pause-queue"]').disabled`),
    true,
  );
  assert.equal(
    await ui.evaluate(`document.querySelector('[data-action="resume-queue"]').disabled`),
    false,
  );
  assert.equal(
    service.engine.jobs().every((j) => j.snapshot.state === 'queued'),
    true,
  );
  assert.equal(
    await ui.evaluate(`document.querySelector('#current-title').textContent`),
    '새 작업 시작을 일시정지했어요',
  );
  assert.equal(
    await ui.evaluate(`document.querySelectorAll('.progress-track [aria-current="step"]').length`),
    0,
  );
  assert.equal(await ui.evaluate(`document.querySelectorAll('.job-row').length`), 2);
  await capture('queue.png');
  await readmeCapture('readme-queue.png');
  await readmeCapture('readme-queue-en.png', 'en');
  pass('dashboard-history-reflects-real-persisted-jobs');
  await ui.click('[data-action="takeover"]');
  await until(
    () => ui.evaluate<string>(`document.querySelector('#queue').textContent`),
    (s) => s.includes('직접 조작 중'),
    3000,
  );
  assert.equal(
    await ui.evaluate(`document.querySelector('[data-action="release"]').disabled`),
    false,
  );
  assert.equal(await ui.evaluate(`document.querySelector('#browser-panel').hidden`), false);
  await capture('operations.png');
  await ui.click('[data-action="release"]');
  await until(
    () => ui.evaluate<string>(`document.querySelector('#queue').textContent`),
    (s) => s.includes('자동화 조작권'),
    3000,
  );
  assert.equal(tray.isDestroyed(), false);
  // Exercise attention and busy rendering without sending any remote request.
  await ui.evaluate(
    `render({...latest,busy:true,phase:'generate',operations:{...latest.operations,paused:false,job:{...latest.operations.job,state:'running',phase:'generate',terminal:false}}})`,
  );
  assert.equal(
    await ui.evaluate(`document.querySelector('#current-title').textContent`),
    '이미지 생성 중',
  );
  await ui.evaluate(
    `render({...latest,busy:false,phase:'SUBMISSION_UNKNOWN',operations:{...latest.operations,job:{...latest.operations.job,state:'waiting_user',requires_action:true,submission_state:'unknown',error:{code:'SUBMISSION_UNKNOWN'}}}})`,
  );
  assert.equal(
    await ui.evaluate(`document.querySelector('[data-action="resume-job"]').disabled`),
    true,
  );
  assert.equal(
    await ui.evaluate(`document.querySelector('[data-action="reconcile"]').disabled`),
    false,
  );
  await ui.evaluate(`update()`);
  assert.deepEqual(errors, []);
  pass('dashboard-busy-attention-recovery-controls-no-renderer-errors');
  const crash = async () => {
    const gone = new Promise((resolve) => view.webContents.once('render-process-gone', resolve));
    view.webContents.forcefullyCrashRenderer();
    await gone;
  };
  const recovered = async () => {
    await until(
      async () =>
        !view.webContents.isCrashed() &&
        view.webContents.debugger.isAttached() &&
        service.engine.suspended === null,
      Boolean,
      15000,
    );
    const reply = await view.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: '1 + 1',
      returnByValue: true,
    });
    assert.equal(reply.result.value, 2);
  };
  await crash();
  await recovered();
  pass('renderer-crash-reloads-page-reattaches-debugger-and-resumes');
  await crash();
  await until(
    async () => service.engine.suspended,
    (reason) => reason === 'ADAPTER_UNAVAILABLE',
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(view.webContents.isCrashed(), true);
  await ui.evaluate(`window.bridge.action('reconnect')`);
  await recovered();
  pass('repeated-renderer-crash-waits-for-manual-reconnect-which-reloads');
  // Visible Hangul outside the language choices themselves means an untranslated string.
  const hangulOutsideLanguageChoice = () =>
    ui.evaluate<string[]>(`(() => {
      const found = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const element = node.parentElement;
        if (!element || element.closest('[hidden], [data-language], .language-choice-label')) continue;
        if (!element.getClientRects().length) continue;
        const value = node.textContent.trim();
        if (/[\\uAC00-\\uD7A3]/.test(value) && value !== 'Language · 언어') found.push(value);
      }
      return found;
    })()`);
  const preferences = path.join(profile, 'preferences.json');
  await ui.evaluate(`window.bridge.language('en').then(() => update())`);
  await until(
    () => ui.evaluate<string>(`document.documentElement.lang`),
    (value) => value === 'en',
    3000,
  );
  assert.deepEqual(JSON.parse(await readFile(preferences, 'utf8')), { language: 'en' });
  for (const panel of ['workspace', 'settings']) {
    await navigate(panel);
    await ui.evaluate('update()');
    assert.deepEqual(await hangulOutsideLanguageChoice(), [], `${panel} has untranslated text`);
  }
  assert.equal(
    await ui.evaluate(`document.querySelector('#settings-heading').textContent`),
    'Settings',
  );
  assert.equal(
    await ui.evaluate(
      `document.querySelector('[data-language="en"]').getAttribute('aria-pressed')`,
    ),
    'true',
  );
  await capture('settings-en.png');
  await ui.evaluate(`window.bridge.language('ko').then(() => update())`);
  await navigate('workspace');
  assert.equal(
    await ui.evaluate(`document.querySelector('#workspace-heading').textContent`),
    '작업 공간',
  );
  assert.deepEqual(JSON.parse(await readFile(preferences, 'utf8')), { language: 'ko' });
  assert.equal(
    await ui.evaluate(`window.bridge.language('fr').then(() => false, () => true)`),
    true,
  );
  assert.deepEqual(errors, []);
  pass('language-switch-translates-every-visible-string-and-persists-choice');
  await durableJson(path.join(profile, 'self-test-operations.json'), {
    result: 'passed',
    checks: [
      'm3-management-ipc-pause-and-queue-count',
      'm3-management-manual-takeover-release',
      'm3-management-button-state-and-tray-lifetime',
      ...checks,
    ],
    screenshot: 'workspace-1360.png',
  });
  console.log('PASS m3-management-ipc-pause-queue-manual-controls-and-render');
}
