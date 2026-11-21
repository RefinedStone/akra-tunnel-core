import { readCloudTurnState } from "./continuation-cloud-state.mjs";

const conversationOrigin = "https://chatgpt.com";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// Allow long conversations with many stored tool calls.
const maxBodyBytes = 8 * 1024 * 1024;

export function sameCloudTurn(turnId, snapshot) {
  return !!snapshot && (turnId === snapshot.turnId || turnId === snapshot.turnId + ":user");
}

// Observe responses already requested by this signed-in view. No requests,
// credentials, headers, or message bodies leave the browser observer.
export function observeCloudConversation(contents, chatUrl, now = Date.now) {
  const conversationId = chatUrl.split("/").at(-1);
  const responsePath = "/backend-api/conversations/" + conversationId;
  const inspector = contents.cdp;
  // Tags stay across reloads: this observer belongs to one conversation URL.
  let latest, currentRequest, revision = 0;

  const selectedResponse = (value) => {
    try {
      const url = new URL(value);
      return url.origin === conversationOrigin && url.pathname === responsePath;
    } catch { return false; }
  };
  const onSelectedPage = () => !contents.isDestroyed() && contents.url() === chatUrl;
  const reset = () => {
    revision++;
    latest = undefined;
    currentRequest = undefined;
  };
  const onMessage = (_event, method, input) => {
    if (method === "Network.requestWillBeSent") {
      if (input.request.method === "GET" && selectedResponse(input.request.url) && onSelectedPage()) {
        reset();
        currentRequest = { id: input.requestId, accepted: false };
      } else if (currentRequest?.id === input.requestId) reset();
      return;
    }
    if (!currentRequest || currentRequest.id !== input.requestId) return;
    if (method === "Network.responseReceived") {
      const response = input.response;
      currentRequest.accepted = selectedResponse(response.url) && response.status === 200 &&
        response.mimeType === "application/json" && !response.fromDiskCache && !response.fromServiceWorker;
    } else if (method === "Network.loadingFailed" || method === "Network.requestServedFromCache") reset();
    else if (method === "Network.loadingFinished") {
      const accepted = currentRequest.accepted;
      currentRequest = undefined;
      if (!accepted || input.encodedDataLength > maxBodyBytes || !onSelectedPage()) return;
      const requestedAt = revision;
      void inspector.sendCommand("Network.getResponseBody", { requestId: input.requestId }).then(result => {
        if (revision !== requestedAt || !onSelectedPage() || typeof result.body !== "string" ||
            result.body.length > maxBodyBytes * 1.4) return;
        const body = result.base64Encoded ? Buffer.from(result.body, "base64") : Buffer.from(result.body);
        if (body.length > maxBodyBytes) return;
        const data = JSON.parse(body.toString("utf8"));
        const outcome = readCloudTurnState(data, conversationId);
        if (outcome) latest = { ...outcome, observedAt: now() };
      }).catch(() => {});
    }
  };
  const cleanup = () => {
    reset();
    inspector.off("message", onMessage);
    contents.off("did-start-loading", reset);
    contents.off("render-process-gone", reset);
  };
  try {
    if (!uuid.test(conversationId) || inspector.isAttached()) return () => undefined;
    inspector.attach("1.3");
    inspector.on("message", onMessage);
    inspector.once("detach", cleanup);
    contents.on("did-start-loading", reset);
    contents.on("render-process-gone", reset);
    void inspector.sendCommand("Network.enable", {
      maxTotalBufferSize: maxBodyBytes * 2, maxResourceBufferSize: maxBodyBytes, maxPostDataSize: 0,
    }).catch(() => {
      cleanup();
      if (!contents.isDestroyed() && inspector.isAttached()) inspector.detach();
    });
  } catch { cleanup(); }
  const read = () => onSelectedPage() ? latest : undefined;
  return read;
}
