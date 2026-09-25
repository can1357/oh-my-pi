import type { PromptCachePrefix } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";

type Hash = number | bigint;

/** Hashes of the cache-relevant parts of one provider request payload. */
interface PrefixFingerprint {
	model: string;
	system: Hash;
	tools: Hash;
	options: Hash;
	/** Per-item hashes of the conversation list; `undefined` when a server-chained request sent only a delta. */
	items: Hash[] | undefined;
	/** Whether each conversation item is a system/developer message (OpenAI-style system prompts live in the list). */
	systemItems: boolean[] | undefined;
}

/** A request's comparison result plus the fingerprint to keep if the request succeeds. */
export interface PromptCachePrefixObservation {
	result: PromptCachePrefix;
	fingerprint: PrefixFingerprint;
}

/**
 * Tracks the last request an agent session sent so each new request can be
 * checked for resending that request's cacheable prefix unchanged.
 *
 * Works on the final wire payload, so it sees exactly what the provider
 * caches, including extension payload rewrites. The payload shapes of every
 * supported API are covered by field name: the conversation list is
 * `messages` / `input` / `contents`; system prompt and tools sit beside it or
 * under `config` / `request`. Cache markers that move each turn
 * (`cache_control`, `prompt_cache_breakpoint`, Bedrock `cachePoint` blocks)
 * are ignored.
 */
export class PromptCachePrefixTracker {
	#previous: PrefixFingerprint | undefined;

	/**
	 * Compare a payload about to be sent with the last accepted request.
	 * Returns `undefined` for payloads with no recognizable conversation list.
	 */
	observe(payload: unknown, model: string): PromptCachePrefixObservation | undefined {
		let fingerprint: PrefixFingerprint | undefined;
		try {
			fingerprint = fingerprintPayload(payload, model);
		} catch {
			// Unserializable payloads (cycles, bigint) are not compared.
			return undefined;
		}
		if (!fingerprint) return undefined;
		return { result: compare(this.#previous, fingerprint), fingerprint };
	}

	/** Make an observed request the baseline for the next one; call once the provider processed it. */
	accept(observation: PromptCachePrefixObservation): void {
		this.#previous = observation.fingerprint;
	}
}

function compare(previous: PrefixFingerprint | undefined, current: PrefixFingerprint): PromptCachePrefix {
	if (!previous || previous.model !== current.model) return { status: "first" };
	// A server-chained request carries only the delta; the server holds the prior
	// context verbatim, so omp cannot have changed it.
	if (current.items === undefined) return { status: "intact" };
	if (previous.items === undefined) return { status: "first" };
	if (previous.system !== current.system) return { status: "changed", part: "system" };
	if (previous.tools !== current.tools) return { status: "changed", part: "tools" };
	if (previous.options !== current.options) return { status: "changed", part: "options" };
	for (let index = 0; index < previous.items.length; index++) {
		if (index >= current.items.length || previous.items[index] !== current.items[index]) {
			const system = previous.systemItems?.[index] === true || current.systemItems?.[index] === true;
			return { status: "changed", part: system ? "system" : "messages", index };
		}
	}
	return { status: "intact" };
}

function fingerprintPayload(payload: unknown, model: string): PrefixFingerprint | undefined {
	if (!isRecord(payload)) return undefined;
	const config = isRecord(payload.config) ? payload.config : undefined;
	const request = isRecord(payload.request) ? payload.request : undefined;
	const list = firstArray(payload.messages, payload.input, payload.contents, request?.contents);
	if (!list) return undefined;
	const chained = typeof payload.previous_response_id === "string";
	return {
		model,
		system: hashValue([
			payload.system,
			payload.instructions,
			payload.systemInstruction,
			config?.systemInstruction,
			request?.systemInstruction,
		]),
		tools: hashValue([
			payload.tools,
			payload.toolConfig,
			config?.tools,
			config?.toolConfig,
			request?.tools,
			request?.toolConfig,
		]),
		// Anthropic invalidates the message cache when tool_choice or thinking changes.
		options: hashValue([payload.tool_choice, payload.thinking]),
		items: chained ? undefined : list.map(hashValue),
		systemItems: chained ? undefined : list.map(isSystemItem),
	};
}

function firstArray(...candidates: unknown[]): unknown[] | undefined {
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) return candidate;
	}
	return undefined;
}

function isSystemItem(item: unknown): boolean {
	return isRecord(item) && (item.role === "system" || item.role === "developer");
}

function hashValue(value: unknown): Hash {
	const json = JSON.stringify(value, stripCacheMarkers);
	return json === undefined ? 0 : Bun.hash(json);
}

function stripCacheMarkers(key: string, value: unknown): unknown {
	if (key === "cache_control" || key === "prompt_cache_breakpoint") return undefined;
	if (Array.isArray(value) && value.some(isCachePointBlock)) return value.filter(entry => !isCachePointBlock(entry));
	return value;
}

function isCachePointBlock(value: unknown): boolean {
	return isRecord(value) && "cachePoint" in value && Object.keys(value).length === 1;
}
