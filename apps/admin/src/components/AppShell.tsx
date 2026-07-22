import { NavLink, Outlet } from "react-router-dom";

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
        <button className="button button-ghost logout" type="button" onClick={() => void logout()}>로그아웃</button>
      </aside>
      <main id="main-content" className="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
