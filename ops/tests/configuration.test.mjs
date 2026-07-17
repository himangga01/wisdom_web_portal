import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { renderTemplateFile } from "../lib/templates.mjs";
import {
  CONFIG_TEMPLATE_DESCRIPTORS,
  CONFIG_TOKEN_NAMES,
  parseProductionValues,
} from "../lib/config-installer.mjs";

const opsRoot = path.resolve(import.meta.dirname, "..");

async function collectTemplates(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await collectTemplates(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith(".template")) result.push(relative);
  }
  return result.sort();
}

test("production installer inventory owns every template and every repository token", async () => {
  const actualTemplates = await collectTemplates(opsRoot);
  const inventoryTemplates = CONFIG_TEMPLATE_DESCRIPTORS.map(({ source }) => source).sort();
  assert.deepEqual(actualTemplates, inventoryTemplates);

  const tokens = new Set();
  for (const relative of actualTemplates) {
    const source = await readFile(path.join(opsRoot, relative), "utf8");
    for (const match of source.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/gu)) tokens.add(match[1]);
  }
  assert.deepEqual([...tokens].sort(), [...CONFIG_TOKEN_NAMES]);

  const example = await readFile(path.join(opsRoot, "config/production-values.example.json"), "utf8");
  assert.deepEqual(Object.keys(parseProductionValues(example)).sort(), [...CONFIG_TOKEN_NAMES]);
});

