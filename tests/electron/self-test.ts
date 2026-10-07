import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, copyFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow, WebContentsView, Tray } from 'electron';
import { Cdp } from '../../packages/browser/src/cdp';
import {
  PageAdapter,
  fixtureSelectors,
  chatgptSelectors,
} from '../../packages/browser/src/adapter';
import { ProbeRunner, type ProbeRequest, type ProbeRecord } from '../../apps/desktop/src/probe';
import { durableJson, readJson } from '../../packages/storage/src/files';
import type { fixtureServer } from '../fixtures/server';
import { m1SelfTest } from './m1-self-test';
import { m2SelfTest } from './m2-self-test';
import { m3SelfTest } from './m3-self-test';

export async function selfTest(context: {
  window: BrowserWindow;
  view: WebContentsView;
  tray: Tray;
  runner: ProbeRunner;
  cdp: Cdp;
  fixture: Awaited<ReturnType<typeof fixtureServer>>;
  profile: string;
  stage: string;
}) {
  const { window, view, tray, runner, cdp, fixture, profile, stage } = context;
  const checks: string[] = [];
  const pass = (name: string) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  const cookies = view.webContents.session.cookies;
  if (stage === 'restart') {
    const saved = await cookies.get({ url: fixture.origin, name: 'fixture-persistent' });
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.value, 'retained');
    pass('persistent-cookie-after-process-restart');
    const first = await readJson<ProbeRecord>(path.join(profile, 'probes/first/probe.json'));
    const result = await runner.run(first.request, () => window.hide());
    assert.equal(result.artifact!.sha256, first.artifact!.sha256);
    assert.equal(await cdp.evaluate("document.body.dataset.sends || '0'"), '0');
    pass('completed-probe-replay-without-send-after-restart');
  } else {
    assert.equal(tray.isDestroyed(), false);
    pass('tray-created');
    const id = view.webContents.id;
    window.show();
    window.close();
    assert.equal(window.isVisible(), false);
    assert.equal(view.webContents.id, id);
    assert.equal(view.webContents.isDestroyed(), false);
    window.show();
    assert.equal(window.isVisible(), true);
    window.hide();
    pass('close-hide-reopen-same-webcontents');
    assert.ok(view.getBounds().width > 0 && view.getBounds().height > 0);
    assert.equal(await cdp.evaluate('typeof window.require'), 'undefined');
    assert.equal(await cdp.evaluate('typeof window.bridge'), 'undefined');
    pass('remote-page-node-and-ipc-isolation');
    cdp.contents.debugger.detach();
    await assert.rejects(cdp.evaluate('1'), /ADAPTER_UNAVAILABLE/);
    cdp.connect();
    assert.equal(await cdp.evaluate('1+1'), 2);
    pass('cdp-detach-reconnect-hidden');
    const rich = new PageAdapter(
      cdp,
      { ...fixtureSelectors, composer: '#rich-editor', send: '#rich-send' },
      fixture.origin,
    );
    await cdp.evaluate(`(() => {
      const e = document.createElement('div'); e.id = 'rich-editor';
      e.contentEditable = 'true'; e.innerHTML = '<p><br></p>'; document.body.append(e);
    })()`);
    assert.equal((await rich.snapshot()).prompt, '');
    await cdp.evaluate(
      `document.querySelector('#rich-editor').innerHTML = '<p>첫 줄  공백</p><p><br></p><p>다음<br>줄</p>'`,
    );
    assert.equal((await rich.snapshot()).prompt, '첫 줄  공백\n\n다음\n줄');
    await cdp.evaluate(`(() => {
      const button = document.createElement('button'); button.id = 'rich-send';
      button.type = 'button'; button.onclick = () => { button.dataset.clicked = 'true'; };
      document.body.append(button);
    })()`);
    await rich.clickSend(await rich.snapshot());
    assert.equal(
      await cdp.evaluate(`document.querySelector('#rich-send').dataset.clicked`),
      'true',
    );
    await cdp.evaluate(`document.querySelector('#rich-send').remove()`);
    await cdp.evaluate(`document.querySelector('#rich-editor').textContent = '일반 텍스트'`);
    assert.equal((await rich.snapshot()).prompt, '일반 텍스트');
    await cdp.evaluate(`document.querySelector('#rich-editor').remove()`);
    pass('rich-editor-empty-and-multiline-prompt-preserved');
    const modern = new PageAdapter(cdp, chatgptSelectors, fixture.origin);
    await cdp.evaluate(`(() => {
      const root = document.createElement('div'); root.id = 'modern-fixture';
      root.innerHTML = '<div id="prompt-textarea" contenteditable="true"><p><br></p></div>' +
        '<div class="group/user-message" data-chatgpt-search-message-ids="11111111-1111-4111-8111-111111111111" data-chatgpt-search-unit-key="fallback-turn-0:0:user"><div class="whitespace-pre-wrap">exact prompt</div><img alt="사용자 첨부 파일" src="/output.png?output=1"></div>' +
        '<div data-chatgpt-search-message-ids="22222222-2222-4222-8222-222222222222"><div data-testid="generated-image-gallery"><button data-testid="generated-image-preview"><img alt="생성된 이미지 1" src="/output.png?output=1"></button><button aria-label="생성된 이미지 1 편집"></button><button aria-label="생성된 이미지 1 공유"></button></div></div>';
      document.body.append(root);
      const stale = root.cloneNode(true); stale.id = 'stale-modern-fixture';
      stale.style.display = 'none'; document.body.append(stale);
      root.querySelector('[data-testid="generated-image-preview"]').onclick = () => {
        const viewer = document.createElement('div'); viewer.id = 'modern-viewer';
        viewer.innerHTML = '<header><button aria-label="다운로드"></button><button aria-label="뷰어 닫기"></button></header><div><img class="ZoomableImage-fixture" alt="fixture" src="/output.png?output=1"></div>';
        document.body.append(viewer);
        viewer.querySelector('[aria-label="뷰어 닫기"]').onclick = () => viewer.remove();
        viewer.querySelector('[aria-label="다운로드"]').onclick = async () => {
          const bytes = await (await fetch('/output.png?output=1')).blob();
          const url = URL.createObjectURL(bytes); const link = document.createElement('a');
          link.href = url; link.download = 'fixture.png'; link.click(); URL.revokeObjectURL(url);
        };
      };
    })()`);
    let modernSnapshot;
    for (let i = 0; i < 100; i++) {
      modernSnapshot = await modern.snapshot();
      if (modernSnapshot.messages.at(-1)?.outputReady) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(
      modernSnapshot!.messages.map((m) => [m.id, m.role]),
      [
        ['11111111-1111-4111-8111-111111111111', 'user'],
        ['22222222-2222-4222-8222-222222222222', 'assistant'],
      ],
    );
    assert.equal(modernSnapshot!.composer, 1);
    assert.equal(modernSnapshot!.messages[0]!.attachmentNamesHidden, true);
    assert.equal(modernSnapshot!.messages[1]!.outputReady, true);
    assert.equal(modernSnapshot!.messages[1]!.outputCount, 1);
    await cdp.evaluate(`(() => {
      const failure=document.createElement('div'); failure.id='modern-failure';
      failure.setAttribute('data-chatgpt-search-message-ids','33333333-3333-4333-8333-333333333333');
      failure.innerHTML='<span><svg></svg>이미지 생성에 실패했습니다</span>'; document.body.append(failure);
    })()`);
    assert.equal((await modern.snapshot()).serviceError, 'GENERATION_REJECTED');
    await cdp.evaluate(`document.querySelector('#modern-failure').style.display='none'`);
    assert.equal((await modern.snapshot()).serviceError, undefined);
    await cdp.evaluate(`(() => {
      const failure = document.querySelector('#modern-failure');
      failure.style.display = '';
      document.body.insertBefore(failure, document.querySelector('#modern-fixture'));
    })()`);
    assert.equal((await modern.snapshot()).serviceError, undefined);
    assert.equal(
      (await modern.generation(modernSnapshot!.messages[0]!.id, modernSnapshot!.url, 1000)).id,
      modernSnapshot!.messages[1]!.id,
    );
    await cdp.evaluate(`document.querySelector('#modern-failure').remove()`);
    await cdp.evaluate(`(() => {
      const frame=document.createElement('div'); frame.id='modern-refusal';
      frame.innerHTML='<div class="group/user-message" data-chatgpt-search-message-ids="55555555-5555-4555-8555-555555555555"><span>fixture user</span></div><div><div><div data-chatgpt-search-message-ids="44444444-4444-4444-8444-444444444444 44444444-4444-4444-8444-444444444444"><span>해당 프롬프트가 나체, 성적 또는 성애적 콘텐츠와 관련된 방지 조치를 위반할 수 있습니다.</span></div></div></div><button aria-label="복사"></button>';
      document.body.append(frame);
    })()`);
    const refused = await modern.snapshot();
    assert.equal(refused.serviceError, 'GENERATION_REJECTED');
    assert.equal(refused.messages.at(-1)!.id, '44444444-4444-4444-8444-444444444444');
    assert.equal(refused.messages.at(-1)!.role, 'assistant');
    assert.equal(refused.messages.at(-1)!.completed, true);
    await cdp.evaluate(
      `document.body.insertBefore(document.querySelector('#modern-refusal'), document.querySelector('#modern-fixture'))`,
    );
    assert.equal((await modern.snapshot()).serviceError, undefined);
    assert.equal(
      (await modern.generation(modernSnapshot!.messages[0]!.id, modernSnapshot!.url, 1000)).id,
      modernSnapshot!.messages[1]!.id,
    );
    await cdp.evaluate(`document.querySelector('#modern-refusal').remove()`);
    pass('historical-failure-and-refusal-do-not-block-current-generation');
    const modernId = modernSnapshot!.messages[1]!.id;
    const modernTarget = await modern.downloadTarget(modernId);
    const modernArtifact = await runner.downloads.collect(
      path.join(profile, 'modern-viewer-download'),
      modernId,
      modernTarget,
      () => modern.download(modernId, modernTarget, modernSnapshot!.url),
    );
    assert.equal(
      modernArtifact.sha256,
      createHash('sha256')
        .update(await readFile(fixture.images[2]!))
        .digest('hex'),
    );
    await modern.dismissViewer(modernId);
    await cdp.evaluate(`document.querySelector('#modern-fixture').remove()`);
    await cdp.evaluate(`document.querySelector('#stale-modern-fixture').remove()`);
    pass('modern-message-identity-gallery-and-fullscreen-original-download');
    await cookies.set({
      url: fixture.origin,
      name: 'fixture-persistent',
      value: 'retained',
      expirationDate: Date.now() / 1000 + 86400,
      sameSite: 'lax',
    });
    await cookies.flushStore();
    const request: ProbeRequest = {
      id: 'first',
      prompt: '두 이미지 결합\r\n"Image 1" + Image 2 🐈\n  공백 유지',
      inputs: [
        { path: fixture.images[0]!, role: 'reference' },
        { path: fixture.images[1]!, role: 'supporting' },
      ],
    };
    const first = await runner.run(request, () => window.hide());
    assert.equal(first.submission, 'confirmed');
    assert.equal(first.phase, 'complete');
    assert.equal(first.prompt_sha256, createHash('sha256').update(request.prompt).digest('hex'));
    assert.equal(window.isVisible(), false);
    assert.equal(view.webContents.id, id);
    assert.deepEqual((await runner.adapter.snapshot()).messages[0]!.attachments, first.names);
    const expected = createHash('sha256')
      .update(await readFile(fixture.images[2]!))
      .digest('hex');
    assert.equal(first.artifact!.sha256, expected);
    assert.equal(first.artifact!.width, 48);
    assert.equal(first.artifact!.height, 32);
    pass('hidden-two-attachments-unicode-prompt-and-real-download-checksum');
    const replay = await runner.run(request, () => window.hide());
    assert.equal(replay.artifact!.id, first.artifact!.id);
    assert.equal(await cdp.evaluate('document.body.dataset.sends'), '1');
    pass('same-probe-no-second-send');
    await assert.rejects(
      runner.run({ ...request, prompt: 'different' }, () => window.hide()),
      /IDEMPOTENCY_CONFLICT/,
    );
    assert.equal(
      (await readJson<ProbeRecord>(path.join(profile, 'probes/first/probe.json'))).phase,
      'complete',
    );
    pass('different-payload-does-not-mutate-existing-record');
    const followup: ProbeRequest = {
      id: 'followup',
      parent_id: 'first',
      prompt: '이 결과를 그대로 참고해 후속 편집',
      inputs: [
        { path: first.artifact!.path, role: 'edit_target' },
        { path: fixture.images[1]!, role: 'reference' },
      ],
    };
    const second = await runner.run(followup, () => window.hide());
    assert.equal(second.conversation_url, first.conversation_url);
    const followupExpected = createHash('sha256')
      .update(await readFile(fixture.images[3]!))
      .digest('hex');
    assert.equal(second.artifact!.sha256, followupExpected);
    assert.notEqual(second.artifact!.sha256, first.artifact!.sha256);
    assert.equal(await cdp.evaluate('document.body.dataset.sends'), '2');
    pass('same-conversation-parent-artifact-followup');
    const target = await runner.adapter.downloadTarget('assistant-2');
    const isolated = await runner.downloads.collect(
      path.join(profile, 'download-attribution'),
      'assistant-2',
      target,
      async () => {
        await cdp.evaluate(
          `(() => { const a = document.createElement('a'); a.href = '/download?output=1'; a.download='old.png'; a.click(); })()`,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await runner.adapter.download('assistant-2', target, second.conversation_url!);
      },
    );
    assert.equal(isolated.sha256, followupExpected);
    pass('unrelated-same-origin-download-rejected');
    await view.webContents.loadURL(fixture.origin);
    const originalAttach = runner.adapter.attach.bind(runner.adapter);
    runner.adapter.attach = async (paths) => {
      await cdp.files(runner.adapter.selectors.file, [paths[0]!]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw Error('INJECTED_DURING_ATTACHMENT');
    };
    const preSubmit = { ...request, id: 'partial-attach' };
    await assert.rejects(
      runner.run(preSubmit, () => window.hide()),
      /INJECTED_DURING_ATTACHMENT/,
    );
    const prepared = await readJson<ProbeRecord>(
      path.join(profile, 'probes/partial-attach/probe.json'),
    );
    assert.equal(prepared.submission, 'not_sent');
    runner.adapter.attach = originalAttach;
    const resumed = await runner.run(preSubmit, () => window.hide());
    assert.equal(resumed.phase, 'complete');
    assert.equal(await cdp.evaluate('document.body.dataset.sends'), '1');
    assert.equal((await runner.adapter.snapshot()).messages[0]!.attachments.length, 2);
    pass('pre-submit-resume-keeps-inputs-and-skips-existing-attachment');
    await view.webContents.loadURL(fixture.origin + '/?viewer=1');
    const viewed = await runner.run({ ...request, id: 'viewer-download' }, () => window.hide());
    assert.equal(viewed.artifact!.sha256, expected);
    assert.equal(await cdp.evaluate('document.body.dataset.saves'), '1');
    assert.equal(
      await cdp.evaluate(
        'window.__webImageBridgeCapture === undefined && HTMLAnchorElement.prototype.click === window.fixtureOriginalAnchorClick && URL.revokeObjectURL === window.fixtureOriginalRevoke',
      ),
      true,
    );
    pass('viewer-save-blob-original-download-and-hook-cleanup');
    await view.webContents.loadURL(fixture.origin + '/c/fixture');
    await assert.rejects(
      runner.run({ ...request, id: 'existing-route-no-history' }, () => window.hide()),
      /NEW_CONVERSATION_REQUIRED/,
    );
    await view.webContents.loadURL(fixture.origin);
    const originalFill = runner.adapter.fill.bind(runner.adapter);
    runner.adapter.fill = async (prompt, names) => {
      await originalFill(prompt, names);
      await cdp.evaluate("history.replaceState(null,'','/c/fixture')");
      return runner.adapter.snapshot();
    };
    await assert.rejects(
      runner.run({ ...request, id: 'late-conversation' }, () => window.hide()),
      /NEW_CONVERSATION_REQUIRED/,
    );
    assert.equal(
      await stat(path.join(profile, 'probes/late-conversation/sending.marker')).then(
        () => true,
        () => false,
      ),
      false,
    );
    runner.adapter.fill = originalFill;
    pass('existing-and-late-hydrated-conversation-cannot-receive-new-request');
    await view.webContents.loadURL(fixture.origin);
    const firstSource = path.join(profile, 'fixture-files/staging-first.png');
    const missingSource = path.join(profile, 'fixture-files/staging-missing.png');
    await copyFile(fixture.images[0]!, firstSource);
    const interruptedStage: ProbeRequest = {
      ...request,
      id: 'interrupted-stage',
      inputs: [
        { path: firstSource, role: 'reference' },
        { path: missingSource, role: 'supporting' },
      ],
    };
    await assert.rejects(runner.run(interruptedStage, () => window.hide()));
    await writeFile(firstSource, 'source changed after the first input was staged');
    await copyFile(fixture.images[1]!, missingSource);
    const fixedStage = await runner.run(interruptedStage, () => window.hide());
    assert.equal(fixedStage.phase, 'complete');
    assert.equal(fixedStage.names[0], first.names[0]);
    assert.equal(await cdp.evaluate('document.body.dataset.sends'), '1');
    pass('incomplete-staging-recovers-with-original-first-input');
    await view.webContents.loadURL(fixture.origin);
    const originalSend = runner.adapter.clickSend.bind(runner.adapter);
    runner.adapter.clickSend = async (baseline) => {
      await originalSend(baseline);
      throw Error('INJECTED_DISCONNECT');
    };
    const interrupted = { ...request, id: 'uncertain' };
    await assert.rejects(
      runner.run(interrupted, () => window.hide()),
      /INJECTED_DISCONNECT/,
    );
    const uncertain = await readJson<ProbeRecord>(
      path.join(profile, 'probes/uncertain/probe.json'),
    );
    assert.equal(uncertain.submission, 'unknown');
    const recovered = await runner.run(interrupted, () => window.hide());
    assert.equal(recovered.phase, 'complete');
    assert.equal(await cdp.evaluate('document.body.dataset.sends'), '1');
    pass('post-send-disconnect-reconciles-without-resend');
    runner.adapter.clickSend = async () => {
      throw Error('INJECTED_BEFORE_CLICK');
    };
    await view.webContents.loadURL(fixture.origin);
    const noClick = { ...request, id: 'before-click' };
    await assert.rejects(
      runner.run(noClick, () => window.hide()),
      /INJECTED_BEFORE_CLICK/,
    );
    await assert.rejects(
      runner.run(noClick, () => window.hide()),
      /SUBMISSION_UNKNOWN/,
    );
    await assert.rejects(
      runner.run({ ...request, id: 'new-id-while-unknown' }, () => window.hide()),
      /UNRESOLVED_PROBE/,
    );
    assert.equal(await cdp.evaluate("document.body.dataset.sends || '0'"), '0');
    pass('marker-before-click-stays-unknown-no-retry');
    runner.adapter.clickSend = originalSend;
  }
  await m1SelfTest(profile, stage, fixture.images, pass);
  await m2SelfTest({
    profile,
    stage,
    cdp,
    window,
    view,
    downloads: runner.downloads,
    fixture,
    pass,
  });
  if (stage === 'first')
    await m3SelfTest({ profile, cdp, window, view, downloads: runner.downloads, fixture, pass });
  await durableJson(path.join(profile, `self-test-${stage}.json`), {
    result: 'passed',
    stage,
    at: new Date().toISOString(),
    versions: process.versions,
    checks,
  });
}
