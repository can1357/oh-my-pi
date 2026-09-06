# PR 9510 re-architecture plan v4 — PersonaRuntime + Policy + Transaction

Context: branch `feat/main-agent-persona` at 0dac8051ff (12 behavior-correct divergence patches); v3 design after 3 rounds of 3-reviewer verification (Task + Reviewer + Scout + extra Seam reviewer). This v4 finalizes; no further iteration expected.

## Core thesis (validated by 4 independent reviewers)

12+ codex P1 fixes across 25 review waves, **all copy-divergence between parallel persona/shadow state**. The redesign replaces 16 shadow fields + 3 apply sequences + 4 task-suppression copies + 4 LSP/Hub lift copies with **one policy object, one runtime, one transaction**.

## Design — final shape

### 1. SessionToolPolicy (owns effective-set computation)

```ts
// packages/coding-agent/src/session/tool-policy.ts (new, ~120 lines)
export class SessionToolPolicy {
    // Durable at construction
    readonly cliGrant: ReadonlySet<string> | null;   // from options.toolNames; null = no CLI grant
    readonly cliLspReadOnly: boolean;                // options.lspReadOnly ?? restrictToolNames  (R3 fix: preserve restricted-session default)

    // Live state (mutated by PersonaRuntime + session-level toggles only)
    #globalRegistry: () => ReadonlySet<string>;      // getter into ToolSession registry (live, not snapshot)
    #persona: {                                      // set by runtime.enter, cleared by runtime.exit
        agent: DiscoveredAgent;
        explicit: PersonaExplicitOverrides;
        grant: ReadonlySet<string>;                  // agent.tools pre-intersected: strips "task" iff spawns:[]
    } | null;
    #sessionToggles: Map<string, boolean>;           // R3-seams simplification: single map, sparse-delta; !has=default

    constructor(opts: {
        toolNames?: readonly string[];               // raw CLI grant
        restrictToolNames?: boolean;                 // whether CLI grant restricts
        lspReadOnly?: boolean;
        registry: () => ReadonlySet<string>;         // ToolSession registry getter
        isDefaultActive: (name: string) => boolean;  // R3 fix: registry tool defaultActive metadata
    });

    // Pure derivations — every read recomputes; no caching; no side effects
    effective(name: string): boolean {
        return this.#globalRegistry().has(name)
            && (this.cliGrant === null || this.cliGrant.has(name))
            && this.#toggledOnOrDefault(name)
            && (this.#persona === null || this.#persona.grant.has(name));
    }
    // where #toggledOnOrDefault: toggles.get(name) ?? this.#isDefaultActive(name)

    isPersonaActive(): boolean { return this.#persona !== null; }
    isRestricted(): boolean {                        // R3 fix: any layer narrows — needed for structured-subagent.ts:425
        return this.cliGrant !== null && this.cliGrant.size < this.#globalRegistry().size
            || this.#sessionToggles.size > 0
            || this.#persona !== null;
    }
    spawnable(): boolean {                           // R2+R3 fix: derivation not circular
        // Persona with spawns:[] NEVER spawnable, regardless of tools: field
        if (this.#persona?.agent.spawns !== undefined && !spawnsUsable(this.#persona.agent.spawns)) return false;
        return this.effective("task");
    }
    lspReadOnly(): boolean {                         // R2+R3 fix: cliLspReadOnly || (write AND edit both ineffective)
        return this.cliLspReadOnly || (!this.effective("write") && !this.effective("edit"));
    }
    hubEnabled(): boolean { return this.effective("hub"); }     // R3 fix: no extra persona check; effective covers it
    mutating(): boolean { return this.effective("write") || this.effective("edit") || this.effective("bash"); }  // R3 fix: bash intentionally absent from cursor mutation floor but kept here

    // Mutators (PersonaRuntime + session toggles ONLY)
    enterPersona(agent: DiscoveredAgent, explicit: PersonaExplicitOverrides): void;
    exitPersona(): void;
    setSessionToolEnabled(name: string, on: boolean): void;   // /mcp toggle, RPC activation
    snapshot(): PolicySnapshot;                                // persona field + toggles copy
    restore(snap: PolicySnapshot): void;
}
```

