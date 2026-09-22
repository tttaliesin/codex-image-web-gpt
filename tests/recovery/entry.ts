import { app, BrowserWindow, WebContentsView, session } from 'electron';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { BridgeService } from '../../packages/core/src/service';
import { BrowserExecution } from '../../packages/browser/src/execution';
import { DownloadCollector } from '../../packages/browser/src/download';
import { Cdp, until } from '../../packages/browser/src/cdp';
import { PageAdapter, fixtureSelectors } from '../../packages/browser/src/adapter';
import { durableJson, readJson } from '../../packages/storage/src/files';
import { executionVisibility } from '../../apps/desktop/src/execution-view';

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
app.setPath('userData', config.profile);
async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  const partition = session.fromPartition('persist:recovery');
  const view = new WebContentsView({
    webPreferences: {
      session: partition,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1200, height: 900 });
  const cdp = new Cdp(view.webContents),
    adapter = new PageAdapter(cdp, fixtureSelectors, config.origin);
  const downloads = new DownloadCollector(partition, view.webContents, config.origin);
  partition.on('will-download', (event) => {
    if (!downloads.armed) event.preventDefault();
  });
  const entry = `${config.origin}/?engine=1&case=${config.name}`;
  await view.webContents.loadURL(entry);
  cdp.connect();
  const port = new BrowserExecution(adapter, downloads, {
    directory: config.directory,
    fixtureEntry: entry,
    busy: executionVisibility(window, view),
    attention: () => {},
    hidden: () => !window.isVisible(),
    generationTimeout: 10000,
  });
  const barrier = async (name: string) => {
    partition.flushStorageData();
    await durableJson(path.join(config.profile, 'barrier.json'), { name });
    await new Promise(() => {});
  };
  const run = port.run.bind(port);
  if (config.stage === 'crash') {
    port.run = async (context, recovering) => {
      if (config.name === 'before-marker') {
        const original = context.beforeSend;
        context.beforeSend = async (baseline) => {
          await barrier(config.name);
          return original(baseline);
        };
      }
      if (config.name === 'confirmed') {
        const original = context.confirm;
        context.confirm = async (evidence) => {
          await original(evidence);
          await barrier(config.name);
        };
      }
      return run(context, recovering);
    };
    const click = adapter.clickSend.bind(adapter);
    if (config.name === 'marker')
      adapter.clickSend = async () => {
        await barrier(config.name);
      };
    if (config.name === 'after-click')
      adapter.clickSend = async (baseline) => {
        await click(baseline);
        await until(
          () => adapter.snapshot(),
          (s) => s.messages.some((m) => m.role === 'user'),
          5000,
        );
        await barrier(config.name);
      };
    if (config.name === 'download-published') {
      const collect = downloads.collect.bind(downloads);
      downloads.collect = async (...args) => {
        const result = await collect(...args);
        await barrier(config.name);
        return result;
      };
    }
    if (config.name === 'download-mid')
      partition.on('will-download', (_event, item) => {
        item.on('updated', () => {
          if (item.getReceivedBytes() > 0) void barrier(config.name);
        });
      });
  }
  const service = new BridgeService({
    directory: config.directory,
    inputRoots: [],
    exportRoots: [config.output],
    port,
  });
  if (config.stage === 'crash' && config.name === 'shutdown-download') {
    let exiting = false;
    partition.on('will-download', (_event, item) => {
      item.on('updated', () => {
        if (exiting || item.getReceivedBytes() === 0) return;
        exiting = true;
        const started = Date.now();
        void service.close().then(async () => {
          const elapsed = Date.now() - started;
          assert.ok(elapsed < 2000, `Shutdown took ${elapsed} ms`);
          await durableJson(path.join(config.profile, 'barrier.json'), {
            name: config.name,
            graceful: true,
            elapsed_ms: elapsed,
          });
          app.exit(0);
        });
      });
    });
  }
  if (config.stage === 'crash' && config.name === 'artifact-published')
    (service.artifacts as any).commit = async () => barrier(config.name);
  if (config.stage === 'crash' && config.name.startsWith('export-')) {
    const put = service.db.put.bind(service.db);
    service.db.put = (table, id, value: any) => {
      const items = value?.snapshot?.items;
      const hit =
        table === 'exports' && items?.[0]?.state === 'exported' && items?.[1]?.state === 'pending';
      if (config.name === 'export-first' || !hit) put(table, id, value);
      if (hit) {
        writeFileSync(
          path.join(config.profile, 'barrier.json'),
          JSON.stringify({ name: config.name }),
        );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    };
  }
  await service.ready;
  const invoke = async (name: string, input: unknown): Promise<any> => {
    const result = await service.call(`web_image_${name}`, input);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  if (config.stage === 'crash') {
    const input = {
      request_id: randomUUID(),
      mode: 'generate',
      prompt: 'M3 process crash fixture',
      expected_output: { count: config.name.startsWith('export-') ? 2 : 1 },
    };
    await durableJson(path.join(config.profile, 'request.json'), input);
    const accepted = await invoke('submit', input);
    if (config.name.startsWith('export-')) {
      await service.engine.idle();
      const job = service.engine.job(accepted.job.job_id).snapshot;
      assert.equal(job.state, 'succeeded');
      const exporting = {
        export_id: randomUUID(),
        artifact_ids: job.artifact_ids,
        destination_dir: config.output,
      };
      await durableJson(path.join(config.profile, 'export.json'), exporting);
      await invoke('export', exporting);
    }
    await new Promise(() => {});
  } else {
    const input = await readJson<any>(path.join(config.profile, 'request.json'));
    await service.engine.idle();
    const replay = await invoke('submit', input);
    assert.equal(replay.deduplicated, true);
    const job = service.engine.job(replay.job.job_id).snapshot;
    assert.equal(
      job.state,
      ['marker', 'after-click'].includes(config.name) ? 'unknown' : 'succeeded',
      JSON.stringify(job),
    );
    if (config.name.startsWith('export-')) {
      await service.exporter.idle();
      const result = await invoke(
        'export',
        await readJson(path.join(config.profile, 'export.json')),
      );
      assert.equal(result.export.state, 'succeeded');
    }
    await durableJson(path.join(config.profile, 'result.json'), {
      name: config.name,
      state: job.state,
      submission_state: job.submission_state,
      artifacts: job.artifact_ids.length,
    });
    await service.close();
    app.exit(0);
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
