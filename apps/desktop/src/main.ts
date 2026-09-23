import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  Tray,
  Menu,
  nativeImage,
  dialog,
  powerMonitor,
  shell,
  clipboard,
} from 'electron';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Cdp, until } from '../../../packages/browser/src/cdp';
import {
  PageAdapter,
  chatgptSelectors,
  fixtureSelectors,
} from '../../../packages/browser/src/adapter';
import { allowedNavigation, conversationUrl } from '../../../packages/browser/src/policy';
import { DownloadCollector } from '../../../packages/browser/src/download';
import {
  ProbeRunner,
  safeError,
  validateRequest,
  type ProbeRequest,
  type ProbeRecord,
} from './probe';
import { durableJson, readJson } from '../../../packages/storage/src/files';
import { hostMcp, type McpConfiguration } from './mcp-host';
import { BrowserExecution } from '../../../packages/browser/src/execution';
import { executionVisibility } from './execution-view';
import { Operations } from './operations';
import { bindPower } from './power';
import { DesktopSurface } from './desktop-surface';
import { handleDesktopCommand } from './ipc';
import { loadPageDocument } from './page-navigation';
import { observePage, pageStatus as observedPageStatus, type PageStatus } from './page-observer';

const root = path.resolve(__dirname, '../../../..');
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const operationsTesting = process.argv.includes('--operations-test');
const setupTesting = process.argv.includes('--setup-test');
const testing = process.argv.includes('--self-test') || operationsTesting || setupTesting;
const fixtureMode = testing || process.argv.includes('--fixture');
const { DesktopSetup, launchContext } = require(path.join(root, 'scripts/lib/desktop-setup.cjs'));
const context = launchContext({
  appRoot: root,
  packaged: app.isPackaged,
  root:
    argument('--install-root') ??
    (app.isPackaged
      ? path.join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'WebImageBridge')
      : path.join(argument('--profile') ?? path.join(root, '.local'), 'desktop')),
  profile:
    argument('--profile') ??
    (!app.isPackaged
      ? path.join(root, '.local', fixtureMode ? 'fixture-profile' : 'profile')
      : undefined),
  config: argument('--mcp-config'),
});
const profile: string = context.profile;
const mcpConfiguration =
  argument('--mcp-config') || (!testing && !argument('--request')) ? context.config : undefined;
let setup: InstanceType<typeof DesktopSetup> | undefined;
app.setName('Web Image Bridge');
app.setPath('userData', path.resolve(profile));
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let phase = 'ready';
let request: ProbeRequest | undefined;
let runner: ProbeRunner | undefined;
let fixture:
  Awaited<ReturnType<typeof import('../../../tests/fixtures/server').fixtureServer>> | undefined;
let desktop: DesktopSurface | undefined;
let preparingPage = false;
let runPrepared: (() => void) | undefined;
let mcp: Awaited<ReturnType<typeof hostMcp>> | undefined;
let webExecution: BrowserExecution | undefined;
let operations: Operations | undefined;
let refreshTray: (() => void) | undefined;
let closingMcp = false;
let pageStatus: PageStatus = 'loading';
let configuration: McpConfiguration | undefined;
const isBusy = () => !!runner?.busy || preparingPage || !!webExecution?.busy;
const syncPageVisibility = () => desktop?.syncVisibility();
const show = () => desktop?.show();
const showBrowser = () => desktop?.show(true);
const validationFile = argument('--mcp-validation-file');
const validationId = argument('--mcp-validation-id');
const ownsLock = app.requestSingleInstanceLock({
  validation: validationFile ? { file: path.resolve(validationFile), id: validationId } : null,
});
if (!ownsLock) app.quit();
app.on('second-instance', (_event, argv, _cwd, additionalData) => {
  const validation = (
    additionalData as { validation?: { file?: unknown; id?: unknown } } | undefined
  )?.validation;
  if (validation) {
    void Promise.resolve()
      .then(async () => {
        if (!mcp || typeof validation.file !== 'string' || typeof validation.id !== 'string')
          throw Error('MCP_VALIDATION_UNAVAILABLE');
        await mcp.validate(validation.file, validation.id);
      })
      .catch(() => status('MCP_VALIDATION_FAILED'));
    return;
  }
  if (argv.includes('--run-approved')) runPrepared?.();
  else show();
});
app.on('before-quit', (event) => {
  quitting = true;
  if (mcp && !closingMcp) {
    event.preventDefault();
    closingMcp = true;
    void mcp.close().finally(() => {
      mcp = undefined;
      app.quit();
    });
  }
});
app.on('window-all-closed', () => {
  /* tray owns app lifetime */
});
app.on('will-quit', () => {
  fixture?.close();
  tray?.destroy();
});

