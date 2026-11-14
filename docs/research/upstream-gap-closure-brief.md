# Mission
Close the functional gaps between this repo (blyzer/oh-my-pi, branch omp2) and
upstream OMPv1 (can1357/oh-my-pi main, reference commit c308970263, v18.20.0),
working autonomously in a Claude Code cloud session. Add capability; do not
remove or change what already works. Read AGENTS.md and PHILOSOPHY.md first
and follow them.

# Step 0: bootstrap (once, before any gap)
Skip any item that already exists.
1. Save this entire prompt, unchanged, as
   `docs/research/upstream-gap-closure-brief.md`.
2. Append one line to `.claude/context-after-compact.md`: "Before continuing,
   re-read docs/research/upstream-gap-closure-brief.md and
   docs/research/upstream-gap-closure.md." This is the only edit to an
   existing file that this step allows.
3. Vendor the Elephant-Goldfish Model skills: clone
   github.com/google/elephant-goldfish-model, copy its skill directories
   (egm-brainstorm, egm-draft, egm-resolve, egm-review, egm-review-loop,
   egm-bootstrap, egm-drift-report) and the persona files they reference into
   `.claude/skills/`, keeping its LICENSE and NOTICE beside them and recording
   the source commit in `.claude/skills/EGM-PROVENANCE.md`. If the clone is
   blocked by the network policy, record that and use the by-hand loop below.
4. Write four repo-native skills under `.claude/skills/`, each a short
   SKILL.md derived from this repo's own rules (AGENTS.md, docs/adr/README.md,
   the format of existing ADRs and research notes), not from generic advice:
   - `omp-gap-research`: the Study / Inventory / Classify / Research steps and
     the research-note template.
   - `omp-adr`: this repo's ADR format, numbering, status vocabulary and the
     STATUS.md ledger row.
   - `omp-slice-plan`: slicing into one-PR units with acceptance criteria and
     the test kinds this repo uses (unit, e2e crate, golden journal).
   - `omp-pre-pr`: the checks to run and the review to do on a slice's diff
     before opening its PR (`just` lint, lintx ratchets, tests, ADR 0035
     error discipline, naming rule, additive-only rule).
5. Commit steps 1 to 4 as one PR titled "chore: gap-closure brief and
   development skills". These files are development tooling for Claude Code;
   they are not omp2 runtime skills and must not be placed under `.omp/` or
   loaded by omp2.
6. Skills are registered at session start. In this session, use the new
   skills by reading their SKILL.md files directly.

# Hard constraints
- Additive only. Do not change the behaviour, names, schemas or revisions of
  existing tools, skills, convars, hooks, URL schemes or CLI commands. If a gap
  seems to require changing one, stop work on that gap, write the conflict into
  its ADR as an open question, and move to the next gap.
- Add a new roster family only when no existing family, `dyn` device or
  extension can carry the capability, and justify it against ADR 0024 in the
  ADR.
- Vendor integrations go in extensions, never in core (ADR 0049). Core stays
  vendor-neutral.
- Deterministic first: triggers, gating and extraction are rules and native
  code; a model only interprets results or handles what rules cannot.
- Respect locked decisions (ADR 0036 Python-only extensions and eval, ADR 0024
  latched roster, ADR 0006 sandbox policy). Do not reopen them; if a gap
  collides with one, record "not adopted" with the reason.
- No new language runtimes. Port TypeScript logic to Rust under omp2 names;
  reuse upstream Rust code where its license allows.
- Native naming and structure. Nothing ported keeps a `pi` identity: no
  `pi-*` crate names, `pi_*` modules, `PI_*` environment variables, `.pi`
  paths or pi-era settings keys. Name new crates `omp-*`, and follow this
  repo's crate layout, convar naming (`sv_*`, `cl_*`), error discipline
  (ADR 0035) and Director / roster / extension model. Port the behaviour, not
  the shape: upstream's TypeScript structure and in-process assumptions do not
  carry over. Upstream paths in this prompt are source references only.
  Record the upstream origin of each port in its ADR, and in the crate's
  NOTICE where the license requires it.
- Every change keeps `just` lint, the lintx ratchets and the full test suite
  green.

# Design review: Elephant-Goldfish Model (EGM)
Use EGM to review every design before code is written for it. You are the
Elephant: you hold the context and draft. Goldfish reviewers are fresh
subagents that see only the document and the files it references, never this
conversation.
- Use the EGM skills vendored in Step 0. If they are not present, run the same
  loop by hand: one fresh subagent per persona (zoom-out, comprehension,
  design critic, implementation readiness, as listed in ADR 0053 D7), each
  given only the document path, then a synthesis pass.
