import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod/v4";
import type { FetchImpl, ModelSpec } from "../types";
import { isRecord } from "../utils";

const GITLAB_DEFAULT_BASE_URL = "https://gitlab.com";
const GRAPHQL_PATH = "/api/graphql";
const PROJECTS_PATH = "/api/v4/projects";
const GROUPS_PATH = "/api/v4/groups";
const FALLBACK_MODEL_ID = "claude_sonnet_4_6_vertex";
const FALLBACK_MODEL_NAME = "Claude Sonnet 4.6 - Vertex";
// Bound the top-level group pagination so a misbehaving server cannot loop forever.
// 50 pages × 100/page covers 5000 top-level groups, far beyond any realistic account.
const GITLAB_DUO_WORKFLOW_MAX_GROUP_PAGES = 50;

// GitLab Duo Workflow does not expose a context window via the model catalog GraphQL.
// The Duo Workflow Service streams the real per-agent window in each checkpoint's
// `agent_context_usage` (claude_opus_4_8 observed at 1_000_000), but OMP's context
// panel / auto-compaction read `model.contextWindow` from the catalog ModelSpec, which
// the provider cannot backfill at runtime. Match the model ref to a static window the
// same way other providers ship static values; DWS' own global fallback is 200_000
// (duo_workflow_service/conversation/trimmer.py).
const GITLAB_DUO_WORKFLOW_DEFAULT_CONTEXT_WINDOW = 200_000;
const GITLAB_DUO_WORKFLOW_CONTEXT_WINDOW_RULES: readonly { pattern: RegExp; contextWindow: number }[] = [
	{ pattern: /claude[_-]?opus/i, contextWindow: 1_000_000 },
	{ pattern: /claude[_-]?sonnet/i, contextWindow: 1_000_000 },
	{ pattern: /claude[_-]?haiku/i, contextWindow: 200_000 },
	{ pattern: /gemini/i, contextWindow: 1_000_000 },
	{ pattern: /gpt[_-]?5/i, contextWindow: 400_000 },
];

function resolveGitLabDuoWorkflowContextWindow(modelRef: string): number {
	for (const rule of GITLAB_DUO_WORKFLOW_CONTEXT_WINDOW_RULES) {
		if (rule.pattern.test(modelRef)) return rule.contextWindow;
	}
	return GITLAB_DUO_WORKFLOW_DEFAULT_CONTEXT_WINDOW;
}

const AI_CHAT_AVAILABLE_MODELS_QUERY = `query lsp_aiChatAvailableModels($rootNamespaceId: GroupID!) {
  aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
    defaultModel { name ref }
    selectableModels { name ref }
    pinnedModel { name ref }
  }
}`;

const ProjectRootNamespaceQuery = `query omp_gitlabDuoWorkflowProjectRootNamespace($fullPath: ID!) {
  project(fullPath: $fullPath) {
    namespace {
      id
      rootAncestor { id }
    }
  }
}`;

const modelRefSchema = z
	.object({
		name: z.string().optional().catch(undefined),
		ref: z.string().optional().catch(undefined),
	})
	.loose();

const aiChatAvailableModelsSchema = z
	.object({
		defaultModel: z.unknown().nullable().optional(),
		selectableModels: z.array(z.unknown()).nullable().optional().catch([]),
		pinnedModel: z.unknown().nullable().optional(),
	})
	.loose();

type GitLabDuoWorkflowCandidateSource = "override" | "project" | "remote" | "group";

export interface GitLabDuoWorkflowModelRef {
	name: string;
	ref: string;
}

interface GitLabDuoWorkflowAvailability {
	defaultModel: GitLabDuoWorkflowModelRef | null;
	selectableModels: readonly GitLabDuoWorkflowModelRef[];
	pinnedModel: GitLabDuoWorkflowModelRef | null;
}

interface GitLabDuoWorkflowCandidate {
	rootNamespaceId: string;
	namespacePath?: string;
	// The concrete GitLab project (full path) this namespace was resolved from, when
	// the candidate came from an explicit project id/path or the workspace git remote.
	// Carried forward so runtime scoping uses the actual repository project instead of
	// a generic group project.
	projectPath?: string;
	source: GitLabDuoWorkflowCandidateSource;
}

interface GitLabDuoWorkflowNamespaceSelectionWithModels extends GitLabDuoWorkflowNamespaceSelection {
	models: GitLabDuoWorkflowAvailability;
}

