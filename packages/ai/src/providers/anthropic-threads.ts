/**
 * Anthropic message threads (`message-threads-2026-08-12`).
 *
 * A thread keeps a conversation on the server for 5 minutes after its last
 * stored response, so a long agent loop uploads its history once and then
 * sends only what each turn appends; time to first token stays low as the
 * conversation grows. Token usage and pricing are unchanged.
 *
 * Every request is planned from the full body the provider would send without
 * a thread, so the client stays the source of truth:
 *
 * - **continue** when the session's last stored response is fresh, the
 *   thread's fixed fields (model, system, tools, tool choice, thinking, output
 *   config, context management, `fallbacks` presence, beta set) are unchanged,
 *   and the full messages extend the conversation the server holds, cache
 *   breakpoints aside. Only the appended messages go on the wire.
 * - **create** otherwise: the full body plus `thread: { type: "create" }`.
 * - **no thread** for bodies a thread cannot hold (compaction, context edits
 *   other than `clear_thinking` keep-all, turn-scoped messages, fallback-credit
 *   redemptions) and once the server refused threading for the session.
 *
 * A continue the server refuses is replayed as a create; any doubt costs a
 * full upload, never a conversation that diverges from the client's.
 *
 * Prompt caching inside a thread (measured against the API): the create's
 * system, tools and non-last message breakpoints keep working on every
 * continue; a continue's own breakpoints act on that request only, each
 * looking back about 20 blocks for a cache entry. A continue therefore marks
 * its first appended block, which sits right after the stored response and
 * reaches the previous request's entry, besides its newest block, which
 * writes this turn (see {@link continueBreakpoints}).
 *
 * https://platform.claude.com/docs/en/build-with-claude/message-threads
 */
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { $flag } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Model } from "../types";
import { normalizeExtraBetas } from "./anthropic-headers";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	ImageBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	TextBlockParam,
	ToolResultBlockParam,
	ToolUseBlockParam,
} from "./anthropic-wire";

/**
 * How long after a stored response a continue may name it. The server keeps a
 * thread 5 minutes after its last stored response; the margin covers the
 * delay between the server storing it and the client seeing `message_stop`.
 */
const THREAD_REUSE_WINDOW_MS = 270_000;

/**
 * Refused continues in a row (each followed by a replay) that stop threading
 * the session: a conversation the server keeps failing to continue right
 * after a replay is one it cannot store.
 */
const MAX_REFUSED_CONTINUES = 2;

/**
 * Chains kept per endpoint and model, least recently used evicted first. Side
 * requests mint one-shot session ids (speculative compaction, side questions)
 * that are never released, and each chain pins a whole conversation.
 */
const MAX_THREAD_CHAINS = 16;

/**
 * Error text of thread 400s that carry no `error_code` (a continue without
 * `previous_message_id`, one that resends `system` or `tools`).
 */
const THREAD_ERROR_TEXT = /(?<!diagnostics\.)previous_message_id|\bthread\b.{0,3}(?:param|field|request|type|:)/i;

/** Session thread chains keyed by routing session id; held in the Anthropic provider session state. */
export type AnthropicThreadChains = Map<string, AnthropicThreadChain>;

/** One session's thread bookkeeping. */
export interface AnthropicThreadChain {
	/** Stored response the next request may continue. A continue that names it removes it: each id continues once. */
	anchor?: AnthropicThreadAnchor;
	/** Continues the server refused since the last unforced success; {@link MAX_REFUSED_CONTINUES} disables the chain. */
	refusedContinues: number;
	/** The server cannot thread this session's requests; later requests go without `thread`. */
	disabled: boolean;
}

interface AnthropicThreadAnchor {
	/** Response `id` a continue names as `previous_message_id`. */
	messageId: string;
	/** Conversation the server holds for `messageId`: the request's full messages, then the response. */
	messages: readonly MessageParam[];
	/** Fixed and create-only fields of the thread; any change starts a new thread. */
	fingerprint: ThreadFingerprint;
	/** When the response was stored (`Date.now()`). */
	storedAt: number;
}

/**
 * Fields a thread fixes at create time. `system` and `tools` are create-only,
 * the rest must match on every request; `betas` is the normalized
 * `anthropic-beta` set without the threads beta itself.
 */
type ThreadFingerprint = Pick<
	MessageCreateParamsStreaming,
	"model" | "system" | "tools" | "tool_choice" | "thinking" | "output_config" | "context_management"
