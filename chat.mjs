import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chatDom } from "./chat-dom.mjs";
import { leaseState, syncDirectory, writeSynced } from "./host-lease.mjs";

export { acquireHostLease } from "./host-lease.mjs";

const origin = "https://chatgpt.com";
const conversationUrl = value => typeof value === "string" && /^https:\/\/chatgpt\.com\/c\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const digest = value => createHash("sha256").update(value).digest("hex");
const checkId = id => {
  if (typeof id !== "string" || !id.trim() || id.length > 256) throw new Error("CHAT_REQUEST_ID_INVALID");
};
const publicObservation = ({ requestId, delivery, phase, evidence, recovery, resumes, chatUrl }) =>
  ({ requestId, delivery, phase, evidence, recovery, resumes, ...(chatUrl ? { chatUrl } : {}) });

export class ChatSessionService {
  #home;
  #state;
  #pageFor;
  #readyMs;

  constructor({ home, lease, pageFor, readinessMs = 10_000 }) {
    this.#home = home;
    this.#state = leaseState(lease);
    this.#pageFor = pageFor;
    if (!Number.isFinite(readinessMs) || readinessMs < 0 || readinessMs > 60_000) throw new Error("CHAT_READINESS_INVALID");
    this.#readyMs = readinessMs;
  }

  status() {
    return this.#state?.active ? { host: true } : { host: false, reason: "chat_host_busy" };
  }

  #run(id, operation) {
    checkId(id);
    const state = this.#state;
    if (!state?.active) return Promise.reject(new Error("CHAT_HOST_BUSY"));
    const result = state.queue.then(async () => {
      this.#assertActive();
      if (await realpath(this.#home) !== state.home) throw new Error("CHAT_HOST_HOME_MISMATCH");
      const directory = path.join(state.home, "chat-jobs-v1");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await syncDirectory(state.home);
      const file = path.join(directory, digest(id) + ".json");
      const record = await readFile(file, "utf8").then(JSON.parse, error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (record && record.requestId !== id) throw new Error("CHAT_RECORD_INVALID");
      const save = async (entry) => {
        const pending = path.join(directory, "." + randomUUID());
        try {
          await writeSynced(pending, JSON.stringify(entry));
          await rename(pending, file);
          await syncDirectory(directory);
        } finally { await rm(pending, { force: true }); }
      };
      return operation(record, save);
    });
    state.queue = result.catch(() => {});
    return result;
  }

  #assertActive(page) {
    if (!this.#state?.active) throw new Error("CHAT_HOST_BUSY");
    page?.assertActive?.();
  }

  submit({ requestId, session, instruction, maxResumes }) {
    const mode = session?.mode;
    const chatUrl = mode === "continue" ? session.chatUrl : undefined;
    if (!["new", "temporary", "continue"].includes(mode) || (mode === "continue" && !conversationUrl(chatUrl)) ||
        typeof instruction !== "string" || !instruction.trim() || instruction.length > 250_000 ||
        !Number.isSafeInteger(maxResumes) || maxResumes < 0) throw new Error("CHAT_REQUEST_INVALID");
    const startUrl = chatUrl ?? (origin + (mode === "temporary" ? "/?temporary-chat=true" : "/"));
    const fingerprint = digest(JSON.stringify([mode, chatUrl, instruction, maxResumes]));
    return this.#run(requestId, async (existing, save) => {
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("CHAT_REQUEST_CONFLICT");
        return publicObservation(await this.#settleUncertain(existing, save));
      }
      const record = { requestId, fingerprint, mode, marker: "[akra-chat:" + randomUUID() + "]", delivery: "not_sent",
        phase: "unknown", evidence: "none", recovery: "none", resumes: 0, maxResumes, chatUrl };
      // Reserve the ID before any page operation. A later submit never injects
      // a second draft, even if this process died before dispatch.
      await save(record);
      const draft = record.marker + "\n\n" + instruction;
      let page;
      try {
        page = await this.#pageFor(requestId);
        this.#assertActive(page);
        await page.load(startUrl);
        const deadline = Date.now() + this.#readyMs;
        let ready;
        do {
          this.#assertActive(page);
          await page.focus();
          this.#assertActive(page);
          ready = await page.evaluate(chatDom, { action: "focus", marker: record.marker, expectedUrl: startUrl, bootstrap: mode !== "continue" });
          if (ready.ready || ready.phase === "blocked" || Date.now() >= deadline) break;
          await delay(Math.min(200, Math.max(0, deadline - Date.now())));
        } while (true);
        if (!ready.ready) {
          record.phase = ready.phase ?? "unknown";
          if (record.phase === "blocked" || record.phase === "load_failed") record.evidence = "dom";
        } else {
          this.#assertActive(page);
          await page.insertText(draft);
          // The durable write must precede the click, never the other way round.
          record.delivery = "sending";
          await save(record);
          this.#assertActive(page);
          const sent = await page.evaluate(chatDom, { action: "send", marker: record.marker, draft, expectedUrl: startUrl, bootstrap: mode !== "continue" });
          record.delivery = sent.clicked === true ? "host_acknowledged" : sent.clicked === false ? "not_sent" : "send_uncertain";
        }
      } catch {
        if (record.delivery === "sending") record.delivery = "send_uncertain";
        else record.phase = "load_failed";
      }
      await save(record);
      return publicObservation(record);
    });
  }

