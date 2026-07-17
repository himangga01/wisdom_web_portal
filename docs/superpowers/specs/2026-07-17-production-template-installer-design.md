# Production Template Installer Design

**Status:** Approved on 2026-07-17
**Scope:** Close the `production template render/install CLI` public-launch blocker without starting services or reading secrets.

## 1. Goal

Provide one production CLI that reads a protected JSON values file, renders every operational template with an exact non-secret token set, validates all rendered artifacts before mutation, and installs them with restrictive permissions and atomic replacement. The CLI is dry-run by default. It never reads Keychain values, Cloudflare credential contents, consultation data, or age private identities, and it never invokes `launchctl`.

## 2. Considered approaches

1. **Protected JSON values file — selected.** One bounded versioned file holds the exact template-token map. It is reviewable, repeatable across dry-run/apply, avoids dozens of command-line arguments, and can be protected with mode `0600`.
2. **One CLI flag per token — rejected.** More than forty values would make omission, quoting, shell-history, and operator-review failures likely.
3. **Ambient environment variables — rejected.** Inherited state is difficult to audit and can leak unrelated values into rendering.

## 3. Components

- `ops/lib/config-installer.mjs`: pure manifest parsing, template inventory, rendering, invariant validation, install planning, atomic file publication, and rollback.
- `ops/scripts/config-install.mjs`: strict argument parser, macOS adapters, external validators, dry-run/apply output, and sanitized errors.
- `ops/config/production-values.example.json`: placeholder-only example with every accepted token and no deployable credential.
- `ops/tests/config-installer.test.mjs`: library and CLI contract tests using real temporary files plus injected external validators.
- `ops/tests/configuration.test.mjs`: repository-level checks that every template is owned by the installer inventory and the example contains the exact token set.
- `docs/operations/mac-mini-setup.md` and `ops/runbooks/deployment.md`: exact dry-run, user-scope apply, system-scope apply, and post-install validation commands.

## 4. Input contract

The values file is UTF-8 JSON with a 64 KiB maximum:

```json
{
  "schemaVersion": 1,
  "values": {
    "ADMIN_HOST": "admin.example.test"
  }
}
```

The top-level keys are exactly `schemaVersion` and `values`; `schemaVersion` is exactly `1`. `values` must contain exactly the 35-token union found in the frozen installer template inventory. Missing and extra keys fail. `USER_HOME` and `RELEASE_ROOT` are not template tokens and are not accepted as extra values; the installer derives them from the exact `APP_ROOT=/Users/<USER_NAME>/portal` contract. Every value is a non-empty string with no NUL, CR, or LF. The file path must be absolute, the file must be a regular non-symlink, and POSIX group/world permissions must be zero.

The installer additionally enforces these cross-field invariants:

- `CONTROL_HOST` and `CADDY_BIND` are exactly `127.0.0.1`.
- `APEX_HOST`, `PUBLIC_HOST`, and `ADMIN_HOST` are normalized DNS hostnames without schemes, ports, paths, wildcard labels, or trailing dots; all three are distinct.
- numeric ports are canonical decimal integers from 1 through 65535 and are pairwise non-conflicting where they bind locally.
- `TUNNEL_ID` is a canonical UUID and `AGE_RECIPIENT` is an age public recipient, never an identity.
- `USER_NAME` is a bounded macOS account identifier.
- all token names ending in `_ROOT`, `_HOME`, `_BINARY`, `_FILE`, `_CONFIG`, or `_RELEASE` are normalized absolute paths.
- `APP_ROOT` is exactly `/Users/<USER_NAME>/portal`; `USER_HOME` is derived as its parent. `CADDY_CONFIG` and `CLOUDFLARED_CONFIG` agree with installer-derived shared targets.
- `CURRENT_RELEASE`, derived `RELEASE_ROOT`, `PUBLIC_CURRENT_RELEASE`, and `PUBLIC_RELEASE_ROOT` are exactly the separate `APP_ROOT/current`, `APP_ROOT/releases`, `APP_ROOT/public-current`, and `APP_ROOT/public-releases` paths; data, backup, log, temp, and release roots cannot nest unsafely.
- values are treated as internal configuration and are never printed. The exact allowlist contains references and public material only; keys such as application secrets, SMTP passwords, Telegram tokens, Cloudflare credential bodies, Codex API credentials, and age identities are rejected as extras.

## 5. Template inventory and targets

The inventory is code-owned rather than supplied by the values file.

### User scope

`--scope user` renders and installs:

- `config/runtime.env.template` → `APP_ROOT/shared/runtime.env`, mode `0600`
- `monitoring/checks.json.template` → `APP_ROOT/shared/monitoring.json`, mode `0600`
- `caddy/Caddyfile.template` → `APP_ROOT/shared/Caddyfile`, mode `0600`
- `cloudflared/config.yml.template` → `APP_ROOT/shared/cloudflared.yml`, mode `0600`
- all eight `launchd/com.jihye.portal.*.plist.template` files → `USER_HOME/Library/LaunchAgents/*.plist`, mode `0600`

Apply requires macOS plus both exact confirmations:

```text
--apply --confirm-app-root <APP_ROOT> --confirm-user-home <USER_HOME>
```

It only installs files. Loading, unloading, bootstrapping, or restarting launchd services remains an explicit later operational step after preflight.

### System scope

`--scope system` renders only:

- `newsyslog/wisdom-portal.conf.template` → `/etc/newsyslog.d/wisdom-portal.conf`, mode `0644`

Apply requires macOS, effective user ID `0`, and:

```text
--apply --confirm-system-target /etc/newsyslog.d/wisdom-portal.conf
```

Separating scopes prevents a root-run system-file operation from silently rewriting user LaunchAgents or application configuration.

## 6. Render and validation flow

1. Parse CLI arguments with no positional values, duplicates, unknown flags, or environment fallback.
2. Securely read and parse the protected values file.
3. Enumerate the fixed template descriptors and verify that repository `.template` files match the inventory exactly.
4. Render every artifact for the selected scope with the existing strict template renderer.
5. Reject unresolved tokens and enforce a 64 KiB per-artifact limit.
6. Parse `runtime.env` with `parseRuntimeConfig` and `monitoring.json` with `parseMonitoringConfig`.
7. Validate every plist with `/usr/bin/plutil -lint` against a private staging file.
8. Validate Caddy with the configured `CADDY_BINARY validate --config <staged> --adapter caddyfile`.
9. Validate cloudflared ingress with the configured `CLOUDFLARED_BINARY --config <staged> tunnel ingress validate`.
10. Validate system scope with `/usr/sbin/newsyslog -n -f <staged>`.
11. Produce a sanitized plan containing only scope, artifact IDs, SHA-256 digests, change status, and `applied: false`.
12. In apply mode, verify target parent directories are real non-symlink directories with no group/world write permission, then publish through sibling temporary files, `fsync`, `chmod`, and atomic rename.
13. If publication of any later artifact fails, restore every earlier target from its bounded previous bytes or remove newly created targets. A rollback failure returns a distinct sanitized fatal code.
14. Reopen every installed file, verify regular non-symlink identity, exact mode, size, and SHA-256, then return `applied: true`.

Dry-run performs all parsing, rendering, internal validation, and external validator calls in a private temporary directory but never touches a target path.

## 7. Filesystem and error safety

- Apply rejects non-macOS platforms. Library tests inject a platform and adapters; Windows is supported only for tests and dry-run planning.
- Input, template, staging, target-parent, and existing target symlinks are rejected.
- Target parents must already exist; the installer does not create the Mac directory layout or broaden permissions.
- Existing target files may be replaced only if they are regular non-symlinks owned by the invoking account in user scope or root in system scope.
- No rendered contents, template values, absolute paths, child stdout/stderr, or previous file bytes appear in normal or error output.
- External commands use fixed absolute executables, fixed argument arrays, `shell: false`, bounded output, and a 10-second timeout.
- Error output is one stable code such as `CONFIG_INPUT_INVALID`, `CONFIG_VALUES_INVALID`, `CONFIG_VALIDATION_FAILED`, `CONFIG_TARGET_INVALID`, `CONFIG_INSTALL_FAILED`, or `CONFIG_ROLLBACK_FAILED`.

## 8. CLI surface

```text
node ops/scripts/config-install.mjs \
  --values /absolute/production-values.json \
  --scope user

node ops/scripts/config-install.mjs \
  --values /absolute/production-values.json \
  --scope user \
  --apply \
  --confirm-app-root /Users/wisdom/portal \
  --confirm-user-home /Users/wisdom

sudo /absolute/node ops/scripts/config-install.mjs \
  --values /absolute/production-values.json \
  --scope system \
  --apply \
  --confirm-system-target /etc/newsyslog.d/wisdom-portal.conf
```

The values file itself is never accepted through stdin or a command-line JSON string because both make repeatable review and protected-file checks weaker.

## 9. Testing

Tests must first fail for each new behavior and then cover:

- exact values-file shape, size, permission, symlink, missing-token, extra-token, control-character, host, port, UUID, recipient, and path rejection
- repository template inventory completeness and exact example-token equality
- user/system target mapping and modes
- dry-run zero target writes and apply confirmation requirements
- internal runtime and monitoring parsers
- external validator argv, timeout, output bounds, and sanitized failures
- all validation before the first target mutation
- atomic replacement, unchanged-file handling, rollback of created/replaced files, rollback-failure distinction, installed digest/mode verification, and symlink-swap rejection
- no Keychain, launchctl, credential-file read, or secret-shaped output
- CLI exit codes and JSON report shape
- macOS integration commands documented for a later real-Mac execution; Windows CI marks only genuine macOS executable/ownership cases as platform skips

## 10. Out of scope

- generating or importing secrets
- creating domain, Cloudflare, Google, Naver, SMTP, Telegram, or OpenAI accounts
- creating the directory layout
- `launchctl` lifecycle operations
- first normal publication bootstrap
- Kakao allowlist publication
- Hermes HMAC provisioning
- tunnel-off Host-aware health probing
- offline Keychain recovery bundles
- offsite backup replication

These remain separate, reviewable launch blockers.