**Seeded via sdk.ts createAgentSessionScoped at line ~1908** (toolRegistry closure available, toolSession not yet — getter captures the registry Map). Policy instance passed into `AgentSessionConfig.toolPolicy` alongside `toolSession`. (R3 verified construction ordering is feasible at sdk.ts:1908.)

### 2. PersonaSwitchTransaction — single atomic switch (R3 seams fix)

All four fields — policy, model/thinking, append prompt, spawns — captured and restored in one snapshot. Replaces the layered policy.restore + presentation.restore + model.restore composition.

```ts
// packages/coding-agent/src/session/persona-runtime.ts (new)
class PersonaRuntime {
    constructor(readonly policy: SessionToolPolicy, readonly session: AgentSession);

    async enter(agent: DiscoveredAgent, explicit: PersonaExplicitOverrides, hooks: PersonaModelApplyHooks): Promise<void>;
    async exit(hooks: PersonaModelApplyHooks): Promise<void>;
    async reconcile(desired, hooks: PersonaModelApplyHooks): Promise<void>;    // launch+resume+ACP factory share this

    async snapshot(): Promise<PersonaSwitchSnapshot>;    // R3 fix: PUBLIC — plan/goal/vibe modes capture persona pre-partition
    async restore(snap: PersonaSwitchSnapshot): Promise<void>;  // symmetric
}

interface PersonaSwitchSnapshot {
    policy: PolicySnapshot;                    // persona + sessionToggles
    tools: readonly string[];                  // presentation (R2 fix: survives; not derivable)
    mountedToolNames: readonly string[];
    baseModelOverride: ModelOverrideState;
    appendPrompt: string | undefined;
    spawns: SessionSpawns | null;
    lastAssistantUsageCleared: boolean;        // UI marker state captured (mode entry clears conditionally)
}
```

**enter** sequence:
```
async enter(agent, explicit, hooks) {
    // R3 fix: mode-conform semantics — queue model if streaming (defer), or queue persona switch entirely if hooks say so
    if (hooks.shouldDefer?.()) await hooks.deferModelSwitch?.(agent);   // ACP: notify + skip; TUI: queue via pendingModelSwitch
    const snap = await this.snapshot();
    try {
        this.session.clearInheritedProviderPromptCacheKey();   // plan-mode parity; runtime needs public wrapper (R3 scout)
        this.#clearUiCacheMarker();                            // call-site responsibility (InteractiveMode clears lastAssistantUsage; ACP equivalent)
        this.policy.enterPersona(agent, explicit);
        this.session.setSessionSpawns(this.policy.effectiveSpawns());    // presentation channel
        this.session.applyPersonaAppendPrompt(agent.systemPrompt, ...);  // identity channel
        await applyPersonaModelAndThinking(this.session, agent, explicit, hooks);
        await this.session.refreshBaseSystemPrompt();
    } catch (err) {
        await this.restore(snap);
        throw err;
    }
}
```

### 3. Launch-as-switch (R3 fix: model resolution via modelPattern, not pendingModelHint)

```
// main.ts --agent: no fork, just stash
options.agentName = agent.name;
options.agentExplicit = explicit;
options.modelPattern ??= agent.model;                 // R3-task fix: keep persona model in the modelPattern seam (journal persistence + discovery + fallback chain all preserved)
options.thinkingLevel ??= agent.thinking;
// NO restrictToolNames=true; NO personaName; NO personaCliToolOverride; NO baseline capture

const session = await createAgentSession(options);
await session.personaRuntime.enter(agent, explicit, hooks);  // BEFORE first user turn (same gate as deferred MCP)
```

ACP factory/reload + resume reconcile: same call shape through `runtime.reconcile`.

