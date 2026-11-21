import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { continuationDom } from "./continuation-dom.mjs";
import { continuationDiscoveryDom } from "./continuation-discovery-dom.mjs";
import { observeDiscoveryRateLimits } from "./continuation-discovery-network.mjs";
import { observeCloudConversation, sameCloudTurn } from "./continuation-cloud-snapshot.mjs";
import { sendContinuationInput } from "./continuation-input.mjs";
import { acquireHostLease } from "../chat.mjs";
export function createContinuationHost({ home, onStatus = () => {}, discoveryTiming, frontend, runtime }) {
  const { CONTINUATION_PROTOCOL, continuationHome, continuationPipe, startWatchSchema, watchIdSchema, checkpointSchema, turnRefSchema, ContinuationStore, OBSERVATION_MAX_AGE_MS, ContinuationEnrollment, DISCOVERY_HOME, enrollmentPolicySchema, checkContinuation, continueStoppedTurn, ensurePrivateDirectory, usedTunnelApp } = runtime;
  if (typeof usedTunnelApp !== "function") throw new TypeError("runtime.usedTunnelApp is required");
  const directory = continuationHome(path.join(home, "continuation")), descriptor = path.join(directory, "browser.json");
  const token = randomBytes(32).toString("hex"), socketPath = continuationPipe(directory);
  const store = new ContinuationStore(directory), views = new Map(), sockets = new Set(), interrupted = new Set();
  const enrollment = new ContinuationEnrollment(directory, Date.now, discoveryTiming);
  const cloudSnapshots = new WeakMap();
  let server, timer, stopped = true, ownsSocket = false, queue = Promise.resolve();
  const serial = fn => { const op = queue.then(fn); queue = op.catch(() => {}); return op; };
  let discoveryTimer, discoveryView, discoveryObserver, discoveryPending, discoveryUrls = [];
  const discoveryEvidence = new Map();
  let lease;
  const { newView, showView, parkView } = frontend;
  const loadConversation = (view, url) => view.load(url);
  const bounded = async (operation, milliseconds) => {
    let timeout;
    try { return await Promise.race([operation, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("BROWSER_TIMEOUT")), milliseconds); })]); }
    finally { clearTimeout(timeout); }
  };
  const viewFor = async watch => {
    let view = views.get(watch.id);
    if (!view || view.isDestroyed()) {
      view = newView();
      cloudSnapshots.set(view, observeCloudConversation(view, watch.chatUrl));
      views.set(watch.id, view);
      await loadConversation(view, watch.chatUrl);
    }
    // Do not follow a redirect or silently return to a changed conversation.
    return view;
  };
  const evalDom = (view, args) => view.evaluate(continuationDom, args);
  const prepareDiscoveryView = async () => {
    if (!discoveryView || discoveryView.isDestroyed()) {
      const view = newView();
      discoveryView = view;
      // Chromium needs a committed renderer before Network.enable can acknowledge.
      discoveryObserver = bounded((async () => {
        await view.load("about:blank");
        await observeDiscoveryRateLimits(view, header => {
          void enrollment.rateLimited(header).catch(() => enrollment.noteDiscovery("browser_unavailable"));
        }, {
          socket: () => enrollment.notePushSocket(),
          // A pushed chat only reorders discovery. The shared navigation budget still decides when it opens.
          frame: frame => { if (enrollment.notePushFrame(frame)) wakeForHint(); },
        }, (chatUrl, data) => {
          const used = usedTunnelApp(data, (enrollment.status().policy?.plugins ?? []).map(plugin => plugin.appId));
          discoveryEvidence.delete(chatUrl);
          discoveryEvidence.set(chatUrl, used);
          if (discoveryEvidence.size > 50) discoveryEvidence.delete(discoveryEvidence.keys().next().value);
          return used ? "tunnel_calls" : "no_tunnel_calls";
        }, event => enrollment.noteTagDiagnostic(event));
      })(), 5000).catch(error => {
        frontend.closeView(view);
        throw error;
      });
    }
    await discoveryObserver;
    return discoveryView;
  };
  const canScan = () => !stopped && enrollment.canDiscover() && !frontend.isShown(discoveryView);
  const discover = async () => {
    if (stopped || !enrollment.status().policy?.enabled || discoveryPending) return;
    discoveryPending = (async () => {
      let candidateUrl;
      try {
        if (!canScan()) return;
        const policy = enrollment.status().policy;
        const page = await enrollment.reserveDiscoveryPage(discoveryUrls, store.list());
        if (!page || !canScan()) return;
        await prepareDiscoveryView();
        if (!canScan()) return;
        enrollment.noteDiscovery("scanning", discoveryUrls.length);
        if (page === DISCOVERY_HOME) {
          discoveryUrls = [];
          await loadConversation(discoveryView, page);
          let navigation;
          // ChatGPT renders the sidebar asynchronously after the load event.
          for (let i = 0; i < 10 && canScan(); i++) {
            navigation = await discoveryView.evaluate(continuationDiscoveryDom, { limit: policy.recentLimit });
            if (navigation.urls.length || navigation.reason === "login_required") break;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          if (!canScan()) return;
          enrollment.noteDiscovery(navigation?.reason || "browser_unavailable", navigation?.urls.length || 0);
          discoveryUrls = navigation?.urls ?? [];
          return;
        }
        const url = page;
        candidateUrl = page;
        discoveryEvidence.delete(url);
        await loadConversation(discoveryView, url);
        let observation;
        for (let i = 0; i < 10 && canScan(); i++) {
          observation = await evalDom(discoveryView, { expectedUrl: url });
          if (observation.turnId || observation.phase === "load_failed") break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        // Read evidence from the page's current response, not a previous visit.
        for (let i = 0; i < 5 && canScan() && observation?.chatUrl === url && !discoveryEvidence.has(url); i++) await new Promise(resolve => setTimeout(resolve, 200));
        if (!canScan()) return;
        if (observation && discoveryEvidence.get(url) === true) observation = { ...observation, tunnelUsed: true };
        if (observation?.chatUrl === url) {
          const decision = await serial(() => canScan() ? enrollment.consider(store, observation) : null);
          if (decision?.reason === "registered") onStatus({ watchId: decision.watchId, reason: "automatically_registered" });
        } else await serial(() => enrollment.unavailable(url));
      } catch {
        enrollment.noteDiscovery("browser_unavailable");
        if (candidateUrl && canScan()) await serial(() => enrollment.unavailable(candidateUrl)).catch(() => {});
      }
    })();
    try { await discoveryPending; }
    finally {
      discoveryPending = undefined;
      const remaining = enrollment.status().discovery.rateLimitedUntil - Date.now();
      scheduleDiscovery(Math.min(2_147_483_647, Math.max(discoveryTiming.navigationMs, remaining)));
    }
  };
  const scheduleDiscovery = delay => {
    if (stopped || discoveryTimer || discoveryPending || !enrollment.status().policy?.enabled) return;
    discoveryTimer = setTimeout(() => { discoveryTimer = undefined; void discover(); }, delay);
  };
  // A pending timer already runs discovery at or after the budget opens; only an idle loop needs a wake.
  const wakeForHint = () => scheduleDiscovery(Math.max(0, enrollment.status().discovery.nextNavigationAt - Date.now()));
  const browser = {
    async observe(watch, readResponseId = false) {
      const view = await viewFor(watch);
      const rendered = await evalDom(view, { expectedUrl: watch.chatUrl, readResponseId });
      const cloudSnapshot = cloudSnapshots.get(view)?.();
      return cloudSnapshot ? { ...rendered, cloudSnapshot } : rendered;
    },
    async observeStopped(watch) {
      const observation = await browser.observe(watch, true);
      const snapshot = observation.cloudSnapshot;
      if (observation.renderedResponseId && snapshot && Date.now() - snapshot.observedAt <= OBSERVATION_MAX_AGE_MS) {
        if (observation.renderedResponseId !== snapshot.responseId) throw new Error("CLOUD_STOP_NOT_CONFIRMED");
        return observation;
      }
      // Work pages can omit the assistant ID. Re-read the selected branch even when the cached stop is recent.
      if (watch.checkpoint.stage !== "active" || stopped || interrupted.has(watch.id) ||
          observation.chatUrl !== watch.chatUrl || !observation.turnId || observation.turnId !== watch.observation?.turnId ||
          !observation.composerEmpty || observation.attachments || observation.runningControl ||
          ["running", "blocked", "disconnected", "load_failed"].includes(observation.phase) ||
          (watch.expectedAccount && observation.account?.toLowerCase() !== watch.expectedAccount.toLowerCase())) throw new Error("CLOUD_STOP_NOT_CONFIRMED");
      await loadConversation(await viewFor(watch), watch.chatUrl);
      for (let i = 0; i < 6 && !stopped && !interrupted.has(watch.id); i++) {
        const refreshed = await browser.observe(watch);
        if (refreshed.cloudSnapshot || refreshed.runningControl || refreshed.phase === "blocked") return refreshed;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      return await browser.observe(watch);
    },
    async retryLoad(watch) {
      if (stopped || interrupted.has(watch.id) || !store.status(watch.id).enabled) throw new Error("WATCH_PAUSED");
      const result = await evalDom(await viewFor(watch), { expectedUrl: watch.chatUrl, expectedAccount: watch.expectedAccount, action: "retry_load" });
      if (!result.clicked) throw new Error("PAGE_RETRY_NOT_READY");
    },
    async reconnect(watch) {
      if (stopped || interrupted.has(watch.id) || !store.status(watch.id).enabled) throw new Error("WATCH_PAUSED");
      const view = await viewFor(watch), o = await evalDom(view, { expectedUrl: watch.chatUrl });
      if (o.chatUrl !== watch.chatUrl || o.turnId !== watch.recovery?.turnId || o.phase !== "disconnected" || !o.composerEmpty || o.attachments) return;
      // Reloading restores the stream; it does not cancel the server-side turn.
      await loadConversation(view, watch.chatUrl);
    },
    async send(watch, turnId, prompt, stoppedResponseId) {
      const continueStopped = stoppedResponseId !== undefined;
      if (stopped || interrupted.has(watch.id) || !store.status(watch.id).enabled) throw new Error("WATCH_PAUSED");
      const view = await viewFor(watch);
      const plugins = [...new Map([...watch.plugins, ...watch.requiredPlugins].map(p => [p.appId, p])).values()];
      const args = { expectedUrl: watch.chatUrl, expectedTurnId: turnId, expectedResponseId: stoppedResponseId, expectedAccount: watch.expectedAccount,
        allowDisconnected: !continueStopped && !!watch.recovery?.reloads, allowStopped: continueStopped };
      const assertActive = () => {
        if (stopped || interrupted.has(watch.id) || !store.status(watch.id).enabled) throw new Error("WATCH_PAUSED");
        const snapshot = cloudSnapshots.get(view)?.();
        const sameFreshSnapshot = sameCloudTurn(turnId, snapshot) && Date.now() - snapshot.observedAt <= OBSERVATION_MAX_AGE_MS;
        if (continueStopped && (!sameFreshSnapshot || snapshot.phase !== "stopped" || snapshot.responseId !== stoppedResponseId)) throw new Error("CLOUD_STOP_NOT_CONFIRMED");
        if (!continueStopped && sameFreshSnapshot && snapshot.phase === "running") throw new Error("CLOUD_TURN_RUNNING");
        if (!continueStopped && sameFreshSnapshot && snapshot.phase !== "failed") throw new Error("CLOUD_TURN_ALREADY_ENDED");
      };
      await sendContinuationInput({
        focus: () => view.focus(),
        read: (action, extra) => evalDom(view, { ...args, action, ...extra }),
        insertText: text => view.insertText(text),
        assertActive,
      }, { prompt, plugins });
      // Wait for a persisted user bubble, never for a long model response.
      for (let i = 0; i < 20 && !stopped; i++) {
        const observation = await browser.observe(watch);
        if (observation.latestUserText?.includes(watch.attempts.at(-1)?.marker || "missing-marker")) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error("SEND_UNCONFIRMED");
    },
  };
  const dispatch = async (action, raw = {}) => {
    if (action === "auto_status") return enrollment.status();
    if (action === "auto_configure") {
      const result = await enrollment.configure(enrollmentPolicySchema.parse(raw));
      if (result.policy.enabled) scheduleDiscovery(0);
      else { clearTimeout(discoveryTimer); discoveryTimer = undefined; discoveryUrls = []; }
      return result;
    }
    if (action === "auto_scan" || action === "call_observed") {
      // call_observed (non-Codex tool calls, at most every 10 seconds) is marked before the queue.
      scheduleDiscovery(0);
      return { queued: !!enrollment.status().policy?.enabled, ...enrollment.status() };
    }
    if (action === "auto_show") {
      if ((!discoveryView || discoveryView.isDestroyed()) && !enrollment.canDiscover()) {
        throw new Error("DISCOVERY_BROWSER_UNAVAILABLE");
      }
      const view = await prepareDiscoveryView();
      showView(view);
      if (["", "about:blank"].includes(view.url()) && !view.isLoading() && enrollment.canDiscover()) {
        await loadConversation(view, DISCOVERY_HOME);
      }
      return enrollment.status();
    }
    if (action === "list") return store.list();
    if (action === "start") return store.start(startWatchSchema.parse(raw));
    const id = watchIdSchema.parse(raw.watchId);
    if (action === "status") return store.status(id);
    // Older brokers ignore extra fields on continue_stopped. Use a distinct action for an exact reply.
    if (action === "continue_stopped") throw new Error("CLOUD_RESPONSE_REF_REQUIRED");
    if (action === "continue_stopped_response") {
      return continueStoppedTurn(store, browser, id, turnRefSchema.parse(raw.turnRef), turnRefSchema.parse(raw.responseRef));
    }
    if (["pause", "resume", "stop"].includes(action)) {
      const result = await store.control(id, action);
      if (action === "resume") interrupted.delete(id);
      return result;
    }
    if (action === "checkpoint") {
      const result = await store.checkpoint(id, checkpointSchema.parse(raw.checkpoint));
      if (result.checkpoint.stage === "active") interrupted.delete(id);
      return result;
    }
    if (action === "show") { const view = await viewFor(store.status(id)); showView(view); return { ...store.status(id), browserShown: true }; }
    if (action === "hide") { const view = views.get(id); if (view) parkView(view); return { hidden: true }; }
    if (action === "claim") {
      // UI claims use a new direct browser observation, not a client-supplied status.
      await store.observe(id, await browser.observe(store.status(id)));
      return store.claim(id, "widget");
    }
    if (action === "receipt") {
      if (!/^[a-f0-9]{32}$/.test(raw.attemptId) || !["host_acknowledged", "api_returned", "send_uncertain"].includes(raw.status)) throw new Error("INVALID_RECEIPT");
      return store.receipt(id, raw.attemptId, raw.status);
    }
    throw new Error("ACTION_UNSUPPORTED");
  };
  const tick = async () => {
    if (stopped) return;
    try {
      for (const w of await store.expireStale()) onStatus({ watchId: w.id, reason: w.reason });
      for (const w of store.list().filter(w => w.enabled && !interrupted.has(w.id))) {
        const updated = await checkContinuation(store, browser, w.id);
        if (updated.reason !== w.reason) onStatus({ watchId: w.id, reason: updated.reason });
      }
      for (const [id, view] of views) {
        const w = store.list().find(w => w.id === id);
        if (!w || w.stopped || w.checkpoint.stage === "complete") {
          frontend.closeView(view); views.delete(id);
        }
      }
    } finally {
      if (!stopped) timer = setTimeout(() => void serial(tick).catch(() => {}), 10_000);
    }
  };
  return {
    hide: () => { for (const view of [...views.values(), ...(discoveryView ? [discoveryView] : [])]) parkView(view); },
    async start() {
      if (lease) return { host: !stopped };
      lease = await acquireHostLease(home);
      if (!lease) return { host: false, reason: "chat_host_busy" };
      try {
        await ensurePrivateDirectory(directory);
        const old = await readFile(descriptor, "utf8").then(JSON.parse).catch(() => null);
        if (old?.pid) { try { process.kill(old.pid, 0); throw new Error("CONTINUATION_ALREADY_RUNNING"); } catch (e) { if (e.code !== "ESRCH") throw e; } }
        if (process.platform !== "win32") await rm(socketPath, { force: true });
      server = net.createServer(socket => {
        sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.setEncoding("utf8"); socket.setTimeout(30_000, () => socket.destroy());
        let buffer = "", used = false;
        socket.on("data", chunk => {
          if (used) return;
          buffer += chunk;
          if (Buffer.byteLength(buffer) > 64 * 1024) { socket.destroy(); return; }
          const end = buffer.indexOf("\n"); if (end < 0) return; used = true;
          let incoming;
          try {
            incoming = JSON.parse(buffer.slice(0, end));
            // Mark activity before the queue: a tick in progress must not claim a send first.
            if (incoming.token === token && incoming.action === "call_observed") {
              store.noteTunnelCall(incoming.args?.chatTag);
              if (enrollment.noteTaggedCall(incoming.args?.chatTag)) wakeForHint();
            }
            if (incoming.token === token && watchIdSchema.safeParse(incoming.args?.watchId).success &&
                (["pause", "stop"].includes(incoming.action) || (incoming.action === "checkpoint" && checkpointSchema.safeParse(incoming.args?.checkpoint).success && incoming.args.checkpoint.stage !== "active"))) interrupted.add(incoming.args.watchId);
          } catch {}
          void serial(async () => {
            let id = null;
            try {
              const message = JSON.parse(buffer.slice(0, end)); id = message.id;
              if (message.token !== token || typeof id !== "string" || id.length > 100) throw new Error("AUTHENTICATION_FAILED");
              const result = await dispatch(message.action, message.args);
              if (!socket.destroyed) socket.end(JSON.stringify({ id, ok: true, result }) + "\n");
            } catch (error) {
              const code = error?.code || (/^[A-Z_]+$/.test(error?.message || "") ? error.message : "CONTINUATION_FAILED");
              if (!socket.destroyed) socket.end(JSON.stringify({ id, ok: false, code }) + "\n");
            }
          }).catch(() => socket.destroy());
        });
      });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
      ownsSocket = true;
        await store.load();
        await enrollment.load();
        await writeFile(descriptor, JSON.stringify({ protocol: CONTINUATION_PROTOCOL, token, socketPath, pid: process.pid }), { mode: 0o600 });
        stopped = false; frontend.start();
        timer = setTimeout(() => void serial(tick).catch(() => {}), 1000);
        scheduleDiscovery(1000);
        return { host: true };
      } catch (error) { await this.stop(); throw error; }
    },
    async stop() {
      if (!lease) return;
      stopped = true;
      clearTimeout(timer); clearTimeout(discoveryTimer);
      discoveryTimer = undefined;
      for (const socket of sockets) socket.destroy();
      await queue;
      await discoveryPending;
      if (discoveryView && !discoveryView.isDestroyed()) frontend.closeView(discoveryView);
      discoveryView = undefined;
      for (const view of views.values()) if (!view.isDestroyed()) frontend.closeView(view);
      views.clear();
      frontend.stop();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      const current = await readFile(descriptor, "utf8").then(JSON.parse).catch(() => null);
      if (current?.token === token) await rm(descriptor, { force: true });
      if (ownsSocket && process.platform !== "win32") await rm(socketPath, { force: true });
      ownsSocket = false;
      await lease.release();
      lease = undefined;
    },
  };
}
