import argon2 from "argon2";

const ARGON_MEMORY_COST = 19_456;
const ARGON_TIME_COST = 2;
const ARGON_PARALLELISM = 1;
const ARGON_HASH_LENGTH = 32;

const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: ARGON_MEMORY_COST,
  timeCost: ARGON_TIME_COST,
  parallelism: ARGON_PARALLELISM,
  hashLength: ARGON_HASH_LENGTH,
} as const;

interface ParsedArgonHash {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  saltLength: number;
  hashLength: number;
}

function parseArgon2idHash(hash: string): ParsedArgonHash | undefined {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(hash);
  if (!match) return undefined;
  const memoryCost = Number(match[1]);
  const timeCost = Number(match[2]);
  const parallelism = Number(match[3]);
  const salt = Buffer.from(match[4] ?? "", "base64");
  const encodedHash = Buffer.from(match[5] ?? "", "base64");
  if (
    !Number.isSafeInteger(memoryCost) ||
    !Number.isSafeInteger(timeCost) ||
    !Number.isSafeInteger(parallelism) ||
    salt.byteLength < 8 ||
    encodedHash.byteLength < 16
  ) {
    return undefined;
  }
  return {
    memoryCost,
    timeCost,
    parallelism,
    saltLength: salt.byteLength,
    hashLength: encodedHash.byteLength,
  };
}

export function isAdminPasswordHashFormatValid(hash: string): boolean {
  return parseArgon2idHash(hash) !== undefined;
}

export function isFrozenAdminPasswordHash(hash: string): boolean {
  const parsed = parseArgon2idHash(hash);
  return parsed !== undefined &&
    parsed.memoryCost === ARGON_MEMORY_COST &&
    parsed.timeCost === ARGON_TIME_COST &&
    parsed.parallelism === ARGON_PARALLELISM &&
    parsed.saltLength === 16 &&
    parsed.hashLength === ARGON_HASH_LENGTH;
}

export async function hashAdminPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS);
}

export async function verifyAdminPassword(
  hash: string,
  password: string,
): Promise<{ valid: boolean; needsRehash: boolean }> {
  const parsed = parseArgon2idHash(hash);
  if (!parsed) return { valid: false, needsRehash: false };
  try {
    if (!await argon2.verify(hash, password)) {
      return { valid: false, needsRehash: false };
    }
  } catch {
    return { valid: false, needsRehash: false };
  }
  return {
    valid: true,
    needsRehash:
      parsed.memoryCost < ARGON_MEMORY_COST ||
      parsed.timeCost < ARGON_TIME_COST ||
      parsed.parallelism < ARGON_PARALLELISM ||
      parsed.saltLength < 16 ||
      parsed.hashLength < ARGON_HASH_LENGTH,
  };
}
