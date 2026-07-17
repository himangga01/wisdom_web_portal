# Production Template Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a dry-run-first, secret-free macOS CLI that renders, validates, and atomically installs every production operations template from one protected versioned JSON values file.

**Architecture:** `ops/lib/config-installer.mjs` owns the exact template inventory, strict values contract, rendering, validation orchestration, and rollback-safe publication. `ops/scripts/config-install.mjs` owns strict argv parsing and fixed macOS child-process/filesystem adapters. User and system scopes are separate so root-only newsyslog installation cannot rewrite user configuration.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, existing template/runtime/monitor parsers, macOS `plutil` and `newsyslog`, Caddy and cloudflared CLIs.

## Global Constraints

- Default operation is dry-run; filesystem mutation requires `--apply` plus exact target confirmations.
- No Keychain access, credential-file reads, `launchctl`, shell execution, secret values, or rendered contents in output.
- Input and rendered files are bounded at 64 KiB; all relevant symlinks and group/world-writable protected files are rejected.
- User scope installs twelve files; system scope installs only `/etc/newsyslog.d/wisdom-portal.conf`.
- Every behavior follows TDD: add one failing test, observe the intended failure, then write minimal production code.
- Implementation remains on `codex/admin-backup-mac-setup`; do not modify `master`.

---

### Task 1: Exact Template Inventory and Protected Values Contract

**Files:**
- Create: `ops/lib/config-installer.mjs`
- Create: `ops/tests/config-installer.test.mjs`
- Create: `ops/config/production-values.example.json`

**Interfaces:**
- Produces: `CONFIG_TEMPLATE_DESCRIPTORS`, `CONFIG_TOKEN_NAMES`, `parseProductionValues(source)`, `readProductionValuesFile(filePath, adapters)`.
- Consumes: `renderTemplate` from `ops/lib/templates.mjs` in later tasks.

- [x] **Step 1: Write failing inventory and parser tests**

Create tests that import the four exports and assert:

```js
assert.equal(CONFIG_TEMPLATE_DESCRIPTORS.length, 13);
assert.equal(CONFIG_TEMPLATE_DESCRIPTORS.filter(({ scope }) => scope === "user").length, 12);
assert.equal(CONFIG_TEMPLATE_DESCRIPTORS.filter(({ scope }) => scope === "system").length, 1);

const parsed = parseProductionValues(JSON.stringify({ schemaVersion: 1, values: fixtureValues }));
assert.deepEqual(Object.keys(parsed).sort(), [...CONFIG_TOKEN_NAMES]);
assert.throws(() => parseProductionValues(JSON.stringify({
  schemaVersion: 1,
  values: { ...fixtureValues, TELEGRAM_BOT_TOKEN: "forbidden" },
})), { code: "CONFIG_VALUES_INVALID" });
```

Add table cases for missing token, extra token, wrong schema, arrays, non-string/empty values, NUL/CR/LF, source over 64 KiB, loopback hosts, DNS names, port range/canonical form, distinct hosts, UUID, age recipient, user name, absolute normalized paths, target-derived paths, and unsafe root overlap.

Add real-file cases for relative path, symlink, directory, over-size, and POSIX mode `0644`; the accepted fixture is a regular `0600` file.

- [x] **Step 2: Run the focused test and observe RED**

Run:

```powershell
node --test ops/tests/config-installer.test.mjs
```

Expected: FAIL because `ops/lib/config-installer.mjs` does not exist.

- [x] **Step 3: Implement the exact descriptors and strict parser**

Define descriptors with stable IDs, source paths, scope, target resolver, and mode. Export the immutable sorted 35-token list derived from descriptor templates. `USER_HOME` and `RELEASE_ROOT` are not accepted values; derive them from the exact `APP_ROOT=/Users/<USER_NAME>/portal` contract. `parseProductionValues` requires exact top-level and token keys, then applies the approved cross-field invariants. All failures expose a stable `CONFIG_VALUES_INVALID` code without values.

Implement `readProductionValuesFile` with absolute-path, regular non-symlink, 64 KiB, single-read identity, and POSIX `mode & 0o077 === 0` checks. It returns only the parsed immutable token map.

- [x] **Step 4: Add the exact placeholder-only example**

Create schema version 1 JSON with every key in `CONFIG_TOKEN_NAMES`, fixture/example values only, no private key, token, password, API credential, or deployable domain. The example must parse successfully but remain visibly non-production.

- [x] **Step 5: Run focused tests GREEN and commit**

Run the focused test and `git diff --check`, then commit:

```powershell
git add ops/lib/config-installer.mjs ops/tests/config-installer.test.mjs ops/config/production-values.example.json
git commit -m "feat: validate production template values"
```

---

### Task 2: Render and Validate a Secret-Free Dry-Run Plan

**Files:**
- Modify: `ops/lib/config-installer.mjs`
- Modify: `ops/tests/config-installer.test.mjs`
- Modify: `ops/tests/configuration.test.mjs`

