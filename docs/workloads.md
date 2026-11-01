# Workloads

A workload is a YAML file that declares a DAG of steps. `omp workload` executes that graph with **no model in the control loop**: omp plans the waves, expands templates, spawns subagents, and runs argv gates. Worker models still run inside `prompt` steps; they do not decide what runs next.

The runner does not add spawn capability. A `task` batch, an `eval` script, and `omp cleanse` already fan work out through the same subagent primitive. Reach for a workload when the *orchestration* should be a reviewed, rerunnable artifact (cron, CI, a named command) rather than a plan a model invents each turn.

| Reach for | When | Who decides the next step |
| --- | --- | --- |
| Workload YAML (`omp workload`) | The graph is known, should be checked in, and must rerun the same way | The runner |
| A `task` `tasks[]` batch | One-off fan-out inside a conversation | The parent model |
| An `eval` script (`agent()` / `parallel()` / `pipeline()`) | You need loops, branches, or a graph invented at runtime | The script (often model-written) |
| `omp cleanse` | Project diagnostics: discover checkers, then one weighted file-disjoint repair batch | The cleanse loop |

`task` and `eval` remain the right tools for exploratory work. `omp cleanse` is a specialized diagnostic fixer ([`src/cleanse/index.ts`](../packages/coding-agent/src/cleanse/index.ts)), not a general DAG. A workload's value is inspectability: a file you can review in a PR and invoke as `omp workload name` without a model choosing the next node.

## Implementation files

- [`src/workload/spec.ts`](../packages/coding-agent/src/workload/spec.ts) — schema, YAML load, discovery, DAG validation
- [`src/workload/template.ts`](../packages/coding-agent/src/workload/template.ts) — `${...}` expansion
- [`src/workload/runner.ts`](../packages/coding-agent/src/workload/runner.ts) — wave execution, `for_each` fan-out, retries, failure policy
- [`src/workload/index.ts`](../packages/coding-agent/src/workload/index.ts) — `runWorkloadCommand` (list / dry-run / run)
- [`src/commands/workload.ts`](../packages/coding-agent/src/commands/workload.ts) — `omp workload` CLI
- [`src/task/structured-subagent.ts`](../packages/coding-agent/src/task/structured-subagent.ts) — spawn primitive used by every `prompt` step

---

## YAML schema

Version 1 only (`version` omitted → `1`; any other value is rejected). Extra keys are dropped. `name` and every step `id` must match `^[a-z0-9][a-z0-9_-]*$`. `steps` is required and must be non-empty. Exactly one of `prompt` or `run` per step.

