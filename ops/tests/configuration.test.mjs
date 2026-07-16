import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { renderTemplateFile } from "../lib/templates.mjs";

const opsRoot = path.resolve(import.meta.dirname, "..");

const fixture = Object.freeze({
  ADMIN_HOST: "admin.example.test",
  ADMIN_DUMMY_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$+PoSSRtbM306Z90yryZta7Qvu3hikTDby6TmJumCJEY",
  AGE_BINARY: "/opt/homebrew/bin/age",
  AGE_RECIPIENT: "age1operatorreplacebeforeinstall",
  APEX_HOST: "example.test",
  APP_ROOT: "/Users/wisdom/portal",
  BACKUP_ROOT: "/Users/wisdom/Backups/portal",
  BACKUP_TEMP_ROOT: "/Users/wisdom/Library/Caches/WisdomPortalBackup",
  CADDY_BINARY: "/opt/homebrew/bin/caddy",
  CADDY_ADMIN_PORT: "2019",
  CADDY_BIND: "127.0.0.1",
  CADDY_CONFIG: "/Users/wisdom/portal/shared/Caddyfile",
  CADDY_PORT: "8080",
  CLOUDFLARED_BINARY: "/opt/homebrew/bin/cloudflared",
  CLOUDFLARED_CONFIG: "/Users/wisdom/portal/shared/cloudflared.yml",
  CLOUDFLARED_CREDENTIALS_FILE: "/Users/wisdom/.cloudflared/fixture.json",
  CODEX_BINARY: "/opt/homebrew/bin/codex",
  CODEX_HOME: "/Users/wisdom/Library/Application Support/WisdomPortalCodex",
  CODEX_KEYCHAIN_SERVICE: "com.jihye.portal.codex-api",
  CODEX_MODEL: "gpt-5-codex",
  CODEX_TEMP_ROOT: "/Users/wisdom/Library/Caches/WisdomPortalCodex",
  CONTROL_HOST: "127.0.0.1",
  CONTROL_PORT: "8787",
  CURRENT_RELEASE: "/Users/wisdom/portal/current",
  DATA_ROOT: "/Users/wisdom/Library/Application Support/WisdomPortal",
  LOG_ROOT: "/Users/wisdom/Library/Logs/WisdomPortal",
  GIT_BINARY: "/usr/bin/git",
  INDEXNOW_KEYCHAIN_SERVICE: "com.jihye.portal.indexnow",
  NODE_BINARY: "/opt/homebrew/bin/node",
  NPM_BINARY: "/opt/homebrew/bin/npm",
  PUBLIC_HOST: "www.example.test",
  PUBLIC_CURRENT_RELEASE: "/Users/wisdom/portal/public-current",
  PUBLIC_RELEASE_ROOT: "/Users/wisdom/portal/public-releases",
  RELEASE_ROOT: "/Users/wisdom/portal/releases",
  TUNNEL_ID: "00000000-0000-4000-8000-000000000000",
  USER_HOME: "/Users/wisdom",
  USER_NAME: "wisdom",
});

async function render(relativePath, extra = {}) {
  return renderTemplateFile(path.join(opsRoot, relativePath), {
    ...fixture,
    ...extra,
  });
}

