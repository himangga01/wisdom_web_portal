import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { backupRunStateSchema, type BackupRunState } from "@wisdom/shared";

const MAX_BACKUP_RUN_STATE_BYTES = 4_096;

function invalidBackupRunStateError(): Error & { code: "BACKUP_RUN_STATE_INVALID" } {
  return Object.assign(new Error("Backup run state is invalid"), {
    code: "BACKUP_RUN_STATE_INVALID" as const,
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function hasSecureFileMetadata(metadata: Stats): boolean {
  if (!metadata.isFile() || metadata.size > MAX_BACKUP_RUN_STATE_BYTES) return false;
  return process.platform === "win32" || (metadata.mode & 0o777) === 0o600;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface BackupRunStateOpenConstants {
  O_RDONLY: number;
  O_NOFOLLOW?: number;
  O_NONBLOCK?: number;
}

export function backupRunStateOpenFlags(
  platform: NodeJS.Platform,
  fileConstants: BackupRunStateOpenConstants,
): number {
  if (platform === "win32") return fileConstants.O_RDONLY;
  if (
    typeof fileConstants.O_NOFOLLOW !== "number" ||
    typeof fileConstants.O_NONBLOCK !== "number"
  ) {
    throw invalidBackupRunStateError();
  }
  return fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK;
}

export async function readBackupRunState(
  statePath: string,
): Promise<BackupRunState | undefined> {
  try {
    if (!isAbsolute(statePath)) throw invalidBackupRunStateError();

    const expectedPath = resolve(statePath);
    const expectedParent = dirname(expectedPath);
    const parentMetadata = await lstat(expectedParent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw invalidBackupRunStateError();
    }
    const actualParent = await realpath(expectedParent);
    if (resolve(actualParent) !== expectedParent) throw invalidBackupRunStateError();

    const beforeOpen = await lstat(expectedPath);
    if (beforeOpen.isSymbolicLink() || !hasSecureFileMetadata(beforeOpen)) {
      throw invalidBackupRunStateError();
    }

    const handle = await open(
      expectedPath,
      backupRunStateOpenFlags(process.platform, constants),
    );
    let source: string;
    try {
      const afterOpen = await handle.stat();
      if (!sameFile(beforeOpen, afterOpen) || !hasSecureFileMetadata(afterOpen)) {
        throw invalidBackupRunStateError();
      }

      const bytes = Buffer.alloc(MAX_BACKUP_RUN_STATE_BYTES + 1);
      let total = 0;
      while (total < bytes.byteLength) {
        const next = await handle.read(bytes, total, bytes.byteLength - total, total);
        if (next.bytesRead === 0) break;
        total += next.bytesRead;
      }
      if (total > MAX_BACKUP_RUN_STATE_BYTES) throw invalidBackupRunStateError();
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
    } finally {
      await handle.close();
    }

    return backupRunStateSchema.parse(JSON.parse(source));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw invalidBackupRunStateError();
  }
}
