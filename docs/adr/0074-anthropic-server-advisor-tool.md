# 0074. Anthropic server-side advisor tool as an opt-in hosted tool

Status: proposed
Date: 2026-11-20
Area: ai

Research: Anthropic advisor tool, beta (`https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool`). Read against `omp2` at `b6fc45474c`.

**Review status.** Proposed. Not owner-approved. Not machine-reviewed.

## Answer in brief

- **Add one opt-in hosted tool, `HostedTool::Advisor`, lowered only by the Anthropic codec.** An executor model (for example `claude-sonnet-5-5`) consults a stronger advisor model (for example `claude-opus-5-5`) inside one request. Anthropic runs the advisor server-side. omp2 sends one tool entry and one beta header.
- **Behaviour change if accepted: none by default.** The tool is off unless a provider sets it.
- **Not the local advisor.** `crates/agent/src/directors/advisor.rs` reviews each turn in a separate request and injects notes. This record does not change it. The two can run together; the owner decides which to enable (O3).

## Context

### What the provider requires (from the doc)

- Request header `anthropic-beta: advisor-tool-2026-03-01`. The tool is in beta.
- Tool entry in `tools`: `{"type":"advisor_20260301","name":"advisor","model":"<advisor>","max_uses":N,"max_tokens":M}`.
- `max_uses`: advisor calls allowed per turn; unlimited by default. Past the cap the executor receives an `advisor_tool_result_error` with `error_code: "max_uses_exceeded"` and continues without advice.
- `max_tokens`: caps the advisor's output (thinking plus text) per call; minimum 1024.
- Response blocks: `server_tool_use` from the executor, then `advisor_tool_result`.
- Not read in full: the doc's cost-control and supported-pair sections. Both are UNVERIFIED here and are checked in S0.

### Where it attaches (verified in the tree)

- `HostedTool` is declared at `crates/ai/src/call.rs:849` with `WebSearch`, `CodeExecution` and `Retrieval`.
- The Anthropic codec lowers it at `crates/ai/src/codec/anthropic.rs:1423-1449`. `Retrieval` already fails closed there with `anthropic.hosted_retrieval.unsupported` (`:1446`). That is the precedent for a hosted tool a codec cannot carry.
- `HostedToolDefinition` (`anthropic.rs:414`) already has `kind`, `name` and `max_uses`. It has no `model` or `max_tokens`.
- `BetaSet` (`anthropic.rs:150`) is an ordered unique set with `header_value()`. The Messages path inserts betas before `project(...)` (`:2225-2240`), so one more beta needs no new header code.
- Four other codecs match `HostedTool` exhaustively (`gemini.rs:1178`, `openai_chat.rs:1582`, `openai_responses.rs:2937`, `anthropic.rs:1437`). A new variant forces each to decide.

## Decision

1. Add `HostedTool::Advisor { model, max_uses, max_tokens }`.
2. Anthropic codec: emit the tool entry and insert `advisor-tool-2026-03-01` into the `BetaSet`. Reject `max_tokens` below 1024 with a typed capability error before sending.
3. Every other codec returns its existing unsupported-hosted-tool error for `Advisor`. No silent drop.
4. Configuration: an optional `server_advisor` table on the anthropic provider in the catalog, fields `enabled` (default false), `model`, `max_uses`, `max_tokens`. TOML, not YAML or JS. omp2's only extension surface is Python (ADR 0036).
5. Direct adapter only. Vertex and Bedrock reject it until the provider documents support.

## Options considered

- **A. Hosted tool on the Anthropic codec (chosen).** One request, one bill line, the provider owns the advisor loop.
- **B. Extend the local advisor director.** Already exists, but it costs a second request per turn and cannot see the executor mid-generation.
- **C. Do nothing.** Keeps the local advisor only.

## Slices

- **S0, measurement.** One recorded real request against the direct API with a sonnet executor and an opus advisor. Records the supported pairs, the response block shapes, and what the usage object reports for advisor tokens. No code merges before this exists.
- **S1.** `HostedTool::Advisor`, codec lowering, beta insertion, fail-closed arms in the other codecs, unit tests on the encoded body and header.
- **S2.** Decode `server_tool_use` and `advisor_tool_result` blocks, including `max_uses_exceeded`, and surface advisor token usage in cost accounting.
- **S3.** Catalog `server_advisor` table and validation.

## Open questions for the owner

- **O1.** Which executor and advisor pair is the default when `enabled` is true.
- **O2.** Default `max_uses` and `max_tokens`. Proposal: 2 and 2048, as in the request example.
- **O3.** Run alongside the local advisor director, or replace it.
- **O4.** Cost ceiling. The doc describes conversation-level limits that this record has not read.

## Acceptance tests

- Encoded body contains the `advisor_20260301` entry with the configured fields, and the header contains `advisor-tool-2026-03-01` exactly once when a beta is already present.
- `max_tokens` of 1023 is rejected before any network call.
- Each non-Anthropic codec returns its unsupported error for `Advisor`.
- A recorded `max_uses_exceeded` result decodes without ending the turn.

## Status in omp

Not started. S0 is the first slice.
