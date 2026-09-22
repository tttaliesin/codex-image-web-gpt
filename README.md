<p align="center">
  <img src="apps/desktop/ui/icon.svg" width="72" height="72" alt="">
</p>

<h1 align="center">Web Image Bridge</h1>

<p align="center"><strong>요청은 Codex에서, 생성은 ChatGPT에서, 결과는 원본으로</strong></p>
<p align="center">로그인한 ChatGPT 웹과 프로젝트 폴더를 잇는 Windows 이미지 작업실</p>

<p align="center">
  <a href="https://github.com/tttaliesin/codex-image-web-gpt/releases/latest">Windows 다운로드</a> ·
  <a href="#getting-started">설치와 첫 이미지</a> ·
  <a href="#workflow">화면과 동작</a> ·
  <a href="#development">개발 안내</a>
</p>

![Web Image Bridge 작업 공간 — 요청 수신 상태, ChatGPT 연결, 생성 단계와 최근 작업을 보여 주는 데스크톱 화면](assets/readme/workspace.png)

<p align="center"><sub>Windows 11 x64 · 전용 로그인 세션 · 로컬 MCP · 트레이 상주</sub></p>

Codex에 이미지 생성·편집을 요청하면 ChatGPT 웹에서 실행하고, 다운로드한 원본을 프로젝트 폴더에 저장하는 앱

별도 이미지 API 키 없이 사용자의 ChatGPT 웹 세션으로 실행하며, 프롬프트 작성과 결과 검수는 Codex가 담당

## 요청 하나에서 원본 파일까지

**Codex에서 요청 → ChatGPT 웹에서 생성·편집 → 원본 다운로드 → 허용 폴더에 저장**

두 참고 이미지를 하나의 장면으로 합치는 요청 예시

파일 경로는 실제 이미지의 절대 경로로 바꾸고, 앱에서 입력 폴더와 저장 폴더 선택

```text
Web Image Bridge로 아래 두 이미지를 하나의 장면으로 합쳐줘.

1. C:/Images/subject.png — 주인공의 외형 참고
2. C:/Images/room.jpg — 배경과 구도 참고

첫 번째 이미지의 주인공을 두 번째 이미지의 공간에 자연스럽게 배치해줘.
결과 원본은 프로젝트 outputs 폴더에 저장해줘.
```

결과를 확인한 뒤, 같은 Codex 작업에서 이어지는 편집

```text
방금 결과에서 배경 조명만 차가운 푸른색으로 바꿔줘.
주인공의 외형과 배치는 그대로 유지해줘.
```

같은 대화와 이전 결과를 연결해 편집하고, 완료 후 Codex가 제시한 경로에서 실제 다운로드 원본 확인

<a id="getting-started"></a>

## 시작하기

**준비물:** Windows 11 x64·Codex·이미지 생성이 가능한 ChatGPT 계정

### 1. 압축 풀고 앱 열기

