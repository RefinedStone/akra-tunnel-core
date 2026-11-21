import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContinuationHost } from "../legacy/index.mjs";

for (const matchesPolicy of [true, false]) {
  test(`shared host uses stored call evidence (configured app match: ${matchesPolicy})`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "akra-core-enrollment-"));
    const id = "00000000-0000-4000-8000-000000000001";
    const chatUrl = `https://chatgpt.com/c/${id}`;
    const expectedApp = "asdk_app_fixture";
    const data = { calls: [{ appId: matchesPolicy ? expectedApp : "asdk_app_other" }], text: "synthetic conversation text" };
    const inspector = Object.assign(new EventEmitter(), {
      attach() {},
      async sendCommand(command) {
        if (command === "Network.getResponseBody") return { body: JSON.stringify(data) };
      },
    });
    const view = Object.assign(new EventEmitter(), {
      cdp: inspector,
      async load(url) {
        if (url !== chatUrl) return;
        const requestId = "fixture";
        const urlOfResponse = `https://chatgpt.com/backend-api/conversation/${id}`;
        inspector.emit("message", {}, "Network.requestWillBeSent", { requestId, request: { url: urlOfResponse, method: "GET" } });
        inspector.emit("message", {}, "Network.responseReceived", { requestId, response: { url: urlOfResponse, status: 200, mimeType: "application/json" } });
        inspector.emit("message", {}, "Network.loadingFinished", { requestId, encodedDataLength: 512 });
      },
      async evaluate() { return { chatUrl, turnId: "synthetic-turn", phase: "failed" }; },
      isDestroyed: () => false,
    });
    const events = new EventEmitter();
    const diagnostics = [];
    const classifications = [];
    const host = createContinuationHost({
      home,
      discoveryTiming: { navigationMs: 60_000 },
      frontend: {
        newView: () => view, isShown: () => false, start() {}, stop() {},
        closeView() { inspector.emit("detach"); },
      },
      runtime: {
        CONTINUATION_PROTOCOL: 1,
        continuationHome: directory => directory,
        continuationPipe: directory => process.platform === "win32"
          ? `\\\\.\\pipe\\${path.basename(home)}` : path.join(directory, "enroll.sock"),
        ensurePrivateDirectory: directory => mkdir(directory, { recursive: true }),
        ContinuationStore: class { async load() {} async expireStale() { return []; } list() { return []; } },
        ContinuationEnrollment: class {
          async load() {}
          status() { return { policy: { enabled: true, plugins: [{ appId: expectedApp }] }, discovery: { rateLimitedUntil: 0 } }; }
          canDiscover() { return true; }
          async reserveDiscoveryPage() { return chatUrl; }
          noteDiscovery() {}
          noteTagDiagnostic(event) { diagnostics.push(event); }
          async consider(_store, observation) { events.emit("observation", observation); }
        },
        usedTunnelApp(conversation, appIds) {
          classifications.push({ conversation, appIds });
          return conversation.calls.some(call => appIds.includes(call.appId));
        },
      },
    });
    try {
      const observation = once(events, "observation", { signal: AbortSignal.timeout(5000) });
      assert.deepEqual(await host.start(), { host: true });
      const [observed] = await observation;
      assert.deepEqual(classifications, [{ conversation: data, appIds: [expectedApp] }]);
      assert.deepEqual(observed, {
        chatUrl, turnId: "synthetic-turn", phase: "failed", ...(matchesPolicy ? { tunnelUsed: true } : {}),
      });
      assert.ok(diagnostics.some(event => event.outcome === (matchesPolicy ? "tunnel_calls" : "no_tunnel_calls")));
      assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic conversation text|asdk_app|carriers/);
    } finally {
      await host.stop();
      await rm(home, { recursive: true, force: true });
    }
  });
}
