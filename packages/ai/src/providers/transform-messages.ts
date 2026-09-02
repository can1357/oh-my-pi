import { renderDemotedThinking } from "../dialect/demotion";
import type {
	Api,
	AssistantMessage,
	DeveloperMessage,
	Message,
	Model,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types";
import { isDemotedThinking, kDemotedThinking } from "../utils/block-symbols";

const enum ToolCallStatus {
	/** A tool result has already been emitted for this tool call; later duplicates must be skipped. */
	Resolved = 1,
	/** A synthetic aborted result was emitted; later real results must be skipped. */
	Aborted = 2,
}

/**
 * Maximum tool-call id length the strictest replay provider accepts.
 *
 * Anthropic requires `^[a-zA-Z0-9_-]+$` with a 64-char cap; Google and Codex
 * `normalizeToolCallId` implementations cap individual id segments to the same
 * 64-char ceiling. Replacement ids minted here flow back through
 * `convertAnthropicMessages` (and friends) unchanged, so the `_dupN` suffix
 * MUST not push a normalized id past this bound.
 */
const MAX_TOOL_CALL_ID_LENGTH = 64;

/**
 * OpenAI Responses-family APIs mint composite tool ids (`call_id|item_id`);
 * opaque Chat Completions ids do not (openai-completions preserves same-model
 * ids verbatim as provider correlation tokens), so ONLY these origins may be
 * canonicalized to their `call_` component for pairing.
 */
function isResponsesFamilyApi(api: Api | undefined): boolean {
	return api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses";
}

/**
 * The wire `call_id` component of a (possibly composite) Responses id: the
 * FIRST segment before `|`. A degenerate `|itemId` (empty call half, pipe at
 * index 0) keeps its full id so unrelated empty-half ids never collapse onto
 * one empty-string bucket.
 */
function responsesCallComponent(id: string): string {
	const pipe = id.indexOf("|");
	return pipe <= 0 ? id : id.slice(0, pipe);
}

/**
 * Origin classification for tool-call ids, tracked per CONCRETE id rather than
 * by a global prefix set. Two facts drive whether an id may be canonicalized to
 * its `call_` component for pairing:
 *
 *  - `responsesComponents`: the `call_` components of ids provably minted by a
 *    Responses-family assistant turn (keyed off the source message `api`).
 *  - `opaqueCompositeCallIds`: the FULL ids of pipe-bearing tool calls from a
 *    NON-Responses (opaque Chat Completions) assistant turn. openai-completions
 *    preserves these verbatim as provider correlation tokens; the `|` is
 *    literal, so they must pair by raw equality even when their `call_` prefix
 *    happens to collide with a Responses component seen elsewhere in history.
 *
 * Scoping by concrete id (not merely a shared prefix) is load-bearing (#10284):
 * an earlier Responses `call_A` must not license canonicalizing later same-model
 * Chat Completions ids `call_A|first` / `call_A|second` onto one `call_A`
 * bucket, which would collapse two distinct opaque calls and steer a lone
 * `call_A|second` result onto the wrong call.
 */
interface ToolCallOriginScope {
	responsesComponents: ReadonlySet<string>;
	opaqueCompositeCallIds: ReadonlySet<string>;
}

function collectToolCallOriginScope(messages: readonly Message[]): ToolCallOriginScope {
	const responsesComponents = new Set<string>();
	const opaqueCompositeCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const responsesOrigin = isResponsesFamilyApi(msg.api);
		for (const block of msg.content) {
			if (block.type !== "toolCall") continue;
			if (responsesOrigin) responsesComponents.add(responsesCallComponent(block.id));
			else if (block.id.includes("|")) opaqueCompositeCallIds.add(block.id);
		}
	}
	return { responsesComponents, opaqueCompositeCallIds };
}

/**
 * Canonical key for pairing a tool result with its assistant tool call.
 *
 * The OpenAI Codex/Responses APIs store a tool result's id as a composite
 * `<call_id>|<response_item_id>` (e.g. `call_ABC|fc_XYZ`), while the assistant
 * `toolCall` that produced it carries the plain `call_ABC` (or a composite with
 * a DIFFERENT item half). Keying both sides on the FIRST segment pairs them,
 * while NOT collapsing two distinct parallel calls whose results happen to
 * share a `response_item` (`fc_`) half.
 *
 * SCOPING (load-bearing, #10284): a pipe-bearing id is canonicalized to its
 * `call_` component ONLY when it is not itself a concrete opaque-origin call id
 * ({@link ToolCallOriginScope.opaqueCompositeCallIds}) and its component was
 * minted by a Responses-family turn ({@link ToolCallOriginScope.responsesComponents}).
 * A same-model Chat Completions id is an OPAQUE provider correlation token that
 * may itself contain `|` (openai-completions.ts preserves it verbatim);
 * splitting it would collapse two distinct opaque calls onto one bucket, so the
 * real result never pairs and the call is back-filled with a synthetic stub.
 * Opaque ids fall through to full-id keying, where the provider's own echoed
 * `tool_call_id` already pairs result to call by raw equality.
 *
 * Pairing keys are used only for lookup; the messages' own ids are left intact
 * so the provider encoder still receives the exact wire ids it expects.
 *
 * LOAD-BEARING INVARIANT: pairing correctness depends on the wire `call_id`
 * being unique per distinct tool call. The Codex Responses wire guarantees this
 * (distinct parallel calls carry distinct call_ids; only the `fc_` half varies),
 * and genuine cross-turn id reuse is `_dup`-suffixed on the call_ segment by
 * `deduplicateToolCallIds` (which this key preserves).
 */
function toolCallPairingKey(id: string, originScope: ToolCallOriginScope): string {
	const pipe = id.indexOf("|");
	if (pipe <= 0) return id;
	if (originScope.opaqueCompositeCallIds.has(id)) return id;
	const prefix = id.slice(0, pipe);
	return originScope.responsesComponents.has(prefix) ? prefix : id;
}

function appendDuplicateSuffix(originalId: string, suffix: string, maxLength: number): string {
	// Responses-family ids are composites (`callId|itemId`): the wire call_id is
	// the FIRST segment (normalizeResponsesToolCallId splits on `|`), so the
	// suffix must land on every segment or the duplicate collapses back onto the
	// original call_id at encode time. The length budget applies per segment,
	// matching the per-segment caps of the provider normalizers.
	if (originalId.includes("|")) {
		return originalId
			.split("|")
			.map(segment => appendSegmentDuplicateSuffix(segment, suffix, maxLength))
			.join("|");
	}
	return appendSegmentDuplicateSuffix(originalId, suffix, maxLength);
}

