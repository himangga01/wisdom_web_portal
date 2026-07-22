import { describe, expect, it } from "vitest";

import { backLinkHtml, errorBodyHtml, savedBannerHtml } from "./primitives.js";
import { consultationDetailBodyHtml, dashboardBodyHtml } from "./screens.js";

describe("admin UI components", () => {
  it("escapes hrefs and text like escapeHtml", () => {
    expect(backLinkHtml("/x?a=1&b=2", "<b>go</b>")).toBe(
      '<p><a href="/x?a=1&amp;b=2">&lt;b&gt;go&lt;/b&gt;</a></p>',
    );
  });

  it("renders success banners, including the test-send link", () => {
    expect(savedBannerHtml("saved")).toBe('<p class="banner banner-ok">저장되었습니다.</p>');
    const sent = savedBannerHtml("sent");
    expect(sent).toContain('<a href="/admin/failures">발송 실패</a>');
    // The wording must not imply successful sends appear on the failures screen.
    expect(sent).toContain("발송에 실패했거나 채널 설정 문제로 취소된 경우에만");
  });

  it("renders an error body with heading, message, and back link", () => {
    expect(errorBodyHtml("제목", "메시지", "/back", "돌아가기")).toBe(
      '<h1>제목</h1><p>메시지</p><p><a href="/back">돌아가기</a></p>',
    );
  });

  it("renders the dashboard count link with a status-and-count label", () => {
    expect(dashboardBodyHtml([{ status: "received", count: 3 }], "")).toContain(
      '<a href="/admin/consultations?status=received">접수: 3</a>',
    );
  });

  it("escapes stored PII in the consultation detail", () => {
    const html = consultationDetailBodyHtml({
      id: "c1",
      receiptId: "r1",
      status: "received",
      locale: "ko",
      category: "procurement",
      receivedAt: "2026-07-16 09:00 (KST)",
      preferredContact: "전화",
      marketingState: "미동의",
      retentionExpiresAt: "2027-07-16 09:00 (KST)",
      purged: false,
      emailChannelEnabled: false,
      hermesChannelEnabled: true,
      notifications: [],
      statusHistory: [],
      pii: { name: "<script>x</script>", phone: "010", email: "", company: "", message: "m" },
    });
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("<dd>접수</dd>");
    expect(html).toContain("공공조달");
  });
});
