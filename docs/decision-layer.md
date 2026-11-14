# Decision layer

The decision layer asks the judge small, bounded questions on the agent's behalf before a turn starts, and turns the answers into context the main model receives with the user's request. It never replaces the main model, rewrites the cacheable system prefix per turn, grants permissions, or runs anything. Every feature has a policy fallback: when the judge is unavailable, slow, or unsure, the turn proceeds as it would without the feature.

**Nothing is on by default.** `decision.backend` and every feature mode default to `off`, and setting only the backend enables no feature.

```sh
omp config set decision.backend judge        # or: deterministic (offline, exact names only)
omp config set decision.skills.mode suggest  # off | shadow | suggest | automatic
```

The decision settings are config-file only; there is no settings-panel section.

## Backends

| `decision.backend` | Behavior                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`              | Every feature is off.                                                                                                                                                                                                                                                                                                                                                                      |
| `deterministic`    | Local only: no model, network, or credential. Answers only what code can (explicitly named items); semantic questions fall back.                                                                                                                                                                                                                                                           |
| `judge`            | Asks the native judge the `judge` model role resolves to (see [Settings](./settings.md)), with its credentials, fallback chain, attempt timeout, answer cache, and session usage ledger. Policies gate on calibrated probabilities, so a prompted chat or on-device model never stands in: without a native judge first in the chain, features fall back as if the judge were unavailable. |

## Modes

Each feature has its own mode:

- `off`: no decision work.
- `shadow`: evaluate off the turn's critical path and record the outcome for `/decision status`; nothing reaches the model.
- `suggest`: deliver names as advice at the conversation tail.
- `automatic`: also load what was selected (for skills, their bodies).

## Skills

`decision.skills.mode` lets the judge pick which loaded skills a user request needs. It runs once per top-level user task (a typed prompt or a user-invoked `/skill:<name>`), never for subagents, injected messages, or bare greetings.

1. **Retrieval.** Local BM25 over skill names and descriptions picks at most 64 non-hidden candidates; terms shared by more than a quarter of the catalogue do not count. A follow-up such as "do that" or "go ahead" also retrieves against a bounded, labeled excerpt of earlier messages (at most four, 1,500 characters each), which the judge sees only to resolve the reference.
2. **Relevance.** One judgment asks two applicability gates (does the request act on the user's system; would a documented procedure help) and one independent relevance question per candidate. Both gates must reach 0.35 and a candidate 0.7; at most three advance.
3. **Fit.** A second judgment asks whether each survivor's first 700 characters of body fit the request; a candidate needs 0.7.

Both judgments share `decision.skills.deadlineMs` (default 4,000 ms). Explicitly named skills (`/skill:<name>`, `skill://<name>`) are always selected, and every selected skill brings its `requiresSkills` closure. The thresholds are experimental policy constants, not measured accuracy. With the `deterministic` backend, only skills the request names (`/skill:<name>`, or the name as words: "the release notes skill") are selected.

The result is one hidden `decision-skill-hint` message delivered with the request:

```text
<skill_relevance>
Relevant: postgres-migrations. Ignore if it does not fit.
</skill_relevance>
```

In `automatic` mode the selected bodies are also delivered, in the same non-user `skill-prompt` form as autoloaded skills, before the hint. A body already in the active context is not loaded again; after compaction removes it, a later selection loads it again. Loading is all-or-nothing within 64 KiB, 32 skills, and 1 s; an unreadable file or an exceeded bound loads nothing and leaves the hint. Loading a body does not run a skill's scripts or claim a user invocation.

### Frontmatter

Two `SKILL.md` frontmatter fields feed the decision layer:

- `alwaysApply: true` — listed and preloaded under the progressive catalogue (below); otherwise metadata.
- `requiresSkills: [name, ...]` (YAML `requires-skills`) — exact names of skills selected and loaded alongside this one. Missing names or cycles disable dependency expansion and the progressive catalogue.

### Progressive catalogue

```sh
omp config set decision.skills.variant progressive
```

