/**
 * PersonaRuntime — single atomic persona switch transaction (plan §2, v4.1).
 *
 * All persona-owned state — policy persona grant, tool presentation, model/thinking,
 * append prompt, spawns, inherited provider cache key — is captured in one
 * `PersonaSwitchSnapshot` and restored symmetrically. This replaces the layered
 * policy/presentation/model restore composition; no partial restores survive a
 * failed switch.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { AgentSession } from "./agent-session";
import type { PersonaExplicitOverrides, PersonaModelApplyHooks } from "./persona-model-hooks";
import type { DiscoveredAgent, PolicySnapshot, SessionToolPolicy } from "./tool-policy";

/** A persona switch attempted while the session is mid-turn. */
export class PersonaSwitchError extends Error {
 constructor(message: string) {
  super(message);
  this.name = "PersonaSwitchError";
 }
}

/** Model + thinking level captured before a persona switch (restored on rollback). */
export interface ModelOverrideState {
 model: Model | undefined;
 thinkingLevel: ConfiguredThinkingLevel | undefined;
}

/**
 * Complete persona-switchable session state. Captured by
 * `PersonaRuntime.snapshot()`, restored by `PersonaRuntime.restore()`.
 */
export interface PersonaSwitchSnapshot {
 /** Policy persona grant + session tool toggles. */
 policy: PolicySnapshot;
 /** Presentation: top-level enabled tool names. */
 tools: readonly string[];
 /** Presentation: names mounted under `xd://`. */
 mountedToolNames: readonly string[];
 /** Model + thinking state before the switch. */
 baseModelOverride: ModelOverrideState;
 /** Persona append prompt (identity channel); `undefined` when inactive. */
 appendPrompt: string | undefined;
 /** Session spawn policy; `null` when unrestricted/unset. */
 spawns: string[] | "*" | null;
 /** Runtime model baseline owned by the active persona; `undefined` when none captured. */
 activeBaseline: ModelOverrideState | undefined;
}

/** The persona a `reconcile()` call wants active. */
export interface PersonaSwitchTarget {
 agent: DiscoveredAgent;
 explicit?: PersonaExplicitOverrides;
}

/**
 * Owns persona enter/exit/reconcile against one session. Constructed with the
 * session's `SessionToolPolicy`; the policy owns the effective tool set, the
 * runtime owns the switch transaction around it.
 */
export class PersonaRuntime {
 readonly policy: SessionToolPolicy;
 readonly session: AgentSession;

 constructor(policy: SessionToolPolicy, session: AgentSession) {
  this.policy = policy;
  this.session = session;
 }

 /**
  * The runtime-owned pre-enter model baseline (model + thinking), captured
  * immediately before the FIRST successful model apply of the active
  * persona (or after a successful apply when no baseline exists — a deferred
  * enter never captured one). Runtime-owned because the hook instance that
  * ran `apply` does not survive to exit: `exitAgentPersona` builds a fresh
  * hooks object whose `restore()` would be a no-op, leaving the persona's
  * model/thinking applied. Cleared on exit, on rollback, and before each
  * enter (re-enter recaptures).
  */
 #activeBaseline: ModelOverrideState | undefined;

 /**
  * Pre-chain baseline (fr-vV): the pre-persona model/thinking carried across
  * a mid-turn persona→persona switch. A mid-turn A→B switch runs while A's
  * exit already QUEUED its baseline restore (flushed only at turn end), so
  * the live model is still A's persona model — capturing it as B's baseline
  * would make B's exit restore A's persona model instead of the true pre-A
  * state. When the previous exit queued its restore, `#enterInner` adopts
  * this root as B's baseline instead of the live capture.
  *
  * Lifecycle: captured by `#exitInner` exactly when it QUEUES a restore
  * (the queued flush will land exactly this state); consumed by the next
  * deferred `#enterInner` (non-deferred enters drop it — the flush already
  * landed and the live session is authoritative); and spent by
  * `onPendingModelRestoreFlushed` when the surface that owns the queue
  * applies the restore. A rollback keeps it pending: the transaction
  * snapshot restores the pre-switch persona whose own queued restore is
  * still owed the root.
  *
  * A manual model change while a persona is active (`/model`, the picker)
  * re-roots for NON-deferred flows by construction: the user action mutates
  * the live session, and the persona's exit then captures that as its
  * baseline. For a mid-turn change between a deferred exit and the next
  * deferred enter, the queue owner's flush notification is what invalidates
  * the stale root (the flush lands before the user's pick, spending the
  * root; the enter then captures the live — user-chosen — session).
  */
 #rootBaseline: ModelOverrideState | undefined;

