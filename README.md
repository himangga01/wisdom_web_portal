# 지혜 웹 포털

지혜행정사사무소 운영 포털의 npm 워크스페이스입니다. 운영 애플리케이션은 `apps/site`, `apps/control`, 공용 계약과 토큰은 `packages/shared`에 둡니다. `prototypes/homepage-motion`은 승인된 시각·모션 참고본이며 운영 워크스페이스와 분리해 동결 상태로 유지합니다.

## 요구 환경

- Node.js 24 (`.nvmrc`, `.node-version`)
- npm 12
- Docker 없이 실행 가능한 로컬 환경

## 설치와 검증

Windows PowerShell에서는 실행 정책에 막히는 `npm.ps1` 대신 `npm.cmd`를 사용합니다.

```powershell
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run test:e2e
npm.cmd run verify
```

macOS에서는 일반 `npm` 명령을 사용합니다.

```sh
npm install
npm run build
npm test
npm run test:e2e
npm run verify
```

루트 명령은 `apps/*`와 `packages/*`의 같은 이름 스크립트를 실행하며, 아직 해당 스크립트가 없는 워크스페이스는 건너뜁니다. `verify`는 타입 검사, 단위 테스트, 빌드, E2E 테스트 순서로 전체 운영 워크스페이스를 확인합니다.

## 환경 설정

`.env.example`을 로컬 `.env`로 복사한 뒤 실제 값을 설정합니다. 애플리케이션은 `.env`를 로드한 다음 `@wisdom/shared`의 `parseEnvironment`에 전달해야 합니다.

- 운영 환경의 세 비밀값은 각각 32자 이상이어야 하며 하나라도 없으면 파싱이 실패합니다.
- 운영 환경은 인메모리 데이터베이스를 사용할 수 없습니다.
- `NODE_ENV=test`에서만 격리된 인메모리 데이터베이스와 테스트 전용 비밀값을 기본 제공하며 운영에는 재사용되지 않습니다.
- 이메일 본문 모드는 기본적으로 `receipt-only`입니다. `full-inquiry`는 별도 운영 승인 후 명시적으로 설정합니다.
- 실제 비밀값, 상담 요청 본문, 원문 연락처를 Git이나 로그에 남기지 않습니다.

## 공용 패키지

`packages/shared`는 다음 내용을 단일 진입점으로 제공합니다.

- 출시 언어, 상담 분류·상태·연락 방식 계약
- 개인정보·마케팅 동의와 상담 요청 Zod 스키마
- 상담 접수 응답과 API 오류 계약
- 알림 채널·이메일 본문 모드·글 상태 계약
- bronze/sand/ivory 디자인 토큰과 승인된 홈페이지 리빌 수치
- 운영 비밀값을 누락 허용하지 않는 환경 파서

상담 요청의 전체 HTTP 본문 크기 제한과 저장·암호화는 Task 3에서 서버 경계에 추가합니다.
