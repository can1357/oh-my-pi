import { logger, once } from "@oh-my-pi/pi-utils";
import { buildModel } from "../build";
import { apiRouteFor } from "../compat/behavior";
import { type CodexModelDiscoveryResult, fetchCodexModels } from "../discovery/codex";
import type { DevinModelDiscoveryOptions } from "../discovery/devin";
import { buildGitLabDuoWorkflowFallbackModel, fetchGitLabDuoWorkflowModels } from "../discovery/gitlab-duo-workflow";
import type { ModelManagerOptions } from "../model-manager";
import { getBundledModel } from "../models";
import type { Api, FetchImpl, Model, ModelSpec } from "../types";
import { DEVIN_DEFAULT_BASE_URL } from "../wire/devin";
import { toModelSpec } from "./bundled-references";
import { resolveModelCacheProviderId } from "./cache-provider-id";

// ---------------------------------------------------------------------------
// OpenAI Codex
// ---------------------------------------------------------------------------

/** One Codex OAuth account to fetch a catalog for. */
export interface OpenAICodexAccount {
	/** OAuth access token used for `Authorization: Bearer ...`. */
	accessToken: string;
	/** ChatGPT account id sent as the `chatgpt-account-id` header. */
	accountId?: string;
}

export interface OpenAICodexModelManagerConfig {
	/**
	 * Resolves every configured Codex OAuth account at discovery time. Codex
	 * discovery is account-scoped — a model can be available to one account and
	 * absent from another — so each account's `/models` endpoint is fetched
	 * independently and the results unioned by id. Without this, discovery would
	 * surface only the account it happened to resolve and, being authoritative,
	 * prune every model the other accounts expose (#6265).
	 *
	 * Returns `null` to abort discovery entirely (e.g. an account's credential
	 * failed to refresh): a partial account set would be cached as the complete
	 * authoritative catalog and hide the missing account's models, so the caller
	 * keeps the previous/bundled catalog instead.
	 */
	resolveAccounts?: () => Promise<readonly OpenAICodexAccount[] | null>;
	clientVersion?: string;
	fetch?: FetchImpl;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { resolveAccounts, clientVersion, fetch } = config;
	return {
		providerId: "openai-codex",
		dynamicModelsAuthoritative: true,
		...(resolveAccounts
			? {
					fetchDynamicModels: async () => {
						const accounts = await resolveAccounts();
						if (!accounts || accounts.length === 0) return null;
						const results = await Promise.all(
							accounts.map(async account => ({
								accountId: account.accountId,
								result: await fetchCodexModels({
									accessToken: account.accessToken,
									accountId: account.accountId,
									clientVersion,
									fetchFn: fetch,
								}),
							})),
						);
						return unionCodexModels(results);
					},
				}
			: undefined),
	};
}

/**
 * Merge complete per-account Codex catalogs into one authoritative list,
 * deduped by model id (first account to expose an id wins).
 *
 * Returns `null` when any account's fetch failed transiently, so a partial list
 * cannot replace the previous or bundled authoritative catalog. An account
 * whose credential the backend rejected outright (401/403 — revoked or
 * deauthorized) contributes nothing and is skipped instead: it would otherwise
 * veto every sibling account's models until the user removes it. If no account
 * produced a catalog, discovery aborts the same way.
 */
function unionCodexModels(
	results: readonly { accountId: string | undefined; result: CodexModelDiscoveryResult | null }[],
): ModelSpec<"openai-codex-responses">[] | null {
	const byId = new Map<string, ModelSpec<"openai-codex-responses">>();
	let catalogs = 0;
	for (const { accountId, result } of results) {
		if (!result) return null;
		if (result.rejectedStatus !== undefined) {
			logger.warn("Codex model discovery skipped an account whose credential was rejected", {
				accountId,
				status: result.rejectedStatus,
			});
			continue;
		}
		catalogs++;
		for (const model of result.models) {
			if (!byId.has(model.id)) byId.set(model.id, model);
		}
	}
	return catalogs > 0 ? [...byId.values()] : null;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface CursorModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	clientVersion?: string;
}

