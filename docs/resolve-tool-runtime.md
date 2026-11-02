# Resolution devices runtime

Pending previews and plan approval do not use a `resolve` tool. They finalize through plain-text `write` calls to virtual `xd://` devices implemented in `packages/coding-agent/src/tools/resolve.ts`:

- `xd://resolve` — apply the pending staged preview; body = a one-sentence reason
- `xd://reject` — discard the pending staged preview; body = a one-sentence reason
- `xd://propose` — submit a plan for approval while plan mode is active; body = the plan slug (`<slug>` for `local://<slug>-plan.md`)

These are internal URLs, not filesystem paths. `read xd://resolve`, `read xd://reject`, and `read xd://propose` return a one-line usage hint. Bodies are trimmed plain text, not JSON; the runtime does not enforce sentence count or a nonempty reason. Completed device writes carry `details.xdev` metadata; `writeDeviceDispatch()` exposes the envelope and `resolveDispatchDetails()` extracts apply/discard details from `xdev.inner`.

## Preview flows

Preview producers call `queueResolveHandler(...)` with `apply(reason)` and optional `reject(reason)` callbacks. Each preview receives a unique pending-invoker ID in `ToolChoiceQueue`, so stacked previews do not overwrite one another.

When no hard tool-choice directive takes precedence, a pending preview makes `AgentSession.nextToolChoiceDirective()` return a soft requirement:

- `toolName: "write"`
- `satisfies: isPreviewResolutionToolCall`
- reminder from `resolve-device-reminder.md`

The model complies by calling only writes to `xd://resolve` or `xd://reject` in that turn. A different write, another tool, or a resolution write batched with a detour is noncompliant: the calls are skipped and the next turn forces `write`. Repeated noncompliance eventually aborts rather than looping indefinitely.

Dispatch selects the in-flight queue invoker first, then the pending-preview head, and invokes its callback through `runResolveInvocation(...)`. `queueResolveHandler(...)` needs a session tool-choice queue; without one, it does not register a preview.

- A successful apply or discard consumes that pending invoker exactly once.
- If apply throws, the same preview is re-registered so the model can reject it or retry after fixing the cause.
- Rejecting with no pending action succeeds with `Nothing to reject; no pending action remains.`
- Resolving with no pending action throws.
- An apply callback's ordinary error becomes `ToolError("Apply failed: ...")`; an existing `ToolError` is preserved.

## Plan approval

Plan mode installs a separate proposal handler through `setPlanProposalHandler(...)`.

- Interactive mode hands `PlanApprovalDetails` to the plan-review UI.
- ACP mode runs elicitation/approval and emits mode updates.
- PlanYolo auto-approves and switches to the execution target.

`xd://propose` dispatches the written slug to the installed plan proposal handler and is valid only while plan mode is active. The handler validates that a real plan artifact exists. Slug-based `local://<slug>-plan.md` lookup can fall back to the recorded plan path or discovered plan artifacts; proposal does not rename the file.

Ordinary print mode has no interactive review surface and ignores `plan.defaultOnStartup`; use `--plan-yolo` for the supported headless approval-and-execution flow.

## Keeping `write` available

Because previews and plan approval ride `write`, normal session assembly retains the transport:

- `createTools(...)` auto-appends `write` when a deferrable tool such as `ast_edit` is active and `restrictToolNames` is not set.
- `createAgentSession(...)` ensures registration for deferrable tools, available plan mode, or deferred MCP discovery, subject to the same restriction.
- Active-tool reconciliation retains `write` while mounted devices, deferrable tools, or active plan mode need it. This may be a device-only transport, not a general filesystem-write grant.

Low-level or restricted SDK hosts must explicitly supply the queue and write transport required by their preview flow.

## Custom tools

Custom tools still stage previews through `pushPendingAction(...)`; the loader forwards them into `queueResolveHandler(...)`. The custom-tool preview API is unchanged except for the model-facing finalization step: follow up with a plain-text write to `xd://resolve` or `xd://reject`, not a `resolve` tool call.
