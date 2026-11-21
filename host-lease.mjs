import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

const leases = new WeakMap();

export async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = await open(directory, "r");
  try { await fd.sync(); } finally { await fd.close(); }
}

export async function writeSynced(file, content) {
  const fd = await open(file, "wx", 0o600);
  try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

export async function acquireHostLease(home) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const canonical = await realpath(home);
  const directory = path.join(canonical, "host-lease-v1");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = new Set(await readdir(directory));
  const generation = [...entries].reduce((last, name) => {
    const match = /^claim-(\d+)$/.exec(name);
    return match ? Math.max(last, Number(match[1])) : last;
  }, 0);
  if (generation && !entries.has(`released-${generation}`)) {
    const pid = Number(await readFile(path.join(directory, `claim-${generation}`), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("HOST_LEASE_INVALID");
    if (alive(pid)) return null;
  }
  // Claims are immutable. A stale reader cannot delete or replace a newer
  // host's claim. Linking a complete record publishes exactly one winner.
  const pending = path.join(directory, `.claim-${randomUUID()}`);
  const next = generation + 1;
  try {
    await writeSynced(pending, String(process.pid));
    try { await link(pending, path.join(directory, `claim-${next}`)); }
    catch (error) { if (error.code === "EEXIST") return null; throw error; }
    await syncDirectory(directory);
  } finally { await rm(pending, { force: true }); }
  const state = { home: canonical, active: true, queue: Promise.resolve() };
  let releasing;
  const lease = Object.freeze({
    get active() { return state.active; },
    release() {
      return releasing ??= (async () => {
        state.active = false;
        await state.queue;
        await writeSynced(path.join(directory, `released-${next}`), "");
        await syncDirectory(directory);
      })();
    },
  });
  leases.set(lease, state);
  return lease;
}

export function leaseState(lease) { return leases.get(lease); }
