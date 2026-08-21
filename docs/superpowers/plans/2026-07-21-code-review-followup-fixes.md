# Code Review Follow-up Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** 전체 정적 코드 리뷰에서 확인된 7개 이슈를 수정하고, 현재 HEAD 기준 릴리스 근거를 다시 일치시킨다.

**Architecture:** 관리자 라우트의 입력 경계와 조회량을 제한하고, 공개 상담 폼은 서버 메시지를 직접 노출하지 않고 현재 언어의 클라이언트 메시지로 변환한다. 백업 보존 처리는 아티팩트와 상태 파일의 불완전한 쌍을 복구·정리할 수 있도록 보강한다. 릴리스 문서는 승인된 검증 결과만 기록한다.

**Tech Stack:** TypeScript, Hono, Astro, Zod, SQLite/D1, Vitest, Playwright, Node.js ESM

---

## 실행 제약

- 이 문서는 수정 계획만 정의한다. 현재 단계에서는 코드 수정, 테스트, 검증, 커밋을 실행하지 않는다.
- 각 작업의 실행은 사용자의 별도 승인을 받은 뒤 시작한다.
- 테스트와 전체 검증은 구현 승인과 별도로 사용자 승인을 받은 경우에만 실행한다.
- 패키지 추가와 의존성 변경은 하지 않는다.
- 기존 사용자 변경 사항과 관련 없는 파일은 수정하지 않는다.
- 검증 승인을 받지 못한 상태에서는 릴리스 문서에 성공 수치나 완료 상태를 기록하지 않는다.

## 이슈 대응표

| 우선순위 | 이슈 | 계획 작업 |
|---|---|---|
| P1 | 릴리스 검증 문서가 현재 HEAD와 불일치 | 작업 6, 7 |
| P2 | 관리자 페이지 번호로 안전 정수 범위를 벗어난 OFFSET 생성 | 작업 1 |
| P2 | 다국어 폼에 영문 서버 필드 오류 노출, 라디오 그룹 누락 | 작업 3 |
| P2 | 전체 문의 이메일 알림 비활성화에도 승인 요구 | 작업 2 |
| P2 | 백업 파일 삭제 중단 시 고아 상태 파일 누적 | 작업 5 |
| P3 | 실패 알림과 글 리비전 목록의 무제한 조회 | 작업 1 |
| P3 | `Retry-After`가 없을 때 임의의 60초 안내 | 작업 4 |

### Task 1: 관리자 페이지 번호 정규화 및 목록 조회량 제한

**Files:**

- Modify: `apps/control/src/admin/routes.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`

**Step 1: 실패하는 경계 테스트 작성**

`admin-http.test.ts`에 다음 동작을 고정한다.

- 매우 큰 `page` 값으로 목록을 요청해도 503이 아니라 200 HTML을 반환한다.
- `page=0`, 음수, 숫자가 아닌 값은 1페이지로 처리한다.
- 실제 마지막 페이지를 넘는 값은 마지막 페이지로 제한한다.
- `/admin/failures`는 페이지 크기만큼만 렌더링한다.
- 글 상세의 리비전 목록은 `revisionPage`로 페이지를 이동한다.

예상 테스트 형태:

```ts
it("clamps unsafe admin page values", async () => {
  const response = await authenticatedRequest(
    "/admin/articles?page=999999999999999999999999",
  );

  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("STORAGE_UNAVAILABLE");
});
```

**Step 2: 총건수 기반 페이지 정규화 도우미 작성**

기존 `requestedPage()`를 총건수와 페이지 크기를 받는 형태로 변경한다.

```ts
function requestedPage(
  value: string | undefined,
  pageSize: number,
  total: number,
): number {
  if (!value || !/^\d{1,9}$/.test(value)) return 1;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(parsed, lastPage);
}
```

각 목록 라우트에서 `COUNT`를 먼저 구한 후 정규화된 페이지로 `OFFSET`을 계산한다. 이 순서로 기사, 릴리스, 상담 목록을 모두 통일한다.

**Step 3: 실패 알림 목록 페이지네이션 추가**

`FAILURE_PAGE_SIZE = 50`을 정의하고 다음 순서로 변경한다.

1. 전체 실패 알림 수 조회
2. `requestedPage()`로 현재 페이지 정규화
3. `LIMIT ? OFFSET ?` 조회
4. 기존 관리자 페이지네이션 UI 렌더링

