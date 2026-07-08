# Architecture

## Request lifecycle

```text
request
  -> feature extraction
  -> rule matching
  -> learned-score overlay
  -> objective scorer
  -> route decision
  -> execution by host / OMP / caller
  -> validation
  -> fallback or accept
  -> telemetry
  -> offline analysis / policy updates
```

## Components

| Component | Responsibility |
|---|---|
| `features.ts` | Converts request text, metadata, attachments, user prefs, and runtime state into a feature vector. |
| `policy.ts` | Applies guardrail rules and objective-weighted scoring. |
| `learned.ts` | Adds optional linear model deltas for data-driven routing. |
| `validation.ts` | Checks JSON, schemas, required fields, regexes, non-empty outputs, and safety hints. |
| `telemetry.ts` | Writes JSONL records for decisions, validation, fallbacks, and outcomes. |
| `extension.ts` | Bridges the router into OMP tools, commands, and input lifecycle hooks. |
| `cli.ts` | Lets you test decisions and validators outside OMP. |

## Design principles

- Model names live in config, not business logic.
- Rules are explicit and explainable.
- Learned routing is optional and constrained by rules.
- Fallback chains are returned with every decision.
- Validation is part of routing, not an afterthought.
- Telemetry records enough context to tune the policy later without storing full prompts by default.

## Data flow

1. Caller sends a `RequestInput`.
2. `extractFeatures()` estimates tokens, task type, modality, complexity, safety sensitivity, and user/runtime preferences.
3. `findMatchingRules()` identifies force rules and soft route preferences.
4. `scoreCandidates()` scores all compatible model profiles.
5. `decideRoute()` selects the top route and returns fallbacks plus a validation plan.
6. Caller executes against the selected model.
7. `validateOutput()` determines whether to accept, repair, retry, escalate, or block.
8. Telemetry is written to JSONL for offline reporting.

## Where to add production integrations

- Provider invocation: keep outside this package or add a `providers/` layer.
- Online learned policy: replace or extend `learned.ts` with a bandit/ranking service.
- Dashboards: consume `.llm-router/telemetry.jsonl` or forward records to your observability stack.
- A/B tests: add a strategy ID to telemetry metadata and use separate config files per strategy.

## Tool-use capture extension

This variant adds a `tool-capture` component between tool execution and telemetry storage.

```text
Tool runtime / OMP hook
  ↓
ToolUseCaptureLayer
  ↓
redaction + payload snapshotting
  ↓
contextSummary generation
  ↓
.llm-router/tool-use.jsonl
  ↓
tool-routing training export
```

The capture layer is separate from model routing so it can be used to train a future tool router without coupling it to the current model router. Captured records contain compact features and labels rather than raw context-heavy transcripts.
