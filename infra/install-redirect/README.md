# Installer endpoint and private binary channel

`oh-my-pk.pkking.computer` serves the installer scripts and proxies the private
standalone-binary channel. It does **not** make every install a binary install:

- the default `install.sh` and `install.ps1` paths install or validate Bun, then
  install `@pk-nerdsaver-ai/pi-coding-agent` from npm;
- only explicit `--binary` (Unix) or `-Binary` (PowerShell) mode reads the
  Hugging Face-backed `/version` and `/bin/...` routes.

The private Hugging Face model repository is independent of both the GitHub
Release assets built by Actions and the npm packages used by default installers.
A complete release therefore has separate GitHub, Hugging Face, and npm gates.
npm publication is required before default installers can receive the same
release.

```text
default installer ──▶ Bun ──▶ npm registry

explicit --binary / -Binary
        │
        └──▶ Cloudflare Worker ── tokened request ──▶ private HF model repo
             (public endpoint)                         (standalone binaries)
```

The Worker holds the Hugging Face read token as a secret and never exposes it to
the installer client. It also proxies `/collab/*` through the `ompk-collab`
Worker service binding, keeps browser collaboration links on the product
hostname, and serves the documentation home at `/docs`.

## Routes

- `/` — install landing page with links to `/docs`.
- `/docs` — documentation home; individual pages remain versioned in `docs/`.
- `/install`, `/install.sh`, `/install.ps1` — installer scripts from the
  repository's `main` branch.
- `/version` — the private model repository's `VERSION` file.
- `/bin/vX.Y.Z/<filename>` — `vX.Y.Z/<filename>` in the private model
  repository.
- `/collab/*` — product-hosted browser collaboration client.

The versioned binary routes are immutable and may be used with an explicit
binary ref. `/version` is the moving pointer used by unpinned explicit binary
installs.

## Binary repository contract

The configured default is the private Hugging Face **model** repository
`pkkidking/oh-my-pi-binaries`. Its complete release layout is:

```text
VERSION                         # exactly vX.Y.Z plus a newline
vX.Y.Z/omp-darwin-arm64
vX.Y.Z/omp-darwin-x64
vX.Y.Z/omp-linux-arm64
vX.Y.Z/omp-linux-x64
vX.Y.Z/omp-windows-x64.exe
```

`VERSION` must contain the V-prefixed Git tag, such as `v16.4.6`; a bare
`16.4.6` does not satisfy the channel contract. Explicit binary mode supports
macOS x64/arm64, Linux x64/arm64, and Windows x64.

[`publish-binaries-hf.ts`](../../scripts/publish-binaries-hf.ts) uploads files
under the versioned tag directory. It changes `VERSION` only when all five
required filenames are present under that tag, unless a release operator
deliberately uses `--force-version`. A partial upload does not move the
unpinned-binary pointer.

## One-time setup

1. **Private model repository** — create
   `pkkidking/oh-my-pi-binaries` as a private Hugging Face model repository, or
   set `HF_REPO` to the selected private repository.
2. **Hugging Face tokens** — configure:
   - a write-scoped token as `HF_TOKEN` only in the binary publication
     environment;
   - a fine-grained, read-only token scoped to the model repository as the
     Worker's `HF_TOKEN` secret.
3. **Worker secret and deployment** — from `infra/install-redirect/`:

   ```sh
   wrangler secret put HF_TOKEN
   wrangler deploy
   ```

   `wrangler.toml` sets `HF_REPO`, `HF_REPO_TYPE`, the custom-domain routes, and
   the `COLLAB` service binding. Deploy `packages/collab-relay` before relying
   on the collaboration route.

Never place a Hugging Face token in an installer command, URL, repository file,
or release note.

## Each release

The tag/GitHub Release, private binary channel, and npm graph are separate
publication gates. See
[`docs/RELEASING-FORK.md`](../../docs/RELEASING-FORK.md) for the complete
sequence and completion checklist.

For the Hugging Face gate, run the publisher on hosts that have the native
artifacts and toolchains for their requested targets. Pass the V-prefixed tag
explicitly:

```powershell
# Windows x64
$env:HF_TOKEN = "<write-scoped-token>"
bun ../../scripts/publish-binaries-hf.ts --tag vX.Y.Z --targets win32-x64
```

```sh
# Linux x64/arm64
HF_TOKEN="<write-scoped-token>" bun ../../scripts/publish-binaries-hf.ts \
  --tag vX.Y.Z --targets linux-x64,linux-arm64

# macOS x64/arm64
HF_TOKEN="<write-scoped-token>" bun ../../scripts/publish-binaries-hf.ts \
  --tag vX.Y.Z --targets darwin-x64,darwin-arm64
```

The relative command paths above assume the current directory is
`infra/install-redirect/`. From the repository root, use
`bun scripts/publish-binaries-hf.ts ...`.

Reruns skip binaries already stored under the tag. `--force-build`
rebuilds/re-uploads them; `--no-version` always leaves the pointer unchanged;
`--force-version` can expose a partial release and should not be used for a
normal five-platform publication.

## How installation resolves

Default Unix installation:

```text
curl .../install.sh | sh
  -> Worker serves scripts/install.sh from GitHub raw
  -> installer installs/validates Bun
  -> bun install -g @pk-nerdsaver-ai/pi-coding-agent
  -> npm registry
```

Explicit Unix binary installation:

```text
curl .../install.sh | sh -s -- --binary
  -> Worker serves scripts/install.sh from GitHub raw
  -> installer reads /version (unless --ref pins a tag)
  -> installer requests /bin/vX.Y.Z/omp-<platform>-<arch>
  -> Worker reads vX.Y.Z/<filename> from the private HF model repository
```

PowerShell follows the same split: the default command uses npm, while
`-Binary` requests `/bin/vX.Y.Z/omp-windows-x64.exe`.

Override the endpoint for local testing with `OMP_DIST_BASE` in `install.sh` or
`$env:OMP_DIST_BASE` in `install.ps1`.