### 4. Mode partitions + persona interplay (R4 final: suspend-persona)

Modes (plan/goal/vibe/prewalk/goal-research) **suspend** the persona during the mode, then **restore** it on mode exit. This is the conservative match to today's semantics (mode entry clears persona via `clearPersonaOwnedState`; mode exit was persona-lost). The new runtime makes suspension/resumption transactional — persona identity survives the mode — but never coexists: while a mode is active, the persona's grant is off; while exiting the mode, the persona comes back exactly as left.

Mechanism (R4 reviewer correction): the funnel `setActiveToolsByName` does NOT need to consult `policy.effective()` — mode partition machinery is already orthogonal. Instead, mode entry calls `const snap = await session.personaRuntime.snapshot()` + `await session.personaRuntime.exit(hooks)` (existing teardown semantics); mode exit calls `await session.personaRuntime.restore(snap)` (persona identity/grant/prompt/spawns restore in one transaction).

Why not "modes run WITH persona active": a read-only persona (scout-style grant: [read, grep, glob, web_search]) has no `write` in its grant, so plan mode's "write to PLAN.md" augmentation breaks. Goal mode's `goal` tool isn't in persona frontmatter grants and gets dropped. Snapshot/exit/restore avoids every such collision by treating a session as being in exactly one state at a time: persona-active XOR mode-active.

### 5. Cursor bridge — partition-aware

R3 P1-1 finding: policy.effective() alone loses the live-partition view. Corrected formula:

```
cursorAllowed(name) = isToolActive(name)              // R3 fix: live partition — unchanged semantic from current code
```
Where `isToolActive` is `activeToolNames.has(name) || toolSession.xdev?.mountedNames.has(name) === true` — **exactly** what today's `isToolGranted` closure computes. The predicate's OWNERSHIP moves (no longer a bespoke callback, reads shared state), but its SEMANTICS are preserved. `expandRegistryToAllBuiltins` deletion still works because the registry no longer widens under personas; the active set is built from policy each time.

Mutation floor stays derivation-based with current carve-outs:
- `pi_edit` answers iff `isToolActive("edit") && !deviceOnlyWrite("edit")`  ← unchanged
- `pi_write` native mutation iff `isToolActive("write") || isToolActive("edit")`  ← unchanged
- Shell frames iff `isToolActive("bash")`  ← unchanged
No `effective("bash")` widening (R2 fix preserved).

### 6. canLiveSwitchPersona disposition (final)

5 module-eval sites keep a flag (renamed `personaSwitchableLiveLoading`): 1473 (custom commands), 2358 (extension paths), 2447 (extension sync), 3018 (custom-cmd errors). **2283** (image-gen/tts gate) reads `options.personaName !== undefined` today — after Stage 2 deletes personaName this converts to `personaSwitchableLiveLoading` too (Scout R4 flag).
4 tool/MCP gates absorbed into policy reads: 3086 (getAllRegisteredTools), 3089 (sdk custom tools), 4545 (onToolRegistered), 2172 (MCP).
Total: 4 keep + 1 convert + 4 absorb.

### 7. Subagent spawn inheritance (R3 fix: wiring specified; R4 fix: intersection not replacement)

`structured-subagent.ts:425` changes from `session.restrictToolNames` to `session.toolPolicy.isRestricted()`. `buildSubagentSessionOptions` (executor.ts:3327) gains one new parameter `inheritedToolGrant: ReadonlySet<string> | null` — set to the parent's effective set when the parent is restricted (persona active, or plain restricted session), null otherwise.

**Precedence (R4 blocker fix)**: child tools come from `childToolNames = (childAgent.tools ?? DEFAULT) ∩ parentGrant` where:
- If the child agent declares `tools:` frontmatter explicitly, those names are used AS DECLARED, then INTERSECTED with `parentGrant` (the parent's persona-effective grant when persona active, or parent's full CLI grant when restricted, or full registry when unrestricted). An explicit `tools: [bash]` declared by a child of a read-only-persona parent → `bash` is filtered OUT at spawn (parent narrows what children may do — never widens). This matches today's subagent restriction contract (a child cannot exceed its parent's capability envelope).
- If the child has NO tools frontmatter (e.g. bundled task.md), inherit the parent's full current effective set.
- Intersection happens at spawn time; persona exit mid-child-execution doesn't retroactively re-filter (consistent with today's subagent lifecycle).

