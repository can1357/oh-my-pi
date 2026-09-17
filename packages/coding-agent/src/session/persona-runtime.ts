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
	/**
	 * The pre-chain exit baseline an in-flight mid-turn exit parked for the NEXT
	 * enter. Rolled back with the transaction: a failed enter CONSUMED it (and
	 * its own baseline capture then ran against the still-live persona model),
	 * so the retry must find it in the slot again.
	 */
	deferredExitBaseline: ModelOverrideState | undefined;
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
			const exitedInTransaction = this.policy.isPersonaActive();
			if (exitedInTransaction) {
				await this.#exitInner(hooks, deferModel);
			}
			await this.#enterInner(agent, explicit, hooks, deferModel, baselineOverride, exitedInTransaction);
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
			const exitedInTransaction = this.policy.isPersonaActive();
			if (exitedInTransaction) {
				await this.#exitInner(hooks, deferModel);
			}
			await this.#enterInner(
				desired.agent,
				desired.explicit ?? {},
				hooks,
				deferModel,
				desired.baselineOverride,
				exitedInTransaction,
			);
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
			deferredExitBaseline: this.#deferredExitBaseline,
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
		this.#deferredExitBaseline = snap.deferredExitBaseline;
		this.#activePresentationSnapshot = snap.activePresentationSnapshot
			? {
					tools: [...snap.activePresentationSnapshot.tools],
					mountedToolNames: [...snap.activePresentationSnapshot.mountedToolNames],
				}
			: undefined;
		// A snapshot that carries no enter-registry names (the restore() field
		// was introduced after the snapshot was taken, or a caller-built
		// snapshot) falls back to the registry as the session presents it NOW:
		// the names the rolled-back persona is about to present were registered
		// at or before ITS enter, so the eventual exit merge must treat them as
		// pre-enter — only genuinely later registrations ride the j2l merge.
		// Reusing a PREVIOUS persona's enter names instead would drop
		// activations the rolled-back persona's enter captured (an
		// already-registered default-inactive tool enabled via /mcp or RPC
		// set-tools would vanish from the exit restore).
		this.#enterRegistryNames = snap.enterRegistryNames ?? new Set(this.session.getAllToolNames());
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
		exitedInTransaction = false,
	): Promise<void> {
		this.session.clearInheritedProviderPromptCacheKey();
		// A non-deferred (pre-turn) enter supersedes any model mutation the
		// SURFACE still has queued for its next boundary (TUI pending switch,
		// session-level ACP slot — both reachable from a RETAINED failed flush):
		// it must not land mid-persona later. Provenance decides what it was:
		// - TRUE FIRST enter: the entry can only be an exit restore whose flush
		//   failed, so the live model is still the old persona's — ADOPT the
		//   owed baseline into the capture below (dropping it would delete the
		//   only copy of the true base).
		// - chained enter (this transaction ran #exitInner): that exit already
		//   restored the true baseline synchronously, so the queued entry is a
		//   stale persona-MODEL SWITCH, not a restore — DROP it without
		//   adopting; binding the new persona's exit to a model no persona ever
		//   landed on is the regression adopting it causes.
		// A mid-turn (deferred) enter takes the #deferredExitBaseline channel
		// and leaves the surface queue untouched for its own transaction.
		// Surfaces that keep a queue the session itself does not carry (TUI)
		// override the channel; otherwise fall back to the session-level slot.
		const readOwed = hooks.getSurfaceDeferredRestore ?? (() => this.session.getDeferredModelRestore?.());
		const dropOwed = hooks.clearSurfaceDeferredRestore ?? (() => this.session.clearDeferredModelRestore?.());
		const owed = deferModel ? undefined : readOwed();
		if (owed?.model) dropOwed();
		// Capture pre-persona baseline if not already active (or overridden on resume)
		if (!this.#activeBaseline) {
			const deferred = deferModel ? this.#deferredExitBaseline : undefined;
			this.#deferredExitBaseline = undefined;
			this.#activeBaseline =
				baselineOverride ??
				deferred ??
				(owed?.model && !exitedInTransaction
					? { model: owed.model, thinkingLevel: owed.thinkingLevel }
					: {
							model: this.session.model,
							thinkingLevel: this.session.configuredThinkingLevel(),
						});
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
		// The persona grant must be read BEFORE exitPersona() clears the layer:
		// it decides what the live enabled set can speak for in the merge below.
		const personaGrant = this.policy.snapshot().persona?.grant ?? null;
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
			const preEnter = new Set([...snapshot.tools, ...snapshot.mountedToolNames]);
			// j2l merge, three halves:
			// - Tools REGISTERED mid-persona (absent from the enter-time registry)
			//   ride the merge — the frozen pre-enter snapshot cannot hold them.
			// - A name the user ACTIVATED mid-persona (present in the enter
			//   registry but NOT in the pre-enter presentation — an already
			//   registered default-inactive tool turned on via /mcp or RPC
			//   set-tools) must SURVIVE: consulting only the registry drops it.
			//   The live enabled set still carries the activation (the exit's own
			//   funnel apply is the call below), so union it in.
			// - A name the user DEACTIVATED mid-persona must STAY deactivated: the
			//   baseline (an effectiveSet() over the live registry) holds every
			//   enter-time name, so the snapshot seed alone resurrects it. The
			//   persona grant attributes the live absence: a persona-GRANTED
			//   missing name is a user toggle (keep it off), a persona-DENIED one
			//   was stripped by the persona's own narrowing — the toggle funnel
			//   rejects re-activating a persona-denied tool — so the live set
			//   cannot speak for the user there and the frozen snapshot restores
			//   it (the exit funnel re-filters granted() either way). The mounted
			//   seed keeps the pre-enter presentation verbatim: an xd:// mount is
			//   never a `/mcp` toggle target, and dropping it here would unmount
			//   the pre-persona device when its name is absent from the live
			//   mounted set for any other reason.
			const live = new Set(this.session.getEnabledToolNames());
			const merged: string[] = [];
			for (const name of snapshot.tools) {
				if ((personaGrant === null || personaGrant.has(name)) && !live.has(name)) continue;
				merged.push(name);
			}
			for (const name of baseline) {
				// A name the user ACTIVATED mid-persona (an already-registered
				// default-inactive tool turned on via /mcp or RPC) sits in neither
				// the snapshot nor the effective() baseline — effective() folds in
				// the default-activity layer, which answers "on by default", not
				// "may it run". The live enabled set still carries the activation
				// (this exit's own funnel apply is the call below), so union in
				// every live tool the persona grant permits. The persona-grant
				// conjunct is load-bearing: without it a persona-DENIED tool the
				// user forced on mid-persona would leak past the exit merge.
				if (live.has(name) && !preEnter.has(name) && (personaGrant === null || personaGrant.has(name))) {
					if (!merged.includes(name)) merged.push(name);
					continue;
				}
				if (enterRegistry?.has(name) ? live.has(name) && !preEnter.has(name) : !merged.includes(name)) {
					merged.push(name);
				}
			}
			const mergedMounted = [...snapshot.mountedToolNames];
			for (const name of this.session.getMountedXdevToolNames()) {
				if (
					baseline.has(name) &&
					(enterRegistry?.has(name) ? live.has(name) && !preEnter.has(name) : true) &&
					!mergedMounted.includes(name)
				) {
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
