import { once } from "@oh-my-pi/pi-utils";
import { type CodexModelDiscoveryResult, fetchCodexModels } from "../discovery/codex";
import type { DevinModelDiscoveryOptions } from "../discovery/devin";
import { buildGitLabDuoWorkflowFallbackModel, fetchGitLabDuoWorkflowModels } from "../discovery/gitlab-duo-workflow";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec } from "../types";
import { resolveModelCacheProviderId } from "./cache-provider-id";
import { buildGrokbotStaticSeed } from "./grokbot";

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
							accounts.map(account =>
								fetchCodexModels({
									accessToken: account.accessToken,
									accountId: account.accountId,
									clientVersion,
									fetchFn: fetch,
								}),
							),
						);
						return unionCodexModels(results);
					},
				}
			: undefined),
	};
}

/**
 * Merge complete per-account Codex catalogs into one authoritative list,
 * deduped by model id (first account to expose an id wins). Returns `null` when
 * any account's fetch failed, so a partial list cannot replace the previous or
 * bundled authoritative catalog.
 */
function unionCodexModels(
	results: readonly (CodexModelDiscoveryResult | null)[],
): ModelSpec<"openai-codex-responses">[] | null {
	const byId = new Map<string, ModelSpec<"openai-codex-responses">>();
	for (const result of results) {
		if (!result) return null;
		for (const model of result.models) {
			if (!byId.has(model.id)) byId.set(model.id, model);
		}
	}
	return [...byId.values()];
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

export function devinModelManagerOptions(config: DevinModelManagerConfig = {}): ModelManagerOptions<"devin-agent"> {
	const { apiKey, baseUrl, fetch } = config;
	return {
		providerId: "devin",
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
// Grok Bot provider (InferenceService Stream)
// ---------------------------------------------------------------------------

export interface GrokbotModelManagerConfig {
	baseUrl?: string;
}

export function grokbotModelManagerOptions(
	config: GrokbotModelManagerConfig = {},
): ModelManagerOptions<"grokbot-sand"> {
	return {
		providerId: "grokbot",
		staticModels: buildGrokbotStaticSeed(config.baseUrl),
	};
}

// ---------------------------------------------------------------------------
// Zai
// ---------------------------------------------------------------------------

export interface ZaiModelManagerConfig {}

export function zaiModelManagerOptions(_config: ZaiModelManagerConfig = {}): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "zai" };
}