test("operator environment templates expose exactly-one Naver verification settings as opt-in", async () => {
  const rootExample = await readFile(path.resolve(opsRoot, "../.env.example"), "utf8");
  const runtime = await readFile(path.join(opsRoot, "config/runtime.env.template"), "utf8");

  for (const source of [rootExample, runtime]) {
    assert.match(source, /^# NAVER_SITE_VERIFICATION_META=your-token-here$/m);
    assert.match(source, /^# NAVER_SITE_VERIFICATION_FILE=naver-site-verification\.html$/m);
    assert.doesNotMatch(source, /^NAVER_SITE_VERIFICATION_(?:META|FILE)=/m);
  }
});

test("Caddy is loopback-only and separates apex, public, and admin hosts", async () => {
  const caddy = await render("caddy/Caddyfile.template");

  assert.match(caddy, /default_bind\s+127\.0\.0\.1/);
  assert.match(caddy, /admin 127\.0\.0\.1:2019/);
  assert.match(caddy, /http:\/\/example\.test:8080[\s\S]*redir https:\/\/www\.example\.test\{uri\} 308/);
  assert.match(caddy, /http:\/\/www\.example\.test:8080/);
  assert.match(caddy, /http:\/\/admin\.example\.test:8080/);
  assert.match(caddy, /trusted_proxies_strict/);
  assert.match(caddy, /client_ip_headers CF-Connecting-IP/);
  assert.match(caddy, /respond "unknown host" 404/);
  assert.doesNotMatch(caddy, /(?:0\.0\.0\.0|\[::\]|:80\b|:443\b)/);
});

test("Caddy routes only the public API and live health to control", async () => {
  const caddy = await render("caddy/Caddyfile.template");

  assert.match(caddy, /@public_api path \/api\/v1\/\*/);
  assert.match(caddy, /@public_live path \/health\/live/);
  assert.match(caddy, /handle @public_api \{[\s\S]*?reverse_proxy 127\.0\.0\.1:8787[\s\S]*?\}/);
  assert.match(caddy, /handle @public_live \{[\s\S]*?reverse_proxy 127\.0\.0\.1:8787[\s\S]*?\}/);
  assert.match(caddy, /@public_private path \/admin\* \/health\/ready \/internal\/\*/);
  assert.match(caddy, /respond @public_private 404/);
  assert.match(caddy, /http:\/\/admin\.example\.test:8080[\s\S]*reverse_proxy 127\.0\.0\.1:8787/);
});

test("Caddy exposes only the exact IndexNow key path with private response policy", async () => {
  const caddy = await render("caddy/Caddyfile.template");

  assert.match(caddy, /@indexnow_key path \/indexnow-key\.txt/);
  assert.match(
    caddy,
    /handle @indexnow_key \{[\s\S]*Cache-Control "no-store"[\s\S]*X-Robots-Tag "noindex, nofollow, noarchive"[\s\S]*Content-Type "text\/plain; charset=utf-8"[\s\S]*Referrer-Policy "no-referrer"[\s\S]*reverse_proxy 127\.0\.0\.1:8787[\s\S]*\}/,
  );
  assert.doesNotMatch(caddy, /@indexnow_key path \/indexnow-key\.txt\*/);
});

test("public withdrawal capability routes are proxied with private response policy", async () => {
  const caddy = await render("caddy/Caddyfile.template");

  assert.ok(caddy.includes(
    "@withdraw path_regexp withdraw ^/(?:marketing/withdraw/(?:[A-Za-z0-9_-]{43}|confirm)|(?:en|zh-hans|zh-hant)/marketing/withdraw/confirm)/?$",
  ));
  assert.match(caddy, /handle @withdraw \{[\s\S]*header \{[\s\S]*Cache-Control "no-store"[\s\S]*X-Robots-Tag "noindex, nofollow, noarchive"[\s\S]*Referrer-Policy "no-referrer"[\s\S]*\}[\s\S]*reverse_proxy 127\.0\.0\.1:8787[\s\S]*\}/);
  assert.doesNotMatch(caddy, /@public_private path[^\n]*withdraw/);
  assert.doesNotMatch(caddy, /@withdraw path[^\n]*\/marketing\/withdraw\*/);
});

test("public dynamic and static routes are mutually exclusive in literal policy order", async () => {
  const caddy = await render("caddy/Caddyfile.template");
  const publicStart = caddy.indexOf("http://www.example.test:8080");
  const adminStart = caddy.indexOf("http://admin.example.test:8080");
  const publicBlock = caddy.slice(publicStart, adminStart);
  const positions = [
    "handle @public_private",
    "handle @withdraw",
    "handle @public_api",
    "handle @public_live",
    "handle @indexnow_key",
    "handle {",
  ].map((needle) => publicBlock.indexOf(needle));

  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, positions.toSorted((left, right) => left - right));
  assert.match(publicBlock, /route \{[\s\S]*handle @public_private[\s\S]*handle @withdraw[\s\S]*handle @public_api[\s\S]*handle @public_live[\s\S]*handle @indexnow_key[\s\S]*handle \{/);
  assert.equal((publicBlock.match(/try_files/g) ?? []).length, 1);
  assert.ok(publicBlock.indexOf("handle {") < publicBlock.indexOf("try_files"));
});

test("admin host blocks non-admin control surfaces before its catch-all proxy", async () => {
  const caddy = await render("caddy/Caddyfile.template");
  const adminStart = caddy.indexOf("http://admin.example.test:8080");
  const unknownStart = caddy.indexOf("http://:8080", adminStart);
  const admin = caddy.slice(adminStart, unknownStart);

  assert.match(
    admin,
    /@admin_forbidden path \/internal \/internal\/\* \/api \/api\/\* \/indexnow-key\.txt \/marketing\/withdraw\* \/en\/marketing\/withdraw\* \/zh-hans\/marketing\/withdraw\* \/zh-hant\/marketing\/withdraw\* \/health \/health\/\*/,
  );
  assert.ok(admin.indexOf("respond @admin_forbidden 404") < admin.indexOf("reverse_proxy 127.0.0.1:8787"));
  assert.doesNotMatch(admin, /@admin_forbidden[^\n]*\/admin\/health/);
});

test("static misses retain an actual 404 and every Astro build asset is immutable", async () => {
  const caddy = await render("caddy/Caddyfile.template");

  assert.match(caddy, /@immutable path \/_astro\/\*/);
  assert.match(caddy, /try_files \{path\} \{path\}\/index\.html =404/);
  assert.match(caddy, /handle_errors \{[\s\S]*@en_404 path \/en\/\*[\s\S]*rewrite \* \/en\/404\/index\.html/);
  assert.match(caddy, /@zh_hans_404 path \/zh-hans\/\*[\s\S]*rewrite \* \/zh-hans\/404\/index\.html/);
  assert.match(caddy, /@zh_hant_404 path \/zh-hant\/\*[\s\S]*rewrite \* \/zh-hant\/404\/index\.html/);
  assert.match(caddy, /handle_errors \{[\s\S]*handle \{[\s\S]*rewrite \* \/404\.html[\s\S]*file_server[\s\S]*\}/);
  assert.doesNotMatch(caddy, /try_files[^\n]*\/404\.html/);
});

test("unknown Host falls through to a loopback catch-all only", async () => {
  const caddy = await render("caddy/Caddyfile.template");
  const catchAll = "http://:8080 {\n\trespond \"unknown host\" 404\n}";

  assert.ok(caddy.trimEnd().endsWith(catchAll));
  assert.doesNotMatch(caddy, /http:\/\/127\.0\.0\.1:8080 \{/);
  assert.equal((caddy.match(/respond "unknown host" 404/g) ?? []).length, 1);
});

test("Caddy applies security and cache contracts without sensitive access logs", async () => {
  const caddy = await render("caddy/Caddyfile.template");

  for (const header of [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Content-Security-Policy",
  ]) {
    assert.match(caddy, new RegExp(header));
  }
  assert.match(caddy, /Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'"/);
  assert.match(caddy, /Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(caddy, /Cache-Control "public, max-age=0, must-revalidate"/);
  assert.match(caddy, /Cache-Control "no-store"/);
  assert.match(caddy, /X-Robots-Tag "noindex, nofollow, noarchive"/);
  assert.match(caddy, /access logs intentionally disabled/i);
  assert.doesNotMatch(caddy, /\blog\s*\{/);
  assert.doesNotMatch(caddy, /query(?:_string)?/i);
});

test("Caddy fixes XML MIME and noindexes only bounded Naver verification filenames", async () => {
  const caddy = await render("caddy/Caddyfile.template");

  assert.match(caddy, /@sitemap_xml path \/sitemap\.xml/);
  assert.match(caddy, /@rss_xml path \/rss\.xml/);
  assert.match(caddy, /header @sitemap_xml Content-Type "application\/xml; charset=utf-8"/);
  assert.match(caddy, /header @rss_xml Content-Type "application\/rss\+xml; charset=utf-8"/);
  assert.match(caddy, /@naver_verify path_regexp naver_verify \^\/naver\[A-Za-z0-9_\-\]\{24,128\}\\\.html\$/);
  assert.match(caddy, /header @naver_verify X-Robots-Tag "noindex, nofollow"/);
  assert.doesNotMatch(caddy, /@naver_verify path \/naver\*/);
});

test("public content and application releases use distinct pointers", async () => {
  const caddy = await render("caddy/Caddyfile.template");
  const runtime = await render("config/runtime.env.template");
  const control = await render("launchd/com.jihye.portal.control.plist.template");

  assert.match(caddy, /root \* \/Users\/wisdom\/portal\/public-current/);
  assert.doesNotMatch(caddy, /root \* \/Users\/wisdom\/portal\/current/);
  assert.match(runtime, /PUBLIC_RELEASE_ROOT=\/Users\/wisdom\/portal\/public-releases/);
  assert.match(runtime, /PUBLIC_CURRENT_LINK=\/Users\/wisdom\/portal\/public-current/);
  assert.match(control, /\/Users\/wisdom\/portal\/current\/apps\/control\/dist\/server\.js/);
});

test("content worker runtime uses paths and a Keychain reference, never a Codex credential", async () => {
  const runtime = await render("config/runtime.env.template");
  for (const contract of [
    "CODEX_BINARY=/opt/homebrew/bin/codex",
    "GIT_BINARY=/usr/bin/git",
    "CODEX_MODEL=gpt-5-codex",
    "CODEX_TEMP_ROOT=/Users/wisdom/Library/Caches/WisdomPortalCodex",
    "CODEX_HOME=/Users/wisdom/Library/Application Support/WisdomPortalCodex",
    "CODEX_KEYCHAIN_SERVICE=com.jihye.portal.codex-api",
    "CODEX_TIMEOUT_MS=120000",
    "SITE_SOURCE_ROOT=/Users/wisdom/portal/current",
    "NODE_BINARY=/opt/homebrew/bin/node",
    "NPM_BINARY=/opt/homebrew/bin/npm",
    "PUBLICATION_BUILD_TIMEOUT_MS=300000",
    "INDEXNOW_KEYCHAIN_SERVICE=com.jihye.portal.indexnow",
    "INDEXNOW_KEY_LOCATION=https://www.example.test/indexnow-key.txt",
    "INDEXNOW_TIMEOUT_MS=10000",
  ]) assert.ok(runtime.includes(contract), contract);
  assert.doesNotMatch(runtime, /CODEX_API_KEY|sk-[A-Za-z0-9]/u);
});

test("cloudflared exposes only declared hosts to loopback Caddy", async () => {
  const config = await render("cloudflared/config.yml.template");

  assert.match(config, /tunnel: 00000000-0000-4000-8000-000000000000/);
  assert.match(config, /credentials-file: \/Users\/wisdom\/\.cloudflared\/fixture\.json/);
  for (const host of ["example.test", "www.example.test", "admin.example.test"]) {
    assert.match(config, new RegExp(`hostname: ${host.replaceAll(".", "\\.")}`));
  }
  assert.equal((config.match(/service: http:\/\/127\.0\.0\.1:8080/g) ?? []).length, 3);
  assert.match(config, /service: http_status:404/);
  assert.doesNotMatch(config, /(?:0\.0\.0\.0|\[::\]|noTLSVerify|token:)/);
});

test("launchd templates keep executables absolute and secrets out of plists", async () => {
  const launchdDir = path.join(opsRoot, "launchd");
  const files = (await readdir(launchdDir)).filter((file) => file.endsWith(".plist.template"));

  assert.deepEqual(files.sort(), [
    "com.jihye.portal.backup.plist.template",
    "com.jihye.portal.caddy.plist.template",
    "com.jihye.portal.cloudflared.plist.template",
    "com.jihye.portal.content-worker.plist.template",
    "com.jihye.portal.control.plist.template",
    "com.jihye.portal.notification-worker.plist.template",
  ]);

  for (const file of files) {
    const plist = await render(`launchd/${file}`);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>\d+<\/integer>/);
    assert.doesNotMatch(plist, /<key>EnvironmentVariables<\/key>/);
    assert.doesNotMatch(plist, /(?:SECRET|PASSWORD|PRIVATE_KEY)[^<]*<string>/i);
    for (const argument of plist.matchAll(/<string>([^<]+)<\/string>/g)) {
      const value = argument[1];
      if (value.includes("/") && !value.startsWith("--")) {
        assert.ok(path.posix.isAbsolute(value), `${file} has a relative executable/path: ${value}`);
      }
    }
  }
});

test("control processes receive only the common runtime contract and independent Keychain items", async () => {
  const expectedSecrets = [
    "ADMIN_SESSION_SECRET=com.jihye.portal.admin-session",
    "CONTROL_HMAC_SECRET=com.jihye.portal.control-hmac",
    "HERMES_HMAC_SECRET=com.jihye.portal.hermes-hmac",
    "PII_ENCRYPTION_KEY=com.jihye.portal.pii-key",
    "WITHDRAWAL_TOKEN_SECRET=com.jihye.portal.withdrawal-token",
  ];

  for (const service of ["control", "notification-worker", "content-worker"]) {
    const plist = await render(`launchd/com.jihye.portal.${service}.plist.template`);
    const mappings = [...plist.matchAll(/<string>([A-Z][A-Z0-9_]+=[A-Za-z0-9._-]+)<\/string>/g)]
      .map((match) => match[1])
      .sort();
    assert.deepEqual(mappings, expectedSecrets, service);
    assert.match(plist, /<string>--config<\/string><string>\/Users\/wisdom\/portal\/shared\/runtime\.env<\/string>/);
    assert.match(plist, /\/Users\/wisdom\/portal\/current\/ops\/scripts\/keychain-exec\.mjs/);
    assert.doesNotMatch(plist, /\/Users\/wisdom\/portal\/ops\/scripts/);
    assert.doesNotMatch(plist, /(?:SMTP_PASSWORD|DATA_ENCRYPTION_KEY)/);
  }
});

test("ops templates contain placeholders rather than deployable credentials", async () => {
  const allowedSuffixes = [".template", ".md", ".mjs"];
  const queue = [opsRoot];
  while (queue.length > 0) {
    const directory = queue.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "tests") queue.push(absolute);
        continue;
      }
      if (!allowedSuffixes.some((suffix) => entry.name.endsWith(suffix))) continue;
      const text = await readFile(absolute, "utf8");
      assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
      assert.doesNotMatch(text, /(?:api[_-]?key|password|secret)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{16,}/i);
    }
  }
});

test("backup schedule and log rotation are bounded", async () => {
  const backup = await render("launchd/com.jihye.portal.backup.plist.template");
  const newsyslog = await render("newsyslog/wisdom-portal.conf.template");

  assert.match(backup, /<key>StartInterval<\/key><integer>3600<\/integer>/);
  assert.match(backup, /<string>--apply<\/string>/);
  assert.match(backup, /\/Users\/wisdom\/portal\/current\/ops\/scripts\/(?:keychain-exec|backup)\.mjs/);
  assert.doesNotMatch(backup, /\/Users\/wisdom\/portal\/ops\/scripts/);
  assert.match(newsyslog, /\/Users\/wisdom\/Library\/Logs\/WisdomPortal\/\*\.log\s+wisdom:staff\s+640\s+10\s+10240\s+\*\s+GJN/);
  assert.doesNotMatch(newsyslog, /world|777/i);
});

test("monitoring template keeps external public checks separate from private alerts", async () => {
  const monitoring = await render("monitoring/checks.json.template");
  const parsed = JSON.parse(monitoring);

  assert.deepEqual(parsed.externalPublic, {
    url: "https://www.example.test/health/live",
    expectedStatus: 200,
    expectedText: "ok",
    source: "outside-mac-and-lan",
  });
  assert.equal(parsed.private.backupFreshnessMinutes, 90);
  assert.equal(parsed.private.diskFreePercentMinimum, 15);
  assert.equal(parsed.private.notificationFailureBacklogMaximum, 0);
  assert.doesNotMatch(monitoring, /admin\.example\.test|health\/ready/);
});

test("operations runbooks document recovery limits and reversible host guidance", async () => {
  const deployment = await readFile(path.join(opsRoot, "runbooks/deployment.md"), "utf8");
  const recovery = await readFile(path.join(opsRoot, "runbooks/recovery.md"), "utf8");
  const incidents = await readFile(path.join(opsRoot, "runbooks/incidents.md"), "utf8");

  assert.match(deployment, /FileVault[\s\S]*pre-login[\s\S]*user.*unlock/i);
  assert.match(deployment, /pmset[\s\S]*inspect[\s\S]*reversible/i);
  assert.match(deployment, /UPS[\s\S]*wired Ethernet[\s\S]*sleep/i);
  assert.match(recovery, /RPO[^\n]*60 minutes[\s\S]*RTO[^\n]*4 hours[\s\S]*non-guaranteed/i);
  for (const scenario of ["disk full", "tunnel outage", "certificate", "database corruption", "key loss", "notification backlog", "rollback"]) {
    assert.match(incidents, new RegExp(scenario, "i"));
  }
  assert.doesNotMatch(`${deployment}\n${recovery}\n${incidents}`, /port forwarding|open router port/i);
});
