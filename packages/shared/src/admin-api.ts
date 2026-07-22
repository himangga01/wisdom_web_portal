import type {
  ArticleState,
  ConsultationStatus,
  Locale,
  NotificationChannel,
} from "./contracts.js";

export type AdminApiErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "ROW_VERSION_CONFLICT"
  | "CONFIRMATION_REQUIRED"
  | "OPERATION_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface AdminApiErrorBody {
  error: {
    code: AdminApiErrorCode;
    message: string;
    fieldErrors?: Record<string, string>;
  };
}

export interface AdminApiSuccess<T> {
  data: T;
}

export interface AdminPage {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface AdminSessionDto {
  stage: "authenticated";
  adminId: string;
  csrfToken: string;
  expiresAtMs: number;
  idleExpiresAtMs: number;
}

export interface AdminPreAuthDto {
  stage: "mfa";
  csrfToken: string;
}

export interface AdminDashboardDto {
  counts: Array<{ status: string; count: number }>;
}

export interface AdminConsultationListItem {
  id: string;
  receiptId: string;
  status: ConsultationStatus;
  locale: string;
  category: string;
  receivedAtMs: number;
}

export interface AdminConsultationListDto {
  items: AdminConsultationListItem[];
  page: AdminPage;
}

export interface AdminConsultationDetailDto extends AdminConsultationListItem {
  preferredContact: string;
  rowVersion: number;
  pii: {
    name: string;
    phone: string;
    email?: string;
    company?: string;
    message: string;
  } | null;
  nextStatuses: ConsultationStatus[];
}

export interface AdminArticleListItem {
  id: string;
  sourceLocale: Locale;
  locale: Locale;
  slug: string;
  state: ArticleState;
  rowVersion: number;
  title: string;
  updatedAtMs: number;
}

export interface AdminArticleListDto {
  items: AdminArticleListItem[];
  page: AdminPage;
}

export interface AdminArticleHeadDto {
  locale: Locale;
  slug: string;
  state: ArticleState;
  rowVersion: number;
  headRevisionId: string;
  title: string;
  summary: string;
  bodyMarkdown: string;
  sourcesJson: string;
  createdAtMs: number;
  createdByType: string;
}

export interface AdminArticleRevisionDto {
  id: string;
  locale: Locale;
  revisionNo: number;
  title: string;
  createdAtMs: number;
  createdByType: string;
  previousRevisionId: string | null;
  previousRevisionNo: number | null;
}

export interface AdminArticleDetailDto {
  id: string;
  sourceLocale: Locale;
  createdAtMs: number;
  updatedAtMs: number;
  heads: AdminArticleHeadDto[];
  revisions: AdminArticleRevisionDto[];
  revisionPage: AdminPage;
}

export interface AdminRevisionDiffDto {
  locale: Locale;
  previous: { id: string; title: string; summary: string; bodyMarkdown: string };
  current: { id: string; title: string; summary: string; bodyMarkdown: string };
}

export interface AdminPublishPreviewItem {
  articleId: string;
  locale: Locale;
  slug: string;
  state: ArticleState;
  headRevisionId: string;
  title: string;
  summary: string;
  sourceBindingValid: boolean;
}

export interface AdminPublishPreviewDto {
  eligible: AdminPublishPreviewItem[];
  blocked: AdminPublishPreviewItem[];
  eligibleTotal: number;
  blockedTotal: number;
  fingerprint: string;
  page: AdminPage;
}

export interface AdminReleaseDto {
  id: string;
  version: string;
  state: string;
  manifestSha256: string;
  verifiedAtMs: number | null;
  activatedAtMs: number | null;
  rolledBackAtMs: number | null;
  createdAtMs: number;
}

export interface AdminReleaseListDto {
  items: AdminReleaseDto[];
  page: AdminPage;
}

export interface AdminNotificationSettingDto {
  channel: NotificationChannel;
  enabled: boolean;
  provider: string;
  payloadMode: string | null;
  updatedAtMs: number;
  smtpConfigured: boolean;
  smtp?: {
    host: string;
    port: number;
    from: string;
    to: string;
    secretRef: string;
  };
}

export interface AdminNotificationsDto {
  settings: AdminNotificationSettingDto[];
}

export interface AdminConsentBundleDto {
  bundleId: string;
  documents: Array<{ kind: string; locale: string; version: string }>;
}

export interface AdminFailureDto {
  id: string;
  channel: NotificationChannel;
  eventType: string;
  attemptCount: number;
  lastErrorCode: string | null;
}

export interface AdminFailureListDto {
  items: AdminFailureDto[];
  page: AdminPage;
}

export interface AdminHealthDto {
  ready: boolean;
  queues: Array<{ state: string; count: number }>;
}
