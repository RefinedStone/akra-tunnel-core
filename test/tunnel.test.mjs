import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TunnelRuntimeService } from "akra-tunnel-core/tunnel";

test("reads the manifest and verifies declared artifacts without executing them", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "akra-runtime-status-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const manifestPath = join(home, "manifest.json");
  const entry = join(home, "entry.mjs");
  const source = 'throw new Error("must not execute");\n';
  const entrySha256 = createHash("sha256").update(source).digest("hex");
  const artifacts = { entrySha256: entry };
  const service = new TunnelRuntimeService({ manifestPath, schemaVersion: 23, artifacts });
  const expectState = async (state) => assert.deepEqual(await service.getStatus(), { state });

  await expectState("missing");
  await writeFile(manifestPath, "{");
  await expectState("invalid");
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 22, entrySha256 }));
  await writeFile(entry, source);
  await expectState("invalid");
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 23 }));
  await expectState("invalid");
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 23, entrySha256 }));
  delete artifacts.entrySha256;
  await expectState("ready");
  await writeFile(entry, "corrupt");
  await expectState("invalid");
  await rm(entry);
  await expectState("invalid");
});
