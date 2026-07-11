import { once } from "@pk-nerdsaver-ai/pi-utils";
import { fetchCodexModels } from "../discovery/codex";
import type { DevinModelDiscoveryOptions } from "../discovery/devin";
import { buildGitLabDuoWorkflowFallbackModel, fetchGitLabDuoWorkflowModels } from "../discovery/gitlab-duo-workflow";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";

// ---------------------------------------------------------------------------
// OpenAI Codex
// ---------------------------------------------------------------------------

export interface OpenAICodexModelManagerConfig {
	accessToken?: string;
	accountId?: string;
	clientVersion?: string;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { accessToken, accountId, clientVersion } = config;
	return {
		providerId: "openai-codex",
		...(accessToken
			? {
					fetchDynamicModels: async () => {
						const result = await fetchCodexModels({ accessToken, accountId, clientVersion });
						return result?.models ?? null;
					},
				}
			: undefined),
	};
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
// Zai
// ---------------------------------------------------------------------------

export interface ZaiModelManagerConfig {}

export function zaiModelManagerOptions(_config: ZaiModelManagerConfig = {}): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "zai" };
}
