# 지혜행정사사무소 홈페이지 모션 샘플

추천 조합 디자인을 실제 브라우저에서 확인할 수 있도록 만든 Tailwind CSS v4 기반 정적 샘플입니다. 기업행정·공공조달·출입국·비자를 같은 비중으로 보여주며, 각 주요 구간은 처음 화면에 들어올 때 한 번만 차분하게 나타납니다.

## 실행

이 폴더에서 다음 명령을 실행합니다.

```powershell
npm install
npx playwright install chromium
npm run dev -- --host 0.0.0.0
```

Windows PowerShell 실행 정책으로 `npm.ps1`이 차단되면 `npm` 대신 `npm.cmd`를 사용합니다.

```powershell
npm.cmd install
npx.cmd playwright install chromium
npm.cmd run dev -- --host 0.0.0.0
```

개발 서버가 표시한 로컬 주소를 브라우저에서 열면 됩니다. 같은 공유기 안의 다른 기기에서는 맥미니 또는 PC의 내부 IP와 Vite 포트를 사용합니다.

## 검증과 캡처

```powershell
npm test
npm run test:e2e
npm run build
npm run capture
npm run standalone
npm.cmd run verify:standalone
```

- `test`: 모션 상태와 홈페이지 정적 계약 검사
- `test:e2e`: Chromium 반응형·접근성·오류 복구·성능 회귀 검사
- `build`: TypeScript 검사와 Vite 운영 빌드
- `capture`: `wisdom-homepage-dynamic-c1-desktop.png`, `wisdom-homepage-dynamic-c1-mobile.png`, `wisdom-homepage-dynamic-c1-scroll.webm` 생성
- `standalone`: 별도 서버 없이 바로 열 수 있는 단일 HTML 생성

`verify:standalone`은 운영 빌드 후 CSS·JavaScript·대표 사진을 포함한
`.superpowers/brainstorm/renders/wisdom-homepage-dynamic-c1-demo.html`을 만들고,
실행·렌더링 리소스가 모두 파일 안에 포함됐는지 먼저 검사합니다. 일반 `https`,
`mailto`, `tel`, 해시 내비게이션 링크는 허용합니다. 이어 Chromium에서 서버 없이
직접 열어 스크롤 전에 18개 대상의 정확한 key·direction·delay 순서와
`500ms`·`±64px`·`60ms` 모션 토큰, 좌우 미노출 상태를 확인합니다. 390px 화면의
가로 넘침은 스크롤 전·각 reveal 중·완료 후마다 검사하며, `console.error`·`pageerror`·
`requestfailed`가 하나라도 발생하면 검증을 실패시킵니다.
기존 `wisdom-homepage-cinematic-demo.html`은 비교용으로 보존합니다.

## 시안 범위

- 언어 선택기는 KO·EN·简·繁의 화면 위치와 반응형 형태를 확인하는 디자인 샘플입니다. 실제 번역 전환은 본 프로젝트의 i18n 구현 단계에서 연결합니다.
- 상담 요청 버튼, 카카오, 개인정보 처리방침은 최종 라우트와 상담 폼이 정해지는 구현 단계에서 연결합니다.
- 네이버 블로그와 지도는 현재 제공된 공개 주소를 사용합니다.

## 이미지 교체 주의

현재 대표 사진은 제공된 브로슈어를 잘라 사용한 저해상도 시안입니다. 운영 배포 전 고해상도 상반신 원본으로 교체해야 합니다. 운영본에서는 원본을 AVIF·WebP·JPEG로 변환하고 각 이미지의 고정 `width`·`height`를 유지해 화면 밀림을 방지합니다.