 /**
  * Activates a persona atomically: snapshot → apply → rollback on failure.
  *
  * Mid-turn semantics (plan §8, acceptance 9): the persona transaction — policy
  * grant flip, spawns, append prompt, tool presentation — applies IMMEDIATELY
  * even while the session streams; ONLY the model/thinking switch defers.
  * With `hooks.shouldDeferModelSwitch()` reporting defer, the model change goes
  * through `hooks.deferModelSwitchWhileStreaming` (TUI queues to
  * `#pendingModelSwitch`, ACP emits a notice) and the transaction completes
  * normally. Without deferral hooks, a mid-turn switch throws
  * {@link PersonaSwitchError} — the caller has no safe channel for the model
  * half, so the whole switch is refused.
  */
 async enter(
  agent: DiscoveredAgent,
  explicit: PersonaExplicitOverrides,
  hooks: PersonaModelApplyHooks,
 ): Promise<void> {
  const deferModel = this.session.isStreaming && (hooks.shouldDeferModelSwitch?.() ?? false);
  if (this.session.isStreaming && !deferModel) {
   throw new PersonaSwitchError("Cannot switch persona while the session is streaming");
  }
  const tx = await PersonaSwitchTransaction.begin(this);
  try {
   // Switching personas directly must not narrow cumulatively: the live
   // partition already reflects the PRIOR persona's grant, so filtering it
   // again would lose tools the old persona held but the new one re-grants.
   // Reset to the pre-persona baseline first (reconcile does the same via
   // its exit→enter pair).
   if (this.policy.isPersonaActive()) {
    await this.#exitInner(hooks, deferModel);
   }
   await this.#enterInner(agent, explicit, hooks, deferModel);
  } catch (err) {
   await this.restore(tx.snapshot);
   throw err;
  }
 }

 /**
  *
  * Model baseline ownership lives HERE, not in the hooks instance: exit
  * builds a fresh hooks object (its `restore()` would be a no-op), so the
  * runtime captures the pre-apply model/thinking itself and restores from
  * `#activeBaseline` in `#exitInner` and `restore()`. A deferred enter never
  * captured a baseline (the model stays until the surface flushes), so the
  * runtime baseline is simply absent for that persona — a later exit restores
  * nothing and the surface queue owns the pending persona model.
  *
  * Symmetric teardown of `enter`: snapshot the persona-active state, tear down,
  * rollback on failure. Mid-turn semantics mirror `enter`: policy/prompt/
  * spawns/presentation teardown applies immediately; the model restore defers
  * through `hooks.deferModelRestoreWhileStreaming` when the surface reports
  * defer (and skips silently without the hook — the deferred baseline is lost
  * rather than applied into a live turn). Without deferral hooks, a mid-turn
  * exit throws {@link PersonaSwitchError}.
  */
 async exit(hooks: PersonaModelApplyHooks): Promise<void> {
  const deferModel = this.session.isStreaming && (hooks.shouldDeferModelSwitch?.() ?? false);
  if (this.session.isStreaming && !deferModel) {
   throw new PersonaSwitchError("Cannot exit persona while the session is streaming");
  }
  const tx = await PersonaSwitchTransaction.begin(this);
  try {
   await this.#exitInner(hooks, deferModel);
  } catch (err) {
   await this.restore(tx.snapshot);
   throw err;
  }
 }

 /**
  * Shared entry for launch/resume/ACP factory: makes `desired` the active
  * persona, replacing whatever is currently active. Drift-free by construction.
  *
  * Atomicity: ONE pre-reconcile snapshot guards the whole exit→enter pair; if
  * enter fails, the session is restored to the state BEFORE the reconcile
  * (persona still active), not to the post-exit default.
  */
 async reconcile(desired: PersonaSwitchTarget, hooks: PersonaModelApplyHooks): Promise<void> {
  const deferModel = this.session.isStreaming && (hooks.shouldDeferModelSwitch?.() ?? false);
  if (this.session.isStreaming && !deferModel) {
   throw new PersonaSwitchError("Cannot reconcile persona while the session is streaming");
  }
  // ONE pre-reconcile snapshot guards the whole exit→enter pair: if enter
  // fails, the session is restored to the state BEFORE the reconcile (persona
  // still active), not to the post-exit default.
  const guard = await PersonaSwitchTransaction.begin(this);
  try {
   if (this.policy.isPersonaActive()) {
    await this.#exitInner(hooks, deferModel);
   }
   await this.#enterInner(desired.agent, desired.explicit ?? {}, hooks, deferModel);
  } catch (err) {
   await this.restore(guard.snapshot);
   throw err;
  }
 }