export function cursorModelManagerOptions(config: CursorModelManagerConfig = {}): ModelManagerOptions<"cursor-agent"> {
	const { apiKey, baseUrl, clientVersion } = config;
	return {
		providerId: "cursor",
		cacheProviderId: resolveModelCacheProviderId("cursor"),
		...(apiKey
			? {
					fetchDynamicModels: async () => {
						const { fetchCursorUsableModels } = await cursorDiscovery();
						return fetchCursorUsableModels({ apiKey, baseUrl, clientVersion });
					},
				}
			: undefined),
	};
}

const cursorDiscovery = once(() => import("../discovery/cursor"));

// ---------------------------------------------------------------------------
// GitLab Duo Chat
// ---------------------------------------------------------------------------

const GITLAB_DUO_ANTHROPIC_BASE_URL = "https://cloud.gitlab.com/ai/v1/proxy/anthropic/";
const GITLAB_DUO_OPENAI_BASE_URL = "https://cloud.gitlab.com/ai/v1/proxy/openai/v1";

export type GitLabDuoModelIdentity = {
	upstreamModelId: string;
	referenceProvider: "anthropic" | "openai";
	referenceModelId: string;
};

/**
 * Duo's public aliases are deployment identity, not model metadata. The
 * reference ids select bundled first-party rows; capabilities, prices, and
 * limits are copied from those rows rather than repeated here.
 */
const GITLAB_DUO_MODEL_IDENTITIES: Readonly<Record<string, GitLabDuoModelIdentity>> = {
	"duo-chat-opus-4-6": {
		upstreamModelId: "claude-opus-4-6",
		referenceProvider: "anthropic",
		referenceModelId: "claude-opus-4-6",
	},
	"duo-chat-sonnet-4-6": {
		upstreamModelId: "claude-sonnet-4-6",
		referenceProvider: "anthropic",
		referenceModelId: "claude-sonnet-4-6",
	},
	"duo-chat-opus-4-5": {
		upstreamModelId: "claude-opus-4-5-20251101",
		referenceProvider: "anthropic",
		referenceModelId: "claude-opus-4-5-20251101",
	},
	"duo-chat-sonnet-4-5": {
		upstreamModelId: "claude-sonnet-4-5-20250929",
		referenceProvider: "anthropic",
		referenceModelId: "claude-sonnet-4-5-20250929",
	},
	"duo-chat-haiku-4-5": {
		upstreamModelId: "claude-haiku-4-5-20251001",
		referenceProvider: "anthropic",
		referenceModelId: "claude-haiku-4-5-20251001",
	},
	"duo-chat-gpt-5-1": {
		upstreamModelId: "gpt-5.1-2025-11-13",
		referenceProvider: "openai",
		referenceModelId: "gpt-5.1",
	},
	"duo-chat-gpt-5-2": {
		upstreamModelId: "gpt-5.2-2025-12-11",
		referenceProvider: "openai",
		referenceModelId: "gpt-5.2",
	},
	"duo-chat-gpt-5-mini": {
		upstreamModelId: "gpt-5-mini-2025-08-07",
		referenceProvider: "openai",
		referenceModelId: "gpt-5-mini",
	},
	"duo-chat-gpt-5-codex": {
		upstreamModelId: "gpt-5-codex",
		referenceProvider: "openai",
		referenceModelId: "gpt-5-codex",
	},
	"duo-chat-gpt-5-2-codex": {
		upstreamModelId: "gpt-5.2-codex",
		referenceProvider: "openai",
		referenceModelId: "gpt-5.2-codex",
	},
};

export function resolveGitLabDuoModelIdentity(modelId: string): GitLabDuoModelIdentity | undefined {
	const direct = GITLAB_DUO_MODEL_IDENTITIES[modelId];
	if (direct) return direct;
	for (const alias in GITLAB_DUO_MODEL_IDENTITIES) {
		const identity = GITLAB_DUO_MODEL_IDENTITIES[alias];
		if (identity?.upstreamModelId === modelId) return identity;
	}
	return undefined;
}

