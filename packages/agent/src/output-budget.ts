import type { Context, Model, Tool } from "@oh-my-pi/pi-ai";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import type { Tokenizer } from "./tokenizer";

/** Smallest output cap {@link fitOutputTokensToContextWindow} will request. */
export const MIN_FITTED_OUTPUT_TOKENS = 1024;

/**
 * Local counts are padded by 1/this before sizing the output cap: the
 * provider's tokenizer can disagree with ours by a few percent, and
 * undercounting reproduces the overflow this guards against. This is a
 * tokenizer-error margin on the prompt, not a context reserve; compaction's
 * own reserve (`resolveBudgetReserveTokens`) still decides when to compact.
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
 * Returns `maxTokens` unchanged when the requested cap already fits, the
 * model declares no window, or nothing would be requested (including an
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
	model: Pick<Model, "contextWindow" | "maxTokens"> & { compat?: Model["compat"] },
	context: Context,
	maxTokens: number | undefined,
	tokenizer: Tokenizer,
): number | undefined {
	if (maxTokens === undefined && omitsDefaultOutputCap(model.compat)) return undefined;
	const requested = maxTokens ?? model.maxTokens;
	const contextWindow = model.contextWindow;
	if (!requested || !contextWindow || contextWindow <= 0) return maxTokens;

	const counted = countContextTokens(context, tokenizer);
	const promptTokens = counted + Math.ceil(counted / PROMPT_ESTIMATE_MARGIN_DIVISOR);
	const room = contextWindow - promptTokens;
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