**Hub auto-append** (executor.ts:3021): kept as-is for unrestricted parent sessions; for parent-restricted (including persona), hub is NOT auto-appended (it's already inside or outside the grant by parent's persona). Rule: hub append applies only when parent is unrestricted (current semantic preserved), removing the current launch-vs-live divergence.

This delivers **launch/live parity** (acceptance criterion 8): both restrict the main session through the persona layer; both produce children with identical envelopes since policy state on the parent is the same.

### 8. ACP deferral semantics (R3 fix: correct precedent)

Current ACP: mid-turn model switch is SKIPPED with a text notice (`deferModelSwitchWhileStreaming`), tools/prompt apply immediately.
Current TUI: mid-turn model switch QUEUED via `#pendingModelSwitch`, flushed on agent_end.
Plan mode: sends steer context mid-turn, queues model.

v4 matches: persona enters immediately (policy/prompt/tools flip), model switch goes through the EXISTING `PersonaModelApplyHooks.deferModelSwitch`/`queueModelSwitch` channel per-surface (TUI queues, ACP notices). No new mid-turn rejection. This matches today's working behavior and removes the round-3 false claim about plan-mode mid-turn rejection.

### 9. Cache-clear + UI marker (G1 corrected)

`clearInheritedProviderPromptCacheKey` on AgentSession is private; runtime needs a public wrapper (~3 lines on AgentSession). UI `lastAssistantUsage` clearing: happens at the InteractiveMode call site around `runtime.enter()`/`runtime.exit()`, NOT inside the runtime (session layer cannot reach UI). Plan-mode parity: plan mode does it inline at interactive-mode.ts:3333/3600; persona does it at switchAgentPersona/ACP call sites. Acceptance 10 test is an interactive-mode harness test (R3 scout confirmed: novel surface, needs that harness).

### 10. Deletion table (orphan audit complete)