**Interfaces:**
- Produces: `buildConfigurationPlan({ opsRoot, values, scope }, adapters)` returning `{ schemaVersion: 1, scope, applied: false, artifacts }`.
- Each artifact is exactly `{ id, sha256, changed }`; it contains no source, target path, or rendered content.

- [ ] **Step 1: Write failing render/validation tests**

Use real repository templates and temporary existing targets. Inject validators that record only artifact IDs. Assert that user scope validates runtime, monitoring, eight plists, Caddy, and cloudflared; system scope validates only newsyslog. Assert `parseRuntimeConfig` and `parseMonitoringConfig` failures map to `CONFIG_VALIDATION_FAILED`.

Add tests proving all validation completes before any target write, unresolved tokens fail, each artifact is at most 64 KiB, unchanged digests report `changed: false`, and reports contain neither fixture values nor absolute paths.

- [ ] **Step 2: Run focused tests RED**

Expected: FAIL because `buildConfigurationPlan` is missing.

- [ ] **Step 3: Implement rendering and validation orchestration**

For the selected fixed descriptors, call `renderTemplate`, reject remaining `{{TOKEN}}`, enforce the bound, parse internal configuration, and invoke the descriptor-specific injected validator with staged bytes. Hash with SHA-256 and compare only against a securely inspected regular existing target. Map child/parser details to `CONFIG_VALIDATION_FAILED`.

- [ ] **Step 4: Add repository inventory contract tests**

Enumerate `ops/**/*.template` and assert it equals descriptor sources exactly. Parse the example and assert its keys equal the union of actual repository tokens. This makes an added template or token fail CI until deliberately added to the installer.

- [ ] **Step 5: Run configuration and installer tests GREEN and commit**

```powershell
node --test ops/tests/config-installer.test.mjs ops/tests/configuration.test.mjs
git add ops/lib/config-installer.mjs ops/tests/config-installer.test.mjs ops/tests/configuration.test.mjs
git commit -m "feat: validate rendered production configuration"
```

---

### Task 3: Atomic Apply and Rollback

**Files:**
- Modify: `ops/lib/config-installer.mjs`
- Modify: `ops/tests/config-installer.test.mjs`

**Interfaces:**
- Produces: `installConfiguration(input, adapters)` returning the same sanitized plan with `applied: true` after verified publication.
- Consumes the fully rendered/validated in-memory artifacts from Task 2; it never re-renders after mutation starts.

- [ ] **Step 1: Write failing confirmation and platform tests**

Assert dry-run never invokes target mutations. Assert apply rejects non-darwin, missing/mismatched `confirmAppRoot` and `confirmUserHome`, system scope without root, and missing/mismatched `confirmSystemTarget` with stable codes.

- [ ] **Step 2: Write failing filesystem transaction tests**

With real temp directories and injected failure hooks, cover:

```js
const result = await installConfiguration(input, adapters);
assert.equal(result.applied, true);
assert.equal((await stat(runtimeTarget)).mode & 0o777, 0o600);
assert.equal(await readFile(runtimeTarget, "utf8"), expectedRuntime);
```

Also assert target-parent symlink, existing-target symlink/directory/wrong owner, group/world-writable parent, mid-publication failure rollback, newly created target removal, previous file restoration, rollback-failure code, unchanged file preservation, post-install digest mismatch rejection, and no leftover sibling temp files.

- [ ] **Step 3: Run focused tests RED**

Expected: FAIL because `installConfiguration` is missing.

- [ ] **Step 4: Implement publish/verify/rollback**

Before mutation, secure every target parent and existing target, capture bounded previous bytes and metadata, and create all sibling temporary files with `O_CREAT|O_EXCL|O_NOFOLLOW`, exact mode, file `fsync`, and closed handles. Rename in descriptor order and `fsync` each parent. On failure, restore previous files through new sibling temporaries or remove newly created targets; a restoration failure becomes `CONFIG_ROLLBACK_FAILED`. Reopen and verify mode, regular identity, size, and digest before reporting success.

- [ ] **Step 5: Run focused tests GREEN and commit**

```powershell
node --test ops/tests/config-installer.test.mjs
git add ops/lib/config-installer.mjs ops/tests/config-installer.test.mjs
git commit -m "feat: atomically install production configuration"
```

---

### Task 4: Strict macOS CLI and External Validators

**Files:**
- Create: `ops/scripts/config-install.mjs`
- Modify: `ops/lib/config-installer.mjs`
- Modify: `ops/tests/config-installer.test.mjs`
- Modify: `ops/tests/cli-dry-run.test.mjs`

**Interfaces:**
- Produces: `parseConfigInstallArguments(argv)` and executable `main(argv, dependencies)`.
- CLI emits one JSON report on stdout or `Configuration install failed: <CODE>` on stderr.

