# README capture runbook

The README previously embedded 22 demo clips and screenshots served from
`omp.sh` — upstream's recordings of upstream's TUI, on a domain the fork does
not own. They were removed in PR #18. This runbook covers re-shooting the
high-value subset under the fork's own branding.

**Scope of this document:** everything *around* the recording — scenario
staging, terminal setup, what each take must show, and where the assets land.
The recording itself needs an operator at a screen; no agent can produce it.

Tracked in NER-138.

## Which captures are worth re-shooting

Not all 21. Four carry most of the differentiation, in priority order:

| capture | shows | staging cost |
|---|---|---|
| `eval` | Python **and** Bun kernels in one session, calling back into agent tools | low |
| `dap` | a real debugger attached to a segfaulting binary | medium — needs `lldb-dap` |
| `ttsr` | a stream aborted mid-token and course-corrected by an injected rule | medium |
| `lsp` | a rename propagating across three files via `workspace/willRenameFiles` | low |

`collab` and `pr` are cheap additions if wanted: `collab` can use the live
`ompk-collab` worker, and `pr` can point at a real `oh-my-pk` PR.

## Terminal setup — identical for every take

Consistency matters more than any individual setting; mismatched takes look
worse than plain ones.

- **Size:** 120×32. Wide enough for tool cards without wrapping, short enough
  that the whole frame stays legible when scaled into a README.
- **Theme:** whatever `theme` resolves to by default — do not hand-pick, so the
  captures match what a new user sees.
- **Font:** any 8x13-class terminal font at ≥16px. Below that, text turns to
  mush when the asset is downscaled.
- **Shell prompt:** minimise it. A long path or a git-status prompt dates the
  capture and leaks local directory names.
- **Config isolation:** run with a scratch config dir so personal skills,
  commands and MCP servers do not appear:
  ```bash
  PI_CONFIG_DIR=.capture-ompk omp
  ```
  This matters — the agent discovers project `.ompk/` content, and an
  un-isolated capture will show your own commands and agents in the UI.

## Scenario staging

### 1. `eval` — two kernels, one session

Stage a directory with a small CSV and nothing else. The take must show:

- a Python cell loading the CSV **through the agent's own `read` tool**, not
  `open()` — the loopback bridge is the point;
- a JavaScript cell operating on the same in-session state;
- both kernels alive in one session at the end.

The `py` and `js` runtimes live in `packages/coding-agent/src/eval/`. No extra
install beyond a working `python3` on PATH.

### 2. `dap` — a real debugger

Requires `lldb-dap` on PATH (`packages/coding-agent/src/dap/defaults.json`
also ships `gdb`, `codelldb`, `debugpy`, `dlv`, `js-debug-adapter`,
`netcoredbg`, `kotlin-debug-adapter`).

Stage a C file with a deterministic null-deref or bad index — deterministic
matters, because a take that has to be retried on a flaky crash wastes an hour.
Build with `-g -O0`. The take must show the adapter attaching, a stop event, a
frame with real locals, and the agent *reasoning about the value it read*
rather than just printing it.

`debugpy` is the cheaper fallback if `lldb-dap` is unavailable — Python needs no
compiler and the story is the same.

### 3. `ttsr` — stream abort and rule injection

Needs a rule whose condition reliably matches something the model is about to
write. Two failure modes to avoid:

- a rule so broad it fires immediately and shows nothing interesting;
- one so narrow the model never trips it, and the take is a dead stream.

Aim for a pattern the model reaches for naturally in the chosen task. The take
must show the abort mid-token, the injected rule card, and the agent's
course-correction afterwards — all three, or the feature is not legible.

### 4. `lsp` — a rename that propagates

Stage a TypeScript project where one symbol is imported through a barrel and
re-exported, so the rename visibly touches three files. Show the reference
lookup first, then the rename, then a search confirming zero stale matches. The
zero-matches frame is what proves it worked.

## Hosting

Two options; neither needs new infrastructure.

1. **Commit to `assets/`** and serve via GitHub raw, exactly as `hero.png`
   already does:
   `https://github.com/kingkillery/oh-my-pk/blob/main/assets/<name>?raw=true`.
   Simplest, versioned with the repo, but video in git is unpleasant.
2. **R2 behind `pkking.computer`.** The account already has R2
   (`gopk-clips`, `ompk-hub-blobs`, `ompk-collab-shares`) and the zone. Better
   for `.mp4`; needs a bucket and a public route.

Stills as `.webp`, video as `.mp4` with a `-poster.webp` first frame — that is
the pattern the README markup already expects.

## Do not

- **Do not synthesise screenshots or hand-write fake TUI output.** These assets
  exist to show the product working. A fabricated one is a false claim about
  software behaviour, and it will be believed.
- **Do not reuse upstream's assets.** That is what this work replaces.
- **Do not capture with your real config dir.** See the isolation note above.

## Status

Staging and setup: documented here. Recording: pending an operator. Nothing is
committed to `assets/` yet, and the README currently carries no media.