/**
 * GitLab Duo Workflow model/namespace discovery configuration.
 */
export interface GitLabDuoWorkflowDiscoveryConfig {
	apiKey: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	namespaceId?: string;
	projectId?: string;
	projectPath?: string;
	cwd?: string;
}

export interface GitLabDuoWorkflowNamespaceSelection {
	rootNamespaceId: string;
	namespacePath?: string;
	// Concrete GitLab project (full path) the namespace was resolved from, when known
	// (explicit project config or the workspace git remote). The runtime prefers this
	// over a generic group project so the workflow scopes to the active repository.
	projectPath?: string;
	source: GitLabDuoWorkflowCandidateSource;
}

export async function discoverGitLabDuoWorkflowNamespace(
	config: GitLabDuoWorkflowDiscoveryConfig,
): Promise<GitLabDuoWorkflowNamespaceSelection> {
	const selection = await selectGitLabDuoWorkflowNamespace(config);
	return {
		rootNamespaceId: selection.rootNamespaceId,
		...(selection.namespacePath ? { namespacePath: selection.namespacePath } : {}),
		...(selection.projectPath ? { projectPath: selection.projectPath } : {}),
		source: selection.source,
	};
}

export async function discoverGitLabDuoWorkflowRuntimeNamespace(
	config: GitLabDuoWorkflowDiscoveryConfig,
): Promise<GitLabDuoWorkflowNamespaceSelection> {
	const baseUrl = normalizeGitLabBaseUrl(config.baseUrl);
	const selection = await selectGitLabDuoWorkflowCandidate(config, baseUrl, resolveRuntimeNamespaceCandidate, true);
	if (selection) {
		return selection;
	}
	throw new Error(
		"Unable to find a GitLab Duo Workflow namespace. Set GITLAB_DUO_NAMESPACE_ID to a root namespace or GITLAB_DUO_PROJECT_ID to a GitLab project.",
	);
}

export async function fetchGitLabDuoWorkflowModels(
	config: GitLabDuoWorkflowDiscoveryConfig,
): Promise<readonly ModelSpec<"gitlab-duo-agent">[] | null> {
	const selection = await discoverGitLabDuoWorkflowNamespace(config);
	const baseUrl = normalizeGitLabBaseUrl(config.baseUrl);
	const availability = await fetchAiChatAvailableModels(config, baseUrl, selection.rootNamespaceId);
	if (!availability) {
		return null;
	}
	const modelRefs = resolveModelRefs(availability);
	if (modelRefs.length === 0) {
		return null;
	}
	return modelRefs.map(model => buildGitLabDuoWorkflowModelSpec(model, baseUrl, selection.rootNamespaceId));
}

export function buildGitLabDuoWorkflowModelSpec(
	model: GitLabDuoWorkflowModelRef,
	baseUrl = GITLAB_DEFAULT_BASE_URL,
	rootNamespaceId?: string,
): ModelSpec<"gitlab-duo-agent"> {
	const normalizedBaseUrl = normalizeGitLabBaseUrl(baseUrl);
	return {
		id: model.ref,
		name: model.name,
		api: "gitlab-duo-agent",
		provider: "gitlab-duo-agent",
		baseUrl: normalizedBaseUrl,
		// The Duo Agent Platform path exposes no client-controllable thinking knob
		// (Anthropic model params are server-fixed; see provider notes), so reasoning
		// is off — this also hides OMP's thinking-effort selector for these models.
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: resolveGitLabDuoWorkflowContextWindow(model.ref),
		maxTokens: null,
		supportsTools: true,
		...(rootNamespaceId ? { gitlabDuoWorkflowRootNamespaceId: rootNamespaceId } : undefined),
	};
}

export function buildGitLabDuoWorkflowFallbackModel(
	id = FALLBACK_MODEL_ID,
	name = FALLBACK_MODEL_NAME,
	baseUrl = GITLAB_DEFAULT_BASE_URL,
): ModelSpec<"gitlab-duo-agent"> {
	return buildGitLabDuoWorkflowModelSpec({ name, ref: id }, baseUrl);
}

async function selectGitLabDuoWorkflowNamespace(
	config: GitLabDuoWorkflowDiscoveryConfig,
): Promise<GitLabDuoWorkflowNamespaceSelectionWithModels> {
	const baseUrl = normalizeGitLabBaseUrl(config.baseUrl);
	const selection = await selectGitLabDuoWorkflowCandidate(config, baseUrl, candidate =>
		validateNamespaceCandidate(config, baseUrl, candidate),
	);
	if (selection) {
		return selection;
	}
	throw new Error(
		"Unable to find a GitLab Duo Workflow namespace with available models. Set GITLAB_DUO_NAMESPACE_ID to a root namespace with Duo model access.",
	);
}