- A review in your own context is not a Goldfish review. Never use a forked
  subagent as a reviewer, because a fork inherits this conversation. If fresh
  subagent contexts are not available, stop reviewing, mark the ADR
  "unreviewed" and do not implement that gap.
- Scope: classes c and d only. Skip it for classes a and b, and for gaps that
  are data or small mechanical additions (6, 7, 8, 15).
- EGM is a development aid. Nothing in omp2's build, tests or runtime may
  depend on it (ADR 0053 O3). Do not implement ADR 0053 itself in this pass.
- EGM expects a human to approve the specification. No human is present, so
  apply this substitute and nothing weaker:
  1. Verify every Goldfish finding against source before accepting or
     rejecting it; cite path and line either way.
  2. Revise and re-review, at most three rounds.
  3. If any finding of blocker severity is still open after round three, stop
     at the ADR for that gap, list it for the owner, and move on.
  4. If none is open, implement, but only behind a default-off `cap-*` feature
     or convar, and record in the ADR that the design was machine-reviewed and
     not owner-approved.
- A clean review does not replace tests. Acceptance is the tests in the plan.

# Using OMPv1 as a development aid
Where OMPv1 is available in this environment, you may run it as a tool while
building omp2, where it helps and omp2 has no equivalent yet:
- `/ratchet` to build an eval for a flow you are porting (fact extraction,
  semantic find, auto effort) and hill-climb it before fixing the design.
- skillshare to fetch or pack skill bundles useful for the work.
- `find`, `/seance` and any other upstream-only tool for studying code.
Rules:
- This is tooling for the developer loop only. Nothing in omp2's build, tests
  or runtime may depend on OMPv1 being installed.
- Prefer omp2's own tools and skills whenever they can do the job. Do not
  modify them; add a new tool only when nothing existing fits.
- Each time you had to reach for an OMPv1 tool, note it in that gap's research
  file as evidence of the gap's value.
- Evals and skills produced this way are committed in omp2-native form.

# Skills to use, by stage
- Research: `omp-gap-research`. The Explore subagent for the inventory step.
  A deep-research skill, if one is listed in this session, for questions
  outside the two repos (what ovnfs is, the E2B API, ABKit distribution
  terms); otherwise research those directly.
- Design: `omp-adr`.
- Design review: the EGM skills.
- Plan: `omp-slice-plan`.
- Implement and close: `omp-pre-pr` on every slice before its PR.
- If this session also lists architecture, system-design, testing-strategy,
  code-review, debug or documentation skills, you may use them as a second
  opinion. Where they disagree with the `omp-*` skills or AGENTS.md, the repo
  wins. Never block on a missing skill.

# Method, per gap
First create one todo task per gap below. Then, for each task in order:
1. Study: read the upstream implementation at the reference commit and state
   in two or three sentences what it does and why a user needs it.
2. Inventory: search this repo for what already exists (crates, extensions,
   convars, hooks, importer stubs). Cite files and lines.
