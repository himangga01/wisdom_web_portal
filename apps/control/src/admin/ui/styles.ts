import { createHash } from "node:crypto";

export const ADMIN_STYLE = `:root{color-scheme:light}*{box-sizing:border-box}`
  + `body{margin:0;font-family:-apple-system,"Apple SD Gothic Neo","Segoe UI",Roboto,sans-serif;`
  + `font-size:16px;line-height:1.6;color:#1f2937;background:#f5f5f4}`
  + `header{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;padding:.75rem 1.25rem;`
  + `background:#1f2937;color:#fff}`
  + `header>a{color:#fff;font-weight:700;text-decoration:none}`
  + `header nav{display:flex;flex-wrap:wrap;gap:.75rem}`
  + `header nav a{color:#e5e7eb;text-decoration:none;font-size:.9rem}`
  + `header nav a:hover{color:#fff;text-decoration:underline}`
  + `header form{margin-left:auto}`
  + `main{max-width:60rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}`
  + `h1{font-size:1.5rem;margin:.2rem 0 1rem}h2{font-size:1.15rem;margin:1.5rem 0 .5rem}`
  + `a{color:#1d4ed8}`
  + `table{border-collapse:collapse;width:100%;margin:.5rem 0;background:#fff}`
  + `th,td{border:1px solid #d6d3d1;padding:.5rem .65rem;text-align:left;vertical-align:top}`
  + `th{background:#f3f4f6}`
  + `form{margin:1rem 0}fieldset{margin:1rem 0;border:1px solid #d6d3d1;border-radius:.4rem}`
  + `label{display:block;margin:.6rem 0 .2rem;font-weight:600}`
  + `input,select,textarea{font:inherit;padding:.45rem .55rem;border:1px solid #9ca3af;border-radius:.3rem;max-width:100%}`
  + `button{font:inherit;padding:.5rem .9rem;border:0;border-radius:.3rem;background:#1d4ed8;color:#fff;cursor:pointer}`
  + `button:hover{background:#1e40af}`
  + `pre{background:#fff;border:1px solid #d6d3d1;border-radius:.4rem;padding:.75rem;overflow-x:auto}`
  + `.banner{padding:.75rem 1rem;border-radius:.4rem;margin:0 0 1rem}`
  + `.banner-ok{background:#dcfce7;border:1px solid #86efac}`
  + `.banner-error{background:#fee2e2;border:1px solid #fca5a5}`
  + `.muted{color:#6b7280}`;

// CSP source-expression for the single inline <style> block, so the app-layer
// Content-Security-Policy permits its own styles without depending on the
// upstream (Caddy) header replacing it. Hashes the exact bytes the browser
// sees between the <style> tags.
export const ADMIN_STYLE_CSP_HASH = `'sha256-${createHash("sha256").update(ADMIN_STYLE).digest("base64")}'`;
