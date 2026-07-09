# Routing Policy

## Objectives

The policy optimizes a weighted utility:

```text
score = quality_weight * model_quality
      + latency_weight * normalized_latency
      + cost_weight * normalized_cost
      + safety_weight * model_safety
      + task_fit_bonus
      + rule_bonus
      + learned_delta
```

The default weights are:

```json
{
  "quality": 0.45,
  "latency": 0.20,
  "cost": 0.20,
  "safety": 0.15
}
```

Weights are normalized automatically if they do not sum to 1.

## Rules

Rules are guardrails and high-priority preferences. A force rule overrides scoring when the target model is compatible.

Example:

```json
{
  "name": "safety-sensitive",
  "priority": 100,
  "when": { "minSafetySensitivity": 0.45 },
  "route": {
    "model": "safe",
    "fallback": ["quality", "balanced"],
    "force": true,
    "reason": "safety-sensitive request"
  }
}
```

Step-aware rules can match metadata passed as `request.metadata.stepContext`.
These fields are normalized once and shared by feature extraction and telemetry:

```json
{
  "name": "high-risk-agent-step",
  "priority": 92,
  "when": { "stepRisk": "high" },
  "route": {
    "model": "quality",
    "fallback": ["coding", "balanced"],
    "force": true,
    "reason": "high-risk agent step"
  }
}
```

Supported step predicates include `stepKind`, `stepRisk`, `irreversible`,
`minRecentFailures`, `lastVerifier`, `minEscalationCount`, and
`estimatedCacheHit`. Use these for trajectory-aware escalation; keep broad task
classification and safety policy on the existing task/safety predicates.

## Learned overlay

The learned policy is intentionally simple: a linear score delta by model.

```json
{
  "learned": {
    "enabled": true,
    "intercept": 0,
    "modelWeights": {
      "quality": {
        "task.coding": 0.15,
        "complexity": 0.25
      },
      "fast": {
        "preference.speed": 0.2,
        "tokens.total.log": -0.1
      }
    },
    "minConfidenceToOverride": 0.18
  }
}
```

Use telemetry to train or hand-tune these weights. Keep hard safety and compatibility rules outside the learned layer.

## Validation-driven fallback

Every decision includes a validation plan. Typical flow:

1. Run selected model.
2. Validate result.
3. If validation fails:
   - repair for JSON/schema failures
   - retry same model for transient/incomplete output
   - escalate for safety-sensitive or repeated failures
   - block when unsafe output is detected
4. Log validation and fallback records.

## Tuning loop

Use JSONL telemetry to answer:

- Which task types frequently escalate?
- Which models fail schema validation?
- Where are expensive models overused?
- Where do small models succeed reliably?
- Which runtime conditions correlate with failures?

Then adjust:

- objective weights
- model cost/latency/quality estimates
- rule thresholds
- learned deltas
- fallback order

## Tool-routing cross-training data

Model routing and tool routing should be trained separately. Model routing decides which LLM profile should handle the turn. Tool routing decides whether the agent should call a tool, which tool to call, and how much of the result should remain in context.

This package records tool-use traces with `ToolUseCaptureLayer` and exports them using:

```bash
node dist/cli.js tool-export --output .llm-router/tool-routing-training.jsonl
```

Use the exported examples to train a small tool-router model or ranker that optimizes:

- correct tool selection
- avoiding unnecessary tool calls
- reducing retained context via summaries
- escalating from stale/failed tool routes to better tools
- preserving useful evidence while dropping raw payloads
