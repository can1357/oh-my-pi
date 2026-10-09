# Grok Bot connector

The `grokbot` provider connects directly to Cursor's Sand
`aiserver.v1.InferenceService/Stream`. It is distinct from the `cursor`
AgentService connector, the Anthropic API, and xAI.

Use your own authorized `GROKBOT_RENEWAL_CREDENTIAL` (or
`SAND_INFERENCE_RENEWAL_CREDENTIAL`) together with `GROKBOT_MACHINE_ID`.
`/login grokbot` explains the host-side setup; credentials are never printed.
The optional secrets file is `<agent-dir>/secrets/grokbot.env`.

AvailableModels discovery is account-scoped. GetUsableModels confirms which
packed IDs may be sent directly; other variants retain the canonical model
and its advertised parameters. The offline catalog is a fallback, not proof
of service entitlement.

```sh
omp --provider grokbot --model claude-opus-5-5-medium
omp --provider grokbot --model claude-opus-5-5-low
omp --provider grokbot --model claude-opus-5-5-high
omp --provider grokbot --model claude-opus-5-5-xhigh
```

The default remains `sand-default`. Its resolved model is unknown until the
server reports `responseInfo.model`; that value is exposed as
`AssistantMessage.upstreamModel`. A catalog name or a model's self-description
does not establish the backend that served a turn.

Claude tools use the product tool schema while retaining the selected model.
Signed native content is replayed verbatim only within its model lineage.
There is no automatic fallback to a different backend when explicit Opus
requests fail. Experimental text tools and host-managed chat are not included.

Some authorized workloads supply a separate inference JWT. The SDK can forward
`grokbotInferenceAuthenticationJwt` or a per-attempt supplier, an explicit
one-shot `grokbotInferenceAuthenticationJwtFile`, and
`grokbotInferenceRequestContext`. `INFERENCE_PROXY_JWT` and
`GROKBOT_INFERENCE_AUTHENTICATION_JWT_FILE` are optional launcher inputs.
These are forwarded only to Stream, never minted locally or sent to discovery.
Only use credentials issued for your own workload; omission does not imply
that every account requires this header.

Live validation on 2026-10-09 reached authenticated discovery, but direct
Stream calls were denied by the tested account. No live Opus 5.5 response or
resolved Auto model has been verified. Protocol fixture tests are not an
inference entitlement test.