**Step 4: 글 리비전 목록 페이지네이션 추가**

`REVISION_PAGE_SIZE = 50`을 정의한다. 글 상세 라우트에서 해당 글의 리비전 수를 먼저 조회하고 `revisionPage` 쿼리로 목록을 제한한다. 기존 페이지네이션 헬퍼가 `page`를 고정한다면 쿼리 키를 인자로 받도록 확장한다.

```ts
pagination(path, revisionPage, REVISION_PAGE_SIZE, revisionTotal, "revisionPage")
```

**Step 5: 승인 후 집중 테스트 실행**

사용자가 테스트 실행을 승인한 경우에만 실행한다.

```bash
npm --workspace @wisdom/control test -- admin-http.test.ts
```

**Step 6: 승인 후 커밋**

```bash
git add apps/control/src/admin/routes.ts apps/control/src/admin/admin-http.test.ts
git commit -m "fix(control): bound admin pagination queries"
```

### Task 2: 전체 문의 이메일 알림 비활성화 승인 조건 수정

**Files:**

- Modify: `apps/control/src/admin/routes.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`

**Step 1: 실패하는 권한 조건 테스트 작성**

- 현재 설정이 `full-inquiry`이며 활성화된 상태에서 승인 체크 없이 비활성화하면 303을 반환한다.
- 비활성화된 `full-inquiry`를 승인 체크 없이 다시 활성화하면 422를 반환한다.
- 승인 체크와 함께 활성화하면 정상 저장된다.

**Step 2: 활성화할 때만 승인하도록 조건 축소**

```ts
if (enabled && payloadMode === "full-inquiry") {
  if (!fullInquiryApproved) {
    return renderValidationError(...);
  }
}
```

저장되는 `enabled`, `payloadMode`, 승인 감사 정보는 기존 구조를 유지한다.

**Step 3: 승인 후 집중 테스트 실행**

```bash
npm --workspace @wisdom/control test -- admin-http.test.ts
```

**Step 4: 승인 후 커밋**

```bash
git add apps/control/src/admin/routes.ts apps/control/src/admin/admin-http.test.ts
git commit -m "fix(control): allow disabling full inquiry email"
```

### Task 3: 상담 폼 서버 오류 메시지 현지화 및 라디오 그룹 처리

**Files:**

- Modify: `apps/site/src/lib/form-validation.ts`
- Modify: `apps/site/src/components/ConsultationForm.astro`
- Modify: `apps/site/tests/public-site.spec.ts`

**Step 1: 실패하는 다국어 폼 테스트 작성**

상담 API를 422 응답으로 가로채고 다음을 확인한다.

- 한국어·중국어 페이지에서 서버의 영문 Zod 메시지가 표시되지 않는다.
- 현재 언어의 일반 입력 오류 안내가 표시된다.
- `preferredContact` 오류가 있으면 첫 번째 라디오에 오류 상태를 적용하고 해당 그룹으로 포커스를 이동한다.
- 사용자가 값을 바꾸면 그룹의 사용자 지정 오류가 모두 해제된다.

**Step 2: 서버 오류 표시용 현지화 문구 연결**

`ConsultationForm.astro`의 폼에 이미 제공되는 현재 언어의 일반 오류 문구를 서버 필드 오류의 대체 문구로 사용한다.

```astro
<form
  ...
  data-status-invalid={content.form.status.invalid}
  data-error-server={content.form.status.invalid}
>
```

서버가 보낸 `messages[0]`은 필드 식별 목적으로만 처리하고 화면이나 `setCustomValidity()`에 직접 전달하지 않는다.

**Step 3: 단일 컨트롤과 라디오 그룹을 함께 반환하는 도우미 작성**

```ts
function controlsForField(form: HTMLFormElement, name: string): FormControl[] {
  const named = form.elements.namedItem(name);

  if (named instanceof RadioNodeList) {
    return Array.from(named).filter(isFormControl);
  }

  return isFormControl(named) ? [named] : [];
}
```

`applyServerFieldErrors()`는 첫 컨트롤에 현지화된 일반 오류를 설정하고, 동일 이름 그룹의 나머지 컨트롤도 변경 시 오류가 해제되도록 등록한다.

```ts
const localizedMessage = form.dataset.errorServer
  ?? form.dataset.statusInvalid
  ?? "";
```

