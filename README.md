<p align="center">
  <img src="https://raw.githubusercontent.com/kingkillery/oh-my-pk/refs/heads/main/assets/hero.png" alt="omp">
</p>

<p align="center">
  <strong>A coding agent with the IDE wired in.</strong>
  <strong><a href="https://oh-my-pk.pkking.computer">oh-my-pk.pkking.computer</a></strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pk-nerdsaver-ai/pi-coding-agent"><img src="https://img.shields.io/npm/v/@pk-nerdsaver-ai/pi-coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://github.com/kingkillery/oh-my-pk/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://github.com/kingkillery/oh-my-pk/actions"><img src="https://img.shields.io/github/actions/workflow/status/kingkillery/oh-my-pk/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/kingkillery/oh-my-pk/blob/main/LICENSE"><img src="https://img.shields.io/github/license/kingkillery/oh-my-pk?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  Fork of <a href="https://github.com/badlogic/pi-mono">Pi</a> by <a href="https://github.com/mariozechner">@mariozechner</a> 
</p>

The most capable agent surface that ships. Continuously tuned by real-world use — complete out of the box, open all the way down.

Canonical product name: `oh-my-pk`. Canonical install endpoint: `https://oh-my-pk.pkking.computer`. Complete documentation home: [`https://oh-my-pk.pkking.computer/docs`](https://oh-my-pk.pkking.computer/docs). Legacy repository URLs and the old `oh-my-pi.pkking.computer` route may remain during migration.

**59** bundled provider namespaces · **3,991** catalog entries · **34** built-in tools · **14** LSP ops · **28** DAP ops · **63,239** maintained lines of Rust.

## Install

**macOS · Linux**

```sh
curl -fsSL https://oh-my-pk.pkking.computer/install.sh | sh
```

**Bun (recommended)**

```sh
bun install -g @pk-nerdsaver-ai/pi-coding-agent
```

**Windows (PowerShell)**

```powershell
irm https://oh-my-pk.pkking.computer/install.ps1 | iex
```

`oh-my-pk` requires Bash on Windows. Install Git for Windows (recommended), or use WSL, Cygwin, or MSYS2; the installer detects Git Bash or `bash.exe` on `PATH` and records the shell path.

macOS · Linux · Windows · bun ≥ 1.3.14

The install scripts install/validate Bun and use the npm package by default. Prebuilt binaries are currently available with `--binary` on Linux x64/arm64 and `-Binary` on Windows x64; macOS uses the Bun/npm install path.
There is no Homebrew tap or mise registry entry for this fork —
don't use `brew install kingkillery/tap/omp` or `mise use -g
github:kingkillery/oh-my-pi`, neither is published.

### Shell completions

`oh-my-pk` (aliases: `omp`, `ompk`) generates its own completion scripts for **bash**, **zsh**, and **fish** from the live command/flag metadata, so they never drift from the actual CLI. Subcommands, flags, and enum values complete statically; model names (`--model`, `--smol`, `--slow`, `--plan`) resolve against the bundled model catalog and `--resume` against your on-disk sessions.

```sh
# zsh — add to ~/.zshrc (or write the output into a file on your $fpath)
eval "$(oh-my-pk completions zsh)"

# bash — add to ~/.bashrc
eval "$(oh-my-pk completions bash)"

# fish
oh-my-pk completions fish > ~/.config/fish/completions/oh-my-pk.fish
```

## Every tool, _benchmaxxed_.

Edits that land on the first attempt. Reads that summarize files instead of dumping their content. Searches that return instantly. Pick any model — omp will get it right.

| model            | metric       | what                                                                  |
| ---------------- | ------------ | --------------------------------------------------------------------- |
| Grok Code Fast 1 | 6.7% → 68.3% | Tenfold lift the moment the edit format stops eating the model alive. |
| Gemini 3 Flash   | +5 pp        | Over str_replace — beats Google's own best attempt at the format.     |
| Grok 4 Fast      | −61% tokens  | Output collapses once the retry loop on bad diffs disappears.         |
| MiniMax          | 2.1×         | Pass rate more than doubles. Same weights, same prompt.               |

- `read` : summarized snippets · ideal defaults · selector hit rate
- `grep` : fastest in the west
- `lsp` : everything your IDE knows, the agent knows
- `prompts` : adjusted relentlessly for each model

[Read the full post ↗](https://blog.can.ac/2026/02/12/the-harness-problem/)

## The Pi _you love_, with **batteries included**.

Originally built on [Mario Zechner](https://github.com/mariozechner)'s wonderful [Pi](https://github.com/badlogic/pi-mono), omp adds everything you're missing.

### 01 · Code execution w/ tool-calling

Most harnesses give the agent a Python sandbox and call it done. Ours runs persistent Python and a Bun worker, and either kernel can call back into the agent's own tools — `read`, `grep`, `task` — over a loopback bridge. The agent loads a CSV with `tool.read` from inside Python, charts it from JavaScript, and never leaves the cell.

### 02 · LSP wired into every write

Ask for a rename and you get a rename. The call goes through workspace/willRenameFiles, so re-exports, barrel files, and aliased imports update before the file moves. Everything your IDE knows, the agent knows.

### 03 · Drives a real debugger

A C binary segfaults: the agent attaches lldb, steps to the bad pointer, reads the frame. A Go service hangs: it attaches dlv and walks the goroutines. A Python process is wedged: debugpy, pause, inspect, evaluate. Most agents are still sprinkling print statements.

### 04 · Time-traveling stream rules

Your rules sit dormant until the model goes off-script. A regex match aborts the stream mid-token, injects the rule as a system reminder, and retries from the same point. You get course-correction without paying context tax on every turn. Injections survive compaction, so the fix sticks.

### 05 · First-class subagents

Split a job across workers and get typed results back. `task` fans workers out in parallel; opt editing workers into isolated copy-on-write/worktree environments when you need overlap-safe patches. Each worker runs its own tool surface, and `yield` returns a schema-validated object the parent reads directly.

Launch one directly with `/subagent using <alias-or-model> "<prompt>"`, cap new workers with `/tier light|mid|frontier|auto`, or pass `fork: true` to `task` for an ephemeral child that inherits the parent's system prompt, tools, model, and read-only history snapshot. Fresh contexts remain the default.

For whole-repository coverage, the bundled `agentic-mapreduce` skill turns deterministic selectors into bounded map shards and a typed reducer pass with `mr-worker` and `mr-reducer`; `tree-of-thoughts` and `tot-reasoner` cover shards that need adversarial branching.

Agent Hub can sync background agents into pk-kanban, keeping long-running worker state visible on the same local board you use for project coordination.

### 06 · A second model, watching every turn.

Pair a reviewer model to the 'advisor' role and it reads every turn the main agent takes, injecting notes inline — a quiet aside, a concern, or a hard blocker. It runs on its own context and its own model, so it catches what the doer rushed past. The main agent sees the note and course-corrects, or tells you why it won't.

Need the second model to do work instead of review it? `/fusion on` keeps a warm cheap sidekick for settled mechanical tasks while the frontier model keeps the reasoning. Choose `delegate` or `escalate`, optionally route through a model pool, and inspect live sidekick state and token split with `/fusion status`. Fusion is opt-in and requires an available, credentialed sidekick model.

### 07 · Hand someone the link, they're in.

/collab puts your live session on a relay and hands back a link — and a QR. A teammate joins from another terminal with oh-my-pk join, or just opens it in a browser. Share read-write to pair on the same agent, or /collab view for a read-only link anyone can watch but no one can steer. Frames are sealed client-side; the relay never sees your keys.

`/hub` is the durable counterpart: publish a client-side encrypted replication snapshot on one device, then run `/hub resume <link>` to restore the full history as a local session fork on another. Hub handoff requires provisioned account access, relay connectivity, and the complete link including its fragment key.

### 08 · Read a pdf on arxiv, why not?

`web_search` walks an eighteen-provider availability/fallback chain and hands whatever URLs it finds straight to `read`. Arxiv PDFs, GitHub pages, Stack Overflow threads come back as structured markdown with anchors intact — the same tool surface you use on local files. Cite, follow, quote, never lose where you came from.

### 09 · Unapologetically native. Even on Windows.

Other agents shell out to rg, grep, find, and bash. On many machines those binaries don't exist, and on the ones where they do, every call costs a fork-exec round-trip. omp links the real implementations into the process. ripgrep, glob, find: in-process. brush is the bash, with sessions that survive across calls. The same omp binary runs on macOS, Linux, and Windows — no WSL bridge.

### 10 · Code review with priorities and a verdict

Get a clear verdict on whether the change ships, with every issue ranked P0 through P3 and scored for confidence. /review spawns dedicated reviewer subagents that sweep branches, single commits, or uncommitted work in parallel. You tackle what blocks release first; nothing important hides in a wall of prose.

### 11 · Hashline: edit by content hash

Perfect edits, fewer tokens. The model points at anchors instead of retyping the lines it wants to change, so whitespace battles and string-not-found loops just stop happening. Edit a stale file and the anchors diverge — we reject the patch before it corrupts anything. Grok 4 Fast spends 61% fewer output tokens on the same work.

### 12 · GitHub is just another filesystem

Other harnesses bolt on gh_issue_view, gh_pr_view, gh_search — each with its own parameters the agent has to learn and you have to debug. We skipped that. read already handles paths; PRs are paths. One interface to teach the model, one surface to keep correct.

### 13 · Hindsight: memory the agent curates

The agent remembers your codebase between sessions. It writes facts mid-run with retain, pulls them back with recall, and compresses each session into a mental model that loads on the first turn of the next one. Project-scoped by default, so what it learns about this repo stays with this repo.

### 14 · ACP: editor-drivable agent

Run omp inside Zed and you get the same agent you drive from the terminal — reading the buffer you're actually looking at, writing through the editor's save path, spawning shells in the editor's terminal. Destructive tools pause for a permission prompt you can answer once and forget. No bridge, no plugin, no second brain to keep in sync.

### 15 · Reads the configuration your other tools already wrote

Every other agent ships an importer and expects you to convert. `oh-my-pk` discovers the supported parts of eight auto-registered ecosystems already on disk — Claude Code, Cursor, Windsurf, Codex, Cline, GitHub Copilot, VS Code, and OpenCode. Nothing is copied or migrated; the Discovery table below names the exact surfaces that load.

### 16 · oh-my-pk commit: atomic splits, validated messages

oh-my-pk commit reads the working tree through git_overview, git_file_diff, and git_hunk, then splits unrelated changes into atomic commits ordered by their dependencies. Cycles are rejected before anything is written. Source files score above tests, docs, and configs, so the headline commit is the one that matters. Lock files are excluded from analysis entirely.

### 17 · Read PRs. _Walk skills._ Pull JSON out of subagents.

Fifteen internal schemes — `pr://`, `issue://`, `agent://`, `skill://`, `rule://`, and the rest — resolve transparently inside every FS-shaped tool the agent already calls. `read pr://1428` returns the same shape as `read src/foo.ts`. `grep` walks a diff like a directory. `agent://<id>/findings.0.path` pulls a field out of a subagent's output by path.

### 18 · Conflict resolution, made easy.

Each merge conflict becomes one URL. The agent writes `@theirs`, `@ours`, or `@base` to `conflict://N` and the file resolves cleanly. Bulk form: `conflict://*`.

### 19 · Preview, then accept.

`ast_edit` returns a _(proposed)_ card with the replacement count. The change is staged. The agent calls `resolve` with a reason; the TUI turns it into an **Accept** card and the disk move happens — atomic, all or nothing.

### 20 · Drives a _real browser_. _Or your Slack?_

Stealth's on by default, so pages see a normal user instead of a headless bot. The same API drives any Electron app in place — point it at Slack and the agent reads your DMs the way it reads the web.

## Whatever the task needs, _it's already in the box_.

34 canonical built-ins live in the same namespace as `read` and `bash`. Pin the active set with `--tools read,edit,bash,…`; discoverable tools can stay out of the prompt until `search_tool_bm25` surfaces them when discovery is enabled.

**Files & search**

- `read` — files, dirs, archives, SQLite, PDFs, notebooks, URLs, and internal `://` schemes through one path.
- `write` — create or overwrite a file, archive entry, or SQLite row.
- `edit` — hashline patches with content-hash anchors and stale-anchor recovery.
- `ast_edit` — structural rewrites previewed before apply, via ast-grep.
- `ast_grep` — structural code queries over 50+ tree-sitter grammars.
- `grep` — regex content search over files, globs, and internal URLs; legacy alias: `search`.
- `glob` — glob-based path lookup; legacy alias: `find`.
- `context_oracle` — ask a lightweight repository-context service for cited LSP, file, diagnostic, and edit-impact evidence.

**Runtime**

- `bash` — workspace shell, with optional PTY or background-job dispatch.
- `eval` — persistent Python and JavaScript cells with shared prelude and tool re-entry.
- `ssh` — one remote command against a configured host.

**Code intelligence**

- `lsp` — diagnostics, navigation, symbols, renames, code actions, and raw requests.
- `debug` — drive a DAP session: breakpoints, stepping, threads, stack, and variables.

**Coordination**

- `task` — fan out subagents in parallel, optionally workspace-isolated.
- `irc` — short prose between live agents in this process.
- `todo` — ordered mutations over the session todo list with phase tracking.
- `job` — wait on or cancel background jobs.
- `ask` — structured follow-up questions for interactive runs.

**Outside the box**

- `browser` — cmux WKWebView tabs when available, otherwise Puppeteer over local/headless Chromium or CDP-attached/spawned apps.
- `web_search` — query configured providers, returning an answer plus citations.
- `deep_research` — run multi-step web research and produce a cited report.
- `ix_bridge` — drive the local IX Bridge daemon/Chrome extension with status, guide, and command actions.
- `github` — GitHub CLI operations for repos, PRs, issues, code search, and Actions run-watch.
- `inspect_image` — vision-model analysis of a local image file.

**Memory & state**

- `checkpoint` — mark conversation state for a later collapse-and-report.
- `rewind` — prune exploratory context and keep a concise report.
- `memory_edit` — edit durable memory through the active Mnemopi backend.
- `retain` — queue durable facts into the active Hindsight or Mnemopi backend.
- `recall` — search the active Hindsight or Mnemopi backend for raw memories.
- `reflect` — synthesize an answer over the active Hindsight or Mnemopi memory bank.
- `learn` — capture a reusable lesson in long-term memory and optionally create or update a managed skill.
- `manage_skill` — create, update, or delete an isolated managed skill.
- `activity` — read the local Activity Memory timeline by calendar day or trailing hours; local-only and read-only.

**Misc**

- `search_tool_bm25` — BM25 over the discoverable tool index; activates top matches mid-session.

**Bundled session extensions — not included in the 34 built-ins**

- `generate_image` — generate or edit raster images via Gemini, GPT, or xAI Grok image models.
- `tts` — local Kokoro-82M WAV/PCM16 or xAI Grok Voice WAV/MP3; automatic backend selection prefers local.

**Hidden control tool — not included in the 34 built-ins**

- `resolve` — apply or discard a queued preview action.

Availability for canonical built-ins: off by default — `github` (`github.enabled`), `inspect_image` (`inspect_image.enabled`), `checkpoint`/`rewind` (`checkpoint.enabled`), `activity` (`gopkClips.enabled`), `memory_edit` (`memory.backend: mnemopi`), `retain`/`recall`/`reflect` (`memory.backend: hindsight` or `mnemopi`), `manage_skill` (`autolearn.enabled`; top-level only), and `learn` (`autolearn.enabled`; top-level only; memory backend `local`, `hindsight`, or `mnemopi`). `search_tool_bm25` is available whenever discovery is enabled; `tools.discoveryMode` defaults to `all`. Bundled extension `tts` is separately gated by `speechgen.enabled` and is off by default.

[Full tool reference →](https://oh-my-pk.pkking.computer/docs)

## 59 bundled provider namespaces, 3,991 catalog entries, _one /model away_.

Roles route work by intent. Common roles are `default`, `smol` (fast/cheap), `slow` (thinking), `vision`, `plan`, `designer`, `commit`, `task`, and `advisor`; specialized roles cover browser operation/control, route prediction, fast context, and `budget`/`balanced`/`max-intelligence`/`free` tiers. `title` and `tiny` are functional but hidden. General delegated agents use `task`; quick mechanical agents can use `smol`; `commit` drives commit generation, including changelog work. Override at launch with `--smol`, `--slow`, or `--plan`; cycle through configured models for the active role with `Ctrl+P`; swap the active model mid-session with `/model`.

The lists below are selected bundled providers, not the exhaustive 59-namespace catalog. `/login` handles supported OAuth/account-backed providers; API-key-backed APIs and coding gateways use their provider credentials.

### Selected direct APIs and gateways

Anthropic · OpenAI · Google Gemini · Google Vertex · Azure OpenAI · Amazon Bedrock · xAI · Z.AI (direct) · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Hugging Face · NVIDIA · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway

### Selected accounts, coding plans, and gateways

OpenAI Codex `oauth` · Google Antigravity `oauth` · Google Gemini CLI `oauth` · Cursor `oauth` · GitHub Copilot `oauth` · Cline `oauth` · Qwen Portal `oauth` · Ollama Cloud `oauth` · Wafer Serverless `oauth` · GitLab Duo · Kimi Code · MiniMax Coding Plan · Alibaba Coding Plan · Zhipu Coding Plan · Xiaomi token plans · Wafer Pass · OpenCode Go · OpenCode Zen · Moonshot · Qianfan · NanoGPT · Venice · Kilo · ZenMux

Perplexity is a `web_search` backend, not a bundled `/model` provider.

### Local and self-hosted

The three implicit keyless engines are Ollama, llama.cpp, and LM Studio. Ollama discovers through native `/api/tags` and `/api/show`; llama.cpp uses its model endpoints; LM Studio uses `/v1/models`. vLLM and LiteLLM also support runtime discovery and can be configured keyless when the server permits it. Ollama Cloud is hosted and requires API-key or OAuth authentication.

### Four knobs that make routing useful

- **Custom providers** — Declare providers in `~/.ompk/agent/models.yml` with any supported transport: `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-gemini-cli`, or `google-vertex`.
- **Fallback chains** — Per-role chains under `retry.fallbackChains`. When the primary throws 429s or hits a quota wall, the next entry takes the rest of the turn — restored on cooldown.
- **Path-scoped models** — Scope `enabledModels` and `disabledProviders` entries to a `path:` prefix to pin a different model set on one repo without touching the global config. Scoped entries cover the path and everything under it.
- **Round-robin credentials** — Stack API keys per provider and the runtime rotates with session affinity and per-credential backoff. Useful when one key would burn its quota by lunch.

Full provider & routing reference at [oh-my-pk.pkking.computer/docs](https://oh-my-pk.pkking.computer/docs).

## Eighteen backends. _One tool the agent already knows_.

`web_search` is built in, not bolted on. `auto` walks an eighteen-provider availability/fallback chain in the order below. Choose a preferred provider to try it first, or use `auto` for the normal order; failures and empty results continue through the remaining available providers. Exclude providers explicitly when they must never be used. Behind every hit, site-aware extraction turns GitHub, registries, arXiv, Stack Overflow, and docs into structured Markdown — anchors and link targets survive.

### Search providers

| provider | auth / availability |
| --- | --- |
| `auto` | ordered availability-and-failure fallback |
| `perplexity` | `PERPLEXITY_COOKIES`, OAuth, or `PERPLEXITY_API_KEY`; explicit selection also has anonymous fallback |
| `gemini` | `google-gemini-cli` or `google-antigravity` OAuth |
| `anthropic` | `ANTHROPIC_SEARCH_API_KEY`, or Anthropic OAuth / `ANTHROPIC_API_KEY` |
| `codex` | OpenAI Codex / ChatGPT OAuth |
| `xai` | `XAI_API_KEY` |
| `zai` | `ZAI_API_KEY` or stored `zai` credential |
| `exa` | `EXA_API_KEY` or stored Exa credential; explicit selection can use public Exa MCP |
| `tinyfish` | `TINYFISH_API_KEY` |
| `jina` | `JINA_API_KEY` |
| `kagi` | `KAGI_API_KEY` (Search API beta access) |
| `tavily` | `TAVILY_API_KEY` |
| `firecrawl` | `FIRECRAWL_API_KEY` |
| `brave` | `BRAVE_API_KEY` |
| `kimi` | `MOONSHOT_SEARCH_API_KEY` or `KIMI_SEARCH_API_KEY`, then stored `moonshot` / `kimi-code` auth |
| `parallel` | `PARALLEL_API_KEY` |
| `synthetic` | `SYNTHETIC_API_KEY` |
| `searxng` | `SEARXNG_ENDPOINT` or `searxng.endpoint`; optional bearer/basic auth |
| `duckduckgo` | no key; official Instant Answer API |

### Specialised handlers

The agent gets structured content, not stripped HTML.

- **Code hosts** — github, gitlab
- **Package registries** — npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages
- **Research sources** — arxiv, semantic scholar
- **Forums** — stack overflow, reddit, hn
- **Docs** — mdn, readthedocs, docs.rs

Pages convert to markdown with link structure intact. The agent can cite, follow, and quote without losing anchors.

### Security databases

Vuln lookups answer with vendor data, not blog summaries.

- **NVD** — national vulnerability database
- **OSV** — open source vuln feed
- **CISA KEV** — known exploited vulns

[`web_search` reference ↗](docs/tools/web_search.md)

## More than **63,000 lines of maintained Rust**, doing the work other harnesses shell out for.

`pi-natives` is the aggregate N-API `cdylib`, linking `pi-shell`, `pi-ast`, and `pi-iso`. The maintained Cargo workspace has seven packages: those four, shell-support libraries `pi-uutils-ctx` and `pi_uu_grep`, and the separate Windows-only `desktop-tag-host` helper. The 63,239-line audited total counts tracked Rust source, including maintained tests and build files, and excludes `crates/vendor` and both Brush mirrors.

Search, globbing, AST operations, text processing, highlighting, image rendering, and many shell builtins run in process. CPU/blocking N-API jobs use libuv, async shell/PTY/isolation paths use Tokio with blocking syscalls offloaded, and token batches use Rayon. External shell commands and some isolation backends/fallbacks still launch child processes.

- Maintained workspace packages: `pi-natives`, `pi-shell`, `pi-ast`, `pi-iso`, `pi-uutils-ctx`, `pi_uu_grep`, `desktop-tag-host`
- Release npm leaf-package tags: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`

The table below is a responsibility-oriented breakdown of maintained native runtime code; glue and tests are omitted, and deliberately volatile per-module LoC estimates are not duplicated.

| Module | What it does |
| --- | --- |
| `shell` | Persistent embedded Brush shell sessions · custom builtins · timeout/abort · fixups/cancellation · process management |
| `minimizer` | Opt-in shell-output compression · command detection · fail-safe built-in/user pipelines · original-output artifact preservation |
| `grep` | Regex search · parallel/sequential execution · glob and type filters |
| `fd` | Fuzzy path discovery for autocomplete and `@` mentions |
| `keys` | Kitty keyboard protocol with xterm fallback · PHF perfect-hash lookup |
| `text` | ANSI-aware width · truncation · column slicing · SGR-preserving wrap |
| `summary` | Tree-sitter structural source summaries with elision controls |
| `block` | Tree-sitter block ranges and enclosing-boundary resolution |
| `ast` | ast-grep pattern matching and structural rewrites |
| `fs_cache` | TTL-based directory-scan cache with explicit invalidation |
| `highlight` | Syntax highlighting · semantic categories · language aliases |
| `pty` | Native PTY allocation for sudo, SSH, and interactive prompts; owned by `pi-natives` |
| `glob` | Discovery with glob/type filters, mtime sort, and gitignore respect |
| `workspace` | Workspace walking with gitignore and `AGENTS.md` discovery in one pass |
| `appearance` | Native macOS dark/light detection and observation via CoreFoundation FFI |
| `power` | macOS power assertions for idle/system/display-sleep prevention |
| `task` | Libuv blocking jobs and Tokio async futures with cancellation, timeout, and profiling |
| `iso` | APFS clonefile · btrfs subvolume snapshots · ZFS snapshot+clone · Linux FICLONE · OverlayFS/fuse-overlayfs · Windows block clones · ProjFS · git-worktree/recursive-copy fallback |
| `prof` | Circular-buffer profiler with folded stacks and SVG flamegraphs |
| `ps` | Stable process references, child traversal, status/wait, and process-tree termination |
| `clipboard` | Text copy and image read from the system clipboard without `xclip`/`pbcopy` |
| `tokens` | Embedded O200k/Cl100k BPE token counting; Rayon-backed batches |
| `snapcompact` | Bitmap conversation-frame rendering to PNG with bundled pixel fonts |
| `sixel` | PNG/JPEG/WebP/GIF decode, resize, and SIXEL rendering |
| `html` | HTML-to-Markdown conversion with optional content cleaning |

## Five entry points: _interactive_, _one-shot_, the Node SDK, RPC, and ACP.

Same engine, five surfaces. `oh-my-pk` runs the TUI. `oh-my-pk -p` prints a final response and exits; `oh-my-pk --mode json` emits the one-shot session as newline-delimited JSON events. The Node SDK embeds the session in your process. `oh-my-pk --mode rpc` and `oh-my-pk acp` hand the wheel to another program over stdio.

### Interactive — when in doubt, the agent asks

The TUI is the default surface. Tool calls render as cards, edits preview before they land, and ambiguity routes through the `ask` tool — a structured option picker the agent can call mid-turn. The keyboard handles the rest.

The same prompt cards surface over ACP, so editors get the picker without writing one.

### Ephemeral — isolate the whole session

`oh-my-pk -p "fix the failing tests" --ethereal`

`--ethereal` runs the entire session against a throwaway copy of your repo, so the agent never touches your working tree. The default `auto` mode reflink-copies a Git repo (falling back to a `git worktree` overlay, or a plain copy off-Git); `.env` files and secrets stay home unless you opt in with `--copy-env`/`--copy-secret`, `--export-patch out.patch` hands back the diff, and `--preserve-workspace` keeps the sandbox for inspection. See [Ethereal Workspaces](docs/ethereal-workspaces.md).

### SDK — embed in Node

`@pk-nerdsaver-ai/pi-coding-agent`

Node and TypeScript hosts pull the engine in directly. The package exposes `ModelRegistry`, `SessionManager`, `createAgentSession`, and `discoverAuthStorage`; the session emits typed events you subscribe to.

```ts
import {
  createAgentSession,
  SessionManager,
} from "@pk-nerdsaver-ai/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

if (modelFallbackMessage) {
  process.stderr.write(`${modelFallbackMessage}\n`);
}

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("list .ts files");
unsubscribe();
await session.dispose();
```

### RPC — drive over stdio

`oh-my-pk --mode rpc`

For non-Node embedders, or when you want process isolation. NDJSON commands in, response and event frames out. `--mode rpc-ui` adds tool cards, selectors, and dialogs as `extension_ui_request` frames the host must answer.

```text
$ oh-my-pk --mode rpc --no-session
< {"type":"ready"}
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response","command":"prompt","success":true}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

### ACP — speak to editors

`oh-my-pk acp`

The [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) over JSON-RPC. When the editor advertises capabilities, tool I/O routes through it and writes are gated by `session/request_permission`.

| omp tool                      | ACP route                           |
| ----------------------------- | ----------------------------------- |
| `bash`                        | `terminal/create + terminal/output` |
| `read`                        | `fs/read_text_file`                 |
| `write`                       | `fs/write_text_file`                |
| `edit, bash`                  | `session/request_permission`        |

Full references: [SDK docs](docs/sdk.md) · [RPC protocol](docs/rpc.md) · [ACP specification](https://github.com/zed-industries/agent-client-protocol).

## A harness worth keeping is one you _don't_ outgrow.

Pick it up at **[oh-my-pk.pkking.computer](https://oh-my-pk.pkking.computer)** and read the full docs at **[oh-my-pk.pkking.computer/docs](https://oh-my-pk.pkking.computer/docs)**.

omp is a fork of [Pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner), rewritten as a coding-first surface: sessions, subagents, slash commands, extensions — all TypeScript, all MIT, all on [GitHub](https://github.com/kingkillery/oh-my-pk). Shape it from config, hook it from outside, or read the source when you need to.

### Primitives

An extension is a TypeScript module. Same tool API, same slash-command registry, same hotkey table, same TUI primitives the built-ins use. Nothing is reserved.

### Discovery

At session startup, `oh-my-pk` discovers supported configuration already on disk; nothing is copied or migrated.

| Ecosystem | Discovered surface |
| --- | --- |
| Claude Code | `.claude/CLAUDE.md` context, `.claude/skills`, commands, supported MCP files, tools/settings, and system-prompt files; `.claude/rules/*.md` is not currently discovered |
| Cursor | `.cursor/rules/*.{mdc,md}`, `mcp.json`, and project settings; Cursor skills and legacy root `.cursorrules` are not currently discovered |
| Windsurf | user `global_rules.md`, project `.windsurf/rules/*.md`, and `mcp_config.json`; Windsurf skills and legacy `.windsurfrules` are not currently discovered |
| Codex | user/project `AGENTS.md`, `config.toml` MCP, skills, and supported commands/prompts/hooks/tools/settings |
| Cline | project `.clinerules` as either a file or a directory of Markdown rules |
| GitHub Copilot | project `.github/copilot-instructions.md`, recursive `*.instructions.md` `applyTo` rules, `.github/skills`, and `.github/prompts`; user files come from `~/.copilot` or `COPILOT_HOME`; Copilot MCP is not currently ingested |
| VS Code | project `.vscode/mcp.json` MCP configuration |
| OpenCode | project `opencode.json` and `.opencode/{skills,commands,plugins}`, plus user configuration under `~/.config/opencode`; supported MCP, context, settings, commands, skills, and plugins load by capability |

### Extensibility

Ask `oh-my-pk` to write the piece you're missing. Restart the session to load a newly written extension, skill, hook, custom tool, agent, or MCP configuration; `/reload-plugins` currently refreshes discovery caches, file slash commands, and SSH state. Keep extensions local, ship them in a `marketplace`, or publish them to npm.

## Philosophy

omp is a fork of [pi-mono](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner), extended with a batteries-included coding workflow.

Key ideas:

- Keep interactive terminal-first UX for real coding work
- Include practical built-ins (tools, sessions, branching, subagents, extensibility)
- Make advanced behavior configurable rather than hidden

## GraphTree: parallel multi-agent worktrees and Fractal parity

`/graphtree` manages isolated git worktree nodes and recursive agent lifecycle trees for running several agents on the same repository side by side.

- `/graphtree status` (or bare `/graphtree`): prints active worktree node hierarchy as ASCII tree.
- `/graphtree list`: lists worktree node details (branch, path).
- `/graphtree agents`: renders a bounded live recursive `AgentRegistry` parent/child tree with sanitized status, attention, activity, and working directory context.
- `/graphtree init <name> [branch]`: creates a new worktree node (defaults to branch `graphtree/<name>`).
- `/graphtree run <objective>`: hands the model a prompt with configured hard bounds (`task.maxRecursionDepth`, `task.maxConcurrency`, `task.maxRuntimeMs`, `task.isolation.mode`) to plan, shard, and reduce work across nodes. Note: `/graphtree run` is prompt-driven and relies on local task/agent primitives rather than a standalone daemon.
- `/graphtree stop <agent-id>`: aborts and releases a non-main, non-advisor agent via `AgentLifecycleManager`.
- `/graphtree steer <agent-id> <guidance>`: revives a subagent if parked and sends steering guidance.
- `/graphtree revive <agent-id>`: revives a parked subagent; live agents report their current state without claiming a revival.
- `/graphtree merge <name>`: squash-merges a node's branch into `HEAD` as staged changes for review.
- `/graphtree prune <name>`: removes a clean, named worktree node (refuses dirty worktrees).

### External Fractal Parity Matrix

| Capability | External Systems (`plasma-ai/fractal`, `TinyAGI/fractals`) | Local Primitive in oh-my-pk |
| --- | --- | --- |
| Recursive Agent Tree | Autonomous sub-tree spawning | `AgentRegistry` parent/child hierarchy + nested task recursion |
| Worktree & Path Isolation | Separate directories / worktree clones | `task.isolation.mode` + `git worktree` nodes |
| Bounded Execution | Recursion & concurrency limits | `task.maxRecursionDepth`, `task.maxConcurrency`, `task.maxRuntimeMs` |
| Lifecycle Controls | Pause, stop, steer sub-tasks | `/graphtree stop`, `/graphtree steer`, `/graphtree revive` via `AgentLifecycleManager` |
| Persistence & Revival | Disk-backed agent state | Parked session files (`sessionFile`) with on-demand cold revival |
| Tree Visualization | Graph/tree terminal UI | ASCII tree rendering (`/graphtree` & `/graphtree agents`) |

See [`docs/graphtree.md`](docs/graphtree.md) for the complete reference and architectural details.

---

## Development

### Getting started from source

Fresh clones need both workspace dependencies and the local Rust/N-API addon before the source CLI can start.

```sh
bun setup
bun dev
```

`bun setup` installs Bun workspaces and builds `@pk-nerdsaver-ai/pi-natives`. Re-run `bun run build:native` after changing Rust crates or `packages/natives`.

For a non-interactive smoke check:

```sh
bun dev -- --version
```

### Debug Command

`/debug` opens tools for debugging, reporting, and profiling.

For architecture and contribution guidelines, see [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

---

## Monorepo Packages

| Package | Description |
| --- | --- |
| **[@pk-nerdsaver-ai/pi-activity-journal](packages/activity-journal)** | Local, evidence-backed activity journal with privacy-first clip ingestion |
| **[@pk-nerdsaver-ai/pi-ai](packages/ai)** | Multi-provider LLM client with streaming and model/provider integration |
| **[@pk-nerdsaver-ai/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@pk-nerdsaver-ai/pi-catalog](packages/catalog)** | Model catalog: bundled model database, provider descriptors, and identity |
| **[@pk-nerdsaver-ai/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI and SDK |
| **[@pk-nerdsaver-ai/clips-extension](packages/clips-extension)** | Extension that feeds Clips (gopk.xyz) screen recordings to agents |
| **[@pk-nerdsaver-ai/collab-relay](packages/collab-relay)** | Cloudflare relay and share service for oh-my-pk collaboration |
| **[@pk-nerdsaver-ai/collab-web](packages/collab-web)** | Browser guest client, mock host, and local relay for collab live sessions |
| **[@pk-nerdsaver-ai/pi-context-policy](packages/context-policy)** | Consent and retention policy primitives for opt-in persistent context |
| **[@pk-nerdsaver-ai/pi-context-storage](packages/context-storage)** | Storage contracts and pressure controls for opt-in persistent context |
| **[@pk-nerdsaver-ai/pi-deep-research](packages/deep-research)** | Supervisor/researcher deep-research agent built on `pi-ai` |
| **[@pk-nerdsaver-ai/pi-desktop-tag](packages/desktop-tag)** | Desktop extension for triggering agents with screenshots, selected text, and screen regions |
| **[@pk-nerdsaver-ai/hashline](packages/hashline)** | Line-anchored patch language and applier behind the `edit` tool |
| **[@pk/llm-router-agent](packages/llm-router-agent)** | Configurable LLM-routing extension and standalone router |
| **[@pk-nerdsaver-ai/pi-mnemopi](packages/mnemopi)** | Local SQLite memory engine for oh-my-pk agents |
| **[@pk-nerdsaver-ai/ompk-linear-agent](packages/ompk-linear-agent)** | Cloudflare Worker and job queue dispatching Linear-triggered ompk, Claude Code, or Codex runs over Tailscale |
| **[@pk-nerdsaver-ai/pi-natives](packages/natives)** | N-API bindings for grep, shell, image, text, syntax highlighting, and more |
| **[@pk-nerdsaver-ai/pi-remote-workspace](packages/remote-workspace)** | Docker-backed ephemeral workspace job runner for oh-my-pk |
| **[@pk-nerdsaver-ai/pi-screenpipe-bridge](packages/screenpipe-bridge)** | Bridges a local screenpipe capture daemon into the activity-journal gopk sink |
| **[@pk-nerdsaver-ai/snapcompact](packages/snapcompact)** | Bitmap-frame context compression package and SQuAD eval suite |
| **[@pk-nerdsaver-ai/omp-stats](packages/stats)** | Local observability dashboard for AI usage statistics |
| **[@pk-nerdsaver-ai/swarm-extension](packages/swarm-extension)** | Swarm orchestration extension package |
| **[@pk-nerdsaver-ai/terminal-bench](packages/terminal-bench)** | Terminal Bench 2 runner for the local oh-my-pk build with live progress and spend reporting |
| **[@pk-nerdsaver-ai/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@pk-nerdsaver-ai/typescript-edit-benchmark](packages/typescript-edit-benchmark)** | Edit benchmark suite built from TypeScript source-code mutations |
| **[@pk-nerdsaver-ai/pi-utils](packages/utils)** | Shared utilities for logging, streams, directories, environment, and processes |
| **[@pk-nerdsaver-ai/verifier-extension](packages/verifier-extension)** | LLM-as-verifier candidate comparison and audit extension package |
| **[@pk-nerdsaver-ai/pi-wire](packages/wire)** | Shared collab live-session protocol types and relay constants |

### Rust Crates

| Crate | Description |
| --- | --- |
| **[pi-natives](crates/pi-natives)** | Aggregate N-API `cdylib` for `@pk-nerdsaver-ai/pi-natives`; owns the N-API modules and links `pi-shell`, `pi-ast`, and `pi-iso` |
| **[pi-shell](crates/pi-shell)** | Embedded Brush shell sessions, output minimization, in-process coreutils/grep, fixups/cancellation, and process management; PTY allocation remains in `pi-natives` |
| **[pi-ast](crates/pi-ast)** | Tree-sitter summaries, syntactic block resolution, and AST search/rewrite across 58 supported language variants |
| **[pi-iso](crates/pi-iso)** | Isolation PAL and diff capture: APFS clonefile, btrfs snapshots, ZFS snapshot+clone, Linux reflinks, OverlayFS, Windows block clones, ProjFS, and git-worktree/recursive-copy fallback |
| **[pi-uutils-ctx](crates/pi-uutils-ctx)** | Thread-local stdio/cwd/environment/cancellation shim for embedded uutils |
| **[pi_uu_grep](crates/pi-uu-grep)** | ripgrep-library-backed in-process `grep` and `rg` shell builtins |
| **[desktop-tag-host](crates/desktop-tag-host)** | Unpublished Windows tray/hotkey/capture host that supervises the ompk-tag gateway |

Vendored dependency inputs are separate from the maintained workspace: [`brush-core`](crates/brush-core-vendored) and [`brush-builtins`](crates/brush-builtins-vendored) are local Brush mirrors, and additional upstream mirrors live under `crates/vendor`. They are excluded from the 63,239 maintained-line total.

## Contributing

Issues are open to everyone. **Pull requests require a vouch** — PRs from
unvouched or denounced authors are closed automatically. If you're not yet
vouched, ask a maintainer to `!vouch` you rather than opening a PR (which would
be closed on sight). See **[CONTRIBUTING.md](CONTRIBUTING.md)** and
[`.github/VOUCHED.td`](.github/VOUCHED.td) for the full policy.

---

## License

MIT. See [LICENSE](LICENSE).

© 2025 Mario Zechner  
© 2025-2026 Can Bölük

_made for terminals that stay open_

- [oh-my-pk.pkking.computer](https://oh-my-pk.pkking.computer)
- [GitHub](https://github.com/kingkillery/oh-my-pk)
- [Changelog](https://github.com/kingkillery/oh-my-pk/blob/main/packages/coding-agent/CHANGELOG.md)
- [npm](https://www.npmjs.com/package/@pk-nerdsaver-ai/pi-coding-agent)
- [Discord](https://discord.gg/4NMW9cdXZa)
- [MIT](https://github.com/kingkillery/oh-my-pk/blob/main/LICENSE)