 /**
  * Captures all persona-switchable state. Public: plan/goal/vibe modes capture
  * the persona pre-partition and restore it on mode exit (plan §4).
  */
 async snapshot(): Promise<PersonaSwitchSnapshot> {
  return {
   policy: this.policy.snapshot(),
   tools: [...this.session.getEnabledToolNames()],
   mountedToolNames: [...this.session.getMountedXdevToolNames()],
   baseModelOverride: {
    model: this.session.model,
    thinkingLevel: this.session.configuredThinkingLevel(),
   },
   appendPrompt: this.session.getPersonaAppendPrompt(),
   // Capture the spawn policy as currently set: while a persona is active this
   // is the persona-owned override; with no persona active it is the host
   // config value, which `restore` re-pins via setSessionSpawns.
   spawns: this.session.getSessionSpawns(),
   activeBaseline: this.#activeBaseline,
  };
 }

 /**
  * Symmetric restore of `snapshot()` — the single rollback mechanism.
  * Model/thinking revert from the captured `baseModelOverride` directly, NOT
  * through `hooks.restore()`: the hook instance that ran `apply` does not
  * survive to the rollback site (exit/reconcile callers build fresh hooks),
  * so a hooks-only rollback would leave a half-applied switch. The runtime
  * baseline round-trips through the snapshot: a persona→persona switch whose
  * new enter fails rolls the surviving persona back WITH its baseline, so a
  * later exit still restores the pre-switch model. Prompt rebuild last: the
  * restored append prompt/policy shape what the next render shows, so a
  * rollback never serves a stale cached prompt.
  */
 async restore(snap: PersonaSwitchSnapshot): Promise<void> {
  this.policy.restore(snap.policy);
  await this.session.setActiveToolPresentation([...snap.tools], [...snap.mountedToolNames]);
  this.session.setSessionSpawns(snap.spawns);
  this.session.applyPersonaAppendPrompt(snap.appendPrompt);
  this.#activeBaseline = snap.activeBaseline;
  const { model, thinkingLevel } = snap.baseModelOverride;
  // P2-5: revert whenever the baseline CAPTURED a field — the baseline is the
  // pre-switch state, so `model: undefined` there means "the session had no
  // model before the switch" and must be restored to that, not skipped.
  // Skipping on undefined leaked the persona's model/thinking into the
  // restored session whenever the persona never declared them.
  if (model !== undefined && this.session.model !== model) {
   await this.session.setModel(model);
  }
  if (thinkingLevel !== undefined && this.session.configuredThinkingLevel() !== thinkingLevel) {
   this.session.setThinkingLevel(thinkingLevel);
  }
 }

