# Admin Automatic Backup Control and Mac mini Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an audited administrator ON/OFF control for scheduled encrypted backups while preserving manual backup and restore, then provide a command-checked Mac mini M4 installation guide that inventories every required account, issued value, operator decision, and locally generated secret.

**Architecture:** SQLite schema v7 stores the singleton automatic-backup policy and its optimistic-concurrency revision. A secret-free LaunchAgent dispatcher runs every 60 seconds, checks policy and due time before Keychain access, and invokes the existing encrypted backup through fixed argv only when due; `backup.mjs --automatic` rechecks policy under the database-maintenance lock. A bounded owner-only run-state JSON is observational only, monitoring distinguishes disabled/grace/failure states, and restore injects the current operator policy into the staged database before replacement.

**Tech Stack:** Node.js 24, TypeScript strict, Hono, Drizzle/better-sqlite3, Zod 4, Vitest, Node test runner, macOS launchd/Keychain, age 1.3.1, Markdown operations documentation.

## Global Constraints

- Work only in the isolated worktree branch `codex/admin-backup-mac-setup`.
- The canonical policy is exactly one `backup_settings` row; the migration default is ON.
- Missing, malformed, multiply-defined, or unreadable policy is `BACKUP_CONTROL_INVALID`; never infer ON or OFF.
- OFF controls scheduled automatic backups only. Manual backup without `--automatic` and guarded restore remain available.
- Re-enabling must make one automatic run due immediately; after a verified run, normal cadence is one backup per 60 minutes.
- The dispatcher runs every 60 seconds and must decide OFF before Keychain access or verified-pair scanning.
- Automatic backup checks policy again after acquiring the existing database-maintenance lock and before checkpoint, snapshot, age, status publication, or retention.
- A backup that passed the locked second check may finish after a later OFF change; do not terminate it mid-flight.
- `DATA_ROOT/backup-run-state.json` is bounded owner-only observation, not backup-integrity evidence. Verified `.age` and `.json` pairs remain authoritative.
- Administrator POSTs require the existing MFA session, exact `ADMIN_ORIGIN`, CSRF, strict form limits, positive `rowVersion`, and explicit OFF confirmation.
- Settings update and `audit_events` insertion are one `BEGIN IMMEDIATE` transaction. Audit metadata contains only old/new boolean state and row version.
- Monitoring alerts once for an unchanged administrator-disabled state, alerts immediately for newly added failures, gives ON transitions a 10-minute grace, and clears the disabled incident only after a post-enable verified backup.
- Restore preserves the current operator choice, not the choice captured in an old backup. If the current target policy cannot be read, apply requires `--automatic-backup-after-restore enabled|disabled`.
- Never render or log age identity, PII keys, Keychain values/references, absolute paths, consultation data, raw child stderr, SMTP credentials, Telegram tokens, or recovery codes on the backup admin screen or run-state file.
- Do not add Docker, WordPress, router port forwarding, automatic offsite replication, an external backup provider, or a Keychain recovery-bundle implementation in this change.
- Existing migration SQL and fingerprints for versions 1 through 6 are immutable; append version 7 only.
- Every behavior change is test-first: observe the focused test fail, add the minimum implementation, observe it pass, and commit the independently reviewable task.

## File Structure

- `apps/control/src/db/schema.ts` — Drizzle declaration, required schema inventory, schema version.
- `apps/control/src/db/client.ts` — append-only v7 migration and readiness checks.
- `apps/control/src/backups/settings.ts` — typed policy read and CAS/audit transaction.
- `apps/control/src/backups/run-state.ts` — bounded, sanitized observation reader for the admin page.
- `packages/shared/src/backup-run-state.ts` — the one strict JSON contract shared by Control and Ops.
- `apps/control/src/admin/routes.ts` — `/admin/backups` page and mutation.
- `apps/control/src/app.ts`, `apps/control/src/server.ts` — inject the observation provider; derive the state path from the production database directory.
- `ops/lib/backup-control.mjs` — policy validation, due decision, protected atomic run-state IO, dispatcher orchestration.
- `ops/scripts/backup-dispatcher.mjs` — dry-run/apply CLI and fixed, shell-free Keychain child invocation.
- `ops/lib/backup.mjs`, `ops/scripts/backup.mjs`, `ops/lib/system-adapters.mjs` — locked second check, manual/automatic separation, schema-v7 SQLite policy adapters.
- `ops/lib/monitoring.mjs`, `ops/scripts/monitor-db-check.mjs` — disabled/grace/failure health semantics and one-alert suppression.
- `ops/lib/restore.mjs`, `ops/scripts/restore.mjs` — current-policy resolution and staged policy injection.
- `ops/launchd/com.jihye.portal.backup.plist.template` — 60-second dispatcher entry point.
- `ops/lib/release-system.mjs` — require all new runtime artifacts in sealed releases.
- `docs/operations/mac-mini-setup.md` — end-to-end operator guide and input inventory.
- `docs/00-document-map.md`, `ops/runbooks/deployment.md`, `ops/runbooks/recovery.md`, `README.md` — discoverability and operational cross-references.

---

### Task 1: Schema v7 and Atomic Backup Policy Service

**Files:**
- Create: `apps/control/src/backups/settings.ts`
- Create: `apps/control/src/backups/settings.test.ts`
- Modify: `apps/control/src/db/schema.ts`
- Modify: `apps/control/src/db/client.ts`
- Modify: `apps/control/src/db/database.test.ts`

**Interfaces:**
- Consumes: `ControlDatabase` from `apps/control/src/db/client.ts`; existing `audit_events` schema and `BEGIN IMMEDIATE` transaction pattern.
- Produces: `BackupSettings`, `readBackupSettings(db)`, and `changeAutomaticBackupSetting(db, input, options)` for Tasks 2, 3, 4, and 5; SQLite schema version 7.

- [x] **Step 1: Write failing v7 migration and readiness tests**

Add exact assertions to `apps/control/src/db/database.test.ts` for the default row, constraints, migration history, and readiness:

```ts
expect(SCHEMA_VERSION).toBe(7);
expect(db.sqlite.prepare(`
  SELECT singleton, automatic_enabled, row_version, updated_at_ms, updated_by_admin_id
  FROM backup_settings
`).get()).toEqual({
  singleton: 1,
  automatic_enabled: 1,
  row_version: 1,
  updated_at_ms: 0,
  updated_by_admin_id: null,
});
expect(history.at(-1)).toEqual({ version: 7, name: "automatic-backup-control" });
expect(() => db.sqlite.prepare(
  "UPDATE backup_settings SET automatic_enabled = 2 WHERE singleton = 1",
).run()).toThrow();
db.sqlite.exec("DROP TABLE backup_settings");
expect(isDatabaseReady(db)).toBe(false);
```

Also migrate a database stopped at v6 and assert the v7 row appears without changing existing admin and consultation rows. Change every exact migration count/list expectation from six to seven while keeping the first six fingerprints unchanged.

- [x] **Step 2: Run the focused migration test and observe failure**

Run:

