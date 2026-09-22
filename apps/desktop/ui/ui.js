const labels = {
  ready: '준비됨',
  prepare: '요청 준비 중',
  attach: '이미지 첨부 중',
  submit: '전송 확인 중',
  generate: '이미지 생성 중',
  download: '원본 저장 중',
  complete: '저장 완료',
  queued: '대기 중',
  running: '진행 중',
  waiting_user: '확인 필요',
  reconciling: '기존 결과 확인 중',
  unknown: '제출 확인 필요',
  succeeded: '완료',
  partial: '일부 완료',
  failed: '실패',
  canceled: '중단됨',
  AUTH_REQUIRED: '로그인 필요',
  HUMAN_CHECK_REQUIRED: '직접 확인 필요',
  ADAPTER_UNAVAILABLE: '연결 복구 필요',
  OS_SUSPENDED: '절전으로 보류',
  NETWORK_OFFLINE: '네트워크 대기',
  STATE_CONFLICT: '상태 확인 필요',
  UI_CHANGED: '페이지 확인 필요',
  SUBMISSION_UNKNOWN: '제출 확인 필요',
  DOWNLOAD_FAILED: '저장 재개 필요',
  PAGE_LOAD_FAILED: '페이지 연결 실패',
  MCP_TOKEN_COPIED: '인증 토큰 복사됨',
  MCP_NOT_ENABLED: 'Codex 연결 설정 필요',
  MCP_VALIDATION_FAILED: '요청 확인 필요',
};
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