3. Classify as exactly one of:
   a. already covered by an equivalent (name it; no code change);
   b. not needed (say why, and what a user does instead);
   c. port (bring upstream's behaviour across, in omp2's shape);
   d. propose (design something better suited to omp2's architecture).
4. Research: for c and d, compare at least two options, including "build on
   existing omp2 code" versus "port", and choose one with reasons.
5. Document: write `docs/research/<gap>.md` with steps 1 to 4. For c and d
   also write a new ADR with the next free number, status "Proposed", and add
   its row to `docs/adr/STATUS.md`. Classes a and b get the research note only.
6. Review: run the EGM loop on the ADR as described above. Add a section
   "What the review changed" to the ADR, listing each finding, whether you
   confirmed it against source, and what you changed.
7. Plan: list slices small enough for one PR each, with acceptance criteria
   and the tests that prove them. Add each slice as a sub-task in the todo.
8. Implement slice by slice on a branch per gap, behind a `cap-*` feature or a
   default-off convar until its acceptance tests pass. Add unit tests and, for
   user-visible behaviour, an e2e or golden-journal test.
9. Close: update the ADR status and the ledger with what landed and what is
   open, tick the todo task, and append a row to
   `docs/research/upstream-gap-closure.md` (gap, class, ADR, review outcome,
   status, PRs).

# Gaps, in priority order
1. Subagent isolation. Two parts, one ADR:
   a. Copy-on-write backends: upstream `crates/pi-iso` (APFS clone, btrfs,
      ZFS, overlayfs, ProjFS, Windows block clone) versus per-file reflink
      with copy fallback here. Land as `omp-iso` or inside the existing
      isolation code, whichever the inventory favours.
   b. ovnfs: upstream `crates/pi-vfs` and
      `packages/coding-agent/src/task/ovnfs.ts`, which speed up isolated
      subagent startup on ovnfs-backed checkouts. Study what ovnfs is and
      when it applies before classifying. If it only helps on a filesystem
      this project's users do not have, classify it b and say so. If adopted,
      it is an `omp-*` virtual-filesystem crate.
2. Mnemopi model-free fact extraction: upstream
   `packages/mnemopi/src/core/extraction.ts` (`heuristicExtractFacts`) and
   `core/beam/consolidate.ts` (`extractAndStoreFacts`); add fact validity
   (`valid_until`). Here, extraction is skipped when `llm_mode` is none
   (`crates/memory/src/session.rs`), and the sink
   `BankStore::save_extracted_facts` exists. Rules must cover Spanish and
   technical facts (versions, dependencies, decisions), not only English
   first-person statements. Prefer structured tool results over parsing prose.
   Then wire `local-memory-model` extraction through the existing Apple FM
   backend (`crates/ai/src/local/applefm.rs`), one bounded request per chunk,
   falling back to the rules when the model is unavailable.
3. Semantic `find`: upstream `tools/find` with the judge role. Evaluate
   building it on `omp-kb` plus the existing judge role.
4. Desktop user-intervention guard and XKB layout handling: upstream
   `crates/pi-natives/src/desktop/control` (source reference only).
5. Automatic reasoning effort: upstream `defaultThinkingLevel: auto` and
   `providers.autoThinkingMaxEffort`. Design as a Director. Choose effort
   only; do not switch models mid-session.
6. In-process shell builtins missing here: cp, chmod, tar, rsync, du, df, dd,
   env, id, sd, shasum, strings, od, nl, fold, rmdir, lsof, uptime, md5.
7. Config discovery: Copilot instructions, `.github/instructions`,
   `~/.ssh/config`.
8. Web readers with no match here: CISA KEV, SEC EDGAR, Semantic Scholar,
   pub.dev, Firefox add-ons, JetBrains and VS Code marketplaces. Search
   backends: Keenable, Hacker News.
9. Subagent tools: `/seance` (read-only consult of a saved session, from the
   journal without opening a writer) and the completion probe.
10. Session tools: `/anon`, `/record` and `omp play`, `/local`,
    `/forget-approvals`, model presets.
11. Context tools: `context_notes`, `new_context`, `wait`, and the `out://`,
    `proc://` and `cfg://` schemes. Expect several to classify as a or b;
    `xd://` is expected to be covered by `dyn`.
12. TUI: job widgets and auto-graph charts.
13. Browser: React inspection and accessibility audit. Assess ABKit as an
    additional `omp-webview` engine, including its distribution terms;
    research and ADR only unless the terms are clear.
14. Memory backends: sharpshooter-style project decision files. Hindsight as
    an extension only.
15. Providers and sign-in missing here (DeepInfra, SambaNova, SiliconFlow,
    Snowflake, LiteLLM, Cloudflare Workers AI, Factory Droid, GitLab Duo
    agent, Qwen portal, Liquid, Modular and the rest of the upstream-only
    list; Mistral Vibe and Snowflake sign-in): catalog data only, no new
    codec unless the wire protocol is new.
16. Ratchet and skillshare as omp2 features: expect overlap with ADW,
    autoresearch and the signed extension index. Classify before building.
17. Forge URL schemes: move `pr://` and `issue://` resolution out of core per
    ADR 0050, so each forge extension owns its own change and repository
    management schemes. Existing URLs must keep working.
18. Generated RPC clients (Go, Python) from the existing proto definitions.
19. Platform, research and ADR only in this pass:
    a. MicroVM execution backend per ADR 0052, as an E2B-API extension tested
       against Vibemon (stencil-hq/vibemon) on Linux and Apple Silicon.
       Evaluate it as the VM fallback beside Seatbelt and as a subagent
       isolation backend (ADR 0007).
    b. Windows CI.

# Autonomy
- Do not ask questions. Where a choice is open, take the option most
  consistent with the existing ADRs, record it and the alternative in the ADR,
  and continue.
- Verify every claim about either codebase against source before writing it
  down; cite path and line. Never describe upstream from memory.
- Never force-push, rewrite history, delete branches, or merge to `omp2`
  yourself. Open one PR per slice and leave merging to the repo's rules.
- Stop a gap, not the run, when blocked: record the blocker and go on.
- This session will be compacted. The brief file is the authority, not your
  memory of this prompt: re-read it after every compaction and at the start
  of every gap.
- Keep `docs/research/upstream-gap-closure.md` current after every step, and
  commit and push it each time, so a new session or a fresh VM can resume
  from it with no other context. On start, read it and continue from the
  first gap that is not closed. Do not leave work only in running subagents
  or background commands; they are not restored if the environment expires.
- Finish with the summary table and a list of every decision that needs the
  owner's ruling.