```powershell
npm.cmd run test --workspace @wisdom/control -- src/db/database.test.ts
```

Expected: FAIL because `SCHEMA_VERSION` is 6 and `backup_settings` does not exist.

- [x] **Step 3: Append the exact v7 schema and migration**

Add this Drizzle declaration to `apps/control/src/db/schema.ts`, include it in `REQUIRED_TABLES` and `drizzleSchema`, and set `SCHEMA_VERSION = 7`:

```ts
export const backupSettings = sqliteTable("backup_settings", {
  singleton: integer("singleton").primaryKey(),
  automaticEnabled: integer("automatic_enabled", { mode: "boolean" }).notNull(),
  rowVersion: integer("row_version").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  updatedByAdminId: text("updated_by_admin_id").references(() => admins.id),
});
```

Append, without editing migrations 1–6, to `apps/control/src/db/client.ts`:

```ts
const SEVENTH_MIGRATION = `
CREATE TABLE backup_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  automatic_enabled INTEGER NOT NULL CHECK (automatic_enabled IN (0, 1)),
  row_version INTEGER NOT NULL CHECK (row_version > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  updated_by_admin_id TEXT REFERENCES admins(id)
);
INSERT INTO backup_settings (
  singleton, automatic_enabled, row_version, updated_at_ms, updated_by_admin_id
) VALUES (1, 1, 1, 0, NULL);
`;

// MIGRATIONS tail
{ version: 7, name: "automatic-backup-control", sql: SEVENTH_MIGRATION },
```

Add all five columns to the `isDatabaseReady()` required-column map and require exactly one valid singleton row.

- [x] **Step 4: Run the migration test and observe pass**

Run the Step 2 command.

Expected: PASS with the v6→v7 and fresh-v7 cases green.

- [x] **Step 5: Write failing policy service tests**

Create `apps/control/src/backups/settings.test.ts` covering:

```ts
const changed = changeAutomaticBackupSetting(db, {
  automaticEnabled: false,
  expectedRowVersion: 1,
  actorAdminId: adminId,
  requestId: "request-disable",
  nowMs: 1_721_188_800_000,
}, { randomUUID: () => "00000000-0000-4000-8000-000000000701" });

expect(changed).toMatchObject({
  kind: "updated",
  httpStatus: 200,
  settings: { automaticEnabled: false, rowVersion: 2 },
});
expect(db.sqlite.prepare(`
  SELECT action, metadata_json FROM audit_events ORDER BY created_at_ms DESC LIMIT 1
`).get()).toEqual({
  action: "automatic_backup.disabled",
  metadata_json: JSON.stringify({
    previousAutomaticEnabled: true,
    automaticEnabled: false,
    rowVersion: 2,
  }),
});
```

Test default ON, OFF→ON action, unchanged/no-audit, stale revision/409, singleton missing/malformed as `BACKUP_CONTROL_INVALID`, CAS changes=0, and rollback at injected `after-settings` and `after-audit` fault points.

- [x] **Step 6: Run the service test and observe failure**

Run:

```powershell
npm.cmd run test --workspace @wisdom/control -- src/backups/settings.test.ts
```

Expected: FAIL because `settings.ts` is absent.

- [x] **Step 7: Implement the typed policy service**

Implement these exact exports:

```ts
export interface BackupSettings {
  automaticEnabled: boolean;
  rowVersion: number;
  updatedAtMs: number;
  updatedByAdminId: string | null;
}

export interface ChangeAutomaticBackupInput {
  automaticEnabled: boolean;
  expectedRowVersion: number;
  actorAdminId: string;
  requestId: string;
  nowMs: number;
}

export type ChangeAutomaticBackupResult =
  | { kind: "updated" | "unchanged"; httpStatus: 200; settings: BackupSettings }
  | { kind: "conflict"; httpStatus: 409; settings: BackupSettings };

export function readBackupSettings(db: ControlDatabase): BackupSettings;

export function changeAutomaticBackupSetting(
  db: ControlDatabase,
  input: ChangeAutomaticBackupInput,
  options: {
    randomUUID?: () => string;
    faultInjector?: (point: "after-settings" | "after-audit") => void;
  } = {},
): ChangeAutomaticBackupResult;
```

Validate all integer/boolean/string fields when reading. Wrap all storage parsing failures with a sanitized error whose `code` is `BACKUP_CONTROL_INVALID`. Inside `BEGIN IMMEDIATE`, reread, return conflict for stale revision, return unchanged without audit for the same boolean, perform a CAS update on singleton/revision/old boolean, insert the action-specific audit event, and roll back on every exception.

- [x] **Step 8: Run policy, database, and Control type checks**

Run:

```powershell
npm.cmd run test --workspace @wisdom/control -- src/backups/settings.test.ts src/db/database.test.ts
npm.cmd run typecheck --workspace @wisdom/control
```

Expected: both test files PASS and TypeScript exits 0.

- [x] **Step 9: Commit Task 1**

```powershell
git add apps/control/src/backups/settings.ts apps/control/src/backups/settings.test.ts apps/control/src/db/schema.ts apps/control/src/db/client.ts apps/control/src/db/database.test.ts
git commit -m "feat: add audited automatic backup policy"
```

---

### Task 2: Strict Run-State Contract and Administrator Backup Page

**Files:**
- Create: `packages/shared/src/backup-run-state.ts`
- Create: `packages/shared/src/backup-run-state.test.ts`
- Create: `apps/control/src/backups/run-state.ts`
- Create: `apps/control/src/backups/run-state.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/control/src/admin/routes.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`
- Modify: `apps/control/src/app.ts`
- Modify: `apps/control/src/server.ts`

**Interfaces:**
- Consumes: Task 1 `readBackupSettings` and `changeAutomaticBackupSetting`.
- Produces: `backupRunStateSchema`, `BackupRunState`, `readBackupRunState(path)`, optional `backupRunStateProvider` dependency, and secured `/admin/backups` GET/POST routes.

- [x] **Step 1: Write failing shared run-state contract tests**

Create strict schema tests that accept only this shape and reject extra keys, non-UTC times, absolute artifact paths, unknown outcomes, and unknown error codes:

```ts
const value = backupRunStateSchema.parse({
  formatVersion: 1,
  runId: "00000000-0000-4000-8000-000000000702",
  startedAt: "2026-07-17T04:00:00.000Z",
  finishedAt: "2026-07-17T04:00:03.000Z",
  outcome: "verified",
  controlRevision: 2,
  lastVerifiedAt: "2026-07-17T04:00:03.000Z",
  lastVerifiedArtifact: "hourly-20260717T040000Z.age",
  errorCode: null,
});
expect(value.outcome).toBe("verified");
```

The allowed errors are exactly `BACKUP_CONTROL_INVALID` and `BACKUP_OPERATION_FAILED`; all detailed child errors map to the latter.

- [x] **Step 2: Run shared test and observe failure**

Run:

```powershell
npm.cmd run test --workspace @wisdom/shared -- src/backup-run-state.test.ts
```

Expected: FAIL because the module is absent.

- [x] **Step 3: Implement and export the shared contract**