**Step 4: 승인 후 공개 사이트 테스트 실행**

```bash
npm --workspace @wisdom/site run test:e2e -- public-site.spec.ts
```

**Step 5: 승인 후 커밋**

```bash
git add apps/site/src/lib/form-validation.ts apps/site/src/components/ConsultationForm.astro apps/site/tests/public-site.spec.ts
git commit -m "fix(site): localize server-side form errors"
```

### Task 4: `Retry-After` 없는 429 응답 안내 수정

**Files:**

- Modify: `apps/site/src/content/site-content.ts`
- Modify: `apps/site/src/components/ConsultationForm.astro`
- Modify: `apps/site/src/lib/form-validation.ts`
- Modify: `apps/site/src/lib/consultation-adapter.test.ts`
- Modify: `apps/site/tests/public-site.spec.ts`

**Step 1: 실패하는 응답 분기 테스트 작성**

- 숫자 `Retry-After`가 있으면 남은 초를 포함한 문구를 사용한다.
- 헤더가 없거나 유효하지 않으면 초를 임의로 만들지 않고 일반 재시도 문구를 사용한다.

**Step 2: 4개 언어 콘텐츠에 일반 제한 문구 추가**

`rateLimitedWithoutDelay` 필드를 콘텐츠 타입과 각 언어 데이터에 추가한다. 문구는 “요청이 많습니다. 잠시 후 다시 시도해 주세요.”와 같은 의미로 번역한다.

**Step 3: 폼 데이터 속성 연결**

```astro
data-status-rate-limited={content.form.status.rateLimited}
data-status-rate-limited-generic={content.form.status.rateLimitedWithoutDelay}
```

**Step 4: 60초 기본값 제거**

```ts
const message = result.retryAfterSeconds === undefined
  ? form.dataset.statusRateLimitedGeneric ?? form.dataset.statusFailure ?? ""
  : formatRetryMessage(
      form.dataset.statusRateLimited ?? "",
      result.retryAfterSeconds,
    );
```

**Step 5: 승인 후 집중 테스트 실행**

```bash
npm --workspace @wisdom/site test -- consultation-adapter.test.ts
npm --workspace @wisdom/site run test:e2e -- public-site.spec.ts
```

**Step 6: 승인 후 커밋**

```bash
git add apps/site/src/content/site-content.ts apps/site/src/components/ConsultationForm.astro apps/site/src/lib/form-validation.ts apps/site/src/lib/consultation-adapter.test.ts apps/site/tests/public-site.spec.ts
git commit -m "fix(site): handle rate limits without retry delay"
```

### Task 5: 백업 보존 중 고아 상태 파일 정리

**Files:**

- Modify: `ops/lib/backup.mjs`
- Modify: `ops/tests/backup-restore.test.mjs`

**Step 1: 중단 상태 재현 테스트 작성**

다음 디렉터리 상태를 만들고 보존 처리를 호출한다.

- 검증 완료 상태 JSON은 존재함
- 같은 기본 이름의 `.age` 아티팩트는 없음
- 정상 백업 쌍도 함께 존재함

처리 후 고아 상태 JSON만 제거되고 정상 백업 쌍은 유지되는지 확인한다. 심볼릭 링크, 예상 밖 파일명, 검증되지 않은 상태 파일은 삭제하지 않는 안전성 테스트도 추가한다.

**Step 2: 스캔 결과에 고아 상태 파일을 별도 수집**

`applyBackupRetention()`에서 다음 조건을 모두 만족하는 상태 파일만 `orphanStatusPaths`에 넣는다.

- 허용된 백업 파일명 규칙과 일치
- 실제 일반 파일이며 심볼릭 링크가 아님
- JSON 파싱과 기존 상태 스키마 검증 성공
- `verified === true`
- 대응하는 아티팩트가 존재하지 않음

**Step 3: 기존 삭제 예산 안에서 고아 상태 파일 정리**

정상 백업 쌍 삭제와 고아 상태 파일 정리를 합쳐 기존 `maxDeletions`를 넘지 않도록 한다. 삭제 직전에 `lstat`과 경로 경계를 다시 확인한다.

```js
const remainingDeletionBudget = Math.max(
  0,
  maxDeletions - deletedBackupPairs.length,
);
```

