import { Hono } from "hono";

import { registerWithdrawalRoutes } from "../withdrawal/routes.js";
import { registerAdminApiRoutes } from "./api.js";
import { registerAdminSpaRoutes } from "./spa.js";
import type { AdminRouteDependencies } from "./types.js";

interface AdminEnvironment {
  Variables: { requestId: string };
}

export type {
  AdminArticlePublicationActionInput,
  AdminArticlePublicationActions,
  AdminArticlePublicationResult,
  AdminRouteDependencies,
} from "./types.js";

export function registerAdminRoutes(
  app: Hono<AdminEnvironment>,
  dependencies: AdminRouteDependencies,
): void {
  registerAdminApiRoutes(app, dependencies);
  registerAdminSpaRoutes(app);
  registerWithdrawalRoutes(app, dependencies);
}