> & { fallbacks: boolean; betas: string };

/** A thread-shaped request. */
export interface AnthropicThreadRequest {
	kind: "create" | "continue";
	/** Wire body: the full params plus `thread`, or only the appended messages for a continue. */
	body: MessageCreateParamsStreaming;
}

/**
 * What the provider does with a request the server refused for a thread
 * reason: `replay` resends it as a create, `unthreaded` resends it without
 * `thread`.
 */
export type AnthropicThreadRecovery = "replay" | "unthreaded";

/** A response the server stored and the next request may continue. */
export interface AnthropicStoredResponse {
	messageId: string;
	/** The response as the next request's history serializes it. */
	message: MessageParam;
}

/**
 * Whether requests for `model` to `baseUrl` use message threads. A caller's
 * `statefulResponses` wins; otherwise `PI_ANTHROPIC_MESSAGE_THREADS`, then the
 * model policy, limited to the official endpoint: a reroute through
 * `ANTHROPIC_BASE_URL` leaves the policy flag on for a gateway that may not
 * know the field.
 */
export function wantsAnthropicThreads(
	model: Model<"anthropic-messages">,
	statefulResponses: boolean | undefined,
	baseUrl: string,
): boolean {
	if (statefulResponses !== undefined) return statefulResponses;
	return $flag(
		"PI_ANTHROPIC_MESSAGE_THREADS",
		model.compat.supportsMessageThreads === true && isOfficialAnthropicApiUrl(baseUrl),
	);
}

/** The chain for `sessionId`, created on first use and marked most recently used. */
export function anthropicThreadChain(chains: AnthropicThreadChains, sessionId: string): AnthropicThreadChain {
	let chain = chains.get(sessionId);
	if (chain) {
		chains.delete(sessionId);
	} else {
		chain = { refusedContinues: 0, disabled: false };
		const oldest = chains.size >= MAX_THREAD_CHAINS ? chains.keys().next() : undefined;
		if (oldest && !oldest.done) chains.delete(oldest.value);
	}
	chains.set(sessionId, chain);
	return chain;
}

/**
 * One provider call's use of a session thread. The provider calls
 * {@link plan} before each attempt, {@link recover} and
 * {@link dropAfterUnexplained400} from its retry ladder, and {@link settle}
 * once the turn completes.
 */
export class AnthropicThreadTurn {
	readonly #chain: AnthropicThreadChain;
	/**
	 * Keep `system` and `tools` on continues. Claude Code's subscription traffic
	 * resends them (fingerprint-checked; the billing attestation lives in
	 * `system`); the documented API contract rejects them.
	 */
	readonly #resendSystemAndTools: boolean;
	/** Anchor this call continues from, taken off the chain when first planned. */
	#claimed: AnthropicThreadAnchor | undefined;
	/** The server refused this call's continue: plan creates from now on. */
	#forceCreate = false;
	/** This call goes without `thread` from now on. */
	#unthreaded = false;
	/** Disable the chain if the unthreaded resend after an unexplained 400 carries the turn. */
	#disableOnSuccess = false;
	#planned:
		| {
				params: MessageCreateParamsStreaming;
				betaHeader: string;
				fingerprint: ThreadFingerprint;
				request: AnthropicThreadRequest;
		  }
		| undefined;

	constructor(chain: AnthropicThreadChain, options: { resendSystemAndTools: boolean }) {
		this.#chain = chain;
		this.#resendSystemAndTools = options.resendSystemAndTools;
	}

