# Resolution devices runtime

Pending previews and plan approval do not use a `resolve` tool. They finalize through plain-text `write` calls to virtual `xd://` devices implemented in `packages/coding-agent/src/tools/resolve.ts`:

- `xd://resolve` — apply the pending staged preview; body = a one-sentence reason
- `xd://reject` — discard the pending staged preview; body = a one-sentence reason
- `xd://propose` — submit a plan for approval while plan mode is active; body = the plan slug (`<slug>` for `local://<slug>-plan.md`)
- `xd://deliver-plan` — deliver a design without authorizing implementation; body = the exact plan slug (`<slug>` for `local://<slug>-plan.md`)

These are internal URLs, not filesystem paths. Reading any of these devices returns a one-line usage hint. Completed device writes carry `details.xdev` metadata; consumers recover the inner result through `writeDeviceDispatch()` and `resolveDispatchDetails()`.

## Preview flows

Preview producers call `queueResolveHandler(...)` with `apply(reason)` and optional `reject(reason)` callbacks. Each preview receives a unique pending-invoker ID in `ToolChoiceQueue`, so stacked previews do not overwrite one another.

While a preview is pending, `AgentSession.nextToolChoiceDirective()` returns a soft requirement:

- `toolName: "write"`
- `satisfies: isPreviewResolutionToolCall`
- reminder from `resolve-device-reminder.md`

The model complies by writing to `xd://resolve` or `xd://reject`. A different write does not resolve the preview and is skipped or escalated by the soft-requirement lifecycle.

Dispatch invokes the pending queue head through `runResolveInvocation(...)`.

- A successful apply or discard consumes that pending invoker exactly once.
- If apply throws, the same preview is re-registered so the model can reject it or retry after fixing the cause.
- Rejecting with no pending action succeeds with `Nothing to reject; no pending action remains.`
- Resolving with no pending action throws.
- An apply callback's ordinary error becomes `ToolError("Apply failed: ...")`; an existing `ToolError` is preserved.

## Plan approval

Plan mode installs a separate proposal handler through `setPlanProposalHandler(...)`.

- Interactive mode hands `PlanApprovalDetails` to the plan-review UI.
- ACP mode requires an explicit approval choice through a form-capable client before emitting execution mode updates. Clients without `elicitation.form` remain in plan mode and can deliver a design instead; lack of an approval UI never authorizes implementation.
- PlanYolo auto-approves and switches to the execution target.

`xd://propose` dispatches the written slug to the installed plan proposal handler and is valid only while plan mode is active.

## Design-only delivery

Write a non-empty design to `local://<slug>-plan.md`, then write `<slug>` to `xd://deliver-plan`. Delivery validates only that exact file; it does not search other plans. A successful result contains `PlanDeliveryDetails` with `kind: "plan-delivery"` and `implementationAuthorized: false`.

Delivery lets the current user turn finish without forcing an approval prompt. It does not open the execution approval UI, exit plan mode, restore worktree write access, clear the session, or enqueue implementation. A later acknowledgement of the design is not implementation approval. A new user turn must make its own planning decision or delivery; the prior delivery is not a cross-turn exemption.

Implementation still requires the existing native approval flow. `deliver-plan` does not invoke the proposal handler, including the PlanYolo handler.

## Why `write` is guaranteed

Because previews and plan approval ride `write`, the harness keeps `write` available whenever needed:

- `createTools(...)` auto-appends `write` when a deferrable tool such as `ast_edit` is active.
- `createAgentSession(...)` keeps `write` registered when a deferrable tool exists or plan mode is enabled.

## Custom tools

Custom tools still stage previews through `pushPendingAction(...)`; the loader forwards them into `queueResolveHandler(...)`. The custom-tool preview API is unchanged except for the model-facing finalization step: follow up with a plain-text write to `xd://resolve` or `xd://reject`, not a `resolve` tool call.
