import {
  adminArticleDetailSchema,
  adminArticleMutationResultSchema,
  type AdminArticleHeadDto,
  type Locale,
} from "@wisdom/shared";
import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { apiRequest } from "../../api/client";
import { useResource } from "../../api/use-resource";
import { ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { Pagination } from "../../components/Pagination";
import { StatusBadge } from "../../components/StatusBadge";

const actionLabels: Record<string, string> = {
  review: "검토 요청",
  return: "초안으로 반환",
  approve: "승인",
  reject: "반려",
};

function actions(head: AdminArticleHeadDto): string[] {
  if (head.state === "draft") return ["review", "reject"];
  if (head.state === "in_review") return ["return", "approve", "reject"];
  if (head.state === "approved") return ["review"];
  return [];
}

export function ArticleDetailPage() {
  const { id = "" } = useParams();
  const [search] = useSearchParams();
  const revisionPage = search.get("revisionPage") ?? "1";
  const resource = useResource(
    `/articles/${encodeURIComponent(id)}?revisionPage=${encodeURIComponent(revisionPage)}`,
    adminArticleDetailSchema,
  );
  const [pending, setPending] = useState<string>();
  const [mutationError, setMutationError] = useState<unknown>();
  const mutate = async (key: string, path: string, body: unknown) => {
    setPending(key);
    setMutationError(undefined);
    try {
      await apiRequest(path, adminArticleMutationResultSchema, { method: "POST", body });
      await resource.reload();
    } catch (error) {
      setMutationError(error);
    } finally {
      setPending(undefined);
    }
  };
  const saveSlug = (head: AdminArticleHeadDto, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void mutate(
      `slug:${head.locale}`,
      `/articles/${encodeURIComponent(id)}/locales/${encodeURIComponent(head.locale)}/slug`,
      { slug: String(form.get("slug") ?? ""), rowVersion: head.rowVersion },
    );
  };
  if (resource.loading) return <Loading />;
  if (resource.error || !resource.data) return <ErrorMessage error={resource.error} />;
  const article = resource.data;
  const title = article.heads.find((head) => head.locale === article.sourceLocale)?.title ?? article.id;
  const sourceHead = article.heads.find((head) => head.locale === article.sourceLocale);
  const targets = (["ko", "en", "zh-Hans", "zh-Hant"] as Locale[]).filter((locale) => locale !== article.sourceLocale);
  return (
    <>
      <PageHeader
        eyebrow={`SOURCE · ${article.sourceLocale}`}
        title={title}
        description="언어별 본문, 검토 상태와 변경 이력을 확인합니다."
        actions={<Link className="button button-secondary" to="/articles">목록으로</Link>}
      />
      {mutationError ? <ErrorMessage error={mutationError} /> : null}
      {sourceHead && ["approved", "published"].includes(sourceHead.state) ? (
        <section className="panel compact-panel">
          <h2>번역 요청</h2>
          <form className="inline-form" onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void mutate("translation", `/articles/${encodeURIComponent(id)}/translations`, {
              targetLocale: String(form.get("targetLocale")),
              rowVersion: sourceHead.rowVersion,
            });
          }}>
            <label>대상 언어<select name="targetLocale">{targets.map((locale) => <option key={locale}>{locale}</option>)}</select></label>
            <button className="button button-primary" disabled={pending === "translation"}>{pending === "translation" ? "요청 중…" : "번역 요청"}</button>
          </form>
        </section>
      ) : null}
      <div className="content-stack">
        {article.heads.map((head) => (
          <article className="panel article-locale" key={head.locale}>
            <div className="section-heading"><div><p className="eyebrow">{head.locale}</p><h2>{head.title}</h2></div><StatusBadge value={head.state} /></div>
            <p className="summary">{head.summary}</p>
            <div className="article-copy"><h3>본문</h3><pre>{head.bodyMarkdown}</pre></div>
            <details><summary>출처 데이터</summary><pre>{head.sourcesJson}</pre></details>
            {(head.state === "draft" || head.state === "in_review") ? (
              <form className="inline-form" onSubmit={(event) => saveSlug(head, event)}>
                <label>공개 슬러그<input name="slug" defaultValue={head.slug} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={96} required /></label>
                <button className="button button-secondary" disabled={pending === `slug:${head.locale}`}>슬러그 저장</button>
              </form>
            ) : <p><span className="muted">공개 슬러그</span> <code>{head.slug}</code></p>}
            <div className="action-row">{actions(head).map((action) => (
              <button
                className={`button ${action === "reject" ? "button-danger" : "button-secondary"}`}
                key={action}
                disabled={pending === `${head.locale}:${action}`}
                onClick={() => void mutate(
                  `${head.locale}:${action}`,
                  `/articles/${encodeURIComponent(id)}/locales/${encodeURIComponent(head.locale)}/${action}`,
                  { rowVersion: head.rowVersion },
                )}
              >{actionLabels[action]}</button>
            ))}</div>
          </article>
        ))}
      </div>
      <section className="panel">
        <h2>변경 이력</h2>
        <div className="revision-list">{article.revisions.map((revision) => (
          <div className="revision-item" key={revision.id}>
            <div><strong>{revision.locale} #{revision.revisionNo}</strong><span>{revision.title}</span><small>{revision.createdByType} · {new Date(revision.createdAtMs).toLocaleString()}</small></div>
            {revision.previousRevisionId ? (
              <Link className="button button-ghost" to={`/articles/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision.id)}/diff?against=${encodeURIComponent(revision.previousRevisionId)}`}>#{revision.previousRevisionNo}과 비교</Link>
            ) : null}
          </div>
        ))}</div>
        <Pagination page={article.revisionPage} path={`/articles/${encodeURIComponent(id)}`} parameter="revisionPage" />
      </section>
    </>
  );
}
