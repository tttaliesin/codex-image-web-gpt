import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BrowserWindow, WebContentsView } from 'electron';
import { executionVisibility } from '../../apps/desktop/src/execution-view';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BrowserExecution } from '../../packages/browser/src/execution';
import { PageAdapter, fixtureSelectors } from '../../packages/browser/src/adapter';
import { Cdp, until } from '../../packages/browser/src/cdp';
import type { DownloadCollector } from '../../packages/browser/src/download';
import { BridgeService } from '../../packages/core/src/service';
import { startMcp } from '../../packages/mcp/src/server';
import { durableJson, readJson } from '../../packages/storage/src/files';
import type { fixtureServer } from '../fixtures/server';

export async function m2SelfTest(context: {
  profile: string;
  stage: string;
  cdp: Cdp;
  window: BrowserWindow;
  view: WebContentsView;
  downloads: DownloadCollector;
  fixture: Awaited<ReturnType<typeof fixtureServer>>;
  pass(name: string): void;
}) {
  const { profile, stage, cdp, window, downloads, fixture, pass } = context;
  const create = async (name: string, behavior = '') => {
    const directory = path.join(profile, `m2-${name}`);
    const adapter = new PageAdapter(cdp, fixtureSelectors, fixture.origin);
    const port = new BrowserExecution(adapter, downloads, {
      directory,
      fixtureEntry: `${fixture.origin}/?engine=1&case=${behavior}`,
      busy: executionVisibility(window, context.view),
      attention: () => {},
      hidden: () => !window.isVisible(),
      generationTimeout: 5000,
      readyTimeout: 5000,
    });
    const service = new BridgeService({
      directory,
      inputRoots: [path.dirname(fixture.images[0]!)],
      exportRoots: [profile],
      port,
    });
    await service.ready;
    return { service, port, adapter };
  };
  const invoke = async (service: BridgeService, name: string, input: unknown): Promise<any> => {
    const result = await service.call(`web_image_${name}`, input);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const request = () => ({
    request_id: randomUUID(),
    mode: 'generate',
    prompt: 'M2 fixture 🐈\r\n  exact prompt',
    inputs: fixture.images
      .slice(0, 2)
      .map((file, i) => ({ path: file, role: i ? 'supporting' : 'reference' })),
  });
  if (stage === 'restart') {
    const { service } = await create('recovery');
    try {
      const saved = await readJson<{ job_id: string }>(
        path.join(profile, 'm2-recovery-request.json'),
      );
      const prior = service.engine.job(saved.job_id).snapshot;
      assert.equal(prior.state, 'waiting_user');
      assert.equal(prior.phase, 'download');
      assert.equal(prior.submission_state, 'confirmed');
      await invoke(service, 'control', {
        request_id: randomUUID(),
        job_id: prior.job_id,
        expected_revision: prior.revision,
        action: 'resume',
      });
      await service.engine.idle();
      const done = service.engine.job(prior.job_id).snapshot;
      assert.equal(done.state, 'succeeded', JSON.stringify(done));
      assert.equal(fixture.metrics.sends, 0);
      assert.equal(fixture.metrics.downloads, 1);
      pass('m2-process-restart-download-existing-response-without-new-send');
    } finally {
      await service.close();
    }
    return;
  }
  {
    const { service } = await create('http');
    context.view.setVisible(false);
    const server = await startMcp(service, 'local-fixture-token-not-for-production', 0);
    const client = new Client({ name: 'm2-electron-fixture', version: '1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: {
            headers: { Authorization: 'Bearer local-fixture-token-not-for-production' },
          },
        }),
      );
      const input = request(),
        before = fixture.metrics.sends;
      const accepted = await client.callTool({ name: 'web_image_submit', arguments: input });
      const parentId = (accepted.structuredContent as any).data.job.job_id;
      await client.close();
      await service.engine.idle();
      const parent = service.engine.job(parentId).snapshot;
      assert.equal(parent.state, 'succeeded', JSON.stringify(parent));
      assert.equal(window.isVisible(), false);
      assert.equal(fixture.metrics.sends, before + 1);
      const artifacts = (await invoke(service, 'artifacts', { job_id: parentId })).artifacts;
      assert.equal(artifacts[0].width, 48);
      assert.equal(artifacts[0].height, 32);
      assert.equal((await invoke(service, 'submit', input)).deduplicated, true);
      const follow = await invoke(service, 'submit', {
        request_id: randomUUID(),
        mode: 'edit',
        prompt: 'M2 fixture edit',
        session_id: parent.session_id,
        parent_job_id: parentId,
        inputs: [{ artifact_id: artifacts[0].artifact_id, role: 'edit_target' }],
      });
      await service.engine.idle();
      const edited = service.engine.job(follow.job.job_id).snapshot;
      assert.equal(edited.state, 'succeeded', JSON.stringify(edited));
      assert.equal(
        service.engine.session(edited.session_id).conversation_url,
        service.engine.session(parent.session_id).conversation_url,
      );
      assert.notEqual(
        (await invoke(service, 'artifacts', { job_id: edited.job_id })).artifacts[0].sha256,
        artifacts[0].sha256,
      );
      const status = await invoke(service, 'status', {});
      assert.equal(status.capabilities.web_generate.state, 'unverified');
      assert.equal(fixture.metrics.sends, before + 2);
      pass('m2-http-to-hidden-cdp-download-followup-and-disconnected-client');
    } finally {
      await client.close();
      await server.close();
      await service.close();
    }
  }
  for (const behavior of ['multi', 'viewer', 'delayed-image', 'text', 'limit', 'reject']) {
    const { service } = await create(behavior, behavior);
    try {
      const accepted = await invoke(service, 'submit', {
        ...request(),
        expected_output: { count: behavior === 'multi' ? 2 : 1 },
      });
      await service.engine.idle();
      const job = service.engine.job(accepted.job.job_id).snapshot;
      if (behavior === 'text') {
        assert.equal(job.state, 'waiting_user');
        assert.equal(job.error?.code, 'UI_CHANGED');
      } else if (behavior === 'limit') {
        assert.equal(job.state, 'waiting_user');
        assert.equal(job.error?.code, 'RATE_LIMITED');
      } else if (behavior === 'reject') {
        assert.equal(job.state, 'failed');
        assert.equal(job.error?.code, 'GENERATION_REJECTED');
      } else {
        assert.equal(job.state, 'succeeded', JSON.stringify(job));
        assert.equal(job.artifact_ids.length, behavior === 'multi' ? 2 : 1);
      }
      pass(`m2-${behavior}-result-classification`);
    } finally {
      await service.close();
    }
  }
  {
    const { service, adapter } = await create('ambiguous');
    const send = adapter.clickSend.bind(adapter);
    let attempts = 0;
    adapter.clickSend = async (baseline) => {
      attempts++;
      await send(baseline);
      throw Error('INJECTED_AFTER_CLICK');
    };
    try {
      const accepted = await invoke(service, 'submit', request());
      await service.engine.idle();
      let job = service.engine.job(accepted.job.job_id).snapshot;
      assert.equal(job.submission_state, 'confirmed');
      assert.equal(job.state, 'waiting_user');
      adapter.clickSend = send;
      await invoke(service, 'control', {
        request_id: randomUUID(),
        job_id: job.job_id,
        expected_revision: job.revision,
        action: 'resume',
      });
      await service.engine.idle();
      job = service.engine.job(job.job_id).snapshot;
      assert.equal(job.state, 'succeeded', JSON.stringify(job));
      assert.equal(attempts, 1);
      pass('m2-click-exception-recovers-existing-submission-without-resend');
    } finally {
      await service.close();
    }
  }
  {
    const { service, adapter } = await create('unknown');
    const before = fixture.metrics.sends;
    adapter.clickSend = async () => {
      throw Error('INJECTED_BEFORE_CLICK');
    };
    try {
      const accepted = await invoke(service, 'submit', request());
      await service.engine.idle();
      assert.equal(service.engine.job(accepted.job.job_id).snapshot.state, 'unknown');
      const next = await invoke(service, 'submit', request());
      await service.engine.idle();
      assert.equal(service.engine.job(next.job.job_id).snapshot.state, 'queued');
      assert.equal(fixture.metrics.sends, before);
      pass('m2-marker-before-click-unknown-blocks-next-submission');
    } finally {
      await service.close();
    }
  }
  {
    const { service } = await create('recovery');
    const collect = downloads.collect.bind(downloads);
    downloads.collect = async () => {
      throw Error('DOWNLOAD_FAILED');
    };
    try {
      const accepted = await invoke(service, 'submit', request());
      await service.engine.idle();
      const job = service.engine.job(accepted.job.job_id).snapshot;
      assert.equal(job.state, 'waiting_user');
      assert.equal(job.phase, 'download');
      assert.equal(job.submission_state, 'confirmed');
      await durableJson(path.join(profile, 'm2-recovery-request.json'), { job_id: job.job_id });
      cdp.contents.session.flushStorageData();
      pass('m2-download-failure-persists-confirmed-response-for-restart');
    } finally {
      downloads.collect = collect;
      await service.close();
    }
  }
}
