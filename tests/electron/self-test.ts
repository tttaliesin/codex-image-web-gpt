import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, copyFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow, WebContentsView, Tray } from 'electron';
import { Cdp } from '../../packages/browser/src/cdp';
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