type GitLabDuoWorkflowCandidateResolver<TSelection> = (
	candidate: GitLabDuoWorkflowCandidate,
) => Promise<TSelection | null> | TSelection | null;

async function selectGitLabDuoWorkflowCandidate<TSelection>(
	config: GitLabDuoWorkflowDiscoveryConfig,
	baseUrl: string,
	resolveCandidate: GitLabDuoWorkflowCandidateResolver<TSelection>,
	enrichNamespaceOverride = false,
): Promise<TSelection | null> {
	const namespaceId = normalizeIdentifier(config.namespaceId) ?? normalizeIdentifier(Bun.env.GITLAB_DUO_NAMESPACE_ID);
	if (namespaceId) {
		const candidate = enrichNamespaceOverride
			? ((await fetchNamespaceOverrideCandidate(config, baseUrl, namespaceId)) ?? {
					rootNamespaceId: namespaceId,
					source: "override" as const,
				})
			: { rootNamespaceId: namespaceId, source: "override" as const };
		const selected = await resolveCandidate(candidate);
		if (selected) {
			return selected;
		}
	}

	const projectId =
		normalizeIdentifier(config.projectId) ??
		normalizeIdentifier(config.projectPath) ??
		normalizeIdentifier(Bun.env.GITLAB_DUO_PROJECT_ID) ??
		normalizeIdentifier(Bun.env.GITLAB_DUO_PROJECT_PATH);
	if (projectId) {
		const projectNamespace = await fetchProjectRootNamespace(config, baseUrl, projectId);
		if (projectNamespace) {
			const selected = await resolveCandidate({
				rootNamespaceId: projectNamespace,
				// Only a full path (group/project) is meaningful as a runtime project
				// scope; a bare numeric id resolves the namespace but is not carried.
				...(projectId.includes("/") ? { projectPath: projectId } : {}),
				source: "project",
			});
			if (selected) {
				return selected;
			}
		}
	}

	const remoteProjectPath = await discoverGitLabRemoteProjectPath(config.cwd, baseUrl);
	if (remoteProjectPath) {
		const remoteNamespace = await fetchProjectRootNamespace(config, baseUrl, remoteProjectPath);
		if (remoteNamespace) {
			const selected = await resolveCandidate({
				rootNamespaceId: remoteNamespace,
				projectPath: remoteProjectPath,
				source: "remote",
			});
			if (selected) {
				return selected;
			}
		}
	}

	for (const groupNamespace of await fetchTopLevelGroupNamespaceCandidates(config, baseUrl)) {
		const selected = await resolveCandidate(groupNamespace);
		if (selected) {
			return selected;
		}
	}

	return null;
}

function resolveRuntimeNamespaceCandidate(
	candidate: GitLabDuoWorkflowCandidate,
): GitLabDuoWorkflowNamespaceSelection | null {
	const rootNamespaceId = normalizeIdentifier(candidate.rootNamespaceId);
	const namespacePath = normalizeIdentifier(candidate.namespacePath);
	const projectPath = normalizeIdentifier(candidate.projectPath);
	return rootNamespaceId
		? {
				rootNamespaceId,
				...(namespacePath ? { namespacePath } : {}),
				...(projectPath ? { projectPath } : {}),
				source: candidate.source,
			}
		: null;
}

async function validateNamespaceCandidate(
	config: GitLabDuoWorkflowDiscoveryConfig,
	baseUrl: string,
	candidate: GitLabDuoWorkflowCandidate,
): Promise<GitLabDuoWorkflowNamespaceSelectionWithModels | null> {
	const rootNamespaceId = normalizeIdentifier(candidate.rootNamespaceId);
	if (!rootNamespaceId) {
		return null;
	}
	const models = await fetchAiChatAvailableModels(config, baseUrl, rootNamespaceId);
	if (!models || resolveModelRefs(models).length === 0) {
		return null;
	}
	const namespacePath = normalizeIdentifier(candidate.namespacePath);
	return { rootNamespaceId, ...(namespacePath ? { namespacePath } : {}), source: candidate.source, models };
}