function appendSegmentDuplicateSuffix(segment: string, suffix: string, maxLength: number): string {
	if (segment.length + suffix.length <= maxLength) return `${segment}${suffix}`;
	const prefixBudget = Math.max(0, maxLength - suffix.length);
	return `${segment.slice(0, prefixBudget)}${suffix}`;
}

type PendingToolResultRewrite = { replacementId: string } | undefined;

function deduplicateToolCallIds(
	messages: Message[],
	originScope: ToolCallOriginScope,
	maxToolCallIdLength = MAX_TOOL_CALL_ID_LENGTH,
	duplicateSuffixPrefix = "_dup",
): Message[] {
	const seenToolCallIds = new Map<string, number>();
	const pendingToolResultRewrites = new Map<string, PendingToolResultRewrite[]>();

	return messages.map(msg => {
		if (msg.role === "toolResult") {
			// Pair on the call_ component: a composite result id
			// (`call_X|fc_Y`) must find the rewrite enqueued under its assistant
			// call's canonical id. Raw-string keying here misses the composite,
			// so the `_dup` remap silently no-ops and a reused call_id's later
			// result is dropped downstream.
			const key = toolCallPairingKey(msg.toolCallId, originScope);
			const rewrites = pendingToolResultRewrites.get(key);
			if (!rewrites || rewrites.length === 0) return msg;

			const rewrite = rewrites.shift();
			if (rewrites.length === 0) pendingToolResultRewrites.delete(key);
			if (rewrite) return { ...msg, toolCallId: rewrite.replacementId };
			return msg;
		}

		if (msg.role !== "assistant") return msg;

		const enqueueToolResultRewrite = (id: string, rewrite: PendingToolResultRewrite): void => {
			const rewrites = pendingToolResultRewrites.get(id);
			if (rewrites) {
				rewrites.push(rewrite);
				return;
			}
			pendingToolResultRewrites.set(id, [rewrite]);
		};

		// Ids this turn has already touched; used to scope the "drop carried-over
		// pending rewrites" semantics to the FIRST occurrence per turn so multiple
		// blocks of the same id within one turn still accumulate as duplicates.
		const idsTouchedInTurn = new Set<string>();
		let contentChanged = false;
		const content = msg.content.map(block => {
			if (block.type !== "toolCall") return block;

			// Route all dedup bookkeeping by the call_ component so a plain
			// assistant id and a composite result id (`call_X` / `call_X|fc_Y`)
			// share one counter + rewrite queue. The `_dup` SUFFIX still lands on
			// the full wire id via `appendDuplicateSuffix` (below) — only the
			// KEYING is canonical, so emitted ids are unchanged.
			const blockKey = toolCallPairingKey(block.id, originScope);

			// Drop any pending rewrites carried over from a prior assistant turn
			// for this id on its first appearance this turn. When a later turn
			// re-emits the same id, the older duplicate call's expected result
			// never landed in time — the second pass synthesizes
			// "No result provided" for it, and the upcoming real result(id) must
			// route to one of THIS turn's calls. Without this guard the older
			// `_dup` id would steal the next result.
			if (!idsTouchedInTurn.has(blockKey)) {
				pendingToolResultRewrites.delete(blockKey);
				idsTouchedInTurn.add(blockKey);
			}

			const previousCount = seenToolCallIds.get(blockKey) ?? 0;
			if (previousCount === 0) {
				seenToolCallIds.set(blockKey, 1);
				enqueueToolResultRewrite(blockKey, undefined);
				return block;
			}

			let duplicateIndex = previousCount;
			let replacementId = appendDuplicateSuffix(
				block.id,
				`${duplicateSuffixPrefix}${duplicateIndex}`,
				maxToolCallIdLength,
			);
			while (seenToolCallIds.has(toolCallPairingKey(replacementId, originScope))) {
				duplicateIndex += 1;
				replacementId = appendDuplicateSuffix(
					block.id,
					`${duplicateSuffixPrefix}${duplicateIndex}`,
					maxToolCallIdLength,
				);
			}
			seenToolCallIds.set(blockKey, duplicateIndex + 1);
			seenToolCallIds.set(toolCallPairingKey(replacementId, originScope), 1);
			enqueueToolResultRewrite(blockKey, { replacementId });
			contentChanged = true;
			return { ...block, id: replacementId };
		});

		if (!contentChanged) return msg;
		return { ...msg, content };
	});
}

/**
 * Drop assistant `toolCall` blocks whose `id` or `name` is empty / whitespace-only,
 * the `toolResult` messages they point at, and any assistant turn that has no
 * replayable content left.
 *
 * Models occasionally emit malformed calls such as `{ "name": "", "arguments": "{}" }`
 * (observed: GLM-5.2 + thinking on long turns, #3458) or a structurally valid
 * `toolCall` whose provider/native passthrough id never materialized (`id: ""`).
 * The agent loop rejects or skips these at execution time, but the malformed block
 * and its error tool-result can stay in `currentContext.messages`, so every
 * subsequent request replays them. Every provider validates the call shape —
 * Anthropic 400s on `tool_use.name` / `tool_use.id` (alongside an orphan
 * `tool_result`), OpenAI Chat Completions 400s on malformed
 * `tool_calls[i].function.*` — wedging the session in a 400 loop until manual
 * `/clear`.
 *
 * Run before any other transform so the rest of the pipeline never sees a
 * malformed call. Idempotent: a re-run on an already-sanitized list returns
 * the input untouched. Provider-agnostic — any wire model could surface this.
 */
function isMalformedToolCallName(name: string | undefined): boolean {
	return !name || name.trim().length === 0;
}

function isMalformedToolCallId(id: string | undefined): boolean {
	return !id || id.trim().length === 0;
}

function isMalformedToolCall(block: { id: string; name: string }): boolean {
	return isMalformedToolCallId(block.id) || isMalformedToolCallName(block.name);
}

