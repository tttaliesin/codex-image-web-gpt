import path from 'node:path';
import { readFileSync } from 'node:fs';
import { durableJson } from '../../../packages/storage/src/files';

// Main-process text: tray menu and native dialogs. The page has its own copy in ui/i18n.js.
const ko = {
  openWindow: '창 열기',
  hideWindow: '창 숨기기',
  quitApp: '앱 종료',
  trayStatus: (phase: string, waiting: number) => `${phase} · 대기 ${waiting}건`,
  trayAttention: ' · 확인 필요',
  trayPaused: ' · 새 작업 정지',
  trayDraining: ' · 완료 후 종료',
  resumeQueue: '새 작업 시작 재개',
  pauseQueue: '새 작업 시작 일시정지',
  quitAfter: '현재 작업 완료 후 종료',
  quitNow: '기록 저장 후 즉시 종료',
  pickInputTitle: '참고 이미지를 가져올 폴더',
  pickOutputTitle: '이미지를 저장할 폴더',
  requestFilter: '승인된 M0 요청',
  firstRequest: (output: string) =>
    `Web Image Bridge로 흰 배경 위의 작은 도자기 화병을 그려줘. 결과 원본을 ${output} 폴더에 저장해줘.`,
  cancel: '취소',
  replaceSkillConfirm: '백업 후 연결',
  replaceSkillTitle: '기존 imagegen 스킬 백업',
  replaceSkillMessage: '기존 imagegen 스킬을 백업하고 Web Image Bridge 스킬로 연결할까요?',
  replaceSkillDetail: (folder: string) =>
    `${folder}\n\n이 폴더는 앱 설치 폴더의 backups로 옮겨지고, 연결을 해제하면 원래 위치로 되돌아갑니다.`,
  retireShadowConfirm: '이름 바꾸기',
  retireShadowTitle: 'Codex의 이전 설치본 정리',
  retireShadowMessage: 'Codex 앱 전용 저장소에 남은 이전 설치본의 이름을 바꿀까요?',
  retireShadowDetail: (folders: string) =>
    `${folders}\n\n지우지 않고 이름만 바꿉니다. 이후 Codex에서 새 대화를 시작하면 현재 설치본으로 연결됩니다.`,
  releaseRemoteConfirm: '잠금 해제',
  releaseRemoteTitle: '웹 생성 종료 확인',
  releaseRemoteMessage: '중단한 작업의 웹 생성이 끝났는지 확인했나요?',
  releaseRemoteDetail:
    'ChatGPT 페이지에서 이 요청이 전송되지 않았거나 생성이 끝난 것을 직접 확인한 경우에만 해제하세요. 해제하면 대기 중인 다음 작업이 시작됩니다.',
  startFailedTitle: 'Web Image Bridge를 시작하지 못했습니다',
  startFailedDetail: (code: string) =>
    `오류 코드: ${code}\n앱을 다시 실행해 주세요. 계속 실패하면 이 오류 코드를 알려 주세요.`,
};
const en: typeof ko = {
  openWindow: 'Open window',
  hideWindow: 'Hide window',
  quitApp: 'Quit app',
  trayStatus: (phase, waiting) => `${phase} · ${waiting} waiting`,
  trayAttention: ' · Needs attention',
  trayPaused: ' · New jobs paused',
  trayDraining: ' · Quitting when done',
  resumeQueue: 'Resume new jobs',
  pauseQueue: 'Pause new jobs',
  quitAfter: 'Quit after the current job',
  quitNow: 'Save records and quit now',
  pickInputTitle: 'Folder to take reference images from',
  pickOutputTitle: 'Folder to save images in',
  requestFilter: 'Approved M0 request',
  firstRequest: (output) =>
    `Draw a small ceramic vase on a white background with Web Image Bridge. Save the original to the ${output} folder.`,
  cancel: 'Cancel',
  replaceSkillConfirm: 'Back up and connect',
  replaceSkillTitle: 'Back up existing imagegen skill',
  replaceSkillMessage:
    'Back up the existing imagegen skill and connect with the Web Image Bridge skill?',
  replaceSkillDetail: (folder) =>
    `${folder}\n\nThis folder moves to backups in the app install folder and returns to its place when you disconnect.`,
  retireShadowConfirm: 'Rename',
  retireShadowTitle: 'Clean up old install in Codex',
  retireShadowMessage: 'Rename the old install left in the Codex app’s private storage?',
  retireShadowDetail: (folders) =>
    `${folders}\n\nIt is renamed, not deleted. Start a new conversation in Codex afterwards to connect to the current install.`,
  releaseRemoteConfirm: 'Release lock',
  releaseRemoteTitle: 'Confirm web generation ended',
  releaseRemoteMessage: 'Did you confirm that web generation for the stopped job has ended?',
  releaseRemoteDetail:
    'Release only after checking on the ChatGPT page that this request was not sent or its generation has finished. The next waiting job starts once released.',
  startFailedTitle: 'Web Image Bridge could not start',
  startFailedDetail: (code) =>
    `Error code: ${code}\nStart the app again. If it keeps failing, share this error code.`,
};
const messages = { ko, en };
export type Language = keyof typeof messages;
export const isLanguage = (value: unknown): value is Language => value === 'ko' || value === 'en';

let current: Language = 'ko';
export const language = () => current;
export const t = () => messages[current];

// The choice lives with the profile so an update or reinstall keeps it.
const preferencesFile = (profile: string) => path.join(profile, 'preferences.json');
function readPreferences(profile: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(preferencesFile(profile), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
export function loadLanguage(profile: string, fallback: Language) {
  const saved = readPreferences(profile).language;
  current = isLanguage(saved) ? saved : fallback;
  return current;
}
export async function saveLanguage(profile: string, value: unknown) {
  if (!isLanguage(value)) throw Error('INPUT_INVALID');
  await durableJson(preferencesFile(profile), { ...readPreferences(profile), language: value });
  current = value;
  return current;
}
