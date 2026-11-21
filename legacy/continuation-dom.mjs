// Serialized into a sandboxed ChatGPT page. Uses rendered DOM only.
export function continuationDom({ expectedUrl, action = "observe", expectedTurnId, expectedResponseId, readResponseId = false, expectedAccount, prompt, allowDisconnected = false, allowStopped = false, plugins = [], query = "", plugin } = {}) {
  if (location.href !== expectedUrl) return action === "observe"
    ? { chatUrl: location.origin + location.pathname, turnId: null, phase: "unknown", composerEmpty: false, attachments: false, account: null, reason: "conversation_changed", latestUserText: "", assistantProgress: false }
    : { error: "TARGET_NOT_READY" };
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const label = el => normalize(el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ") || el.getAttribute("title") || el.textContent);
  const usersSelector = '[data-message-author-role="user"],[data-chatgpt-search-unit-key$=":user"],[data-user-message-bubble]';
  const users = [...document.querySelectorAll(usersSelector)].filter(el => !el.parentElement?.closest(usersSelector));
  const last = users.at(-1);
  const owner = last?.closest('[data-message-id],[data-chatgpt-search-message-ids],[data-chatgpt-search-unit-key]');
  const candidateId = owner?.getAttribute("data-message-id") || owner?.getAttribute("data-chatgpt-search-message-ids") || owner?.getAttribute("data-chatgpt-search-unit-key") || null;
  const turnId = candidateId && candidateId.length <= 512 ? candidateId : null;
  const afterUser = el => last && !!(last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.closest(usersSelector);
  const controls = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const tailControls = controls.filter(afterUser);
  const failure = tailControls.some(el => /^(생각 실패|Thought failed|Thinking failed|Something went wrong|응답 생성 중 오류가 발생했습니다)[.!]?$/i.test(label(el)))
    || [...document.querySelectorAll('[role="alert"]')].filter(visible).filter(afterUser).some(el => /^(Something went wrong|오류가 발생했습니다|응답 생성 중 오류가 발생했습니다)[.!]?$/i.test(label(el)));
  const busy = controls.some(el => /^(응답 중지|응답 생성 중지|중지|Stop generating|Stop response)$/i.test(label(el)) || el.getAttribute("data-testid") === "stop-button");
  const stopped = tailControls.some(el => /^(생각 중지됨|응답이 중지됨|Thought stopped|Stopped thinking|Response stopped)$/i.test(label(el)));
  const approval = tailControls.some(el => /^(승인|허용|항상 허용|Approve|Allow|Always allow|Confirm)$/i.test(label(el)));
  const final = tailControls.some(el => /^(응답 다시 생성|Regenerate response|Read aloud|소리 내어 읽기)$/i.test(label(el)));
  // This is a transport notice, not a final answer or a user-authored quote.
  const disconnectedText = /^(연결이 해제되었습니다[.!]?\s*전체 답변을 기다리는 중입니다[.!]?|Connection (?:interrupted|lost)[.!]?\s*Waiting for the complete (?:answer|response)[.!]?)$/i;
  // Seen 2026-11-21 while the server kept calling tunnel tools. Its own "다시 시도" button may resend
  // the message, so it is treated as a disconnection (reload only) and never clicked. English text is unverified.
  const sendTimeoutText = /^(메시지 전송 시간이 초과되었습니다[.!]?\s*다시 시도하세요[.!]?|(?:Message|Request) timed out[.!]?\s*(?:Please )?try again[.!]?)$/i;
  const transportNotice = text => [...document.querySelectorAll('[role="alert"],[role="status"],div,p,span')].filter(visible).filter(afterUser)
    .some(el => !el.closest('pre,code,blockquote,.markdown,[data-message-author-role="assistant"],[data-chatgpt-search-unit-key$=":assistant"]') && text.test(normalize(el.textContent)));
  const sendTimeout = transportNotice(sendTimeoutText);
  const disconnected = sendTimeout || transportNotice(disconnectedText);
  const composer = [...document.querySelectorAll('#prompt-textarea,[contenteditable="true"][data-lexical-editor],div.ProseMirror[contenteditable="true"],textarea[placeholder*="Message"],textarea[placeholder*="메시지"],textarea[placeholder*="Ask"]')].find(visible);
  const composerText = composer ? normalize(composer.value ?? composer.innerText ?? composer.textContent) : "";
  const mentionSelector = '[app-mention-path],[data-prompt-link-href^="app://"]';
  const selectedPlugins = composer ? [...composer.querySelectorAll(mentionSelector)].filter(el => !el.parentElement?.closest(mentionSelector)).map(el => ({
    name: normalize(el.getAttribute("app-mention-name") || el.getAttribute("app-mention-display-name") || el.getAttribute("data-prompt-link-label")?.replace(/^\$/, "") || el.textContent),
    appId: (el.getAttribute("app-mention-path") || el.getAttribute("data-prompt-link-href") || "").replace(/^app:\/\//, ""),
  })) : [];
  const draftNode = composer?.cloneNode(true);
  draftNode?.querySelectorAll(mentionSelector).forEach(el => el.remove());
  // Native multi-line insertion uses paragraph/div/br nodes in ProseMirror.
  // textContent alone joins their words and incorrectly rejects our own prompt.
  draftNode?.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode('\n')));
  draftNode?.querySelectorAll('p,div,li').forEach(el => { el.prepend(document.createTextNode('\n')); el.append(document.createTextNode('\n')); });
  const draftText = normalize(composer?.value ?? draftNode?.textContent);
  const samePlugins = (a, b) => a.length === b.length && a.every(p => b.some(q => q.appId === p.appId && q.name === p.name));
  const observedPlugins = [];
  for (const link of last?.querySelectorAll('a[href]') || []) {
    if (link.closest('pre,code,blockquote')) continue;
    const match = (link.getAttribute("href") || "").match(/^(?:app:\/\/|(?:https:\/\/chatgpt\.com)?\/plugins\/plugin_)(asdk_app_[a-zA-Z0-9_-]{1,180})$/);
    const name = normalize(link.textContent).replace(/^\$/, "");
    if (match && /^[\p{L}\p{N}_. -]{1,100}$/u.test(name) && !observedPlugins.some(p => p.appId === match[1])) observedPlugins.push({ name, appId: match[1] });
  }
  const composerRegion = composer?.closest('form,[data-testid="composer"],[data-composer-body],[class*="ComposerLayoutBody-"]') || composer?.parentElement;
  const main = document.querySelector('main,[role="main"]');
  const loadError = !last && !composer && main && [...main.querySelectorAll('div,p,span')].filter(visible)
    .some(el => /^(이 ChatGPT 대화를 불러올 수 없습니다|Unable to load (?:this ChatGPT )?conversation)[.!]?$/i.test(normalize(el.textContent)));
  const pageRetry = loadError ? controls.filter(el => main.contains(el) && /^(다시 시도|Retry|Try again)$/i.test(label(el)) && !el.disabled) : [];
  const attachments = [...(composerRegion?.querySelectorAll('img,[data-testid*="attachment"],[data-testid*="file-thumbnail"],[data-testid="file-upload-progress"],[aria-label*="Remove attachment"],[aria-label*="Remove file"],[aria-label*="첨부 파일 삭제"],[aria-label*="파일 삭제"],[aria-label*="파일 제거"],[aria-label*="첨부 제거"]') || [])].some(el => !el.closest(mentionSelector));
  const accountNode = [...document.querySelectorAll('[data-testid="profile-menu"],[role="menu"],[aria-label*="프로필"],[aria-label*="Profile"]')].filter(visible).find(el => /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(label(el)));
  const account = accountNode ? label(accountNode).match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0] || null : null;
  const phase = pageRetry.length === 1 && !busy && !approval ? "load_failed" : location.href !== expectedUrl || !last || !turnId || !composer ? "unknown" : approval ? "blocked" : stopped ? "stopped" : !busy && final ? "complete" : disconnected ? "disconnected" : busy && failure ? "unknown" : busy ? "running" : failure ? "failed" : "unknown";
  const assistant = [...document.querySelectorAll('[data-message-author-role="assistant"],[data-chatgpt-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":thoughts"]')].filter(afterUser);
  let renderedResponseId;
  if (readResponseId || expectedResponseId) {
    const reply = assistant.findLast(el => visible(el) && el.matches('[data-message-author-role="assistant"],[data-chatgpt-search-unit-key$=":assistant"]'));
    const id = reply?.getAttribute("data-message-id") || reply?.getAttribute("data-chatgpt-search-message-ids");
    if (id && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) renderedResponseId = id;
    if (expectedResponseId && renderedResponseId && renderedResponseId !== expectedResponseId) return { error: "CLOUD_STOP_NOT_CONFIRMED" };
  }
  // Work-mode activity is exposed as a Conversation region, without assistant
  // message wrappers. Include only rendered text after the latest user bubble.
  const conversation = document.querySelector('[aria-label="Conversation"]');
  const activity = [];
  if (conversation && last) {
    const walker = document.createTreeWalker(conversation, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (el && afterUser(el) && visible(el) && !composerRegion?.contains(el) && !el.closest('[role="status"],[role="alert"],script,style') && !disconnectedText.test(normalize(node.textContent)) && !sendTimeoutText.test(normalize(node.textContent))) activity.push(normalize(node.textContent));
    }
  }
  const progressText = (activity.length ? activity.join(" ") : assistant.map(el => normalize(el.textContent)).join("\n")).replace(/\b\d+(?:h|m|s)\b|\d+\s*(?:시간|분|초)/g, "");
  let progressHash = 2166136261;
  for (let i = 0; i < progressText.length; i++) progressHash = Math.imul(progressHash ^ progressText.charCodeAt(i), 16777619);
  const safeUrl = location.href === expectedUrl ? expectedUrl : location.origin + location.pathname;
  const observation = { chatUrl: safeUrl, turnId, phase, composerEmpty: !!composer && !composerText && !selectedPlugins.length, attachments, account,
    reason: phase === "unknown" && busy && failure ? "failure_with_running_control" : phase === "disconnected" && sendTimeout ? "send_timeout" : phase, latestUserText: normalize(last?.textContent).slice(0, 12000), assistantProgress: final || assistant.some(el => normalize(el.textContent).length > 20) || tailControls.some(el => !composerRegion?.contains(el) && /^(생각 중|Thinking|Working)$/i.test(label(el))),
    runningControl: busy, progressKey: (progressHash >>> 0).toString(16), plugins: observedPlugins.slice(0, 8) };
  if (action === "observe") return renderedResponseId ? { ...observation, renderedResponseId } : observation;
  if (action === "retry_load") {
    if (phase !== "load_failed" || (expectedAccount && account?.toLowerCase() !== expectedAccount.toLowerCase())) return { error: "TARGET_NOT_READY" };
    pageRetry[0].click(); return { clicked: true };
  }
  const resumable = allowStopped ? !busy && !approval && !disconnected && ["stopped", "complete", "unknown", "failed"].includes(phase)
    : phase === "failed" || (allowDisconnected && phase === "disconnected");
  if (location.href !== expectedUrl || turnId !== expectedTurnId || !resumable || attachments || !composer || (expectedAccount && account?.toLowerCase() !== expectedAccount.toLowerCase())) return { error: "TARGET_NOT_READY" };
  if (action === "focus") {
    if (composerText || selectedPlugins.length) return { error: "DRAFT_PRESENT" };
    composer.focus(); return { focused: true };
  }
  if (action === "plugin_state") return { selectedPlugins, draftText };
  if (action === "select_plugin") {
    if (draftText !== normalize(query) || !samePlugins(selectedPlugins, plugins)) return { error: "DRAFT_CHANGED" };
    const candidates = controls.filter(el => !composerRegion?.contains(el) && !el.disabled &&
      (label(el) === plugin.name || label(el).startsWith(plugin.name + " ")));
    if (candidates.length !== 1) return { error: "PLUGIN_SELECTION_UNAVAILABLE" };
    candidates[0].click(); return { selected: true };
  }
  if (action === "focus_append") {
    if (draftText || !samePlugins(selectedPlugins, plugins)) return { error: "PLUGIN_CONTEXT_MISSING" };
    composer.focus();
    const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(composer); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
    return { focused: true };
  }
  if (action === "send") {
    if (!samePlugins(selectedPlugins, plugins)) return { error: "PLUGIN_CONTEXT_MISSING" };
    if (draftText !== normalize(prompt)) return { error: "DRAFT_CHANGED" };
    const sends = controls.filter(el => composerRegion?.contains(el) && !el.disabled && (/^(보내기|전송|Send message|Send prompt|Send)$/i.test(label(el)) || el.getAttribute("data-testid") === "send-button"));
    if (sends.length !== 1) return { error: "SEND_UNAVAILABLE" };
    sends[0].click(); return { clicked: true };
  }
  return { error: "ACTION_UNSUPPORTED" };
}