Implement:

```ts
export const backupRunOutcomeSchema = z.enum([
  "running", "verified", "not-due", "admin-disabled", "failed",
]);
export const backupRunErrorCodeSchema = z.enum([
  "BACKUP_CONTROL_INVALID", "BACKUP_OPERATION_FAILED",
]).nullable();
export const backupRunStateSchema = z.object({
  formatVersion: z.literal(1),
  runId: z.uuid(),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  outcome: backupRunOutcomeSchema,
  controlRevision: z.int().positive().nullable(),
  lastVerifiedAt: z.iso.datetime({ offset: true }).nullable(),
  lastVerifiedArtifact: z.string()
    .regex(/^hourly-\d{8}T\d{6}Z\.age$/u)
    .nullable(),
  errorCode: backupRunErrorCodeSchema,
}).strict();
export type BackupRunState = z.infer<typeof backupRunStateSchema>;
```

Add the export to `packages/shared/src/index.ts` and keep cross-field outcome checks in `.superRefine`: running has no `finishedAt`; verified requires both verified fields; non-failed states require a positive control revision and `errorCode: null`; `BACKUP_CONTROL_INVALID` may use a null revision because no trustworthy row exists.

- [x] **Step 4: Write failing protected reader tests**

In `apps/control/src/backups/run-state.test.ts`, create owner-only fixtures and assert:

```ts
await expect(readBackupRunState(statePath)).resolves.toMatchObject({ outcome: "verified" });
await expect(readBackupRunState(missingPath)).resolves.toBeUndefined();
await expect(readBackupRunState(oversizedPath)).rejects.toMatchObject({
  code: "BACKUP_RUN_STATE_INVALID",
});
```

Cover non-absolute paths, final symlink, linked parent, non-regular file, over 4 KiB, permissive POSIX mode, malformed JSON, and schema-invalid JSON. Error messages must not contain source content or the absolute path.

- [x] **Step 5: Implement the bounded Control-side reader**

Implement `readBackupRunState(statePath: string): Promise<BackupRunState | undefined>` using `lstat`, `realpath`, an `open` handle, a post-open identity check, a 4 KiB maximum, `0600` enforcement on POSIX, and `backupRunStateSchema.parse`. Treat `ENOENT` as no observation; map every other failure to sanitized `BACKUP_RUN_STATE_INVALID`.

- [x] **Step 6: Write failing administrator HTTP tests**

Extend `apps/control/src/admin/admin-http.test.ts` with:

```ts
const page = await current.app.request(`${ADMIN_ORIGIN}/admin/backups`, {
  headers: { cookie: session.cookie },
});
const html = await page.text();
expect(page.status).toBe(200);
expect(html).toContain("Automatic encrypted backup");
expect(html).toContain('name="rowVersion" value="1"');
expect(html).toContain('name="csrf"');
expect(html).not.toMatch(/AGE-SECRET-KEY|keychain:|portal\.sqlite|010-8415-0023|kjihye0023@naver\.com/i);
```

Test login redirect, public-host 404, sensitive headers, nav link, default ON, validated observation display, unavailable observation, wrong Origin/CSRF, invalid state/revision, missing OFF confirmation, successful OFF, audit row, stale 409, unchanged redirect, and ON without confirmation.

- [x] **Step 7: Run administrator test and observe failure**

Run:

```powershell
npm.cmd run build:shared
npm.cmd run test --workspace @wisdom/control -- src/admin/admin-http.test.ts src/backups/run-state.test.ts
```

Expected: FAIL because the routes/provider are absent.

- [x] **Step 8: Implement the provider and secured routes**

Add to `ControlAppDependencies` and `Task4RouteDependencies`:

```ts
backupRunStateProvider?: () => Promise<BackupRunState | undefined>;
```

In production `server.ts`, derive the fixed observation path without a new environment key:

```ts
const backupRunStatePath = path.join(
  path.dirname(runtime.config.databasePath),
  "backup-run-state.json",
);
// createControlApp dependency
backupRunStateProvider: () => readBackupRunState(backupRunStatePath),
```

Add `Backups` to `page()` navigation. `GET /admin/backups` uses `protectedSession`, reads policy, catches observation errors as “Observation unavailable,” and renders only status, last change, sanitized actor display, last run outcome, verified timestamp/age, the OFF risks, and a form. `POST /admin/backups` uses `protectedPost`, accepts exactly `automaticEnabled=enabled|disabled`, parses a positive safe integer revision, requires `disableConfirmed=yes` only for OFF, calls Task 1, returns 409 for conflict, and redirects 303 for updated/unchanged.

- [x] **Step 9: Run Task 2 focused verification**

Run:

```powershell
npm.cmd run test --workspace @wisdom/shared -- src/backup-run-state.test.ts
npm.cmd run test --workspace @wisdom/control -- src/backups/run-state.test.ts src/admin/admin-http.test.ts
npm.cmd run typecheck
```

Expected: all focused tests PASS and root type checking exits 0.

- [x] **Step 10: Commit Task 2**

```powershell
git add packages/shared/src/backup-run-state.ts packages/shared/src/backup-run-state.test.ts packages/shared/src/index.ts apps/control/src/backups/run-state.ts apps/control/src/backups/run-state.test.ts apps/control/src/admin/routes.ts apps/control/src/admin/admin-http.test.ts apps/control/src/app.ts apps/control/src/server.ts
git commit -m "feat: add administrator backup controls"
```

---

### Task 3: Secret-Free 60-Second Dispatcher and Locked Automatic Recheck

**Files:**
- Create: `ops/lib/backup-control.mjs`
- Create: `ops/scripts/backup-dispatcher.mjs`
- Create: `ops/tests/backup-dispatcher.test.mjs`
- Modify: `ops/lib/backup.mjs`
- Modify: `ops/scripts/backup.mjs`
- Modify: `ops/lib/system-adapters.mjs`
- Modify: `ops/tests/backup-restore.test.mjs`
- Modify: `ops/tests/system-adapters.test.mjs`
- Modify: `ops/tests/cli-dry-run.test.mjs`
- Modify: `ops/launchd/com.jihye.portal.backup.plist.template`
- Modify: `ops/tests/configuration.test.mjs`
- Modify: `ops/lib/release-system.mjs`
- Modify: `ops/tests/release-system.test.mjs`

**Interfaces:**
- Consumes: schema-v7 `backup_settings`, shared `backupRunStateSchema`, `loadNewestBackupStatus`, existing database-maintenance lock, Keychain wrapper, age adapter.
- Produces: `validateBackupControlRows`, `readBackupControl`, `automaticBackupDecision`, `loadBackupRunState`, `writeBackupRunState`, `runBackupDispatcher`, `backup-dispatcher.mjs`, and `createOnlineBackup({ automatic })` skip result.

- [x] **Step 1: Write failing SQLite policy-adapter tests**

Extend `ops/tests/system-adapters.test.mjs` for:

```js
const policy = await createSqliteAdapter().readBackupControl(databasePath);
assert.deepEqual(policy, {
  automaticEnabled: true,
  rowVersion: 1,
  updatedAtMs: 0,
});
```

