# Hugging Face installer distribution

The install scripts use binaries from a **private Hugging Face repo** (free
storage + egress), independently of the GitHub Release assets built by Actions.
A **Cloudflare Worker** at `oh-my-pk.pkking.computer` holds the HF token as a
secret and proxies downloads, so the repo stays private and the installer never
sees a token.

```
build host(s) ── publish-binaries-hf.ts ──▶ private HF repo ──▶ CF Worker ──▶ install.sh / install.ps1 ──▶ user
   (host-bound)                              (free storage)     (token secret)   (oh-my-pk.pkking.computer)
```

## One-time setup

1. **Private HF repo** — create `pkkidking/oh-my-pi-binaries` (type *model*, **private**)
   at https://huggingface.co/new. Keep the default name or set `HF_REPO` accordingly.
2. **HF tokens** — at https://huggingface.co/settings/tokens:
   - a **write** token (for publishing) — used as `HF_TOKEN` when running the publish script;
   - a **read** token (for the Worker) — set as the Worker secret.
3. **Worker secret + deploy** — from `infra/install-redirect/`:
   ```sh
   wrangler secret put HF_TOKEN      # paste the READ token
   wrangler deploy
   ```
   `wrangler.toml` already sets `HF_REPO` / `HF_REPO_TYPE` and the custom-domain route.
   (Requires a Cloudflare account on the **free** Workers plan — no paid features used.)

## Each release

1. **Bump + changelog + tag**. The standard release command triggers the GitHub
   Actions build and waits for it to finish:
   ```sh
   bun scripts/release.ts <version>
   ```
   On Windows the local `bun run check` it runs will fail only on `cargo clippy`
   flagging `#[cfg(any(linux,macos))]` code as dead — that's a Windows-only false
   positive; run `bun run check:ts` + `bun test` to validate instead.
2. **Build + publish binaries** to the private HF repo. A single host usually only
   builds its own platform; run this on each build host you have:
   ```sh
   # Windows host:
   HF_TOKEN=hf_write_xxx bun scripts/publish-binaries-hf.ts --targets win32-x64
   # Linux host (needs zig + cargo-zigbuild + cargo-xwin for cross, or build natively):
   HF_TOKEN=hf_write_xxx bun scripts/publish-binaries-hf.ts --targets linux-x64,linux-arm64
   # macOS host (only a Mac can build darwin):
   HF_TOKEN=hf_write_xxx bun scripts/publish-binaries-hf.ts --targets darwin-arm64,darwin-x64
   ```
   Reruns are idempotent: targets already uploaded under the release tag are
   skipped before local compilation. Pass `--force-build` to rebuild/re-upload a
   target anyway.

   The last `publish-binaries-hf.ts` run for a tag refreshes the `VERSION` pointer,
   so run the platforms you have; installs resolve whatever is uploaded for that tag.
   Use `--dry-run` to preview without building or uploading.
3. **(Optional) npm** — `@pk-nerdsaver-ai/*` on npm is independent of the binary
   install path. Publishing it still needs the cross-platform native `.node` addons
   for all five platforms (`bun scripts/ci-release-publish.ts` after building them);
   without a Mac this regresses macOS on npm, so the binary install path above is the
   primary, fully-local channel.

## How installs resolve

`curl -fsSL https://oh-my-pk.pkking.computer/install.sh | sh` →
- the Worker serves `scripts/install.sh` (from GitHub raw);
- the script reads `…/version` (Worker → HF `VERSION`) for the latest tag (or `--ref`);
- downloads `…/bin/<tag>/omp-<platform>-<arch>` (Worker → HF, token applied server-side);
- no GitHub Release and no HF token on the client.

Override the endpoint for testing with `OMP_DIST_BASE` (sh) / `$env:OMP_DIST_BASE` (ps1).