async function fetchAiChatAvailableModels(
	config: GitLabDuoWorkflowDiscoveryConfig,
	baseUrl: string,
	rootNamespaceId: string,
): Promise<GitLabDuoWorkflowAvailability | null> {
	const payload = await postGraphQL(config, baseUrl, AI_CHAT_AVAILABLE_MODELS_QUERY, {
		rootNamespaceId: toGraphQLRootNamespaceId(rootNamespaceId),
	});
	if (!payload) {
		return null;
	}
	const data = getRecord(payload, "data");
	const rawModels = data?.aiChatAvailableModels;
	if (rawModels === null || rawModels === undefined) {
		return null;
	}
	return parseAvailability(rawModels);
}

async function fetchNamespaceOverrideCandidate(
	config: GitLabDuoWorkflowDiscoveryConfig,
	baseUrl: string,
	namespaceId: string,
): Promise<GitLabDuoWorkflowCandidate | null> {
	const restNamespaceId = toRestNamespaceId(namespaceId);
	if (!restNamespaceId) {
		return null;
	}
	const fetchImpl = config.fetch ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}${GROUPS_PATH}/${encodeURIComponent(restNamespaceId)}`, {
			method: "GET",
			headers: buildGitLabJsonHeaders(config.apiKey),
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}
	const rootNamespaceId = extractRootNamespaceId(payload) ?? namespaceId;
	const namespacePath = extractNamespacePath(payload);
	return {
		rootNamespaceId,
		...(namespacePath ? { namespacePath } : {}),
		source: "override",
	};
}

function toRestNamespaceId(namespaceId: string): string | null {
	const gidMatch = namespaceId.match(/^gid:\/\/gitlab\/(?:Group|Namespace)\/(\d+)$/);
	if (gidMatch?.[1]) return gidMatch[1];
	return /^\d+$/.test(namespaceId) ? namespaceId : null;
}

async function fetchProjectRootNamespace(
	config: GitLabDuoWorkflowDiscoveryConfig,
	baseUrl: string,
	projectIdOrPath: string,
): Promise<string | null> {
	const rest = await fetchProjectRootNamespaceViaRest(config, baseUrl, projectIdOrPath);
	if (rest?.rootNamespaceId) {
		return rest.rootNamespaceId;
	}
	// A normal GitLab project payload exposes only the immediate `namespace`, not
	// the root ancestor, so a leaf project under a subgroup yields no explicit
	// root above. Resolve the root via GraphQL `rootAncestor`, keyed by the
	// project's full path. For a numeric id the path is unknown until the REST
	// payload returns it (`path_with_namespace`); fall back to the literal value
	// only when it is already a path.
	const fullPath = rest?.pathWithNamespace ?? (projectIdOrPath.includes("/") ? projectIdOrPath : null);
	if (!fullPath) {
		return null;
	}
	return fetchProjectRootNamespaceViaGraphQL(config, baseUrl, fullPath);
}

interface GitLabDuoWorkflowRestProject {
	rootNamespaceId: string | null;
	pathWithNamespace: string | null;
}

async function fetchProjectRootNamespaceViaRest(
	config: GitLabDuoWorkflowDiscoveryConfig,
	baseUrl: string,
	projectIdOrPath: string,
): Promise<GitLabDuoWorkflowRestProject | null> {
	const fetchImpl = config.fetch ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}${PROJECTS_PATH}/${encodeURIComponent(projectIdOrPath)}`, {
			method: "GET",
			headers: buildGitLabJsonHeaders(config.apiKey),
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}
	return {
		rootNamespaceId: extractExplicitRootNamespaceId(payload),
		pathWithNamespace: extractProjectFullPath(payload),
	};
}

async function fetchProjectRootNamespaceViaGraphQL(
	config: GitLabDuoWorkflowDiscoveryConfig,
	baseUrl: string,
	projectPath: string,
): Promise<string | null> {
	const payload = await postGraphQL(config, baseUrl, ProjectRootNamespaceQuery, { fullPath: projectPath });
	if (!payload) {
		return null;
	}
	const data = getRecord(payload, "data");
	const project = getRecord(data, "project");
	return extractExplicitRootNamespaceId(project);
}