  async #settleUncertain(record, save) {
    if (record.delivery === "sending") {
      record.delivery = "send_uncertain";
      await save(record);
    }
    return record;
  }

  async #sample(page, record, allowRestore) {
    const url = await page.url();
    if (record.chatUrl && url !== record.chatUrl) {
      if (!allowRestore || !["", "about:blank"].includes(url)) return { phase: "unknown" };
      // Reopening after restart is itself a recovery attempt.
      return { phase: "load_failed" };
    }
    if (url !== origin + "/" && url !== origin + "/?temporary-chat=true" && !conversationUrl(url)) return { phase: "blocked" };
    return page.evaluate(chatDom, { action: "observe", marker: record.marker, expectedUrl: url });
  }

  async #observe(page, record, save, recover) {
    const apply = observation => {
      record.phase = observation.phase;
      record.evidence = observation.markerObserved || observation.phase === "blocked" ? "dom" : "none";
      if (observation.markerObserved) {
        record.delivery = observation.assistantProgress || record.delivery === "progress_observed" ? "progress_observed" : "message_observed";
        if (record.mode !== "temporary" && conversationUrl(observation.chatUrl)) record.chatUrl = observation.chatUrl;
      }
      if (observation.result) record.result = observation.result;
      if (observation.phase === "complete") record.recovery = "none";
    };
    let current = await this.#sample(page, record, true).catch(() => ({ phase: "load_failed" }));
    apply(current);
    if (recover && ["load_failed", "disconnected"].includes(current.phase)) {
      if (!record.chatUrl || record.resumes >= record.maxResumes) record.recovery = "exhausted";
      else {
        record.recovery = "in_progress";
        record.resumes++;
        await save(record);
        try {
          this.#assertActive(page);
          await page.load(record.chatUrl);
          current = await this.#sample(page, record, false);
        } catch { current = { phase: "load_failed" }; }
        apply(current);
        record.recovery = ["load_failed", "disconnected"].includes(current.phase)
          ? record.resumes >= record.maxResumes ? "exhausted" : "in_progress" : "none";
      }
    }
    await save(record);
  }

  observe(requestId) {
    return this.#run(requestId, async (record, save) => {
      if (!record) return null;
      await this.#settleUncertain(record, save);
      if (record.delivery !== "not_sent" && !["complete", "stopped"].includes(record.phase)) {
        let page;
        try { page = await this.#pageFor(requestId); }
        catch { record.phase = "load_failed"; record.evidence = "none"; await save(record); }
        if (page) await this.#observe(page, record, save, true);
      }
      return publicObservation(record);
    });
  }

  readResult(requestId) {
    return this.#run(requestId, record => record?.phase === "complete" ? record.result ?? null : null);
  }

  stop(requestId) {
    return this.#run(requestId, async (record, save) => {
      if (!record) return null;
      await this.#settleUncertain(record, save);
      if (record.delivery === "not_sent") {
        record.phase = "stopped";
        await save(record);
      } else if (!["complete", "stopped"].includes(record.phase)) {
        const page = await this.#pageFor(requestId);
        await this.#observe(page, record, save, false);
        if (record.phase === "running") {
          const url = await page.url();
          this.#assertActive(page);
          const result = await page.evaluate(chatDom, { action: "stop", marker: record.marker, expectedUrl: url });
          if (result.clicked) {
            record.phase = "stopped";
            record.recovery = "none";
            await save(record);
          }
        }
      }
      return publicObservation(record);
    });
  }
}
