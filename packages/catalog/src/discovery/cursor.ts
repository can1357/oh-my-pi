import * as http2 from "node:http2";
import { type } from "@oh-my-pi/omptype";
import { isKimiK3ModelId } from "../identity";
import { bareModelId, parseGlmModel, semverGte } from "../identity/classify";
import { getBundledModels } from "../models";
import { toModelSpec } from "../provider-models/bundled-references";
import type { Model, ModelSpec } from "../types";
import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from "./cursor-proto";
import { create, fromBinary, toBinary } from "./protobuf";

const CURSOR_DEFAULT_BASE_URL = "https://api2.cursor.sh";
const CURSOR_DEFAULT_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

/**
 * `GetUsableModels` carries no context-window field, so the 1M ceiling is
 * recovered from the signals Cursor does send:
 * - display-name labels ("Opus 5 1M", "GPT-5.5 1M High") across families,
 * - natively 1M families Cursor serves unlabeled (Kimi K3, GLM 5.2+),
 * - the max-mode flag on Claude/Gemini ids, whose max-mode ceiling is 1M.
 */
const CURSOR_1M_CONTEXT_WINDOW = 1_000_000;
const CURSOR_1M_NAME_PATTERN = /\b1m\b/i;
const CURSOR_MAX_MODE_1M_ID_PATTERN = /claude|gemini/;
/** Kimi's official bare K3 id (`k3`, `kimi/k3`); `k3-256k` is the 256k SKU and stays out. */
const CURSOR_KIMI_K3_BARE_ID_PATTERN = /(^|\/)k3$/i;

/**
 * Versioned Cursor Grok ids (`cursor-grok-4.5`, `cursor-grok-4.6-high`) are
 * reasoning models whose effort is carried in the per-tier sibling id.
 * `GetUsableModels` ships no `thinkingDetails` and the bundled references read
 * `reasoning: false`, so classification falls back to the id. The non-reasoning
 * `grok-code-fast-*` family deliberately stays out.
 */
const CURSOR_GROK_REASONING_ID_PATTERN = /^cursor-grok-\d/i;

/**
 * Cursor-only families verified to accept `selectedImages` even though
 * `GetUsableModels` does not advertise input modalities.
 */
const CURSOR_GROK_4_MULTIMODAL_ID_PATTERN = /^cursor-grok-4(?:[.:_-]|$)/i;
const CURSOR_COMPOSER_25_MULTIMODAL_ID_PATTERN = /^composer-2\.5(?:[.:_-]|$)/i;

/**
 * Model-id families whose native catalogs (anthropic, openai/openai-codex,
 * google) are multimodal. Cursor-only verified families are handled separately.
 */
const CURSOR_MULTIMODAL_ID_PATTERN = /claude|gemini|gpt-|codex/;

const OptionalDisplayNameSchema = type("unknown").pipe(raw => (typeof raw === "string" ? raw : undefined));
const CursorAliasesSchema = type("unknown").pipe(raw => {
	if (Array.isArray(raw)) {
		return raw.filter((alias: unknown): alias is string => typeof alias === "string");
	}
	return [];
});

const CursorModelDetailsSchema = type({
	modelId: "string",
	displayName: OptionalDisplayNameSchema.default(undefined),
	displayNameShort: OptionalDisplayNameSchema.default(undefined),
	displayModelId: OptionalDisplayNameSchema.default(undefined),
	aliases: CursorAliasesSchema.default(() => []),
	"thinkingDetails?": "unknown",
	maxMode: "boolean = false",
});

const CursorModelsInnerSchema = type("unknown[]");
const ResilientCursorModelsSchema = type("unknown").pipe(raw => {
	const out = CursorModelsInnerSchema(raw);
	return out instanceof type.errors ? [] : out;
});

const CursorDecodedResponseSchema = type({
	models: ResilientCursorModelsSchema.default(() => []),
});

type CursorModelDetailsValue = typeof CursorModelDetailsSchema.infer;

/**
 * Options for fetching dynamic Cursor models from `GetUsableModels`.
 */
export interface CursorModelDiscoveryOptions {
	/** Cursor access token used for bearer authentication. */
	apiKey: string;
	/** Optional Cursor API base URL override. */
	baseUrl?: string;
	/** Optional client version override sent as `x-cursor-client-version`. */
	clientVersion?: string;
	/** Optional request timeout in milliseconds. */
	timeoutMs?: number;
	/** Optional list of custom Cursor model ids to include in request context. */
	customModelIds?: string[];
}

