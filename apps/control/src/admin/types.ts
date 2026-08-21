import type { Context } from "hono";

import type { AdminAuthContext } from "../auth/service.js";
import type { ConsentAuthorityResolver } from "../consent/service.js";

interface AdminEnvironment {
  Variables: { requestId: string };
}

export interface AdminRouteDependencies extends AdminAuthContext {
  publicOrigin: string;
  adminOrigin: string;
  withdrawalSecret: Uint8Array;
  now: () => number;
  peerAddress: (context: Context<AdminEnvironment>) => string;
  articlePublication?: AdminArticlePublicationActions;
  consentAuthorityResolver?: ConsentAuthorityResolver;
}

export interface AdminArticlePublicationActionInput {
  actorAdminId: string;
  requestId: string;
  nowMs: number;
  mode: "next-batch" | "policy-only";
  expectedFingerprint: string;
}

export interface AdminArticlePublicationResult {
  releaseId: string;
  version: string;
  manifestSha256: string;
}

export interface AdminArticlePublicationActions {
  publish(input: AdminArticlePublicationActionInput): Promise<AdminArticlePublicationResult>;
  rollback(
    input: Pick<
      AdminArticlePublicationActionInput,
      "actorAdminId" | "requestId" | "nowMs"
    > & { releaseId: string },
  ): Promise<AdminArticlePublicationResult>;
}
