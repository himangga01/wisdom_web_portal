import { z } from "zod";

import { emailPayloadModeSchema } from "./contracts.js";

const nodeEnvironmentSchema = z.enum(["development", "test", "production"]);

const rawEnvironmentSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema.default("development"),
  DATABASE_PATH: z.string().trim().min(1).optional(),
  ADMIN_SESSION_SECRET: z.string().trim().min(1).optional(),
  PII_ENCRYPTION_KEY: z.string().trim().min(1).optional(),
  WITHDRAWAL_TOKEN_SECRET: z.string().trim().min(1).optional(),
  EMAIL_PAYLOAD_MODE: emailPayloadModeSchema.default("receipt-only"),
});

const resolvedEnvironmentSchema = z
  .object({
    nodeEnv: nodeEnvironmentSchema,
    databasePath: z.string().trim().min(1),
    adminSessionSecret: z.string().min(32),
    piiEncryptionKey: z.string().min(32),
    withdrawalTokenSecret: z.string().min(32),
    emailPayloadMode: emailPayloadModeSchema,
  })
  .strict()
  .superRefine((environment, context) => {
    if (environment.nodeEnv !== "production") {
      return;
    }

    if (environment.databasePath === ":memory:") {
      context.addIssue({
        code: "custom",
        message: "Production must use a persistent database path",
        path: ["databasePath"],
      });
    }

    for (const [path, value] of [
      ["adminSessionSecret", environment.adminSessionSecret],
      ["piiEncryptionKey", environment.piiEncryptionKey],
      ["withdrawalTokenSecret", environment.withdrawalTokenSecret],
    ] as const) {
      if (value.startsWith("test-only-")) {
        context.addIssue({
          code: "custom",
          message: "Production cannot use a test-only secret",
          path: [path],
        });
      }
    }
  });

const TEST_DEFAULTS = {
  databasePath: ":memory:",
  adminSessionSecret: "test-only-admin-session-secret-0001",
  piiEncryptionKey: "test-only-pii-encryption-key-00001",
  withdrawalTokenSecret: "test-only-withdrawal-token-000001",
} as const;

export type EnvironmentSource = Record<string, string | undefined>;
export type AppEnvironment = z.output<typeof resolvedEnvironmentSchema>;

export function parseEnvironment(source: EnvironmentSource): AppEnvironment {
  const raw = rawEnvironmentSchema.parse(source);
  const testMode = raw.NODE_ENV === "test";

  return resolvedEnvironmentSchema.parse({
    nodeEnv: raw.NODE_ENV,
    databasePath: raw.DATABASE_PATH ?? (testMode ? TEST_DEFAULTS.databasePath : undefined),
    adminSessionSecret:
      raw.ADMIN_SESSION_SECRET ?? (testMode ? TEST_DEFAULTS.adminSessionSecret : undefined),
    piiEncryptionKey:
      raw.PII_ENCRYPTION_KEY ?? (testMode ? TEST_DEFAULTS.piiEncryptionKey : undefined),
    withdrawalTokenSecret:
      raw.WITHDRAWAL_TOKEN_SECRET ??
      (testMode ? TEST_DEFAULTS.withdrawalTokenSecret : undefined),
    emailPayloadMode: raw.EMAIL_PAYLOAD_MODE,
  });
}