const fixture = Object.freeze({
  ADMIN_HOST: "admin.example.test",
  ADMIN_DUMMY_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$+PoSSRtbM306Z90yryZta7Qvu3hikTDby6TmJumCJEY",
  AGE_BINARY: "/opt/homebrew/bin/age",
  AGE_RECIPIENT: "age1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0savhh7m",
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

function plistProgramArguments(source) {
  const match = /<key>ProgramArguments<\/key><array>([\s\S]*?)<\/array>/u.exec(source);
  assert.ok(match, "ProgramArguments array is required");
  return [...match[1].matchAll(/<string>([^<]*)<\/string>/gu)].map((entry) => entry[1]);
}

function plistInteger(source, key) {
  const match = new RegExp(`<key>${key}</key><integer>(\\d+)</integer>`, "u").exec(source);
  assert.ok(match, `${key} integer is required`);
  return Number(match[1]);
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
    "com.jihye.portal.monitor.plist.template",
    "com.jihye.portal.notification-worker.plist.template",
    "com.jihye.portal.retention.plist.template",
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

  for (const service of ["control", "notification-worker", "content-worker", "retention"]) {
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

test("backup schedule dispatches every 60 seconds before Keychain access with one fixed automatic child", async () => {
  const backup = await render("launchd/com.jihye.portal.backup.plist.template");
  const newsyslog = await render("newsyslog/wisdom-portal.conf.template");
  const args = plistProgramArguments(backup);
  const separator = args.indexOf("--");

  assert.deepEqual(args.slice(0, 2), [
    fixture.NODE_BINARY,
    `${fixture.CURRENT_RELEASE}/ops/scripts/backup-dispatcher.mjs`,
  ]);
  assert.equal(plistInteger(backup, "StartInterval"), 60);
  assert.equal(plistInteger(backup, "ThrottleInterval"), 60);
  assert.equal(args[args.indexOf("--run-state") + 1], `${fixture.DATA_ROOT}/backup-run-state.json`);
  assert.equal(separator > 1, true);
  assert.equal(args.slice(0, separator).some((value) => value.includes("keychain-exec")), false);
  assert.equal(args.slice(separator + 1).filter((value) => value.endsWith("/keychain-exec.mjs")).length, 1);
  assert.equal(args.filter((value) => value === "AGE_IDENTITY=com.jihye.portal.age-identity").length, 1);
  assert.equal(args.filter((value) => value === "--automatic").length, 1);
  assert.equal(args.filter((value) => value === "--apply").length, 2);
  assert.deepEqual(args.filter((value, index) => args[index - 1] === "--source"), [
    `${fixture.DATA_ROOT}/portal.sqlite`,
    `${fixture.DATA_ROOT}/portal.sqlite`,
  ]);
  assert.deepEqual(args.filter((value, index) => args[index - 1] === "--root"), [
    fixture.BACKUP_ROOT,
    fixture.BACKUP_ROOT,
  ]);
  assert.doesNotMatch(backup, /\/Users\/wisdom\/portal\/ops\/scripts/);
  assert.match(newsyslog, /\/Users\/wisdom\/Library\/Logs\/WisdomPortal\/\*\.log\s+wisdom:staff\s+640\s+10\s+10240\s+\*\s+GJN/);
  assert.doesNotMatch(newsyslog, /world|777/i);
});

test("retention enforcement runs on a fixed bounded cadence in apply mode", async () => {
  const retention = await render("launchd/com.jihye.portal.retention.plist.template");

  assert.match(retention, /<key>StartInterval<\/key><integer>3600<\/integer>/);
  assert.match(retention, /apps\/control\/dist\/cli\/purge\.js/);
  assert.match(retention, /<string>--apply<\/string>/);
  assert.match(retention, /<string>--batch-size<\/string><string>1000<\/string>/);
  assert.match(retention, /<string>--max-batches<\/string><string>10<\/string>/);
  assert.match(retention, /\/Users\/wisdom\/portal\/current\/ops\/scripts\/keychain-exec\.mjs/);
  assert.doesNotMatch(retention, /\/Users\/wisdom\/portal\/ops\/scripts/);
});

test("monitoring template keeps external uptime separate from executable local checks", async () => {
  const monitoring = await render("monitoring/checks.json.template");
  const parsed = JSON.parse(monitoring);

  assert.deepEqual(parsed.externalPublic, {
    url: "https://www.example.test/health/live",
    expectedStatus: 200,
    expectedText: "ok",
    source: "outside-mac-and-lan",
  });
  assert.equal(parsed.local.thresholds.backupFreshnessMinutes, 90);
  assert.equal(parsed.local.thresholds.backupResumeGraceMinutes, 10);
  assert.equal(parsed.local.thresholds.diskFreePercentMinimum, 15);
  assert.equal(parsed.local.thresholds.queueStallMinutes, 15);
  assert.equal(parsed.local.thresholds.retentionOverdueMaximum, 0);
  assert.equal(parsed.local.thresholds.notificationFailureBacklogMaximum, 0);
  assert.equal(parsed.local.thresholds.translationFailureBacklogMaximum, 0);
  assert.equal(parsed.local.thresholds.publicationFailureBacklogMaximum, 0);
  assert.equal(parsed.local.thresholds.indexNowFailureBacklogMaximum, 0);
  assert.equal(parsed.local.controlReadyUrl, "http://127.0.0.1:8787/health/ready");
  assert.deepEqual(parsed.local.incidentState, {
    path: "/Users/wisdom/Library/Application Support/WisdomPortal/monitor-incident-state.json",
    cooldownMinutes: 30,
  });
  assert.equal(parsed.local.hermes.keychainService, "com.jihye.portal.monitor-hermes-hmac");
  assert.match(parsed.local.databasePath, /^\/Users\/wisdom\//u);
  assert.doesNotMatch(monitoring, /admin\.example\.test|telegram|api[_-]?key|password/i);
});

test("monitor launchd job is bounded and loads only its independent HMAC key", async () => {
  const monitor = await render("launchd/com.jihye.portal.monitor.plist.template");
  assert.match(monitor, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(monitor, /MONITOR_HERMES_HMAC_SECRET=com\.jihye\.portal\.monitor-hermes-hmac/);
  assert.match(monitor, /ops\/scripts\/monitor\.mjs/);
  assert.match(monitor, /--config<\/string><string>\/Users\/wisdom\/portal\/shared\/monitoring\.json/);
  assert.match(monitor, /--apply/);
  assert.doesNotMatch(monitor, /HERMES_HMAC_SECRET=com\.jihye\.portal\.hermes-hmac|telegram/i);
});

test("operations runbooks document recovery limits and reversible host guidance", async () => {
  const deployment = await readFile(path.join(opsRoot, "runbooks/deployment.md"), "utf8");
  const recovery = await readFile(path.join(opsRoot, "runbooks/recovery.md"), "utf8");
  const incidents = await readFile(path.join(opsRoot, "runbooks/incidents.md"), "utf8");

  assert.match(deployment, /FileVault[\s\S]*pre-login[\s\S]*user.*unlock/i);
  assert.match(deployment, /pmset[\s\S]*inspect[\s\S]*reversible/i);
  assert.match(deployment, /UPS[\s\S]*wired Ethernet[\s\S]*sleep/i);
  assert.match(recovery, /RPO[^\n]*60 minutes[\s\S]*RTO[^\n]*4 hours[\s\S]*non-guaranteed/i);
  assert.match(deployment, /protected verified status[\s\S]*stable artifact size[\s\S]*full SHA-256[\s\S]*restore/i);
  assert.match(deployment, /purge\.js --apply --batch-size 1000 --max-batches 10/i);
  assert.match(recovery, /secure_delete[\s\S]*100,000[\s\S]*no-progress/i);
  assert.match(recovery, /4,096[\s\S]*512[\s\S]*8[\s\S]*128 GiB/i);
  assert.match(incidents, /TRANSLATION_FAILURE_BACKLOG[\s\S]*terminal failed/i);
  for (const scenario of ["disk full", "tunnel outage", "certificate", "database corruption", "key loss", "notification backlog", "rollback"]) {
    assert.match(incidents, new RegExp(scenario, "i"));
  }
  assert.doesNotMatch(`${deployment}\n${recovery}\n${incidents}`, /port forwarding|open router port/i);
});

test("runbooks and release gate require local monitor and independent external uptime drills", async () => {
  const deployment = await readFile(path.join(opsRoot, "runbooks/deployment.md"), "utf8");
  const incidents = await readFile(path.join(opsRoot, "runbooks/incidents.md"), "utf8");
  const releaseCandidate = await readFile(path.resolve(opsRoot, "../docs/operations/release-candidate.md"), "utf8");

  assert.match(deployment, /monitor\.mjs[\s\S]*--validate-only[\s\S]*--dry-run/i);
  assert.match(deployment, /com\.jihye\.portal\.monitor-hermes-hmac/);
  assert.match(deployment, /--monitor-config/);
  assert.match(deployment, /launchctl[\s\S]*com\.jihye\.portal\.monitor/i);
  assert.match(deployment, /com\.jihye\.portal\.retention[\s\S]*(?:hour|시간)/i);
  assert.match(incidents, /RETENTION_OVERDUE[\s\S]*(?:purge|보유기간)/i);
  assert.match(incidents, /HERMES_HANDOFF_FAILED[\s\S]*metadata/i);
  assert.match(deployment, /apply mode[\s\S]*HMAC[\s\S]*before[\s\S]*checks/i);
  assert.match(incidents, /DB_TIMEOUT[\s\S]*child process[\s\S]*hard timeout/i);
  assert.match(incidents, /fingerprint[\s\S]*cooldown[\s\S]*no resolution alert/i);
  assert.match(incidents, /monitor-incident-state\.json[\s\S]*protected[\s\S]*atomic/i);
  assert.match(releaseCandidate, /실제 Mac mini[\s\S]*monitor.*dry-run/i);
  assert.match(releaseCandidate, /Mac.*LAN 밖[\s\S]*별도/i);
  assert.match(incidents, /Telegram bot[\s\S]*직접 호출하지 않는다/i);
});

test("Mac mini guide inventories inputs, uses real commands, and names every launch blocker", async () => {
  const guide = await readFile(path.resolve(opsRoot, "../docs/operations/mac-mini-setup.md"), "utf8");

  for (const required of [
    "외부 발급",
    "운영자 결정",
    "Mac 로컬 생성",
    "민감도",
    "저장 위치",
    "검증 방법",
    "분실 영향",
    "AGE-SECRET-KEY-1",
    "PII_ENCRYPTION_KEY",
    "FileVault",
    "Cloudflare Tunnel",
    "Google Search Console",
    "Naver Search Advisor",
    "IndexNow",
    "SMTP",
    "Hermes",
    "Telegram",
    "TOTP",
    "recovery code",
    "Codex",
    "npm run verify",
    "--automatic-backup-after-restore",
    "BACKUP_ADMIN_DISABLED",
    "공개 전 구현 필요",
    "현재 수동 검증 가능",
  ]) assert.match(guide, new RegExp(required, "i"), required);

  const commandText = guide
    .replace(/\\\r?\n\s*/gu, " ")
    .replaceAll('"', "")
    .replace(/\s+/gu, " ");
  for (const commandContract of [
    "secret-bootstrap.mjs --account",
    "secret-import.mjs --account",
    "seed-public.mjs --source-dist",
    "preflight.mjs --monitor-config",
    "deploy.mjs --source",
    "monitor.mjs --config",
    "--validate-only",
    "--dry-run",
    "admin:bootstrap",
    "admin:mfa-replace",
    "/admin/publish",
    "/admin/backups",
    "backup.mjs",
    "restore.mjs",
    "--confirm-destroy",
    "launchctl print gui/$PORTAL_UID",
  ]) assert.ok(commandText.includes(commandContract), commandContract);

  for (const blocker of [
    "production template render/install CLI",
    "first normal publication bootstrap",
    "Kakao URL publication allowlist",
    "Hermes HMAC provisioning",
    "tunnel-off Host-aware health probe",
    "all-Keychain offline recovery bundle",
    "automatic offsite backup replication",
    "stale PUBLIC_ORIGINS README mismatch",
  ]) assert.ok(guide.includes(blocker), blocker);

  for (const notRequired of [
    "Docker 계정·설치: 불필요",
    "WordPress 계정: 불필요",
    "Caddy 계정: 불필요",
    "age 서비스 계정: 불필요",
    "공유기 inbound port forwarding: 불필요",
    "수동 TLS 인증서: 불필요",
    "Kakao Developers API: 단순 링크에는 불필요",
    "Penpot 운영 runtime 접근: 불필요",
  ]) assert.ok(guide.includes(notRequired), notRequired);
});

test("operator entry points link the Mac guide and document only the singular public origin key", async () => {
  const readme = await readFile(path.resolve(opsRoot, "../README.md"), "utf8");
  const documentMap = await readFile(path.resolve(opsRoot, "../docs/00-document-map.md"), "utf8");
  const deployment = await readFile(path.join(opsRoot, "runbooks/deployment.md"), "utf8");
  const recovery = await readFile(path.join(opsRoot, "runbooks/recovery.md"), "utf8");

  assert.match(readme, /docs\/operations\/mac-mini-setup\.md/u);
  assert.match(documentMap, /operations\/mac-mini-setup\.md/u);
  assert.match(deployment, /docs\/operations\/mac-mini-setup\.md/u);
  assert.match(recovery, /docs\/operations\/mac-mini-setup\.md/u);
  assert.match(readme, /`PUBLIC_ORIGIN`/u);
  assert.doesNotMatch(readme, /\bPUBLIC_ORIGINS\b/u);
});

test("Mac guide stops existing schema-v6 deployments until a reviewed maintenance migration exists", async () => {
  const guide = await readFile(path.resolve(opsRoot, "../docs/operations/mac-mini-setup.md"), "utf8");
  const upgradeGate = guide.slice(
    guide.indexOf("### 3.1 기존 schema v6 설치의 추가 배포 중단 조건"),
    guide.indexOf("## 4. 필요하지 않은 계정·설정"),
  );

  assert.ok(upgradeGate.length > 0, "schema-v6 deployment stop section");
  assert.match(upgradeGate, /신규 빈 DB[\s\S]*user_version[\s\S]*0[\s\S]*schema v7/u);
  assert.match(upgradeGate, /기존 schema v6[\s\S]*deploy\.mjs --apply[\s\S]*실행하지 않는다/u);
  assert.match(upgradeGate, /DATABASE_MIGRATION_ROLLBACK_INCOMPATIBLE/u);
  assert.match(upgradeGate, /전용 v6→v7 maintenance migration[\s\S]*현재 구현되어 있지 않/u);
  assert.match(upgradeGate, /require-rollback-compatible[\s\S]*우회[\s\S]*user_version[\s\S]*수동/u);
  assert.match(upgradeGate, /ops\/runbooks\/deployment\.md#rollback-비호환-migration/u);
});

test("Mac guide classifies every input and gives every operational secret a lifecycle", async () => {
  const guide = await readFile(path.resolve(opsRoot, "../docs/operations/mac-mini-setup.md"), "utf8");
  const lines = guide.split(/\r?\n/u);
  const inventoryHeader = "| 필수 여부 | 구분 | 항목 | 발급처/생성 위치 | 값 형식·예 | 민감도 | 저장 위치 | 검증 방법 | 갱신·분실 영향 |";
  const inventoryStart = lines.indexOf(inventoryHeader);
  assert.notEqual(inventoryStart, -1, "nine-column inventory header");
  const inventoryEnd = lines.findIndex((line, index) => index > inventoryStart + 1 && !line.startsWith("|"));
  const inventoryRows = lines.slice(inventoryStart + 2, inventoryEnd);
  assert.equal(inventoryRows.length, 55, "complete inventory rows");
  const inventoryDataRows = inventoryRows.map((row) => row.split("|").slice(1, -1).map((column) => column.trim()));
  for (const columns of inventoryDataRows) {
    assert.equal(columns.length, 9, columns.join(" | "));
    assert.match(columns[0], /^(?:필수|조건부 필수|선택)$/u, columns.join(" | "));
  }
  assert.deepEqual(
    inventoryDataRows.filter((columns) => columns[0] === "조건부 필수").map((columns) => columns[2]),
    ["조건부 Cloudflare API token", "조건부 GitHub 계정·credential"],
    "only manual Cloudflare automation and a private Git remote are conditional",
  );
  const codexCredential = inventoryDataRows.find((columns) => columns[2] === "Codex CLI 인증·OpenAI API credential·billing");
  assert.equal(codexCredential[0], "필수", "approved AI translation/review requires Codex authentication");
  assert.match(codexCredential.join(" "), /로그인 또는 printable credential 중 택1/u);
  const cloudflareApiToken = inventoryDataRows.find((columns) => columns[2] === "조건부 Cloudflare API token");
  assert.match(cloudflareApiToken.join(" "), /수동 console 운영에는 불필요/u);
  const githubCredential = inventoryDataRows.find((columns) => columns[2] === "조건부 GitHub 계정·credential");
  assert.match(githubCredential.join(" "), /public remote면 생략하고 private remote면 필수/u);

  const lifecycleHeader = "| 비밀·reference | Keychain service 또는 저장 위치 | 사용 프로세스 | 회전 가능 여부 | 분실 영향 | 복구 시험 |";
  const lifecycleStart = lines.indexOf(lifecycleHeader);
  assert.notEqual(lifecycleStart, -1, "secret lifecycle table");
  const lifecycleEnd = lines.findIndex((line, index) => index > lifecycleStart + 1 && !line.startsWith("|"));
  const lifecycle = lines.slice(lifecycleStart, lifecycleEnd).join("\n");
  for (const secret of [
    "admin session", "control HMAC", "Hermes HMAC", "monitor HMAC", "PII encryption key",
    "withdrawal token", "age identity", "age recipient", "IndexNow", "SMTP", "Codex",
  ]) assert.match(lifecycle, new RegExp(secret, "i"), secret);

  const externalHeader = "| 외부·운영자 비밀·계정 | 저장 위치·소유자 | 사용자·consumer | 회전·폐기 | 분실 영향 | 복구 시험 |";
  const externalStart = lines.indexOf(externalHeader);
  assert.notEqual(externalStart, -1, "external/operator credential lifecycle table");
  const externalEnd = lines.findIndex((line, index) => index > externalStart + 1 && !line.startsWith("|"));
  const externalRows = lines.slice(externalStart + 2, externalEnd);
  assert.equal(externalRows.length, 15, "every external/operator credential has one lifecycle row");
  for (const row of externalRows) {
    const columns = row.split("|").slice(1, -1).map((column) => column.trim());
    assert.equal(columns.length, 6, row);
    assert.ok(columns.every(Boolean), row);
  }

  const secretCoverage = new Map([
    ["원격접속 방식", ["원격접속 계정·MFA"]],
    ["FileVault unlock 담당자와 복구 수단", ["FileVault 복구 수단"]],
    ["도메인 등록기관 계정", ["도메인 등록기관 계정·MFA"]],
    ["Cloudflare 계정과 zone", ["Cloudflare 계정·MFA"]],
    ["Cloudflare Tunnel credential", ["Cloudflare Tunnel credential"]],
    ["조건부 Cloudflare API token", ["Cloudflare API token"]],
    ["Google 계정", ["Google 계정·MFA"]],
    ["Naver 계정", ["Naver 계정·MFA"]],
    ["SMTP 계정", ["SMTP 제공자 계정·MFA"]],
    ["SMTP app password", ["SMTP credential/reference"]],
    ["Portal/Hermes 일반 HMAC", ["Hermes HMAC"]],
    ["Portal/Hermes monitor HMAC", ["monitor HMAC"]],
    ["Telegram bot token·chat ID", ["Telegram bot token·chat ID"]],
    ["Codex CLI 인증·OpenAI API credential·billing", ["Codex credential/reference"]],
    ["owner password", ["owner password"]],
    ["TOTP enrollment", ["owner TOTP"]],
    ["recovery code 10개", ["owner recovery codes"]],
    ["admin session secret", ["admin session secret"]],
    ["control HMAC", ["control HMAC"]],
    ["PII encryption key와 active key ID", ["PII encryption key"]],
    ["withdrawal token secret", ["withdrawal token secret"]],
    ["age identity·recipient", ["age identity", "age recipient"]],
    ["조건부 GitHub 계정·credential", ["GitHub private credential"]],
    ["외부 uptime 계정·알림 대상", ["external uptime account/MFA"]],
  ]);
  const secretInventoryItems = inventoryDataRows.filter((columns) => columns[5].includes("비밀")).map((columns) => columns[2]).sort();
  assert.deepEqual([...secretCoverage.keys()].sort(), secretInventoryItems, "every secret inventory item has lifecycle coverage");
  const allLifecycle = lines.slice(lifecycleStart, lines.indexOf("## 2. 암호화 계층과 완전 복구 경계")).join("\n");
  for (const [inventoryItem, lifecycleNames] of secretCoverage) {
    for (const lifecycleName of lifecycleNames) assert.ok(allLifecycle.includes(lifecycleName), `${inventoryItem}: ${lifecycleName}`);
  }

});

test("Mac guide shell procedures fail closed and never print process argv", async () => {
  const guide = await readFile(path.resolve(opsRoot, "../docs/operations/mac-mini-setup.md"), "utf8");
  const shellBlocks = [...guide.matchAll(/```sh\r?\n([\s\S]*?)```/gu)].map((match) => match[1]);
  const shellLines = shellBlocks.flatMap((block) => block.split(/\r?\n/u));
  const unguardedTests = shellLines.filter((line) => /^\s*test\b/u.test(line) && !/\|\|\s*exit 1\s*$/u.test(line));
  assert.deepEqual(unguardedTests, [], `unguarded test predicates:\n${unguardedTests.join("\n")}`);

  const logicalCommands = shellBlocks.join("\n").replace(/\\\r?\n\s*/gu, " ").split(/\r?\n/u);
  const unguardedApply = logicalCommands.filter((line) => /--apply\b/u.test(line) &&
    !/\|\|\s*exit 1\s*$/u.test(line) &&
    !/^\s*if\b[\s\S]*;\s*then\s*$/u.test(line));
  assert.deepEqual(unguardedApply, [], `unguarded apply commands:\n${unguardedApply.join("\n")}`);
  const unguardedMutations = logicalCommands.filter((line) => /^\s*(?:chmod|mkdir|rmdir|rm -f|launchctl (?:bootout|bootstrap|kickstart))\b/u.test(line) && !/\|\|\s*exit 1\s*$/u.test(line));
  assert.deepEqual(unguardedMutations, [], `unguarded mutation commands:\n${unguardedMutations.join("\n")}`);

  assert.match(guide, /전용 shell 세션[\s\S]*fail-fast[\s\S]*`\|\| exit 1`/u);
  assert.doesNotMatch(shellBlocks.join("\n"), /^\s*set -e\b/mu);
  assert.match(guide, /test -f "\$CLOUDFLARED_CREDENTIALS_FILE" \|\| exit 1/u);
  assert.match(guide, /AGE_KEYGEN_BINARY[\s\S]*-o "\$AGE_KEYGEN_OUTPUT" \|\| exit 1/u);
  assert.match(guide, /find-generic-password[\s\S]*INDEXNOW_KEYCHAIN_SERVICE[\s\S]*\|\| exit 1/u);
  assert.doesNotMatch(guide, /ps[^\n]*\bcommand\b/u);
  assert.match(guide, /ps -axo pid=,ppid=,%cpu=,%mem=,comm=/u);
});

test("Mac guide restore drill proves outage boundaries, wrong-key rejection, and MFA cleanup", async () => {
  const guide = await readFile(path.resolve(opsRoot, "../docs/operations/mac-mini-setup.md"), "utf8");
  const commandText = guide.replace(/\\\r?\n\s*/gu, " ").replaceAll('"', "").replace(/\s+/gu, " ");

  assert.match(guide, /maintenance window[\s\S]*별도 target[\s\S]*(?:production|운영) service[\s\S]*(?:중단|outage)[\s\S]*external uptime/i);
  for (const label of ["control", "notification-worker", "content-worker"]) {
    assert.ok(commandText.includes(`launchctl bootout gui/$PORTAL_UID/com.jihye.portal.${label} || exit 1`), `bootout ${label}`);
    assert.match(guide, new RegExp(`launchctl print "gui/\\$PORTAL_UID/com\\.jihye\\.portal\\.${label}"[\\s\\S]*state[\\s\\S]*running`, "u"), `running ${label}`);
  }
  assert.match(guide, /restore apply[\s\S]*(?:production|운영) readiness/u);

  const wrongKey = guide.slice(guide.indexOf("### 21.3 wrong identity"), guide.indexOf("### 21.4"));
  for (const prerequisite of [
    /test -x "\$AGE_BINARY" \|\| exit 1/u,
    /test -x "\$AGE_KEYGEN_BINARY" \|\| exit 1/u,
    /test -f "\$BACKUP_ARTIFACT".*\|\| exit 1/u,
    /test ! -L "\$BACKUP_ARTIFACT".*\|\| exit 1/u,
    /test "\$WRONG_RECIPIENT" != "\$AGE_RECIPIENT" \|\| exit 1/u,
    /test ! -e "\$WRONG_OUTPUT" \|\| exit 1/u,
    /no identity matched any of the recipients/u,
    /correct-identity restore.*(?:passed|통과)/iu,
  ]) assert.match(wrongKey, prerequisite);
  assert.match(wrongKey, /WRONG_STDERR_BYTES[\s\S]*4096/u);
  assert.match(wrongKey, /test ! -e "\$WRONG_OUTPUT" \|\| exit 1[\s\S]*rm -f/u);

  const mfa = guide.slice(guide.indexOf("MFA 장치 교체"), guide.indexOf("## 15."));
  assert.match(mfa, /새 TOTP[\s\S]*recovery code[\s\S]*새 로그인[\s\S]*rm -f "\$OWNER_MFA_REPLACEMENT" \|\| exit 1[\s\S]*unset OWNER_MFA_REPLACEMENT/u);
  assert.match(guide, /rollback dry-run[\s\S]*문법[\s\S]*apply[\s\S]*retained release[\s\S]*manifest[\s\S]*migration[\s\S]*canary[\s\S]*pointer/iu);
});

test("Mac guide distinguishes missing launchd jobs and recovers every early restore exit", async () => {
  const guide = await readFile(path.resolve(opsRoot, "../docs/operations/mac-mini-setup.md"), "utf8");
  const commandText = guide.replace(/\\\r?\n\s*/gu, " ").replace(/\s+/gu, " ");

  assert.match(guide, /validate_launchctl_missing_service\(\)[\s\S]*Could not find service[\s\S]*in domain for user gui:[\s\S]*Bad request\.[\s\S]*NR == 1[\s\S]*NR == 2/u);
  assert.doesNotMatch(guide, /grep -Eiq 'Could not find service\|service not found'/u);

  const cloudflaredProbe = guide.slice(guide.indexOf("CLOUDFLARED_PROBE_ERROR"), guide.indexOf("npm run build:fixture"));
  assert.match(cloudflaredProbe, /stat -f '%z'[\s\S]*1024/u);
  assert.match(cloudflaredProbe, /validate_launchctl_missing_service "\$CLOUDFLARED_PROBE_ERROR" 'com\.jihye\.portal\.cloudflared' \|\| exit 1/u);

  const restore = guide.slice(guide.indexOf("### 21.2"), guide.indexOf("### 21.3"));
  const restoreHelperIndex = restore.indexOf("validate_launchctl_missing_service()");
  const restoreFirstProbeIndex = restore.indexOf('validate_launchctl_missing_service "$RESTORE_CONTROL_PROBE"');
  assert.ok(restoreHelperIndex >= 0, "restore shell defines its own missing-service validator");
  assert.ok(restoreHelperIndex < restoreFirstProbeIndex, "restore validator is defined before its first use");
  assert.match(restore, /validate_launchctl_missing_service\(\)[\s\S]*Could not find service[\s\S]*Bad request\.[\s\S]*NR == 1[\s\S]*NR == 2/u);
  assert.match(guide, /새 로그인 또는 새 shell 세션[\s\S]*5절[\s\S]*환경 변수[\s\S]*다시 실행/u);
  assert.match(restore, /RESTORE_RECOVERY_ARMED=yes/u);
  assert.match(restore, /trap ['"]?restore_recovery_handler['"]? EXIT HUP INT TERM/u);
  for (const label of ["control", "notification-worker", "content-worker"]) {
    assert.match(restore, new RegExp(`validate_launchctl_missing_service [^\\n]*['\"]com\\.jihye\\.portal\\.${label}['\"] \\|\\| exit 1`, "u"), `missing proof ${label}`);
    assert.match(restore, new RegExp(`launchctl kickstart -k [^\\n]*com\\.jihye\\.portal\\.${label}`, "u"), `recovery ${label}`);
  }

  const readyIndex = restore.indexOf('curl -fsS "http://127.0.0.1:8787/health/ready" >/dev/null || exit 1');
  const disarmIndex = restore.indexOf("RESTORE_RECOVERY_ARMED=no");
  const flagIndex = restore.indexOf("CORRECT_IDENTITY_RESTORE_VERIFIED=yes");
  assert.ok(readyIndex >= 0, "readiness uses HTTP success rather than a wrong response literal");
  assert.ok(disarmIndex > readyIndex, "recovery remains armed through readiness");
  assert.ok(flagIndex > disarmIndex, "correct-identity marker follows recovery disarm");
  assert.doesNotMatch(commandText, /health\/ready[^\n]*grep -Fq ['"]ok['"]/u);
});
