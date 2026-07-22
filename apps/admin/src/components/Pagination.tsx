import { Link } from "react-router-dom";
import type { AdminPage } from "@wisdom/shared";

export function Pagination({ page, path, parameter = "page" }: {
  page: AdminPage;
  path: string;
  parameter?: string;
}) {
  if (page.total === 0) return null;
  const href = (value: number) => `${path}?${parameter}=${value}`;
  return (
    <nav className="pagination" aria-label="페이지 이동">
      <span>전체 {page.total}개 · {page.page}/{page.pageCount} 페이지</span>
      <div>
        {page.page > 1 ? <Link className="button button-secondary" to={href(page.page - 1)}>이전</Link> : null}
        {page.page < page.pageCount ? <Link className="button button-secondary" to={href(page.page + 1)}>다음</Link> : null}
      </div>
    </nav>
  );
}