### Top-level fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `version` | `number` | No | `1` | Schema version. This omp understands `1` only. |
| `name` | `string` | Yes | — | Workload id. When the file is found by discovery, this must equal the filename stem (`audit-routes.yml` → `name: audit-routes`). |
| `description` | `string` | No | — | Shown in listing and plan output. |
| `defaults` | `object` | No | see below | Per-step defaults folded into every step before execution. |
| `defaults.agent` | `string` | No | `"task"` | Agent definition name for `prompt` steps (bundled `task`, `scout`, `reviewer`, …). |
| `defaults.model` | `string` | No | — | Per-call model selector. Highest precedence; see [Model and effort](#model-and-effort). |
| `defaults.effort` | `"lo" \| "med" \| "hi"` | No | — | Coarse thinking tier, same vocabulary as a `task` item. Omitted → agent-configured selector remains. |
| `defaults.concurrency` | `number` | No | `8` | Positive integer. Caps `for_each` fan-out for a step. |
| `defaults.on_failure` | `"abort" \| "continue"` | No | `"abort"` | What happens after a step exhausts retries. |
| `args` | `object` | No | `{}` | Declared inputs, filled by `--set name=value`. Each value is an object with the keys below. |
| `args.<name>.required` | `boolean` | No | `false` | Missing with no `default` → hard error before the DAG runs. |
| `args.<name>.default` | `string` | No | — | Used when `--set` omits this name. Values are strings (`default: "2"`). |
| `args.<name>.description` | `string` | No | — | Documentation only. |
| `steps` | `array` | Yes | — | Nodes of the DAG. Ids must be unique. |

`--set` is rejected for undeclared names (a typo must not vanish at template time). An optional arg with no default is omitted from the arg map; referencing it is a missing-path error.

### Step fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | `string` | Yes | — | Node id. Unique. Same identifier pattern as `name`. |
| `description` | `string` | No | — | Shown in progress output. |
| `prompt` | `string` | Exactly one of `prompt` / `run` | — | Subagent assignment. Templates expand before spawn. Mutually exclusive with `run`. |
| `run` | `string[]` | Exactly one of `prompt` / `run` | — | Exec-form argv (no shell). Each element is template-expanded, then `Bun.spawn`ed. Empty elements are rejected. Mutually exclusive with `prompt`. |
| `agent` | `string` | No | `defaults.agent` or `"task"` | Agent definition for a `prompt` step. |
| `model` | `string` | No | `defaults.model` | Per-call selector (`provider/model[:level]` or `@role`). **Prompt steps only** — a `run` step that sets `model` is a spec error. |
| `effort` | `"lo" \| "med" \| "hi"` | No | `defaults.effort` | Coarse thinking tier for a `prompt` step. |
| `isolated` | `boolean` | No | `false` | When `true`, the subagent runs in an isolated workspace (same isolation path as `task`). |
| `output_schema` | `object` | No | — | JSON Schema for structured output. The parsed object becomes `${steps.<id>.output}`. **Prompt steps only** — a `run` step that sets `output_schema` is a spec error. |
| `needs` | `string[]` | No | `[]` | Step ids that must succeed before this step runs. Unknown ids and self-dependencies are rejected at load. |
| `for_each` | `string` | No | — | Template expression that must resolve to a list. One invocation per element, bounded by `concurrency`. `${item}` / `${item_index}` are in scope. Allowed on both `prompt` and `run` steps (fanning a checker over a file list is a legitimate shell step). |
| `concurrency` | `number` | No | `defaults.concurrency` or `8` | Positive integer. Caps this step's `for_each` fan-out. `--concurrency` / `-n` overrides it. |
| `retries` | `number` | No | `0` | Extra attempts after a failure (`retries: 1` → two tries). Each `for_each` item retries independently. |
| `on_failure` | `"abort" \| "continue"` | No | `defaults.on_failure` or `"abort"` | After retries are exhausted. See [Execution semantics](#execution-semantics). |

`run` is argv, not a shell string: no pipes, redirects, or globs unless the spawned binary implements them.

## Discovery locations

Discovery is implemented in [`src/workload/spec.ts`](../packages/coding-agent/src/workload/spec.ts) and mirrors [`WATCHDOG.yml`](./advisor-watchdog.md#watchdogyml) ([`src/advisor/watchdog.ts`](../packages/coding-agent/src/advisor/watchdog.ts)): walk from `cwd` up to the git repository root (or the home directory when no repo root is found), plus the user agent dir. Closest wins.

Candidates:

1. Project levels, nearest first: `<dir>/.omp/workloads/*.{yml,yaml}` and `<dir>/workloads/*.{yml,yaml}` at `cwd` and every ancestor up to the stop directory.
2. User level, last: `<active agent dir>/workloads/*.{yml,yaml}` (`~/.omp/agent/workloads/` by default; relocated by `PI_CODING_AGENT_DIR`).
3. An explicit path argument bypasses discovery. A target is treated as a path when it contains a path separator or a `.yml` / `.yaml` extension (`./audit-routes.yml`, `/abs/path.yaml`).

The discovered **name** is the filename stem. If the same stem appears at several levels, the closest project file wins; a project file beats the user file. When a name is loaded, the YAML `name` must equal that stem so the file a name resolves to is unambiguous. An explicit path does not require the stem to match.

`omp workload` with no target lists discovered stems without parsing the files. A file that fails YAML/schema validation errors when selected, not when listed.

## Template expressions

Templates expand in `prompt`, each `run` argv element, and `for_each`. `$${` is an escape: it emits a literal `${` and does not start a reference.

| Expression | Result |
| --- | --- |
| `${args.<name>}` | A resolved `--set` / default string. |
| `${steps.<id>.output}` | The step's result. `prompt` + `output_schema` → parsed object; `prompt` without a schema → yielded text; `run` → JSON-parsed stdout when stdout is a JSON document (trims to `{...}` or `[...]` and parses), otherwise the raw stdout string. A `for_each` step → the array of per-item outputs, in input order. |
| `${steps.<id>.output.<path>}` | A nested field of that value. |
| `${steps.<id>.stdout}` | Raw stdout of a `run` step (always the text, even when `output` was parsed). |
| `${steps.<id>.exit_code}` | Exit code of a `run` step. |
| `${item}` | Current `for_each` element. Hard error outside a `for_each` step. |
| `${item_index}` | Zero-based index of that element. Hard error outside a `for_each` step. |

Array indexing works both ways, and mixed:

```text
${steps.discover.output.files.0}
${steps.discover.output.files[0]}
${steps.audit.output[0].findings[0].message}
```

`for_each` uses the raw value (the list stays a list). It accepts `${steps.discover.output.files}` or the bare path `steps.discover.output.files`. In `prompt` / `run`, strings copy through; numbers, booleans, and `null` stringify (`null` is a real value, not missing); objects and arrays render as compact JSON.

Unknown root, unknown or unfinished step, missing path, unterminated `${`, empty `${}`, or `${item}` / `${item_index}` outside `for_each` is a **hard error at expansion time**. Referencing a step that is not in `needs` (or has not finished) is the unfinished-step error — list it in `needs`.

A `for_each` expression that does not resolve to a list fails that step: fan-out needs a list, so the producing step should declare an `output_schema` with an array property (or, for a `run` producer, print a JSON array to stdout).

## Execution semantics

Load validates the document, folds `defaults`, and plans waves with Kahn's algorithm **before anything runs**. A cycle, a duplicate `id`, an unknown `needs` id, or a self-dependency is a load error.

- **Waves.** `needs` builds the DAG. Each wave is the set of steps whose dependencies have already succeeded. Independent steps in a wave all start together.
- **`for_each`.** When the step becomes ready, the expression is resolved to a list (hard error if it is not one). One invocation per element, in input order, bounded by that step's `concurrency` (CLI `--concurrency` / `-n` overrides). The step's `${steps.<id>.output}` is the array of per-item outputs. Any item that still fails after retries fails the step. `for_each` is allowed on `run` as well as `prompt`.
- **Retries.** `retries: N` means N extra attempts (`0` → one try). Each `for_each` item retries on its own.
- **`on_failure: abort`** (default). After retries are exhausted, later waves are marked `skipped` (`an earlier step failed with on_failure: abort`). In-flight siblings in the current wave still finish.
- **`on_failure: continue`.** The failure is recorded and independent branches still run. **Dependents are not run**, regardless of `on_failure`: a step whose `needs` includes a non-ok step is skipped with `needs "<id>", which did not succeed`. `continue` keeps sibling branches alive; it is not "treat failure as success."
- **Shell gates.** Non-zero exit is a failure. `${steps.<id>.output}` is JSON-parsed when stdout trims to `{...}` or `[...]` and parses (so a `run` step can feed `for_each` with no model in the loop); `${steps.<id>.stdout}` is always the raw text. See [Shell discovery feeding `for_each`](#shell-discovery-feeding-for_each).
- **Prompt steps** go through `runStructuredSubagent` with `keepAlive: false` (one-shot; not parked for `hub` follow-up). Isolation, model, effort, and `output_schema` use that shared path.
- **Shell-only workloads** (every step is `run`) do not create a session. Any `prompt` step creates a persisted parent session so subagent transcripts and artifacts land somewhere inspectable. A JSON ledger `workload-<name>-<runId>.json` is written under that session's artifacts dir whether the run passes or fails.

There is no `if` or `while` in the YAML. `retries` re-attempts a failed step; they do not loop until a checker is green. Put a trailing `run` gate after a repair `prompt` if CI must fail on a dirty tree.

## Model and effort

A step's `model` is the spawn request's own selector, which outranks `task.agentModelOverrides[agentName]` and the agent definition's own `model` list. Role aliases (`@smol`, `@default`) expand through `modelRoles`. A selector that matches no available model fails that spawn at preflight. See [Task agent discovery](./task-agent-discovery.md#model-and-structured-output-precedence).

`effort` is the coarse per-spawn tier the `task` tool accepts: `lo` (lowest supported level), `med` (middle), `hi` (whatever the model tops out at). A `:level` suffix on `model` sets an exact level directly instead. Omitting `effort` leaves model/agent defaults and any `auto` selector untouched.

`output_schema` occupies the same caller `outputSchema` slot as a task item (ahead of agent frontmatter `output` and the parent session schema).

A `prompt` step without its own `model` (and whose agent definition has none) inherits the parent session's active model. The parent itself never prompts a model; it still needs a resolvable one for that fallback.

## CLI

```sh
omp workload
omp workload <name>
omp workload ./path.yml --set target=src/api --dry-run --json -n 4
```

| Flag / arg | Description |
| --- | --- |
| `target` | Workload name (discovery) or path. Omitted → list discovered names. |
| `--set name=value` | Repeatable. Fills declared `args`. Splits on the first `=`. |
| `--dry-run` | Load, resolve args, print the wave plan. Nothing is spawned. Missing required args still fail. |
| `--json` | Machine-readable stdout: `{ "workloads": [...] }` for list, spec+args for dry-run, the run result for execution, `{ "error": "..." }` on failure. Progress otherwise goes to stderr. |
| `--concurrency <n>`, `-n <n>` | Overrides `for_each` concurrency on every step. |

Exit code `0` on a successful list, dry-run, or run; `1` on validation errors or a failed run.

## Worked examples

### Fan-out audit

`.omp/workloads/audit-routes.yml` — discover files, audit each, then rank the array.

```yaml
version: 1
name: audit-routes
description: Discover route handlers, audit each file, rank the findings
defaults:
  agent: scout
  effort: med
  concurrency: 8
  on_failure: abort
args:
  target:
    required: true
    description: Directory to audit (e.g. src/routes)
  depth:
    default: "2"
    description: How deep discovery should walk
steps:
  - id: discover
    description: List route-handler files under the target
    agent: scout
    model: "@smol"
    effort: lo
    prompt: |
      List every route-handler file under ${args.target}, walking at most
      ${args.depth} directories deep. Return only files that define HTTP handlers.
    output_schema:
      type: object
      required: [files]
      properties:
        files:
          type: array
          items:
            type: string

  - id: audit
    description: Audit one route file
    needs: [discover]
    for_each: "${steps.discover.output.files}"
    concurrency: 4
    agent: reviewer
    effort: hi
    prompt: |
      Audit ${item} (file ${item_index}) for missing authentication checks,
      unvalidated input, and leaked secrets. Cite file:line.
    output_schema:
      type: object
      required: [file, findings]
      properties:
        file:
          type: string
        findings:
          type: array
          items:
            type: object
            required: [severity, message]
            properties:
              severity:
                type: string
                enum: [high, med, low]
              message:
                type: string
              line:
                type: integer

  - id: rank
    description: Merge and rank all per-file findings
    needs: [audit]
    agent: task
    model: "openai/gpt-5.4:high"
    prompt: |
      Per-file audit results (JSON array):
      ${steps.audit.output}

      Deduplicate, rank by severity, and produce one summary with residual risks.
```

```sh
omp workload audit-routes --set target=src/routes
```

### Shell discovery feeding `for_each`

A `run` step that prints a JSON array (or object) has that value as `${steps.<id>.output}`, so a later `for_each` can fan a checker over the list with no model in the control loop. `${steps.<id>.stdout}` stays the raw text.

```yaml
version: 1
name: lint-listed
description: List files from a script, then run eslint on each
steps:
  - id: list
    description: Print a JSON array of paths
    run: ["node", "scripts/list-changed.mjs"]

  - id: lint
    description: Lint one file
    needs: [list]
    for_each: "${steps.list.output}"
    concurrency: 4
    run: ["npx", "eslint", "${item}"]
```

If `scripts/list-changed.mjs` writes `["src/a.ts","src/b.ts"]` to stdout, `list.output` is that array and `lint` spawns `npx eslint src/a.ts` and `npx eslint src/b.ts`. If the script instead prints `{"files":["src/a.ts","src/b.ts"]}`, point `for_each` at `${steps.list.output.files}`.

### Fix until green

`.omp/workloads/fix-until-green.yml` — a repair `prompt` with `retries`, then a shell `run` gate. `retries` re-spawns the repair agent if *it* fails; the agent is told to iterate on `tsc` internally. The trailing `run` is what CI fails on. This is not a YAML `while`.

```yaml
version: 1
name: fix-until-green
description: Repair type errors, then gate on a clean tsc
defaults:
  agent: task
  effort: hi
  on_failure: abort
args:
  pkg:
    default: "."
    description: Package directory to typecheck
steps:
  - id: repair
    description: Run tsc and fix every reported error
    agent: task
    model: "anthropic/claude-sonnet-4-5:high"
    retries: 2
    prompt: |
      In ${args.pkg}, run `npx tsc --noEmit -p ${args.pkg}` and fix every
      reported error. Repeat internally until tsc is clean or you cannot make
      progress. Do not change public APIs unless the types require it.

  - id: typecheck
    description: Gate — tsc must be clean
    needs: [repair]
    run: ["npx", "tsc", "--noEmit", "-p", "${args.pkg}"]
```

```sh
omp workload fix-until-green --set pkg=packages/coding-agent
```

A failing `run` with `on_failure: continue` still **skips** dependents (`needs "typecheck", which did not succeed`). Do not write "tsc fails, then a repair step `needs` it" — the repair will be skipped. Put the checker after the repair, or fold the checker into the repair prompt.

### Cross-model review

`.omp/workloads/cross-model-review.yml` — the same assignment on two model families in one wave, then a third step that weighs both.

```yaml
version: 1
name: cross-model-review
description: Independent reviews on two model families, then a judge
defaults:
  agent: reviewer
  effort: hi
  on_failure: abort
args:
  assignment:
    required: true
    description: The change or question to review
steps:
  - id: anthropic-pass
    description: Review on Anthropic
    model: "anthropic/claude-sonnet-4-5:high"
    prompt: |
      ${args.assignment}

  - id: openai-pass
    description: Review on OpenAI
    model: "openai/gpt-5.4:high"
    prompt: |
      ${args.assignment}

  - id: weigh
    description: Weigh both reviews
    needs: [anthropic-pass, openai-pass]
    agent: task
    model: "google/gemini-2.5-pro"
    effort: med
    prompt: |
      Two independent reviews of the same assignment.

      Anthropic:
      ${steps.anthropic-pass.output}

      OpenAI:
      ${steps.openai-pass.output}

      Weigh agreements and disagreements. Produce one verdict with residual risks.
```

```sh
omp workload cross-model-review --set assignment="Review the auth changes in src/api/"
```

`anthropic-pass` and `openai-pass` have no `needs`, so they run in the same wave. `weigh` waits for both.

## Claude Code workflows

Claude Code's dynamic workflows live in `.claude/workflows/*.js`, export a `meta` object (`name`, `description`), and are invoked as `/name`. The body is imperative JavaScript: `agent()`, `pipeline()`, `parallel()`, `phase()`, plus an `args` global. Claude writes the script; a runtime executes it. Docs: <https://code.claude.com/docs/en/workflows.md>.

omp's equivalent of that **script** is already the [`eval` prelude](./tools/eval.md) (`agent()`, `parallel()`, `pipeline()`, `phase()` in [`src/eval/agent-bridge.ts`](../packages/coding-agent/src/eval/agent-bridge.ts) and [`src/eval/concurrency-bridge.ts`](../packages/coding-agent/src/eval/concurrency-bridge.ts)). A workload is the other shape: declarative YAML, schema-checked and cycle-checked **before** anything spawns, with no `if` / `while` in the file. Use `eval` when the graph has to be a program; use a workload when the graph should be data.

## Notes

- No model in the control loop is a constraint, not a feature toggle. Runtime branching beyond the declared DAG does not exist; approximate a loop with a repair `prompt` that iterates internally plus a trailing `run` gate, or write `eval`.
- A dependent of a failed step is skipped with `needs "<id>", which did not succeed`, independent of that dependency's `on_failure`. `continue` only keeps sibling branches alive.
- `run` is exec-form argv. There is no shell. `model` and `output_schema` are illegal on `run` steps; `for_each` is allowed.
- `${steps.<id>.stdout}` and `${steps.<id>.exit_code}` exist only for `run` steps. Referencing them on a `prompt` step is a missing-path error.
- Isolated `prompt` steps follow the same git-repo / backend rules as [`task` isolation](./tools/task.md).
- Prompt-step / `for_each` concurrency is the fan-out cap (default 8). Independent steps in a wave are not themselves capped by that number; they all start.
- Discovery closest-wins is by **filename stem**, then the YAML `name` must match that stem. Rename both or pass an explicit path.
- Listing does not parse files. Broken YAML shows up in `omp workload` and fails when you run it.
- `keepAlive: false`: finished `prompt` steps are not idle peers for `hub` follow-up. Read transcripts via the session artifacts / ledger.
- Worker `prompt` steps still spend tokens. The runner only removes the orchestrator model.
