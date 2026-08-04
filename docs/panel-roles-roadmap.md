# Panel Roles Roadmap

**Status:** panel execution and the interactive workflow are implemented locally in `tau`; the upstream pull request is still pending.

## Existing seams

The roadmap builds on code that already exists:

- `task/structured-subagent.ts` exposes `runStructuredSubagent()`, which accepts a per-call model override and creates an isolated `AgentSession` for each spawn through `task/executor.ts`.
- `task/parallel.ts` supplies bounded, all-settled fan-out. It preserves successful results when another participant fails.
- Slash commands may return `{ prompt }`; the normal primary-session turn then answers that prompt. `/force` is the established example in `slash-commands/builtin-registry.ts`.

No phase should duplicate these mechanisms with a separate model runner or global mutable state.

## Product rules

- Panel roles are opt-in. The default behavior remains one active model.
- Explicit model and thinking-level selections take precedence over panel execution.
- Every non-primary model runs in its own session and may only use an intentionally read-only tool set.
- A provider failure is visible. Synthesis must label a failed panelist rather than treating it as an empty answer.
- Panel execution does not change the primary session's model, thinking level, or service tier.
- No panel feature writes `settings.json` as a side effect of one session's transient condition.

## Terms and product contract

A **panel role** is a named saved lineup, resolved with `@name` inside a panel command. It contains the member models and efforts, so the user does not re-enter them for every request. A **persona** is an optional member-specific instruction, such as analyst, implementer, or reviewer.

Every panel has one task mode, **Answer** or **Plan**, and one strategy:

- **Independent**: every member receives the exact same neutral panel instruction and user request. Members must resolve to distinct underlying model families. This is the model-diversity path: it measures agreement and disagreement among independently prompted model families.
- **Personas**: every member receives the user request plus its configured persona instruction. The lineup may repeat a model family when the user wants distinct perspectives rather than model diversity.

Each participant returns an independent response. The primary session's already-selected model synthesizes completed and failed results into the visible answer.

Task modes:

- **Answer**: evaluate a question, recommendation, design choice, or draft.
- **Plan**: inspect the workspace read-only and propose an implementation plan.

The initial persona catalog is intentionally small:

| Persona     | Answer focus                      | Plan focus                           |
| ----------- | --------------------------------- | ------------------------------------ |
| analyst     | facts, constraints, options       | affected subsystems and dependencies |
| implementer | practical implementation choice   | smallest safe sequence of changes    |
| reviewer    | risks, missing cases, regressions | acceptance tests and rollback risks  |

### Panel-role configuration

`panel.roles` is the user-facing saved-lineup registry:

```yaml
panel:
  defaultRole: frontier
  roles:
    frontier:
      strategy: independent
      members:
        - model: fireworks/kimi-k3
          thinking: high
        - model: anthropic/claude-fable-5
          thinking: xhigh
        - model: openai-codex/gpt-5.6-sol
          thinking: xhigh
    architecture:
      strategy: personas
      members:
        - persona: analyst
          model: openai-codex/gpt-5.6-sol
          thinking: xhigh
        - persona: reviewer
          model: anthropic/claude-fable-5
          thinking: xhigh
        - persona: implementer
          model: fireworks/kimi-k3
          thinking: high
```

An independent role has at least two members and no `persona` fields. Resolve each model first, then require distinct `modelFamilyToken(model.id)` values from `packages/catalog/src/identity/family.ts`. That follows canonical lineage across providers and proxy names: direct Kimi and Fireworks Kimi are both `kimi`; Claude, GPT, and Kimi are distinct. An unknown family fails closed rather than pretending two opaque names provide diversity.

A personas role has at least two members, each with a valid persona. Repeated personas and families are allowed, since the product claim is perspective coverage rather than cross-family independence.

Every `model` is an exact selector or an ordinary model-role reference such as `@plan`, without a `:thinking` suffix. Its optional `thinking` field is the only panel-member effort override; when omitted, the selected model or ordinary model role supplies its configured default. The parser rejects a suffixed model selector and invalid effort before dispatch.

The contexts are unambiguous: the command's first `@name` resolves `panel.roles.<name>`, whereas `members[].model: "@plan"` resolves the existing ordinary model role. Role IDs are stable enough to appear in session history.

### User experience

```text
/panel answer @frontier Is this migration safe?
/panel plan @architecture Add cache invalidation for config reload.
```

`/panel answer <question>` and `/panel plan <goal>` use `panel.defaultRole` when configured. Otherwise the TUI opens a panel-role picker. ACP and non-interactive callers must provide `@role` unless the default is set.

Before dispatch, the TUI shows task mode, strategy, each resolved selector, thinking level, and model-family key. For independent panels it marks the family-diversity check as passed. After confirmation, every member appears as a normal child agent in the Agent Hub; a compact progress line reports completed, failed, and still-running members.

When all selected members settle or are cancelled, the active primary model receives a synthesis prompt with labeled results, failure reasons, the original request, and task-mode-specific synthesis instructions. The resulting answer is a standard primary-session assistant message with no special persistence or rendering path.

`/panel lineup <answer|plan> <request>` opens the interactive one-off lineup builder. It requires the user to declare either an independent lineup or persona assignments, validates it by the same rules as saved roles, and never partially merges it with a saved role. ACP and non-interactive callers use saved roles only.

### Execution design