[최신 릴리즈](https://github.com/tttaliesin/codex-image-web-gpt/releases/latest)의 Windows x64 ZIP을 내려받아 압축 해제

압축을 푼 폴더의 **`WebImageBridge.exe` 더블클릭**

ZIP에 실행에 필요한 런타임 포함 — 터미널 명령·Node·pnpm·mise 별도 설치 불필요

### 2. 앱에서 세 단계 완료

![앱 시작 안내 — 폴더 선택, ChatGPT 로그인, Codex 연결을 한 화면에서 진행하는 로컬 테스트 화면](assets/readme/setup.png)

1. **저장 폴더 선택** — 생성한 원본을 저장할 위치 선택, 참고 이미지를 쓸 경우 **입력 폴더 추가**
2. **로그인 페이지 열기** — 앱 안의 ChatGPT에서 로그인, 이미 로그인되어 있으면 그대로 사용
3. **Codex에 연결** — 앱 설치·연결 설정·이미지 스킬 등록·로컬 연결 검사를 한 번에 실행

완료 후 바탕화면의 **Web Image Bridge** 바로가기로 실행 가능

기존 Codex 설정은 백업하고 로그인·모델 등 다른 설정은 유지

기존 동명 스킬·서버 설정과 충돌하면 앱에 안내 표시, 관련 없는 파일 덮어쓰기 없이 중단

### 3. 첫 이미지 요청

**Codex를 한 번 다시 시작**한 뒤 앱의 **첫 요청 복사** 버튼으로 요청을 복사해 Codex에 붙여넣기

선택한 저장 폴더가 포함된 요청 예시

```text
Web Image Bridge로 흰 배경 위의 작은 도자기 화병을 그려줘.
결과 원본을 C:/Images/outputs 폴더에 저장해줘.
```

앱의 작업 완료 상태와 Codex가 제시한 원본 파일 경로 확인

<details>
<summary>폴더 변경·업데이트·연결 해제</summary>

**폴더 변경:** 앱의 **설정**에서 입력 폴더 추가·제거와 저장 폴더 변경

진행 중이거나 대기 중인 작업이 없을 때 즉시 적용

**업데이트:** 트레이에서 기존 앱을 종료하고 새 ZIP의 `WebImageBridge.exe` 실행 후 **앱 업데이트** 클릭

로그인·작업 기록·폴더 설정·원본은 유지하며 바탕화면 바로가기도 새 버전으로 갱신

**연결 해제:** 앱의 **설정 → 연결 해제** 클릭

개인 스킬은 설치 폴더의 백업으로 이동하고 로그인·작업 기록·원본은 유지

설치 스킬이 바뀐 업데이트는 앱 안내에 따라 연결 해제 후 다시 연결하고 Codex 재시작

직전 버전으로 되돌릴 때만 패키지 폴더의 PowerShell에서 실행

```powershell
# 직전 버전으로 되돌리기 — 실행 후 앱 재시작
./setup.ps1 -Action rollback

```

수동 설치가 필요한 환경에서는 `setup.ps1`과 [설정 예제](examples/mcp-config.example.json) 사용 가능

</details>

<a id="workflow"></a>

## 화면과 동작

**진행 상태와 대기열을 한곳에서 확인**

요청 준비·이미지 생성·원본 저장의 진행 단계와 최근 작업 표시

새 작업 시작을 일시정지하면 접수된 요청을 대기열에 보관하고, 재개 시 순서대로 처리

![새 작업 시작을 일시정지한 작업 공간 — 대기 중인 이미지 생성 요청 2건과 재개·중단 제어 표시](assets/readme/queue.png)

스크린샷은 로컬 테스트 데이터를 사용한 실제 앱 UI — 로그인 표시·폴더 경로·작업 정보도 테스트 데이터

- **창을 숨겨도 이어지는 작업** — 트레이에서 실행을 유지하고, Codex 연결이 끊겨도 접수한 작업 보존
- **필요할 때 직접 조작** — ChatGPT 페이지를 열어 로그인·사람 확인을 진행하고 자동화에 조작권 반환
- **기존 결과에서 복구** — 다운로드 실패 시 기존 응답의 파일을 다시 회수하고, 내보내기 실패 시 보관한 원본을 다시 복사
- **중복 생성 방지** — 제출 여부가 불명확하면 기존 대화와 기록을 확인하고 자동 재전송 차단

로그인 세션·작업 기록·원본은 이 컴퓨터에 보관하고, 입력·내보내기는 사용자가 허용한 폴더로 제한

창의 X 버튼은 트레이로 숨기기, 완전 종료는 트레이 메뉴의 종료 항목 사용

<a id="development"></a>

## 개발

소스에서 실행·빌드하려면 mise를 추가로 준비하고, 프로젝트 루트의 PowerShell에서 고정 도구와 의존성 설치

```powershell
./scripts/mise.ps1 trust mise.toml
./scripts/mise.ps1 install --locked
./scripts/mise.ps1 run sync
./scripts/mise.ps1 run dev:fixture
```

`dev:fixture`는 계정 없이 화면과 동작을 확인하는 로컬 테스트 모드

| 명령 | 용도 |
| --- | --- |
| `./scripts/mise.ps1 run check` | 타입·포맷·단위 검사와 빌드 |
| `./scripts/mise.ps1 run test:integration` | 로컬 Electron 동작 검사 |
| `./scripts/mise.ps1 run test:recovery` | 프로세스 종료·재시작 복구 검사 |
| `./scripts/mise.ps1 run check:public` | Git 공개 대상의 로컬 상태·인증 정보 포함 여부 검사 |
| `./scripts/mise.ps1 run package:windows` | Windows 설치 ZIP 생성 |

빌드 결과는 `.local/releases`, 최신 패키지 경로는 `.local/latest-package.json`에 저장

직접 만든 패키지도 압축을 풀고 `WebImageBridge.exe`로 같은 시작 절차 진행

Windows 패키징은 Windows의 .NET Framework 4.x 컴파일러로 콘솔 없는 시작 실행 파일을 빌드하는 구성
컴파일러는 `%WINDIR%/Microsoft.NET/Framework64/v4.0.30319/csc.exe`에서 확인하며 추가 .NET SDK 설치는 불필요

[MCP 계약](packages/contracts/schema.json)은 런타임 검증과 타입 생성의 단일 입력

계약 수정 후 `./scripts/mise.ps1 exec pnpm run contracts:generate`로 타입을 갱신하고 `run check` 실행

## 검증 범위

한국어 ChatGPT UI에서 실제 이미지 생성·같은 대화의 후속 편집·원본 다운로드 확인

로컬 Electron 동작·폴더 선택과 권한 변경·Codex 등록과 해제·프로세스 복구·설치본 실행·MCP 연결 검사 수행

- 일반 Codex·Full harness의 전체 생성 왕복은 추가 검증 범위
- ChatGPT UI 변경과 계정·언어 차이에 따라 어댑터 조정이 필요할 수 있는 구성
- Windows x64 이외 플랫폼·코드 서명·MSI·자동 업데이트는 미제공

프로젝트 소스의 공개 라이선스는 아직 미지정