 /**
  * Apply body shared by `enter` and `reconcile`. `deferModel` is the caller's
  * pre-computed mid-turn deferral decision.
  */
 async #enterInner(
  agent: DiscoveredAgent,
  explicit: PersonaExplicitOverrides,
  hooks: PersonaModelApplyHooks,
  deferModel: boolean,
 ): Promise<void> {
  // Plan-mode parity (plan §9): the persona append prompt changes the system
  // prompt, which predictably invalidates the provider cache.
  this.session.clearInheritedProviderPromptCacheKey();
  // Baseline BEFORE any flip — unconditional, including deferred enters
  // (P2-6): the persona may be mid-turn at enter time, but a LATER exit still
  // needs the pre-enter model/thinking to restore. The deferred enter's model
  // half (the persona's own switch) is queued on the surface; the baseline
  // answers a different question — what the session looked like BEFORE this
  // persona — and is only knowable here, before `enterPersona` runs.
  //
  // fr-vV: a mid-turn A→B switch runs while A's exit already QUEUED its
  // baseline restore (flushed only at turn end). The live model is still
  // A's persona model, so the naive live capture would record A's model
  // as B's baseline and B's exit would restore A's persona model. A
  // deferred enter adopts the pre-chain root instead — the state A's
  // queued flush will land, i.e. the true pre-A baseline. A non-deferred
  // enter runs after the turn ended (the queued restore already flushed),
  // so the live capture is authoritative and any stale root is dropped.
  // The root is only authoritative while a queued restore is pending:
  // the surface that owns the queue clears it via
  // onPendingModelRestoreFlushed once the flush lands (TUI). A
  // non-deferred enter runs after the turn ended — the flush already
  // happened, so the live capture is authoritative and the root is
  // dropped here regardless.
  const root = this.#rootBaseline;
  this.#rootBaseline = undefined;
  this.#activeBaseline = (deferModel ? root : undefined) ?? {
   model: this.session.model,
   thinkingLevel: this.session.configuredThinkingLevel(),
  };
  this.policy.enterPersona(agent, explicit);
  // Live presentation partition: keep only the currently-active tools the
  // persona grant still covers (plan §5 — the cursor bridge reads the live
  // partition, not a policy recomputation).
  const activeToolNames = this.session.getActiveToolNames();
  const activeMountedToolNames = this.session.getMountedXdevToolNames();
  await this.session.setActiveToolPresentation(
   activeToolNames.filter(name => this.policy.effective(name)),
   activeMountedToolNames.filter(name => this.policy.effective(name)),
  );
  this.session.setSessionSpawns(agent.spawns ?? null);
  this.session.applyPersonaAppendPrompt(agent.systemPrompt);
  if (deferModel) {
   hooks.deferModelSwitchWhileStreaming?.(agent);
  } else {
   await hooks.apply(agent, explicit);
  }
  await this.session.refreshBaseSystemPrompt();
 }

 /**
  * Notified by the surface that owns the deferred-model queue when a queued
  * persona model-restore has actually been applied to the session (e.g.
  * InteractiveMode.flushPendingModelSwitch). The bridged root baseline
  * describes the pre-chain state that flush lands; after it lands, a later
  * deferred enter must baseline from the live session — anything the user
  * changed in between is authoritative.
  */
 onPendingModelRestoreFlushed(): void {
  this.#rootBaseline = undefined;
 }

 /**
  * Teardown body shared by `exit` and `reconcile`. `deferModel` is the
  * caller's pre-computed mid-turn deferral decision.
  *
  * Model/thinking restore reads the RUNTIME-owned `#activeBaseline` (captured
  * by `#enterInner`), not `hooks.restore()`: the hook instance that ran
  * `apply` does not survive to exit — `exitAgentPersona` and the ACP/text
  * `/agent` path build fresh hooks whose per-instance baseline is empty, so a
  * hooks-only restore would silently leave the persona's model/thinking
  * applied. `hooks.restore()` is kept as a no-op-compatible surface channel
  * (a surface hooks impl may still queue/skip there).
  */
 async #exitInner(hooks: PersonaModelApplyHooks, deferModel: boolean): Promise<void> {
  this.session.clearInheritedProviderPromptCacheKey();
  this.policy.exitPersona();
  this.session.setSessionSpawns(null);
  this.session.applyPersonaAppendPrompt(undefined);
  // Restore presentation from the post-exit policy derivation, NOT the live
  // narrowed set: after `exitPersona` the grant is flipped, so `effectiveSet()`
  // is the unrestricted baseline — reading `getEnabledToolNames()` here would
  // re-present the persona's narrowed tools forever. `effectiveSet()` (unlike
  // the transaction snapshot) also respects sessionToggles the user flipped
  // mid-persona. Mounted presentation: the live mounted names intersected with
  // that baseline (mounted tools are session-mounted, not persona-owned).
  const baseline = this.policy.effectiveSet();
  await this.session.setActiveToolPresentation(
   [...baseline],
   [...this.session.getMountedXdevToolNames()].filter(name => baseline.has(name)),
  );
  const { model, thinkingLevel } = this.#activeBaseline ?? {};
  this.#activeBaseline = undefined;
  if (deferModel) {
   // fr-vV: this exit QUEUES its restore (flushed at turn end). Carry the
   // pre-persona state as the root so a mid-turn re-enter before the flush
   // baselines from the true pre-chain state, not the still-live persona
   // model. Non-deferred exits restore for real: the chain ends and the next
   // enter captures the live (post-restore) session directly.
   this.#rootBaseline = { model, thinkingLevel };
   // Mid-turn exit: the baseline must reach the surface queue, not a live
   // turn. The RUNTIME baseline is authoritative (hooks instances do not
   // survive exit); the surface channel receives it directly.
   hooks.deferModelRestoreWhileStreaming?.({ model, thinkingLevel });
  } else {
   if (model && this.session.model !== model) {
    await this.session.setModel(model);
   }
   if (thinkingLevel && this.session.configuredThinkingLevel() !== thinkingLevel) {
    this.session.setThinkingLevel(thinkingLevel);
   }
  }
  await this.session.refreshBaseSystemPrompt();
 }
}

/**
 * A captured persona state bound to its runtime. Modes open a transaction
 * before partitioning tools and roll back on mode exit; `PersonaRuntime`
 * uses the same mechanism internally for atomic enter/exit.
 */
export class PersonaSwitchTransaction {
 readonly snapshot: PersonaSwitchSnapshot;
 #runtime: PersonaRuntime;

 constructor(runtime: PersonaRuntime, snapshot: PersonaSwitchSnapshot) {
  this.#runtime = runtime;
  this.snapshot = snapshot;
 }

 /** Captures the runtime's current persona state. */
 static async begin(runtime: PersonaRuntime): Promise<PersonaSwitchTransaction> {
  return new PersonaSwitchTransaction(runtime, await runtime.snapshot());
 }

 /** Restores the captured state through the runtime's single restore path. */
 async rollback(): Promise<void> {
  await this.#runtime.restore(this.snapshot);
 }
}
