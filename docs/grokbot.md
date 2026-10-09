# Grok Bot connectors

OMP provides two distinct connectors using your existing authorized Grok Bot
account. Neither uses the public Anthropic API or guarantees Opus entitlement.

`/grokbot` shows native connector configuration without printing credentials.
It respects configured credentials and backend overrides and redacts host URL
userinfo, query parameters, fragments and terminal control characters. It is
not an inference or entitlement test.

## Host-managed text chat

```sh
omp --provider grokbot-chat --model host-managed --no-tools -p "Hello"
# From this checkout:
bun packages/coding-agent/src/cli.ts --provider grokbot-chat --model host-managed --no-tools -p "Hello"
```

This connector uses GrokBotService with the session `accessToken`. It creates
its own isolated temporary conversation, sends the caller's textual history,
correlates the reply with its user nonce, independently reads back the reply,
and deletes only that conversation with ownership and absence checks. It never
attaches to an existing bot or changes shared host defaults. An uncertain
message delivery is not automatically resubmitted.

The model label is `host-managed`: the service does not expose a concrete
serving model through this path. OMP tools, image inputs, native signed thinking,
model selection, sampling controls and server token usage are not supported.
The adapter yields completed messages, not individual model token deltas.
The 32k catalog context floor is conservative local prompt budgeting, not a
verified hidden-backend limit. Failed inference or unverifiable cleanup remains
an error; the temporary conversation name is reported for recovery.

## Native Sand inference

The `grokbot` provider uses `aiserver.v1.InferenceService/Stream`, not Cursor's
AgentService or GrokBotService chat. The stream bearer is the `grokBotToken`
when renewal returns one, rather than the metadata session token.

```sh
omp models grokbot
omp --provider grokbot --model claude-opus-5-5-medium --no-tools -p "Hello"
```

Explicit `claude-opus-5-5-low`, `-medium`, `-high` and `-xhigh` selectors are
preserved. AvailableModels discovery is account-scoped; GetUsableModels confirms
packed IDs that may be sent directly. Other variants retain their canonical
model and advertised parameters. Offline rows and catalog visibility do not
prove service entitlement or successful inference. There is no automatic
fallback from a denied explicit model to host-managed chat.

Native signed content and explicit tool-completion boundaries are retained.
Claude product tools keep the requested model. The opt-in
`GROKBOT_ANTHROPIC_TOOLS_WIRE=text-tools` mode advertises tools in textual
instructions and promotes valid returned JSON calls; it does not rewrite
Claude to a router. This experimental mode has parser/continuation regression
coverage, not a claim of live Claude tool success on every account.

## Credentials and allowance

Use your own authorized `GROKBOT_RENEWAL_CREDENTIAL` (alias
`SAND_INFERENCE_RENEWAL_CREDENTIAL`) with `GROKBOT_MACHINE_ID`.
`/login grokbot` and `/login grokbot-chat` explain host-side setup without
printing credentials. The optional file is `<agent-dir>/secrets/grokbot.env`.

The allowance reporter uses session-authenticated
`DashboardService/GetSandUsageStatus`. Used/remaining percentages and resets
are separate from model entitlement. It does not redeem resets, increase spend
limits or reuse stale allowance as current evidence.

## Optional workload authorization

An authorized launcher may supply `INFERENCE_PROXY_JWT`, the explicit
`GROKBOT_INFERENCE_AUTHENTICATION_JWT_FILE` handoff, or a per-attempt SDK
`grokbotInferenceAuthenticationJwt` supplier. The explicit handoff file is
atomically claimed and removed. Issuer-provided request context may be forwarded
through `grokbotInferenceRequestContext`. These values are never minted or
forged by OMP and are not forwarded to renewal or discovery.

No universal token lifetime/reuse rule is asserted. A renewed bearer alone
neither proves native inference access nor explains every permission failure.
The `sand-default` router makes no promise about its backend; inspect an actual
successful native response's `upstreamModel` instead of asking the model to
identify itself.

## Verification and upstream policy

`bun scripts/grokbot-chat-smoke.ts [new-receipt-path]` exercises public SDK
chat dispatch, exact nonce verification, independent transcript readback and
original-roster/cleanup checks. It uses existing credentials and may consume
allowance. Native Stream remains independently testable and may be denied even
when host-managed chat succeeds. Local live chat has succeeded, but other CLI
checks encountered cleanup-verification errors; uniformly reliable service and
Opus 5.5 serving are not established.

Maintainer acceptance of these private vendor endpoints remains a policy
question. This documentation and the draft PR do not assert that it is resolved.
