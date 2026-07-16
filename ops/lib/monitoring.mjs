import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function loadNewestBackupStatus(backupRoot) {
  if (!path.isAbsolute(backupRoot)) throw Object.assign(new Error("Backup root must be absolute"), { code: "MONITOR_INPUT_INVALID" });
  const root = await lstat(backupRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw Object.assign(new Error("Backup root must be a real directory"), { code: "MONITOR_INPUT_INVALID" });
  const statuses = [];
  for (const name of await readdir(backupRoot)) {
    if (!/^hourly-\d{8}T\d{6}Z\.json$/u.test(name)) continue;
    try {
      const value = JSON.parse(await readFile(path.join(backupRoot, name), "utf8"));
      const artifactPath = path.join(backupRoot, name.replace(/\.json$/u, ".age"));
      const artifact = await lstat(artifactPath);
      if (!artifact.isFile() || artifact.isSymbolicLink()) continue;
      const bytes = await readFile(artifactPath);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (
        value.verified === true &&
        Number.isFinite(Date.parse(value.createdAt)) &&
        value.encryptedBytes === artifact.size &&
        value.encryptedSha256 === hash
      ) statuses.push(value);
    } catch {
      // A malformed status is not a successful backup.
    }
  }
  return statuses.toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

export function backupFreshness(status, now, staleAfterMs = 90 * 60 * 1000) {
  if (!status) return { state: "missing", ageMs: undefined };
  const ageMs = now.valueOf() - Date.parse(status.createdAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return { state: "invalid", ageMs };
  return { state: ageMs > staleAfterMs ? "stale" : "healthy", ageMs };
}
