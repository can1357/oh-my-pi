import { type } from "arktype";
import { Effort, THINKING_EFFORTS } from "../effort";
import type { ModelSpec, ThinkingConfig } from "../types";
import { isRecord } from "../utils";
import { CODEX_BASE_URL, OPENAI_HEADER_VALUES, OPENAI_HEADERS } from "../wire/codex";

const DEFAULT_MODEL_LIST_PATHS = ["/codex/models", "/models"] as const;
const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;
const DEFAULT_CODEX_CLIENT_VERSION = "0.99.0";
const NPM_CODEX_LATEST_URL = "https://registry.npmjs.org/@openai%2Fcodex/latest";

const codexReasoningPresetSchema = type({
	"effort?": "unknown",
});

const codexModelEntrySchema = type({
	"slug?": "unknown",
	"id?": "unknown",
	"display_name?": "unknown",
	"context_window?": "unknown",
	"default_reasoning_level?": "unknown",
	"supported_reasoning_levels?": "unknown",
	"multi_agent_reasoning_effort?": "unknown",
	"input_modalities?": "unknown",
	"supported_in_api?": "unknown",
	"priority?": "unknown",
	"prefer_websockets?": "unknown",
});

const codexModelsResponseSchema = type({
	"models?": "unknown[]",
	"data?": "unknown[]",
});

type CodexModelEntry = typeof codexModelEntrySchema.infer;
interface NormalizedCodexModel {
	model: ModelSpec<"openai-codex-responses">;
	priority: number;
}

/**
 * Fetch options for OpenAI Codex model discovery.
 */
export interface CodexModelDiscoveryOptions {
	/** OAuth access token used for `Authorization: Bearer ...`. */
	accessToken: string;
	/** ChatGPT account id value used for `chatgpt-account-id` header. */
	accountId?: string;
	/** Base URL for Codex backend. Defaults to `https://chatgpt.com/backend-api`. */
	baseUrl?: string;
	/** Optional client version attached as `client_version` query parameter. */
	clientVersion?: string;
	/** Optional endpoint path candidates. Defaults to `/codex/models`, then `/models`. */
	paths?: readonly string[];
	/** Additional headers merged on top of required Codex headers. */
	headers?: Record<string, string>;
	/** Abort signal for network request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetchFn?: typeof fetch;
	/** Optional registry fetch implementation override for client version lookup. */
	registryFetchFn?: typeof fetch;
}

/**
 * Normalized Codex discovery response.
 */
export interface CodexModelDiscoveryResult {
	models: ModelSpec<"openai-codex-responses">[];
	etag?: string;
}

/**
 * Fetches model metadata from Codex backend and normalizes it for pi model management.
 *
 * Returns `null` when no supported model-list route can be fetched/parsed.
 * Returns `{ models: [] }` when a route succeeds but yields no usable models.
 */
export async function fetchCodexModels(options: CodexModelDiscoveryOptions): Promise<CodexModelDiscoveryResult | null> {
	const fetchFn = options.fetchFn ?? fetch;
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const paths = normalizePaths(options.paths);
	const headers = buildCodexHeaders(options);
	const clientVersion = await resolveCodexClientVersion(
		options.clientVersion,
		options.registryFetchFn ?? fetchFn,
		options.signal,
	);

	let sawSuccessfulResponse = false;
	for (const path of paths) {
		const requestUrl = buildModelsUrl(baseUrl, path, clientVersion);
		let response: Response;
		try {
			response = await fetchFn(requestUrl, {
				method: "GET",
				headers,
				signal: options.signal,
			});
		} catch {
			continue;
		}

		if (!response.ok) {
			continue;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			continue;
		}

		const models = normalizeCodexModels(payload, baseUrl);
		if (models === null) {
			continue;
		}
		sawSuccessfulResponse = true;
		const etag = getResponseEtag(response.headers);
		return etag ? { models, etag } : { models };
	}
	return sawSuccessfulResponse ? { models: [] } : null;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
	const raw = (baseUrl ?? CODEX_BASE_URL).trim();
	if (!raw) {
		return CODEX_BASE_URL;
	}
	return raw.replace(/\/+$/, "");
}

