import { readPushFrame } from "./continuation-push.mjs";

const uuidText = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const conversationPath = new RegExp(`^/backend-api/conversations?/(${uuidText})$`, "i");
const maxBodyBytes = 8 * 1024 * 1024;
const MAX_SOCKETS = 20, MAX_CONVERSATIONS = 32;

const pushHost = host => host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host.endsWith(".openai.com");
const pushSocket = url => { try { const u = new URL(url); return u.protocol === "wss:" && pushHost(u.hostname); } catch { return false; } };
// Diagnostic path template: a segment holding a UUID, an 8+ hex run or a number becomes
// {id} or {n}, so no room, file or conversation ID is kept (they are not always UUIDs).
const pathTemplate = pathname => pathname.split("/").map(segment =>
  new RegExp(uuidText, "i").test(segment) || /[0-9a-f]{8}/i.test(segment) ? "{id}" : /^\d+$/.test(segment) ? "{n}" : segment.replace(/[^\w.-]/g, ""),
).join("/").slice(0, 80);
const remember = (map, key, value, max) => {
  // Keep the newest entries: a request without a finish event must never stop observation.
  if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
};

// Observe only the discovery view. Do not replace handlers on the shared login session.
// Push frames are ones the page already received; this observer sends nothing.
// Pass conversation data only to the caller that classifies stored call evidence.
export async function observeDiscoveryRateLimits(contents, onRateLimit, onPush = { socket() {}, frame() {} }, onConversation = () => undefined, onDiagnostic = () => {}) {
  const inspector = contents.cdp;
  const sockets = new Set(), conversations = new Map();
  const conversationOf = url => { try { const u = new URL(url); return u.origin === "https://chatgpt.com" ? conversationPath.exec(u.pathname)?.[1]?.toLowerCase() : undefined; } catch { return undefined; } };
  const readConversation = (requestId, id) => {
    const chatUrl = "https://chatgpt.com/c/" + id;
    const report = (outcome, extra = {}) => onDiagnostic({ kind: "body", chatUrl, outcome, ...extra });
    void inspector.sendCommand("Network.getResponseBody", { requestId }).then(result => {
      if (typeof result.body !== "string" || result.body.length > maxBodyBytes * 1.4) { report("too_large"); return; }
      const body = result.base64Encoded ? Buffer.from(result.body, "base64") : Buffer.from(result.body);
      if (body.length > maxBodyBytes) { report("too_large", { bytes: body.length }); return; }
      let data;
      try { data = JSON.parse(body.toString("utf8")); } catch { report("parse_failed", { bytes: body.length }); return; }
      let outcome;
      try { outcome = onConversation(chatUrl, data); } catch { outcome = "evidence_failed"; }
      report(typeof outcome === "string" ? outcome : "read", { bytes: body.length });
    }, () => report("body_unavailable"));
  };
  // A main-frame navigation drops the page's sockets without a close event. Subframes (widgets) do not.
  const onNavigation = (event, _url, isInPlace, isMainFrame) => {
    if ((event?.isMainFrame ?? isMainFrame) && !(event?.isSameDocument ?? isInPlace)) sockets.clear();
  };
  const onMessage = (_event, method, details) => {
    if (method === "Network.requestWillBeSent") {
      const { url, method: verb } = details.request;
      if (verb === "GET" && url.startsWith("https://chatgpt.com/backend-api/")) {
        try { onDiagnostic({ kind: "path", path: pathTemplate(new URL(url).pathname) }); } catch {}
      }
      const id = verb === "GET" ? conversationOf(url) : undefined;
      if (id) remember(conversations, details.requestId, { id, ok: false }, MAX_CONVERSATIONS);
      return;
    }
    if (method === "Network.loadingFailed") { conversations.delete(details.requestId); return; }
    if (method === "Network.loadingFinished") {
      const request = conversations.get(details.requestId);
      conversations.delete(details.requestId);
      if (request?.ok && details.encodedDataLength <= maxBodyBytes) readConversation(details.requestId, request.id);
      return;
    }
    if (method === "Network.responseReceived" && conversations.has(details.requestId)) {
      const r = details.response;
      const ok = r.status === 200 && r.mimeType === "application/json" && !r.fromDiskCache && !r.fromServiceWorker;
      conversations.get(details.requestId).ok = ok;
      onDiagnostic({ kind: "response", outcome: ok ? "ok" : `status_${r.status}_${String(r.mimeType).replace(/[^\w/.-]/g, "").slice(0, 30)}` });
    }
    if (method === "Network.webSocketCreated") {
      if (!pushSocket(details.url)) return;
      if (sockets.size >= MAX_SOCKETS) sockets.delete(sockets.values().next().value);
      sockets.add(details.requestId); onPush.socket();
      return;
    }
    if (method === "Network.webSocketClosed") { sockets.delete(details.requestId); return; }
    if (method === "Network.webSocketFrameReceived") {
      // Opcode 1 is a text frame. Binary frames are skipped.
      if (!sockets.has(details.requestId) || details.response?.opcode !== 1) return;
      const frame = readPushFrame(details.response.payloadData);
      if (frame) onPush.frame(frame);
      return;
    }
    if (method !== "Network.responseReceived" || details.response.status !== 429 ||
        !["Document", "XHR", "Fetch"].includes(details.type) ||
        !details.response.url.startsWith("https://chatgpt.com/")) return;
    const headers = details.response.headers ?? {};
    const key = Object.keys(headers).find(name => name.toLowerCase() === "retry-after");
    onRateLimit(key ? String(headers[key]) : undefined);
  };
  inspector.attach("1.3");
  inspector.on("message", onMessage);
  contents.on("did-start-navigation", onNavigation);
  inspector.once("detach", () => { inspector.off("message", onMessage); contents.off("did-start-navigation", onNavigation); });
  await inspector.sendCommand("Network.enable", { maxTotalBufferSize: maxBodyBytes * 2, maxResourceBufferSize: maxBodyBytes, maxPostDataSize: 0 });
}