function gitLabDuoDisplayName(alias: string): string {
	const parts = alias.slice("duo-chat-".length).split("-");
	const family = parts.shift();
	if (!family) return alias;
	const numeric: string[] = [];
	while (parts[0] !== undefined && /^\d+$/.test(parts[0])) {
		const part = parts.shift();
		if (part !== undefined) numeric.push(part);
	}
	const familyName = family === "gpt" ? "GPT" : `${family[0]?.toUpperCase() ?? ""}${family.slice(1)}`;
	const version = numeric.length > 0 ? `${family === "gpt" ? "-" : " "}${numeric.join(".")}` : "";
	const suffix = parts.map(part => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
	return `Duo Chat ${familyName}${version}${suffix ? ` ${suffix}` : ""}`;
}

export function getGitLabDuoModels(): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const alias in GITLAB_DUO_MODEL_IDENTITIES) {
		const identity = GITLAB_DUO_MODEL_IDENTITIES[alias];
		if (!identity) continue;
		const reference = getBundledModel(identity.referenceProvider, identity.referenceModelId);
		if (!reference) {
			throw new Error(
				`Missing bundled ${identity.referenceProvider}/${identity.referenceModelId} reference for ${alias}`,
			);
		}
		const route = apiRouteFor("gitlab-duo", alias)?.api;
		if (route !== "anthropic-messages" && route !== "openai-completions" && route !== "openai-responses") {
			throw new Error(`Missing GitLab Duo API route for ${alias}`);
		}
		models.push(
			buildModel({
				...toModelSpec(reference),
				id: alias,
				name: gitLabDuoDisplayName(alias),
				api: route,
				provider: "gitlab-duo",
				baseUrl: route === "anthropic-messages" ? GITLAB_DUO_ANTHROPIC_BASE_URL : GITLAB_DUO_OPENAI_BASE_URL,
			}),
		);
	}
	return models;
}

// ---------------------------------------------------------------------------
// GitLab Duo Workflow
// ---------------------------------------------------------------------------

export interface GitLabDuoWorkflowModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	namespaceId?: string;
	projectId?: string;
	cwd?: string;
}

export function gitLabDuoWorkflowModelManagerOptions(
	config: GitLabDuoWorkflowModelManagerConfig = {},
): ModelManagerOptions<"gitlab-duo-agent"> {
	const apiKey = config.apiKey;
	return {
		providerId: "gitlab-duo-agent",
		// GitLab Duo discovery is credential- and namespace-specific
		// (`aiChatAvailableModels(rootNamespaceId:)` also surfaces namespace-pinned
		// models), so the default provider-id cache namespace would let a second
		// account/namespace load the first one's authoritative model list at startup
		// and skip refetching. Partition the cache by a non-reversible fingerprint of
		// the exact inputs `fetchGitLabDuoWorkflowModels` resolves the namespace from
		// (credential + base URL + namespace/project config + the same env vars + the
		// effective workspace cwd whose git remote drives auto-discovery). Built-in
		// discovery only passes apiKey/baseUrl/fetch, so the cwd/env terms — not the
		// empty config fields — are what actually separate workspace A from B here.
		// Falls back to the bare provider id when no credential is present.
		...(apiKey ? { cacheProviderId: gitLabDuoWorkflowModelCacheProviderId(apiKey, config) } : undefined),
		dynamicModelsAuthoritative: true,
		staticModels: [
			buildGitLabDuoWorkflowFallbackModel("claude_sonnet_4_6_vertex", "Claude Sonnet 4.6 - Vertex", config.baseUrl),
		],
		...(apiKey
			? {
					fetchDynamicModels: async () =>
						fetchGitLabDuoWorkflowModels({
							apiKey,
							baseUrl: config.baseUrl,
							fetch: config.fetch,
							namespaceId: config.namespaceId,
							projectId: config.projectId,
							cwd: config.cwd,
						}),
				}
			: undefined),
	};
}

