import { type Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ProviderSessionState, ServiceTier, ServiceTierByFamily, ServiceTierFamily } from "@oh-my-pi/pi-ai";
import {
	clearAnthropicFastModeFallback,
	Effort,
	isAnthropicFastModeFallbackDisabled,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
} from "@oh-my-pi/pi-ai";
import { isFireworksFastModelId } from "@oh-my-pi/pi-catalog/fireworks-model-id";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { classifyDifficulty } from "../auto-thinking/classifier";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { getKnownRoleIds } from "../config/model-roles";
import { buildServiceTierByFamily, SERVICE_TIER_FAMILIES } from "../config/service-tier";
import type { Settings } from "../config/settings";
import { containsUltrathink } from "../modes/ultrathink";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampAutoThinkingEffort,
	clampThinkingLevelToCeiling,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";
import type { EditMode } from "../utils/edit-mode";
import type { AgentSessionEvent } from "./agent-session-events";
import type { ModelCycleResult, ResolvedRoleModel, RoleModelCycle, RoleModelCycleResult } from "./agent-session-types";
import { formatRoleModelValue, resolveRoleModelFull } from "./role-models";
import { EPHEMERAL_MODEL_CHANGE_ROLE, thinkingFollowsSettings } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Capabilities borrowed from the owning AgentSession. */
export interface ModelControlsHost {
	agent: Agent;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	providerSessionState: Map<string, ProviderSessionState>;
	model(): Model | undefined;
	sessionId(): string;
	promptGeneration(): number;
	resolveActiveEditMode(): EditMode;
	syncAfterModelChange(previousEditMode: EditMode): Promise<void>;
	setModelWithProviderSessionReset(model: Model): Promise<void>;
	clearActiveRetryFallback(): void;
	clearInheritedProviderPromptCacheKey(): void;
	magicKeywordEnabled(keyword: "orchestrate" | "ultrathink" | "workflow"): boolean;
	emit(event: AgentSessionEvent): void;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
}

/** Owns model selection, thinking effort, role cycling, and service tiers. */
export class ModelControls {
	readonly #host: ModelControlsHost;
	#scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#thinkingLevel: ThinkingLevel | undefined;
	/** Hard per-session effort ceiling (e.g. a task spawn's `task.maxEffort` cap); recovery paths re-clamp to it. */
	readonly #thinkingLevelCeiling: Effort | undefined;
	#autoThinking = false;
	#autoResolvedLevel: Effort | undefined;
	#serviceTierByFamily: ServiceTierByFamily;