async function fetchTopLevelGroupNamespaceCandidates(
	config: GitLabDuoWorkflowDiscoveryConfig,
	baseUrl: string,
): Promise<GitLabDuoWorkflowCandidate[]> {
	const fetchImpl = config.fetch ?? fetch;
	const candidates: (GitLabDuoWorkflowCandidate & { preferred: boolean })[] = [];
	// GitLab paginates `/groups`; a token can belong to more than one page of top-level
	// groups, and a usable Duo namespace may live on a later page. Follow the keyset/
	// offset pages (via the `x-next-page` header GitLab sends) until exhausted, bounded
	// so a misbehaving server cannot loop forever.
	let nextPage: string | undefined = "1";
	for (let page = 0; page < GITLAB_DUO_WORKFLOW_MAX_GROUP_PAGES && nextPage; page++) {
		const url = new URL(`${baseUrl}${GROUPS_PATH}`);
		url.searchParams.set("top_level_only", "true");
		url.searchParams.set("per_page", "100");
		url.searchParams.set("order_by", "name");
		url.searchParams.set("sort", "asc");
		url.searchParams.set("page", nextPage);

		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "GET",
				headers: buildGitLabJsonHeaders(config.apiKey),
			});
		} catch {
			break;
		}
		if (!response.ok) {
			break;
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			break;
		}
		if (!Array.isArray(payload)) {
			break;
		}
		for (const group of payload) {
			const rootNamespaceId = extractRootNamespaceId(group);
			if (!rootNamespaceId) {
				continue;
			}
			const namespacePath = extractNamespacePath(group);
			candidates.push({
				rootNamespaceId,
				...(namespacePath ? { namespacePath } : {}),
				source: "group",
				preferred: hasDuoFeatureFlag(group),
			});
		}
		nextPage = nonEmptyHeader(response.headers.get("x-next-page"));
	}
	candidates.sort((left, right) => Number(right.preferred) - Number(left.preferred));
	return candidates.map(candidate => ({
		rootNamespaceId: candidate.rootNamespaceId,
		...(candidate.namespacePath ? { namespacePath: candidate.namespacePath } : {}),
		source: candidate.source,
	}));
}

function nonEmptyHeader(value: string | null): string | undefined {
	return value && value.trim().length > 0 ? value.trim() : undefined;
}

async function postGraphQL(
	config: GitLabDuoWorkflowDiscoveryConfig,
	baseUrl: string,
	query: string,
	variables: Record<string, string>,
): Promise<unknown | null> {
	const fetchImpl = config.fetch ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}${GRAPHQL_PATH}`, {
			method: "POST",
			headers: buildGitLabJsonHeaders(config.apiKey),
			body: JSON.stringify({ query, variables }),
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function parseAvailability(value: unknown): GitLabDuoWorkflowAvailability | null {
	const parsed = aiChatAvailableModelsSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return {
		defaultModel: parseModelRef(parsed.data.defaultModel),
		selectableModels: (parsed.data.selectableModels ?? []).flatMap(model => {
			const parsedModel = parseModelRef(model);
			return parsedModel ? [parsedModel] : [];
		}),
		pinnedModel: parseModelRef(parsed.data.pinnedModel),
	};
}

function parseModelRef(value: unknown): GitLabDuoWorkflowModelRef | null {
	if (value === null || value === undefined) {
		return null;
	}
	const parsed = modelRefSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const ref = normalizeIdentifier(parsed.data.ref);
	if (!ref) {
		return null;
	}
	const name = normalizeIdentifier(parsed.data.name) ?? ref;
	return { name, ref };
}

function resolveModelRefs(availability: GitLabDuoWorkflowAvailability): readonly GitLabDuoWorkflowModelRef[] {
	if (availability.pinnedModel) {
		return [availability.pinnedModel];
	}
	if (availability.selectableModels.length > 0) {
		return availability.selectableModels;
	}
	return availability.defaultModel ? [availability.defaultModel] : [];
}

function extractExplicitRootNamespaceId(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}
	const direct = normalizeIdentifier(value.root_namespace_id) ?? normalizeIdentifier(value.rootNamespaceId);
	if (direct) {
		return direct;
	}
	const rootNamespace =
		getRecord(value.root_namespace, "") ??
		getRecord(value.rootNamespace, "") ??
		getRecord(value.root_ancestor, "") ??
		getRecord(value.rootAncestor, "");
	if (rootNamespace) {
		return (
			normalizeIdentifier(rootNamespace.id) ??
			normalizeIdentifier(rootNamespace.full_path) ??
			normalizeIdentifier(rootNamespace.fullPath)
		);
	}
	const namespace = getRecord(value.namespace, "");
	return namespace ? extractExplicitRootNamespaceId(namespace) : null;
}

function extractRootNamespaceId(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}
	const direct = normalizeIdentifier(value.root_namespace_id) ?? normalizeIdentifier(value.rootNamespaceId);
	if (direct) {
		return direct;
	}
	const rootNamespace =
		getRecord(value.root_namespace, "") ??
		getRecord(value.rootNamespace, "") ??
		getRecord(value.root_ancestor, "") ??
		getRecord(value.rootAncestor, "");
	const nestedRoot = rootNamespace
		? (normalizeIdentifier(rootNamespace.id) ??
			normalizeIdentifier(rootNamespace.full_path) ??
			normalizeIdentifier(rootNamespace.fullPath))
		: null;
	if (nestedRoot) {
		return nestedRoot;
	}
	const namespace = getRecord(value.namespace, "");
	if (namespace) {
		return (
			extractRootNamespaceId(namespace) ??
			normalizeIdentifier(namespace.id) ??
			normalizeIdentifier(namespace.full_path) ??
			normalizeIdentifier(namespace.fullPath)
		);
	}
	return normalizeIdentifier(value.id) ?? normalizeIdentifier(value.full_path) ?? normalizeIdentifier(value.fullPath);
}

function extractNamespacePath(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}
	return (
		normalizeIdentifier(value.full_path) ?? normalizeIdentifier(value.fullPath) ?? normalizeIdentifier(value.path)
	);
}

function extractProjectFullPath(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}
	return normalizeIdentifier(value.path_with_namespace) ?? normalizeIdentifier(value.fullPath);
}

function hasDuoFeatureFlag(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}
	return value.duo_features_enabled === true || value.duo_core_features_enabled === true;
}

function getRecord(value: unknown, key: string): Record<string, unknown> | null {
	const target = key ? (isRecord(value) ? value[key] : undefined) : value;
	return isRecord(target) ? target : null;
}

function normalizeIdentifier(value: unknown): string | null {
	if (typeof value !== "string" && typeof value !== "number") {
		return null;
	}
	const trimmed = String(value).trim();
	return trimmed.length > 0 ? trimmed : null;
}

function toGraphQLRootNamespaceId(rootNamespaceId: string): string {
	return /^\d+$/.test(rootNamespaceId) ? `gid://gitlab/Group/${rootNamespaceId}` : rootNamespaceId;
}

