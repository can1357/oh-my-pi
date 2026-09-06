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
import {
	applyPersonaModelAndThinking,
	type PersonaExplicitOverrides,
	type PersonaModelApplyHooks,
} from "./persona-model-hooks";
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
	/** Whether the UI cache-miss marker (`lastAssistantUsage`) was cleared at switch time. */
	lastAssistantUsageCleared: boolean;
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
			await this.restore(tx.snapshot, hooks);
			throw err;
		}
	}

	/**
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
			await this.restore(tx.snapshot, hooks);
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
			await this.restore(guard.snapshot, hooks);
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
			// TODO(stage-2): UI marker state is mode-layer-owned (plan §9 — the runtime
			// never reaches the UI); captured as `false` until call-site wiring lands.
			lastAssistantUsageCleared: false,
		};
	}

	/**
	 * Symmetric restore of `snapshot()` — the single rollback mechanism.
	 * With hooks, model/thinking flow through `hooks.restore()` (the session-bound
	 * baseline channel). Without, the captured `baseModelOverride` reverts the
	 * model/thinking directly so a rollback never leaves a half-applied switch.
	 * The prompt rebuild last: the restored append prompt/policy shape what the
	 * next render shows, so a rollback never serves a stale cached prompt.
	 */
	async restore(snap: PersonaSwitchSnapshot, hooks?: PersonaModelApplyHooks): Promise<void> {
		this.policy.restore(snap.policy);
		await this.session.setActiveToolPresentation([...snap.tools], [...snap.mountedToolNames]);
		this.session.setSessionSpawns(snap.spawns);
		this.session.applyPersonaAppendPrompt(snap.appendPrompt);
		if (hooks) {
			await hooks.restore();
		} else {
			const { model, thinkingLevel } = snap.baseModelOverride;
			if (model && this.session.model !== model) {
				await this.session.setModel(model);
			}
			if (thinkingLevel && this.session.configuredThinkingLevel() !== thinkingLevel) {
				this.session.setThinkingLevel(thinkingLevel);
			}
		}
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
	): Promise<void> {
		// Plan-mode parity (plan §9): the persona append prompt changes the system
		// prompt, which predictably invalidates the provider cache.
		this.session.clearInheritedProviderPromptCacheKey();
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
		await applyPersonaModelAndThinking(agent, explicit, hooks, deferModel);
		await this.session.refreshBaseSystemPrompt();
	}

	/**
	 * Teardown body shared by `exit` and `reconcile`. `deferModel` is the
	 * caller's pre-computed mid-turn deferral decision.
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
		if (deferModel) {
			hooks.deferModelRestoreWhileStreaming?.();
		} else {
			await hooks.restore();
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
