// Rendered ChatGPT navigation only. Never turn anonymous MCP session IDs into URLs.
export function continuationDiscoveryDom({ limit = 12 } = {}) {
  const visible = el => {
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  if (location.origin !== "https://chatgpt.com") return { reason: "login_required", urls: [] };
  const controls = [...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
  if (controls.some(el => /^(Log in|Sign in|로그인)$/i.test((el.getAttribute("aria-label") || el.textContent || "").trim()))) return { reason: "login_required", urls: [] };
  const urls = [];
  // Native sidebar/navigation excludes links quoted in a conversation or a tool result.
  for (const link of document.querySelectorAll('nav a[href],aside a[href],[data-testid="sidebar"] a[href],#history a[href]')) {
    if (!visible(link) || link.closest('main,[role="main"],[data-message-author-role]')) continue;
    const url = new URL(link.getAttribute("href") || "", location.href);
    if (url.origin !== "https://chatgpt.com" || !/^\/c\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(url.pathname) || url.search || url.hash) continue;
    if (!urls.includes(url.href)) urls.push(url.href);
    if (urls.length >= Math.min(30, limit)) break;
  }
  return { reason: urls.length ? "recent_chats_observed" : "no_recent_chats", urls };
}
