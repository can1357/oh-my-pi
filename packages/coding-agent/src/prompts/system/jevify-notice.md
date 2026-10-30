<system-notice>
User message contains **jevify** → bulk classification through the `eval` kernel's `judge_batch()`. You decide once, up front; the judge processes the bulk; you read only what it flags. This overrides the tendency to split the data up and scan it yourself.

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
3. **Judge** — one `judge_batch(units, questions, intent=…)` call hands the whole batch to the host (states `{id: state}` or a list; `state` carries the id, the frozen framing (commit subject, question context), and the content). Drain settled items with `await batch.drain(timeout=…)` across as many cells as needed; tabulate `{id: choice, top_p, extra facts}` from `item.answers`; keep `item.error` rows as their own row.
4. **Escalate** — sort by the escalation rule; `read`/print only those units' diffs; confirm or overturn each with evidence. Exact-match uncertain verdicts against the code (implementation contract, callers) rather than re-judging.
5. **Report** — counts per label, pre-filter removals, truncations, then flagged items grouped by kind with file path + one-line evidence each. Judge output is evidence, not truth: state which verdicts you confirmed by reading.
</workflow>

<judge>
`judge(state, questions)` — awaited; answers `{id: answer}` for a handful of questions over one state.
`judge_batch(states, questions, *, intent=, concurrency=, retries=, min_ok=)` — bulk: the host owns the run (one judge chain, bounded fan-out, one retry per item) and returns a `JudgmentBatch`; `await batch.drain(timeout=…)` pulls `[(key, item)]` settled slices across as many cells as needed (cells time out; the run doesn't). JS: `judgeBatch(states, questions, { intent, … })`, `await batch.drain({ timeout })`.
- `state`: `str` | JSON object | JSON array. Every question sees the same state.
- `{type: "choice", instructions, criteria: {label: rubric, …}}` → `{choice, probabilities, confidence}`.
- `{type: "bool", instructions, criteria?: {true, false}}` → `{bool: P(yes)}`.
- `{type: "score", instructions, criteria: [lowest, …, highest]}` → `{score, probabilities, confidence}`.
- Item failures land in `item.error` and never raise; only a run that dies wholesale (no judge, `min_ok` unmet) raises from `drain()`. `status()`/`results()`/`failed()` snapshot the run; `judge_batch.attach(id)` recovers it after a kernel reset.
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
states = {f: {"file": f, "subject": SUBJECT, "diff": d[:CAP] + ("\n…[truncated]" if len(d) > CAP else "")} for f, d in diffs.items()}
batch = judge_batch(states, QUESTIONS, intent=f"jevify {SHA}")
verdicts, failures = {}, {}
while len(verdicts) + len(failures) < batch.total:
    for key, item in await batch.drain(timeout=30):
        if item.error is not None: failures[key] = item.error
        else: verdicts[key] = item.answers
flag = {f for f, a in verdicts.items() if a["verdict"]["choice"] != "belongs" or a["verdict"]["probabilities"]["belongs"] < 0.7 or a["logic"]["bool"] >= 0.5} | set(failures)
```

**JavaScript:**

```js
// JS kernel: same workflow — define the rubric constants here, then batch.
const SHA = "abc123";
const SUBJECT = "refactor: new tui framework";
const QUESTIONS = {
	verdict: {
		type: "choice",
		instructions: `One file diff from commit '${SUBJECT}'. Does this change belong to that refactor?`,
		criteria: {
			belongs: "Every hunk is required by or mechanically follows from the stated refactor.",
			mixed: "Mostly the refactor, plus at least one hunk changing unrelated behavior.",
			unrelated: "No hunk relates to the stated refactor.",
		},
	},
	logic: { type: "bool", instructions: "Does any hunk change runtime behavior outside the refactor's subsystem (not renames/imports/types)?" },
};
const CAP = 24_000;
// Build `states` with this kernel's tools (glob/read/…), one entry per unit:
// { [file]: { file, subject: SUBJECT, diff: diff.slice(0, CAP) } }
const batch = await judgeBatch(states, QUESTIONS, { intent: `jevify ${SHA}` });
const verdicts = {}, failures = {};
while (Object.keys(verdicts).length + Object.keys(failures).length < batch.total) {
	for (const [key, item] of await batch.drain({ timeout: 30 })) {
		if (item.error !== undefined) failures[key] = item.error;
		else verdicts[key] = item.answers;
	}
}
```

Then print only `diffs[f]` for `f in flag`, confirm each against the code, and report.
</example>

<anti-patterns>
- Reading the first N items "to get a feel" before writing the rubric.
- One question per `judge()` call when several independent questions share a state.
- Looping `judge()` per unit instead of one `judge_batch()` hand-off: cells time out and every call is a bridge round-trip.
- Fanning items to `task` subagents to "review" them: they read; the judge classifies.
- Treating a judge verdict as final without reading the flagged unit.
- Dropping errored or truncated items silently instead of counting and escalating them.
- Vague labels ("bad", "suspicious") instead of one-sentence observable evidence.
</anti-patterns>

<critical>
Rubric frozen before data. Judge classifies the bulk. You read only what it flags. Report counts, then evidence.
</critical>
</system-notice>
