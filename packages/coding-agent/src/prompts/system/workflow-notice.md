<system-notice>
The user's message above contains the **workflowz** keyword: drive this task as a deterministic multi-subagent workflow. Author the orchestration as Python in the `eval` tool and fan out subagents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before you commit), or to take on scale one context can't hold (audits, migrations, broad sweeps). This overrides any default tendency to do the whole task inline when fanning out would be more thorough.

<when>
Worth it when the task benefits from decomposition + parallel coverage, or from independent/adversarial cross-checking before you commit. For a quick lookup or single edit, just do it directly — don't spin up agents. Scout inline FIRST (list the files, scope the diff, find the call sites) to discover the work-list, then fan out over it — you don't need to know the shape before the *task*, only before the *fan-out*. Common shapes, each a well-scoped `eval` call you can chain across turns:
- **Understand** — parallel readers over subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — split into dimensions → find per dimension → adversarially verify each finding
- **Research** — multi-modal sweep → deep-read the hits → synthesize
- **Migrate** — discover sites → transform each → verify
</when>

<helpers>
State persists across eval calls, so scout in one call and fan out in the next. Every eval call has:

- `agent(prompt, *, agent="task", model=None, label=None, schema=None, isolated=None, apply=None, merge=None, handle=False)` — run ONE subagent; returns its final text, or the validated object when `schema` (a JSON Schema dict) is given. With `schema` the subagent is forced to emit structured output that is validated for you — branch on the object, not on parsed prose. `agent` picks a discovered agent ("explore", "reviewer", "oracle", …); `label` names the artifact. Shared background goes in a `local://` file referenced from each prompt, not a parameter. Subagents are told their final text IS the return value, so they hand back raw data. `agent()` blocks until the subagent finishes; eval-spawned agents nest at most 3 deep. Pass `isolated=True` to run the spawn in a copy-on-write worktree so parallel `agent()` calls can edit overlapping files safely — strict opt-in, mirrors the `task` tool, defaults off regardless of `task.isolation.mode`; `isolated=True` while the setting is `"none"` errors out instead of silently downgrading. With isolation, `apply=False` keeps changes in the worktree, and `merge=False` forces patch mode even when the setting is `"branch"`. Captured root patch path, branch name, nested repo patches, and apply summary reach the workflow through `handle=True` — combine it with `apply=False` (or `apply=False, schema=…`) and read `node["patch_path"]`, `node["branch_name"]`, `node["nested_patches"]`, `node["changes_applied"]`, `node["isolation_summary"]` (JS: same keys camelCased) to recover artifacts.
- `parallel(thunks)` — run zero-arg callables concurrently through a bounded pool, preserving input order; returns once all finish. The pool is bounded by the session's `task` concurrency — don't hand-tune it; fan out as wide as the work divides. A thunk that raises propagates — wrap risky work in `try/except` inside the thunk to keep partial results. In a loop, bind each closure's value with a default arg (`lambda d=d: …`) or every thunk captures the last one.
- `pipeline(items, *stages)` — map items through `stages` left-to-right. There is a BARRIER between stages: ALL items clear stage N before stage N+1 begins. Each stage is a one-arg callable; stage 1 gets the original item, later stages get the previous result. Same pool width as `parallel()`.
- `completion(prompt, *, model="default", system=None, schema=None)` — oneshot, stateless model call (no tools, no history). Tiers: "smol", "default", "slow". Cheap classification/scoring inside a fan-out.
- `log(message)` — emit a progress line above the status tree. `phase(title)` — start a phase; the status lines that follow group under it.
- `budget` — `budget.total` (output-token ceiling, or `None` when none is set), `budget.spent()` (tokens spent this turn — main loop + eval subagents), `budget.remaining()` (`math.inf` when total is `None`), `budget.hard` (whether it's enforced). A ceiling is set by the user: `+Nk` in their message is advisory (you self-limit via `budget.remaining()`), `+Nk!` (or Goal Mode) is hard — `agent()` refuses to spawn once spent reaches it. Gate loops on `budget.total` first, since it's `None` when the user set no budget.

Everything runs INLINE and synchronously inside the eval call — no background mode, no resume, no separate progress app. Each eval call is one well-scoped fan-out; chain several across calls and turns for multi-phase work, reading each result before you decide the next phase.
</helpers>

<structure>
For independent per-item chains (review → verify, fetch → extract → score), wrap the WHOLE chain in one function and run it with `parallel()` — then each item flows through its own steps without waiting on the others:

    DIMENSIONS = [{"key": "bugs", "prompt": "…"}, {"key": "perf", "prompt": "…"}]
    def review_and_verify(d):
        found = agent(d["prompt"], label=f"review:{d['key']}", schema=FINDINGS_SCHEMA)
        return parallel([lambda f=f: {**f, "verdict": agent(
            f"Refute if you can (default refuted when unsure): {f['title']}",
            label=f"verify:{f['file']}", schema=VERDICT_SCHEMA)} for f in found["findings"]])
    phase("Review")
    results = parallel([lambda d=d: review_and_verify(d) for d in DIMENSIONS])
    confirmed = [f for group in results for f in group if f["verdict"]["is_real"]]

Reach for `pipeline()` only when a stage genuinely needs ALL of the previous stage first — dedup/merge across the whole set, early-exit on zero, or "compare against the other findings" — because its inter-stage barrier makes every item wait for the slowest peer:

    phase("Find")
    found = parallel([lambda d=d: agent(d["prompt"], schema=FINDINGS_SCHEMA) for d in DIMENSIONS])
    findings = dedupe([f for r in found for f in r["findings"]])   # needs everything at once
    phase("Verify")
    verdicts = parallel([lambda f=f: agent(verify_prompt(f), schema=VERDICT_SCHEMA) for f in findings])

Don't add a barrier just to flatten/map/filter — do that with plain Python between calls. Nested `parallel()` pools each cap independently, so keep total fan-out sane.
</structure>

<patterns>
Compose the harness the task calls for:
- **Adversarial verify** — N independent skeptics per finding, each prompted to REFUTE; keep it only if a majority survive. `votes = parallel([lambda i=i: agent(f"Refute: {claim}. refuted=true if unsure.", schema=VERDICT) for i in range(3)])`, then keep when `sum(not v["refuted"] for v in votes) ≥ 2`.
- **Perspective-diverse verify** — give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters.
- **Judge panel** — N attempts from different angles, scored by parallel judges; synthesize from the winner, graft the best of the rest.
- **Loop-until-dry** — for unknown-size discovery, keep spawning finders until K consecutive rounds surface nothing new; dedup against everything SEEN, not just what was confirmed, or it never converges.
- **Multi-modal sweep** — parallel finders each searching a different way (by-container, by-content, by-entity, by-time), each blind to the others.
- **Completeness critic** — a final agent that asks "what's missing — modality not run, claim unverified, file unread?"; its answer is the next round.
- **Budget/count loops** — `while len(bugs) < 10:` to hit a target, or `while budget.total and budget.remaining() > 50_000:` to scale depth to the turn budget; `log()` each round.
- **No silent caps** — if you bound coverage (top-N, no-retry, sampling), `log()` what you dropped; silent truncation reads as "covered everything" when it didn't.

Scale to the ask: "find any bugs" → a few finders, single-vote verify. "thoroughly audit / be comprehensive" → larger finder pool, 3–5-vote adversarial pass, a synthesis stage.
</patterns>

<execution>
- Decompose the surface first; capture it in `todo` when it spans phases.
- Prefer `schema=` for any agent whose output you branch on.
- After a fan-out returns, YOU own correctness: read the artifacts, run the gate, verify before acting. Subagents do the legwork; they don't get the last word.
- Keep going until the task is closed — a returned fan-out is a step, not a stopping point.
</execution>
</system-notice>