Cover missing table/row, invalid boolean/revision/time, multiple rows, and SQLite failure as `BACKUP_CONTROL_INVALID`; update fixture `PRAGMA user_version = 7` and expected schema compatibility.

- [x] **Step 2: Implement one fail-closed SQLite policy reader**

Set `createSqliteAdapter({ expectedSchemaVersion = 7 })` and add:

```js
readBackupControl: async (databasePath) => ({
  automaticEnabled,
  rowVersion,
  updatedAtMs,
}),
```

Open readonly with `fileMustExist`, enable `query_only`, require schema v7, and select the singleton with a bounded `LIMIT 2`. Export `validateBackupControlRows(rows)` from `ops/lib/backup-control.mjs` so this adapter and the monitor helper use the same exact integer/boolean validation; map all failures to sanitized `BACKUP_CONTROL_INVALID`. This method is injected into dispatcher, automatic backup, and restore.

- [x] **Step 3: Write failing decision, no-secret, and run-state tests**

Create `ops/tests/backup-dispatcher.test.mjs`. Pin the boundary:

```js
assert.equal(automaticBackupDecision({
  control: { automaticEnabled: true, rowVersion: 2, updatedAtMs: transitionMs },
  newestVerified: { createdAt: new Date(nowMs - 3_599_999).toISOString() },
  now: new Date(nowMs),
}), "not-due");

assert.equal(automaticBackupDecision({
  control: { automaticEnabled: true, rowVersion: 2, updatedAtMs: transitionMs },
  newestVerified: { createdAt: new Date(nowMs - 3_600_000).toISOString() },
  now: new Date(nowMs),
}), "run");
```

Assert OFF calls neither verified-pair scan nor child; missing pair and a pair older than `updatedAtMs` run; post-enable verified pair avoids duplicates; child skip becomes `admin-disabled`; bad exit/oversized stdout/bad JSON writes only `BACKUP_OPERATION_FAILED`; not-due/disabled preserve only verified timestamp and basename. Test protected `0600`, 4 KiB, symlink rejection, atomic replacement, and no absolute paths/identity/raw stderr in state or returned JSON.

- [x] **Step 4: Run dispatcher tests and observe failure**

Run:

```powershell
npm.cmd run build:shared
node --test ops/tests/backup-dispatcher.test.mjs ops/tests/system-adapters.test.mjs
```

Expected: FAIL because the control library and adapter method are absent.

- [x] **Step 5: Implement dispatcher library contracts**

Implement in `ops/lib/backup-control.mjs`:

```js
export const AUTOMATIC_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
export const MAX_BACKUP_RUN_STATE_BYTES = 4 * 1024;
export function automaticBackupDecision({ control, newestVerified, now }) {
  const nowMs = now.valueOf();
  if (!control.automaticEnabled) return "admin-disabled";
  if (!newestVerified) return "run";
  const verifiedAtMs = Date.parse(newestVerified.createdAt);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isFinite(verifiedAtMs) || verifiedAtMs > nowMs) {
    throw Object.assign(new Error("Automatic backup timing is invalid"), {
      code: "BACKUP_CONTROL_INVALID",
    });
  }
  if (verifiedAtMs < control.updatedAtMs) return "run";
  return nowMs - verifiedAtMs >= AUTOMATIC_BACKUP_INTERVAL_MS ? "run" : "not-due";
}
```

In the same module export `validateBackupControlRows(rows)`, `loadBackupRunState(statePath)`, `writeBackupRunState(statePath, value)`, and `runBackupDispatcher(input, adapters)`. `runBackupDispatcher` reads policy first. OFF loads only the prior run-state (never the backup directory), writes `admin-disabled`, and does not call `loadNewestBackupStatus` or `runChild`. ON loads the newest verified pair, returns `not-due` until the exact interval, writes `running` before the child, strictly parses bounded child JSON, reloads the verified pair after success, and atomically writes final state. Every state is validated with `backupRunStateSchema`; use an actual parent directory, sibling temp file, `0600`, fsync, rename, and directory fsync.

- [x] **Step 6: Write failing automatic second-check and manual-bypass tests**

Add to `ops/tests/backup-restore.test.mjs`:

```js
const skipped = await createOnlineBackup({ ...fixture.config, automatic: true }, {
  ...fixture.adapters,
  sqlite: {
    ...fixture.adapters.sqlite,
    readBackupControl: async () => ({
      automaticEnabled: false,
      rowVersion: 4,
      updatedAtMs: fixture.config.now.valueOf(),
    }),
  },
});
assert.deepEqual(skipped, {
  verified: false,
  outcome: "admin-disabled",
  controlRevision: 4,
});
assert.equal(fixture.calls.checkpoint, 0);
assert.equal(fixture.calls.onlineBackup, 0);
assert.equal(fixture.calls.encrypt, 0);
```

Also assert the reader is called while the maintenance lock exists, ON follows the old flow, manual input without `automatic` never calls the policy reader even when policy is OFF, and an OFF change after the locked check does not interrupt the current backup.

- [x] **Step 7: Move the locked check before backup filesystem mutation**

Extend `createOnlineBackup` so it validates the source path, acquires the database-maintenance lock, checks `readBackupControl` only when `config.automatic === true`, and returns the skip object before backup/temp directory validation, chmod, checkpoint, snapshot, age, publication, or retention. Manual calls omit `automatic` and keep the existing behavior.

Extend `ops/scripts/backup.mjs` with exact `--automatic` parsing. On apply, require `WISDOM_KEYCHAIN_EXEC === "1"`, include `automatic` in dry-run JSON, and print either a verified basename/hash result or:

```json
{"dryRun":false,"verified":false,"outcome":"admin-disabled","controlRevision":4}
```

- [x] **Step 8: Write failing dispatcher CLI, plist, and release-seal tests**

Assert dry-run needs no SQLite/Keychain/filesystem; apply accepts fixed child argv after `--`; child execution is `shell: false`, bounded, and has no secret in argv. In `configuration.test.mjs`, parse the plist and assert its first executable script is `backup-dispatcher.mjs`, `StartInterval` is 60, Keychain appears only in dispatcher child argv, and `--automatic --apply` are present. In `release-system.test.mjs`, require both new runtime files.

- [x] **Step 9: Implement the CLI and LaunchAgent switch**

`ops/scripts/backup-dispatcher.mjs` must be dry-run by default and export a guarded `main`. With `--apply`, split the fixed child command at `--`, validate absolute executable/script/config/data paths and bounded argv, then call `runBackupDispatcher` with `spawn`/`execFile` configured `shell: false`, bounded stdout/stderr, and a timeout longer than the normal encrypted backup bound. Never copy child stderr into state or normal output.

Replace the plist top-level program with:

```xml
<string>{{NODE_BINARY}}</string>
<string>{{CURRENT_RELEASE}}/ops/scripts/backup-dispatcher.mjs</string>
```