function normalizePaths(paths: readonly string[] | undefined): string[] {
	if (!paths || paths.length === 0) {
		return [...DEFAULT_MODEL_LIST_PATHS];
	}
	const normalized = paths
		.map(path => path.trim())
		.filter(path => path.length > 0)
		.map(path => (path.startsWith("/") ? path : `/${path}`));
	return normalized.length > 0 ? normalized : [...DEFAULT_MODEL_LIST_PATHS];
}

function buildModelsUrl(baseUrl: string, path: string, clientVersion: string | undefined): string {
	const url = new URL(`${baseUrl}${path}`);
	if (clientVersion && clientVersion.trim().length > 0) {
		url.searchParams.set("client_version", clientVersion.trim());
	}
	return url.toString();
}

function buildCodexHeaders(options: CodexModelDiscoveryOptions): Headers {
	const headers = new Headers(options.headers);
	headers.set("Authorization", `Bearer ${options.accessToken}`);
	if (options.accountId && options.accountId.trim().length > 0) {
		headers.set(OPENAI_HEADERS.ACCOUNT_ID, options.accountId);
	}
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set("accept", "application/json");
	return headers;
}

async function resolveCodexClientVersion(
	clientVersion: string | undefined,
	fetchFn: typeof fetch,
	signal: AbortSignal | undefined,
): Promise<string> {
	const normalizedClientVersion = normalizeClientVersion(clientVersion);
	if (normalizedClientVersion) {
		return normalizedClientVersion;
	}
	try {
		const response = await fetchFn(NPM_CODEX_LATEST_URL, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal,
		});
		if (!response.ok) {
			return DEFAULT_CODEX_CLIENT_VERSION;
		}
		const payload: unknown = await response.json();
		if (!isRecord(payload)) {
			return DEFAULT_CODEX_CLIENT_VERSION;
		}
		const npmVersion = normalizeClientVersion(payload.version);
		return npmVersion ?? DEFAULT_CODEX_CLIENT_VERSION;
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		return DEFAULT_CODEX_CLIENT_VERSION;
	}
}

