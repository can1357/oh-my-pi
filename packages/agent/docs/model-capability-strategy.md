# Model Capability & Adaptive Strategy

OMP Ultra keeps model/provider wire behavior inside `pi-ai` and consumes the resolved `Model` object from the catalog. This layer adds a model-agnostic capability profile and a task-aware strategy profile; it does not create a second provider framework.

## Capability sources

Capabilities are read only from resolved model metadata and provider compat metadata:

- `contextWindow`, `maxTokens`
- `reasoning`, `thinking.efforts`
- `input` for text/image support
- `supportsTools`, `supportsComputerUse`
- resolved compat fields such as `supportsToolChoice`, `supportsForcedToolChoice`, `supportsNamedToolChoice`, `supportsParallelToolCalls`, and `supportsDeveloperRole`

A missing field remains `unknown`. No capability is inferred from a model name.

## Strategy

`createStrategyProfile()` combines Task Router complexity with the normalized capability profile:

- context budget scales with the actual model context window while preserving a minimum output headroom
- configurable reasoning is increased only when the model exposes an explicit thinking ladder
- parallel tools are allowed only when the model/provider explicitly reports support
- structured output stays on the existing fallback path unless support is explicitly reported
- very complex tasks or models without controllable reasoning receive deeper deterministic verification
- unsupported capability surfaces select a capability-aware fallback policy; unknown capability does not force a fallback

## Runtime

`model-capability-runtime.ts` runs before the existing Task Router runtime. If the user did not explicitly choose a thinking level and the model has a controllable effort ladder, the selected effort is applied through the existing `Agent.setThinkingLevel()` API. Provider-specific encoding remains in `pi-ai`.

The calculated strategy is exposed through agent state/telemetry so later layers can consume it without re-resolving capabilities.

Environment switch:

```text
PI_MODEL_CAPABILITIES=0
```

## Health evidence

The public `recordCapabilityEvidence()` helper supports bounded runtime evidence. A transient failure does not immediately invalidate cached capability information; repeated evidence can invalidate the cached profile for a future resolution.

## Limitations

The current OMP model abstraction does not expose an independent normalized structured-output or provider-neutral vision/computer-use capability record for every endpoint, so those fields remain `unknown` unless the model object has explicit metadata. Automatic model replacement is not forced on unknown capabilities; callers can use the strategy's fallback policy when a concrete requirement is unsupported.