function sanitizeMalformedToolCalls(messages: Message[]): Message[] {
	// Fast path: skip the rewrite entirely when nothing is malformed.
	let hasMalformed = false;
	outer: for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content) {
			if (block.type === "toolCall" && isMalformedToolCall(block)) {
				hasMalformed = true;
				break outer;
			}
		}
	}
	if (!hasMalformed) return messages;

	// Positional FIFO pairing within one assistant→tool-result window: a tool-call
	// id can repeat across history when an OpenAI-Responses composite id
	// (`callId|itemId`) collapses on the wire to the same `callId` (see
	// `deduplicateToolCallIds` + `transform-messages-dedup`). A set-based "drop
	// every result for this id" loses the real output for the surviving valid
	// occurrence whenever one duplicate is malformed. Track each `toolCall`
	// occurrence's malformed-ness on a per-id queue and pop on matching
	// `toolResult`, but clear the queues at every non-result boundary so a
	// malformed call whose rejection result never arrived cannot consume a later
	// valid call's real result when the id is reused.
	const dropQueues = new Map<string, boolean[]>();
	const result: Message[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			dropQueues.clear();
			const filtered: AssistantMessage["content"] = [];
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const malformed = isMalformedToolCall(block);
					const queue = dropQueues.get(block.id);
					if (queue) queue.push(malformed);
					else dropQueues.set(block.id, [malformed]);
					if (malformed) continue;
				}
				filtered.push(block);
			}
			if (filtered.length === 0) continue;
			result.push(filtered.length === msg.content.length ? msg : { ...msg, content: filtered });
			continue;
		}
		if (msg.role === "toolResult") {
			const queue = dropQueues.get(msg.toolCallId);
			if (queue && queue.length > 0) {
				const drop = queue.shift() === true;
				if (queue.length === 0) dropQueues.delete(msg.toolCallId);
				if (drop) continue;
			}
			result.push(msg);
			continue;
		}
		dropQueues.clear();
		result.push(msg);
	}
	return result;
}

function shouldDropTruncatedThinkingOnlyAssistant(msg: AssistantMessage): boolean {
	const isTruncatedStop = msg.stopReason === "length" || msg.stopReason === "error" || msg.stopReason === "aborted";
	return isTruncatedStop && !msg.content.some(block => block.type === "toolCall" || block.type === "text");
}

function getLatestSurvivingAssistantIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const msg = messages[index]!;
		if (msg.role === "assistant" && !shouldDropTruncatedThinkingOnlyAssistant(msg)) {
			return index;
		}
	}
	return -1;
}

function isAnthropicMessagesModel(model: Model): model is Model<"anthropic-messages"> {
	return model.api === "anthropic-messages";
}

/**
 * Targets that have proven they read unsigned foreign thinking when replayed
 * natively. This is a semantic-carry allowlist only: OpenAI-compatible
 * `reasoning_content` schema requirements and llama.cpp cache-prefix replay are
 * handled by their encoders and MUST NOT make foreign thinking look meaningful.
 */
function targetReadsForeignThinking(model: Model, compat: Model["compat"]): boolean {
	if (compat === undefined) return false;
	if (model.api === "anthropic-messages") {
		return "replayUnsignedThinking" in compat && compat.replayUnsignedThinking === true;
	}
	if (model.api !== "openai-completions") return false;
	if (!("thinkingFormat" in compat)) return false;
	if (compat.requiresThinkingAsText) return false;
	return model.reasoning && compat.thinkingFormat === "zai";
}

const ANTHROPIC_TOOL_CALL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function isValidAnthropicToolCallId(id: string): boolean {
	return ANTHROPIC_TOOL_CALL_ID_PATTERN.test(id);
}

function fallbackAnthropicToolCallId(originalId: string): string {
	return `toolu_${Bun.hash(originalId).toString(36)}`;
}

function normalizeAnthropicTargetToolCallId<TApi extends Api>(
	id: string,
	model: Model<TApi>,
	source: AssistantMessage,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): string {
	if (isValidAnthropicToolCallId(id)) return id;
	const normalized =
		normalizeToolCallId?.(id, model, source) ?? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_CALL_ID_LENGTH);
	if (isValidAnthropicToolCallId(normalized)) return normalized;
	return fallbackAnthropicToolCallId(id);
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 *
 * For aborted/errored turns, this function:
 * - Preserves tool call structure (unlike converting to text summaries)
 * - Injects synthetic "aborted" tool results
 */
/**
 * Credential-shaped token patterns scrubbed from outbound provider traffic when
 * credential redaction is enabled. Exported so hosts can route the same shapes
 * through reversible obfuscation (keyed placeholders restored before local tool
 * execution) instead of the irreversible `[*_token_redacted]` rewrite below —
 * an irreversible placeholder echoed back in edit-tool `old_string` can never
 * match the real bytes on disk.
 */
export const SENSITIVE_TOKEN_RE =
	/(?<![a-zA-Z0-9_*-])(gh[opusr]_[a-zA-Z0-9_*]{36,}|github_pat_[a-zA-Z0-9_*]{36,}|glpat-[a-zA-Z0-9_*-]{20,}|sk-proj-[a-zA-Z0-9_*-]{36,}|sk-ant-[a-zA-Z0-9_*-]{36,}|sk-[a-zA-Z0-9_*-]{48,})(?![a-zA-Z0-9_*-])/gi;

function hasPlausibleCredentialEntropy(token: string): boolean {
	const lower = token.toLowerCase();
	const prefixLength = lower.startsWith("github_pat_")
		? "github_pat_".length
		: lower.startsWith("glpat-")
			? "glpat-".length
			: lower.startsWith("sk-proj-")
				? "sk-proj-".length
				: lower.startsWith("sk-ant-")
					? "sk-ant-".length
					: lower.startsWith("gh")
						? 4
						: 3;
	const secret = token.slice(prefixLength);
	if (/^\*+$/.test(secret)) return true;
	return [/[a-z]/, /[A-Z]/, /\d/, /[_-]/].filter(pattern => pattern.test(secret)).length >= 2;
}

/**
 * Whether outbound credential-pattern redaction is active. Off by default;
 * hosts opt in explicitly (the coding agent wires this to the
 * `secrets.enabled` setting).
 */
let credentialRedactionEnabled = false;

/**
 * Toggle outbound credential-pattern redaction. When disabled (the default),
 * {@link redactSensitiveCredentials} and {@link redactSensitiveInObject} are
 * pass-throughs and outbound messages/system prompts leave the process
 * unmodified.
 */
export function configureCredentialRedaction(enabled: boolean): void {
	credentialRedactionEnabled = enabled;
}