- [ ] **Step 1: Write failing argv/CLI tests**

Cover exact accepted forms for user/system dry-run and apply. Reject positional arguments, duplicate/unknown flags, missing values, non-absolute values path, apply without confirmations, cross-scope confirmation flags, and explicit secrets. Assert dry-run exit 0 and sanitized failure exit 1.

- [ ] **Step 2: Write failing child-adapter tests**

Inject `spawn` and assert fixed argv, `shell: false`, no inherited template values, 10-second timeout, bounded 4 KiB combined output, and kill on timeout/overflow for:

```text
/usr/bin/plutil -lint <staged-plist>
<CADDY_BINARY> validate --config <staged-caddy> --adapter caddyfile
<CLOUDFLARED_BINARY> --config <staged-yaml> tunnel ingress validate
/usr/sbin/newsyslog -n -f <staged-config>
```

- [ ] **Step 3: Run focused tests RED**

Expected: FAIL because the CLI is missing.

- [ ] **Step 4: Implement strict CLI and adapters**

The script imports no Keychain or launchd module. It creates a private mode-`0700` staging directory, writes only selected rendered artifacts for external validation, always cleans it in `finally`, and calls `installConfiguration`. Output contains only the sanitized report. Export parser/main for tests and execute main only when the module is the process entry point.

- [ ] **Step 5: Run CLI and installer tests GREEN and commit**

```powershell
node --test ops/tests/config-installer.test.mjs ops/tests/cli-dry-run.test.mjs
git add ops/scripts/config-install.mjs ops/lib/config-installer.mjs ops/tests/config-installer.test.mjs ops/tests/cli-dry-run.test.mjs
git commit -m "feat: add production configuration installer CLI"
```

---

### Task 5: Operator Guide and Launch-Blocker Update

**Files:**
- Modify: `docs/operations/mac-mini-setup.md`
- Modify: `ops/runbooks/deployment.md`
- Modify: `docs/operations/release-candidate.md`
- Modify: `ops/tests/configuration.test.mjs`

**Interfaces:**
- Documents the exact Task 4 CLI only; no invented alias or hidden prerequisite.

- [ ] **Step 1: Write failing documentation-contract tests**

Require the exact values-file permission check, user dry-run/apply with both confirmations, separate sudo system apply, sanitized report fields, post-install `plutil`/Caddy/cloudflared/newsyslog validation, and explicit statement that the CLI does not start launchd or read secrets. Change blocker 1 from `공개 전 구현 필요` to `구현 완료·Mac 실장비 검증 필요`; leave blockers 2–7 unchanged.

- [ ] **Step 2: Run configuration tests RED**

Expected: FAIL because documentation still describes the CLI as absent.

- [ ] **Step 3: Update guide/runbooks/checklist**

Replace the manual rehearsal section with exact commands. Require the values file to be real `0600`, run both scopes dry-run before either apply, execute user apply as the portal user, execute only system scope with `sudo`, rerun external validators, and keep cloudflared unloaded until later preflight. Record real-Mac ownership/atomic-replace/rollback drill as the remaining evidence for blocker 1.

- [ ] **Step 4: Run documentation and focused Ops tests GREEN and commit**

```powershell
node --test ops/tests/configuration.test.mjs ops/tests/config-installer.test.mjs ops/tests/cli-dry-run.test.mjs
git add docs/operations/mac-mini-setup.md ops/runbooks/deployment.md docs/operations/release-candidate.md ops/tests/configuration.test.mjs
git commit -m "docs: operate production configuration installer"
```

---

### Task 6: Verification, Review, and GitHub Update

**Files:**
- Modify: `docs/superpowers/plans/2026-07-17-production-template-installer.md` checkboxes only.

- [ ] **Step 1: Run focused security and placeholder scans**

```powershell
rg -n "T[B]D|T[O]DO|implement later" ops docs README.md
rg -n "AGE-SECRET-KEY-1[A-Z0-9]+|ghp_[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|TELEGRAM.*TOKEN=|CODEX_API_KEY=" ops docs README.md
git diff --check origin/master...HEAD
```

Only literal scan commands inside plan documents may match.

- [ ] **Step 2: Run focused and full verification**

```powershell
node --test ops/tests/config-installer.test.mjs ops/tests/configuration.test.mjs ops/tests/cli-dry-run.test.mjs
npm.cmd run verify
```

Expected: zero failures; only existing platform-specific skips are permitted.

- [ ] **Step 3: Review the implementation against the approved spec**

Verify each input, inventory, scope, validation, atomicity, rollback, output, and out-of-scope rule directly against code/tests. Reproduce any Important/Critical finding with a failing test before changing production code.

- [ ] **Step 4: Mark plan complete, commit review corrections, and push**

```powershell
git add -u
git commit -m "fix: address configuration installer review findings"
git push
git status --short --branch
```

Do not create an empty correction commit. The existing draft PR must update to the final branch HEAD.
