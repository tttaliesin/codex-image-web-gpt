// Text comes from i18n.js: t(key) for messages, applyStaticText() for data-i18n markup.
const label = (key) => t('labels')[key];
const $ = (selector) => document.querySelector(selector);
const text = (selector, value) => {
  const element = $(selector);
  if (element.textContent !== String(value)) element.textContent = value;
};
const tone = (selector, value) => {
  $(selector).dataset.tone = value;
};
let displayed,
  latest,
  refreshing = false,
  pendingAction = false,
  historySignature = '',
  surface = 'workspace',
  viewportSignature = '',
  toastTimer;
let setupPending = false,
  folderSignature = '';

// The main process owns the saved choice; the page follows what status reports.
function setLanguage(value) {
  if (!MESSAGES[value] || value === language) return;
  language = value;
  historySignature = '';
  folderSignature = '';
  applyStaticText();
  setSurface(surface);
}

function renderSetup(state) {
  const setup = state.setup;
  $('#setup-guide').hidden = !setup;
  if (!setup) return;
  const folders = !!state.settings?.export_roots?.length;
  const login = state.page_status === 'ready';
  const connected = setup.registered && setup.checked;
  const completed = [folders, login, connected];
  ['folders', 'login', 'codex'].forEach((name, index) => {
    const step = $(`#setup-${name}`);
    step.dataset.complete = String(completed[index]);
    step.querySelector('.step-number').textContent = completed[index] ? '✓' : String(index + 1);
  });
  text('#setup-count', `${completed.filter(Boolean).length} / 3`);
  text(
    '#setup-folders-hint',
    folders ? t('foldersHintSet', state.settings.export_roots[0]) : t('foldersHint'),
  );
  text('#setup-login-hint', login ? t('loginHintReady') : t('loginHint'));
  text(
    '#setup-codex-hint',
    !setup.available
      ? t('codexHintSource')
      : setup.shadow_copies?.length
        ? t('codexHintShadow', setup.shadow_copies.join(', '))
        : setup.skill_conflict && !setup.registered
          ? t('codexHintSkill', setup.skill_conflict)
          : connected
            ? t('codexHintConnected')
            : setup.registered
              ? t('codexHintRegistered')
              : t('codexHint'),
  );
  text(
    '#integration-setting',
    setup.error
      ? t('setupErrors')[setup.error] || t('integrationUnknownError')
      : connected
        ? t('integrationConnected')
        : setup.registered
          ? t('integrationRegistered')
          : t('integrationNone'),
  );
  $('#setup-ready').hidden = !completed.every(Boolean);
  const allowed = {
    'pick-input': state.mcp_enabled && !state.busy,
    'pick-output': state.mcp_enabled && !state.busy,
    'remove-input': state.mcp_enabled && !state.busy,
    connect: setup.available && folders && login && state.mcp_enabled,
    'replace-skill':
      setup.available && folders && login && state.mcp_enabled && !!setup.skill_conflict,
    'retire-shadow': !!setup.shadow_copies?.length,
    disconnect: setup.registered || !!setup.error,
    check: setup.registered && state.mcp_enabled,
    'copy-example': folders,
  };
  const signature = JSON.stringify(state.settings.input_roots);
  if (signature !== folderSignature) {
    folderSignature = signature;
    $('#input-folders').replaceChildren();
    (state.settings.input_roots || []).forEach((folder, index) => {
      const row = document.createElement('div');
      row.className = 'folder-entry';
      const name = document.createElement('span');
      name.textContent = folder;
      const remove = document.createElement('button');
      remove.className = 'button quiet';
      remove.dataset.setup = 'remove-input';
      remove.dataset.index = String(index);
      remove.textContent = t('removeFolder');
      remove.setAttribute('aria-label', t('removeFolderAria', folder));
      row.append(name, remove);
      $('#input-folders').append(row);
    });
  }
  document.querySelectorAll('[data-setup]').forEach((button) => {
    const action = button.dataset.setup;
    button.disabled = setupPending || setup.working || !allowed[action];
    if (action === 'disconnect') button.hidden = !setup.registered && !setup.error;
    if (action === 'connect') {
      button.hidden = setup.registered && !setup.update_available;
      button.textContent = setup.update_available ? t('updateApp') : t('connectCodex');
    }
    if (action === 'check') button.hidden = !setup.registered;
    if (action === 'replace-skill') button.hidden = !setup.skill_conflict || setup.registered;
    if (action === 'retire-shadow') button.hidden = !setup.shadow_copies?.length;
  });
}

