// Korean display labels for internal enum values shown to the operator. Values
// stored in the database and submitted in forms stay in their canonical English
// form; only the visible text is localized. Unknown values fall back to the raw
// string so a future enum never renders blank.

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
