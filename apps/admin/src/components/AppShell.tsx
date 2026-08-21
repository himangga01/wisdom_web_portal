import { NavLink, Outlet } from "react-router-dom";
import { useState } from "react";

import { useSession } from "../app/session";

const links = [
  ["/", "대시보드", true],
  ["/consultations", "상담", false],
  ["/articles", "콘텐츠", false],
  ["/releases", "릴리스", false],
  ["/notifications", "알림", false],
  ["/consents", "동의 문서", false],
  ["/failures", "실패 작업", false],
  ["/health", "상태", false],
] as const;

export function AppShell() {
  const { logout } = useSession();
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const handleLogout = async () => {
    setLogoutPending(true);
    setLogoutFailed(false);
    try {
      await logout();
    } catch {
      setLogoutFailed(true);
    } finally {
      setLogoutPending(false);
    }
  };
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">본문으로 바로가기</a>
      <aside className="sidebar">
        <NavLink className="brand" to="/" end>JIHYE <span>ADMIN</span></NavLink>
        <nav className="primary-nav" aria-label="관리자 메뉴">
          {links.map(([to, label, end]) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? "active" : ""}>
              {label}
            </NavLink>
          ))}
        </nav>
        {logoutFailed ? <p className="muted" role="alert">로그아웃하지 못했습니다. 다시 시도하세요.</p> : null}
        <button
          className="button button-ghost logout"
          type="button"
          disabled={logoutPending}
          onClick={() => void handleLogout()}
        >
          {logoutPending ? "로그아웃 중…" : "로그아웃"}
        </button>
      </aside>
      <main id="main-content" className="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