function normalizeGitLabBaseUrl(baseUrl: string | undefined): string {
	const raw = baseUrl?.trim() || GITLAB_DEFAULT_BASE_URL;
	return raw.replace(/\/+$/, "") || GITLAB_DEFAULT_BASE_URL;
}

function buildGitLabJsonHeaders(apiKey: string): Headers {
	const headers = new Headers();
	headers.set("Accept", "application/json");
	headers.set("Content-Type", "application/json");
	headers.set("Authorization", `Bearer ${apiKey}`);
	return headers;
}

async function discoverGitLabRemoteProjectPath(cwd: string | undefined, baseUrl: string): Promise<string | null> {
	const gitConfigText = await readGitConfigText(cwd ?? process.cwd());
	if (!gitConfigText) {
		return null;
	}
	const remoteUrls = parseGitRemoteUrls(gitConfigText);
	const baseHost = parseUrlHost(baseUrl);
	const basePath = parseUrlBasePath(baseUrl);
	for (const remoteUrl of remoteUrls) {
		const projectPath = parseGitLabRemoteProjectPath(remoteUrl, baseHost, basePath);
		if (projectPath) {
			return projectPath;
		}
	}
	return null;
}

async function readGitConfigText(startCwd: string): Promise<string | null> {
	let current = path.resolve(startCwd);
	while (true) {
		const gitPath = path.join(current, ".git");
		const configText = await readGitConfigFromDotGit(gitPath);
		if (configText) {
			return configText;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

async function readGitConfigFromDotGit(gitPath: string): Promise<string | null> {
	const directConfig = await readTextFile(path.join(gitPath, "config"));
	if (directConfig !== null) {
		return directConfig;
	}
	const dotGitFile = await readTextFile(gitPath);
	if (dotGitFile === null) {
		return null;
	}
	const gitDir = parseGitDirFile(dotGitFile);
	if (!gitDir) {
		return null;
	}
	const gitDirPath = path.isAbsolute(gitDir) ? gitDir : path.resolve(path.dirname(gitPath), gitDir);
	// In a linked worktree, `.git` points at `.git/worktrees/<name>` whose `config`
	// holds no remotes — those live in the common dir named by the `commondir` file.
	const commonDir = await readTextFile(path.join(gitDirPath, "commondir"));
	if (commonDir) {
		const trimmed = commonDir.trim();
		const commonDirPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(gitDirPath, trimmed);
		const commonConfig = await readTextFile(path.join(commonDirPath, "config"));
		if (commonConfig !== null) {
			return commonConfig;
		}
	}
	return readTextFile(path.join(gitDirPath, "config"));
}

async function readTextFile(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return null;
	}
}

function parseGitDirFile(value: string): string | null {
	const match = value.match(/^gitdir:\s*(.+)$/im);
	return match?.[1]?.trim() || null;
}

function parseGitRemoteUrls(configText: string): string[] {
	const urls: string[] = [];
	let inRemoteSection = false;
	for (const line of configText.split(/\r?\n/)) {
		const section = line.match(/^\s*\[([^\]]+)\]/);
		if (section) {
			inRemoteSection = /^remote\s+"[^"]+"$/.test(section[1].trim());
			continue;
		}
		if (!inRemoteSection) {
			continue;
		}
		const match = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
		if (match?.[1]) {
			urls.push(match[1]);
		}
	}
	return urls;
}