	/**
	 * Shape `params` for the wire, or `undefined` to send it without a thread.
	 * Repeated calls with the same params and betas return the same request, so
	 * a transient retry resends the same continue.
	 */
	plan(
		params: MessageCreateParamsStreaming,
		betaHeader: string,
		now = Date.now(),
	): AnthropicThreadRequest | undefined {
		if (this.#unthreaded || this.#chain.disabled || !isThreadable(params)) {
			this.#planned = undefined;
			return undefined;
		}
		const planned = this.#planned;
		if (planned?.params === params && planned.betaHeader === betaHeader) return planned.request;

		const fingerprint = fingerprintOf(params, betaHeader);
		const anchor = this.#forceCreate ? undefined : (this.#claimed ?? this.#chain.anchor);
		let request: AnthropicThreadRequest;
		if (
			anchor &&
			now - anchor.storedAt < THREAD_REUSE_WINDOW_MS &&
			Bun.deepEquals(anchor.fingerprint, fingerprint) &&
			extendsConversation(params.messages, anchor.messages)
		) {
			this.#claimed = anchor;
			if (this.#chain.anchor === anchor) this.#chain.anchor = undefined;
			const body: MessageCreateParamsStreaming = {
				...params,
				messages: continueBreakpoints(params.messages.slice(anchor.messages.length)),
				thread: { type: "continue", previous_message_id: anchor.messageId },
			};
			if (!this.#resendSystemAndTools) {
				delete body.system;
				delete body.tools;
			}
			request = { kind: "continue", body };
		} else {
			request = { kind: "create", body: { ...params, thread: { type: "create" } } };
		}
		this.#planned = { params, betaHeader, fingerprint, request };
		return request;
	}

	/**
	 * Handle a pre-stream failure of the planned request. Returns how to resend
	 * it when the server refused it for a thread reason; `undefined` leaves the
	 * error to the rest of the retry ladder.
	 */
	recover(error: unknown): AnthropicThreadRecovery | undefined {
		const request = this.#planned?.request;
		if (!request) return undefined;
		const code = threadErrorCode(error);
		if (code === undefined) return undefined;
		this.#planned = undefined;
		if (code === "thread_unsupported_request" || request.kind === "create") {
			// An organization setting or a feature threads lack; a create refused
			// for a thread reason says the same. Stop asking for this session.
			this.#disableChain();
			return "unthreaded";
		}
		// Expired, unstored, already continued, in flight, or the fixed fields
		// drifted: the conversation itself is fine, so replay it in full.
		this.#claimed = undefined;
		this.#chain.refusedContinues++;
		if (this.#chain.refusedContinues >= MAX_REFUSED_CONTINUES) {
			this.#disableChain();
			return "unthreaded";
		}
		this.#forceCreate = true;
		return "replay";
	}

	/**
	 * Resend the planned request without `thread` after a 400 nothing else
	 * explained (a context overflow is not one). If that resend carries the
	 * turn, the thread was the problem and the chain is disabled.
	 */
	dropAfterUnexplained400(error: unknown): boolean {
		if (!this.#planned || AIError.status(error) !== 400) return false;
		if (AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow)) return false;
		this.#planned = undefined;
		this.#unthreaded = true;
		this.#disableOnSuccess = true;
		return true;
	}

	/**
	 * Record the completed turn. `stored` is the response when the server keeps
	 * it continuable (a finished turn from the requested model); otherwise the
	 * next request starts a new thread.
	 */
	settle(stored: AnthropicStoredResponse | undefined, now = Date.now()): void {
		if (this.#disableOnSuccess) {
			this.#disableChain();
			return;
		}
		const planned = this.#planned;
		// An unthreaded request leaves the server's thread as it was.
		if (!planned) return;
		if (planned.request.kind === "continue" || !this.#forceCreate) this.#chain.refusedContinues = 0;
		this.#chain.anchor = stored && {
			messageId: stored.messageId,
			messages: [...planned.params.messages, stored.message],
			fingerprint: planned.fingerprint,
			storedAt: now,
		};
	}

	#disableChain(): void {
		this.#chain.disabled = true;
		this.#chain.anchor = undefined;
		this.#claimed = undefined;
		this.#unthreaded = true;
	}
}

/** Whether a thread can hold this body: no compaction, unsupported context edits, turn-scoped messages or credit redemption. */
function isThreadable(params: MessageCreateParamsStreaming): boolean {
	if (params.compaction || params.fallback_credit_token) return false;
	if (params.context_management?.edits.some(edit => edit.type !== "clear_thinking_20251015")) return false;
	return !params.messages.some(message => message.clear_at === "next_user_message");
}

function fingerprintOf(params: MessageCreateParamsStreaming, betaHeader: string): ThreadFingerprint {
	return {
		model: params.model,
		system: params.system,
		tools: params.tools,
		tool_choice: params.tool_choice,
		thinking: params.thinking,
		output_config: params.output_config,
		context_management: params.context_management,
		fallbacks: (params.fallbacks?.length ?? 0) > 0,
		betas: [...new Set(normalizeExtraBetas(betaHeader))].sort().join(","),
	};
}