Pass `--source`, `--root`, `--run-state {{DATA_ROOT}}/backup-run-state.json`, `--apply`, then the fixed child after `--`. Change `StartInterval` from `3600` to `60`; retain `RunAtLoad` and `ThrottleInterval=60`. Add `ops/lib/backup-control.mjs` and `ops/scripts/backup-dispatcher.mjs` to sealed `REQUIRED_ARTIFACTS` and test fixtures.

- [x] **Step 10: Run Task 3 focused verification**

Run:

```powershell
npm.cmd run build:shared
node --test ops/tests/backup-dispatcher.test.mjs ops/tests/backup-restore.test.mjs ops/tests/system-adapters.test.mjs ops/tests/cli-dry-run.test.mjs ops/tests/configuration.test.mjs ops/tests/release-system.test.mjs
npm.cmd run typecheck
```

Expected: all focused tests PASS, including disabled no-secret/no-write and manual bypass.

- [x] **Step 11: Commit Task 3**

```powershell
git add ops/lib/backup-control.mjs ops/scripts/backup-dispatcher.mjs ops/tests/backup-dispatcher.test.mjs ops/lib/backup.mjs ops/scripts/backup.mjs ops/lib/system-adapters.mjs ops/tests/backup-restore.test.mjs ops/tests/system-adapters.test.mjs ops/tests/cli-dry-run.test.mjs ops/launchd/com.jihye.portal.backup.plist.template ops/tests/configuration.test.mjs ops/lib/release-system.mjs ops/tests/release-system.test.mjs
git commit -m "feat: dispatch scheduled backups without early secret access"
```

---

### Task 4: Monitoring Disabled, Resume-Grace, and Recovery Semantics

**Files:**
- Modify: `ops/scripts/monitor-db-check.mjs`
- Modify: `ops/lib/monitoring.mjs`
- Modify: `ops/monitoring/checks.json.template`
- Modify: `ops/tests/monitoring.test.mjs`
- Modify: `ops/tests/cli-dry-run.test.mjs`
- Modify: `ops/tests/configuration.test.mjs`

**Interfaces:**
- Consumes: Task 3 `readBackupControl`, newest verified status, existing protected incident-state storage and Hermes handoff.
- Produces: strict backup control observation, `grace` monitor state, `BACKUP_ADMIN_DISABLED`, `BACKUP_CONTROL_INVALID`, a 10-minute transition gate, and indefinite suppression for an unchanged disabled-only incident.

- [x] **Step 1: Write failing protected database policy-query tests**

Extend `ops/tests/monitoring.test.mjs` around `queryDatabaseAggregates`/the new policy helper. A valid v7 database returns only:

```js
assert.deepEqual(await queryBackupControl(databasePath), {
  automaticEnabled: false,
  rowVersion: 3,
  updatedAtMs: Date.UTC(2026, 6, 17, 4, 0, 0),
});
```

Assert missing table/row, malformed values, wrong schema version, path replacement, timeout, and corrupt DB map to the fixed monitor-facing code `BACKUP_CONTROL_INVALID` without exposing SQLite text or paths.

- [x] **Step 2: Implement a separate bounded helper protocol**

In `ops/scripts/monitor-db-check.mjs`, export `queryBackupControl(databasePath, hooks = {})` using the same independent secure path walk, readonly/query-only database, before/after identity checks, 100 ms SQLite timeout, and 4 KiB child-output bound as aggregate queries. Pass the selected rows through Task 3 `validateBackupControlRows` so dispatcher, backup, restore, and monitor cannot interpret the singleton differently. Add an exact CLI mode:

```text
monitor-db-check.mjs --database /absolute/portal.sqlite --backup-control
```

Keep backlog mode unchanged. In `createSystemMonitoringAdapters`, add `readBackupControl(databasePath, options)` that invokes this helper with absolute Node/script paths, no shell, bounded output, and strict exact-key validation.

- [x] **Step 3: Write failing monitor state and incident tests**

Add cases that assert:

```js
const disabled = await runLocalMonitor(input, healthyAdapters({
  readBackupControl: async () => ({
    automaticEnabled: false,
    rowVersion: 4,
    updatedAtMs: now.valueOf() - 60_000,
  }),
}));
assert.equal(disabled.ok, false);
assert.deepEqual(disabled.checks.find(({ id }) => id === "backup"), {
  id: "backup",
  state: "failed",
  code: "BACKUP_ADMIN_DISABLED",
});
```

Cover: invalid control; one disabled Hermes send; same disabled fingerprint suppressed even after normal cooldown; new disk/control failure changes fingerprint and sends immediately; ON with no post-transition pair is `grace` before exactly 10 minutes; at exactly 10 minutes it fails; grace returns exit 0 but does not clear the prior disabled incident; a post-transition verified pair clears the incident; OFF does not stop disk, service, readiness, queue, or retention checks.

- [x] **Step 4: Run monitor tests and observe failure**

Run:

```powershell
node --test ops/tests/monitoring.test.mjs
```

Expected: FAIL because policy-aware backup health and `grace` do not exist.

- [x] **Step 5: Implement policy-aware backup health**

Add `backupResumeGraceMinutes: 10` to the strict threshold object in `ops/monitoring/checks.json.template` and config parser. Read control before backup freshness evaluation and use this exact order:

```js
if (!controlIsValid) return failed("backup", "BACKUP_CONTROL_INVALID");
if (!control.automaticEnabled) return failed("backup", "BACKUP_ADMIN_DISABLED");
const createdAtMs = newestVerified ? Date.parse(newestVerified.createdAt) : undefined;
const postTransition = Number.isFinite(createdAtMs) && createdAtMs >= control.updatedAtMs;
const transitionAgeMs = now.valueOf() - control.updatedAtMs;
if (!postTransition && transitionAgeMs < 10 * 60_000) {
  return { id: "backup", state: "grace", code: "BACKUP_RESUME_GRACE" };
}
if (!postTransition) return failed("backup", "BACKUP_VERIFIED_PAIR_MISSING");
```

After the transition gate, apply the existing 90-minute timestamp/freshness checks. Overall `ok` accepts only `healthy` and `grace`. A report containing `grace` sends no handoff and exits 0 but deliberately leaves a prior incident state untouched.

- [x] **Step 6: Implement exact disabled-only suppression**

Use failed checks only for the incident fingerprint. Add:

```js
const failures = results.filter(({ state }) => state === "failed");
const disabledOnly = failures.length === 1 &&
  failures[0].id === "backup" &&
  failures[0].code === "BACKUP_ADMIN_DISABLED";
const suppress = prior?.fingerprint === fingerprint &&
  (disabledOnly || withinCooldown);
```

The first disabled report is signed and sent; later identical disabled-only reports are suppressed without rewriting the incident timestamp. Any added real failure changes the fingerprint and sends immediately. Only a fully healthy post-enable verified report clears the stored incident.

- [x] **Step 7: Update fixtures and run focused monitoring verification**

Add the threshold to every strict config fixture in `monitoring.test.mjs` and `cli-dry-run.test.mjs`. Extend `configuration.test.mjs` to require the literal 10-minute template value.

Run:

```powershell
node --test ops/tests/monitoring.test.mjs ops/tests/cli-dry-run.test.mjs ops/tests/configuration.test.mjs
```

Expected: all focused tests PASS.

- [x] **Step 8: Commit Task 4**

```powershell
git add ops/scripts/monitor-db-check.mjs ops/lib/monitoring.mjs ops/monitoring/checks.json.template ops/tests/monitoring.test.mjs ops/tests/cli-dry-run.test.mjs ops/tests/configuration.test.mjs
git commit -m "feat: monitor automatic backup policy"
```

---

### Task 5: Preserve the Current Automatic-Backup Choice During Restore

**Files:**
- Modify: `ops/lib/system-adapters.mjs`
- Modify: `ops/lib/restore.mjs`
- Modify: `ops/scripts/restore.mjs`
- Modify: `ops/tests/system-adapters.test.mjs`
- Modify: `ops/tests/backup-restore.test.mjs`
- Modify: `ops/tests/cli-dry-run.test.mjs`
- Modify: `ops/runbooks/recovery.md`

**Interfaces:**
- Consumes: Task 3 `readBackupControl`; schema-v7 `backup_settings`; existing retention, integrity, quarantine, rollback, service readiness contracts.
- Produces: `resolveRestoreAutomaticBackupPolicy`, `sqlite.applyBackupControl`, and CLI flag `--automatic-backup-after-restore enabled|disabled`.

- [x] **Step 1: Write failing SQLite policy-injection tests**

Extend `ops/tests/system-adapters.test.mjs` for:

```js
const applied = await adapter.applyBackupControl(stagedPath, {
  automaticEnabled: false,
  nowMs,
  requestId: "restore-policy-00000001",
});
assert.deepEqual(applied, {
  automaticEnabled: false,
  rowVersion: 2,
  updatedAtMs: nowMs,
});
assert.deepEqual(database.prepare(`
  SELECT actor_type, action, metadata_json FROM audit_events
  WHERE request_id = 'restore-policy-00000001'
`).get(), {
  actor_type: "system",
  action: "automatic_backup.restore_preserved",
  metadata_json: JSON.stringify({ automaticEnabled: false, rowVersion: 2 }),
});
```

Assert `updated_by_admin_id` becomes NULL, the policy update and system audit are atomic, injected audit failure rolls back, and malformed/missing staged policy fails closed.

- [x] **Step 2: Implement staged policy injection**

Add `applyBackupControl(databasePath, { automaticEnabled, nowMs, requestId })` to `createSqliteAdapter`. Require schema v7 and one valid singleton, use one SQLite transaction, set `automatic_enabled`, increment `row_version`, set `updated_at_ms = nowMs`, clear `updated_by_admin_id`, and insert `automatic_backup.restore_preserved`. Return the validated new public policy only.

- [x] **Step 3: Write failing restore resolution and rollback tests**

Add to `ops/tests/backup-restore.test.mjs`:

- backup contains OFF/current target ON → staged/current result ON;
- backup contains ON/current target OFF → result OFF;
- target missing or unreadable + no explicit mode → `RESTORE_BACKUP_POLICY_REQUIRED` before decrypt/quarantine;
- unreadable target + explicit enabled and explicit disabled each succeed;
- valid current policy plus a conflicting explicit value → `RESTORE_BACKUP_POLICY_CONFLICT`;
- readiness failure restores the original database and original policy;
- staged policy/audit failure never replaces the target;
- ON injection uses restore time so Task 3 makes a new backup due immediately.

Use adapter spies to assert policy resolution occurs after services are stopped and before age decrypt, and injection occurs after retention but before final inspection/replacement.

- [x] **Step 4: Write failing dry-run and CLI tests**

In `ops/tests/cli-dry-run.test.mjs`, assert dry-run remains secret-free and returns:

```json
{
  "automaticBackupPolicy": "preserve-current",
  "explicitFallback": null,
  "inputRequiredIfCurrentUnreadable": true
}
```

Assert exact flag values `enabled|disabled`, reject duplicates/unknown values, keep `--confirm-destroy` exact-target behavior, and require the fallback only when apply cannot read the current target policy.

- [x] **Step 5: Run restore tests and observe failure**

Run:

```powershell
node --test ops/tests/system-adapters.test.mjs ops/tests/backup-restore.test.mjs ops/tests/cli-dry-run.test.mjs
```

Expected: FAIL because policy resolution/injection and the flag are absent.

- [x] **Step 6: Implement restore policy resolution without weakening rollback**

Add:

```js
export async function resolveRestoreAutomaticBackupPolicy({
  target,
  explicitMode,
}, sqlite) {
  try {
    const current = await sqlite.readBackupControl(target);
    if (explicitMode !== undefined && explicitMode !== current.automaticEnabled) {
      throw Object.assign(new Error("Explicit restore policy conflicts with current policy"), {
        code: "RESTORE_BACKUP_POLICY_CONFLICT",
      });
    }
    return { automaticEnabled: current.automaticEnabled, source: "current-target" };
  } catch (error) {
    if (error?.code === "RESTORE_BACKUP_POLICY_CONFLICT") throw error;
    if (explicitMode === undefined) {
      throw Object.assign(new Error("An explicit restore policy is required"), {
        code: "RESTORE_BACKUP_POLICY_REQUIRED",
      });
    }
    return { automaticEnabled: explicitMode, source: "explicit" };
  }
}
```

In `restoreBackupLocked`, after services are confirmed stopped, resolve current/fallback policy before decrypting. After copying to staged and enforcing retention, call `applyBackupControl` with restore time and a fixed sanitized request ID, then rerun integrity/schema checks. Do not change quarantine, atomic rename, service start, readiness, failed-copy, or rollback ordering. Include only `automaticBackupAfterRestore` and `automaticBackupPolicySource: "current-target"|"explicit"` in the result.

- [x] **Step 7: Implement strict CLI parsing and update the recovery runbook**

Parse `--automatic-backup-after-restore` only when present; accept exactly `enabled` or `disabled`, convert to boolean at the library boundary, and never default silently. Dry-run prints the policy rule without opening SQLite. Apply continues to require `WISDOM_KEYCHAIN_EXEC=1`, `AGE_IDENTITY`, `--apply`, and exact `--confirm-destroy`.

In `ops/runbooks/recovery.md`, document dry-run first, current-policy preservation, the fallback condition, both exact flag values, the ON immediate-backup consequence, the OFF preservation consequence, and a post-restore verification query through the admin page rather than direct secret output.

- [x] **Step 8: Run focused restore verification**

Run:

```powershell
node --test ops/tests/system-adapters.test.mjs ops/tests/backup-restore.test.mjs ops/tests/cli-dry-run.test.mjs
```

Expected: all focused tests PASS and all pre-existing readiness/rollback cases remain green.

- [x] **Step 9: Commit Task 5**

```powershell
git add ops/lib/system-adapters.mjs ops/lib/restore.mjs ops/scripts/restore.mjs ops/tests/system-adapters.test.mjs ops/tests/backup-restore.test.mjs ops/tests/cli-dry-run.test.mjs ops/runbooks/recovery.md
git commit -m "feat: preserve backup policy across restores"
```