	constructor(
		host: ModelControlsHost,
		options: {
			scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
			thinkingLevel?: ConfiguredThinkingLevel;
			thinkingLevelCeiling?: Effort;
			serviceTierByFamily?: ServiceTierByFamily;
		},
	) {
		this.#host = host;
		this.#scopedModels = options.scopedModels ?? [];
		this.#serviceTierByFamily = options.serviceTierByFamily ?? {};
		this.#thinkingLevelCeiling = options.thinkingLevelCeiling;
		if (options.thinkingLevel === AUTO_THINKING) {
			// Keep auto pending until the first turn while exposing a valid wire effort.
			this.#autoThinking = true;
			this.#thinkingLevel = clampThinkingLevelToCeiling(
				this.#model,
				resolveProvisionalAutoLevel(this.#model),
				this.#thinkingLevelCeiling,
			);
		} else {
			this.#thinkingLevel = clampThinkingLevelToCeiling(
				this.#model,
				options.thinkingLevel,
				this.#thinkingLevelCeiling,
			);
		}
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);
	}

	get #model(): Model | undefined {
		return this.#host.model();
	}

	/** Effective metadata-clamped thinking level applied to the agent. */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	/** Hard per-session effort ceiling every thinking-level change is clamped to. */
	get thinkingLevelCeiling(): Effort | undefined {
		return this.#thinkingLevelCeiling;
	}

	/** Configured selector, preserving `auto` while classification is active. */
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#autoThinking ? AUTO_THINKING : this.#thinkingLevel;
	}

	/** Whether per-turn automatic thinking classification is enabled. */
	get isAutoThinking(): boolean {
		return this.#autoThinking;
	}

	/** Last concrete effort selected by automatic classification. */
	get autoResolvedThinkingLevel(): Effort | undefined {
		return this.#autoResolvedLevel;
	}

	/** Models explicitly scoped to the session's cycle command. */
	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		return this.#scopedModels;
	}

	/**
	 * Replace the Ctrl+P cycle scope. Startup resolves the scope before background
	 * provider discovery runs; the CLI re-pushes the fuller list here once discovery
	 * completes so a newly-discovered `enabledModels` model joins the cycle and the
	 * scoped `/models` picker (issue #9220).
	 */
	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void {
		this.#scopedModels = scopedModels;
	}

	/** Live per-provider-family service-tier selection. */
	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#serviceTierByFamily;
	}

	/** Restores thinking state from a transcript without persisting a new entry. */
	restoreThinkingLevel(level: ConfiguredThinkingLevel | undefined): void {
		this.#autoThinking = level === AUTO_THINKING;
		this.#autoResolvedLevel = undefined;
		this.#thinkingLevel =
			level === AUTO_THINKING
				? clampThinkingLevelToCeiling(
						this.#model,
						resolveProvisionalAutoLevel(this.#model),
						this.#thinkingLevelCeiling,
					)
				: resolveThinkingLevelForModel(
						this.#model,
						clampThinkingLevelToCeiling(this.#model, level, this.#thinkingLevelCeiling),
					);
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);
	}

	/** Restores an exact thinking snapshot after a failed session switch. */
	restoreThinkingSnapshot(level: ThinkingLevel | undefined, auto: boolean, resolved: Effort | undefined): void {
		this.#thinkingLevel = level;
		this.#autoThinking = auto;
		this.#autoResolvedLevel = resolved;
		this.#applyThinkingLevelToAgent(level);
	}

	/** Restores service tiers without persisting a duplicate transcript entry. */
	restoreServiceTiers(tiers: ServiceTierByFamily): void {
		this.#serviceTierByFamily = tiers;
	}

	/**
	 * Reconcile the live per-family tiers against a reloaded `tier.*` config.
	 *
	 * Startup copies the three `tier.openai`/`tier.anthropic`/`tier.google`
	 * settings into the private map ONCE, and `serviceTierResolver` reads the
	 * map — never the settings — on every request, so reloading `Settings`
	 * alone left each request carrying the launch-time tier while the refresh
	 * reported success.
	 *
	 * Gated per FAMILY on the configured value having actually moved, and on
	 * the live entry still matching what the config previously said. `/fast`,
	 * the settings selector, and an RPC/ACP client all write this map directly,
	 * and such a session-local selection is invisible to the config file — so a
	 * family the session has moved away from its configured value is left
	 * alone, exactly as the queue modes and provider globals are.
	 *
	 * Writes NO first `service_tier_change` receipt: this value still FOLLOWS
	 * the config, and being the branch's only entry would make
	 * `hasServiceTierEntry` true, freezing the tier against every later config
	 * edit once the session is resumed. When a receipt ALREADY exists the
	 * reconcile must persist a merged snapshot instead — see below.
	 */
	applyReloadedServiceTiers(previousConfigured: ServiceTierByFamily, nextConfigured: ServiceTierByFamily): void {
		const next: ServiceTierByFamily = { ...this.#serviceTierByFamily };
		let moved = false;
		for (const family of SERVICE_TIER_FAMILIES) {
			if (previousConfigured[family] === nextConfigured[family]) continue;
			if (this.#serviceTierByFamily[family] !== previousConfigured[family]) continue;
			const tier = nextConfigured[family];
			if (tier) next[family] = tier;
			else delete next[family];
			moved = true;
		}
		if (!moved) return;
		// Re-arming Anthropic priority clears the per-session fast-mode
		// auto-disable, so the next request actually carries `speed: "fast"`
		// again — the same re-arm the interactive setter performs.
		if (next.anthropic === "priority" && this.#serviceTierByFamily.anthropic !== "priority") {
			clearAnthropicFastModeFallback(this.#host.providerSessionState);
		}
		this.#serviceTierByFamily = next;
		// A `service_tier_change` is a WHOLE-MAP snapshot, and restoration
		// (`switchSession`, resume) replays the last one wholesale. So an earlier
		// `/fast`, selector, or RPC/ACP write for ONE family leaves a snapshot
		// that still carries every other family's pre-refresh value: switching
		// away and back, or restarting and resuming, resurrected the stale tier
		// for exactly the families this reconcile had just moved. Re-persisting
		// the merged map keeps the reconciled value across that round-trip.
		//
		// The snapshot now also records WHICH families still follow `tier.*`, so a
		// pin for one family no longer freezes the others at the value they held
		// when it was written. Without that, a stop + `tier.google` edit + resume
		// replayed the stale Google tier, and no later refresh could notice —
		// `Settings` has already loaded the new value, so `previousConfigured`
		// equals `nextConfigured` and this reconcile sees no movement.
		//
		// Gated on a receipt already being on the branch, which is what keeps the
		// snapshot from turning a config-derived family into a permanent pin:
		// `hasServiceTierEntry` is true in that case either way, so restoration
		// already ignores the configured map and this only corrects WHICH map it
		// replays. With no receipt the branch still reads as config-following, and
		// writing the first one here would freeze every family — so it stays
		// unwritten and restoration keeps re-deriving from `tier.*`.
		if (this.#host.sessionManager.getBranch().some(entry => entry.type === "service_tier_change")) {
			this.#host.sessionManager.appendServiceTierChange(
				this.serviceTierEntry(),
				this.#settingsTrackingFamilies(nextConfigured),
			);
		}
	}

	/**
	 * Families whose live tier still equals what `tier.*` configures, so
	 * restoration can re-derive them from the config instead of replaying a
	 * value that may since have changed on disk.
	 */
	#settingsTrackingFamilies(configured: ServiceTierByFamily): ReadonlyArray<keyof ServiceTierByFamily> {
		return SERVICE_TIER_FAMILIES.filter(family => this.#serviceTierByFamily[family] === configured[family]);
	}

	/**
	 * Families an earlier operation already pinned, read off the most recent
	 * receipt: any family absent from its tracking list was pinned then, and that
	 * provenance has to survive a later write about a different family.
	 *
	 * No receipt at all means nothing is pinned yet — restoration re-derives
	 * every family from `tier.*` in that state.
	 *
	 * A LEGACY receipt (written before the tracking list existed) omits the
	 * field, and restoration reads that as fully pinned
	 * (`applySettingsTrackedServiceTiers` returns the persisted map untouched
	 * when the list is absent). Reading it here as fully TRACKING contradicted
	 * that: writing a receipt about one family then marked the others
	 * config-following, and a later `tier.*` edit overwrote a pin the legacy
	 * receipt had recorded. Absent list means pinned, in both readers.
	 */
	#pinnedServiceTierFamilies(): ReadonlySet<keyof ServiceTierByFamily> {
		const branch = this.#host.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "service_tier_change") continue;
			if (!entry.settingsTrackingFamilies) return new Set(SERVICE_TIER_FAMILIES);
			const tracking = new Set(entry.settingsTrackingFamilies);
			return new Set(SERVICE_TIER_FAMILIES.filter(family => !tracking.has(family)));
		}
		return new Set();
	}
	resolveRoleModel(role: string): Model | undefined {
		return resolveRoleModelFull(this.#host.settings, role, this.#host.modelRegistry.getAvailable(), this.#model)
			.model;
	}

	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return resolveRoleModelFull(this.#host.settings, role, this.#host.modelRegistry.getAvailable(), this.#model);
	}

	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined {
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const matchPreferences = getModelMatchPreferences(this.#host.settings);
		for (const role of getKnownRoleIds(this.#host.settings)) {
			const roleValue = this.#host.settings.getModelRole(role);
			if (!roleValue) continue;

			const resolved = resolveModelRoleValue(roleValue, availableModels, {
				settings: this.#host.settings,
				matchPreferences,
			});
			if (!resolved.explicitThinkingLevel || resolved.thinkingLevel === undefined || !resolved.model) continue;
			if (modelsAreEqual(resolved.model, model)) return resolved.thinkingLevel;
		}

		return undefined;
	}

	async setModel(
		model: Model,
		role: string = "default",
		options?: {
			selector?: string;
			thinkingLevel?: ThinkingLevel;
			persist?: boolean;
			/**
			 * Records this transition as a settings-tracking auto-swap (not a user
			 * pin): the `model_change` carries the `settingsTracking` flag and no
			 * role, so a later `/refresh settings` may swap it again and a user's
			 * real role named "default"/"settings" is never mistaken for it.
			 */
			settingsTracking?: boolean;
		},
	): Promise<{ switched: boolean }> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		if (!this.#host.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const targetModel = await this.#host.modelRegistry.refreshSelectedModelMetadata(model);

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(targetModel);
		this.#host.sessionManager.appendModelChange(
			`${targetModel.provider}/${targetModel.id}`,
			options?.settingsTracking ? undefined : role,
			false,
			options?.settingsTracking ? { settingsTracking: true } : undefined,
		);
		if (options?.persist) {
			this.#host.settings.setModelRole(
				role,
				formatRoleModelValue(
					this.#host.settings,
					this.#host.modelRegistry,
					role,
					targetModel,
					options.selector,
					options.thinkingLevel,
				),
			);
		}
		this.#host.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Re-apply thinking for the newly selected model. Prefer the model's
		// configured defaultLevel; otherwise preserve the current level (or auto).
		// A settings-tracking swap's re-apply is settings-derived too — marking it
		// keeps the receipt classifiable as "still follows settings", so the next
		// `/refresh settings` may move the level again.
		this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel, {
			settingsTracking: options?.settingsTracking,
		});
		await this.#host.syncAfterModelChange(previousEditMode);
		return { switched: true };
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs), saves to session
	 * log but NOT to settings.
	 * @throws Error if no API key available for the model
	 */
	async setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		if (!this.#host.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const targetModel = await this.#host.modelRegistry.refreshSelectedModelMetadata(model);

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(targetModel);
		this.#host.sessionManager.appendModelChange(
			`${targetModel.provider}/${targetModel.id}`,
			options?.ephemeral ? EPHEMERAL_MODEL_CHANGE_ROLE : "temporary",
		);
		this.#host.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Apply explicit thinking level if given; otherwise prefer the model's
		// configured defaultLevel; otherwise re-clamp the current level (or auto).
		if (thinkingLevel !== undefined) {
			// A suffix on a user-driven switch (`/switch p/m:<level>`, the selector)
			// is a session choice, so it pins even when it matches the active level
			// — without the flag an unchanged selection writes no receipt and the
			// previous settings-tracking one survives, so a later
			// `defaultThinkingLevel` edit overwrites the user's pick.
			//
			// An ephemeral switch (prewalk, plan-yolo) carries a CONFIGURED level,
			// not a user selection, so it must keep following settings. Clearing
			// `explicit` is not enough: when the handoff's level differs from the
			// active one the receipt is written anyway (the level MOVED), and with
			// `settingsTracking` unset `thinkingFollowsSettings()` then reads that
			// automatic handoff as a user pin — so a later `defaultThinkingLevel`
			// edit plus `refresh("settings")` was ignored. Inherit the pre-handoff
			// answer, as `#reapplyThinkingLevel` does for a model-derived re-apply;
			// the branch still carries it because no thinking receipt is written
			// between the `model_change` above and this call.
			this.setThinkingLevel(
				thinkingLevel,
				false,
				options?.ephemeral
					? { settingsTracking: thinkingFollowsSettings(this.#host.sessionManager.getBranch()) }
					: { explicit: true },
			);
		} else {
			this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
		}
		await this.#host.syncAfterModelChange(previousEditMode);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	/**
	 * Resolve the configured role models in the given order plus the index of
	 * the currently active one. Roles that have no configured model, or whose
	 * configured model is not currently available, are skipped. The `default`
	 * role falls back to the active model when no explicit assignment exists.
	 *
	 * Returns `undefined` only when there is no current model or no available
	 * models at all; an empty `models` array is never returned (callers should
	 * still guard on `models.length`).
	 */
	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.#model;
		if (!currentModel) return undefined;
		const matchPreferences = getModelMatchPreferences(this.#host.settings);
		const models: ResolvedRoleModel[] = [];

		for (const role of roleOrder) {
			const roleModelStr =
				role === "default"
					? (this.#host.settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
					: this.#host.settings.getModelRole(role);
			if (!roleModelStr) continue;

			const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
				settings: this.#host.settings,
				matchPreferences,
			});
			if (!resolved.model) continue;

			models.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			});
		}

		if (models.length === 0) return undefined;

		// Trust the recorded role only while its resolved model still IS the
		// active model. A model switch through another surface (alt+m, retry
		// fallback, /model) or a role re-configuration leaves the recorded role
		// pointing at a model the session no longer runs; cycling from that
		// stale slot lands on the wrong neighbor and reads as a skipped entry.
		const lastRole = this.#host.sessionManager.getLastModelChangeRole();
		let currentIndex = lastRole ? models.findIndex(entry => entry.role === lastRole) : -1;
		if (currentIndex !== -1 && !modelsAreEqual(models[currentIndex].model, currentModel)) {
			currentIndex = -1;
		}
		if (currentIndex === -1) {
			currentIndex = models.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		}
		if (currentIndex === -1) currentIndex = 0;

		return { models, currentIndex };
	}

	/**
	 * Apply a resolved role model as the active model without changing global
	 * settings. Shared with role cycling and the plan-approval model slider.
	 */
	async applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		await this.setModel(entry.model, entry.role);
		if (entry.explicitThinkingLevel && entry.thinkingLevel !== undefined) {
			// `explicitThinkingLevel` means the role carried a thinking suffix, so
			// this IS a selection and must be recorded as a pin. Without the flag a
			// suffix equal to the level already active writes no receipt at all —
			// the effective effort never moves, so the only thing that would have
			// recorded the choice is the pin — and a later `defaultThinkingLevel`
			// edit plus `/refresh settings` then overwrites the role's suffix.
			this.setThinkingLevel(entry.thinkingLevel, false, { explicit: true });
		}
	}

	/**
	 * Cycle through configured role models in a fixed order.
	 * Skips missing roles and changes only the active session model.
	 * @param roleOrder - Order of roles to cycle through (e.g., ["slow", "default", "smol"])
	 * @param direction - "forward" (default) or "backward"
	 */
	async cycleRoleModels(
		roleOrder: readonly string[],
		direction: "forward" | "backward" = "forward",
	): Promise<RoleModelCycleResult | undefined> {
		const cycle = this.getRoleModelCycle(roleOrder);
		if (!cycle || cycle.models.length <= 1) return undefined;

		const step = direction === "backward" ? -1 : 1;
		const next = cycle.models[(cycle.currentIndex + step + cycle.models.length) % cycle.models.length];

		await this.applyRoleModel(next);

		return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role };
	}

	async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = [];

		for (const scoped of this.#scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#host.modelRegistry.getApiKeyForProvider(provider, this.#host.sessionId());
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.#model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Apply model
		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(next.model));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(next.model);
		// An explicit cycle is a user pin, exactly like `setModel`: record the
		// model_change with role "default" and no `settingsTracking` flag so a
		// later `/refresh settings` does not treat it as a swappable auto-track.
		this.#host.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`, "default");
		this.#host.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		// Apply the scoped model's configured thinking level, preserving auto.
		this.setThinkingLevel(this.#autoThinking ? AUTO_THINKING : next.thinkingLevel);
		await this.#host.syncAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.#model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#host.modelRegistry.getApiKey(nextModel, this.#host.sessionId());
		if (!apiKey) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(nextModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(nextModel);
		// An explicit cycle is a user pin, exactly like `setModel`: record the
		// model_change with role "default" and no `settingsTracking` flag so a
		// later `/refresh settings` does not treat it as a swappable auto-track.
		this.#host.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`, "default");
		this.#host.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);
		// Re-apply the current thinking level (or auto) for the newly selected model
		this.#reapplyThinkingLevel();
		await this.#host.syncAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys, filtered by `enabledModels` when configured.
	 * See {@link filterAvailableModelsByEnabledPatterns} for supported pattern forms and limitations.
	 */
	getAvailableModels(): Model[] {
		const all = this.#host.modelRegistry.getAvailable();
		const patterns = this.#host.settings.get("enabledModels");
		if (!patterns || patterns.length === 0) return all;
		return filterAvailableModelsByEnabledPatterns(all, patterns, this.#host.settings);
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	#applyThinkingLevelToAgent(level: ThinkingLevel | undefined): void {
		this.#host.agent.setThinkingLevel(toReasoningEffort(level));
		this.#host.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	/**
	 * Set the thinking level. `auto` enables per-turn classification. Entering
	 * auto writes its provisional level plus `configured: "auto"` immediately,
	 * giving external readers an authoritative selection receipt before the next
	 * user turn. Later classifications persist only changed concrete resolutions.
	 *
	 * `options.settingsTracking` marks the persisted receipt as a
	 * settings-derived application rather than an explicit session choice, so a
	 * later `/refresh settings` may replace it (see
	 * `AgentSession.#thinkingFollowsSettings`). Callers that represent a real
	 * user/RPC/ACP selection must leave it unset.
	 *
	 * `options.explicit` marks this call as a DIRECT thinking selection (the
	 * public session surface: ACP/RPC, the selector, the cycle key) rather than
	 * an incidental re-apply. It is what lets a selection matching the current
	 * level still record its pin — see the receipt logic below. The re-apply
	 * `setModel` performs deliberately leaves it unset: a model pick says nothing
	 * about thinking, so it must not pin the level.
	 */
	setThinkingLevel(
		level: ConfiguredThinkingLevel | undefined,
		persist: boolean = false,
		options?: { settingsTracking?: boolean; explicit?: boolean },
	): void {
		if (level === AUTO_THINKING) {
			const provisional = clampThinkingLevelToCeiling(
				this.#model,
				resolveProvisionalAutoLevel(this.#model),
				this.#thinkingLevelCeiling,
			);
			const wasAuto = this.#autoThinking;
			const previousLevel = this.#thinkingLevel;
			this.#autoThinking = true;
			this.#autoResolvedLevel = undefined;
			this.#thinkingLevel = provisional;
			if (!wasAuto) {
				this.#host.clearInheritedProviderPromptCacheKey();
			}
			this.#applyThinkingLevelToAgent(provisional);
			if (persist) {
				this.#host.settings.set("defaultThinkingLevel", AUTO_THINKING);
			}
			const isChanging = !wasAuto || previousLevel !== provisional;
			if (isChanging || this.#needsExplicitPinReceipt(options)) {
				this.#host.sessionManager.appendThinkingLevelChange(provisional, AUTO_THINKING, {
					settingsTracking: options?.settingsTracking,
				});
			}
			if (isChanging) {
				this.#host.emit({ type: "thinking_level_changed", thinkingLevel: provisional, configured: AUTO_THINKING });
			}
			return;
		}

		const wasAuto = this.#autoThinking;
		this.#autoThinking = false;
		this.#autoResolvedLevel = undefined;
		const effectiveLevel = resolveThinkingLevelForModel(
			this.#model,
			clampThinkingLevelToCeiling(this.#model, level, this.#thinkingLevelCeiling),
		);
		// Leaving auto must persist even when the resolved effort is unchanged (e.g.
		// auto resolved to medium, then the user pins medium): otherwise the latest
		// session entry keeps `configured: "auto"` and resume re-enables auto.
		const isChanging = wasAuto || effectiveLevel !== this.#thinkingLevel;

		this.#thinkingLevel = effectiveLevel;
		this.#applyThinkingLevelToAgent(effectiveLevel);

		if (isChanging || this.#needsExplicitPinReceipt(options)) {
			this.#host.sessionManager.appendThinkingLevelChange(effectiveLevel, effectiveLevel, {
				settingsTracking: options?.settingsTracking,
			});
		}
		if (isChanging) {
			this.#host.clearInheritedProviderPromptCacheKey();
			if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
				this.#host.settings.set("defaultThinkingLevel", effectiveLevel);
			}
			this.#host.emit({ type: "thinking_level_changed", thinkingLevel: effectiveLevel });
		}
	}

	/**
	 * Whether an unchanged selection must still append a receipt to record its
	 * pin. The receipt is the ONLY record that a level is a session choice rather
	 * than a settings-derived one, and it is otherwise written only when the
	 * effective effort moves — so an explicit selection of the level already
	 * active left the latest entry `settingsTracking: true`, and a later
	 * `/refresh settings` overwrote the user's choice once the configured default
	 * moved.
	 *
	 * Gated on the branch actually reading as settings-following: when the latest
	 * selection is already an explicit pin, the pin is recorded and a duplicate
	 * receipt would only grow the branch on every repeat selection. A
	 * settings-derived call needs nothing either — its receipt would say exactly
	 * what the existing one says.
	 */
	#needsExplicitPinReceipt(options?: { settingsTracking?: boolean; explicit?: boolean }): boolean {
		if (options?.explicit !== true || options.settingsTracking === true) return false;
		return thinkingFollowsSettings(this.#host.sessionManager.getBranch());
	}

	/**
	 * Re-apply the active thinking selection after a model change. Preserves `auto`
	 * (re-clamping the provisional level to the new model); otherwise re-applies the
	 * preferred default or the current effective level.
	 */
	#reapplyThinkingLevel(preferredDefault?: ThinkingLevel, options?: { settingsTracking?: boolean }): void {
		// Carry the PRE-SWITCH thinking provenance through a model-derived
		// re-apply. A model pick says nothing about thinking, but when the newly
		// selected model's `thinking.defaultLevel` differs from the current level
		// this call MOVES the level — and with `settingsTracking` unset
		// `setThinkingLevel()` wrote an unflagged receipt, so
		// `thinkingFollowsSettings()` read a level the user never chose as an
		// explicit thinking pin and a later `defaultThinkingLevel` edit plus
		// `/refresh settings` could no longer update it. Inheriting the pre-switch
		// answer keeps a config-tracking level config-tracking and leaves a real
		// pin pinned.
		//
		// Read from the branch here rather than at each call site because no
		// caller writes a thinking receipt between its `model_change` and this
		// re-apply, so the branch still carries the pre-switch answer. An explicit
		// `options.settingsTracking` (the settings-tracking auto-swap) still wins.
		const settingsTracking =
			options?.settingsTracking ?? thinkingFollowsSettings(this.#host.sessionManager.getBranch());
		this.setThinkingLevel(this.#autoThinking ? AUTO_THINKING : (preferredDefault ?? this.#thinkingLevel), false, {
			settingsTracking,
		});
	}

	/**
	 * Cycle to next thinking level: off → auto → minimal..max → off.
	 * @returns New selector, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined {
		if (!this.#model?.reasoning) return undefined;

		const levels: ConfiguredThinkingLevel[] = [
			ThinkingLevel.Off,
			AUTO_THINKING,
			...this.getAvailableThinkingLevels(),
		];
		const configured = this.configuredThinkingLevel();
		const currentLevel = configured === ThinkingLevel.Inherit ? ThinkingLevel.Off : configured;
		const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		// A cycle is a user action, exactly like `setModel`'s explicit pick: pin it
		// so a later `/refresh settings` cannot move the level back.
		this.setThinkingLevel(nextLevel, false, { explicit: true });
		return nextLevel;
	}

	/** Timeout (ms) for per-turn auto-thinking classification before falling back. */
	static readonly #AUTO_THINKING_TIMEOUT_MS = 4000;

	/**
	 * Classify the current user turn and set the effective thinking level for it.
	 * Bounded by a timeout + abort; on failure it preserves the last classified
	 * level, or uses the provisional concrete level before the first resolution.
	 * Never throws into the turn, and never clears `#autoThinking`.
	 */
	async applyAutoThinkingLevel(promptText: string, generation: number): Promise<void> {
		const model = this.#model;
		if (!model?.reasoning) return;
		// Models with reasoning but no controllable effort surface (devin-agent
		// Cascade routes effort via sibling model ids, not a wire param) have
		// nothing to pick — skip classification rather than discard its result.
		if (getSupportedEfforts(model).length === 0) return;

		let resolved: Effort | undefined;
		if (this.#host.magicKeywordEnabled("ultrathink") && containsUltrathink(promptText)) {
			// The user explicitly asked for maximum thinking; bypass the classifier
			// (and the `providers.autoThinkingMaxEffort` ceiling) and jump straight
			// to the highest supported level for this model.
			resolved = clampAutoThinkingEffort(model, Effort.Max);
		} else {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), ModelControls.#AUTO_THINKING_TIMEOUT_MS);
			const usageOwner = {
				sessionId: this.#host.sessionManager.getSessionId(),
				parentId: this.#host.sessionManager.getLeafId(),
			};
			try {
				resolved = await classifyDifficulty(promptText, {
					settings: this.#host.settings,
					registry: this.#host.modelRegistry,
					model,
					sessionId: this.#host.sessionId(),
					signal: controller.signal,
					metadataResolver: provider => this.#host.agent.metadataForProvider(provider),
					onUsage: usage => {
						const entryId = this.#host.sessionManager.appendModelUsage(
							{ purpose: "auto-thinking", ...usage },
							usageOwner,
						);
						if (entryId) usageOwner.parentId = entryId;
					},
				});
			} catch (error) {
				logger.debug("auto-thinking: classification failed; using fallback level", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				clearTimeout(timer);
			}
		}

		// Drop the result if the turn was aborted/superseded while classifying.
		if (this.#host.promptGeneration() !== generation || !this.#autoThinking) return;

		const effort = clampThinkingLevelToCeiling(
			model,
			resolved ?? this.#autoResolvedLevel ?? resolveProvisionalAutoLevel(model),
			this.#thinkingLevelCeiling,
		);
		if (effort === undefined) return;
		const shouldPersistResolution = this.#thinkingLevel !== effort;
		this.#autoResolvedLevel = effort;
		this.#thinkingLevel = effort;
		this.#applyThinkingLevelToAgent(effort);
		if (shouldPersistResolution) {
			// A per-turn classification receipt, not a selection: mark it so the
			// settings-tracking scan walks past it to the underlying `auto`
			// selection rather than reading a resolved effort as an explicit pin.
			this.#host.sessionManager.appendThinkingLevelChange(effort, AUTO_THINKING, { autoResolved: true });
		}
		this.#host.emit({
			type: "thinking_level_changed",
			thinkingLevel: effort,
			configured: AUTO_THINKING,
			resolved: effort,
		});
	}

	/**
	 * True when the currently selected model's family is set to `priority` — the
	 * `/fast` on/off state for the active model. Returns false when no model is
	 * selected or the model exposes no service-tier family (e.g. Fireworks, which
	 * has its own Providers › Fireworks Tier toggle).
	 *
	 * For "is priority actually applied to the next request?" use
	 * {@link isFastModeActive} instead.
	 */
	isFastModeEnabled(): boolean {
		const family = this.#model ? serviceTierFamily(this.#model) : undefined;
		return family ? this.#serviceTierByFamily[family] === "priority" : false;
	}

	/**
	 * True when `priority` is actually realized on the wire for the currently
	 * selected model (OpenAI/Google `service_tier`, direct Anthropic fast mode,
	 * or Fireworks priority). Returns false for tiers the active model can't
	 * realize and when no model is selected.
	 */
	isFastModeActive(): boolean {
		const model = this.#model;
		if (!model || !realizesPriorityServiceTier(this.effectiveServiceTier(model), model)) return false;
		if (model.provider === "anthropic") {
			return !isAnthropicFastModeFallbackDisabled(this.#host.providerSessionState, model);
		}
		return true;
	}

	/**
	 * Effective wire service-tier for a request to `model`. Fireworks models take
	 * the Priority serving path only when the Providers › Fireworks Tier setting
	 * is `"priority"` (and never for `-fast` variants, whose Fast serving path is
	 * mutually exclusive with Priority). Every other model resolves the live
	 * per-family tier map down to the entry for its family.
	 */
	effectiveServiceTier(model: Model | undefined = this.#model): ServiceTier | undefined {
		if (model?.provider === "fireworks") {
			return this.#host.settings.get("providers.fireworksTier") === "priority" && !isFireworksFastModelId(model.id)
				? "priority"
				: undefined;
		}
		if (!model) return undefined;
		return resolveModelServiceTier(this.#serviceTierByFamily, model);
	}

	/** The live per-family tier map, or `null` when empty (for session persistence). */
	serviceTierEntry(): ServiceTierByFamily | null {
		return Object.keys(this.#serviceTierByFamily).length > 0 ? this.#serviceTierByFamily : null;
	}

	/** Set one family's tier (or clear it with `undefined`); persists the change. */
	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		// An explicit selection of the value already held still PINS the family.
		// Returning early here recorded no receipt, so selecting `priority` while
		// `tier.openai: priority` (including `/fast on`) left the family reading as
		// config-following, and a later `tier.openai` edit overwrote the choice.
		// The value does not move, so only the provenance is rewritten.
		if (this.#serviceTierByFamily[family] === tier) {
			this.#applyServiceTierByFamily({ ...this.#serviceTierByFamily }, family);
			return;
		}
		const next: ServiceTierByFamily = { ...this.#serviceTierByFamily };
		if (tier) next[family] = tier;
		else delete next[family];
		// This family is PINNED by the operation, whatever value it lands on.
		this.#applyServiceTierByFamily(next, family);
	}

	/** Replace the whole per-family tier map; persists + re-arms Anthropic fast mode. */
	#applyServiceTierByFamily(next: ServiceTierByFamily, pinnedFamily?: ServiceTierFamily): void {
		// Re-arming Anthropic priority clears the per-session fast-mode auto-disable
		// so the next request actually carries `speed: "fast"` again.
		if (next.anthropic === "priority" && this.#serviceTierByFamily.anthropic !== "priority") {
			clearAnthropicFastModeFallback(this.#host.providerSessionState);
		}
		this.#serviceTierByFamily = next;
		// Provenance is recorded HERE because this is where the whole-map receipt
		// originates: a pin on one family otherwise freezes every other family at
		// the value it happened to hold, and restoration cannot tell the two apart.
		// The PINNED family comes from the operation, never from comparing values:
		// an explicit selection that happens to equal the configured tier is still
		// a pin, and inferring provenance by equality let a later config edit
		// overwrite a choice that is meant to outrank config. Every other family
		// still equal to the live config is safe for restoration to re-derive.
		// Carried forward, not recomputed from scratch: a family pinned by an
		// EARLIER operation is absent from that receipt's tracking list, and
		// re-inferring by equality hands it back to config the moment any other
		// family is set. Pin OpenAI to a value that equals `tier.openai`, then
		// select a Google tier, and the Google operation would re-mark OpenAI as
		// config-following — so a later `tier.openai` edit overwrote a selection
		// meant to outrank config.
		const previouslyPinned = this.#pinnedServiceTierFamilies();
		const tracking = this.#settingsTrackingFamilies(this.#configuredServiceTiers()).filter(
			family => family !== pinnedFamily && !previouslyPinned.has(family),
		);
		this.#host.sessionManager.appendServiceTierChange(this.serviceTierEntry(), tracking);
	}

	/**
	 * The tracking list a receipt written RIGHT NOW should carry: families whose
	 * live tier still equals `tier.*`, minus any an earlier operation pinned.
	 *
	 * Exposed for the `/new` receipt, which starts a fresh transcript and so
	 * must restate this session's provenance rather than omit it — an omitted
	 * list reads as a legacy fully-pinned snapshot, freezing every family at the
	 * value `/new` happened to capture.
	 */
	serviceTierTrackingFamilies(): ReadonlyArray<keyof ServiceTierByFamily> {
		const previouslyPinned = this.#pinnedServiceTierFamilies();
		return this.#settingsTrackingFamilies(this.#configuredServiceTiers()).filter(
			family => !previouslyPinned.has(family),
		);
	}

	/** The per-family tier map the live `tier.*` settings configure. */
	#configuredServiceTiers(): ServiceTierByFamily {
		return buildServiceTierByFamily(
			this.#host.settings.get("tier.openai"),
			this.#host.settings.get("tier.anthropic"),
			this.#host.settings.get("tier.google"),
		);
	}

	/**
	 * `/fast on|off` targets the family of the currently selected model: it sets
	 * (or clears) that family's `priority` tier. Returns `false` when the model
	 * has no service-tier family, so callers can report that fast mode is
	 * unavailable instead of claiming success.
	 */
	setFastMode(enabled: boolean): boolean {
		const family = this.#model ? serviceTierFamily(this.#model) : undefined;
		if (!family) {
			this.#host.emitNotice(
				"info",
				"The current model has no service-tier control for /fast to toggle.",
				"priority",
			);
			return false;
		}
		if (!enabled) {
			if (this.#serviceTierByFamily[family] === "priority") this.setServiceTierFamily(family, undefined);
			return true;
		}
		if (family === "anthropic" && this.#serviceTierByFamily.anthropic === "priority") {
			clearAnthropicFastModeFallback(this.#host.providerSessionState);
		}
		this.setServiceTierFamily(family, "priority");
		return true;
	}

	toggleFastMode(): boolean {
		if (!this.setFastMode(!this.isFastModeEnabled())) return false;
		return this.isFastModeEnabled();
	}

	/**
	 * Get available thinking levels for current model.
	 */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.#model) return [];
		return getSupportedEfforts(this.#model);
	}
}