| Field/Mechanism | Disposition |
|---|---|
| `personaName`, `personaCliToolOverride`, `cliGrantRestrictsActive` | DELETE (Stage 2 — absorbed into policy.cliGrant) |
| `expandRegistryToAllBuiltins`, `hubLifted` | DELETE (Stage 3 — registry no longer widened) |
| `personaRequestsLsp`, `personaRequestsHub` (delete) | DELETE; LSP/Hub lifts become derivations |
| `baselineLspEnabled`, `baselineHubEnabled` | DELETE (R3-orphan fix: baseline becomes policy-driven) |
| `launchPersonaLifts`, `launchPersonaSeedsRestriction` (delete) | DELETE (R3-orphan fix: launch prompt matrix absorbed into refreshBaseSystemPrompt derivations) |
| `personaDroppedMutation`, `personaDroppedEdit` (sdk+session) | DELETE (Cursor derives from isToolActive) |
| `personaActiveToolRestriction` (session-tools, sdk) | DELETE (policy.personaGrant is the truth) |
| `residualCliToolRestriction` (session-tools, sdk) | DELETE (policy.cliGrant is the truth) |
| `#baselineToolNames`, `#baselineMountedToolNames` | KEEP (presentation partition state; restores from snapshot) |
| `#personaAppendPrompt`, `#sessionSpawns`, `#personaAppendPromptInitialized` | KEEP (identity channel + spawn policy channel, unchanged semantics) |
| `applyPersonaModelAndThinking`, `restorePersonaModelAndThinking`, hooks | KEEP (model/thinking precedence machinery; moves into PersonaRuntime unchanged) |
| `canLiveSwitchPersona` (5 module-eval sites) | KEEP, RENAME to `personaSwitchableLiveLoading` (~5 lines) |
| `canLiveSwitchPersona` (3 tool gates + 1 MCP gate) | DELETE, absorbed into policy reads |
| `spawnsDisabled()`, `mainSessionTools()` | KEEP (seed of `spawnable()` derivation) |
| `isToolGranted` (cursor.ts) | DELETE (predicate ownership moves but semantics unchanged) |
| `session.setSessionLspReadOnly`/`getSessionLspReadOnly` config hooks | DELETE (lspReadOnly derivable) |
| `reconcilePersistedPersona` (main.ts) | THIN WRAPPER → `runtime.reconcile()` |
| `applyPersonaToSession` (persona-apply.ts) | MOVE into PersonaRuntime (absorb module) |
| 3 apply-sequence copies (interactive-mode/builtin-modes/persona-apply) | CONSOLIDATE into PersonaRuntime.enter |
| 4 task-suppression copies | DELETE (policy's `task`-stripping at grant computation) |
| `clearInheritedProviderPromptCacheKey` on AgentSession | KEEP + wrap public (3 lines) |
| `lastAssistantUsage = undefined` UI clears | KEEP, add at persona switch call sites |
| Task/spawn orthogonal machinery | KEEP UNCHANGED (agent-tools.ts, discovery-snapshot.ts, spawn-policy, types) |
| Mode partition writers | KEEP UNCHANGED semantically (funnel consults policy) |

## Acceptance criteria (final — 12)

1. `--agent <name>`: persona tools/model/thinking/spawns/systemPrompt active from first turn; explicit CLI flags win.
2. `/agent`, `/switch-agent` live switch; ACP/Cursor work.
3. Exit restores pre-persona capability state (incl LSP read-only, Cursor behavior).
4. Resume restores from `mode_change`; reconcile drift-free.
5. Persona `spawns: []` → no `task` tool + no spawn affordance (one derivation).
6. Persona `tools: [read]` → no mutation anywhere.
7. Restricted persona-capable sessions never widen past CLI grant (MCP, extensions, RPC, memory).
8. Subagent spawn from persona session: parent's effective grant inherited; launch=live parity.
9. Mid-turn persona switch: tools/prompt apply immediately; model switch queues/notices per surface (TUI/ACP), matching today's behavior.
10. Enter/exit clears inherited provider prompt cache key + UI cache-miss marker (plan-mode parity).
11. Ad-hoc activations (`sessionToggles`) survive persona enter/exit.
12. Persona with unknown/disabled spawns advertises `task` (upstream-consistent don't-validate convention).

## Test plan — behavior contracts only

**Keep (verify pass-through; update only assertions that broke):**
agent-persona-switch, interactive-mode-persona-restore, print-rpc-persona-persistence, plan-entry-persona-rollback, sdk-tool-activation, launch-persona-affordances, launch-persona-first-system-prompt, cli-agent-flag, switch-agent-picker, cursor-exec, tools/index, session-fork-prompt-cache-key, cache-invalidation-marker.

**New policy-focused tests (behavioral, externally observable):**
- `policy-intersect.test.ts`: effective() contract for all 12 acceptance criteria (one probe per criterion).
- `persona-spawn-parity.test.ts` (NEW): acceptance 8 — launch --agent [read,task] spawns=['*'] vs live /agent → identical child envelopes.
- `persona-mid-turn.test.ts` (NEW): acceptance 9 — mid-turn switch queues model / applies tools.
- `persona-lsp-derivation.test.ts`: lspReadOnly explicit-CLI durable; persona [read] derives true; persona [read,write] derives false (regression for R3-scout P1-2); persona exit restores cli default.
- `persona-cache-clear.test.ts` (interactive-harness, R3 confirmation): enter → next turn has no cache-miss marker; provider cache invalidated.

**Migrate (assertions renamed, behavior same):**
- sdk-tool-activation.test.ts: `getPersonaToolRestriction` assertions → policy-derived equivalents (R3-task).
- agent-persona-switch.test.ts, switch-agent-picker.test.ts: remove snapshotPersonaSwitch field-by-field assertions (R3-seams).

**Delete (shadow-mechanics):**
- Persona-internal field assertions on baseline pair / residual restriction / dropped-mutation values.

**Do NOT add (R3-seams redundancy audit):**
- Separate spawnable() test — covered by `persona-spawn-parity.test.ts` and intersect probes.

## Rollout: 4 stages

**Stage 1 — Policy + Runtime + Transaction shells, aliasing existing shadow machinery.** Add `session/tool-policy.ts` (~120 lines), `session/persona-runtime.ts` (~250 lines), `PersonaSwitchTransaction` (~80 lines). Construct policy in sdk.ts at line 1908, pass via `AgentSessionConfig.toolPolicy`. Each existing shadow field becomes a read-through delegate (public getters on AgentSession/SessionTools call `policy.X()`); existing behavior tests pass unchanged (aliasing verified). Persona switch sites call `runtime.enter`/`runtime.exit`.

**Stage 2 — Launch-as-switch.** Delete `personaName`, `personaCliToolOverride`, `cliGrantRestrictsActive`, launch persona fork, launch-specific prompt matrix, baseline captures from launch path. `--agent` becomes stash+enter. `reconcilePersistedPersona` shrinks to `runtime.reconcile` call. ACP factory aligns. Migrate any launch tests pinning shadow internals to behavior equivalents.

**Stage 3 — Delete shadows + Cursor/tools/index cleanup.** Remove persona-* private fields; delete `expandRegistryToAllBuiltins`, `hubLifted`, `personaRequestsLsp/Hub`, `baselineLspEnabled/HubEnabled`, `launchPersonaLifts/SeedsRestriction`; rename `canLiveSwitchPersona` module-eval sites; structured-subagent.ts:425 reads policy; delete cursor.ts isToolGranted; consolidate apply-sequence copies. Wire `buildSubagentSessionOptions` to pass inherited grant.

**Stage 4 — Final consolidation.** persona-apply.ts absorbed into persona-runtime.ts; final oxfmt on touched files only; remove test scaffolding for shadow assertions; summary comment on PR.

## Risk register (final)

- **Launch atomicity**: enter persona before first-turn enablement.
- **Model resolution**: `modelPattern` seam carries persona model; journal writes correct model.
- **SessionToggles threading**: enumerated call sites (mcp-command-controller.ts:1365, runtime-init.ts:101, acp-agent.ts:2579, extension-ui-controller.ts:188/421, session-tools.ts:732/821/1840, persisted-revive.ts:189, executor.ts:3507). Each must notify the policy. Failing to thread one resurrects fmuwt class.
- **Snapshot/rollback layering**: PersonaSwitchTransaction is the single mechanism; no partial restores.
- **Module-eval flag** (`personaSwitchableLiveLoading`) renamed explicitly; never confused with tool gates.
- **Cursor deviceOnlyWrite carve-out**: preserved semantically.
- **LSP read-only default under restricted sessions**: construction-time `options.lspReadOnly ?? restrictToolNames` preserved (R3-scout P1-2 regression avoided).
- **Mode partition interplay**: persona suspends during modes (R4 decision). Snapshot+exit/restore via PersonaSwitchTransaction. Risk: mode-exit-restore must succeed even if mode's own partition restore failed; failure modes chained (mode partial restore + persona restore) need sequencing at the call site. Test `plan-entry-persona-rollback` covers.

## Deciding factor (final)

Four independent reviewers converged on the architecture; three rounds of amendments produced a design where every round-3 finding is either integrated or explicitly rejected as out of scope. The shadow-state bug class is structurally prevented by the layered intersect + single transaction. Diff lands ~1.6-2.2x smaller on persona-specific code; ~1.7-2.1x on total. Implementation is tractable (4 staged commits, each green-testable).
