import type { Context, Model, Tool } from "@oh-my-pi/pi-ai";
import { stopsOutputAtContextWindow } from "@oh-my-pi/pi-catalog/compat/output-limits";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import { findRequestUsageAnchor } from "./compaction/transcript-tokens";
import type { Tokenizer } from "./tokenizer";

/** Smallest output cap {@link fitOutputTokensToContextWindow} will request. */
export const MIN_FITTED_OUTPUT_TOKENS = 1024;

/**
 * Local counts are padded by 1/this before sizing the output cap: the
 * provider's tokenizer can disagree with ours by a few percent, and
 * undercounting reproduces the overflow this guards against. This is a
 * tokenizer-error margin on locally counted text only (provider-reported
 * usage is exact), not a context reserve; compaction's own reserve
 * (`resolveBudgetReserveTokens`) still decides when to compact.
 */
const PROMPT_ESTIMATE_MARGIN_DIVISOR = 10;

/**
 * Output cap for a request, so prompt plus output stays inside the model's
 * context window.
 *
 * Chat Completions-style providers (DeepSeek, OpenAI, vLLM, ...) reject a
 * request whose prompt tokens plus `max_tokens` exceed the window. Every
 * request asks for `model.maxTokens` of output by default, so without this a
 * large model output cap (DeepSeek V4: ~384k of a ~1M window) makes every
 * request fail once the prompt passes window minus output cap, long before
 * compaction triggers, and side turns (`/btw`, recaps) have no overflow
 * recovery at all.
 *
 * The prompt size is the provider's own report from the newest trustworthy
 * assistant turn (see {@link findRequestUsageAnchor}) plus a local count of
 * only the messages appended after it; the whole context is counted locally
 * only when no turn can anchor (fresh or freshly rewritten context).
 *
 * Returns `maxTokens` unchanged when the requested cap already fits, the
 * model declares no window, the host ends generation at the window itself
 * instead of rejecting the request (`stops-output-at-context-window`, e.g.
 * Claude 4.5+ on the Claude API), or nothing would be requested (including an
 * OpenRouter-hosted model with no caller cap: the transport omits the catalog
 * default there so each upstream self-caps, and a fitted value would turn into
 * an explicit cap that filters upstreams). Otherwise returns
 * the remaining room (never below {@link MIN_FITTED_OUTPUT_TOKENS}); a
 * prompt that fills the whole window still overflows and is left to the
 * caller's compaction. Near a full window the floor means a turn can stop on
 * `length` instead of failing with a 400.
 *
 * Lives here, not next to the default in pi-ai's `mapOptionsForApi`, because
 * pi-ai has no tokenizer; callers apply it in their `streamFn` (coding-agent
 * does so in its shared settings-aware wrapper).
 *
 * Not fixed: Anthropic budget-thinking transports raise `max_tokens` back to
 * at least the thinking budget plus a fallback buffer downstream
 * (`ensureMaxTokensForThinking`), so a fitted cap below that is overridden
 * and the request can still exceed the window as before.
 */
export function fitOutputTokensToContextWindow(
	model: Model,
	context: Context,
	maxTokens: number | undefined,
	tokenizer: Tokenizer,
): number | undefined {
	if (maxTokens === undefined && omitsDefaultOutputCap(model.compat)) return undefined;
	const requested = maxTokens ?? model.maxTokens;
	const contextWindow = model.contextWindow;
	if (!requested || !contextWindow || contextWindow <= 0) return maxTokens;
	if (stopsOutputAtContextWindow(model)) return maxTokens;

	const room = contextWindow - countPromptTokens(context, tokenizer);
	if (room >= requested) return maxTokens;
	return Math.max(MIN_FITTED_OUTPUT_TOKENS, room);
}

/** OpenRouter hosts drop the catalog default cap unless the endpoint always needs one. */
function omitsDefaultOutputCap(compat: Model["compat"] | undefined): boolean {
	return (
		compat !== undefined && "isOpenRouterHost" in compat && compat.isOpenRouterHost && !compat.alwaysSendMaxTokens
	);
}

/**
 * Framing tokens (system prompt, tool definitions) memoized per array: these
 * are stable identities for the life of a turn, so side turns and repeat
 * requests do not re-stringify and re-tokenize them. Length is part of the key
 * to catch in-place growth.
 */
const framingCounts = new WeakMap<readonly unknown[], { tokenizer: Tokenizer; length: number; tokens: number }>();

function countFraming(items: readonly unknown[] | undefined, tokenizer: Tokenizer, fragments: () => string[]): number {
	if (!items || items.length === 0) return 0;
	const cached = framingCounts.get(items);
	if (cached && cached.tokenizer === tokenizer && cached.length === items.length) return cached.tokens;
	const tokens = tokenizer.countTokens(fragments());
	framingCounts.set(items, { tokenizer, length: items.length, tokens });
	return tokens;
}

function toolFragments(tools: readonly Tool[]): string[] {
	const fragments: string[] = [];
	for (const tool of tools) fragments.push(tool.name, tool.description, stringifyJson(tool.parameters) ?? "");
	return fragments;
}

function withMargin(localTokens: number): number {
	return localTokens + Math.ceil(localTokens / PROMPT_ESTIMATE_MARGIN_DIVISOR);
}

/** Provider-anchored prompt size; falls back to a full local count when nothing anchors. */
function countPromptTokens(context: Context, tokenizer: Tokenizer): number {
	const { messages } = context;
	const anchor = findRequestUsageAnchor(messages);
	if (!anchor) return withMargin(countContextTokens(context, tokenizer));
	let tail = 0;
	for (let index = anchor.index + 1; index < messages.length; index++) {
		tail += tokenizer.countMessage(messages[index]);
	}
	return anchor.tokens + withMargin(tail);
}

function countContextTokens(context: Context, tokenizer: Tokenizer): number {
	const { systemPrompt, tools, inactiveTools } = context;
	return (
		countFraming(systemPrompt, tokenizer, () => [...(systemPrompt ?? [])]) +
		countFraming(tools, tokenizer, () => toolFragments(tools ?? [])) +
		// Anthropic replays retired tool definitions, so they are prompt too.
		countFraming(inactiveTools, tokenizer, () => toolFragments(inactiveTools ?? [])) +
		tokenizer.countMessages(context.messages)
	);
}
