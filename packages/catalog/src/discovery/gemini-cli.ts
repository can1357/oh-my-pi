import { type } from "@oh-my-pi/omptype";
import type { FetchImpl } from "@oh-my-pi/pi-utils";
import { collapseVariants, type VariantCollapseTable } from "../compat/collapse";
import { compareRevision, parseRevision } from "../compat/revision";
import { classifyModel } from "../compat/taxonomy";
import { createBundledReferenceMap } from "../provider-models/bundled-references";
import type { ModelSpec } from "../types";
import { discoveryFetch } from "../utils";
import { getGeminiCliHeaders } from "../wire/gemini-headers";

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
const RETRIEVE_USER_QUOTA_PATH = "/v1internal:retrieveUserQuota";

// All current Gemini CLI models ship a 1M-token context and 65,536-token
// output ceiling; used only for quota-listed ids the bundled catalog does not
// already describe. Ids present in the bundle keep their real limits.
const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_MAX_TOKENS = 65_536;

/** Gemini generations that expose thinking on Cloud Code Assist. */
const REASONING_MIN_VERSION = "2.5";

const LoadCodeAssistResponseSchema = type({
	"cloudaicompanionProject?": type("unknown").pipe(value => {
		if (typeof value === "string") return value;
		if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
			return value.id;
		}
		return undefined;
	}),
});

const QuotaBucketSchema = type({
	"modelId?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
});

const RetrieveUserQuotaResponseSchema = type({
	"buckets?": type("unknown").pipe(value => {
		if (!Array.isArray(value)) return undefined;
		const buckets: Array<{ modelId?: string }> = [];
		for (const bucket of value) {
			const parsed = QuotaBucketSchema(bucket);
			if (!(parsed instanceof type.errors)) {
				buckets.push(parsed);
			}
		}
		return buckets;
	}),
});

/**
 * Options for the Gemini CLI quota-based discovery fallback.
 */
export interface FetchGeminiCliQuotaModelsOptions {
	/** OAuth access token sent as `Authorization: Bearer <token>`. */
	token: string;
	/** Cloud Code Assist endpoint. Defaults to `https://cloudcode-pa.googleapis.com`. */
	endpoint?: string;
	/** Pre-resolved GCP project id; otherwise discovered via `loadCodeAssist`. */
	projectId?: string;
	/** Optional abort signal for request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetcher?: typeof fetch;
	/** Effort-tier collapse table applied to the discovered list. */
	collapseTable?: VariantCollapseTable;
}

/**
 * Discovers the Gemini models available to a `google-gemini-cli` credential via
 * the account's own `retrieveUserQuota` endpoint on Cloud Code Assist.
 *
 * This is the fallback for accounts whose credential is not authorized for the
 * Antigravity `fetchAvailableModels` endpoint (e.g. Gemini Code Assist Standard
 * tiers, which return HTTP 403 there). Quota buckets carry only model ids, so
 * metadata is filled from the bundled catalog where the id is known and
 * synthesized with Gemini CLI defaults otherwise.
 *
 * Returns `null` on network/payload/auth failure (the caller keeps the bundled
 * catalog). Returns `[]` when the quota response lists no usable Gemini models.
 */
export async function fetchGeminiCliQuotaModels(
	options: FetchGeminiCliQuotaModelsOptions,
): Promise<ModelSpec<"google-gemini-cli">[] | null> {
	const fetcher = discoveryFetch(options.fetcher);
	const endpoint = (options.endpoint?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");
	const headers = {
		Authorization: `Bearer ${options.token}`,
		"Content-Type": "application/json",
		...getGeminiCliHeaders(),
	};

	const projectId = options.projectId ?? (await loadProjectId(fetcher, endpoint, headers, options.signal));

	let response: Response;
	try {
		response = await fetcher(`${endpoint}${RETRIEVE_USER_QUOTA_PATH}`, {
			method: "POST",
			headers,
			body: JSON.stringify(projectId ? { project: projectId } : {}),
			signal: options.signal,
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

	const parsed = RetrieveUserQuotaResponseSchema(payload);
	if (parsed instanceof type.errors) {
		return null;
	}

	const seen = new Set<string>();
	const models: ModelSpec<"google-gemini-cli">[] = [];
	const bundled = createBundledReferenceMap<"google-gemini-cli">("google-gemini-cli");

	for (const bucket of parsed.buckets ?? []) {
		const modelId = bucket.modelId?.trim();
		if (!modelId || seen.has(modelId)) {
			continue;
		}
		const identity = classifyModel("google-gemini-cli", modelId, { lenient: true });
		if (identity.class !== "gemini") continue;
		seen.add(modelId);

		const reference = bundled.get(modelId);
		if (reference) {
			models.push({ ...reference, baseUrl: endpoint });
			continue;
		}

		const revision = identity.revision === undefined ? undefined : parseRevision(identity.revision);
		const reasoningFloor = parseRevision(REASONING_MIN_VERSION);
		models.push({
			id: modelId,
			name: modelId,
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: endpoint,
			reasoning:
				revision !== undefined && reasoningFloor !== undefined && compareRevision(revision, reasoningFloor) >= 0,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
		});
	}

	const collapsed = collapseVariants(
		models,
		options.collapseTable === undefined ? undefined : { table: options.collapseTable },
	);
	collapsed.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	return collapsed;
}

async function loadProjectId(
	fetcher: FetchImpl,
	endpoint: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	let response: Response;
	try {
		response = await fetcher(`${endpoint}${LOAD_CODE_ASSIST_PATH}`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
			}),
			signal,
		});
	} catch {
		return undefined;
	}

	if (!response.ok) {
		return undefined;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return undefined;
	}

	const parsed = LoadCodeAssistResponseSchema(payload);
	return parsed instanceof type.errors ? undefined : parsed.cloudaicompanionProject;
}