/**
 * Fetches Cursor models through `GetUsableModels` and normalizes them into canonical model entries.
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchCursorUsableModels(
	options: CursorModelDiscoveryOptions,
): Promise<ModelSpec<"cursor-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	try {
		const requestPayload = create(GetUsableModelsRequestSchema, {
			customModelIds: normalizeCustomModelIds(options.customModelIds),
		});
		const body = toBinary(GetUsableModelsRequestSchema, requestPayload);
		const baseUrl = (options.baseUrl ?? CURSOR_DEFAULT_BASE_URL).replace(/\/+$/, "");

		const responseBuffer = await fetchViaHttp2(baseUrl, body, options, timeoutMs);

		if (!responseBuffer) {
			return null;
		}
		const decoded = decodeGetUsableModelsResponse(responseBuffer);
		const parsedDecoded = CursorDecodedResponseSchema(decoded);
		if (parsedDecoded instanceof type.errors) {
			return null;
		}

		const references = createCursorReferenceMap();
		return normalizeCursorModels(parsedDecoded.models, options.baseUrl, references);
	} catch {
		return null;
	}
}

function buildRequestHeaders(options: CursorModelDiscoveryOptions): Record<string, string> {
	return {
		"content-type": "application/proto",
		te: "trailers",
		authorization: `Bearer ${options.apiKey}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": options.clientVersion ?? CURSOR_DEFAULT_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
	};
}

/** HTTP/2 transport required by Cursor API (HTTP/1.1 is rejected with 464). */
async function fetchViaHttp2(
	baseUrl: string,
	body: Uint8Array,
	options: CursorModelDiscoveryOptions,
	timeoutMs: number,
): Promise<Uint8Array | null> {
	const { promise, resolve } = Promise.withResolvers<Uint8Array | null>();
	const client = http2.connect(baseUrl);
	const timer = setTimeout(() => {
		client.destroy();
		resolve(null);
	}, timeoutMs);

	client.on("error", () => {
		clearTimeout(timer);
		resolve(null);
	});

	const req = client.request({
		":method": "POST",
		":path": CURSOR_GET_USABLE_MODELS_PATH,
		...buildRequestHeaders(options),
	});

	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		clearTimeout(timer);
		client.close();
		resolve(new Uint8Array(Buffer.concat(chunks)));
	});
	req.on("error", () => {
		clearTimeout(timer);
		client.close();
		resolve(null);
	});
	req.on("response", headers => {
		const status = Number(headers[":status"] ?? 0);
		if (status < 200 || status >= 300) {
			clearTimeout(timer);
			client.close();
			resolve(null);
		}
	});

	if (body.length > 0) {
		req.end(Buffer.from(body));
	} else {
		req.end();
	}

	return promise;
}

function normalizeCustomModelIds(customModelIds: readonly string[] | undefined): string[] {
	if (!customModelIds) {
		return [];
	}
	const normalized = new Set<string>();
	for (const value of customModelIds) {
		if (typeof value !== "string") {
			continue;
		}
		const trimmed = value.trim();
		if (!trimmed) {
			continue;
		}
		normalized.add(trimmed);
	}
	return [...normalized];
}

function createCursorReferenceMap(): Map<string, ModelSpec<"cursor-agent">> {
	const references = new Map<string, ModelSpec<"cursor-agent">>();
	for (const model of getBundledModels("cursor")) {
		references.set(model.id, toModelSpec(model as Model<"cursor-agent">));
	}
	return references;
}

function decodeGetUsableModelsResponse(payload: Uint8Array) {
	if (payload.length === 0) {
		return null;
	}

	const framedBody = decodeConnectUnaryBody(payload);
	if (framedBody) {
		try {
			return fromBinary(GetUsableModelsResponseSchema, framedBody);
		} catch {
			return null;
		}
	}

	try {
		return fromBinary(GetUsableModelsResponseSchema, payload);
	} catch {
		return null;
	}
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
	if (payload.length < 5) {
		return null;
	}

	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset];
		const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
		const messageLength = view.getUint32(1, false);
		const frameEnd = offset + 5 + messageLength;
		if (frameEnd > payload.length) {
			return null;
		}
		const compressionFlagSet = (flags & 0b0000_0001) !== 0;
		if (compressionFlagSet) {
			return null;
		}
		const endStreamFlagSet = (flags & 0b0000_0010) !== 0;
		if (!endStreamFlagSet) {
			return payload.subarray(offset + 5, frameEnd);
		}

		offset = frameEnd;
	}

	return null;
}