function parseGitLabRemoteProjectPath(remoteUrl: string, expectedHost: string | null, basePath: string): string | null {
	const parsed = parseRemoteUrl(remoteUrl);
	if (!parsed) {
		return null;
	}
	if (expectedHost && !gitLabRemoteHostMatches(parsed.host, parsed.portInsensitive, expectedHost)) {
		return null;
	}
	// A self-managed GitLab under a relative install path (e.g. https://host/gitlab) yields
	// remotes like https://host/gitlab/group/project.git, but project full paths stay
	// group/project. Strip the matching base path so the lookup keys off the real full path.
	let projectPath = parsed.projectPath.replace(/^\/+/, "");
	if (basePath && (projectPath === basePath || projectPath.startsWith(`${basePath}/`))) {
		projectPath = projectPath.slice(basePath.length);
	}
	projectPath = projectPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
	return projectPath.includes("/") ? projectPath : null;
}

// Match a remote's host against the configured GitLab `baseUrl` host. HTTP(S) URL
// remotes compare host:port strictly so a self-managed GitLab on a non-default port
// is not confused with another service on the same hostname. `ssh://` and SCP-style
// `git@host:path` remotes name the SSH port (commonly distinct from the web UI port)
// or carry none, so they compare on the bare hostname only — stripping any port the
// base URL carried — instead of being rejected for a port mismatch.
function gitLabRemoteHostMatches(remoteHost: string, portInsensitive: boolean, expectedHost: string): boolean {
	if (!portInsensitive) {
		return remoteHost.toLowerCase() === expectedHost.toLowerCase();
	}
	const remoteHostname = remoteHost.split(":")[0] ?? remoteHost;
	const expectedHostname = expectedHost.split(":")[0] ?? expectedHost;
	return remoteHostname.toLowerCase() === expectedHostname.toLowerCase();
}

function parseRemoteUrl(remoteUrl: string): { host: string; projectPath: string; portInsensitive: boolean } | null {
	try {
		const url = new URL(remoteUrl);
		// `host` (not `hostname`) keeps any explicit port so a self-managed GitLab on a
		// non-default HTTP(S) port is not confused with another service on the same
		// hostname. An `ssh://` remote, however, names the SSH port (commonly distinct
		// from the web UI port), so it must compare on the bare hostname only.
		const portInsensitive = url.protocol === "ssh:";
		return { host: url.host, projectPath: url.pathname, portInsensitive };
	} catch {
		// SCP-style `git@host:path` has no port concept; bare host is the only key.
		const scpMatch = remoteUrl.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
		if (scpMatch?.[1] && scpMatch[2]) {
			return { host: scpMatch[1], projectPath: scpMatch[2], portInsensitive: true };
		}
		return null;
	}
}

function parseUrlHost(url: string): string | null {
	try {
		// Match `parseRemoteUrl`: include the port so host comparison is port-aware.
		return new URL(url).host;
	} catch {
		return null;
	}
}

function parseUrlBasePath(url: string): string {
	try {
		return new URL(url).pathname.replace(/^\/+|\/+$/g, "");
	} catch {
		return "";
	}
}
