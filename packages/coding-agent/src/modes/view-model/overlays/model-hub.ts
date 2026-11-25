import type { KeysApi, Model } from "@oh-my-pi/pi-ai";
import { type ConfiguredThinkingLevel } from "../../../utils/render-utils";
import type { ModelBrowserRegistry, ModelBrowserSource } from "./model-browser";

/** Live preferences and selector operations the /models hub reads. */
export interface ModelHubSource extends ModelBrowserSource {
	readonly disabledProviders: readonly string[];
	readonly fallbackChains: Record<string, string[]>;
	readonly modelRoleStorage: "global" | "project";
	readonly cycleOrder: readonly string[];
	getProjectModelRole(role: string): string | undefined;
	getGlobalModelRole(role: string): string | undefined;
	getModelRoleSource(role: string): "global" | "project" | "default";
	/** Saved model presets (in switch order) and the one the current role setup matches; absent hosts have none. */
	getModelPresets?(): { names: readonly string[]; active: string | undefined };
}

/** Catalog capabilities the /models hub needs. */
export interface ModelHubRegistry extends ModelBrowserRegistry {
	readonly authStorage: { readonly keys: Pick<KeysApi, "source"> };
	getDiscoverableProviders(): string[];
	getProviderDiscoveryState(provider: string):
		| {
				optional: boolean;
				status: "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";
				fetchedAt?: number;
				error?: string;
		  }
		| undefined;
	find(provider: string, id: string): Model | undefined;
	refresh(strategy: "online"): Promise<void>;
	refreshProvider(
		provider: string,
		strategy: "online",
		options?: { refreshCommandCredentials?: boolean },
	): Promise<void>;
}

/** A `--models` scope entry (mirrors the session's scoped model list). */
export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export type ModelRoleSelectionScope = "global" | "project";

export interface ModelHubCallbacks {
	/** Persist a role assignment. */
	onAssign: (
		model: Model,
		role: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		selector: string,
		scope?: ModelRoleSelectionScope,
	) => void | boolean | Promise<void | boolean>;
	/** Clear a configured role back to auto-selection. */
	onUnassign: (role: string, scope?: ModelRoleSelectionScope) => void;
	/** Persist a `retry.fallbackChains` entry — keyed by a role, `provider/model-id`, or `provider/*`; an empty chain clears the key. */
	onFallbackChainChange?: (role: string, chain: string[]) => void;
	/** Locked provider activation: forward to the /login flow. */
	onLoginRequest?: (providerId: string) => void;
	/** Returns the rebuilt scope; `undefined` means the session no longer has a scope. */
	onCatalogRefreshed?: (
		providerId?: string,
	) => ReadonlyArray<ScopedModelItem> | undefined | Promise<ReadonlyArray<ScopedModelItem> | undefined>;
	/** Save the current role assignments and default thinking level as a named model preset. */
	onSavePreset?: (name: string) => void;
	/**
	 * Apply a saved model preset (ctrl+←/→ or p/⇧P in the Roles view) and report
	 * the outcome itself. A switch that writes nothing (a refused preset) still
	 * advances the hub's preset cursor, so the next press moves past it.
	 */
	onSwitchPreset?: (name: string) => void | Promise<void>;
	/** Persist a new quick-switch cycle order (the ctrl+p role cycle). */
	onCycleOrderChange?: (order: string[]) => void;
	/**
	 * Persist typed text as `model`'s own compaction limit: a token base the
	 * policy scales (`400k`), a fixed trigger (`f400k`), a percentage (`80%`), or
	 * empty to reset. Rejected input returns `{ kind: "error" }`; input that
	 * needs acknowledgement (one that opens the extended window) returns
	 * `{ kind: "confirm" }` until called again with the same text and
	 * `confirmed`. Either keeps the field open.
	 */
	onCompactionPointChange?: (
		model: Model,
		input: string,
		confirmed: boolean,
	) => CompactionPointChangeResult | undefined;
	/**
	 * One short line on where `model` would compact with the typed limit
	 * (`compacts at 340K · 85% of 400K base`), shown beside the field while
	 * typing; undefined for input that does not parse or fit.
	 */
	previewCompactionPoint?: (model: Model, input: string) => string | undefined;
	onCancel: () => void;
}

/** Why {@link ModelHubCallbacks.onCompactionPointChange} kept the field open. */
export type CompactionPointChangeResult = { kind: "error"; message: string } | { kind: "confirm"; message: string };

export interface ModelHubOptions {
	/** Preselect this provider's sidebar entry (e.g. when reopening after /login). */
	initialProviderId?: string;
	/** `provider/id` of the session's model, marked current in the native picker. */
	currentSelector?: string;
}
