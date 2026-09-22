import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { powerMonitor, type BrowserWindow, type WebContentsView } from 'electron';
import { PageAdapter, fixtureSelectors } from '../../packages/browser/src/adapter';
import { BrowserExecution } from '../../packages/browser/src/execution';
import { Cdp, until } from '../../packages/browser/src/cdp';
import type { DownloadCollector } from '../../packages/browser/src/download';
import { BridgeService } from '../../packages/core/src/service';
import { Operations } from '../../apps/desktop/src/operations';
import { bindPower } from '../../apps/desktop/src/power';
import { executionVisibility } from '../../apps/desktop/src/execution-view';
import type { fixtureServer } from '../fixtures/server';

export async function m3SelfTest(context: {
  profile: string;
  cdp: Cdp;
  window: BrowserWindow;
  view: WebContentsView;
  downloads: DownloadCollector;
  fixture: Awaited<ReturnType<typeof fixtureServer>>;
  pass(name: string): void;
}) {
  const { profile, cdp, window, view, downloads, fixture, pass } = context;
  const create = async (name: string) => {
    const directory = path.join(profile, `m3-${name}`),
      adapter = new PageAdapter(cdp, fixtureSelectors, fixture.origin);
    const port = new BrowserExecution(adapter, downloads, {
      directory,
      fixtureEntry: `${fixture.origin}/?engine=1`,
      busy: executionVisibility(window, view),
      attention: () => {},
      hidden: () => !window.isVisible(),
      generationTimeout: 5000,
    });
    let manual = false;
    const service = new BridgeService({
      directory,
      inputRoots: [path.dirname(fixture.images[0]!)],
      exportRoots: [profile],
      port,
      view: {
        setVisible() {},
        setManual(value) {
          assert.equal(port.busy, false);
          manual = value;
        },
      },
    });
    await service.ready;
    const operations = new Operations(service, () => {});
    return { service, adapter, port, operations, manual: () => manual };
  };
  const call = async (service: BridgeService, name: string, input: unknown): Promise<any> => {
    const result = await service.call(`web_image_${name}`, input);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const submit = () => ({
    request_id: randomUUID(),
    mode: 'generate',
    prompt: 'M3 fixture only',
    inputs: fixture.images.slice(0, 2).map((file) => ({ path: file, role: 'reference' })),
  });
  {
    const { service, operations, manual } = await create('manual');
    const sends = fixture.metrics.sends;
    try {
      const job = (await call(service, 'submit', submit())).job;
      await until(
        async () => service.engine.job(job.job_id).snapshot,
        (j) => j.phase === 'attach',
        3000,
      );
      await operations.command('takeover');
      assert.equal(manual(), true);
      assert.equal(service.engine.job(job.job_id).snapshot.submission_state, 'not_sent');
      await cdp.evaluate(`document.querySelector('#prompt').value='manual draft not approved'`);
      await operations.command('release');
      await service.engine.idle();
      assert.equal(service.engine.job(job.job_id).snapshot.state, 'waiting_user');
      assert.equal(fixture.metrics.sends, sends);
      await operations.command('takeover');
      await cdp.evaluate(`document.querySelector('#prompt').value=''`);
      await operations.command('release');
      await service.engine.idle();
      assert.equal(service.engine.job(job.job_id).snapshot.state, 'succeeded');
      assert.equal(fixture.metrics.sends, sends + 1);
      pass('m3-manual-draft-change-blocks-send-and-release-revalidates');
    } finally {
      await service.close();
    }
  }
  for (const mode of ['debugger', 'network', 'power']) {
    const { service, operations } = await create(mode);
    const sends = fixture.metrics.sends;
    const detach = () => {
      void operations.suspend('ADAPTER_UNAVAILABLE');
    };
    const unbind = bindPower(powerMonitor, operations);
    if (mode === 'debugger') cdp.contents.debugger.on('detach', detach);
    try {
      const job = (await call(service, 'submit', submit())).job;
      await until(
        async () => service.engine.job(job.job_id).snapshot,
        (j) => j.submission_state === 'confirmed',
        4000,
      );
      if (mode === 'debugger') {
        cdp.contents.debugger.detach();
        await until(
          async () => service.engine.job(job.job_id).snapshot,
          (j) => j.state === 'waiting_user',
          3000,
        );
        cdp.connect();
        await operations.resume('ADAPTER_UNAVAILABLE');
      } else if (mode === 'network') {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
          offline: true,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
        await operations.suspend('NETWORK_OFFLINE');
        assert.equal(await cdp.evaluate('navigator.onLine'), false);
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
        await operations.resume('NETWORK_OFFLINE');
      } else {
        powerMonitor.emit('suspend');
        await service.engine.idle();
        assert.equal(service.engine.suspended, 'OS_SUSPENDED');
        powerMonitor.emit('resume');
        await until(
          async () => service.engine.suspended,
          (s) => s === null,
          3000,
        );
      }
      await service.engine.idle();
      const result = service.engine.job(job.job_id).snapshot;
      assert.equal(result.state, 'succeeded', JSON.stringify(result));
      assert.equal(fixture.metrics.sends, sends + 1);
      pass(`m3-${mode}-recovery-without-new-submit`);
    } finally {
      unbind();
      cdp.contents.debugger.removeListener('detach', detach);
      await service.close();
    }
  }
  {
    const { service, operations } = await create('cancel');
    const sends = fixture.metrics.sends;
    try {
      const job = (await call(service, 'submit', submit())).job;
      await until(
        async () => service.engine.job(job.job_id).snapshot,
        (j) => j.submission_state === 'confirmed',
        4000,
      );
      await operations.command('cancel');
      await service.engine.idle();
      assert.equal(service.engine.job(job.job_id).snapshot.state, 'canceled');
      await until(
        () => new PageAdapter(cdp, fixtureSelectors, fixture.origin).snapshot(),
        (s) => !s.busy && s.messages.some((m) => m.downloads > 0),
        4000,
      );
      await operations.command('reconcile');
      await service.engine.idle();
      assert.equal(service.engine.job(job.job_id).snapshot.remote_may_continue, false);
      assert.equal(fixture.metrics.sends, sends + 1);
      assert.equal(service.engine.job(job.job_id).snapshot.artifact_ids.length, 0);
      pass('m3-canceled-remote-completion-observation-clears-profile-lock');
    } finally {
      await service.close();
    }
  }
}