function setSurface(value) {
  surface = value;
  for (const name of ['workspace', 'browser', 'settings'])
    $(`#${name}-panel`).hidden = name !== value;
  document.querySelectorAll('.nav-item[data-surface]').forEach((button) => {
    button.classList.toggle('active', button.dataset.surface === value);
    if (button.dataset.surface === value) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  text('#breadcrumb', { workspace: '작업 공간', browser: 'ChatGPT', settings: '설정' }[value]);
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
  text('#history-count', jobs.length ? `최근 ${jobs.length}개` : '');
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
    title.textContent = job.mode === 'edit' ? '이미지 편집' : '이미지 생성';
    const meta = document.createElement('div');
    meta.className = 'job-meta';
    const date = new Date(job.created_at);
    meta.textContent = `${Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)} · ${job.job_id.slice(0, 8)}`;
    copy.append(title, meta);
    const state = document.createElement('span');
    state.className = 'job-state';
    state.dataset.tone = jobTone(job);
    state.textContent = labels[job.state] || '상태 확인 중';
    const files = document.createElement('span');
    files.className = 'job-files';
    files.textContent = job.artifact_count ? `원본 ${job.artifact_count}개` : '—';
    row.append(icon, copy, state, files);
    $('#job-list').append(row);
  }
}
function render(state) {
  latest = state;
  displayed = state.operations;
  const ops = state.operations,
    job = ops?.job,
    manual = ops?.session?.control_owner === 'manual';
  const page = state.page_status || 'loading',
    pageLabels = {
      loading: '확인 중',
      ready: '로그인됨',
      login: '로그인 필요',
      challenge: '직접 확인 필요',
      unavailable: '연결 확인 필요',
    };
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
  for (const action of ['reconcile', 'resume-job', 'cancel'])
    $(`[data-action="${action}"]`).hidden = !enabled[action];
  $('#operations').hidden = !ops;
  $('#legacy-controls').hidden = state.web_execution;
  text(
    '#queue',
    ops
      ? `대기 ${ops.waiting_count}건 · ${ops.paused ? '일시정지 · ' : ''}${manual ? '직접 조작 중' : '자동화 조작권'}`
      : '',
  );
  let heading = '다음 이미지를 기다리고 있어요';
  let notice = 'Codex에 이미지 생성이나 편집을 요청하세요. 창을 숨겨도 작업은 계속됩니다.';
  let statusTone = state.busy ? 'warning' : jobTone(job);
  if (state.phase === 'AUTH_REQUIRED' || page === 'login') {
    heading = 'ChatGPT에 로그인해 주세요';
    notice = 'ChatGPT 페이지를 열어 로그인하면 같은 세션으로 이미지 작업을 이어갑니다.';
    statusTone = 'warning';
  } else if (state.phase === 'HUMAN_CHECK_REQUIRED' || page === 'challenge') {
    heading = '페이지에서 직접 확인해 주세요';
    notice = 'ChatGPT 페이지에 표시된 확인을 완료한 뒤 작업을 이어갈 수 있습니다.';
    statusTone = 'warning';
  } else if (ops?.draining) {
    heading = '작업을 마친 뒤 종료합니다';
    notice = '새 요청 접수를 닫았습니다. 현재 작업이 완료되면 앱이 종료됩니다.';
    statusTone = 'warning';
  } else if (job?.terminal && job.remote_may_continue) {
    heading = '기존 결과를 확인해 주세요';
    notice =
      '로컬 작업은 중단됐지만 웹 생성은 계속될 수 있습니다. 기존 결과를 확인한 뒤 이어갑니다.';
    statusTone = 'warning';
  } else if (manual) {
    heading = '직접 조작 중입니다';
    notice =
      'ChatGPT 페이지를 직접 사용할 수 있습니다. 완료하면 상단의 자동화에 반환을 눌러 주세요.';
    statusTone = 'warning';
  } else if (ops?.suspended) {
    heading = labels[ops.suspended] || '연결을 확인해 주세요';
    notice = '작업 기록을 보관하고 있습니다. 설정에서 연결 상태를 확인한 뒤 이어갈 수 있습니다.';
    statusTone = 'warning';
  } else if (ops?.paused && !state.busy && (!job || job.state === 'queued')) {
    heading = '새 작업 시작을 일시정지했어요';
    notice = '접수한 요청은 대기열에 보관됩니다. 새 작업 재개를 누르면 순서대로 이어갑니다.';
    statusTone = 'warning';
  } else if (job?.state === 'queued' && !state.busy) {
    heading = '작업이 시작되기를 기다리고 있어요';
    notice = '요청을 대기열에 보관했습니다. 앞선 작업과 필요한 확인이 끝나면 이어서 시작합니다.';
  } else if (job?.requires_action || job?.state === 'failed') {
    heading =
      job?.state === 'failed' ? '작업을 완료하지 못했어요' : '작업을 이어가려면 확인이 필요해요';
    notice = `${labels[job.error?.code] || '현재 페이지와 작업 상태를 확인해 주세요.'} · 기존 결과 확인 또는 ChatGPT 페이지에서 상태를 확인하세요.`;
    statusTone = jobTone(job);
  } else if (state.busy || (job && !job.terminal)) {
    heading = labels[job?.phase || state.phase] || '작업을 진행하고 있어요';
    notice = '이미지를 준비하고 원본을 저장합니다. 창을 숨겨도 진행 상황과 작업 기록이 유지됩니다.';
    statusTone = 'warning';
  } else if (job?.state === 'succeeded') {
    heading = '원본 이미지가 저장됐어요';
    notice =
      '최근 작업에서 저장 상태를 확인하세요. 같은 대화에서 Codex에 후속 편집을 요청할 수 있습니다.';
    statusTone = 'success';
  } else if (job?.state === 'partial') {
    heading = '일부 이미지가 저장됐어요';
    notice = '확보한 원본은 보관됐습니다. Codex에서 작업 결과와 누락된 출력을 확인하세요.';
    statusTone = 'warning';
  } else if (job?.state === 'canceled') {
    heading = '작업이 중단됐어요';
    notice = '작업 기록은 보관됩니다. 새로운 이미지 작업은 Codex에서 요청하세요.';
  } else if (!state.mcp_enabled) {
    heading = 'Codex 연결을 준비해 주세요';
    notice =
      '설정에서 연결 상태를 확인하세요. 요청 파일을 사용하는 경우 설정에서 파일을 열 수 있습니다.';
  } else if (ops?.paused) {
    heading = '새 작업 시작을 일시정지했어요';
    notice = '접수한 요청은 대기열에 보관됩니다. 새 작업 재개를 누르면 순서대로 이어갑니다.';
  }
  if (state.request && !state.web_execution)
    text(
      '#request-description',
      `요청 ${state.request.id} · 입력 이미지 ${state.request.input_count}개`,
    );
  text('#current-title', heading);
  text('#notice', notice);
  text(
    '#status',
    manual
      ? '직접 조작 중'
      : ops?.paused && !state.busy
        ? '일시정지'
        : labels[state.phase] || '상태 확인 필요',
  );
  tone('#status', statusTone);
  tone('#work-symbol', statusTone);
  text(
    '#work-state',
    job ? `${job.mode === 'edit' ? '편집' : '생성'} · ${job.job_id.slice(0, 8)}` : '대기 중',
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
  text('#mcp-summary', state.mcp_enabled ? '요청 수신 준비됨' : '설정 필요');
  tone('#mcp-summary', state.mcp_enabled ? 'success' : 'warning');
  text('#session-summary', pageLabels[page] || '확인 중');
  tone('#session-summary', pageTone);
  text('#waiting-summary', `${ops?.waiting_count ?? 0}개`);
  tone('#connection-dot', state.mcp_enabled ? 'success' : 'warning');
  tone('#browser-dot', pageTone);
  text('#connection-label', state.mcp_enabled ? 'Codex 요청 수신 준비' : 'Codex 연결 설정 필요');
  text(
    '#connection-caption',
    state.busy
      ? '백그라운드에서 작업 중'
      : ops?.paused
        ? '새 작업 일시정지'
        : '이 컴퓨터에서 실행 중',
  );
  text('#mcp-endpoint', state.settings?.mcp_endpoint || 'MCP 서버가 실행되지 않았습니다.');
  text('#login-setting', pageLabels[page] || '확인 중');
  text('#export-location', state.settings?.export_roots?.join('\n') || '설정되지 않음');
  text('#input-location', state.settings?.input_roots?.join('\n') || '설정되지 않음');
  text('#profile-location', state.settings?.profile || '이 컴퓨터에 보관');
  text('#app-version', state.settings?.version || '');
  text('#control-label', manual ? '직접 조작 중' : '자동화 조작권');
  text(
    '#browser-message',
    state.busy ? '이미지 작업을 진행하고 있어요' : 'ChatGPT 페이지를 준비하고 있어요',
  );
  text(
    '#browser-description',
    state.busy
      ? '작업 중에는 페이지 입력을 잠시 잠급니다. 진행 상황은 작업 공간에서 확인하세요.'
      : '같은 로그인 세션으로 연결합니다.',
  );
  text(
    '#browser-hint',
    manual
      ? '직접 확인을 마치면 상단에서 자동화에 반환해 주세요.'
      : state.busy
        ? '창을 숨겨도 이미지 생성과 원본 저장은 계속됩니다.'
        : '로그인과 직접 확인은 이 페이지에서 진행하세요.',
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
    text('#status', '앱 연결 확인 필요');
    tone('#status', 'error');
    showError('앱 상태를 읽지 못했습니다. 잠시 후 자동으로 다시 확인합니다.');
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
      showError('화면을 열지 못했습니다. 잠시 후 다시 시도해 주세요.');
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
      if (button.dataset.action === 'copy-mcp-token') toast('인증 토큰을 클립보드에 복사했습니다.');
    } catch {
      showError(
        '작업 상태가 바뀌었거나 현재 동작을 적용할 수 없습니다. 최신 상태를 확인해 주세요.',
      );
    } finally {
      pendingAction = false;
      await update();
    }
  }),
);
window.bridge.onSurface(setSurface);
new ResizeObserver(() => {
  void reportViewport();
}).observe($('#browser-viewport'));
setInterval(update, 1000);
void update();
