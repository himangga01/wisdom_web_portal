import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getVerification, getStaticPaths as getVerificationPaths } from "../pages/[verification].js";
import { GET as getRobots } from "../pages/robots.txt.js";
import { GET as getRss } from "../pages/rss.xml.js";
import { GET as getSitemap } from "../pages/sitemap.xml.js";

const fixtureDirectory = fileURLToPath(
  new URL("../content/__fixtures__/published-content", import.meta.url),
);
const originalEnvironment = { ...process.env };

beforeEach(() => {
  process.env.PUBLIC_ORIGIN = "https://www.jihye-office.kr";
  process.env.WISDOM_PUBLISHED_CONTENT_DIR = fixtureDirectory;
  delete process.env.GOOGLE_SITE_VERIFICATION_DNS;
  delete process.env.NAVER_SITE_VERIFICATION_META;
  delete process.env.NAVER_SITE_VERIFICATION_FILE;
});

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("static search discovery endpoints", () => {
  it("serves sitemap, RSS, and robots with exact media types", async () => {
    const sitemap = await getSitemap({} as never);
    const rss = await getRss({} as never);
    const robots = await getRobots({} as never);

    expect(sitemap.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await sitemap.text()).toContain("<urlset");
    expect(rss.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(await rss.text()).toContain("<rss");
    expect(robots.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await robots.text()).toContain(
      "Sitemap: https://www.jihye-office.kr/sitemap.xml",
    );
  });

  it("omits the Naver file route when unset and emits only a configured raw file", async () => {
    expect(await getVerificationPaths({} as never)).toEqual([]);

    process.env.NAVER_SITE_VERIFICATION_FILE = "naverunit_test_file_token_1234567890.html";
    const paths = await getVerificationPaths({} as never);
    expect(paths).toEqual([{
      params: { verification: "naverunit_test_file_token_1234567890.html" },
      props: {
        content:
          "naver-site-verification: naverunit_test_file_token_1234567890.html",
      },
    }]);

    const response = await getVerification({ props: paths[0]!.props } as never);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toBe(
      "naver-site-verification: naverunit_test_file_token_1234567890.html\n",
    );
  });
});