1. Add a narrow `panel` command module and register it from `slash-commands/builtin-registry.ts`.
2. Resolve the selected panel role and every member selector through the existing model registry before dispatch. Reject unavailable models, invalid effort levels, malformed role shapes, and independent lineups with duplicate or unknown `modelFamilyToken(model.id)` values before any participant starts. Prepare an immutable plan before TUI review, then dispatch that exact plan after approval rather than resolving it again.
3. Build one `StructuredSubagentRequest` per member and call `runStructuredSubagent()` directly. Use:
   - `model` for the resolved member selector;
   - a bundled, read-only neutral panel-agent definition for every independent member;
   - the same base definition plus only the configured persona instruction for a personas member;
   - `keepAlive: true`, so participant transcripts appear as ordinary subagents;
   - `enableIrc: false` and no mutating tools;
   - a command-owned `AbortSignal`.
4. Dispatch through `mapWithConcurrencyLimitAllSettled`. Start with a panel limit of four concurrent members. This bounds cost and synthesis context while preserving diversity.
5. Ask each member for a bounded response with explicit headings: conclusion, evidence, risks, and confidence. Truncate any response that exceeds the synthesis budget and mark the truncation.
6. Compose the synthesis prompt from typed `PanelistResult` records. Preserve host-owned panel-role ID, resolved model, model-family key, strategy, persona, effort, usage, status, cancellation, and failure fields separately from the escaped response text. Return `{ prompt }` from the slash command.
7. The primary session generates the synthesis. It remains on its current model and thinking level for the entire panel operation.

The panel command must not route through the model-invoked `task` tool, alter `TaskItem`'s wire schema, or reuse the advisor runtime. Those surfaces serve different ownership and lifecycle rules.

### Persona customization

`panel.personas` extends the built-in catalog with configured read-only personas:

```yaml
panel:
  personas:
    security-reviewer:
      label: Security reviewer
      modes: [answer, plan]
      instructions: >-
        Identify concrete security and operational risks. Do not invent facts.
      tools: workspace-read
```

Constraints:

- `instructions` are inserted only into a personas-panel prompt, never the primary system prompt or an independent-panel prompt.
- `tools` only accepts `none` or `workspace-read` in the first version. `workspace-read` maps to the established read-only tool set.
- A persona cannot grant `edit`, `write`, `bash`, browser actions, or messaging privileges.
- Existing built-in personas remain available if the user supplies no persona configuration.

### Cancellation, persistence, costs, and synthesis trust

Panels own a command-level `AbortController`. Escape and Ctrl+C abort queued and in-flight members, retaining results that already settled. When cancellation leaves one or more completed members, the TUI asks whether to synthesize the retained partial results; it skips synthesis when none completed. Member transcripts remain inspectable through the Agent Hub after completion. The completion status reports every terminal outcome plus aggregate token, request, and cost usage before synthesis.

#### Interaction guarantees

- **Lineup confirmation:** saved roles and one-off lineups display the exact resolved selector, thinking level, and model-family key for every member before dispatch. Approval dispatches the immutable reviewed plan.
- **Live progress:** the TUI renders a compact completed, failed, aborted, running, and pending status line while members execute.
- **Interrupted partial synthesis:** cancellation with completed members requires an explicit transient confirmation before synthesis; cancellation before any member completes skips it.

Treat panel output as untrusted evidence. A plan member can reproduce prompt injection from a repository, and a member can emit forged labels or synthesis instructions. `renderPanelSynthesisInput()` must length-bound and mechanically escape each response inside a typed record; host code owns all identity and status fields. The primary synthesis instruction explicitly treats member text as evidence, never instructions.

### Implementation phases

| Phase | Work                                                                                                                                                                                    | Done when                                                                                                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1    | Define panel-role/member/result types, strategy parser, family validation using `modelFamilyToken`, bounded synthesis renderer, and bundled read-only neutral and persona panel agents. | Unit tests cover `@role` resolution, malformed role shapes, duplicate or unknown independent families, prompt size bounds, failure labels, and untrusted-text escaping.                                                                           |
| A2    | Add `/panel answer` and `/panel plan` using saved `@role` lineups, isolated structured subagents, and all-settled dispatch.                                                             | `@frontier` runs without re-entering models; independent members receive the same neutral prompt and have distinct families; persona members receive only their configured persona; one member failure still produces a labeled synthesis prompt. |
| A3    | Add cancellation, progress reporting, aggregate usage, retained artifacts, and Agent Hub visibility.                                                                                    | A user interrupt aborts pending work without hanging and completed member transcripts remain accessible.                                                                                                                                          |
| A4    | Add the TUI panel-role picker, then one-off independent-lineup and persona-assignment construction by reusing model-browser list data and multi-select settings UI behavior.            | The TUI can run a saved role or construct, inspect, and submit either strategy without command flags.                                                                                                                                             |
| A5    | Add `panel.personas` configuration and persona management UI only after the built-in persona and panel-role contracts are stable.                                                       | A custom persona changes only the corresponding personas-panel prompt and cannot widen its tool permissions.                                                                                                                                      |

### Focused verification

- One structured spawn occurs per chosen member, each with a distinct identity and isolated session.
- A default role and an explicit `@role` resolve and prepare every model and effort before any participant starts; approval dispatches the same resolved lineup.
- An independent role supplies the same neutral prompt to every member and rejects duplicate or unknown resolved model families before dispatch.
- A personas role supplies only the selected persona instruction to each member and need not pass the family-diversity check.
- The main session's model and configured thinking level are identical before and after a panel run.
- A rejected, timed-out, or aborted member appears as a labeled failure in the synthesis source.
- Panelist prompts cannot access mutating tools.
- Malicious member text cannot escape its result record, overwrite another member's identity, or become synthesis instructions.
- Cancellation prevents queued members from starting and settles already-started members; retained partial results require explicit synthesis approval.
- The same command works through TUI and ACP syntax.