function normalizeClientVersion(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

function isAbortError(error: unknown): error is Error {
	return error instanceof Error && error.name === "AbortError";
}

function normalizeCodexModels(payload: unknown, baseUrl: string): ModelSpec<"openai-codex-responses">[] | null {
	const parsedResponse = codexModelsResponseSchema(payload);
	if (parsedResponse instanceof type.errors) {
		return null;
	}

	const entries = parsedResponse.models ?? parsedResponse.data ?? [];
	const normalized: NormalizedCodexModel[] = [];
	for (const entry of entries) {
		const model = normalizeCodexModelEntry(entry, baseUrl);
		if (model) {
			normalized.push(model);
		}
	}

	normalized.sort((left, right) => {
		if (left.priority !== right.priority) {
			return left.priority - right.priority;
		}
		return left.model.id.localeCompare(right.model.id);
	});

	return normalized.map(item => item.model);
}

function normalizeCodexModelEntry(entry: unknown, baseUrl: string): NormalizedCodexModel | null {
	const parsedEntry = codexModelEntrySchema(entry);
	if (parsedEntry instanceof type.errors) {
		return null;
	}

	const payload: CodexModelEntry = parsedEntry;
	const slug = toNonEmptyString(payload.slug) ?? toNonEmptyString(payload.id);
	if (!slug) {
		return null;
	}

	const supportedInApi = toBoolean(payload.supported_in_api);
	if (supportedInApi === false) {
		return null;
	}

	const name = toNonEmptyString(payload.display_name) ?? slug;
	const contextWindow = toPositiveInt(payload.context_window) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = Math.min(DEFAULT_MAX_TOKENS, contextWindow);
	const reasoning = supportsReasoning(payload.default_reasoning_level, payload.supported_reasoning_levels);
	const input = normalizeInputModalities(payload.input_modalities);
	const preferWebsockets = toBoolean(payload.prefer_websockets);
	const priority = toFiniteNumber(payload.priority) ?? Number.MAX_SAFE_INTEGER;

	return {
		priority,
		model: {
			id: slug,
			name,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl,
			reasoning,
			thinking: normalizeThinking(payload),
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			...(preferWebsockets !== null ? { preferWebsockets } : {}),
			...(priority !== Number.MAX_SAFE_INTEGER ? { priority } : {}),
		},
	};
}

/** Preserve backend capabilities instead of inferring a stale GPT-family ladder. */
function normalizeThinking(payload: CodexModelEntry): ThinkingConfig | undefined {
	if (!Array.isArray(payload.supported_reasoning_levels)) return undefined;
	const advertised = new Set<string>();
	for (const preset of payload.supported_reasoning_levels) {
		const parsed = codexReasoningPresetSchema(preset);
		if (parsed instanceof type.errors) continue;
		const effort = toNonEmptyString(parsed.effort)?.toLowerCase();
		if (effort) advertised.add(effort);
	}
	const efforts = THINKING_EFFORTS.filter(effort => advertised.has(effort));
	if (efforts.length === 0) return undefined;
	const defaultLevel = efforts.find(
		effort => effort === toNonEmptyString(payload.default_reasoning_level)?.toLowerCase(),
	);
	const delegatedEffort = efforts.find(
		effort =>
			effort !== Effort.Ultra && effort === toNonEmptyString(payload.multi_agent_reasoning_effort)?.toLowerCase(),
	);
	const wireEfforts = efforts.filter(effort => effort !== Effort.Ultra);
	// Codex Ultra prefers the advertised multi-agent effort, then max, then
	// the highest supported non-Ultra effort. Ultra is never a wire value.
	const ultraEffort = delegatedEffort ?? wireEfforts.at(-1);
	return {
		mode: "effort",
		efforts,
		requiresEffort: !advertised.has("none"),
		...(defaultLevel ? { defaultLevel } : {}),
		...(efforts.includes(Effort.Ultra) && ultraEffort ? { effortMap: { [Effort.Ultra]: ultraEffort } } : {}),
	};
}

function supportsReasoning(defaultReasoningLevel: unknown, supportedReasoningLevels: unknown): boolean {
	const defaultLevel = toNonEmptyString(defaultReasoningLevel)?.toLowerCase();
	if (defaultLevel && defaultLevel !== "none") {
		return true;
	}

	if (!Array.isArray(supportedReasoningLevels)) {
		return false;
	}

	for (const level of supportedReasoningLevels) {
		const parsedLevel = codexReasoningPresetSchema(level);
		if (parsedLevel instanceof type.errors) {
			continue;
		}
		const effort = toNonEmptyString(parsedLevel.effort)?.toLowerCase();
		if (effort && effort !== "none") {
			return true;
		}
	}

	return false;
}

function normalizeInputModalities(inputModalities: unknown): ("text" | "image")[] {
	if (!Array.isArray(inputModalities)) {
		return ["text", "image"];
	}

	const set = new Set<"text" | "image">();
	for (const modality of inputModalities) {
		const normalized = toNonEmptyString(modality)?.toLowerCase();
		if (normalized === "text" || normalized === "image") {
			set.add(normalized);
		}
	}

	if (set.size === 0) {
		return ["text", "image"];
	}

	const canonical: ("text" | "image")[] = ["text", "image"];
	return canonical.filter(modality => set.has(modality));
}

function getResponseEtag(headers: Headers): string | undefined {
	const etag = headers.get("etag");
	if (!etag) {
		return undefined;
	}
	const trimmed = etag.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function toPositiveInt(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	if (value <= 0) {
		return null;
	}
	return Math.trunc(value);
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

function toBoolean(value: unknown): boolean | null {
	if (typeof value !== "boolean") {
		return null;
	}
	return value;
}
