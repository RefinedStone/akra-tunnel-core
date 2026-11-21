# Third-party notices

These notices describe the wider Akra Tunnel project. This core package ships only JavaScript sources and TypeScript declarations. It has no npm runtime dependencies and does not ship the upstream binaries, native installer, or image codecs listed below.

## openai/tunnel-client

Akra Tunnel downloads the official prebuilt `tunnel-client` binary at runtime and verifies the checksum published with that release. The binary is not stored in this repository.

- Source: https://github.com/openai/tunnel-client
- Version used by this project: `0.0.12`
- License: see the upstream release/repository

## lahuman/cokacremote

The native runtime installer fetches the exact upstream commit, adds a small stdio entrypoint, builds it locally, and records the compiled entrypoint hash.

- Source: https://github.com/lahuman/cokacremote
- Commit: `2cd63cca64a2af6d934929d4a5a5b4009e8b931a`
- License: MIT
- Copyright: 2026 cokacremote contributors

## miuuyy/codex-chatgpt-web

The binary verification, managed runtime, secret separation, readiness checks, and Launcher supervision patterns were informed by this project. Akra Tunnel is a separate implementation and does not include its ChatGPT browser automation or Codex bridge.

- Source: https://github.com/miuuyy/codex-chatgpt-web
- Inspected commit: `2569603f950de3a123e31bd26e7c8757566066f3`
- License: MIT
- Copyright: 2026 codex-chatgpt-web contributors

The MIT license text applying to the MIT-licensed components is reproduced in this repository's `LICENSE` file.

## sharp and platform image codecs

- Source: https://github.com/lovell/sharp
- Exact direct dependency: `sharp@0.35.4` (Apache-2.0).
- Used only for bounded pixel validation and test fixture creation; delivered original files are not re-encoded.
- Native/wasm platform packages and their dependencies are pinned with integrity values in the npm lockfiles. Preserve their included LICENSE/NOTICE files, including `node_modules/@img/sharp-*/LICENSE`, when redistributing an installed runtime. They include third-party codec notices and are not relicensed under this repository's MIT license.