function status(value: string) {
  phase = value;
  syncPageVisibility();
  tray?.setToolTip(`Web Image Bridge: ${value}`);
  refreshTray?.();
  void durableJson(path.join(profile, 'status.json'), {
    phase,
    busy: !!runner?.busy || !!webExecution?.busy,
    at: new Date().toISOString(),
  }).catch(() => {});
}

async function start() {
  await app.whenReady();
  await mkdir(profile, { recursive: true });
  if (mcpConfiguration) {
    setup = new DesktopSetup({
      ...context,
      config: mcpConfiguration,
      port: fixtureMode ? 43180 : 43179,
      configureFolders: async (next: McpConfiguration, persist: () => Promise<void>) => {
        if (!mcp) throw Error('MCP_NOT_ENABLED');
        await mcp.service.configureFolders(next.input_roots, next.export_roots, persist);
      },
      health: async (connection: { url: string; headers: Record<string, string> }) => {
        if (!mcp) throw Error('MCP_NOT_ENABLED');
        return mcp.check(connection);
      },
      shortcut: async (installed: { exe: string; profile: string; config: string }) => {
        const shortcutFile = path.join(app.getPath('desktop'), 'Web Image Bridge.lnk');
        // Never replace a shortcut belonging to another application.
        try {
          const previous = shell.readShortcutLink(shortcutFile);
          if (!previous.target.startsWith(path.join(context.root, 'versions') + path.sep)) return;
        } catch {
          /* First installation has no shortcut. */
        }
        shell.writeShortcutLink(shortcutFile, 'create', {
          target: installed.exe,
          args: `--profile "${installed.profile}" --mcp-config "${installed.config}" --install-root "${context.root}"`,
          description: 'Web Image Bridge',
        });
      },
    });
    await setup.initialize();
    configuration = setup.configuration as McpConfiguration;
  }
  if (fixtureMode) {
    if (app.isPackaged) throw Error('DEVELOPMENT_MODE_REQUIRES_SOURCE');
    const { fixtureServer } =
      require('../../../tests/fixtures/server') as typeof import('../../../tests/fixtures/server');
    fixture = await fixtureServer(path.join(profile, 'fixture-files'));
  }
  const partition = session.fromPartition('persist:web-image-primary');
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on('will-download', (event) => {
    if (!runner?.downloads.armed) event.preventDefault();
  });
  window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: 'Web Image Bridge',
    icon: path.join(root, 'apps/desktop/ui/icon.png'),
    backgroundColor: '#181818',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#212121', symbolColor: '#b0b0b0', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  window.center();
  const view = new WebContentsView({
    webPreferences: {
      session: partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.contentView.addChildView(view);
  desktop = new DesktopSurface(window, view, isBusy);
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window!.hide();
    }
  });
  window.on('closed', () => {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  view.webContents.setZoomFactor(1);
  const guard = (contents: Electron.WebContents) => {
    contents.on('will-navigate', (event, url) => {
      if (!allowedNavigation(url, fixture?.origin)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!allowedNavigation(url, fixture?.origin)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (!allowedNavigation(url, fixture?.origin)) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: window,
          autoHideMenuBar: true,
          webPreferences: {
            session: partition,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
          },
        },
      };
    });
    contents.on('did-create-window', (popup) => {
      guard(popup.webContents);
      popup.setMenu(null);
    });
  };
  guard(view.webContents);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const icon = nativeImage
    .createFromPath(path.join(root, 'apps/desktop/ui/icon.png'))
    .resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip('Web Image Bridge');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '창 열기', click: show },
      { label: '창 숨기기', click: () => window!.hide() },
      { type: 'separator' },
      {
        label: '앱 종료',
        click: () => {
          app.quit();
        },
      },
    ]),
  );
  tray.on('double-click', show);
  let traySignature = '';
  refreshTray = () => {
    if (!operations) return;
    const snapshot = operations.snapshot();
    const label = `${phase} · 대기 ${snapshot.waiting_count}건${snapshot.job?.requires_action ? ' · 확인 필요' : ''}${snapshot.paused ? ' · 새 작업 정지' : ''}${snapshot.draining ? ' · 완료 후 종료' : ''}`;
    if (label === traySignature) return;
    traySignature = label;
    const invoke = (action: string) => {
      void operations!.command(action).catch((error) => status(safeError(error)));
    };
    tray!.setToolTip(`Web Image Bridge: ${label}`.slice(0, 127));
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label, enabled: false },
        { label: '창 열기', click: show },
        { label: '창 숨기기', click: () => window!.hide() },
        { type: 'separator' },
        {
          label: snapshot.paused ? '새 작업 시작 재개' : '새 작업 시작 일시정지',
          enabled: !snapshot.draining,
          click: () => invoke(snapshot.paused ? 'resume-queue' : 'pause-queue'),
        },
        {
          label: '현재 작업 완료 후 종료',
          enabled: !snapshot.draining,
          click: () => invoke('quit-after'),
        },
        { label: '기록 저장 후 즉시 종료', click: () => invoke('quit-now') },
      ]),
    );
  };
  const cdp = new Cdp(view.webContents);
  const adapter = new PageAdapter(
    cdp,
    fixtureMode ? fixtureSelectors : chatgptSelectors,
    fixture?.origin,
  );
  const downloads = new DownloadCollector(partition, view.webContents, fixture?.origin);
  runner = new ProbeRunner(path.join(profile, 'probes'), adapter, downloads, status);
  cdp.contents.debugger.on('detach', () => {
    if (!quitting) {
      status('ADAPTER_UNAVAILABLE');
      void operations?.suspend('ADAPTER_UNAVAILABLE');
    }
  });
  const requestFile = argument('--request');
  if (requestFile) {
    request = await readJson(requestFile);
    validateRequest(request);
  }
  runPrepared = () => {
    if (!request || runner!.busy || preparingPage || webExecution) return;
    preparingPage = true;
    cdp.connect();
    window!.hide();
    const approved = request;
    void until(
      () => adapter.snapshot(),
      (value) => value.composer === 1 && !value.login && !value.challenge,
      30000,
    )
      .then(() => runner!.run(approved, () => window!.hide()))
      .catch((error) => {
        status(safeError(error));
        showBrowser();
      })
      .finally(() => {
        preparingPage = false;
        syncPageVisibility();
        status(phase);
      });
  };
  handleDesktopCommand(window, 'bridge:status', () => {
    return {
      phase,
      surface: desktop!.selected,
      page_status: pageStatus,
      mcp_enabled: !!mcp,
      web_execution: !!webExecution,
      operations: operations?.snapshot() ?? null,
      busy: isBusy(),
      recent_jobs: (mcp?.service.engine.jobs() ?? [])
        .slice(-8)
        .reverse()
        .map(({ snapshot: job }) => ({
          job_id: job.job_id,
          mode: job.mode,
          state: job.state,
          requires_action: job.requires_action,
          created_at: job.created_at,
          artifact_count: job.artifact_ids.length,
        })),
      settings: {
        mcp_endpoint: mcp?.url ?? null,
        input_roots: configuration?.input_roots ?? [],
        export_roots: configuration?.export_roots ?? [],
        profile,
        version: app.getVersion(),
      },
      setup: setup?.snapshot() ?? null,
      request: request ? { id: request.id, input_count: request.inputs.length } : null,
    };
  });
  handleDesktopCommand(window, 'bridge:setup', async (action: unknown, index?: unknown) => {
    if (!setup) throw Error('SETUP_UNAVAILABLE');
    if (
      typeof action !== 'string' ||
      ![
        'pick-input',
        'pick-output',
        'remove-input',
        'connect',
        'disconnect',
        'check',
        'copy-example',
      ].includes(action)
    )
      throw Error('INPUT_INVALID');
    if (action === 'pick-input' || action === 'pick-output') {
      const picked = await dialog.showOpenDialog(window!, {
        title: action === 'pick-input' ? '참고 이미지를 가져올 폴더' : '이미지를 저장할 폴더',
        properties: [
          'openDirectory',
          'createDirectory',
          ...(action === 'pick-input' ? ['multiSelections' as const] : []),
        ],
      });
      return setup.setFolders(
        action === 'pick-input' ? 'input' : 'export',
        picked.canceled
          ? null
          : action === 'pick-input'
            ? [...configuration!.input_roots, ...picked.filePaths]
            : picked.filePaths,
      );
    }
    if (action === 'remove-input') {
      if (
        !Number.isInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= configuration!.input_roots.length
      )
        throw Error('INPUT_INVALID');
      return setup.setFolders(
        'input',
        configuration!.input_roots.filter((_, i) => i !== index),
      );
    }
    if (action === 'copy-example') {
      const output = configuration!.export_roots[0];
      if (!output) throw Error('OUTPUT_FOLDER_REQUIRED');
      await clipboard.writeText(
        `Web Image Bridge로 흰 배경 위의 작은 도자기 화병을 그려줘. 결과 원본을 ${output} 폴더에 저장해줘.`,
      );
      return { copied: true };
    }
    if (action === 'connect') {
      if (!mcp) throw Error('MCP_NOT_ENABLED');
      if (pageStatus !== 'ready') throw Error('AUTH_REQUIRED');
      const result = await setup.connect();
      await setup.check();
      return { ...result, verified: true };
    }
    if (action === 'disconnect') return setup.disconnect();
    return setup.check();
  });
  handleDesktopCommand(window, 'bridge:surface', (selected: string) => desktop!.select(selected));
  handleDesktopCommand(window, 'bridge:viewport', (bounds: Electron.Rectangle) =>
    desktop!.viewport(bounds),
  );
  handleDesktopCommand(
    window,
    'bridge:action',
    async (action: string, expected?: ReturnType<Operations['snapshot']>) => {
      if (action === 'hide') {
        window!.hide();
        return;
      }
      if (action === 'copy-mcp-token') {
        if (mcp) mcp.copyToken();
        else throw Error('MCP_NOT_ENABLED');
        return;
      }
      if (action === 'open-results') {
        const destination = configuration?.export_roots[0];
        if (!destination || (await shell.openPath(destination))) throw Error('PATH_DENIED');
        return;
      }
      if (
        operations &&
        [
          'pause-queue',
          'resume-queue',
          'takeover',
          'release',
          'cancel',
          'resume-job',
          'reconcile',
          'release-remote',
          'quit-after',
          'quit-now',
          'reconnect',
        ].includes(action)
      ) {
        try {
          if (action === 'release-remote') {
            const { response } = await dialog.showMessageBox(window!, {
              type: 'warning',
              buttons: ['잠금 해제', '취소'],
              defaultId: 1,
              cancelId: 1,
              title: '웹 생성 종료 확인',
              message: '중단한 작업의 웹 생성이 끝났는지 확인했나요?',
              detail:
                'ChatGPT 페이지에서 이 요청이 전송되지 않았거나 생성이 끝난 것을 직접 확인한 경우에만 해제하세요. 해제하면 대기 중인 다음 작업이 시작됩니다.',
            });
            if (response !== 0) return;
          }
          if (action === 'reconnect') {
            cdp.connect();
            await operations.resume('ADAPTER_UNAVAILABLE');
            if (!webExecution?.busy) status('ready');
          } else await operations.command(action, expected);
          refreshTray?.();
        } catch (error) {
          status(safeError(error));
          throw Error(safeError(error));
        }
        return;
      }
      if (runner!.busy || preparingPage || webExecution) return;
      try {
        if (action === 'load') {
          const picked = await dialog.showOpenDialog(window!, {
            properties: ['openFile'],
            filters: [{ name: '승인된 M0 요청', extensions: ['json'] }],
          });
          if (!picked.canceled) {
            const value = await readJson(picked.filePaths[0]!);
            validateRequest(value);
            request = value;
            status('ready');
          }
        } else if (action === 'run' && request) {
          runPrepared!();
        }
      } catch (error) {
        status(safeError(error));
      }
    },
  );
  await window.loadFile(path.join(root, 'apps/desktop/ui/index.html'));
  if (!testing) show();
  let startUrl = fixture?.origin ?? 'https://chatgpt.com/';
  if (request && !fixtureMode) {
    const saved = await readJson<ProbeRecord>(
      path.join(profile, 'probes', request.id, 'probe.json'),
    ).catch(() => undefined);
    if (
      saved?.conversation_url &&
      conversationUrl(saved.conversation_url) &&
      JSON.stringify(saved.request) === JSON.stringify(request)
    )
      startUrl = saved.conversation_url;
    else if (request.parent_id) {
      const parent = await readJson<ProbeRecord>(
        path.join(profile, 'probes', request.parent_id, 'probe.json'),
      );
      if (!parent.artifact || !parent.conversation_url || !conversationUrl(parent.conversation_url))
        throw Error('PARENT_MISMATCH');
      startUrl = parent.conversation_url;
    }
  }
  if (!(await loadPageDocument(view.webContents, startUrl))) status('PAGE_LOAD_FAILED');
  cdp.connect();
  const initialPage = await adapter.snapshot().catch(() => null);
  pageStatus = observedPageStatus(initialPage);
  if (mcpConfiguration) {
    configuration = setup.configuration as McpConfiguration;
    if (configuration.web_execution) {
      if (request) throw Error('STATE_CONFLICT');
      webExecution = new BrowserExecution(adapter, downloads, {
        directory: path.join(profile, 'm1'),
        busy: (active) => {
          executionVisibility(window!, view)(active);
          status(phase);
        },
        attention: (code) => {
          status(code);
          showBrowser();
        },
        hidden: () => !window!.isVisible(),
        fixtureEntry: fixture ? `${fixture.origin}/?engine=1` : undefined,
      });
      await webExecution.restoreCapabilities();
    }
    mcp = await hostMcp(
      path.join(profile, 'm1'),
      configuration,
      {
        setVisible: async (visible, selected) => {
          if (
            visible &&
            selected?.conversation_url &&
            !webExecution?.busy &&
            view.webContents.getURL() !== selected.conversation_url
          )
            await view.webContents.loadURL(
              fixture
                ? selected.conversation_url.replace('https://chatgpt.com', fixture.origin)
                : selected.conversation_url,
            );
          if (visible) showBrowser();
          else window!.hide();
        },
        setManual: async (manual, selected) => {
          if (runner?.busy || preparingPage || webExecution?.busy) throw Error('STATE_CONFLICT');
          if (manual) {
            const destination = selected?.conversation_url
              ? fixture
                ? selected.conversation_url.replace('https://chatgpt.com', fixture.origin)
                : selected.conversation_url
              : !mcp?.service.engine.active()
                ? (fixture?.origin ?? 'https://chatgpt.com/')
                : null;
            if (destination && view.webContents.getURL() !== destination)
              await view.webContents.loadURL(destination);
            showBrowser();
          } else window!.hide();
        },
      },
      webExecution,
    );
    mcp.service.engine.changes.on('changed', (id: string) => {
      const job = mcp!.service.engine.job(id).snapshot;
      status(job.error?.code ?? (job.terminal ? job.state : job.phase));
      void operations?.checkDrain();
    });
    operations = new Operations(mcp.service, () => app.quit());
    const restoredManual = operations.snapshot().session;
    if (restoredManual?.control_owner === 'manual' && restoredManual.conversation_url) {
      desktop.select('browser');
      await view.webContents.loadURL(
        fixture
          ? restoredManual.conversation_url.replace('https://chatgpt.com', fixture.origin)
          : restoredManual.conversation_url,
      );
    }
    mcp.service.engine.changes.on('operations', () => refreshTray?.());
    const unbindPower = bindPower(powerMonitor, operations);
    app.once('will-quit', unbindPower);
    refreshTray();
    if (setup?.registered) await setup.check().catch(() => {});
  }
  if (testing) {
    try {
      if (setupTesting) {
        const { setupSelfTest } =
          require('../../../tests/electron/setup-self-test') as typeof import('../../../tests/electron/setup-self-test');
        if (!mcp || !setup) throw Error('MCP_NOT_ENABLED');
        await setupSelfTest(window, view, setup, mcp.service, profile);
        await mcp.close();
        mcp = undefined;
      } else if (operationsTesting) {
        const { operationsSelfTest } =
          require('../../../tests/electron/operations-self-test') as typeof import('../../../tests/electron/operations-self-test');
        if (!mcp) throw Error('MCP_NOT_ENABLED');
        await operationsSelfTest(window, tray, mcp.service, profile, view);
        await mcp.close();
        mcp = undefined;
      } else {
        const { selfTest } =
          require('../../../tests/electron/self-test') as typeof import('../../../tests/electron/self-test');
        await selfTest({
          window,
          view,
          tray,
          runner,
          cdp,
          fixture: fixture!,
          profile,
          stage: argument('--stage') ?? 'first',
        });
      }
      console.log(JSON.stringify({ result: 'passed', stage: argument('--stage') ?? 'first' }));
      quitting = true;
      app.exit(0);
    } catch (error) {
      console.error(error);
      quitting = true;
      app.exit(1);
    }
  } else {
    if (!webExecution?.busy) show();
    const stopObserving = await observePage({
      adapter,
      cdp,
      profile,
      execution: webExecution,
      operations,
      diagnostics: process.argv.includes('--diagnostics'),
      busy: isBusy,
      phase: () => phase,
      status,
      pageStatus: (value) => {
        pageStatus = value;
      },
      refreshTray: () => refreshTray?.(),
    });
    app.once('before-quit', stopObserving);
    if (process.argv.includes('--run-approved')) runPrepared();
  }
}
if (ownsLock && validationFile)
  app.exit(2); // Validation only targets an already running owner.
else if (ownsLock)
  void start().catch((error) => {
    console.error(safeError(error));
    app.exit(1);
  });