export function redactSensitiveCredentials(text: string): string {
	if (!credentialRedactionEnabled) return text;
	return text.replace(SENSITIVE_TOKEN_RE, match => {
		if (!hasPlausibleCredentialEntropy(match)) return match;
		const lower = match.toLowerCase();
		if (lower.startsWith("gh")) {
			return "[github_token_redacted]";
		}
		if (lower.startsWith("gl")) {
			return "[gitlab_token_redacted]";
		}
		if (lower.startsWith("sk-ant-")) {
			return "[anthropic_token_redacted]";
		}
		if (lower.startsWith("sk")) {
			return "[openai_token_redacted]";
		}
		return "[token_redacted]";
	});
}

export function redactSensitiveInObject(val: unknown): { result: unknown; changed: boolean } {
	if (!credentialRedactionEnabled) return { result: val, changed: false };
	if (typeof val === "string") {
		const redacted = redactSensitiveCredentials(val);
		return { result: redacted, changed: redacted !== val };
	}
	if (Array.isArray(val)) {
		let changed = false;
		const result = val.map(item => {
			const res = redactSensitiveInObject(item);
			if (res.changed) changed = true;
			return res.result;
		});
		return { result, changed };
	}
	if (val !== null && typeof val === "object") {
		let changed = false;
		const res: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(val)) {
			const sub = redactSensitiveInObject(v);
			if (sub.changed) changed = true;
			res[k] = sub.result;
		}
		return { result: res, changed };
	}
	return { result: val, changed: false };
}

function redactSensitiveCredentialsInMessages(messages: Message[]): Message[] {
	if (!credentialRedactionEnabled) return messages;
	return messages.map((msg): Message => {
		if (msg.role === "user" || msg.role === "developer") {
			const userMsg = msg as UserMessage | DeveloperMessage;
			if (typeof userMsg.content === "string") {
				const redacted = redactSensitiveCredentials(userMsg.content);
				if (redacted === userMsg.content) return msg;
				return { ...userMsg, content: redacted } as Message;
			}
			const contentArray = userMsg.content;
			let changed = false;
			const content = contentArray.map((block): UserMessage["content"][number] => {
				if (block.type === "text") {
					const redacted = redactSensitiveCredentials(block.text);
					if (redacted !== block.text) {
						changed = true;
						return { ...block, text: redacted };
					}
				}
				return block;
			});
			return (changed ? { ...userMsg, content } : userMsg) as Message;
		}

		if (msg.role === "toolResult") {
			const toolResultMsg = msg as ToolResultMessage;
			let changed = false;
			const content = toolResultMsg.content.map((block): ToolResultMessage["content"][number] => {
				if (block.type === "text") {
					const redacted = redactSensitiveCredentials(block.text);
					if (redacted !== block.text) {
						changed = true;
						return { ...block, text: redacted };
					}
				}
				return block;
			});
			return (changed ? { ...toolResultMsg, content } : toolResultMsg) as Message;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			let changed = false;
			const content = assistantMsg.content.map((block): AssistantMessage["content"][number] => {
				if (block.type === "text") {
					const redacted = redactSensitiveCredentials(block.text);
					if (redacted !== block.text) {
						changed = true;
						return { ...block, text: redacted };
					}
				} else if (block.type === "thinking") {
					const redacted = redactSensitiveCredentials(block.thinking);
					if (redacted !== block.thinking) {
						changed = true;
						return { ...block, thinking: redacted, thinkingSignature: undefined };
					}
				} else if (block.type === "toolCall") {
					if (block.arguments) {
						const { result: redactedArgs, changed: argsChanged } = redactSensitiveInObject(block.arguments);
						if (argsChanged) {
							changed = true;
							const castArgs =
								redactedArgs && typeof redactedArgs === "object" && !Array.isArray(redactedArgs)
									? (redactedArgs as Record<string, unknown>)
									: undefined;
							return {
								...block,
								arguments: castArgs,
								thoughtSignature: undefined,
							} as AssistantMessage["content"][number];
						}
					}
				}
				return block;
			});
			return (changed ? { ...assistantMsg, content } : assistantMsg) as Message;
		}

		return msg;
	});
}

