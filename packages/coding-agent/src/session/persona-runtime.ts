/**
 * PersonaRuntime — single atomic persona switch transaction (plan §2, v4.1).
 *
 * All persona-owned state — policy persona grant, tool presentation, model/thinking,
 * append prompt, spawns, inherited provider cache key — is captured in one
 * `PersonaSwitchSnapshot` and restored symmetrically, exactly like Plan Mode.
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
	/** Pre-enter presentation captured by the active persona's enter. */
	activePresentationSnapshot: { tools: readonly string[]; mountedToolNames: readonly string[] } | undefined;
	/** Tool registry names at enter time (j2l merge). */
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
	 * Pre-persona model baseline (model + thinking), captured on the first enter
	 * (or deserialized on resume). Preserved across A -> B switches, matching Plan Mode.
	 * Exiting restores this baseline.
	 */
	#activeBaseline: ModelOverrideState | undefined;

	/**
	 * Pre-persona tool presentation snapshot captured on the first enter.
	 * Preserved across A -> B switches. Exiting restores this snapshot directly.
	 */
	#activePresentationSnapshot: { tools: readonly string[]; mountedToolNames: readonly string[] } | undefined;

	/** Tool registry names at enter time for j2l merge. */
	#enterRegistryNames: ReadonlySet<string> | undefined;

	/** Pre-chain baseline across a mid-turn persona switch (fr-vV). */
	#deferredExitBaseline: ModelOverrideState | undefined;

	/**
	 * Activates a persona atomically: snapshot → apply → rollback on failure.
	 */
	async enter(
		agent: DiscoveredAgent,
		explicit: PersonaExplicitOverrides,
		hooks: PersonaModelApplyHooks,
		baselineOverride?: ModelOverrideState,
	): Promise<void> {
		const deferModel = this.session.isStreaming && (hooks.shouldDeferModelSwitch?.() ?? false);
		if (this.session.isStreaming && !deferModel) {
			throw new PersonaSwitchError("Cannot switch persona while the session is streaming");
		}
		const txSnapshot = await this.snapshot();
		try {
			if (this.policy.isPersonaActive()) {
				await this.#exitInner(hooks, deferModel);
			}
			await this.#enterInner(agent, explicit, hooks, deferModel, baselineOverride);
		} catch (err) {
			await this.restore(txSnapshot);
			hooks.onPersonaSwitchFailed?.();
			throw err;
		}
	}

	/**
	 * Exits the active persona: restores pre-persona tools, model, thinking,
	 * clears spawns and append prompt.
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
			hooks.onPersonaSwitchFailed?.();
			throw err;
		}
	}

	/**
	 * Reconciles the session toward `desired`.
	 */
	async reconcile(desired: PersonaSwitchTarget | undefined, hooks: PersonaModelApplyHooks): Promise<void> {
		const current = this.policy.snapshot().persona;
		const deferModel = this.session.isStreaming && (hooks.shouldDeferModelSwitch?.() ?? false);
		if (this.session.isStreaming && !deferModel) {
			throw new PersonaSwitchError("Cannot reconcile persona while the session is streaming");
		}
		const txSnapshot = await this.snapshot();
		try {
			if (!desired) {
				if (this.policy.isPersonaActive()) {
					await this.#exitInner(hooks, deferModel);
				}
				return;
			}
			const sameAgent = current && current.agent.name === desired.agent.name;
			const sameExplicit = current && JSON.stringify(current.explicit) === JSON.stringify(desired.explicit ?? {});
			if (sameAgent && sameExplicit) {
				return;
			}
			if (this.policy.isPersonaActive()) {
				await this.#exitInner(hooks, deferModel);
			}
			await this.#enterInner(desired.agent, desired.explicit ?? {}, hooks, deferModel, desired.baselineOverride);
		} catch (err) {
			await this.restore(txSnapshot);
			hooks.onPersonaSwitchFailed?.();
			throw err;
		}
	}

	getActiveBaseline(): ModelOverrideState | undefined {
		return this.#activeBaseline;
	}

	/**
	 * Adopts a persisted pre-persona baseline for the CURRENTLY active persona
	 * (branch landing on an earlier activation of the same persona with a
	 * different recorded baseline). The eventual exit restores the adopted
	 * baseline instead of the live-captured one.
	 */
	adoptBaselineOverride(baseline: ModelOverrideState): void {
		this.#activeBaseline = baseline;
	}

	/** Clears the deferred exit baseline once the surface flushes the queued restore. */
	onPendingModelRestoreFlushed(): void {
		this.#deferredExitBaseline = undefined;
	}
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
			spawns: this.session.getSessionSpawns(),
			activeBaseline: this.#activeBaseline,
			activePresentationSnapshot: this.#activePresentationSnapshot,
			enterRegistryNames: this.#enterRegistryNames,
		};
	}

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
		if (model !== undefined && this.session.model !== model) {
			await this.session.setModel(model);
		}
		if (this.session.configuredThinkingLevel() !== thinkingLevel) {
			this.session.setThinkingLevel(thinkingLevel);
		}
		await this.session.refreshBaseSystemPrompt();
	}

	async #enterInner(
		agent: DiscoveredAgent,
		explicit: PersonaExplicitOverrides,
		hooks: PersonaModelApplyHooks,
		deferModel: boolean,
		baselineOverride?: ModelOverrideState,
	): Promise<void> {
		this.session.clearInheritedProviderPromptCacheKey();
		// Capture pre-persona baseline if not already active (or overridden on resume)
		if (!this.#activeBaseline) {
			const deferred = deferModel ? this.#deferredExitBaseline : undefined;
			this.#deferredExitBaseline = undefined;
			this.#activeBaseline = baselineOverride ??
				deferred ?? {
					model: this.session.model,
					thinkingLevel: this.session.configuredThinkingLevel(),
				};
		}
		if (!this.#activePresentationSnapshot) {
			this.#activePresentationSnapshot = {
				tools: this.session.getEnabledToolNames(),
				mountedToolNames: this.session.getMountedXdevToolNames(),
			};
		}
		this.#enterRegistryNames = new Set(this.session.getAllToolNames());
		this.policy.enterPersona(agent, explicit);
		await this.session.setActiveToolPresentation(
			this.session.getEnabledToolNames().filter(name => this.policy.granted(name)),
			this.session.getMountedXdevToolNames().filter(name => this.policy.granted(name)),
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
			// j2l merge: restore pre-enter snapshot tools plus any tool registered
			// mid-persona by an extension.
			const baseline = this.policy.effectiveSet();
			const merged = [...snapshot.tools];
			for (const name of baseline) {
				if (!enterRegistry?.has(name) && !merged.includes(name)) {
					merged.push(name);
				}
			}
			const mergedMounted = [...snapshot.mountedToolNames];
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
			this.#deferredExitBaseline = { model, thinkingLevel };
			hooks.deferModelRestoreWhileStreaming?.({ model, thinkingLevel });
		} else {
			this.#deferredExitBaseline = undefined;
			if (model !== undefined && this.session.model !== model) {
				await this.session.setModel(model);
			}
			if (this.session.configuredThinkingLevel() !== thinkingLevel) {
				this.session.setThinkingLevel(thinkingLevel);
			}
		}
		await this.session.refreshBaseSystemPrompt();
	}
}
