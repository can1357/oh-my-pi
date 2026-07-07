# Inference Acceleration (experimental)

The acceleration module in `@pk-nerdsaver-ai/pi-agent-core/acceleration` adds
optional latency optimizations in front of the standard `streamSimple` path.
The current release ships the orchestration surface and a baseline-equivalent
fallback. Exact token-level speculative decoding is **not** available against
any of the providers in this repo (no next-token logprobs in the public API),
so `token_speculative` falls back to baseline. Lookahead reasoning and the
combined mode are wired through the same fallback boundary, so they always emit
a target-model response.

## Modes

| Mode                   | Behavior                                                                                       | Default               |
| ---------------------- | ---------------------------------------------------------------------------------------------- | --------------------- |
| `baseline`             | Existing target-model-only path.                                                               | yes                   |
| `token_speculative`    | Draft → target verification. With no verifier support, falls back to baseline.                | off                   |
| `lookahead_reasoning`  | Draft proposes compact semantic steps, verifier accepts/rejects, target runs once.             | off                   |
| `combined`             | Lookahead reasoning at the step level + token speculation inside target expansions.             | off                   |

## Configuration

Settings live under the `acceleration` group:

```yaml
acceleration:
	enabled: false # default off, do not enable without testing
	mode: baseline # baseline | token_speculative | lookahead_reasoning | combined
	draft_model: "" # empty → caller-supplied draft model
	target_model: "" # empty → use the active session model (must share provider)
	verifier_model: "" # empty → use the target model
	gamma_initial: 4
	gamma_min: 1
	gamma_max: 8
	acceptance_rate_increase_threshold: 0.75
	acceptance_rate_decrease_threshold: 0.55
	lookahead_steps_initial: 3
	lookahead_steps_max: 5
	enable_streaming: true
	enable_batch_verification: true
	fallback_to_baseline_on_error: true
	force_lookahead: false
```

`acceleration.target_model` is restricted to a model that shares the active
session's provider. A cross-provider override is logged and ignored — the
session's model wins for credential routing so the wrong API key is never
attached to the request.

## Programmatic surface

The exported types and entry points live in
`@pk-nerdsaver-ai/pi-agent-core/acceleration`:

- `AccelerationMode`, `AccelerationConfig`, `AccelerationTelemetry`
- `DraftModel`, `TargetModel`, `Verifier`
- `SpeculativeDecoder`, `LookaheadPlanner`, `LookaheadVerifier`
- `AccelerationOrchestrator`, `createAccelerationStreamFn`
- `normalizeAccelerationConfig`, `updateAdaptiveGamma`,
  `shouldUseLookaheadReasoning`

The orchestrator only ever emits a `done` event whose assistant message
matches the target model's output. When a step or verification fails, the
orchestrator falls back to baseline; the `fallbackCount` field on telemetry
records every fallback for debugging.

## Telemetry

`onTelemetry` is fired once per request with the final telemetry record. The
module always logs a `debug` record under the
`"Acceleration telemetry"` message so it is visible in `PI_LOG_LEVEL=debug`.

## Testing

```sh
bun --cwd=packages/agent test test/acceleration.test.ts
bun scripts/acceleration-bench.ts
```

The benchmark runs against a deterministic mock provider and reports
`backend=mock`. **Do not interpret its numbers as speedups.** It is a regression
suite for behavior equivalence and a smoke test for the orchestration path.

## Known limitations

- No provider exposes next-token logprobs through `pi-ai`, so exact token
  verification is impossible today. The verifier adapter is wired up but
  always reports `exact: false`; the orchestrator treats that as unavailable
  and falls back to baseline.
- The draft model selector is a plain string. If the selector does not
  resolve, the orchestrator logs a warning and falls back to baseline.
- Lookahead step acceptance is a JSON-shape contract. Bad JSON is
  swallowed and treated as "no accepted steps" → baseline fallback.
- The combined mode runs lookahead reasoning and records that the token layer
  fell back when exact verification is unavailable.
- The module is intentionally minimal: it does not register OTel, persist
  acceptance rates, or expose per-step timings beyond the consolidated
  telemetry record.
