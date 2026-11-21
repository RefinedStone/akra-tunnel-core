// Runs in the renderer. Keep it self-contained for PagePort serialization.
export function chatDom({ action, marker, draft, expectedUrl, bootstrap }) {
  if (location.origin !== "https://chatgpt.com") return { phase: "blocked" };
  if (expectedUrl && location.href !== expectedUrl) return { phase: "unknown" };
  const normalize = text => String(text ?? "").replace(/\s+/g, " ").trim();
  const visible = node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const label = node => normalize(node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent);
  const controls = [...document.querySelectorAll('button,[role="button"],a[href]')].filter(visible);
  const enabled = node => !node.disabled && node.getAttribute("aria-disabled") !== "true";
  const login = controls.some(node => /^(log in|sign in|로그인)$/i.test(label(node)));
  const challenge = document.querySelector('iframe[src*="challenges.cloudflare.com"],[data-testid="challenge-running"]');
  const approval = controls.some(node => /^(approve|allow|always allow|confirm|승인|허용|항상 허용)$/i.test(label(node)) && !node.closest('[data-message-author-role="user"]'));
  if (login || challenge || approval) return { phase: "blocked" };
  const user = '[data-message-author-role="user"],[data-chatgpt-search-unit-key$=":user"],[data-user-message-bubble]';
  const assistant = '[data-message-author-role="assistant"],[data-chatgpt-search-unit-key$=":assistant"]';
  const turns = [...document.querySelectorAll(user)].filter(node => visible(node) && !node.parentElement?.closest(user));
  const hasMarker = node => String(node.innerText ?? node.textContent).split(/\r?\n/).some(line => line.trim() === marker)
    || normalize(node.textContent).startsWith(marker + " ");
  const matched = turns.findLast(hasMarker);
  const last = turns.at(-1);
  const after = (anchor, node) => !!(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) && !anchor.contains(node);
  const belongs = node => !!matched && after(matched, node) && (matched === last || !after(turns[turns.indexOf(matched) + 1], node));
  const responses = [...document.querySelectorAll(assistant)].filter(node => visible(node) && belongs(node) && !node.parentElement?.closest(assistant));
  const response = responses.at(-1);
  const result = String(response?.querySelector(".markdown")?.innerText ?? response?.innerText ?? response?.textContent ?? "").trim();
  const stops = controls.filter(node => enabled(node) && (node.getAttribute("data-testid") === "stop-button" || /^(stop (generating|response)|응답 중지|응답 생성 중지)$/i.test(label(node))));
  const completion = controls.some(node => belongs(node) && /^(regenerate response|read aloud|응답 다시 생성|소리 내어 읽기)$/i.test(label(node)));
  const stopped = controls.some(node => belongs(node) && /^(thought stopped|response stopped|생각 중지됨|응답이 중지됨)$/i.test(label(node)));
  const banners = [...document.querySelectorAll('[role="alert"],[role="status"]')].filter(node => visible(node) && !node.closest(`${user},${assistant}`));
  const disconnected = banners.some(node => /^(connection (interrupted|lost)|message timed out|연결이 해제되었습니다|메시지 전송 시간이 초과되었습니다)/i.test(label(node)));
  const failed = banners.some(node => !!matched && belongs(node) && /^(something went wrong|thinking failed|응답 생성 중 오류가 발생했습니다)/i.test(label(node)));
  const composer = [...document.querySelectorAll('#prompt-textarea,[data-lexical-editor][contenteditable="true"],div.ProseMirror[contenteditable="true"]')].find(visible);
  const region = composer?.closest('form,[data-testid="composer"],[data-composer-body],[class*="ComposerLayoutBody-"]') ?? composer?.parentElement;
  const loadFailed = !composer && [...document.querySelectorAll('main p,main div,[role="alert"]')].some(node => visible(node) && /^(unable to load (this ChatGPT )?conversation|이 ChatGPT 대화를 불러올 수 없습니다)[.!]?$/i.test(normalize(node.textContent)));
  const phase = loadFailed ? "load_failed" : disconnected ? "disconnected" : !matched ? "unknown" : stopped || (matched !== last && !completion) ? "stopped"
    : matched === last && stops.length ? "running" : completion && result ? "complete" : failed ? "failed" : "unknown";
  if (action === "observe") return {
    phase, markerObserved: !!matched, assistantProgress: !!result || phase === "running",
    ...(phase === "complete" ? { result } : {}),
    ...(matched && /^\/c\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(location.pathname) ? { chatUrl: location.origin + location.pathname } : {}),
  };
  if (action === "stop") {
    if (matched && matched === last && phase === "running" && stops.length === 1) { stops[0].click(); return { clicked: true }; }
    return { clicked: false, phase };
  }
  // Only the plain chat composer is accepted. Never select apps, attach
  // files, clear user drafts, or click a retry button.
  if (!composer || !region || stops.length || (bootstrap && turns.length) || matched ||
      region.querySelector('img,[data-testid*="attachment"],[data-testid*="file-thumbnail"],[app-mention-path],[data-prompt-link-href^="app://"]')) {
    return { ready: false, phase };
  }
  const clone = composer.cloneNode(true);
  clone.querySelectorAll("br").forEach(node => node.replaceWith(document.createTextNode("\n")));
  clone.querySelectorAll("p,div,li").forEach(node => { node.prepend("\n"); node.append("\n"); });
  const text = normalize(composer.value ?? clone.textContent);
  if (action === "focus" && !text) { composer.focus(); return { ready: true }; }
  if (action === "send" && text === normalize(draft)) {
    const sends = [...region.querySelectorAll('button[data-testid="send-button"],button#composer-submit-button,button[aria-label="Send prompt"],button[aria-label="메시지 보내기"]')].filter(node => visible(node) && enabled(node));
    if (sends.length === 1) { sends[0].click(); return { clicked: true }; }
  }
  return { ready: false, clicked: false, phase };
}
