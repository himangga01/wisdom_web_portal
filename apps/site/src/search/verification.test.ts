import { describe, expect, it } from "vitest";

import { parseSearchVerificationConfig } from "./verification.js";

describe("search ownership verification configuration", () => {
  it("emits nothing when Google and Naver values are missing or placeholders", () => {
    expect(parseSearchVerificationConfig({})).toEqual({});
    expect(parseSearchVerificationConfig({
      GOOGLE_SITE_VERIFICATION_DNS: "CHANGE_ME",
      NAVER_SITE_VERIFICATION_META: "your-token-here",
      NAVER_SITE_VERIFICATION_FILE: "naver-site-verification.html",
    })).toEqual({});
  });

  it("keeps Google DNS verification separate from Naver head verification", () => {
    const config = parseSearchVerificationConfig({
      GOOGLE_SITE_VERIFICATION_DNS:
        "google-site-verification=unit_test_dns_token_1234567890",
      NAVER_SITE_VERIFICATION_META: "unit_test_naver_meta_token_1234567890",
    });

    expect(config).toEqual({
      googleDnsRecord: "google-site-verification=unit_test_dns_token_1234567890",
      naverMetaToken: "unit_test_naver_meta_token_1234567890",
    });
    expect(config).not.toHaveProperty("googleMetaToken");
  });

  it("supports one operator-provided Naver verification file without HTML markup", () => {
    expect(parseSearchVerificationConfig({
      NAVER_SITE_VERIFICATION_FILE: "naverunit_test_file_token_1234567890.html",
    })).toEqual({
      naverFile: {
        filename: "naverunit_test_file_token_1234567890.html",
        content:
          "naver-site-verification: naverunit_test_file_token_1234567890.html",
      },
    });
  });

  it("rejects malformed values and ambiguous Naver verification modes", () => {
    expect(() => parseSearchVerificationConfig({
      GOOGLE_SITE_VERIFICATION_DNS: "google-site-verification=<script>",
    })).toThrow("SEARCH_VERIFICATION_INVALID");
    expect(() => parseSearchVerificationConfig({
      NAVER_SITE_VERIFICATION_META: "valid_test_meta_token_1234567890",
      NAVER_SITE_VERIFICATION_FILE: "navervalid_test_file_1234567890.html",
    })).toThrow("SEARCH_VERIFICATION_AMBIGUOUS");
    expect(() => parseSearchVerificationConfig({
      NAVER_SITE_VERIFICATION_META: "valid_test_meta_token_1234567890\n",
    })).toThrow("SEARCH_VERIFICATION_INVALID");
  });
});
