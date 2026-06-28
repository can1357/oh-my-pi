import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { FetchImpl, ModelSpec } from "../types";
import {
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
} from "./devin-gen/exa/api_server_pb/api_server_pb";
import { type ClientModelConfig, MetadataSchema } from "./devin-gen/exa/codeium_common_pb/codeium_common_pb";

const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";
const DEVIN_GET_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const DEVIN_IDE_VERSION = "3.2.23";
const DEVIN_EXTENSION_VERSION = "1.48.2";
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

/** Best-effort match for labels whose wording implies a thinking / reasoning-effort variant. */
const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;
function supportsDevinThinking(config: ClientModelConfig): boolean {
	if (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;
	return config.modelInfo?.modelFeatures?.supportsThinking === true || REASONING_LABEL_PATTERN.test(config.label);
}

/**
 * Options for fetching dynamic Devin (Codeium Cascade) models from `GetCliModelConfigs`.
 */
export interface DevinModelDiscoveryOptions {
	/** Codeium session token carried inside protobuf `Metadata.apiKey`. */
	apiKey?: string;
	/** Optional Codeium API base URL override. */
	baseUrl?: string;
	/** Optional request timeout in milliseconds (default 5000). */
	timeoutMs?: number;
	/** Optional caller abort signal, combined with the internal timeout. */
	signal?: AbortSignal;
	/** Optional fetch implementation for request-debug/proxy/test transports. */
	fetch?: FetchImpl;
}

/**
 * Fetches Devin models through the `GetCliModelConfigs` unary Connect RPC and
 * normalizes them into canonical model entries.
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchDevinModels(
	options: DevinModelDiscoveryOptions,
): Promise<ModelSpec<"devin-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const resolvedBaseUrl = options.baseUrl ?? DEVIN_DEFAULT_BASE_URL;
	const requestUrl = `${resolvedBaseUrl.replace(/\/+$/, "")}${DEVIN_GET_CLI_MODEL_CONFIGS_PATH}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

	try {
		const request = create(GetCliModelConfigsRequestSchema, {
			metadata: create(MetadataSchema, {
				apiKey: normalizeDevinSessionToken(options.apiKey),
				ideName: "windsurf",
				ideVersion: DEVIN_IDE_VERSION,
				extensionName: "windsurf",
				extensionVersion: DEVIN_EXTENSION_VERSION,
			}),
		});
		const body = toBinary(GetCliModelConfigsRequestSchema, request);

		const headers: Record<string, string> = {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		};

		const fetchImpl = options.fetch ?? fetch;
		const response = await fetchImpl(requestUrl, { method: "POST", headers, body, signal });
		if (!response.ok) {
			return null;
		}

		const decoded = decodeCliModelConfigsResponse(new Uint8Array(await response.arrayBuffer()));
		if (!decoded) {
			return null;
		}

		return normalizeDevinModels(decoded.clientModelConfigs, options.baseUrl);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

/**
 * Decodes a raw (unframed) `GetCliModelConfigsResponse`. Bun's `fetch` usually
 * auto-decompresses gzip, so the direct decode is attempted first; a
 * `gunzipSync` fallback covers runtimes that hand back the still-compressed body.
 */
function decodeCliModelConfigsResponse(payload: Uint8Array) {
	try {
		return fromBinary(GetCliModelConfigsResponseSchema, payload);
	} catch {
		try {
			return fromBinary(GetCliModelConfigsResponseSchema, gunzipSync(payload));
		} catch {
			return null;
		}
	}
}

function normalizeDevinModels(
	configs: readonly ClientModelConfig[],
	baseUrlOverride: string | undefined,
): ModelSpec<"devin-agent">[] {
	const byId = new Map<string, ModelSpec<"devin-agent">>();
	for (const config of configs) {
		if (config.disabled) {
			continue;
		}
		const id = config.modelUid.trim();
		if (!id) {
			continue;
		}
		const input: ("text" | "image")[] = config.supportsImages ? ["text", "image"] : ["text"];
		const contextWindow = config.maxTokens > 0 ? config.maxTokens : DEFAULT_CONTEXT_WINDOW;
		byId.set(id, {
			id,
			name: config.label.trim() || id,
			api: "devin-agent",
			provider: "devin",
			baseUrl: baseUrlOverride ?? DEVIN_DEFAULT_BASE_URL,
			reasoning: supportsDevinThinking(config),
			input,
			supportsTools: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens: Math.min(config.maxTokens > 0 ? config.maxTokens : DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
		});
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
