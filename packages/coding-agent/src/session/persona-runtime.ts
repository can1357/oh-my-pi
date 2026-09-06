/**
 * PersonaRuntime — single atomic persona switch transaction (plan §2, v4.1).
 *
 * All persona-owned state — policy persona grant, tool presentation, model/thinking,
 * append prompt, spawns, inherited provider cache key — is captured in one
 * `PersonaSwitchSnapshot` and restored symmetrically. This replaces the layered
 * policy/presentation/model restore composition; no partial restores survive a
 * failed switch.
 */
import { logger } from "@oh-my-pi/pi-utils";
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
	/** Pre-enter presentation captured by the active persona's enter (j2l). */
	activePresentationSnapshot: { tools: readonly string[]; mountedToolNames: readonly string[] } | undefined;
	/** Tool-registry names at the active persona's enter (j2l merge). */
	enterRegistryNames: ReadonlySet<string> | undefined;
}

/** The persona a `reconcile()` call wants active. */
export interface PersonaSwitchTarget {
	agent: DiscoveredAgent;
	explicit?: PersonaExplicitOverrides;
	/**
	 * Authoritative pre-persona baseline (j2g): carried through resume from the
	 * persona's journal entry. When present it REPLACES the live capture as the
	 * enter baseline — a resumed session's live model/thinking are the
	 * persona-produced state, not the pre-persona state.
	 */
	baselineOverride?: ModelOverrideState;
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
	 * Presentation snapshot captured when the CURRENT persona's enter partitioned
	 * the live tools (j2l). Exit restores from here — the pre-enter presentation,
	 * including user/extension deactivations made before the persona entered —
	 * instead of the post-exit policy derivation, which collapses to the
	 * unrestricted default set. Cleared on exit and recaptured per enter;
	 * round-trips through `snapshot()`/`restore()` so rollback reinstates the
	 * surviving persona's own entry snapshot.
	 */
	#activePresentationSnapshot: { tools: readonly string[]; mountedToolNames: readonly string[] } | undefined;
	/**
	 * Tool registry names at enter time (j2l merge). The frozen pre-enter
	 * presentation snapshot cannot contain tools REGISTERED while the persona was
	 * active — exit would drop them. A name in the live registry but absent here
	 * was registered mid-persona; exit unions it into the restored presentation
	 * (the post-exit effective set already decides default-active/toggled state).
	 * Cleared on exit and recaptured per enter; round-trips through
	 * `snapshot()`/`restore()` so rollback reinstates the surviving persona's
	 * own entry registry.
	 */
	#enterRegistryNames: ReadonlySet<string> | undefined;

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
		const txSnapshot = await this.snapshot();
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
			await this.restore(txSnapshot);
			throw err;
		}
	}

	/**
	 * Model baseline ownership lives HERE, not in the hooks instance: exit
	 * builds a fresh hooks object (its `restore()` would be a no-op), so the
	 * runtime captures the pre-apply model/thinking itself — UNCONDITIONALLY,
	 * including deferred enters (P2-6: a persona entered mid-turn still needs
	 * the pre-enter baseline for its later exit) — and restores from
	 * `#activeBaseline` in `#exitInner` and `restore()`.
	 *
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
		const txSnapshot = await this.snapshot();
		try {
			await this.#exitInner(hooks, deferModel);
		} catch (err) {
			await this.restore(txSnapshot);
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
		const guardSnapshot = await this.snapshot();
		try {
			if (this.policy.isPersonaActive()) {
				await this.#exitInner(hooks, deferModel);
			}
			await this.#enterInner(desired.agent, desired.explicit ?? {}, hooks, deferModel, desired.baselineOverride);
		} catch (err) {
			await this.restore(guardSnapshot);
			throw err;
		}
	}

	// j2g: capture the baseline the CALLER must journal (runtime stays pure):
	// the pre-persona model/thinking this enter just recorded, so a resume can
	// re-enter with it as the authoritative baseline instead of re-capturing the
	// persona-produced live state.
	getActiveBaseline(): ModelOverrideState | undefined {
		return this.#activeBaseline;
	}

	/**
	 * Captures all persona-switchable state. Public: plan/goal/vibe modes and
	 * the session-level switch teardown capture the CURRENT persona state
	 * before their own teardown; mode entry and persona switching are mutually
	 * exclusive (each side refuses while the other is active — the recovery
	 * path is the always-available persona exit), so a captured snapshot
	 * describes the pre-transition state, restored on rollback.
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
			activePresentationSnapshot: this.#activePresentationSnapshot,
			enterRegistryNames: this.#enterRegistryNames,
		};
	}

	/**
	 * Symmetric restore of `snapshot()` — the single rollback mechanism.
	 * Model/thinking revert from the captured `baseModelOverride` directly —
	 * the hook instance that ran `apply` does not survive to the rollback site
	 * (exit/reconcile callers build fresh hooks), so no hooks channel exists.
	 * The runtime baseline round-trips through the snapshot: a persona→persona
	 * switch whose new enter fails rolls the surviving persona back WITH its
	 * baseline, so a later exit still restores the pre-switch model. Prompt
	 * rebuild last: the restored append prompt/policy shape what the next render
	 * shows, so a rollback never serves a stale cached prompt.
	 */
	async restore(snap: PersonaSwitchSnapshot): Promise<void> {
		this.policy.restore(snap.policy);
		await this.session.setActiveToolPresentation([...snap.tools], [...snap.mountedToolNames]);
		this.session.setSessionSpawns(snap.spawns);
		this.session.applyPersonaAppendPrompt(snap.appendPrompt);
		this.#activeBaseline = snap.activeBaseline;
		this.#activePresentationSnapshot = snap.activePresentationSnapshot
			? {
					tools: [...snap.activePresentationSnapshot.tools],
					mountedToolNames: [...snap.activePresentationSnapshot.mountedToolNames],
				}
			: undefined;
		this.#enterRegistryNames = snap.enterRegistryNames;
		const { model, thinkingLevel } = snap.baseModelOverride;
		// j2o: revert whenever the baseline CAPTURED a field — `undefined` there
		// means "the session had no model / no configured thinking before the
		// switch" and must be restored to that, not skipped (a truthiness guard
		// leaks the persona's model/thinking into the restored session).
		// j2q: the revert is runtime-driven, not a user pick — the persona may be
		// REINSTATED at this point (a failed A→B switch restores A's policy), so
		// AgentSession's setters would otherwise see an active persona and re-root
		// #activeBaseline to the reverted value, mis-attributing the restore.
		this.#applyingPersonaModel = true;
		try {
			if (model !== undefined && this.session.model !== model) {
				await this.session.setModel(model);
			}
			if (this.session.configuredThinkingLevel() !== thinkingLevel) {
				this.session.setThinkingLevel(thinkingLevel);
			}
		} finally {
			this.#applyingPersonaModel = false;
		}
		// oeb: setActiveToolPresentation only rebuilds the system prompt when the
		// tool SIGNATURE changed; the append prompt / model / thinking restores
		// above change what the prompt shows without touching that signature. A
		// trailing refresh lands the rebuilt prompt unconditionally (idempotent —
		// signature-identical rebuilds are skipped inside the session).
		await this.session.refreshBaseSystemPrompt();
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
		baselineOverride?: ModelOverrideState,
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
		// j2g: a resume reconcile passes the PRE-persona baseline captured at the
		// original enter (persisted in the journal); it is authoritative — the
		// live session state is persona-produced, not pre-persona.
		this.#activeBaseline = baselineOverride ??
			(deferModel ? root : undefined) ?? {
				model: this.session.model,
				thinkingLevel: this.session.configuredThinkingLevel(),
			};
		this.policy.enterPersona(agent, explicit);
		// j2l: capture the PRE-ENTER presentation (the full enabled set incl.
		// mounted, before the persona narrows it) so exit can restore exactly it,
		// preserving user/extension deactivations made before the persona.
		this.#activePresentationSnapshot = {
			tools: this.session.getEnabledToolNames(),
			mountedToolNames: this.session.getMountedXdevToolNames(),
		};
		// j2l merge: the registry BEFORE the persona entered — exit unions names
		// registered MID-persona back into the restored presentation.
		this.#enterRegistryNames = new Set(this.session.getAllToolNames());
		// Live presentation partition: keep only the currently-ENABLED tools the
		// persona grant still covers (plan §5 — the cursor bridge reads the live
		// partition, not a policy recomputation). The SOURCE set must be the full
		// enabled set (j2i): `getActiveToolNames()` is provider-facing only — it
		// excludes mounted `xd://` names, so filtering it would silently unmount
		// every mounted device on enter. `setActiveToolPresentation` re-derives
		// the top-level vs mounted split from the mounted subset passed below.
		await this.session.setActiveToolPresentation(
			this.session.getEnabledToolNames().filter(name => this.policy.effective(name)),
			this.session.getMountedXdevToolNames().filter(name => this.policy.effective(name)),
		);
		this.session.setSessionSpawns(agent.spawns ?? null);
		this.session.applyPersonaAppendPrompt(agent.systemPrompt);
		if (deferModel) {
			hooks.deferModelSwitchWhileStreaming?.(agent);
		} else {
			// j2p: mark the persona's OWN model apply so AgentSession's model
			// setters can discriminate it from a user /model pick (which must
			// re-root the baseline instead of being treated as persona state).
			this.#applyingPersonaModel = true;
			try {
				await hooks.apply(agent, explicit);
			} finally {
				this.#applyingPersonaModel = false;
			}
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
	 * j2p: true while the persona's OWN model apply (hooks.apply inside
	 * #enterInner) is running. AgentSession.setModel/setModelTemporary consult
	 * this to tell the persona's self-applied model from a USER pick made under
	 * the persona: a user pick re-roots #activeBaseline via
	 * noteUserModelChange, so the persona's exit restores the user's newer
	 * model instead of the stale pre-enter one.
	 */
	#applyingPersonaModel = false;

	/**
	 * j2r: invoked by `noteUserModelChange` after a successful re-root, so the
	 * host can persist the rerooted baseline (append a fresh `mode_change
	 * agent` journal entry — the reader takes the LAST entry). Wired once by
	 * the session factory via `setBaselineRerootCallback`; absent on test
	 * stubs and persona-incapable sessions.
	 */
	#onBaselineRerooted: (() => void) | undefined;

	get isApplyingPersonaModel(): boolean {
		return this.#applyingPersonaModel;
	}

	/** j2r: wires the journal-persistence callback (session factory). */
	setBaselineRerootCallback(callback: () => void): void {
		this.#onBaselineRerooted = callback;
	}

	/**
	 * j2p: a USER model/thinking change landed while this persona is active.
	 * Re-roots the runtime-owned baseline: exit restores the user's model, not
	 * the pre-enter one. Called by AgentSession's model setters (never by the
	 * runtime's own apply — the #applyingPersonaModel guard discriminates).
	 *
	 * j2r: the reroot is PERSISTED through `#onBaselineRerooted` so a resume
	 * re-enters with the user's baseline: the callback (wired by the session
	 * factory) appends a fresh `mode_change agent` journal entry carrying the
	 * updated baseline — the reader takes the LAST entry. Only fires when the
	 * re-root actually captured a baseline; a deferred enter (no baseline)
	 * stays callback-free, and the runtime's own restore/apply never journals.
	 */
	noteUserModelChange(): void {
		if (this.#activeBaseline === undefined) return;
		this.#activeBaseline = {
			model: this.session.model,
			thinkingLevel: this.session.configuredThinkingLevel(),
		};
		// The model switch already landed; a throwing persistence callback must
		// not turn a successful switch into an error or skip the caller's
		// trailing prompt refresh. Journal appends are non-throwing today; the
		// guard is for future callback shapes.
		try {
			this.#onBaselineRerooted?.();
		} catch (error) {
			logger.warn("Failed to persist a rerooted persona baseline", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	/**
	 * Teardown body shared by `exit` and `reconcile`. `deferModel` is the
	 * caller's pre-computed mid-turn deferral decision.
	 *
	 * Model/thinking restore reads the RUNTIME-owned `#activeBaseline` (captured
	 * by `#enterInner`): the hook instance that ran `apply` does not survive to
	 * exit — `exitAgentPersona` and the ACP/text `/agent` path build fresh hooks,
	 * so no hooks restore channel exists.
	 */
	async #exitInner(hooks: PersonaModelApplyHooks, deferModel: boolean): Promise<void> {
		this.session.clearInheritedProviderPromptCacheKey();
		this.policy.exitPersona();
		this.session.setSessionSpawns(null);
		this.session.applyPersonaAppendPrompt(undefined);
		const snapshot = this.#activePresentationSnapshot;
		this.#activePresentationSnapshot = undefined;
		const enterRegistry = this.#enterRegistryNames;
		this.#enterRegistryNames = undefined;
		if (snapshot) {
			// j2l merge: the frozen pre-enter snapshot must not discard tools
			// REGISTERED while the persona was active — an extension that landed
			// mid-persona would vanish at exit (the frozen list cannot contain it).
			// A live-registry name ABSENT from the enter-registry snapshot was
			// registered mid-persona; union it with the restored presentation. The
			// post-exit effective set (policy already exited → the unrestricted
			// baseline: registry ∩ cliGrant ∩ toggles, via the isDefaultActive seed)
			// decides its default-active state, so a default-inactive registration
			// stays dormant. A tool DEACTIVATED before the persona entered is in
			// neither the snapshot nor the baseline and stays off.
			const merged = [...snapshot.tools];
			const mergedMounted = [...snapshot.mountedToolNames];
			const baseline = this.policy.effectiveSet();
			for (const name of baseline) {
				if (!enterRegistry?.has(name) && !merged.includes(name)) merged.push(name);
			}
			for (const name of this.session.getMountedXdevToolNames()) {
				if (baseline.has(name) && !enterRegistry?.has(name) && !mergedMounted.includes(name)) {
					mergedMounted.push(name);
				}
			}
			await this.session.setActiveToolPresentation(merged, mergedMounted);
		} else {
			const baseline = this.policy.effectiveSet();
			await this.session.setActiveToolPresentation(
				[...baseline],
				[...this.session.getMountedXdevToolNames()].filter(name => baseline.has(name)),
			);
		}
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
			// j2o: restore even when the baseline field is `undefined` — that is
			// the state the session was in before the persona applied its model.
			// j2q: runtime-driven, so the re-entrancy flag must suppress
			// AgentSession's note-on-set (same suppression #enterInner's apply
			// path uses): without it the persona's own restore would be treated
			// as a user pick and re-root the just-consumed baseline.
			this.#applyingPersonaModel = true;
			try {
				if (model !== undefined && this.session.model !== model) {
					await this.session.setModel(model);
				}
				if (this.session.configuredThinkingLevel() !== thinkingLevel) {
					this.session.setThinkingLevel(thinkingLevel);
				}
			} finally {
				this.#applyingPersonaModel = false;
			}
		}
		await this.session.refreshBaseSystemPrompt();
	}
}
