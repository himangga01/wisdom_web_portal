// Korean display labels for internal enum values shown to the operator. Values
// stored in the database and submitted in forms stay in their canonical English
// form; only the visible text is localized. Unknown values fall back to the raw
// string so a future enum never renders blank.

import { OVERFLOW_REFERRER_ORIGIN } from "../../analytics/store.js";

const CONSULTATION_STATUS_LABELS: Record<string, string> = {
  received: "접수",
  acknowledged: "확인",
  in_progress: "진행 중",
  closed: "종결",
  spam: "스팸",
};

const ARTICLE_STATE_LABELS: Record<string, string> = {
  draft: "초안",
  in_review: "검토 중",
  approved: "승인",
  published: "발행",
  rejected: "반려",
};

const CATEGORY_LABELS: Record<string, string> = {
  procurement: "공공조달",
  credibility: "기업신용",
  "safety-esg": "안전·ESG",
  "business-certification": "기업인증",
  "licensing-entity": "인허가·법인",
  "immigration-visa": "출입국·비자",
  other: "기타",
};

const CHANNEL_LABELS: Record<string, string> = {
  email: "이메일",
  "hermes-telegram": "Hermes(텔레그램)",
};

const PAYLOAD_MODE_LABELS: Record<string, string> = {
  "receipt-only": "접수 확인만",
  "full-inquiry": "전체 문의 내용",
};

const PREFERRED_CONTACT_LABELS: Record<string, string> = {
  phone: "전화",
  email: "이메일",
};

const NOTIFICATION_STATE_LABELS: Record<string, string> = {
  pending: "대기",
  processing: "처리 중",
  sent: "발송됨",
  failed: "실패",
  cancelled: "취소됨",
};

// A retired release is the previously-active version that stepped down; it is
// still the rollback target, so it is not "expired".
const RELEASE_STATE_LABELS: Record<string, string> = {
  building: "빌드 중",
  active: "활성",
  retired: "이전 버전",
  failed: "실패",
};

const CONSENT_KIND_LABELS: Record<string, string> = {
  privacy: "개인정보",
  marketing: "마케팅",
};

const LOCALE_LABELS: Record<string, string> = {
  ko: "한국어",
  en: "영어",
  "zh-Hans": "중국어(간체)",
  "zh-Hant": "중국어(번체)",
};

const CREATED_BY_TYPE_LABELS: Record<string, string> = {
  admin: "관리자",
  hermes: "Hermes",
  codex: "자동 번역",
  system: "시스템",
};

// Machine error codes recorded on notification deliveries. Both delivery
// failures (shown on the failures screen) and lifecycle cancellations (shown in
// a consultation's notification history) are covered; unknown codes fall back to
// the raw string so a future code never renders blank.
const NOTIFICATION_ERROR_LABELS: Record<string, string> = {
  CHANNEL_DISABLED: "채널 꺼짐",
  ADAPTER_UNAVAILABLE: "발송 어댑터 사용 불가",
  WITHDRAWAL_CONFIGURATION_MISSING: "철회 설정 누락",
  WITHDRAWAL_CAPABILITY_ERROR: "철회 링크 생성 실패",
  PROVIDER_ERROR: "발송 제공자 오류",
  PROVIDER_HANDOFF_STARTED: "발송 위임 시작",
  PROVIDER_HANDOFF_ERROR: "발송 위임 오류",
  MARKETING_WITHDRAWN: "마케팅 수신 철회",
  RETENTION_PURGED: "보유기간 만료 파기",
  RETENTION_EXPIRED: "보유기간 만료",
  CONSULTATION_PURGED: "상담 파기됨",
  LEASE_EXPIRED: "처리 리스 만료",
};

function label(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

export const consultationStatusLabel = (value: string): string => label(CONSULTATION_STATUS_LABELS, value);
export const articleStateLabel = (value: string): string => label(ARTICLE_STATE_LABELS, value);
export const categoryLabel = (value: string): string => label(CATEGORY_LABELS, value);
export const channelLabel = (value: string): string => label(CHANNEL_LABELS, value);
export const payloadModeLabel = (value: string): string => label(PAYLOAD_MODE_LABELS, value);
export const preferredContactLabel = (value: string): string => label(PREFERRED_CONTACT_LABELS, value);
export const notificationStateLabel = (value: string): string => label(NOTIFICATION_STATE_LABELS, value);
export const releaseStateLabel = (value: string): string => label(RELEASE_STATE_LABELS, value);
export const consentKindLabel = (value: string): string => label(CONSENT_KIND_LABELS, value);
export const localeLabel = (value: string): string => label(LOCALE_LABELS, value);
export const createdByTypeLabel = (value: string): string => label(CREATED_BY_TYPE_LABELS, value);
export const notificationErrorLabel = (value: string): string => label(NOTIFICATION_ERROR_LABELS, value);

// Referrer origins are stored verbatim; only the two synthetic buckets — direct
// traffic and the per-day cardinality overflow — get a Korean label.
export const referrerOriginLabel = (value: string): string =>
  value === "" ? "직접 방문" : value === OVERFLOW_REFERRER_ORIGIN ? "기타(집계 상한 초과)" : value;
