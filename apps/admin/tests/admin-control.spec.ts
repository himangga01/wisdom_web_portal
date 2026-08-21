import { expect, test, type Page } from "@playwright/test";

import { totpCode } from "../../control/src/auth/totp.ts";

const fixedNowMs = 1_768_435_200_000;
const totpSecret = Buffer.alloc(32, 94);

async function login(page: Page) {
  await page.goto("/admin");
  await page.getByLabel("아이디").fill("owner");
  await page.getByLabel("비밀번호").fill("owner password");
  await page.getByRole("button", { name: "계속" }).click();
  await expect(page).toHaveURL(/\/admin\/mfa$/u);
  await page.getByLabel("아이디").fill("owner");
  await page.getByLabel("인증 코드").fill(totpCode(totpSecret, fixedNowMs));
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "대시보드" })).toBeVisible();
}

test("runs core administrator flows against the actual Control app", async ({ page, context }) => {
  await login(page);

  await page.getByRole("link", { name: "상담", exact: true }).click();
  await expect(page.getByRole("link", { name: "receipt-control-e2e" })).toBeVisible();
  await page.getByRole("link", { name: "receipt-control-e2e" }).click();
  await expect(page.getByText("Control E2E", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "릴리스" }).click();
  await page.getByRole("link", { name: "게시 미리보기" }).click();
  await expect(page.getByRole("heading", { name: "다음 게시 묶음" })).toBeVisible();

  await page.getByRole("link", { name: "알림" }).click();
  const emailPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "이메일" }) });
  await expect(emailPanel.getByRole("button", { name: "테스트 발송" })).toBeDisabled();
  await emailPanel.getByRole("button", { name: "설정 저장" }).click();
  await expect(page.getByText("이메일 알림 설정을 저장했습니다.")).toBeVisible();

  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/u);
  const sessionResponse = await page.request.get("/admin/api/v1/session");
  expect(sessionResponse.status()).toBe(401);
  expect((await context.cookies()).some((cookie) => cookie.name.includes("session"))).toBe(false);
});