---

### Task 6: Detailed Mac mini M4 Installation and Operations Guide

**Files:**
- Create: `docs/operations/mac-mini-setup.md`
- Modify: `docs/00-document-map.md`
- Modify: `README.md`
- Modify: `ops/runbooks/deployment.md`
- Modify: `ops/runbooks/recovery.md`
- Modify: `ops/tests/configuration.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–5 CLI names, paths, policy behavior, schema v7, existing templates/runbooks, approved design inventory.
- Produces: a single operator entry point with exact commands, expected output, stop conditions, secret-handling rules, externally issued values, locally generated values, validation, loss impact, and honest launch blockers.

- [x] **Step 1: Write failing documentation-contract tests**

Extend `ops/tests/configuration.test.mjs` to load `docs/operations/mac-mini-setup.md` and require all of these literal sections or terms:

```js
for (const required of [
  "외부 발급", "운영자 결정", "Mac 로컬 생성", "민감도", "저장 위치",
  "검증 방법", "분실 영향", "AGE-SECRET-KEY-1", "PII_ENCRYPTION_KEY",
  "FileVault", "Cloudflare Tunnel", "Google Search Console",
  "Naver Search Advisor", "IndexNow", "SMTP", "Hermes", "Telegram",
  "TOTP", "recovery code", "Codex", "npm run verify",
  "--automatic-backup-after-restore", "BACKUP_ADMIN_DISABLED",
  "공개 전 구현 필요", "현재 수동 검증 가능",
]) assert.match(guide, new RegExp(required, "i"));
```

Also require exact command names/flags currently present in the repository, all eight known launch blockers, and explicit statements that Docker, WordPress, Caddy account, age service account, router forwarding, manual TLS certificates, Kakao Developers API for a simple link, and Penpot runtime access are not required.

- [x] **Step 2: Run the documentation test and observe failure**

Run:

```powershell
node --test ops/tests/configuration.test.mjs
```

Expected: FAIL because `mac-mini-setup.md` is absent.

- [x] **Step 3: Write the preparation inventory first**

Create an opening table with these columns:

```markdown
| 구분 | 항목 | 발급처/생성 위치 | 값 형식·예 | 민감도 | 저장 위치 | 검증 방법 | 분실·오류 영향 |
```

Populate every approved item:

- macOS login account, UID, HOME, FileVault unlock/recovery, cold-boot on-site access, wired LAN, UPS, power settings;
- domain registrar account, apex/public/admin hosts;
- Cloudflare account, zone, tunnel ID, credentials file, DNS records;
- Google account and Search Console Domain Property DNS TXT;
- Naver account, Search Advisor site, exactly one HTML-file or meta verification method;
- IndexNow ownership key;
- canonical Naver Blog, Naver Map, Kakao chat URLs;
- SMTP account, host, port 465 implicit TLS, from/to, app password, Keychain service;
- Hermes endpoint/port and two independent HMAC services; Telegram bot token/chat ID remain inside Hermes;
- Codex CLI, OpenAI API credential/billing, model, Keychain service, isolated work/temp paths and timeouts;
- administrator username/display name, password, TOTP enrollment, offline recovery codes;
- privacy and marketing documents for `ko`, `en`, `zh-Hans`, `zh-Hant`;
- generated admin session, control HMAC, Hermes HMAC, monitor HMAC, PII, withdrawal, age identity/recipient, IndexNow, SMTP/Codex Keychain references;
- GitHub private/public transfer decision, repository URL and commit SHA, external uptime account.

Mark values as secret/public/operator decision and prohibit storing secrets in Git, runtime templates, shell history, screenshots, Telegram, or the guide.

- [x] **Step 4: Document encryption and recovery boundaries**

Explain exactly:

```text
age1...                public recipient used to encrypt backup files
AGE-SECRET-KEY-1...    private identity required to decrypt backup files
PII_ENCRYPTION_KEY     separate key required to decrypt consultation fields inside SQLite
FileVault              protects the Mac storage at rest before login
```

State that a complete recovery needs a verified `.age`/`.json` pair, age identity, PII key, remaining application secrets, source/config, and an operator who can unlock/login after cold boot. Mark the missing all-Keychain offline recovery bundle and automatic offsite encrypted replication as public-launch blockers, not implemented commands.

- [x] **Step 5: Document exact Mac preparation and coexistence checks**

Use computed paths, never a hardcoded username:

```sh
umask 077
export PORTAL_USER="$(id -un)"
export PORTAL_UID="$(id -u)"
export SOURCE_ROOT="$HOME/src/wisdom-web-portal"
export APP_ROOT="$HOME/portal"
export RELEASE_ROOT="$APP_ROOT/releases"
export CURRENT_RELEASE="$APP_ROOT/current"
export PUBLIC_RELEASE_ROOT="$APP_ROOT/public-releases"
export PUBLIC_CURRENT_RELEASE="$APP_ROOT/public-current"
export DATA_ROOT="$HOME/Library/Application Support/WisdomPortal"
export LOG_ROOT="$HOME/Library/Logs/WisdomPortal"
export BACKUP_ROOT="$HOME/Backups/WisdomPortal"
export BACKUP_TEMP_ROOT="$HOME/Library/Caches/WisdomPortalBackup"
```

Include `uname -m = arm64`, `sw_vers`, `fdesetup status`, reversible `pmset` inspection, `xcode-select -p`, free space, and port/process checks for Gemma/Hermes plus 8787, 8788, 8080, 2019, and 18787. Stop if the login short name violates the current Keychain account validator, a required port conflicts, FileVault has no recovery path, or no on-site cold-boot plan exists.

- [x] **Step 6: Document exact software, source, and filesystem setup**

Require Node major 24, npm 12, Caddy, cloudflared, exact age 1.3.1, SQLite at least 3.51.3, and Codex CLI. Pin installation-source and checksum verification rather than assuming Homebrew still supplies age 1.3.1. Require clone of `https://github.com/himangga01/wisdom_web_portal.git` or a verified `git bundle`, Mac-local `npm ci`, Playwright browser install, `npm run verify`, recorded commit SHA, and clean `git status`. Explicitly prohibit copying Windows `node_modules`.

Create real non-symlink directories with `0700`; require rendered runtime/monitor files to be `0600`. Since no production render/install CLI exists, label template rendering `공개 전 구현 필요`; if manually inspected for a local rehearsal, require unresolved-token scan, `plutil -lint`, and Caddy validation and do not claim this is a supported production installer.

- [x] **Step 7: Document secrets, bootstrap, services, and publication in dependency order**

Use only real repository commands for `secret-bootstrap.mjs`, `secret-import.mjs`, `seed-public.mjs`, `preflight.mjs`, `deploy.mjs`, monitor validation/dry-run, admin owner/MFA, policy publication, and launchd inspection. Every command block includes expected safe output and a stop condition. Never use `security ... -w`; verify Keychain item existence without printing values.

