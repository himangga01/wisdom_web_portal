import { useEffect, useRef } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

import { AppShell } from "../components/AppShell";
import { ErrorMessage, Loading } from "../components/AsyncState";
import { ArticleDetailPage } from "../features/articles/ArticleDetailPage";
import { ArticleListPage } from "../features/articles/ArticleListPage";
import { RevisionDiffPage } from "../features/articles/RevisionDiffPage";
import { LoginPage } from "../features/auth/LoginPage";
import { MfaPage } from "../features/auth/MfaPage";
import { ConsultationDetailPage } from "../features/consultations/ConsultationDetailPage";
import { ConsultationListPage } from "../features/consultations/ConsultationListPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { ConsentsPage } from "../features/operations/ConsentsPage";
import { FailuresPage } from "../features/operations/FailuresPage";
import { HealthPage } from "../features/operations/HealthPage";
import { NotificationsPage } from "../features/operations/NotificationsPage";
import { PublishPreviewPage } from "../features/releases/PublishPreviewPage";
import { ReleaseListPage } from "../features/releases/ReleaseListPage";
import { useSession } from "./session";

function routeTitle(pathname: string): string {
  if (pathname === "/login") return "관리자 로그인";
  if (pathname === "/mfa") return "2단계 인증";
  if (pathname.startsWith("/consultations/")) return "상담 상세";
  if (pathname === "/consultations") return "상담 관리";
  if (pathname.includes("/revisions/") && pathname.endsWith("/diff")) return "리비전 비교";
  if (pathname.startsWith("/articles/")) return "콘텐츠 상세";
  if (pathname === "/articles") return "콘텐츠 검토";
  if (pathname === "/publish/preview") return "게시 미리보기";
  if (pathname === "/releases") return "공개 릴리스";
  if (pathname === "/notifications") return "알림 설정";
  if (pathname === "/consents") return "동의 문서";
  if (pathname === "/failures") return "실패 작업";
  if (pathname === "/health") return "서비스 상태";
  return pathname === "/" ? "관리자 대시보드" : "페이지를 찾을 수 없음";
}

function RouteEffects() {
  const { pathname, search } = useLocation();
  const locationIdentity = `${pathname}${search}`;
  const previousLocation = useRef(locationIdentity);
  useEffect(() => {
    document.title = `${routeTitle(pathname)} | JIHYE 관리자`;
    if (previousLocation.current !== locationIdentity) {
      const target = document.getElementById("main-content") ?? document.querySelector("h1");
      if (target instanceof HTMLElement) {
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus();
      }
      previousLocation.current = locationIdentity;
    }
  }, [locationIdentity, pathname]);
  return null;
}

function SessionContent() {
  const { state, retrySession } = useSession();
  const location = useLocation();
  if (state.stage === "loading") return <main className="auth-page"><Loading label="관리자 세션 확인 중" /></main>;
  if (state.stage === "error") return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="session-error-title">
        <h1 id="session-error-title">관리자 서비스에 연결할 수 없습니다.</h1>
        <ErrorMessage error={state.error} />
        <button className="button button-primary" type="button" onClick={() => void retrySession()}>다시 시도</button>
      </section>
    </main>
  );
  if (state.stage === "anonymous") {
    return location.pathname === "/login"
      ? <LoginPage />
      : <Navigate to="/login" replace />;
  }
  if (state.stage === "mfa") {
    return location.pathname === "/mfa"
      ? <MfaPage />
      : <Navigate to="/mfa" replace />;
  }
  if (location.pathname === "/login" || location.pathname === "/mfa") {
    return <Navigate to="/" replace />;
  }
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="consultations" element={<ConsultationListPage />} />
        <Route path="consultations/:id" element={<ConsultationDetailPage />} />
        <Route path="articles" element={<ArticleListPage />} />
        <Route path="articles/:id" element={<ArticleDetailPage />} />
        <Route path="articles/:id/revisions/:revisionId/diff" element={<RevisionDiffPage />} />
        <Route path="publish/preview" element={<PublishPreviewPage />} />
        <Route path="releases" element={<ReleaseListPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="consents" element={<ConsentsPage />} />
        <Route path="failures" element={<FailuresPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="*" element={<section className="state-card"><h1>페이지를 찾을 수 없습니다.</h1></section>} />
      </Route>
    </Routes>
  );
}

function SessionRoutes() {
  return <><RouteEffects /><SessionContent /></>;
}

export function AppRouter() {
  return <BrowserRouter basename="/admin"><SessionRoutes /></BrowserRouter>;
}
