import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export class TunnelRuntimeService {
  #manifestPath;
  #schemaVersion;
  #artifacts;

  constructor({ manifestPath, schemaVersion, artifacts }) {
    this.#manifestPath = resolve(manifestPath);
    this.#schemaVersion = schemaVersion;
    this.#artifacts = Object.entries(artifacts).map(([key, file]) => [key, resolve(file)]);
    if (this.#artifacts.length === 0) throw new TypeError("At least one runtime artifact is required");
  }

  async getStatus() {
    let raw;
    try {
      raw = await readFile(this.#manifestPath, "utf8");
    } catch (error) {
      return { state: error.code === "ENOENT" ? "missing" : "invalid" };
    }
    try {
      const manifest = JSON.parse(raw);
      if (manifest?.schemaVersion !== this.#schemaVersion) return { state: "invalid" };
      for (const [key, file] of this.#artifacts) {
        const digest = Object.hasOwn(manifest, key) && manifest[key];
        if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return { state: "invalid" };
        if (createHash("sha256").update(await readFile(file)).digest("hex") !== digest) {
          return { state: "invalid" };
        }
      }
      return { state: "ready" };
    } catch {
      return { state: "invalid" };
    }
  }
}
