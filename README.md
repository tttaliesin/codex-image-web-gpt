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

파일 경로는 실제 이미지의 절대 경로로 바꾸고, 입력 폴더와 `outputs`를 설치 시 허용 폴더로 등록

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

**준비물:** Windows 11 x64·PowerShell 7·Codex·이미지 생성이 가능한 ChatGPT 계정

### 1. Windows ZIP 다운로드

[최신 릴리즈](https://github.com/tttaliesin/codex-image-web-gpt/releases/latest)에서 `web-image-bridge-0.1.0-windows-x64.zip`을 내려받아 압축 해제

`setup.ps1`이 있는 폴더의 PowerShell에서 다음 단계 진행

ZIP에 Electron 런타임 포함 — Node·pnpm·mise 별도 설치 불필요

### 2. 허용 폴더 설정과 설치

아래 예시의 입력 폴더를 실제 이미지 폴더의 절대 경로로 변경하고 실행

아래 예시의 내보내기 위치는 압축을 푼 폴더 아래 `outputs`, 프로젝트에서 사용할 경우 `export_roots`를 해당 프로젝트의 출력 폴더로 변경

설정 형식은 [설정 예제](examples/mcp-config.example.json) 참조

```powershell
New-Item -ItemType Directory -Path outputs -Force | Out-Null
$bridgeConfig = @{
  input_roots = @((Join-Path $env:USERPROFILE 'Pictures'))
  export_roots = @((Join-Path (Get-Location).Path 'outputs'))
  port = 43179
  web_execution = $true
}
$bridgeConfig | ConvertTo-Json | Set-Content ./mcp-config.json -Encoding utf8
./setup.ps1 -Action install -McpConfig (Resolve-Path ./mcp-config.json).Path
& "$env:LOCALAPPDATA/WebImageBridge/launch.ps1"
```

앱의 ChatGPT 페이지에서 로그인 후 작업 공간의 **요청 수신 준비됨**과 **로그인됨** 표시 확인

### 3. Codex 연결과 첫 요청

같은 PowerShell에서 개인 `imagegen` 스킬과 로컬 MCP 등록

```powershell
./setup.ps1 -Action register
```

등록 시 Codex 설정에 `web_image_bridge`와 인증 도우미를 추가하고, 번들 `imagegen` 스킬을 설정에서 비활성화

변경 전 설정은 설치 폴더에 백업하고, 기존 동명 스킬·서버 설정과 충돌하면 중단

Codex의 MCP 서버 또는 Codex 앱을 재시작한 뒤 첫 이미지 요청

```text
Web Image Bridge로 흰 배경 위의 작은 도자기 화병을 그려줘.
완료되면 원본 파일을 보여줘.
```

앱의 작업 완료 상태와 Codex가 제시한 원본 파일 경로 확인

<details>
<summary>업데이트·되돌리기·연결 해제</summary>

새 빌드의 `setup.ps1 -Action install`로 실행 버전을 전환하고 트레이에서 앱 종료 후 다시 실행

로그인 프로필·작업 기록·기존 설정·원본은 보존하며, 허용 폴더 변경은 `%LOCALAPPDATA%/WebImageBridge/mcp-config.json`에서 직접 편집

패키지 폴더의 PowerShell에서 필요한 명령만 실행

```powershell
# 직전 버전으로 되돌리기 — 실행 후 앱 재시작
./setup.ps1 -Action rollback

# 이 설치의 Codex 연결과 스킬 등록 해제
./setup.ps1 -Action unregister
```

연결 해제 시 개인 스킬은 설치 폴더의 백업으로 이동하고, 로그인·작업 기록·원본은 유지

설치 스킬의 내용이 바뀐 업데이트는 `unregister` 후 `register`로 다시 등록하고 Codex 재시작

</details>

<a id="workflow"></a>

## 화면과 동작

**진행 상태와 대기열을 한곳에서 확인**

요청 준비·이미지 생성·원본 저장의 진행 단계와 최근 작업 표시

새 작업 시작을 일시정지하면 접수된 요청을 대기열에 보관하고, 재개 시 순서대로 처리

![새 작업 시작을 일시정지한 작업 공간 — 대기 중인 이미지 생성 요청 2건과 재개·중단 제어 표시](assets/readme/queue.png)

두 스크린샷은 로컬 테스트 데이터를 사용한 실제 앱 UI — 로그인 표시와 작업 정보도 테스트 데이터

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

직접 만든 패키지도 해당 폴더의 `setup.ps1`로 같은 설치 절차 진행

[MCP 계약](packages/contracts/schema.json)은 런타임 검증과 타입 생성의 단일 입력

계약 수정 후 `./scripts/mise.ps1 exec pnpm run contracts:generate`로 타입을 갱신하고 `run check` 실행

## 검증 범위

한국어 ChatGPT UI에서 실제 이미지 생성·같은 대화의 후속 편집·원본 다운로드 확인

로컬 Electron 동작·프로세스 복구·설치본 실행·MCP 연결 검사 수행

- 일반 Codex·Full harness의 전체 생성 왕복은 추가 검증 범위
- ChatGPT UI 변경과 계정·언어 차이에 따라 어댑터 조정이 필요할 수 있는 구성
- Windows x64 이외 플랫폼·코드 서명·MSI·자동 업데이트는 미제공

프로젝트 소스의 공개 라이선스는 아직 미지정