function setSurface(value) {
  surface = value;
  for (const name of ['workspace', 'browser', 'settings'])
    $(`#${name}-panel`).hidden = name !== value;
  document.querySelectorAll('.nav-item[data-surface]').forEach((button) => {
    button.classList.toggle('active', button.dataset.surface === value);
    if (button.dataset.surface === value) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  text('#breadcrumb', t('surfaces')[value]);
  requestAnimationFrame(reportViewport);
}
async function reportViewport() {
  if (surface !== 'browser') return;
  const rect = $('#browser-viewport').getBoundingClientRect();
  const bounds = {
    x: Math.round(rect.x + 1),
    y: Math.round(rect.y + 1),
    width: Math.round(rect.width - 2),
    height: Math.round(rect.height - 2),
  };
  const signature = JSON.stringify(bounds);
  if (signature === viewportSignature || bounds.width < 1 || bounds.height < 1) return;
  try {
    await window.bridge.viewport(bounds);
    viewportSignature = signature;
  } catch {
    /* Next resize or status poll retries. */
  }
}
function showError(message) {
  text('#action-error', message);
  $('#action-error').hidden = false;
}
function toast(message) {
  clearTimeout(toastTimer);
  text('#action-message', message);
  $('#action-message').hidden = false;
  toastTimer = setTimeout(() => {
    $('#action-message').hidden = true;
  }, 3500);
}
const jobTone = (job) =>
  ['succeeded', 'complete'].includes(job?.state)
    ? 'success'
    : job?.state === 'failed'
      ? 'error'
      : job?.requires_action || ['partial', 'canceled'].includes(job?.state)
        ? 'warning'
        : 'neutral';
function renderHistory(jobs) {
  const signature = JSON.stringify(jobs);
  if (signature === historySignature) return;
  historySignature = signature;
  $('#job-list').replaceChildren();
  $('#empty-history').hidden = jobs.length > 0;
  text('#history-count', jobs.length ? t('historyCount', jobs.length) : '');
  const dates = new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  for (const job of jobs) {
    const row = document.createElement('div');
    row.className = 'job-row';
    const icon = document.createElement('div');
    icon.className = 'job-icon';
    icon.innerHTML = '<svg aria-hidden="true"><use href="#i-image"/></svg>';
    const copy = document.createElement('div');
    copy.className = 'job-copy';
    const title = document.createElement('div');
    title.className = 'job-title';
    title.textContent = job.mode === 'edit' ? t('jobEdit') : t('jobGenerate');
    const meta = document.createElement('div');
    meta.className = 'job-meta';
    const date = new Date(job.created_at);
    meta.textContent = `${Number.isNaN(date.valueOf()) ? '' : dates.format(date)} · ${job.job_id.slice(0, 8)}`;
    copy.append(title, meta);
    const state = document.createElement('span');
    state.className = 'job-state';
    state.dataset.tone = jobTone(job);
    state.textContent = label(job.state) || t('jobStateUnknown');
    const files = document.createElement('span');
    files.className = 'job-files';
    files.textContent = job.artifact_count ? t('jobFiles', job.artifact_count) : '—';
    row.append(icon, copy, state, files);
    $('#job-list').append(row);
  }
}
function render(state) {
  latest = state;
  displayed = state.operations;
  if (state.language) setLanguage(state.language);
  renderSetup(state);
  const ops = state.operations,
    job = ops?.job,
    manual = ops?.session?.control_owner === 'manual';
  const page = state.page_status || 'loading',
    pageLabels = t('pageLabels');
  const pageTone =
    page === 'ready'
      ? 'success'
      : ['login', 'challenge', 'unavailable'].includes(page)
        ? 'warning'
        : 'neutral';
  if (state.surface && state.surface !== surface) setSurface(state.surface);
  const enabled = {
    'pause-queue': ops && !ops.paused && !ops.draining,
    'resume-queue': ops?.paused && !ops.draining,
    takeover: ops?.session && !manual && job?.submission_state !== 'sending',
    release: manual,
    reconnect: ops?.suspended === 'ADAPTER_UNAVAILABLE',
    reconcile: !manual && (job?.requires_action || (job?.remote_may_continue && job?.terminal)),
    'release-remote': !!(job?.terminal && job?.remote_may_continue),
    'resume-job': !manual && job?.requires_action && job?.submission_state !== 'unknown',
    cancel: job && !job.terminal,
    'quit-after': ops && !ops.draining,
    'quit-now': !!ops,
    load: !state.busy && !state.web_execution,
    run: !state.busy && !!state.request && !state.web_execution,
    'copy-mcp-token': state.mcp_enabled,
    'open-results': !!state.settings?.export_roots?.length,
  };
  for (const [action, allow] of Object.entries(enabled))
    $(`[data-action="${action}"]`).disabled = pendingAction || !allow;
  $('[data-action="pause-queue"]').hidden = !!ops?.paused;
  $('[data-action="resume-queue"]').hidden = !ops?.paused;
  $('[data-action="takeover"]').hidden = manual;
  $('[data-action="release"]').hidden = !manual;
  for (const action of ['reconcile', 'release-remote', 'resume-job', 'cancel'])
    $(`[data-action="${action}"]`).hidden = !enabled[action];
  $('#operations').hidden = !ops;
  $('#legacy-controls').hidden = state.web_execution;
  text('#queue', ops ? t('queueLine', ops.waiting_count, ops.paused, manual) : '');
  let heading = t('idleHeading');
  let notice = t('idleNotice');
  let statusTone = state.busy ? 'warning' : jobTone(job);
  if (state.phase === 'AUTH_REQUIRED' || page === 'login') {
    heading = t('loginHeading');
    notice = t('loginNotice');
    statusTone = 'warning';
  } else if (state.phase === 'HUMAN_CHECK_REQUIRED' || page === 'challenge') {
    heading = t('challengeHeading');
    notice = t('challengeNotice');
    statusTone = 'warning';
  } else if (ops?.draining) {
    heading = t('drainingHeading');
    notice = t('drainingNotice');
    statusTone = 'warning';
  } else if (job?.terminal && job.remote_may_continue) {
    heading = t('remoteHeading');
    notice =
      job.submission_state === 'confirmed' ? t('remoteConfirmedNotice') : t('remoteUnknownNotice');
    statusTone = 'warning';
  } else if (manual) {
    heading = t('manualHeading');
    notice = t('manualNotice');
    statusTone = 'warning';
  } else if (ops?.suspended) {
    heading = label(ops.suspended) || t('suspendedHeading');
    notice = t('suspendedNotice');
    statusTone = 'warning';
  } else if (ops?.paused && !state.busy && (!job || job.state === 'queued')) {
    heading = t('pausedHeading');
    notice = t('pausedNotice');
    statusTone = 'warning';
  } else if (job?.state === 'queued' && !state.busy) {
    heading = t('queuedHeading');
    notice = t('queuedNotice');
  } else if (
    // Only a diverged follow-up fails unsent with fix_input; a rejection is always confirmed.
    job?.state === 'failed' &&
    job.submission_state === 'not_sent' &&
    job.error?.code === 'STATE_CONFLICT' &&
    job.error.next_action === 'fix_input'
  ) {
    heading = t('divergedHeading');
    notice = t('divergedNotice');
    statusTone = 'warning';
  } else if (job?.requires_action || job?.state === 'failed') {
    heading = job?.state === 'failed' ? t('failedHeading') : t('actionHeading');
    notice = `${label(job.error?.code) || t('actionFallback')} · ${t('actionSuffix')}`;
    statusTone = jobTone(job);
  } else if (state.busy || (job && !job.terminal)) {
    heading = label(job?.phase || state.phase) || t('busyHeading');
    notice = t('busyNotice');
    statusTone = 'warning';
  } else if (job?.state === 'succeeded') {
    heading = t('succeededHeading');
    notice = t('succeededNotice');
    statusTone = 'success';
  } else if (job?.state === 'partial') {
    heading = t('partialHeading');
    notice = t('partialNotice');
    statusTone = 'warning';
  } else if (job?.state === 'canceled') {
    heading = t('canceledHeading');
    notice = t('canceledNotice');
  } else if (!state.mcp_enabled) {
    heading = t('noMcpHeading');
    notice = t('noMcpNotice');
  } else if (ops?.paused) {
    heading = t('pausedHeading');
    notice = t('pausedNotice');
  }
  text(
    '#request-description',
    state.request && !state.web_execution
      ? t('requestDescription', state.request.id, state.request.input_count)
      : t('legacyHint'),
  );
  text('#current-title', heading);
  text('#notice', notice);
  text(
    '#status',
    manual
      ? t('statusManual')
      : ops?.paused && !state.busy
        ? t('statusPaused')
        : label(state.phase) || t('statusUnknown'),
  );
  tone('#status', statusTone);
  tone('#work-symbol', statusTone);
  text(
    '#work-state',
    job
      ? `${job.mode === 'edit' ? t('workEdit') : t('workGenerate')} · ${job.job_id.slice(0, 8)}`
      : t('workIdle'),
  );
  const stepIndex =
    job?.state === 'succeeded' || state.phase === 'complete'
      ? 3
      : (job?.phase || state.phase) === 'download'
        ? 2
        : ['submit', 'generate'].includes(job?.phase || state.phase)
          ? 1
          : 0;
  document.querySelectorAll('[data-step]').forEach((element, index) => {
    const progressing = !!state.busy || ['running', 'reconciling'].includes(job?.state);
    const done = !!job && !['failed', 'canceled'].includes(job.state) && index < stepIndex;
    element.classList.toggle('done', done);
    element.classList.toggle('current', progressing && index === stepIndex);
    if (progressing && index === stepIndex) element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
    element.querySelector('span').textContent = done ? '✓' : String(index + 1);
  });
  const codexReady = state.mcp_enabled && (!state.setup || state.setup.registered);
  text('#mcp-summary', codexReady ? t('mcpRegistered') : t('mcpNeeded'));
  tone('#mcp-summary', codexReady ? 'success' : 'warning');
  text('#session-summary', pageLabels[page] || t('checking'));
  tone('#session-summary', pageTone);
  text('#waiting-summary', t('waitingCount', ops?.waiting_count ?? 0));
  tone('#connection-dot', codexReady ? 'success' : 'warning');
  tone('#browser-dot', pageTone);
  text('#connection-label', codexReady ? t('connectionRegistered') : t('connectionNeeded'));
  text(
    '#connection-caption',
    state.busy ? t('captionBusy') : ops?.paused ? t('captionPaused') : t('captionRunning'),
  );
  text('#mcp-endpoint', state.settings?.mcp_endpoint || t('mcpOff'));
  text('#login-setting', pageLabels[page] || t('checking'));
  text('#export-location', state.settings?.export_roots?.join('\n') || t('notSet'));
  text(
    '#input-location',
    state.settings?.input_roots?.length
      ? t('inputFolders', state.settings.input_roots.length)
      : t('inputFoldersNone'),
  );
  text('#profile-location', state.settings?.profile || t('profileLocal'));
  text('#app-version', state.settings?.version || '');
  text('#control-label', manual ? t('controlManual') : t('controlAutomation'));
  text('#browser-message', state.busy ? t('browserBusy') : t('browserPreparing'));
  text('#browser-description', state.busy ? t('browserBusyDescription') : t('browserDescription'));
  text(
    '#browser-hint',
    manual ? t('browserManualHint') : state.busy ? t('browserBusyHint') : t('browserHint'),
  );
  renderHistory(state.recent_jobs || []);
  void reportViewport();
}
async function update() {
  if (refreshing) return;
  refreshing = true;
  try {
    render(await window.bridge.status());
  } catch {
    text('#status', t('appUnavailable'));
    tone('#status', 'error');
    showError(t('statusReadFailed'));
  } finally {
    refreshing = false;
  }
}
document.querySelectorAll('[data-surface]').forEach((button) =>
  button.addEventListener('click', async () => {
    try {
      await window.bridge.surface(button.dataset.surface);
      setSurface(button.dataset.surface);
      await update();
    } catch {
      showError(t('surfaceFailed'));
    }
  }),
);
document.querySelectorAll('[data-language]').forEach((button) =>
  button.addEventListener('click', async () => {
    try {
      setLanguage((await window.bridge.language(button.dataset.language)).language);
      await update();
    } catch {
      showError(t('languageFailed'));
    }
  }),
);
document.querySelectorAll('[data-action]').forEach((button) =>
  button.addEventListener('click', async () => {
    if (pendingAction) return;
    pendingAction = true;
    if (latest) render(latest);
    try {
      await window.bridge.action(button.dataset.action, displayed);
      $('#action-error').hidden = true;
      if (button.dataset.action === 'copy-mcp-token') toast(t('tokenCopied'));
    } catch {
      showError(t('actionFailed'));
    } finally {
      pendingAction = false;
      await update();
    }
  }),
);
window.bridge.onSurface(setSurface);
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-setup]');
  if (!button || button.disabled || setupPending) return;
  setupPending = true;
  text(
    '#setup-feedback',
    ['connect', 'replace-skill'].includes(button.dataset.setup) ? t('installing') : t('applying'),
  );
  if (latest) renderSetup(latest);
  try {
    const result = await window.bridge.setup(
      button.dataset.setup,
      button.dataset.index === undefined ? undefined : Number(button.dataset.index),
    );
    $('#action-error').hidden = true;
    const message = result?.canceled
      ? ''
      : result?.copied
        ? t('exampleCopied')
        : result?.retired
          ? t('shadowRetired')
          : result?.verified
            ? t('verified')
            : result?.registered
              ? t('registered')
              : button.dataset.setup === 'disconnect'
                ? result?.restored_skill
                  ? t('disconnectedRestored')
                  : t('disconnected')
                : t('foldersSaved');
    text('#setup-feedback', message);
    if (message) toast(message);
  } catch (error) {
    const errors = t('setupErrors');
    const code = Object.keys(errors).find((code) => error.message?.includes(code));
    const message = code ? errors[code] : t('setupFailed');
    text('#setup-feedback', message);
    showError(message);
  } finally {
    setupPending = false;
    await update();
  }
});
new ResizeObserver(() => {
  void reportViewport();
}).observe($('#browser-viewport'));
applyStaticText();
setInterval(update, 1000);
void update();