export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
	maxNormalizedToolCallIdLength = MAX_TOOL_CALL_ID_LENGTH,
	duplicateToolCallIdSuffixPrefix = "_dup",
	targetCompat: Model<TApi>["compat"] = model.compat,
): Message[] {
	// Redact sensitive credential-like patterns from all outbound messages when
	// the host opted in via `configureCredentialRedaction` — prevents security
	// block errors from LLM providers (e.g. invalid_prompt).
	messages = redactSensitiveCredentialsInMessages(messages);

	// Drop assistant `toolCall` blocks with empty/whitespace `id` or `name`
	// (and their matched `toolResult` messages) before anything else looks at
	// the history. Replays of these would 400 every provider — see
	// `sanitizeMalformedToolCalls`.
	messages = sanitizeMalformedToolCalls(messages);

	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	// Responses-family assistant composite ids (`call_id|item_id`) normalized for
	// a cross-provider target keyed by their `call_id` component, so a paired
	// tool RESULT arriving with a DIFFERENT item half still resolves to the same
	// normalized id. Only Responses-origin ids populate this (opaque Chat
	// Completions ids pair by raw equality and must never be canonicalized).
	const responsesCompositeIdMap = new Map<string, string>();

	const latestSurvivingAssistantIndex = getLatestSurvivingAssistantIndex(messages);
	const invalidBoundThinkingAssistantIndexes = new Set<number>();
	if (model.thinking?.prefixBinding) {
		let latestRewriteAt: number | undefined;
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			if (message.role === "user" && message.historyRewriteAt !== undefined) {
				latestRewriteAt =
					latestRewriteAt === undefined
						? message.historyRewriteAt
						: Math.max(latestRewriteAt, message.historyRewriteAt);
			} else if (message.role === "toolResult" && message.prunedAt !== undefined) {
				latestRewriteAt =
					latestRewriteAt === undefined ? message.prunedAt : Math.max(latestRewriteAt, message.prunedAt);
			} else if (
				message.role === "assistant" &&
				latestRewriteAt !== undefined &&
				message.timestamp <= latestRewriteAt
			) {
				invalidBoundThinkingAssistantIndexes.add(index);
			}
		}
	}
	// First pass: transform messages (thinking blocks, tool call ID normalization)
	const normalizedMessages = messages.map((msg, index) => {
		// User and developer messages pass through unchanged
		if (msg.role === "user" || msg.role === "developer") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const exactNormalizedId = toolCallIdMap.get(msg.toolCallId);
			const normalizedId =
				exactNormalizedId ??
				(msg.toolCallId.includes("|")
					? responsesCompositeIdMap.get(responsesCallComponent(msg.toolCallId))
					: undefined);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const isAnthropicTarget = isAnthropicMessagesModel(model);
			// Anthropic's all-or-none contract on prior-turn thinking blocks
			// applies to every `anthropic-messages → anthropic-messages` replay,
			// not just the latest assistant turn. The legacy
			// `mustPreserveLatestAnthropicThinking` flag only honored it for the
			// latest turn; every prior turn fell through to the cross-API
			// text-demotion path whenever the conversation crossed a model id,
			// silently dropping the reasoning chain on continuation for custom
			// anthropic-messages providers configured via `models.yaml` and
			// session-level model swaps (#2257).
			const isAnthropicReplay = isAnthropicTarget && assistantMsg.api === "anthropic-messages";
			const sameAnthropicDeployment =
				isAnthropicReplay &&
				assistantMsg.provider === model.provider &&
				(model.compat.officialEndpoint || model.thinking?.prefixBinding === true);
			const isLatestSurvivingAssistant = index === latestSurvivingAssistantIndex;
			// Signature policy is a second axis. Anthropic cryptographically
			// binds reasoning signatures to its deployment and model lineage.
			// First-party deployments now accept same-deployment cross-model
			// signatures and drop blocks the target model cannot read. Signatures
			// still must be stripped when a signing endpoint boundary is crossed:
			//   * official Anthropic (source): the 3p target can't reverify a
			//     foreign signature and keeping it leaks continuation metadata
			//     for no benefit.
			//   * signing Anthropic (target): opaque signing proxies cannot prove
			//     they share the source deployment. Foreign signatures can trigger
			//     `400 Invalid signature in thinking block` (#4297).
			// 3p ↔ 3p replays preserve signatures because compatible providers
			// (Z.AI, DeepSeek, custom `models.yaml` providers) treat them as
			// opaque continuation hints rather than verified material; stripping
			// degrades the reasoning chain into unsigned/text on the next turn
			// (#2265). Source-side official detection uses the canonical catalog
			// provider id `"anthropic"` because assistant messages carry no
			// `baseUrl` — a user who manually points `provider: "anthropic"` at
			// a custom proxy via `models.yaml` will see signatures stripped, the
			// conservative direction (degraded reasoning, not broken requests).
			const isOfficialAnthropicSource = isAnthropicReplay && assistantMsg.provider === "anthropic";
			const isSigningAnthropicTarget = isAnthropicTarget && model.compat.signingEndpoint;
			const signingAnthropicInvolved = isOfficialAnthropicSource || isSigningAnthropicTarget;
			// Compatible Anthropic-messages reasoning targets that accept
			// unsigned thinking natively (Z.AI, DeepSeek, the generic
			// `reasoning && !official` case in the compat builder). Used to keep
			// `redacted_thinking` siblings beside unsigned visible thinking on
			// targets that won't text-demote it.
			const replaysUnsignedAnthropicThinking = isAnthropicTarget && model.compat.replayUnsignedThinking;
			// Thinking signatures can be untrustworthy for two distinct reasons with very
			// different blast radii:
			//
			// 1. Aborted/errored turns: the stream stopped mid-block, so only the block
			//    that was streaming at the abort point — always the FINAL content block —
			//    can carry a partially-streamed (invalid) signature. Every earlier block
			//    completed: Anthropic delivers a block's signature at its
			//    `content_block_stop`, which necessarily fired before the next block began,
			//    so those signatures are whole and valid. Stripping them would needlessly
			//    discard a replayable thinking chain — e.g. interrupting during the visible
			//    text output after thinking already finished leaves a fully-signed thinking
			//    block that must be kept, or Anthropic rejects the replay with HTTP 400
			//    "Invalid `signature` in `thinking` block".
			//
			// 2. Abandoned tool-use turns: a turn that carries toolCall blocks but did NOT
			//    request tool execution (stopReason !== "toolUse" — e.g. adaptive-thinking
			//    Opus emitting tool calls and then ending on `end_turn`/`stop`). The agent
			//    loop pairs those calls with placeholder tool_results to keep the
			//    tool_use/tool_result contract valid. The turn completed cleanly, but its
			//    signatures are end_turn-bound and cannot be replayed in that synthesized
			//    continuation, so EVERY thinking signature is stripped.
			//
			// Latest abandoned turns are exempt because Anthropic requires thinking blocks
			// from its most recent response to remain byte-for-byte unmodified.
			const invalidStopReason = assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error";
			const abandonedToolUse =
				!invalidStopReason &&
				assistantMsg.stopReason !== "toolUse" &&
				assistantMsg.content.some(b => b.type === "toolCall");
			const lastBlockIndex = assistantMsg.content.length - 1;

			const anthropicVisibleThinkingSurvivesReplay = (
				candidate: AssistantMessage["content"][number],
				candidateIndex: number,
			): boolean => {
				if (candidate.type !== "thinking") return false;
				if (!isAnthropicReplay) return false;
				if (isLatestSurvivingAssistant && abandonedToolUse) return true;
				const candidateSignatureUntrustworthy =
					abandonedToolUse || (invalidStopReason && candidateIndex === lastBlockIndex);
				const replaySignature =
					candidateSignatureUntrustworthy && candidate.thinkingSignature ? undefined : candidate.thinkingSignature;
				if (!replaySignature && (!candidate.thinking || candidate.thinking.trim() === "")) return false;
				if (isSameModel && isSigningAnthropicTarget && (!replaySignature || replaySignature.trim() === "")) {
					return false;
				}
				return true;
			};
			const hasVisibleAnthropicThinking = assistantMsg.content.some(candidate => candidate.type === "thinking");
			const dropsAllSameModelVisibleThinking =
				isAnthropicReplay &&
				isSameModel &&
				isSigningAnthropicTarget &&
				hasVisibleAnthropicThinking &&
				!assistantMsg.content.some(anthropicVisibleThinkingSurvivesReplay);

			const transformedContent = assistantMsg.content.flatMap((block, blockIndex) => {
				if (
					invalidBoundThinkingAssistantIndexes.has(index) &&
					(block.type === "thinking" || block.type === "redactedThinking")
				) {
					return [];
				}
				if (block.type === "thinking") {
					// Only an aborted/errored turn's final (mid-stream) block can hold a
					// partial signature; abandoned tool-use turns strip all. Drop the
					// untrustworthy signature so the encoder can downgrade the block to text.
					const signatureUntrustworthy = abandonedToolUse || (invalidStopReason && blockIndex === lastBlockIndex);
					let sanitized: typeof block =
						signatureUntrustworthy && block.thinkingSignature
							? { ...block, thinkingSignature: undefined }
							: block;
					if (isAnthropicReplay) {
						// A signature is only replayable where its issuer can verify it.
						// Same-provider replays (including cross-model-id switches within
						// official Anthropic — pinned by the prefill suite) keep the
						// latest turn byte-for-byte per Anthropic's rule for its own most
						// recent response. A latest turn minted by a DIFFERENT provider
						// is not "Anthropic's own response": its signature can never
						// verify on a signing Anthropic target and wedges the session
						// with `400 Invalid signature in thinking block` on every
						// attempt until the poisoned turn ages out of the replay window
						// (observed live: a kimi-code/k3 turn replayed to official
						// Anthropic after a session-level model switch mid tool-loop).
						const crossProviderSource = assistantMsg.provider !== model.provider;
						// Latest abandoned turn: Anthropic's byte-for-byte rule forbids
						// even stripping a signature on the latest message — but only
						// for turns the target's own provider issued.
						if (isLatestSurvivingAssistant && abandonedToolUse && !crossProviderSource) return block;
						// Preserve same-deployment signatures and let Anthropic perform
						// its one-way model compatibility check. Across deployments,
						// strip stale signatures so the encoder applies the target's
						// unsigned-thinking policy. 3p ↔ 3p replays keep opaque
						// signatures as continuation metadata (#2265).
						const staleSignature =
							!sameAnthropicDeployment && (isLatestSurvivingAssistant ? crossProviderSource : !isSameModel);
						if (staleSignature && signingAnthropicInvolved && sanitized.thinkingSignature) {
							sanitized = { ...sanitized, thinkingSignature: undefined };
						}
						// Drop blocks with neither a signature anchor nor any text —
						// nothing for the next turn to replay.
						if (!sanitized.thinkingSignature && (!sanitized.thinking || sanitized.thinking.trim() === "")) {
							return [];
						}
						// Same-model Anthropic replay to a signature-enforcing endpoint
						// requires valid signatures to natively replay thinking blocks.
						// Both undefined and empty string signatures are invalid and must
						// be dropped entirely — not demoted to text. Demotion would cause
						// the reasoning_extraction safety classifier to refuse the response.
						if (
							isSameModel &&
							isSigningAnthropicTarget &&
							(!sanitized.thinkingSignature || sanitized.thinkingSignature.trim() === "")
						) {
							return [];
						}
						return sanitized;
					}
					// Cross-API target: same-model replay keeps signatures untouched
					// (the encoder needs them for native replay; an OpenAI encrypted
					// reasoning blob has empty text but a load-bearing signature).
					if (isSameModel && sanitized.thinkingSignature) return sanitized;
					// Nothing left for the next turn to replay: drop empty/no-anchor
					// thinking blocks before the cross-model paths.
					if (!sanitized.thinking || sanitized.thinking.trim() === "") return [];
					if (isSameModel) return sanitized;
					// Cross-model + cross-API: preserve native thinking only for
					// targets proven to read unsigned foreign reasoning (Z.AI-format
					// OpenAI-compatible targets, plus Anthropic-compatible
					// `replayUnsignedThinking`). Tool-call schema requirements and
					// llama.cpp cache-prefix replay are orthogonal encoder concerns;
					// keeping inert foreign CoT native for those flags loses the
					// canonical visible-text fallback without adding model context.
					if (targetReadsForeignThinking(model, targetCompat)) {
						return sanitized.thinkingSignature ? { ...sanitized, thinkingSignature: undefined } : sanitized;
					}
					// Other cross-API targets (openai-responses encrypted blobs, google
					// thought parts, anthropic-target from a non-Anthropic source, or any
					// reasoning-disabled target) can't replay an unsigned thinking block:
					// the native reasoning slot either rejects a foreign signature or — as
					// verified end-to-end against Gemini 3 — silently discards unsigned
					// thought content (it is neither recalled nor influences generation).
					// Demote to text so the reasoning survives as context, wrapped in the
					// TARGET model's own canonical thinking-block dialect (e.g. a ```thinking
					// fence for Gemini) so it reads as reasoning rather than bare prose the
					// model might mimic.
					// Mark the demoted block (symbol-keyed, never serialized) instead of
					// baking a separator into its text: the openai-completions flatten —
					// the one consumer that joins adjacent text blocks into a single
					// string — inserts a paragraph break after marked blocks, so the
					// bare Anthropic-dialect output (or any dialect's wrapped output
					// whose closing tag isn't a natural word boundary) can't glue onto
					// the following visible-text block, while ordinary adjacent text
					// blocks stitched from streaming / bridges / imported transcripts
					// stay byte-identical. A separator baked into the block text would
					// leak to non-flattening targets: Anthropic/Bedrock reject a
					// terminal assistant message whose text ends with whitespace.
					return {
						type: "text" as const,
						text: renderDemotedThinking(model.id, sanitized.thinking),
						[kDemotedThinking]: true,
					};
				}

				if (block.type === "redactedThinking") {
					// Redacted thinking is native-only. Keep it for same-model
					// signed replay, for the latest byte-for-byte turn issued by the
					// target's own provider, or for compatible targets that will
					// also emit sibling unsigned thinking natively. Drop it when the
					// matching visible thinking was discarded, or when visible
					// thinking was stripped and will be demoted to text — a foreign
					// redacted payload can no more verify on a signing target than a
					// foreign visible signature can, even on the latest turn.
					if (isAnthropicReplay) {
						if (dropsAllSameModelVisibleThinking) return [];
						if (
							isSameModel ||
							sameAnthropicDeployment ||
							(isLatestSurvivingAssistant && assistantMsg.provider === model.provider) ||
							replaysUnsignedAnthropicThinking
						) {
							return block;
						}
						return [];
					}
					if (isSameModel) return block;
					return [];
				}

				if (block.type === "anthropicServerTool") {
					// Anthropic requires native server-tool calls and results to be
					// replayed unchanged. They are meaningful only to the provider
					// that produced them; every cross-provider target drops them.
					if (isAnthropicReplay && assistantMsg.provider === model.provider) return block;
					return [];
				}

				if (block.type === "fallback") {
					// Server-side-fallback boundary marker (Anthropic beta
					// `server-side-fallback-2026-06-01`). Only the official
					// Anthropic endpoint accepts this block on replay: every
					// other target either rejects unknown content blocks with a
					// 400 (anthropic-compatible endpoints like Umans/Z.AI/MiniMax,
					// and older omp gateways whose schema pre-dates this feature)
					// or throws in its converter (Bedrock). Even the official
					// replay path only accepts the block when the current request
					// itself opts into the beta — but we don't know that here, so
					// keep it and let `convertAnthropicMessages` re-check the
					// per-request opt-in before serializing.
					if (isAnthropicTarget && model.compat.officialEndpoint) return block;
					return [];
				}

				if (block.type === "image") {
					// Assistant images are display artifacts. No provider accepts them
					// in an assistant replay turn; the native Responses result remains
					// in providerPayload for OpenAI replay.
					return [];
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall, thoughtSignature: undefined };
					}

					let normalizedId: string | undefined;
					if (isAnthropicTarget) {
						normalizedId = normalizeAnthropicTargetToolCallId(
							toolCall.id,
							model,
							assistantMsg,
							normalizeToolCallId,
						);
					} else if (!isSameModel && normalizeToolCallId) {
						normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
					}

					if (normalizedId !== undefined) {
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
						// Record the Responses call-component → emitted-id mapping
						// EVEN WHEN the assistant id is plain and normalization is
						// identity. A composite RESULT (`call_A|fc_R`) for a plain
						// Responses call `call_A` still needs this mapping to resolve
						// onto the emitted id; without it the result stays composite
						// and the target sees a call `call_A` beside a result
						// `call_A|fc_R`, breaking call/result correspondence (and, on
						// Anthropic, the id char rules).
						if (isResponsesFamilyApi(assistantMsg.api)) {
							responsesCompositeIdMap.set(responsesCallComponent(toolCall.id), normalizedId);
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			// A demoted-thinking block that survived as the message's final block can
			// still end with the thinking text's own trailing whitespace (bare
			// Anthropic-dialect demotion copies it verbatim), and Anthropic rejects a
			// terminal assistant message whose text ends with trailing whitespace
			// ("final assistant content cannot end with trailing whitespace").
			// trimEnd() is safe: demoted text is synthesized context, never
			// byte-exact replay material.
			const finalBlock = transformedContent[transformedContent.length - 1];
			if (finalBlock?.type === "text" && isDemotedThinking(finalBlock)) {
				transformedContent[transformedContent.length - 1] = { ...finalBlock, text: finalBlock.text.trimEnd() };
			}

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});
	// Per-concrete-id origin classification — the only scope `toolCallPairingKey`
	// consults to decide whether a pipe-bearing id is a canonicalizable Responses
	// composite or an opaque Chat Completions token that pairs by raw equality.
	const originScope = collectToolCallOriginScope(normalizedMessages);
	const transformed = deduplicateToolCallIds(
		normalizedMessages,
		originScope,
		maxNormalizedToolCallIdLength,
		duplicateToolCallIdSuffixPrefix,
	);
	// All real tool results, keyed by id, in document order. One id can map to
	// more than one result: compaction can fold an assistant `tool_use` into a
	// summary string while its `tool_result` survives, and a later turn may reuse
	// the id. `takeRealToolResult` pulls the earliest unconsumed result positioned
	// AFTER the call's assistant turn, so an orphaned earlier result is never
	// pulled forward onto a later call (which would surface a prior turn's output).
	type IndexedToolResult = { index: number; msg: ToolResultMessage; consumed: boolean };
	const realToolResultsById = new Map<string, IndexedToolResult[]>();
	for (let index = 0; index < transformed.length; index++) {
		const msg = transformed[index];
		if (msg.role === "toolResult") {
			const entry: IndexedToolResult = { index, msg, consumed: false };
			const key = toolCallPairingKey(msg.toolCallId, originScope);
			const entries = realToolResultsById.get(key);
			if (entries) entries.push(entry);
			else realToolResultsById.set(key, [entry]);
		}
	}
	const takeRealToolResult = (id: string, afterIndex: number): ToolResultMessage | undefined => {
		const entries = realToolResultsById.get(toolCallPairingKey(id, originScope));
		if (!entries) return undefined;
		for (const entry of entries) {
			if (entry.consumed || entry.index <= afterIndex) continue;
			entry.consumed = true;
			return entry.msg;
		}
		return undefined;
	};

	// Anthropic rejects `tool_result` blocks whose `tool_use_id` does not appear in a prior
	// `tool_use` block. After handoff/compaction folds an assistant turn into a summary
	// string, the user-side `toolResult` for that turn can survive while the originating
	// `tool_use` disappears — leaving an orphan that triggers HTTP 400. Track the set of
	// `tool_use` ids that survive transformation so the second pass can drop orphans cleanly.
	const validToolUseIds = new Set<string>();
	for (const msg of transformed) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content) {
			if (block.type === "toolCall") validToolUseIds.add(toolCallPairingKey(block.id, originScope));
		}
	}

	// Second pass: ensure each surviving assistant tool call is immediately
	// followed by exactly one corresponding tool result.
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	// Index of the assistant turn that declared `pendingToolCalls`; a pulled
	// result must be positioned after it (see `takeRealToolResult`).
	let pendingToolCallsStartIndex = -1;
	let pendingAbortedToolCalls = new Map<string, ToolCall>();
	let pendingAbortedTimestamp: number | undefined;
	let pendingAbortedStartIndex = -1;
	// Track which tool calls already have an emitted result so delayed/duplicate
	// toolResult messages cannot create a second provider-visible result.
	const toolCallStatus = new Map<string, ToolCallStatus>();

	const flushPendingToolCalls = (timestamp: number): void => {
		if (pendingToolCalls.length === 0) return;
		for (const tc of pendingToolCalls) {
			const statusKey = toolCallPairingKey(tc.id, originScope);
			if (toolCallStatus.has(statusKey)) continue;
			const realToolResult = takeRealToolResult(tc.id, pendingToolCallsStartIndex);
			if (realToolResult) {
				result.push(realToolResult);
				toolCallStatus.set(statusKey, ToolCallStatus.Resolved);
				continue;
			}
			result.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp,
			} as ToolResultMessage);
			toolCallStatus.set(statusKey, ToolCallStatus.Resolved);
		}
		pendingToolCalls = [];
	};

	const flushPendingAbortedToolCalls = (): void => {
		if (pendingAbortedTimestamp === undefined) return;
		for (const tc of pendingAbortedToolCalls.values()) {
			const statusKey = toolCallPairingKey(tc.id, originScope);
			if (toolCallStatus.has(statusKey)) continue;
			const realToolResult = takeRealToolResult(tc.id, pendingAbortedStartIndex);
			if (realToolResult) {
				result.push(realToolResult);
				toolCallStatus.set(statusKey, ToolCallStatus.Resolved);
				continue;
			}
			result.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: "aborted" }],
				isError: true,
				timestamp: pendingAbortedTimestamp,
			} as ToolResultMessage);
			toolCallStatus.set(statusKey, ToolCallStatus.Aborted);
		}
		pendingAbortedToolCalls = new Map();
		pendingAbortedTimestamp = undefined;
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];
		const messageTimestamp = "timestamp" in msg && typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

		if (msg.role === "assistant") {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();

			const assistantMsg = msg as AssistantMessage;

			// Drop assistant turns that carry no actionable content (no `text`, no `toolCall`)
			// AND were terminated by a truncating stop reason (`length` / `error` / `aborted`).
			// These are produced when the provider returns `stop_reason: "max_tokens"` (or a
			// stream error) mid-thinking, leaving a `[thinking]`-only message with a valid
			// signature but nothing for the next turn to anchor on. Keeping it creates
			// back-to-back assistant turns once the next response lands, which Anthropic
			// rejects with "messages.X.content.Y: `thinking` blocks in the latest assistant
			// message cannot be modified".
			//
			// `stopReason: "stop"` thinking-only messages are intentionally preserved: they
			// represent reasoning-only assistant turns used for replay round-trips
			// (OpenAI completions `reasoning_text`, Google signed thought parts).
			const originalMsg = messages[i]!;
			if (originalMsg.role === "assistant" && shouldDropTruncatedThinkingOnlyAssistant(originalMsg)) {
				continue;
			}

			const toolCalls = assistantMsg.content.filter(b => b.type === "toolCall") as ToolCall[];

			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				// Keep the assistant message with tool calls intact. Real tool results are
				// emitted immediately if available; otherwise synthesize aborted results
				// before the next turn boundary.
				result.push(msg);
				pendingAbortedToolCalls = new Map(
					toolCalls.map(toolCall => [toolCallPairingKey(toolCall.id, originScope), toolCall] as const),
				);
				pendingAbortedTimestamp = assistantMsg.timestamp;
				pendingAbortedStartIndex = i;
				continue;
			}

			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				pendingToolCallsStartIndex = i;
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			const resultKey = toolCallPairingKey(msg.toolCallId, originScope);
			if (toolCallStatus.has(resultKey)) continue;

			if (pendingAbortedToolCalls.has(resultKey)) {
				pendingAbortedToolCalls.delete(resultKey);
				toolCallStatus.set(resultKey, ToolCallStatus.Resolved);
				result.push(msg);
				continue;
			}

			if (pendingToolCalls.some(tc => toolCallPairingKey(tc.id, originScope) === resultKey)) {
				toolCallStatus.set(resultKey, ToolCallStatus.Resolved);
				result.push(msg);
				continue;
			}

			if (!validToolUseIds.has(resultKey)) {
				// Orphan `tool_result`: the originating `tool_use` is not present in the
				// transformed history (typically because handoff/compaction folded the
				// assistant message into a summary string while the user-side result
				// survived). Sending the block as-is would 400 the request, so it must
				// be dropped.
				//
				// If a pending tool-call window is still open (either normal or
				// aborted), the orphan cannot be replaced with a developer note here:
				//
				// * Anthropic requires the next message after an assistant `tool_use`
				//   to be the matching `tool_result`. Inserting a developer message
				//   would break that contiguity.
				// * Flushing pending aborted calls here would wedge synthetic results
				//   between the assistant turn and a real result that may still arrive
				//   inside the current contiguous result window.
				//
				// Drop the orphan silently in that case; the pending calls will be
				// resolved in their own contiguous result window or at the next boundary.
				if (
					pendingToolCalls.some(tc => !toolCallStatus.has(toolCallPairingKey(tc.id, originScope))) ||
					pendingAbortedToolCalls.size > 0
				) {
					continue;
				}
				// No pending tool-call window: safe to preserve the text payload so the
				// model still sees what the tool returned.
				//
				// The note is emitted with `role: "user"` rather than `role: "developer"`
				// because the developer role is elevated by some providers:
				//
				// * Ollama maps `developer` -> `system` (highest instruction priority).
				// * OpenAI chat-completions reasoning models forward `developer` as
				//   `developer` (above-user instruction priority).
				//
				// Stale, model-untrusted tool output must not gain instruction priority
				// above user/developer messages it lived alongside before compaction.
				// `user` role is mapped to plain user content by every provider, so the
				// content survives without ever being treated as an instruction the
				// model should obey.
				const textParts: string[] = [];
				for (const part of msg.content) {
					if (part.type === "text" && part.text.trim() !== "") textParts.push(part.text);
				}
				if (textParts.length > 0) {
					const errorAttr = msg.isError ? ' is-error="true"' : "";
					result.push({
						role: "user",
						content: `<stale-tool-result tool="${msg.toolName}" id="${msg.toolCallId}"${errorAttr}>\n${textParts.join("\n")}\n</stale-tool-result>`,
						timestamp: messageTimestamp,
					} as UserMessage);
				}
			}

			// The matching tool_use exists elsewhere, but this result is not in
			// the currently open result window. Emitting it here would break the
			// provider invariant; the first real result is pulled into the correct
			// slot by the pending-call flush instead.
		} else if (msg.role === "user" || msg.role === "developer") {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();
			result.push(msg);
		} else {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();
			result.push(msg);
		}
	}

	flushPendingToolCalls(Date.now());
	flushPendingAbortedToolCalls();

	return result;
}
