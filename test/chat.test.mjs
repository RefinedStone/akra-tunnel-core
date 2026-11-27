import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquireHostLease, ChatSessionService } from "../chat.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const conversation = "https://chatgpt.com/c/00000000-0000-4000-8000-000000000001";
const request = { requestId: "job", session: { mode: "new" }, instruction: "fixture", maxResumes: 2 };

async function harness(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "akra-core-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const lease = await acquireHostLease(home);
  let url = "about:blank", draft, clicks = 0, loads = [], sample = { phase: "unknown" }, lost = false, blocked = false;
  let active = true;
  const page = {
    url: () => url,
    load: async value => { loads.push(value); url = value; },
    focus: () => {},
    assertActive: () => { if (!active) throw new Error("TAKEOVER"); },
    insertText: text => { draft = text; },
    async evaluate(_fn, args) {
      if (args.action === "focus") return blocked ? { phase: "blocked" } : { ready: true };
      if (args.action === "send") {
        assert.equal(draft, args.draft);
        assert.match(draft, /^\[akra-chat:[a-f0-9-]+\]\n\nfixture$/);
        clicks++;
        if (lost) throw new Error("RESPONSE_LOST");
        return { clicked: true };
      }
      if (args.action === "stop") return { clicked: true };
      return sample;
    },
  };
  const make = current => new ChatSessionService({ home, lease: current, pageFor: () => page, readinessMs: 0 });
  return { home, lease, make, get clicks() { return clicks; }, loads,
    sample(next, at = conversation) { sample = next; url = at; },
    lose() { lost = true; }, block() { blocked = true; }, takeOver() { active = false; } };
}

test("new job clicks once, matches delivery and preserves its finished result across hosts", async t => {
  const f = await harness(t);
  const host = f.make(f.lease);
  const [a, b] = await Promise.all([host.submit(request), host.submit(request)]);
  assert.deepEqual(a, b);
  assert.equal(f.clicks, 1);
  assert.deepEqual(f.loads, ["https://chatgpt.com/"]);
  f.sample({ phase: "running", markerObserved: true, assistantProgress: true, chatUrl: conversation });
  assert.equal((await host.observe("job")).delivery, "progress_observed");
  f.sample({ phase: "complete", markerObserved: true, result: "answer", chatUrl: conversation });
  assert.equal((await host.observe("job")).phase, "complete");
  await f.lease.release();
  const next = await acquireHostLease(f.home);
  const restarted = f.make(next);
  assert.equal(await restarted.readResult("job"), "answer");
  await restarted.submit(request);
  await assert.rejects(restarted.submit({ ...request, instruction: "different" }), /CHAT_REQUEST_CONFLICT/);
  assert.equal(f.clicks, 1);
  await next.release();
});

test("lost send reply stays uncertain after restart and can be confirmed by observation", async t => {
  const f = await harness(t);
  f.lose();
  assert.equal((await f.make(f.lease).submit(request)).delivery, "send_uncertain");
  await f.lease.release();
  const next = await acquireHostLease(f.home);
  const host = f.make(next);
  assert.equal((await host.submit(request)).delivery, "send_uncertain");
  assert.equal(f.clicks, 1);
  f.sample({ phase: "running", markerObserved: true });
  assert.equal((await host.observe("job")).delivery, "message_observed");
  assert.equal((await host.stop("job")).phase, "stopped");
  await next.release();
});

test("two frontends share one lease, and dead owner recovery elects one winner", async t => {
  const f = await harness(t);
  const denied = await acquireHostLease(f.home);
  assert.equal(denied, null);
  await assert.rejects(f.make(denied).submit(request), /CHAT_HOST_BUSY/);
  assert.equal(f.clicks, 0);
  await f.lease.release();
  execFileSync(process.execPath, ["--input-type=module", "-e",
    `import {acquireHostLease} from "./chat.mjs"; if (!await acquireHostLease(process.argv[1])) process.exitCode=1`, f.home],
  { cwd: root });
  const winners = (await Promise.all(Array.from({ length: 8 }, () => acquireHostLease(f.home)))).filter(Boolean);
  assert.equal(winners.length, 1);
  await winners[0].release();
});

test("bounded recovery reloads an exact persisted URL and never clicks send again", async t => {
  const f = await harness(t);
  const host = f.make(f.lease);
  await host.submit({ ...request, session: { mode: "continue", chatUrl: conversation } });
  f.sample({ phase: "disconnected", markerObserved: true, chatUrl: conversation });
  assert.equal((await host.observe("job")).recovery, "in_progress");
  assert.equal((await host.observe("job")).recovery, "exhausted");
  assert.equal((await host.observe("job")).resumes, 2);
  assert.deepEqual(f.loads, [conversation, conversation, conversation]);
  assert.equal(f.clicks, 1);
});

test("temporary mode uses its own URL, and login and takeover send zero times", async t => {
  const f = await harness(t);
  const host = f.make(f.lease);
  f.block();
  const blocked = await host.submit({ ...request, session: { mode: "temporary" } });
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.delivery, "not_sent");
  assert.deepEqual(f.loads, ["https://chatgpt.com/?temporary-chat=true"]);
  f.takeOver();
  await host.submit({ ...request, requestId: "takeover" });
  assert.equal(f.clicks, 0);
  assert.equal(f.loads.length, 1);
});

test("shipped JavaScript imports no Electron and npm installs no browser or native dependencies", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  for (const directory of [root, path.join(root, "legacy")]) {
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".mjs")) continue;
      const filename = path.join(directory, file);
      assert.doesNotMatch(await readFile(filename, "utf8"), /["'](?:node:)?electron(?:\/[^"']*)?["']/);
      execFileSync(process.execPath, ["--check", filename]);
    }
  }
  await import("../legacy/index.mjs");
});

test("busy frontend reads snapshots without browser access or mutation", async t => {
  const f = await harness(t);
  const owner = f.make(f.lease);
  const busy = new ChatSessionService({home:f.home, lease:await acquireHostLease(f.home),
    pageFor() { assert.fail("busy client must not access a page"); }});
  assert.deepEqual(busy.status(), {host:false,reason:"chat_host_busy"});
  assert.equal(await busy.observe("absent"), null);
  assert.equal(await busy.readResult("absent"), null);
  const submitted = await owner.submit(request);
  assert.deepEqual(await busy.observe("job"), submitted);
  await assert.rejects(busy.submit(request), /CHAT_HOST_BUSY/);
  await assert.rejects(busy.stop("job"), /CHAT_HOST_BUSY/);
  f.sample({phase:"complete", markerObserved:true, result:"answer", chatUrl:conversation});
  assert.equal(await busy.readResult("job"), null);
  const done = await owner.observe("job");
  assert.deepEqual(await busy.observe("job"), done);
  assert.equal(await busy.readResult("job"), "answer");
  assert.equal(f.clicks, 1);
  assert.deepEqual(f.loads, ["https://chatgpt.com/"]);
  await f.lease.release();
});