With skills mode `suggest` or `automatic`, the main agent's system prompt lists only `alwaysApply: true` skills and their `requiresSkills` closure, plus short discovery guidance, instead of every skill. The listed skills' bodies are preloaded with each user task. Every other skill stays loaded and reachable through hints, `/skill:<name>`, and `skill://<name>`. When the judge cannot answer, the hint lists up to five unverified local matches instead; when nothing matches, it points at search. An invalid `requiresSkills` graph keeps the full roster. Changing the variant rebuilds the system prompt like other prompt settings.

Hidden skills (`hide: true`, `disable-model-invocation: true`, or matched by `skills.manualSkills`) are never listed or autoloaded, even when an `alwaysApply` or selected skill requires them: the dependency edge is dropped (along with anything reachable only through it), so the model never pulls in a skill it must not invoke on its own. They remain available through `/skill:<name>` and `skill://<name>`.

While the progressive catalogue is active, the agent searches the full catalogue with `read`; otherwise bare `skill://` is not a catalogue, since the system prompt already lists every non-hidden skill:

- `skill://` pages every non-hidden skill by name.
- `skill://?q=<query>` searches names and descriptions locally.
- `limit` (1–100, default 50) sets the page size; follow `skill://?cursor=<nextCursor>` (keep `q`) until `coverageComplete` is true. A cursor is rejected once the catalogue or query changes.

## `/decision status`

Shows the backend, whether a native judge is available, each feature's mode and deadline, the skills variant (and why progressive falls back, if it does), and this session's last 20 decisions: outcome reason, candidate count, latency, and selected names. Records never include request text or skill bodies, and are not persisted.

## Settings

| Key                          | Default  | Meaning                                                 |
| ---------------------------- | -------- | ------------------------------------------------------- |
| `decision.backend`           | `off`    | `off`, `deterministic`, or `judge`; `off` disables all. |
| `decision.skills.mode`       | `off`    | `off`, `shadow`, `suggest`, or `automatic`.             |
| `decision.skills.variant`    | `roster` | `roster` or `progressive` system-prompt skill listing.  |
| `decision.skills.deadlineMs` | `4000`   | Total judge budget per selection (1–30000 ms).          |
| `decision.tools.mode`        | `off`    | `off`, `shadow`, `suggest`, or `automatic`.             |
| `decision.tools.deadlineMs`  | `4000`   | Total judge budget per tool preflight (1–30000 ms).     |

## Tools

`decision.tools.mode` picks which tools a user task needs before the main model's first request and delivers their documentation with it. It never changes the native tool array, hides tools, generates arguments, or runs a tool.

```sh
omp config set decision.backend judge
omp config set decision.tools.mode automatic
```

- **Candidates.** Every enabled `xd://` device: omp's own discoverable tools and the tools of connected MCP servers that omp mounts there (each judged with its server name). Top-level tools are not candidates; their schemas are already in every request. Preflight needs `read` and `write`, the device transport, and runs after pending MCP discovery so newly connected servers count.
- **Selection.** Local BM25 picks at most 64 candidates by name, description, and required parameter names. One judgment first asks whether the task needs any of these tools at all (calling one or needing its parameters, rather than conversation, explanation, or work the top-level tools cover); below 0.35 nothing is selected and the outcome is `not_needed`. Otherwise it asks an independent relevance Noul per candidate (0.7) and whether the shortlist covers the task (0.7, else `insufficient`); at most eight are selected, and `none_relevant` means none cleared the bar. Tools the request names explicitly, as `xd://<name>` or a backticked exact name, are always selected (a bare word such as `debug` is not); the `deterministic` backend selects only those.
- **Delivery.** `suggest` sends a hidden `tool_relevance` hint naming the selection. `automatic` sends each selected device's full docs as a `decision-tool-contract` message (at most 16 KiB each; larger ones are omitted, never truncated, and named in the hint instead). A contract already in context with the same schema revision is not sent again. Skill bodies and tool contracts share one 64 KiB budget per task. `shadow` ranks after the turn starts and only records the outcome.
- **Budget.** `decision.tools.deadlineMs` (default 4,000 ms) bounds the judgment, which runs concurrently with skill selection.