function gitLabDuoWorkflowModelCacheProviderId(apiKey: string, config: GitLabDuoWorkflowModelManagerConfig): string {
	// Mirror the exact inputs `discoverGitLabDuoWorkflowNamespace` keys off: explicit
	// namespace/project config OR the same env vars, then the git remote at the
	// effective cwd. Built-in discovery leaves the config fields empty, so the env +
	// resolved cwd terms are what actually distinguish two workspaces sharing a token.
	const namespaceId = config.namespaceId ?? Bun.env.GITLAB_DUO_NAMESPACE_ID ?? "";
	const projectId = config.projectId ?? Bun.env.GITLAB_DUO_PROJECT_ID ?? Bun.env.GITLAB_DUO_PROJECT_PATH ?? "";
	const cwd = config.cwd ?? process.cwd();
	const scope = [config.baseUrl ?? "", namespaceId, projectId, cwd].join("\u0000");
	return `gitlab-duo-agent:${Bun.hash(`${apiKey}\u0000${scope}`).toString(36)}`;
}

// Devin (Codeium Cascade)
// ---------------------------------------------------------------------------

export interface DevinModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: DevinModelDiscoveryOptions["fetch"];
}

/**
 * Curated Devin seed — the entire bundled surface for the provider. The
 * Cascade catalog is credential-scoped (gated per account/team), so catalog
 * generation never fetches it: baking one account's roster into the shared
 * bundle would misstate every other account's entitlements and leave zombie
 * rows behind (see CREDENTIAL_SCOPED_PROVIDERS in generate-models.ts). Both
 * SWE-1.6 lanes are verified live against `GetCliModelConfigs`; the
 * descriptor's `defaultModel` (`swe-1-6`) must resolve synchronously at
 * boot, before credential-scoped runtime discovery replaces the seed. Field
 * shape mirrors `devinModelSpec` so seeded and discovered rows are
 * indistinguishable downstream.
 */
export const DEVIN_STATIC_MODELS: readonly ModelSpec<"devin-agent">[] = [
	{
		id: "swe-1-6-fast",
		name: "SWE-1.6 Fast",
		api: "devin-agent",
		provider: "devin",
		baseUrl: DEVIN_DEFAULT_BASE_URL,
		reasoning: true,
		// SWE-1.6 lanes ignore inline images despite upstream `supports_images`
		// (see DEVIN_IMAGE_BLIND_UIDS in ../discovery/devin.ts).
		input: ["text"],
		supportsTools: true,
		cost: { input: 0.3, output: 1.5, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		compat: { supportsParallelToolCalls: true },
	},
	{
		id: "swe-1-6",
		name: "SWE-1.6",
		api: "devin-agent",
		provider: "devin",
		baseUrl: DEVIN_DEFAULT_BASE_URL,
		reasoning: true,
		input: ["text"],
		supportsTools: true,
		// Included in the Coding Plan: upstream reports no cost dimensions.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		compat: { supportsParallelToolCalls: true },
	},
];

export function devinModelManagerOptions(config: DevinModelManagerConfig = {}): ModelManagerOptions<"devin-agent"> {
	const { apiKey, baseUrl, fetch } = config;
	return {
		providerId: "devin",
		// A configured host serves its own Cascade deployment; keep the seed on it.
		staticModels:
			baseUrl === undefined || baseUrl === DEVIN_DEFAULT_BASE_URL
				? DEVIN_STATIC_MODELS
				: DEVIN_STATIC_MODELS.map(model => ({ ...model, baseUrl })),
		...(apiKey ? { dynamicModelsAuthoritative: true } : undefined),
		...(apiKey
			? {
					fetchDynamicModels: async () => {
						const { fetchDevinModels } = await devinDiscovery();
						return fetchDevinModels({ apiKey, baseUrl, fetch });
					},
				}
			: undefined),
	};
}

const devinDiscovery = once(() => import("../discovery/devin"));
// ---------------------------------------------------------------------------
// Zai
// ---------------------------------------------------------------------------

export interface ZaiModelManagerConfig {}

/** Creates model-manager options for Z.AI's mixed native and Anthropic transports. */
export function zaiModelManagerOptions(
	_config: ZaiModelManagerConfig = {},
): ModelManagerOptions<"anthropic-messages" | "openai-completions"> {
	return { providerId: "zai" };
}
