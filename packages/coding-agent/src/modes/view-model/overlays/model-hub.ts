import type { KeysApi, Model } from "@oh-my-pi/pi-ai";
import type { JudgmentApi, NativeJudgeRouteDraft } from "@oh-my-pi/pi-ai/judgment/native";
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
	refreshIfStale(): Promise<boolean>;
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

/** A native route as the open Ctrl+R or Ctrl+N form would save it, sent by its Test route action (Ctrl+T). */
export interface NativeJudgeRouteTest {
	route: NativeJudgeRouteDraft;
	/** The catalog model Ctrl+R edits; absent for a Ctrl+N declaration. */
	model?: Model;
	/** The key typed into Ctrl+N's key step (with its Cloudflare account ID), not yet stored. */
	credential?: { token: string; accountId?: string };
}

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
	/**
	 * Declare `model` a native judge on `api` at the endpoint root `baseUrl` (models.yml metadata only; no
	 * role, fallback or credential changes). Resolves to the reloaded model; a rejection keeps the form open.
	 * Without it, the Judge screen offers no Ctrl+R.
	 */
	onSaveNativeRoute?: (model: Model, api: JudgmentApi, baseUrl: string) => Promise<Model>;
	/** Declare a model the catalog does not list as a native judge (Ctrl+N); same contract as {@link onSaveNativeRoute}. */
	onCreateNativeJudgeRoute?: (draft: NativeJudgeRouteDraft) => Promise<Model>;
	/** Store an API key (with a Cloudflare account ID for Workers AI) for a model created with Ctrl+N. */
	onSaveNativeJudgeCredential?: (model: Model, credential: { token: string; accountId?: string }) => Promise<void>;
	/**
	 * The key source a provider's requests use ahead of a stored API key (models.yml `apiKey`, an environment
	 * variable, a login), described for display; `undefined` when a key stored by Ctrl+N would be used.
	 */
	nativeJudgeKeySource?: (provider: string) => string | undefined;
	/**
	 * Send one test judgment through the drafted route (Ctrl+T in the endpoint and key steps) and describe the
	 * outcome; nothing is saved. `signal` aborts when the form closes or a newer test starts. A rejection shows
	 * as a failed test. Without it, the forms offer no Ctrl+T.
	 */
	onTestNativeRoute?: (test: NativeJudgeRouteTest, signal: AbortSignal) => Promise<{ ok: boolean; message: string }>;
	/** Locked provider activation: forward to the /login flow. */
	onLoginRequest?: (providerId: string) => void;
	/** Returns the rebuilt `--models` scope for the hub to list; `undefined` keeps the current one. */
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
