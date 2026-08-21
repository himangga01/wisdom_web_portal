import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/u);
  await page.getByLabel("아이디").fill("owner");
  await page.getByLabel("비밀번호").fill("owner password");
  await page.getByRole("button", { name: "계속" }).click();
  await expect(page).toHaveURL(/\/admin\/mfa$/u);
  await page.getByLabel("아이디").fill("owner");
  await page.getByLabel("인증 코드").fill("123456");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "대시보드" })).toBeVisible();
}

test("loads under the production CSP and recovers an expired session", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await expect(page).toHaveTitle("관리자 대시보드 | JIHYE 관리자");
  await expect(page.getByText("2", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "상태" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/u);
  await expect(page.getByRole("heading", { name: "관리자 로그인" })).toBeFocused();
  expect(errors).toEqual([]);
});

test("discards an older consultation response after client-side navigation", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "상담", exact: true }).click();
  await page.getByRole("link", { name: "receipt-a" }).click();
  await page.getByRole("link", { name: "상담", exact: true }).click();
  await page.getByRole("link", { name: "receipt-b" }).click();
  await expect(page.getByText("민감 B")).toBeVisible();
  await page.waitForTimeout(550);
  await expect(page.getByText("민감 A")).toHaveCount(0);
  await expect(page).toHaveURL(/\/admin\/consultations\/b$/u);
});

test("sends the production Origin, CSRF, and CAS body for a consultation mutation", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "상담", exact: true }).click();
  await page.getByRole("link", { name: "receipt-b" }).click();
  await page.getByLabel("다음 상태").selectOption("acknowledged");
  await page.getByRole("button", { name: "상태 저장" }).click();
  await expect(page.getByText("acknowledged", { exact: true })).toBeVisible();
});

test("supports leaving MFA and focuses content on query-only pagination", async ({ page }) => {
  await page.goto("/admin");
  await page.getByLabel("아이디").fill("owner");
  await page.getByLabel("비밀번호").fill("owner password");
  await page.getByRole("button", { name: "계속" }).click();
  await page.getByRole("button", { name: "처음부터 다시 로그인" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/u);
  await expect(page.getByRole("heading", { name: "관리자 로그인" })).toBeFocused();

  await login(page);
  await page.getByRole("link", { name: "상담", exact: true }).click();
  await page.getByRole("link", { name: "다음" }).click();
  await expect(page).toHaveURL(/\/admin\/consultations\?page=2$/u);
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page.getByRole("link", { name: "receipt-c" })).toBeVisible();
});

test("locks every rollback control while one rollback is pending", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "릴리스" }).click();
  const first = page.getByRole("row").filter({ hasText: "v1" });
  const second = page.getByRole("row").filter({ hasText: "v2" });
  await first.getByRole("button", { name: "롤백 검토" }).click();
  await first.getByRole("button", { name: "v1 롤백 확인" }).click();
  await expect(second.getByRole("button", { name: "롤백 검토" })).toBeDisabled();
  await expect(first.getByRole("button", { name: "롤백 중…" })).toBeVisible();
});