/** Thread error code of a pre-stream failure: `error.details.error_code`, or a codeless thread 400. */
function threadErrorCode(error: unknown): string | undefined {
	const status = AIError.status(error);
	if (status !== 400 && status !== 404) return undefined;
	const code = error instanceof AIError.ProviderHttpError ? error.code : undefined;
	if (code?.startsWith("thread_")) return code;
	const message = error instanceof Error ? error.message : String(error);
	// A 404 for an unknown model is not a thread error.
	if (status === 404) return message.includes("thread_not_found") ? "thread_not_found" : undefined;
	return THREAD_ERROR_TEXT.test(message) ? "thread_invalid_request" : undefined;
}

/** Whether `messages` appends at least one message to `held`, ignoring cache breakpoints. */
function extendsConversation(messages: readonly MessageParam[], held: readonly MessageParam[]): boolean {
	if (messages.length <= held.length) return false;
	for (let index = 0; index < held.length; index++) {
		if (!sameMessage(messages[index], held[index])) return false;
	}
	return true;
}

function sameMessage(a: MessageParam, b: MessageParam): boolean {
	if (a === b) return true;
	if (a.role !== b.role || a.clear_at !== b.clear_at || !Bun.deepEquals(a.output_config, b.output_config)) {
		return false;
	}
	if (typeof a.content === "string" || typeof b.content === "string") {
		const text = soleText(a.content);
		return text !== undefined && text === soleText(b.content);
	}
	if (a.content.length !== b.content.length) return false;
	for (let index = 0; index < a.content.length; index++) {
		if (!Bun.deepEquals(withoutCacheControl(a.content[index]), withoutCacheControl(b.content[index]))) {
			return false;
		}
	}
	return true;
}

/**
 * Text of string content, or of a single text block that differs from it only
 * by a breakpoint: caching rewrites a string message into that block.
 */
function soleText(content: MessageParam["content"]): string | undefined {
	if (typeof content === "string") return content;
	if (content.length !== 1) return undefined;
	const block = content[0];
	if (block.type !== "text") return undefined;
	for (const key in block) {
		if (key !== "type" && key !== "text" && key !== "cache_control") return undefined;
	}
	return block.text;
}

function withoutCacheControl(block: ContentBlockParam): ContentBlockParam {
	if (!("cache_control" in block) || block.cache_control == null) return block;
	const copy = { ...block };
	delete copy.cache_control;
	return copy;
}

type CacheableBlock = TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam;

function isCacheable(block: ContentBlockParam): block is CacheableBlock {
	return block.type === "text" || block.type === "image" || block.type === "tool_use" || block.type === "tool_result";
}

/**
 * Breakpoints for the messages a continue appends. Prompt caching placed the
 * request's breakpoints for a full upload, but on a continue the trailing one
 * reaches the previous request's cache entry only when the stored response
 * plus the appended blocks fit its ~20-block lookback; a turn of parallel tool
 * calls does not, and would rewrite the whole conversation. This keeps the
 * newest breakpoint, which writes the turn, adds one on the first appended
 * block, which reads up to the previous request, and drops the rest: with the
 * create's system and tools breakpoints that stays within the four a request
 * may count. Messages without a breakpoint (caching off) pass through.
 */
function continueBreakpoints(appended: MessageParam[]): MessageParam[] {
	let template: CacheControlEphemeral | undefined;
	let newest: [number, number] | undefined;
	let first: [number, number] | undefined;
	for (let m = 0; m < appended.length; m++) {
		const content = appended[m].content;
		if (typeof content === "string") {
			first ??= [m, 0];
			continue;
		}
		for (let b = 0; b < content.length; b++) {
			const block = content[b];
			if (!first && isCacheable(block)) first = [m, b];
			if ("cache_control" in block && block.cache_control) newest = [m, b];
			if (isCacheable(block) && block.cache_control) template = block.cache_control;
		}
	}
	if (!template || !first) return appended;
	const marked = (m: number, b: number) =>
		(m === first[0] && b === first[1]) || (newest !== undefined && m === newest[0] && b === newest[1]);
	return appended.map((message, m) => {
		if (m !== first[0] && typeof message.content === "string") return message;
		const content: ContentBlockParam[] =
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		let changed = typeof message.content === "string";
		const next = content.map((block, b) => {
			if (!marked(m, b)) {
				const stripped = withoutCacheControl(block);
				changed ||= stripped !== block;
				return stripped;
			}
			if (!isCacheable(block) || block.cache_control) return block;
			changed = true;
			return { ...block, cache_control: { ...template } };
		});
		return changed ? { ...message, content: next } : message;
	});
}