Clearly label the first normal publication bootstrap deadlock, Kakao runtime allowlist gap, Hermes HMAC provisioning gap, and tunnel-off Host health-probe gap as `공개 전 구현 필요`; do not invent workarounds that weaken Secure cookies or tunnel preflight.

- [x] **Step 8: Document automatic/manual backup and guarded restore drills**

Show administrator ON/OFF behavior and the manual Keychain-wrapped backup command without `--automatic`. Document that OFF leaves existing artifacts and restore intact, stops scheduled creation/retention, voids the 60-minute RPO target, and allows an already-started backup to finish. After ON, require observation of one start within 60 seconds and no duplicate before 60 minutes.

Show restore dry-run and apply with exact target confirmation. Explain current-policy preservation and when the fallback flag is mandatory. Require a separate-target restore drill, wrong-age-identity failure, verified artifact/hash/size checks, measured RPO/RTO, and restoration of services/readiness.

- [x] **Step 9: Document search, channels, monitoring, reboot, and acceptance**

Include Google/Naver DNS verification, sitemap/robots/RSS/IndexNow checks, canonical blog/map/Kakao links, SMTP receipt/full-inquiry modes, Hermes metadata-only Telegram behavior, local monitor validation, independent outside-Mac/LAN uptime, FileVault cold boot/manual unlock, UPS/wired-network/power-loss drill, and final external checks for public/admin hosts.

List these eight current blockers exactly and assign one status to each: production template render/install CLI; first normal publication bootstrap; Kakao URL publication allowlist; Hermes HMAC provisioning; tunnel-off Host-aware health probe; all-Keychain offline recovery bundle; automatic offsite backup replication; stale `PUBLIC_ORIGINS` README mismatch. State that external account creation/payment/ownership remains an operator action.

- [x] **Step 10: Add entry-point links and fix only the misleading README key**

Add the guide to `docs/00-document-map.md`, link it from `README.md`, and update the stale plural `PUBLIC_ORIGINS` wording to the implemented singular `PUBLIC_ORIGIN` without changing runtime behavior. Add cross-links from deployment and recovery runbooks to the guide and preserve their concise emergency procedures.

- [x] **Step 11: Run documentation verification**

Run:

```powershell
node --test ops/tests/configuration.test.mjs
rg -n "T[B]D|T[O]DO|implement later|AGE-SECRET-KEY-1[A-Z0-9]+|CODEX_API_KEY=|TELEGRAM.*TOKEN=" docs/operations/mac-mini-setup.md ops/runbooks README.md
```

Expected: configuration tests PASS; the scan returns no placeholder or embedded-secret assignment. The explanatory literal `AGE-SECRET-KEY-1...` is allowed only with ellipsis and must not match a real key.

- [x] **Step 12: Commit Task 6**

```powershell
git add docs/operations/mac-mini-setup.md docs/00-document-map.md README.md ops/runbooks/deployment.md ops/runbooks/recovery.md ops/tests/configuration.test.mjs
git commit -m "docs: add Mac mini installation and recovery guide"
```

---

### Task 7: Whole-Branch Integration, Security Review, and Publication

**Files:**
- Modify only files required by reproduced review findings.
- Update: `docs/superpowers/plans/2026-07-17-admin-backup-control-and-mac-mini-setup.md` checkbox state during execution.
- Update: `.superpowers/sdd/progress.md` local execution ledger; this path remains uncommitted if ignored.

**Interfaces:**
- Consumes: all Task 1–6 deliverables.
- Produces: a clean verified feature branch, review evidence, GitHub push, and draft pull request.

- [x] **Step 1: Run focused cross-boundary suites**

Run:

```powershell
npm.cmd run build:shared
npm.cmd run test --workspace @wisdom/control -- src/db/database.test.ts src/backups/settings.test.ts src/backups/run-state.test.ts src/admin/admin-http.test.ts
node --test ops/tests/backup-dispatcher.test.mjs ops/tests/backup-restore.test.mjs ops/tests/system-adapters.test.mjs ops/tests/monitoring.test.mjs ops/tests/configuration.test.mjs ops/tests/cli-dry-run.test.mjs ops/tests/runtime-launch.test.mjs ops/tests/release-system.test.mjs
```

Expected: every focused suite PASS with zero failures.

- [x] **Step 2: Run static secret, placeholder, and artifact-boundary scans**

Run:

```powershell
rg -n "T[B]D|T[O]DO|implement later" apps packages ops docs README.md
rg -n "AGE-SECRET-KEY-1[A-Z0-9]+|ghp_[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|TELEGRAM.*TOKEN=|CODEX_API_KEY=" apps packages ops docs README.md
git diff --check origin/master...HEAD
git status --short
```

Expected: no newly introduced placeholders or credential assignments; `git diff --check` exits 0; only intentional tracked changes are present.

- [x] **Step 3: Run the full fresh verification gate**

Run:

```powershell
npm.cmd run verify
```

Expected: typecheck, all unit/integration/Ops suites, builds, Astro validation, and Chromium/Firefox/WebKit E2E all PASS. Record exact counts and elapsed time from this run.

- [x] **Step 4: Perform two-stage independent review**

Dispatch one fresh reviewer for specification compliance and a separate fresh reviewer for code quality/security/operations. Give each `origin/master...HEAD`, the approved design, this plan, and verification output. Required review questions:

```text
Does OFF avoid Keychain and backup filesystem work?
Does manual backup still work without --automatic?
Is the locked second check before checkpoint/snapshot/age/retention?
Does restore preserve current policy or demand an explicit fallback?
Can any admin/run-state/log output expose secrets, paths, or PII?
Are disabled/grace/incident semantics exact at their time boundaries?
Does the guide name only real commands and honestly mark all blockers?
```

Reproduce every Important/Critical finding with a failing test or direct evidence. Apply only valid findings, rerun the smallest affected suite, and ask the corresponding reviewer to re-review until no Important/Critical finding remains.

- [x] **Step 5: Re-run verification after review fixes**

Run:

```powershell
npm.cmd run verify
git diff --check origin/master...HEAD
git status --short --branch
```

Expected: fresh full verification PASS, clean whitespace check, and no uncommitted implementation changes.

- [x] **Step 6: Commit any final review corrections**

If review produced valid changes, commit only those files:

```powershell
git add -u
git commit -m "fix: address automatic backup review findings"
```

If no files changed, do not create an empty commit.

- [ ] **Step 7: Push the feature branch and open a draft PR**

Run:

```powershell
git push -u origin codex/admin-backup-mac-setup
```

Open a draft pull request into `master` titled `Add admin automatic backup control and Mac mini setup guide`. Its body lists delivered behavior, schema v7/rollback incompatibility, focused/full verification evidence, operational blockers intentionally left out of scope, and Mac hardware validation still required.

- [ ] **Step 8: Final handoff**

Provide the user a detailed Korean implementation summary grouped by administrator UX/security, scheduler/runtime, monitoring, restore, Mac guide, schema/migrations, tests, Git commits/branch/PR, remaining launch blockers, and the first Mac mini action. Include clickable absolute links to the guide, plan, and key implementation files.