결과에는 정상 쌍 삭제와 고아 상태 삭제를 구분해 기록한다.

```js
return {
  deleted: deletedBackupPairs,
  deletedOrphanStatuses,
};
```

**Step 4: 승인 후 백업 테스트 실행**

```bash
node --test ops/tests/backup-restore.test.mjs
```

**Step 5: 승인 후 커밋**

```bash
git add ops/lib/backup.mjs ops/tests/backup-restore.test.mjs
git commit -m "fix(ops): clean orphaned backup status files"
```

### Task 6: 릴리스 문서의 오래된 검증 근거 제거

**Files:**

- Modify: `docs/operations/release-candidate.md`
- Modify: `README.md`

**Step 1: 현재 HEAD와 맞지 않는 완료 표현 제거**

`release-candidate.md`에서 과거 기준 커밋 이후 런타임 변경이 없다는 문장과 현재 상태로 오해할 수 있는 검증 완료 수치를 제거한다. 과거 실행 결과를 유지해야 한다면 “과거 기준 기록”으로 명시하고 현재 릴리스 근거와 분리한다.

**Step 2: 재검증 전 상태를 명시**

검증이 아직 승인·실행되지 않았다면 다음 상태로 기록한다.

```md
## Current validation status

- Current implementation contains runtime changes after the previous validation baseline.
- Fresh validation has not been run for this revision.
- Release approval remains pending until the user approves and the commands in Task 7 pass.
```

`README.md`의 검증 수치도 현재 근거가 아니면 제거하거나 같은 상태 문구로 연결한다.

**Step 3: 승인 후 문서 변경 커밋**

이 단계는 테스트를 실행하지 않는다. 문서 수정 실행 자체를 승인받은 경우에만 커밋한다.

```bash
git add docs/operations/release-candidate.md README.md
git commit -m "docs: mark release validation as pending"
```

### Task 7: 사용자 승인 후 검증 및 릴리스 근거 갱신

**Files:**

- Modify after successful verification: `docs/operations/release-candidate.md`
- Modify after successful verification: `README.md`

**Step 1: 검증 실행 승인 요청**

구현이 끝난 뒤 사용자에게 아래 명령 실행 여부를 별도로 승인받는다. 승인 전에는 실행하지 않는다.

**Step 2: 승인된 경우 집중 테스트 실행**

```bash
npm --workspace @wisdom/control test -- admin-http.test.ts
npm --workspace @wisdom/site test -- consultation-adapter.test.ts
node --test ops/tests/backup-restore.test.mjs
```

브라우저 테스트가 별도로 승인된 경우에만 실행한다.

```bash
npm --workspace @wisdom/site run test:e2e -- public-site.spec.ts
```

**Step 3: 전체 검증이 별도로 승인된 경우 실행**

```bash
npm run verify
```

**Step 4: 실제 결과만 문서에 기록**

성공한 명령의 실행 시각, 대상 커밋, 실제 테스트 수, 성공·실패 결과를 기록한다. 실패하거나 실행하지 않은 항목은 완료로 표시하지 않는다.

**Step 5: 승인 후 검증 근거 커밋**

```bash
git add docs/operations/release-candidate.md README.md
git commit -m "docs: refresh release validation evidence"
```

## 완료 조건

- 관리자 목록의 모든 `OFFSET`은 총건수 기준으로 제한된 페이지 값에서 계산된다.
- 실패 알림과 글 리비전 목록은 고정된 페이지 크기로 조회된다.
- 전체 문의 이메일 알림은 비활성화할 때 추가 승인을 요구하지 않는다.
- 공개 상담 폼은 서버의 영문 필드 메시지를 사용자에게 직접 노출하지 않는다.
- 라디오 그룹 서버 오류가 표시·포커스·해제된다.
- `Retry-After`가 없을 때 가짜 60초 대기 시간을 표시하지 않는다.
- 백업 보존 처리가 검증된 고아 상태 파일을 제한된 삭제 예산 안에서 정리한다.
- 릴리스 문서는 현재 커밋에서 실제로 실행된 승인된 검증 결과만 포함한다.

## 비범위

- 새로운 관리자 기능 또는 공개 사이트 기능 추가
- UI 전면 재설계
- 패키지·런타임 버전 변경
- 데이터베이스 스키마 변경
- 배포, 푸시, PR 생성 또는 병합
