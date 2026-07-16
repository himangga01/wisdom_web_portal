import {
  computePublishedArticleContentSha256,
  type Locale,
  type PublishedArticleDocument,
} from "@wisdom/shared";
import { createHash } from "node:crypto";

import {
  siteContent,
  type ServiceCategorySlug,
} from "../content/site-content.js";

export const SERVICE_REQUIRED_ANSWER_SECTION_IDS = [
  "scope",
  "preparation",
  "process",
] as const;
export const ARTICLE_REQUIRED_ANSWER_SECTION_IDS = ["answer"] as const;

type ServiceAnswerSectionId = (typeof SERVICE_REQUIRED_ANSWER_SECTION_IDS)[number];

export interface ServiceAnswerSection {
  id: ServiceAnswerSectionId;
  heading: string;
  body: string;
  items: readonly string[];
}

export interface ServicePublication {
  locale: Locale;
  slug: ServiceCategorySlug;
  h1: string;
  title: string;
  description: string;
  summary: string;
  answerSections: readonly ServiceAnswerSection[];
  contentSha256: string;
}

const serviceLabels: Record<Locale, {
  scope: string;
  preparation: string;
  preparationBody: string;
  process: string;
  processBody: string;
}> = {
  ko: {
    scope: "지원 범위",
    preparation: "사전 확인 사항",
    preparationBody: "적용 요건과 준비 자료는 기업·신청 유형 및 최신 공고에 따라 달라질 수 있으므로 공식 기준과 사실관계를 먼저 확인합니다.",
    process: "검토 및 진행 방식",
    processBody: "상담에서 사실관계와 목표를 확인한 뒤 적용 요건, 제출 자료, 진행 순서와 가능한 대안을 검토합니다.",
  },
  en: {
    scope: "Scope of support",
    preparation: "What to confirm first",
    preparationBody: "Applicable requirements and evidence vary by applicant, filing type, and current notice, so the official criteria and facts are confirmed first.",
    process: "Review and process",
    processBody: "The consultation confirms the facts and objective before reviewing applicable requirements, evidence, sequence, and available alternatives.",
  },
  "zh-Hans": {
    scope: "支持范围",
    preparation: "事前确认事项",
    preparationBody: "适用条件和准备材料可能因企业、申请类型及最新公告而异，因此首先确认官方标准和事实关系。",
    process: "审查与办理方式",
    processBody: "咨询时先确认事实和目标，再审查适用条件、提交材料、办理顺序和可行替代方案。",
  },
  "zh-Hant": {
    scope: "支援範圍",
    preparation: "事前確認事項",
    preparationBody: "適用條件及準備資料可能因企業、申請類型與最新公告而異，因此先確認官方標準與事實關係。",
    process: "審查與辦理方式",
    processBody: "諮詢時先確認事實與目標，再審查適用條件、提交資料、辦理順序及可行替代方案。",
  },
};

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalServicePayload(publication: Omit<ServicePublication, "contentSha256">): unknown {
  return {
    locale: publication.locale,
    slug: publication.slug,
    h1: publication.h1,
    title: publication.title,
    description: publication.description,
    answerSections: publication.answerSections,
  };
}

export function buildServicePublication(
  locale: Locale,
  slug: ServiceCategorySlug,
): ServicePublication {
  const content = siteContent[locale];
  const service = content.services.categories.find((candidate) => candidate.slug === slug);
  if (!service) throw new Error("SERVICE_CONTENT_QUALITY_FAILED");
  const labels = serviceLabels[locale];
  const withoutHash: Omit<ServicePublication, "contentSha256"> = {
    locale,
    slug,
    h1: service.title,
    title: `${service.title} | ${content.office.name}`,
    description: service.summary,
    summary: service.summary,
    answerSections: [
      { id: "scope", heading: labels.scope, body: service.summary, items: service.items },
      { id: "preparation", heading: labels.preparation, body: labels.preparationBody, items: [] },
      {
        id: "process",
        heading: labels.process,
        body: labels.processBody,
        items: content.pages.process.steps.map(({ title, body }) => `${title}: ${body}`),
      },
    ],
  };
  const publication = {
    ...withoutHash,
    contentSha256: sha256(canonicalServicePayload(withoutHash)),
  };
  assertServicePublicationQuality(publication);
  return publication;
}

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

export function assertServicePublicationQuality(value: ServicePublication): void {
  const ids = value.answerSections.map(({ id }) => id);
  const { contentSha256, ...withoutHash } = value;
  const valid = value.h1.trim().length > 0
    && value.title.trim().length > 0
    && value.title.includes(value.h1)
    && value.description === value.summary
    && value.description.trim().length > 0
    && JSON.stringify(ids) === JSON.stringify(SERVICE_REQUIRED_ANSWER_SECTION_IDS)
    && value.answerSections.every(({ heading, body }) => heading.trim() && body.trim())
    && contentSha256 === sha256(canonicalServicePayload(withoutHash));
  if (!valid) throw new Error("SERVICE_CONTENT_QUALITY_FAILED");
}

export function assertArticlePublicationQuality(article: PublishedArticleDocument): void {
  let contentHashMatches = false;
  try {
    contentHashMatches = computePublishedArticleContentSha256({
      title: article.title,
      summary: article.summary,
      bodyMarkdown: article.bodyMarkdown,
      sources: article.sources,
      locale: article.locale,
    }) === article.contentSha256;
  } catch {
    contentHashMatches = false;
  }
  const valid = article.title.trim().length > 0
    && article.summary.trim().length > 0
    && /^##\s+\S+/m.test(article.bodyMarkdown)
    && /<h2(?:\s[^>]*)?>[^<]+<\/h2>/.test(article.bodyHtml)
    && article.reviewer.name.trim().length > 0
    && article.reviewer.role.trim().length > 0
    && validDate(article.revisionCreatedAt)
    && validDate(article.approvedAt)
    && validDate(article.firstPublishedAt)
    && validDate(article.modifiedAt)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(article.revisionId)
    && /^[0-9a-f]{64}$/.test(article.contentSha256)
    && contentHashMatches
    && article.sources.length > 0
    && article.sources.every(({ id, url, sourceTimestamp }) => (
      id.trim().length > 0 && validHttpsUrl(url) && validDate(sourceTimestamp)
    ));
  if (!valid) throw new Error("ARTICLE_CONTENT_QUALITY_FAILED");
}
