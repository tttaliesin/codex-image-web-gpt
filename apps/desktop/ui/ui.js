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
let setupPending = false,
  folderSignature = '';
const setupErrors = {
  SETUP_BUSY: '다른 설정을 적용하고 있어요. 완료 후 다시 눌러주세요.',
  STATE_CONFLICT: '진행 중이거나 대기 중인 작업이 있어요. 작업이 끝난 뒤 폴더를 변경해 주세요.',
  FOLDER_UNAVAILABLE: '사용할 수 없는 폴더예요. 이 컴퓨터에 있는 폴더를 다시 골라주세요.',
  FOLDER_LINK_REJECTED: '바로가기나 연결 폴더 대신 원본 폴더를 선택해 주세요.',
  AUTH_REQUIRED: 'ChatGPT 페이지에서 로그인한 뒤 다시 연결해 주세요.',
  MCP_NOT_ENABLED: '앱 연결을 준비하고 있어요. 잠시 후 다시 시도해 주세요.',
  OUTPUT_FOLDER_REQUIRED: '먼저 결과를 저장할 폴더를 골라주세요.',
  PACKAGED_APP_REQUIRED: 'Codex 연결은 다운로드한 배포 앱에서 사용할 수 있어요.',
  EXISTING_SKILL_CONFLICT:
    '기존 imagegen 스킬과 충돌해요. 기존 파일은 보존했습니다. 사용 중인 스킬을 확인해 주세요.',
  EXISTING_CONFIG_CONFLICT: '기존 Codex 연결 설정과 충돌해요. 기존 설정을 변경하지 않았습니다.',
  INSTALLED_SKILL_CHANGED: '설치 후 수정된 스킬이 있어요. 수정한 내용은 보존했습니다.',
  SKILL_UPDATE_REQUIRES_UNREGISTER:
    '이전 스킬을 갱신하려면 설정에서 연결 해제 후 다시 연결해 주세요. 기존 스킬은 백업됩니다.',
  CONFIG_MANAGED_BLOCK_CHANGED: 'Codex 설정이 설치 후 변경됐어요. 현재 설정을 보존했습니다.',
  CONFIG_MANAGED_BLOCK_MISSING:
    'Codex의 연결 설정을 찾지 못했어요. 기존 등록 정보를 확인해 주세요.',
  CODEX_NOT_REGISTERED: '먼저 Codex에 연결 버튼으로 설정을 등록해 주세요.',
  MCP_CHECK_FAILED: '로컬 연결을 확인하지 못했어요. 앱을 다시 연 뒤 연결 확인을 눌러주세요.',
  INTEGRATION_TARGET_CONFLICT:
    '기존 설치 위치와 설정이 달라요. 바탕화면 바로가기로 앱을 다시 열어주세요.',
};

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
    folders
      ? `저장 위치 · ${state.settings.export_roots[0]}`
      : '결과를 저장할 폴더를 골라주세요. 참고 이미지 폴더는 나중에 추가해도 돼요.',
  );
  text(
    '#setup-login-hint',
    login
      ? '이 앱의 ChatGPT 세션에 로그인되어 있어요.'
      : '이 앱의 ChatGPT 페이지에서 한 번 로그인하세요.',
  );
  text(
    '#setup-codex-hint',
    !setup.available
      ? '소스 실행 중입니다. Codex 연결은 배포 앱에서 진행하세요.'
      : connected
        ? '설정 등록과 로컬 연결 확인이 끝났어요. Codex를 한 번 다시 시작해 주세요.'
        : setup.registered
          ? '설정이 등록됐어요. 연결 확인을 눌러 사용할 준비가 됐는지 확인하세요.'
          : '연결 설정과 이미지 스킬을 설치하고 원래 설정을 백업합니다.',
  );
  text(
    '#integration-setting',
    setup.error
      ? setupErrors[setup.error] || '연결 설정 확인이 필요해요.'
      : connected
        ? '설정 등록됨 · 로컬 연결 확인 완료'
        : setup.registered
          ? '설정 등록됨 · 연결 확인 필요'
          : '아직 Codex에 등록되지 않았어요.',
  );
  $('#setup-ready').hidden = !completed.every(Boolean);
  const allowed = {
    'pick-input': state.mcp_enabled && !state.busy,
    'pick-output': state.mcp_enabled && !state.busy,
    'remove-input': state.mcp_enabled && !state.busy,
    connect: setup.available && folders && login && state.mcp_enabled,
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
      const label = document.createElement('span');
      label.textContent = folder;
      const remove = document.createElement('button');
      remove.className = 'button quiet';
      remove.dataset.setup = 'remove-input';
      remove.dataset.index = String(index);
      remove.textContent = '제거';
      remove.setAttribute('aria-label', `${folder} 입력 권한 제거`);
      row.append(label, remove);
      $('#input-folders').append(row);
    });
  }
  document.querySelectorAll('[data-setup]').forEach((button) => {
    const action = button.dataset.setup;
    button.disabled = setupPending || setup.working || !allowed[action];
    if (action === 'disconnect') button.hidden = !setup.registered && !setup.error;
    if (action === 'connect') {
      button.hidden = setup.registered && !setup.update_available;
      button.textContent = setup.update_available ? '앱 업데이트' : 'Codex에 연결';
    }
    if (action === 'check') button.hidden = !setup.registered;
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
  renderSetup(state);
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
  const codexReady = state.mcp_enabled && (!state.setup || state.setup.registered);
  text('#mcp-summary', codexReady ? '설정 등록됨' : '연결 필요');
  tone('#mcp-summary', codexReady ? 'success' : 'warning');
  text('#session-summary', pageLabels[page] || '확인 중');
  tone('#session-summary', pageTone);
  text('#waiting-summary', `${ops?.waiting_count ?? 0}개`);
  tone('#connection-dot', codexReady ? 'success' : 'warning');
  tone('#browser-dot', pageTone);
  text('#connection-label', codexReady ? 'Codex 설정 등록됨' : 'Codex 연결 설정 필요');
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
  text(
    '#input-location',
    state.settings?.input_roots?.length
      ? `폴더 ${state.settings.input_roots.length}개 허용`
      : '참고 이미지를 사용할 폴더를 추가하세요.',
  );
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
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-setup]');
  if (!button || button.disabled || setupPending) return;
  setupPending = true;
  text(
    '#setup-feedback',
    button.dataset.setup === 'connect'
      ? '앱을 설치하고 Codex 연결 설정을 등록하고 있어요…'
      : '설정을 적용하고 있어요…',
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
        ? '첫 요청을 복사했어요. Codex에 붙여넣어 주세요.'
        : result?.verified
          ? '설정과 로컬 연결을 확인했어요. Codex를 다시 시작하면 사용할 수 있어요.'
          : result?.registered
            ? 'Codex 연결 설정을 등록했어요. Codex를 한 번 다시 시작해 주세요.'
            : button.dataset.setup === 'disconnect'
              ? '연결을 해제했어요. 로그인과 작업 기록은 보존됐습니다.'
              : '폴더 설정을 저장했어요. 바로 적용됩니다.';
    text('#setup-feedback', message);
    if (message) toast(message);
  } catch (error) {
    const code = Object.keys(setupErrors).find((code) => error.message?.includes(code));
    const message = code
      ? setupErrors[code]
      : '설정을 마치지 못했어요. 현재 연결 상태를 확인하고 다시 시도해 주세요.';
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
setInterval(update, 1000);
void update();
