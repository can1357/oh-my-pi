# Gap 12: TUI job widgets and auto-graph charts

Status: research only. Nothing here is implemented or authorized.
Date: 2026-11-13
Baseline: omp2 f4186b783b; upstream c308970263 (pinned checkout).

Evidence keys:

- **OBSERVED** means read in code or docs at the baseline. Citations use `path:line`. Upstream paths carry the `upstream:` prefix.
- **[INFERENCE]** means the author's reasoning. Every size estimate is an inference.
- **UNVERIFIED** means no run or source confirmed it.

No build, test or run was made for this document.

## Question

Upstream draws two things omp2 does not: live widgets for background jobs (charts, bars and meters derived from a job's output) and automatic charts under numeric tables in the assistant's answers. What are they, how big are they, and what would a fit with `crates/tui` look like?

Out of scope: the Tern (TSP) chart nodes, and upstream's `wait`-card layout details.

## 1. Upstream

### Job widgets

A widget is data, not code. A cheap model writes a declarative spec once per job. A deterministic runtime applies the spec to each new output line. Renderers draw the result (`upstream:packages/tui/src/tools/job-widget.ts:1-13`).

- **Surfaces:** the `wait` card, the HUD's jobs pill with a hover card, and the jobs sheet (`upstream:packages/tui/src/tools/job-widget.ts:3-5`). The user-facing description is in `upstream:docs/settings.md:654`; the switch is `async.widgets`, default on, and off means plain job rows.
- **Job inputs:** a job offers text sources (`out`, `pipe:1`, `tools`, ...) readable from any retained offset, and a brief (kind `bash` or `task`, the command, timeout, intent, and for tasks a watch hint and stage) (`upstream:packages/coding-agent/src/job-widgets/types.ts:35-41`, `upstream:packages/coding-agent/src/job-widgets/types.ts:44-65`).
- **Spec:** up to 12 rules and 4 blocks (`upstream:packages/coding-agent/src/job-widgets/spec.ts:157-160`). A rule is a Rust-regex line matcher with named groups that feed numeric or text fields, with an optional split key, scale and count field (`upstream:packages/coding-agent/src/job-widgets/spec.ts:47-62`). Fields reduce with one of ten aggregates (`upstream:packages/coding-agent/src/job-widgets/spec.ts:14`). Blocks are spark, bars, meter, stat, grid and text (`upstream:packages/coding-agent/src/job-widgets/spec.ts:86-137`). Validation requires every regex to compile, every field a block reads to be fed by a rule, and the rules to match the sample lines the author saw (`upstream:packages/coding-agent/src/job-widgets/spec.ts:1-7`).
- **Authoring:** one toolless request to the `widget` model role (which aliases `smol`) with a forced `respond` call carrying the spec schema, fed the brief and redacted output samples (`upstream:packages/coding-agent/src/job-widgets/author.ts:1-5`).
- **Runtime:** no model past the spec. It reads new text per source, applies the rules in one native `LineMatcher` call per refresh, folds matches into per-field state and builds the view. Work per refresh is proportional to the new text, with bounded rings (`upstream:packages/coding-agent/src/job-widgets/runtime.ts:1-8`).
- **Registry and cadence:** refresh every 1 s while someone watches, at least 250 ms between reads of one job, a spec may be requested only after the job is 15 s old, at most 2 requests in flight, with drift detection that re-authors when unmatched lines pile up (`upstream:packages/coding-agent/src/job-widgets/registry.ts:17-45`).
- **Fallback:** the view state is `authoring`, `live` or `fallback`; with no spec the view shows only the last line and rates (`upstream:packages/tui/src/tools/job-widget.ts:25-32`).
- **Captions:** a second cheap-model use writes one plain-English line per command job saying what it does and when it ends. It sees the command and intent, never the output (`upstream:packages/coding-agent/src/job-widgets/caption.ts:1-6`).
- **Rendering:** the view is drawn as TSP nodes or as ANSI lines. Progress uses a progress bar component and series use a block sparkline, `▁▂▃▄▅▆▇█` (`upstream:packages/tui/src/tools/job-widget.ts:15-17`, `upstream:packages/tui/src/components/sparkline.ts:1-7`). The view carries a title, headline, stage, blocks, state and update time (`upstream:packages/tui/src/tools/job-widget.ts:128-139`).
- **Size:** about 2,500 lines of coding-agent code (runtime 928, spec 853, registry 440, author 273, others) plus about 1,050 lines of TUI rendering. Counts are from `wc -l` on the pinned checkout.

### Auto-graph charts

- Setting `tui.autoGraph`, default `auto`: numeric tables in assistant answers get a chart in the theme's colors on terminals that show graphics. `always` uses the built-in guess, `smart` lets the judge refine it (`upstream:docs/settings.md:917`). The changelog says `auto` refines by judge only for supported native judge models and otherwise uses the built-in estimate (`upstream:packages/coding-agent/CHANGELOG.md:791`).
- Pipeline: `analyzeTable`, then `planChart` (the local guess), `buildChart`, `renderChartSvg`, with `worthCharting` deciding whether the picture says more than the table (`upstream:packages/tui/src/charts/chart-plan.ts:1-8`). The heuristics were fitted on about 7,000 real tables: first text column is the label, index columns never are, table order is kept, total rows stay out of the scale, units never share an axis, a baseline row becomes the reference, and values spanning decades draw as factors of change (`upstream:packages/tui/src/charts/chart-plan.ts:10-21`).
- Model refinement: two judge rounds. First a reading of the table (which column names rows, which numbers lead, which way each measure is better), then a choice among candidate charts each described as what it would draw (`upstream:packages/coding-agent/src/auto-graph/planner.ts:1-19`).
- Delivery: `splitTableCharts` cuts a Markdown block after each table that gets a chart; the chart is cached per table source and shown as a terminal image rasterized in the theme, or as an SVG fence for a TSP terminal (`upstream:packages/tui/src/chat/table-chart.ts:1-10`).
- Size: about 11,300 lines in the chart code (`chart-plan.ts` 5,045, `chart-svg.ts` 4,654, `table-data.ts` 1,567) plus 1,092 for the planner and 284 for `table-chart.ts`. The planning prompt is a 16.5 KB JSON file (`upstream:packages/coding-agent/src/prompts/judge/auto-graph.json`). A port of that size is a project, not a slice. [INFERENCE]

## 2. omp2 inventory

### Components and charset rules

- `omp-tui` is a retained component tree with `dom!`, a differential renderer, graphics, markdown and a Tern surface protocol (`crates/tui/README.md:3-14`). Components include `progress`, `table`, `img`, `scene`, `shader`, `spinner`, `status`, `tool_card` and `todo` (directory `crates/tui/src/components`).
- No sparkline and no chart component: a search for `spark` and `chart` in `crates/tui/src` found only colour names and Mermaid flowchart handling (`crates/tui/src/markdown/mermaid.rs:109`). Correction (2026-11-14): the TSP wire does have `chart` and `meter` node kinds (`crates/tui/src/tsp/wire.rs:108-109`), with no typed builder and no sender yet. Two block ramps are already hardcoded outside `crates/tui`: `trend_bar` in `omp usage` (`crates/app/src/usage_cmd.rs:350-364`) and the live voice meter (`crates/chat/src/overlays/live.rs:667`).
- `Progress` backs the `<progress>` tag and draws `██████░░` (`crates/tui/src/components/progress.rs:10`, test at `crates/tui/src/components/progress.rs:136`).
- Charset is `Unicode`, `NerdFont` or `Ascii` and reaches every component. `AGENTS.md` bans hardcoded colours and hand-emitted glyphs; icons come from `icons.tsv` (`crates/tui/src/context.rs:41-49`, `AGENTS.md:460-462`). A block sparkline needs an ASCII fallback and a theme tone, so its glyph ramp belongs in the icon or charset layer, not in the component.
- Graphics: terminal capability detection and image paths exist (`crates/tui/src/graphics.rs:1-6`, `crates/tui/src/sixel.rs`, `crates/tui/src/components/img.rs`). SVG rasterization exists elsewhere: `omp-tools` rasterizes SVG with `resvg` for image reads (`crates/tools/src/read/image.rs:240`, `crates/tools/src/read/image.rs:308`). `omp-tui` does not depend on `resvg` (`crates/tui/Cargo.toml:28-36`).
- Markdown tables go through `render_table` (`crates/tui/src/markdown/table.rs:197`). That is the hook where a chart would attach.
- Dependencies already in the workspace: `regex` (`Cargo.toml:215`), `resvg` (`Cargo.toml:217`), `image` (`Cargo.toml:89`).

### Job data and surfaces

- Job state lives in the session DOM under `<meta><jobs>` (`crates/agent/src/jobs.rs:1-6`). The `/hub` overlay reads each `<subagent>` and `<job>` row into `JobRow` with id, kind (`subagent`, `tool`, `process`), status, owner, agent, model, start time and a JSON `data` payload (`crates/chat/src/overlays/hub.rs:92-109`, `crates/chat/src/overlays/hub.rs:113`).
- The status band has a `Jobs` chip showing a count with a job icon (`crates/chat/src/status_band.rs:1494`, `crates/chat/src/status_band.rs:1994-1997`).
- The `wait`/`jobs` card renders job snapshots with id, kind, label, text, wall time and status (`crates/chat/src/cards/hub.rs:437-480`).
- Live output: a running call's output frames are appended to the call's `<result>` text stream, in sequence, up to an inline byte limit, with the rest spilled to a content-addressed stage (`crates/agent/src/dispatch.rs:944-967`). Correction (2026-11-14, traced for the ADR revision): the DOM therefore holds only the head of a long output (64 KiB by default, `crates/agent/src/dispatch.rs:107`, `crates/agent/src/dispatch.rs:1048-1085`), and the spill stage is readable only after the call closes. Shell jobs (`bash` `async` and auto-backgrounded runs) and named `process` jobs are envd named processes whose output is in envd's process log, not the DOM (`crates/tools/src/shell.rs:716-746`, `crates/envd/src/tool_shell.rs:332-381`, `crates/driver/src/subagent/hub.rs:800-935`); `EnvClient::attach_output` reads that log from any offset, capped, then follows it (`crates/envd/src/exec.rs:2078-2110`). Chat can reach it through the `Services` feed, whose production implementation holds an `EnvClient` (`crates/app/src/chat_services/mod.rs:85-87`).
- Model roles: the built-in role ids include `smol`, `tiny`, `judge` and `memory` but no `widget` (`crates/catalog/src/selection.rs:175-178`).

### Gap table

| Piece | Upstream | omp2 | Gap |
|---|---|---|---|
| Block sparkline | yes, 89 lines | none | small component plus icon-layer ramp |
| Progress bar | yes | `Progress` | none |
| Job widget view model | `JobWidgetView` | none | new type |
| Spec (rules, blocks) and validator | 853 lines | none | port, or replace |
| Deterministic runtime | 928 lines, native line matcher | none | port; `regex` is available |
| Spec author (`widget` role) | cheap model, forced `respond` | no `widget` role | add role or reuse `smol` |
| Captions | yes | none | optional, separate |
| Surfaces | `wait` card, HUD pill, jobs sheet | `wait` card, `Jobs` chip count, `/hub` | add widget row to each |
| Job text sources | pipes, taps, task tool output | envd process log for shell and process jobs; DOM `<result>` head for dispatcher-detached calls | a read feed to chat (ADR 0066 D3) |
| Table chart planner | 5,000+ lines | none | large |
| Chart rasterization | SVG to terminal image | `resvg` only in `omp-tools` | new dependency edge |
| Chart on TSP | SVG fence; `chart` node for job sparks | `chart` kind on the wire, no sender | out of scope |

## 3. Class

**Class c (port)** for job widgets, staged. The runtime, spec model and view are TypeScript and small enough to rewrite in Rust. Part of it needs no port at all: the model-free fallback view is new omp2 code over data omp2 already has.

**Class c, deferred** for auto-graph. It is a port, but of about 12,000 lines whose value depends on a graphics-capable terminal. A smaller local text chart is a class d proposal inside the plan.

Verdict: build stages 1 and 2 of the job widgets; decide on the rest after that; defer auto-graph. Revised 2026-11-14 after ADR 0066's review: only the model-free newest output line of the selected running shell job in the `/hub` inspector is committed; widgets, charts and model specs are deferred.

## 4. Options

### Job widgets

1. **Build on existing omp2 code.** Extend the `Jobs` chip and the `/hub` job row to show the last output line and a rate, with no model and no rules. Cost: 2 to 3 days. Fit: good. It is the same "fallback" state upstream has, and it needs only the DOM result stream and `JobRow` (`crates/chat/src/overlays/hub.rs:92-109`). It cannot draw series or meters.
2. **Port the full pipeline** (spec, validator, runtime, author, registry). Cost: 2 to 3 weeks for the 2,500 lines plus tests. Fit: good in the end, but it ships a model-authored regex feature before anyone knows the surface is wanted.
3. **Port the runtime and a fixed set of built-in rules** (no model authoring): known commands such as `cargo`, `pytest` and `curl` get hand-written rule sets. Cost: medium. Fit: deterministic, which AGENTS.md prefers, but it covers only commands someone wrote rules for.

Choice: option 1 first, then the runtime from option 2 with built-in rule sets from option 3, and the model author last and only if wanted. This keeps "deterministic rules first, a model only where rules cannot". [INFERENCE]

### Auto-graph

1. **Port the whole pipeline with SVG rasterization.** Cost: weeks, plus a `resvg` edge from `omp-tui`. Fit: poor now.
2. **A local text chart under a numeric table**, built from the sparkline and block bars, no model, no SVG. Cost: 3 to 5 days. Fit: works on every terminal, themed through the charset layer.
3. **Defer.**

Choice: option 3 now. If wanted later, option 2, then image charts through a rasterizer callback the host supplies so `omp-tui` stays free of `resvg`. [INFERENCE]

## 5. Plan

Superseded (2026-11-14): after three review rounds, ADR 0066 commits to one slice: the newest output line of the selected running shell job in the `/hub` inspector. It reads envd's process log through one live attachment from the log end plus one capped history read, behind `cl_hub_job_output`, with a real-PTY proof. Guaranteed coverage is `bash` with `async: true`; whether foreground runs reach envd before the dispatcher's 30 s limit is unverified (ADR 0066 O5). Everything else below is deferred; the ADR's "Deferred work" holds the checked facts. The ADR's `## Slices` is the plan; the list below is the original draft. Two claims in it were wrong: slice 2's "spilled output still shows the retained tail" cannot hold, because the DOM keeps only the head, and slice 1's "a constant series draws the lowest block" contradicts upstream, where a constant positive series draws the top block (`upstream:packages/tui/src/components/sparkline.ts:29-43`).

### Slice 1: sparkline component

- Add a `<spark>` component to `crates/tui/src/components` taking a slice of numbers and a width. The glyph ramp comes from the charset layer (eight blocks in Unicode and NerdFont, an ASCII ramp otherwise). The colour is a theme tone.
- Acceptance: golden frame tests in all three charsets; a constant series draws the lowest block; values above the domain clamp to the full block; width smaller than the series keeps the newest values.
- Gate: none; a component with no caller is inert.

### Slice 2: model-free job row

- A `JobWidgetView` with title, last output line and a rate, drawn in the `/hub` job row and the `Jobs` chip's detail, from the DOM result stream. No model call.
- Acceptance: a running tool job shows its newest output line within one render tick; a job with no output shows its status; output that was spilled past the inline limit still shows the retained tail; the transcript is not repainted by refreshes.
- Gate: default-off convar `sv_job_widgets`.
- Tests: snapshot tests beside `crates/chat/src/cards/hub.rs`.

### Slice 3: rule runtime with built-in rule sets

- Port the rule and field model with the `regex` crate, bounded rings and the ten aggregates; keep the limits of 12 rules and 4 blocks. Ship rule sets for a few common commands. The runtime reads only the job's own output and never tool-result text a job fetched (upstream fixed a leak of exactly that: `upstream:packages/coding-agent/CHANGELOG.md:829`; and percentage meters needed special handling: `upstream:packages/coding-agent/CHANGELOG.md:1154`).
- Acceptance: recorded output of each supported command replays to the expected view; work per refresh is proportional to new text (a test appends 1 MB in small chunks and bounds total time); a rule that stops matching degrades to the slice 2 view.
- Gate: `sv_job_widgets`.

### Slice 4: model-written specs (only if wanted)

- Add the author with a `widget` role or an alias to `smol`, a forced-call schema, validation against the samples before use, redaction of samples, at most 2 requests in flight, and a start only after 15 s.
- Acceptance: a fake author returns a spec that validates and drives the view; an invalid spec is rejected without effect; secrets in samples are redacted before the request.
- Gate: `sv_job_widgets_author`, default off. A `widget` role changes the stable role vocabulary (`crates/catalog/src/selection.rs:172-178` calls it the public contract), so aliasing `smol` is safer. Owner decision.

### Slice 5 (deferred): local text chart under tables

- Hook `render_table` (`crates/tui/src/markdown/table.rs:197`); for a table with one numeric column and a text label column, draw block bars. Decide with a small `worthCharting` rule.
- Acceptance: tables with no numeric column or a single row get no chart; ASCII charset still renders; widths adapt.
- Gate: default-off convar `sv_table_charts`.

Where the code goes: components and the ramp in `crates/tui`; the view model, rules and runtime near `crates/chat` or a small new crate, so `omp-tui` does not learn about jobs (check the crate-boundary rules in `AGENTS.md` first); the author in the agent or driver layer beside other judge users.

## 6. Open questions

1. **Render budget.** A 1 s refresh over many jobs must not repaint the transcript. Draw widgets only in a status or hover surface and let the retained `Ui` diff them (`crates/tui/README.md:11`).
2. **Secret leakage.** Authoring samples can contain secrets. Upstream redacts them; omp2 needs the same, with a test.
3. **A `widget` role.** It changes the stable role vocabulary. Owner decision; aliasing `smol` avoids it.
4. **Replay.** Whether views are journaled or recomputed on resume. Upstream rebuilds them from output after a reload (comment at `upstream:packages/tui/src/tools/job-widget.ts:126`).
5. **Live output for named `process` jobs**: traced on 2026-11-14; they are envd named processes, readable through `attach_output` (see section 2).
6. **Where to put the runtime**: `crates/chat`, or a new crate. Check `AGENTS.md` crate rules.
7. UNVERIFIED: `resvg` rasterization cost on large charts; whether the Tern surface needs a chart node.
8. No locked ADR conflicts found. All additions are new convars and components; no existing tool, hook, scheme or CLI command changes.

## 7. Upstream origin and license

A port would draw from `upstream:packages/coding-agent/src/job-widgets/` (spec, runtime, registry, author, caption, types), `upstream:packages/tui/src/tools/job-widget.ts`, `upstream:packages/tui/src/components/sparkline.ts` and, if auto-graph is ever built, `upstream:packages/tui/src/charts/`, `upstream:packages/tui/src/chat/table-chart.ts` and `upstream:packages/coding-agent/src/auto-graph/planner.ts`. All TypeScript, to be rewritten in Rust. The upstream `LICENSE` is MIT (copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.; `upstream:LICENSE:1-5`). Keep the notice for any copied prompt text, such as the 16.5 KB `auto-graph.json` rubric.