function normalizeCursorModels(
	models: readonly unknown[] | undefined,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
): ModelSpec<"cursor-agent">[] {
	if (!models || models.length === 0) {
		return [];
	}

	const byId = new Map<string, ModelSpec<"cursor-agent">>();
	for (const model of models) {
		const normalized = normalizeCursorModel(model, baseUrlOverride, references);
		if (!normalized) {
			continue;
		}
		byId.set(normalized.id, normalized);
	}

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeCursorModel(
	model: unknown,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
): ModelSpec<"cursor-agent"> | null {
	const parsedModel = CursorModelDetailsSchema(model);
	if (parsedModel instanceof type.errors) {
		return null;
	}

	const details = parsedModel;
	const id = details.modelId.trim();
	if (!id) {
		return null;
	}

	const name = pickModelDisplayName(details, id);
	const reference = references.get(id);
	const reasoning =
		isKimiK3ModelId(id) ||
		CURSOR_GROK_REASONING_ID_PATTERN.test(id) ||
		Boolean(details.thinkingDetails) ||
		reference?.reasoning === true;

	if (reference) {
		return {
			...reference,
			id,
			name,
			baseUrl: baseUrlOverride ?? reference.baseUrl,
			reasoning,
			input: resolveCursorInput(id, reference.input),
			contextWindow: resolveCursorContextWindow(details, id, reference.contextWindow),
			cursorMaxMode: details.maxMode,
		};
	}
	return {
		id,
		name,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: baseUrlOverride ?? CURSOR_DEFAULT_BASE_URL,
		reasoning,
		input: resolveCursorInput(id),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: resolveCursorContextWindow(details, id, DEFAULT_CONTEXT_WINDOW),
		maxTokens: DEFAULT_MAX_TOKENS,
		cursorMaxMode: details.maxMode,
	};
}

/**
 * Context window for a discovered Cursor model: the 1M ceiling when any 1M
 * signal fires (never below a larger bundled reference), else the fallback.
 */
function resolveCursorContextWindow(
	model: CursorModelDetailsValue,
	id: string,
	fallback: number | null,
): number | null {
	const labeled1M =
		CURSOR_1M_NAME_PATTERN.test(id) ||
		[model.displayName, model.displayNameShort, model.displayModelId, ...model.aliases].some(
			candidate => typeof candidate === "string" && CURSOR_1M_NAME_PATTERN.test(candidate),
		);
	if (labeled1M || isCursorNative1MModelId(id) || (model.maxMode && CURSOR_MAX_MODE_1M_ID_PATTERN.test(id))) {
		return Math.max(fallback ?? 0, CURSOR_1M_CONTEXT_WINDOW);
	}
	return fallback;
}

/**
 * Natively 1M-context families Cursor serves without a "1M" label: Kimi K3 and
 * GLM 5.2+ coding SKUs. The shared family parsers cover namespace forms
 * (`moonshotai/kimi-k3`, `z-ai/glm-5.2`) and future GLM versions (`glm-5.10`,
 * `glm-6`); vision and sub-1M variants stay out via the same gates as
 * `isGlm52ReasoningEffortModelId`.
 */
function isCursorNative1MModelId(id: string): boolean {
	if (isKimiK3ModelId(id) || CURSOR_KIMI_K3_BARE_ID_PATTERN.test(id)) {
		return true;
	}
	const glm = parseGlmModel(bareModelId(id));
	if (!glm || glm.vision) {
		return false;
	}
	if (glm.variant !== "base" && glm.variant !== "air" && glm.variant !== "turbo") {
		return false;
	}
	return semverGte(glm.version, "5.2");
}

function pickModelDisplayName(model: CursorModelDetailsValue, fallbackId: string): string {
	const candidates = [model.displayName, model.displayNameShort, model.displayModelId, ...model.aliases, fallbackId];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}
		const trimmed = candidate.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return fallbackId;
}

/**
 * Resolves input modalities from a bundled reference when available, except
 * for Cursor-only families whose image support is known independently. Without
 * a reference, native multimodal families fall back to id classification.
 */
export function resolveCursorInput(id: string, referenceInput?: ("text" | "image")[]): ("text" | "image")[] {
	if (
		isKimiK3ModelId(id) ||
		CURSOR_KIMI_K3_BARE_ID_PATTERN.test(id) ||
		CURSOR_GROK_4_MULTIMODAL_ID_PATTERN.test(id) ||
		CURSOR_COMPOSER_25_MULTIMODAL_ID_PATTERN.test(id)
	) {
		return ["text", "image"];
	}
	if (referenceInput) {
		return referenceInput;
	}
	if (CURSOR_MULTIMODAL_ID_PATTERN.test(id.toLowerCase())) {
		return ["text", "image"];
	}
	return ["text"];
}
