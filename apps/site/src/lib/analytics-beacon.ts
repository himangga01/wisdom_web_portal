const ENDPOINT = "/api/v1/pageview";
const OPT_OUT_KEY = "wisdom_ignore";
const TOGGLE_HASH = "#analytics-toggle";

/**
 * First-party, cookieless pageview beacon. Sends one POST per page display —
 * initial load plus back/forward-cache restores — carrying only the pathname
 * and the referrer; the server derives everything else from the request and
 * discards identifying material immediately (see
 * docs/architecture/first-party-analytics-plan.md).
 *
 * The endpoint is same-origin relative, so a development or preview server
 * receives its own beacons and production statistics can never be polluted
 * from elsewhere. No cookies or storage are used except the explicit operator
 * opt-out flag below.
 */
export function initializeAnalyticsBeacon(): void {
  // Operators exclude their own browser once per device by visiting any page
  // with this hash (mirrors GoatCounter's toggle convention).
  if (window.location.hash === TOGGLE_HASH) {
    const disabled = window.localStorage.getItem(OPT_OUT_KEY) === "true";
    window.localStorage.setItem(OPT_OUT_KEY, disabled ? "false" : "true");
    window.alert(disabled ? "방문 통계 수집을 다시 켰습니다." : "이 브라우저를 방문 통계에서 제외했습니다.");
  }

  const send = (): void => {
    if (window.localStorage.getItem(OPT_OUT_KEY) === "true") return;
    const payload = JSON.stringify({ p: window.location.pathname, r: document.referrer });
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  };

  const sendWhenVisible = (): void => {
    // A prerendered page has not actually been seen yet; count it only once
    // the browser activates it.
    const prerendering = (document as Document & { prerendering?: boolean }).prerendering;
    if (prerendering) {
      document.addEventListener("prerenderingchange", () => send(), { once: true });
      return;
    }
    send();
  };

  sendWhenVisible();

  // A back/forward-cache restore is a real re-view that fires no new page
  // load; persisted === false also fires right after the initial load and is
  // ignored because the initial view was already counted above.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) send();
  });
}
