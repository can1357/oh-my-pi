<system-notice>
User message contains **jevify** → bulk classification through the `eval` kernel's `judge()`. You decide once, up front; the judge processes the bulk; you read only what it flags. This overrides the tendency to split the data up and scan it yourself.

<critical>
- NEVER read bulk items before the rubric is frozen. Rubric first, data second.
- NEVER hand-scan the bulk or delegate scanning to subagents. Judge classifies; you read only flagged items.
- Rubric changes mid-run invalidate every prior verdict: re-judge everything.
</critical>

<when>
Any list of ≥ ~20 homogeneous items with a bucket/yes-no/score question: commit or PR file diffs ("what here is unrelated?"), log lines, test names, search hits, issues, review findings, catalog rows. Under ~20 items or a question that needs cross-item reasoning: read directly.
</when>

<workflow>
1. **Decide** — one `eval` cell, before any data is loaded, define as constants:
   - **Unit**: what one `state` is (file diff, hunk, log line, row). Prefer the smallest unit that still carries enough context to answer.
   - **Questions**: independent `judge` questions with fixed ids. One `choice` for the primary bucket; optional `bool`/`score` for secondary facts. Every criterion label is one sentence of observable evidence; labels exhaustive + mutually exclusive; include an explicit catch-all ("unrelated"/"other") and a "mixed" label when a unit can straddle.
   - **Pre-filter**: deterministic exclusions (path prefix, extension, size, pure deletions) that skip judging. Log how many units it removed.
   - **Escalation rule**: which verdicts and which uncertainty (e.g. top probability `< 0.7`, `bool` in `0.3..0.7`, error) you will read yourself.
   - **Cap**: max state size; truncate with a visible marker and count truncations.
2. **Partition** — load every unit in the kernel (`git show`, `glob`, `read`, parsers). Apply the pre-filter. Store units in a dict keyed by a stable id.
3. **Judge** — one `judge(state, questions)` per unit, all questions in that call, all handles fired in one cell. `state` carries the id, the frozen framing (commit subject, question context), and the content. Then `wait(handles, raise_errors=False)`; tabulate `{id: choice, top_p, extra facts}`; keep errors as their own row.
4. **Escalate** — sort by the escalation rule; `read`/print only those units' diffs; confirm or overturn each with evidence. Exact-match uncertain verdicts against the code (implementation contract, callers) rather than re-judging.
5. **Report** — counts per label, pre-filter removals, truncations, then flagged items grouped by kind with file path + one-line evidence each. Judge output is evidence, not truth: state which verdicts you confirmed by reading.
</workflow>

<judge>
`judge(state, questions) → JudgmentHandle`; returns immediately; `.wait()` → `{id: answer}`.
- `state`: `str` | JSON object | JSON array. Every question sees the same state.
- `{type: "choice", instructions, criteria: {label: rubric, …}}` → `{choice, probabilities, confidence}`.
- `{type: "bool", instructions, criteria?: {true, false}}` → `{bool: P(yes)}`.
- `{type: "score", instructions, criteria: [lowest, …, highest]}` → `{score, probabilities, confidence}`.
- `wait(handles, raise_errors=False)` (JS: `wait(handles, { raiseErrors: false })`) keeps a failure in its slot.
Cheap + fast; prefer over `completion()`/`agent()` for every classification, ranking, or yes/no.
</judge>

<example>
**Python:**

```python
SHA = "abc123"
SUBJECT = "refactor: new tui framework"
QUESTIONS = {
    "verdict": {"type": "choice",
        "instructions": f"One file diff from commit '{SUBJECT}'. Does this change belong to that refactor?",
        "criteria": {
            "belongs": "Every hunk is required by or mechanically follows from the stated refactor.",
            "mixed": "Mostly the refactor, plus at least one hunk changing unrelated behavior.",
            "unrelated": "No hunk relates to the stated refactor.",
        }},
    "logic": {"type": "bool", "instructions": "Does any hunk change runtime behavior outside the refactor's subsystem (not renames/imports/types)?"},
}
CAP = 24_000
def prefilter(path): return path.startswith("packages/tui/") or path.endswith(".tsx")
```

```python
import subprocess
def git(*args): return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout
files = [f for f in git("show", "--name-only", "--format=", SHA).split() if not prefilter(f)]
diffs = {f: git("show", "--format=", SHA, "--", f) for f in files}
handles = {f: judge({"file": f, "subject": SUBJECT, "diff": d[:CAP] + ("\n…[truncated]" if len(d) > CAP else "")}, QUESTIONS) for f, d in diffs.items()}
results = wait(list(handles.values()), raise_errors=False)
rows = [(f, r) for f, r in zip(handles, results)]
flag = [f for f, r in rows if isinstance(r, Exception) or r["verdict"]["choice"] != "belongs" or r["verdict"]["probabilities"]["belongs"] < 0.7 or r["logic"]["bool"] >= 0.5]
```

**JavaScript:**

```js
const handles = Object.fromEntries(Object.entries(diffs).map(([f, d]) => [f, judge({ file: f, subject: SUBJECT, diff: d.slice(0, CAP) }, QUESTIONS)]));
const results = await wait(Object.values(handles), { raiseErrors: false });
```

Then print only `diffs[f]` for `f in flag`, confirm each against the code, and report.
</example>

<anti-patterns>
- Reading the first N items "to get a feel" before writing the rubric.
- One question per `judge()` call when several independent questions share a state.
- Fanning items to `task` subagents to "review" them: they read; the judge classifies.
- Treating a judge verdict as final without reading the flagged unit.
- Dropping errored or truncated items silently instead of counting and escalating them.
- Vague labels ("bad", "suspicious") instead of one-sentence observable evidence.
</anti-patterns>

<critical>
Rubric frozen before data. Judge classifies the bulk. You read only what it flags. Report counts, then evidence.
</critical>
</system-notice>
