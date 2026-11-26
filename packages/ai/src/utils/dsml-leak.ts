/**
 * Removal of DeepSeek tool-call markup left in visible assistant text.
 *
 * DeepSeek models on OpenAI-compatible hosts sometimes emit their tool calls as
 * text in `content`: the V4 `<｜DSML｜…>` envelope or the V3 chat-template
 * tokens (`<｜tool▁calls▁begin｜>` …). A well-formed call is healed into a
 * structured call by `StreamMarkupHealing`, but a degraded model can drop
 * required tags (or the host runs no healer at all). That markup must not stay
 * in history: replaying it teaches the model to keep writing tool calls as text
 * (issue #10556). Callers strip it before the message is committed and tell the
 * model its call failed.
 *
 * The same markup also leaks into the string arguments of calls the host did
 * parse (`"command": "ls</｜DSML｜ parameter>"`); it is cut off before the call
 * runs. A native Responses replay payload (OpenRouter) holds its own copy of
 * the turn's text, reasoning and arguments and is cleaned the same way.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import {
	DEEPSEEK_TOOL_CALL_END,
	DEEPSEEK_TOOL_CALL_TOKENS,
	DEEPSEEK_TOOL_CALLS_END,
	findDeepSeekTemplateToken,
} from "../dialect/deepseek";
import type { AssistantMessage, Model, OpenAIResponsesHistoryPayload, ProviderPayload } from "../types";
import { copyCursorExecResolved } from "./block-symbols";
import { dropReasoningDetailsEnvelopes, isReasoningField, parseReasoningDetailsSignature } from "./reasoning-source";

// Structural DSML tags in either pipe spelling (fullwidth `｜` U+FF5C or ASCII),
// including doubled delimiters and the observed malformed ` calls` wrapper.
const DSML_TAG_PATTERN = /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|invoke|parameter|calls)\b[^<>]*>?/gu;
// Code the model deliberately quoted (fences, inline spans) is not a leak.
const QUOTED_CODE_PATTERN = /(```|~~~)[\s\S]*?(?:\1|$)|`[^`\n]*`/g;
// The identifier-only line a degraded model writes in place of
// `<｜DSML｜invoke name="…">` (e.g. `bash\n<｜DSML｜parameter …>`): part of the
// broken call, so it goes with the markup.
const TRAILING_TOOL_NAME_LINE = /(^|\n)[ \t]*[A-Za-z_][\w.-]*[ \t]*\r?\n[ \t]*$/;
const CLOSING_TAG_PATTERN = /^<\s*\//;
const BLANK_LINE_PATTERN = /\r?\n[ \t]*\r?\n/;
// Start of a DSML tag in any spelling, opening or closing; the name may be cut off.
const DSML_TAG_START = /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]/u;
const QUOTE_PATTERN = /["'`]/;

interface MarkupTag {
	readonly index: number;
	readonly end: number;
	/** Ends a call or envelope, so the broken call stops here. */
	readonly closing: boolean;
}

/** DSML tags and tool-call template tokens (in any spelling the scanner accepts), in text order. */
function findMarkupTags(text: string): MarkupTag[] {
	const tags: MarkupTag[] = [];
	for (const match of text.matchAll(DSML_TAG_PATTERN)) {
		tags.push({
			index: match.index,
			end: match.index + match[0].length,
			closing: CLOSING_TAG_PATTERN.test(match[0]),
		});
	}
	for (
		let match = findDeepSeekTemplateToken(text, DEEPSEEK_TOOL_CALL_TOKENS);
		match;
		match = findDeepSeekTemplateToken(text, DEEPSEEK_TOOL_CALL_TOKENS, match.index + match.raw.length)
	) {
		tags.push({
			index: match.index,
			end: match.index + match.raw.length,
			closing: match.token === DEEPSEEK_TOOL_CALL_END || match.token === DEEPSEEK_TOOL_CALLS_END,
		});
	}
	return tags.sort((a, b) => a.index - b.index);
}

/**
 * Remove the broken tool call from one stretch of unquoted text: everything from
 * the first markup tag (or the tool-name line just before it) through the last.
 * The DSML scanner keeps a malformed call's closers, so its last closer marks
 * the end. When the closers never arrived, the dangling argument value runs to
 * the next blank line (or the end of the stretch); prose after that survives.
 */
function stripUnquoted(text: string): string {
	const tags = findMarkupTags(text);
	if (tags.length === 0) return text;
	const first = tags[0]!;
	const last = tags[tags.length - 1]!;
	let start = first.index;
	const nameLine = TRAILING_TOOL_NAME_LINE.exec(text.slice(0, start));
	if (nameLine) start = nameLine.index + nameLine[1]!.length;
	let end = last.end;
	if (!last.closing) {
		const blankLine = text.slice(last.end).search(BLANK_LINE_PATTERN);
		end = blankLine === -1 ? text.length : last.end + blankLine;
	}
	const before = text.slice(0, start).trimEnd();
	const after = text.slice(end).trimStart();
	return before.length > 0 && after.length > 0 ? `${before}\n\n${after}` : before + after;
}

/**
 * Whether DSML leak recovery applies to `model`: a DeepSeek-class model, or one
 * explicitly configured with the `dsml` stream healer (e.g. a `models.yml` entry
 * whose id the classifier cannot place). Other models never write DeepSeek tool
 * calls, so such markup from them is prose and is left alone.
 */
export function isDsmlLeakRecoveryTarget(model: Model): boolean {
	if (model.identity?.class === "deepseek") return true;
	const compat = model.compat;
	return (
		compat !== undefined && "streamMarkupHealingPattern" in compat && compat.streamMarkupHealingPattern === "dsml"
	);
}

/**
 * Strip leaked DeepSeek tool-call markup (DSML or chat-template tokens) from
 * `text`, leaving quoted code intact. Returns `undefined` when `text` carries
 * no such markup.
 */
export function stripDsmlToolMarkup(text: string): string | undefined {
	// Every DSML tag names `DSML`; every template token spelling carries a fullwidth bar.
	if (!text.includes("DSML") && !text.includes("｜")) return undefined;
	let out = "";
	let cursor = 0;
	let changed = false;
	const flush = (end: number): void => {
		const segment = text.slice(cursor, end);
		const stripped = stripUnquoted(segment);
		if (stripped !== segment) changed = true;
		out += stripped;
	};
	for (const quoted of text.matchAll(QUOTED_CODE_PATTERN)) {
		flush(quoted.index);
		out += quoted[0];
		cursor = quoted.index + quoted[0].length;
	}
	flush(text.length);
	return changed ? out : undefined;
}

/**
 * Cut leaked DSML off the end of a string tool-call argument; `undefined` when
 * there is none.
 *
 * DeepSeek sometimes writes a structured call's JSON while still emitting DSML:
 * it ends a string value with `</｜DSML｜parameter>` (often misspelled, e.g.
 * `</｜DSML｜ parameter>`) and starts the next parameter (`<｜DSML｜parameter
 * name=`) until that `"` closes the JSON string. A leak is therefore the value's
 * first DSML tag followed by a quote-free tail. DSML written on purpose (a string
 * literal, a quoted grep pattern, a Markdown code span) has a quote after it and
 * is kept.
 */
function stripDsmlArgumentLeak(value: string): string | undefined {
	const tag = DSML_TAG_START.exec(value);
	if (!tag || QUOTE_PATTERN.test(value.slice(tag.index))) return undefined;
	return value.slice(0, tag.index);
}

/** `value` with every nested string argument cut by {@link stripDsmlArgumentLeak}; the same reference when unchanged. */
function stripArgumentLeaks(value: unknown): unknown {
	if (typeof value === "string") return stripDsmlArgumentLeak(value) ?? value;
	if (Array.isArray(value)) {
		let out: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const stripped = stripArgumentLeaks(value[index]);
			if (stripped !== value[index]) (out ??= value.slice())[index] = stripped;
		}
		return out ?? value;
	}
	return isRecord(value) ? stripRecordLeaks(value) : value;
}

function stripRecordLeaks(record: Record<string, unknown>): Record<string, unknown> {
	let out: Record<string, unknown> | undefined;
	for (const key in record) {
		const entry = record[key];
		const stripped = stripArgumentLeaks(entry);
		if (stripped !== entry) (out ??= { ...record })[key] = stripped;
	}
	return out ?? record;
}

/**
 * `payload` with leaked markup removed from its Responses output items;
 * `undefined` when it is not a Responses payload or nothing changed. Same-model
 * replay sends these items verbatim, so markup cleaned only from `content`
 * would still go back to the model as it was written.
 */
function stripPayloadLeaks(payload: ProviderPayload | undefined): OpenAIResponsesHistoryPayload | undefined {
	if (payload?.type !== "openaiResponsesHistory") return undefined;
	const items = mapChanged(payload.items, stripItemLeaks);
	return items === payload.items ? undefined : { ...payload, items };
}

/** A Responses output item after cleanup: the same reference when unchanged, `undefined` when nothing of it is left. */
function stripItemLeaks(item: Record<string, unknown>): Record<string, unknown> | undefined {
	switch (item.type) {
		case "message": {
			const content = stripTextParts(item.content);
			if (content === item.content) return item;
			return isEmptyList(content) ? undefined : { ...item, content };
		}
		case "reasoning": {
			const content = stripTextParts(item.content);
			const summary = stripTextParts(item.summary);
			if (content === item.content && summary === item.summary) return item;
			if (isEmptyList(content) && isEmptyList(summary) && typeof item.encrypted_content !== "string") {
				return undefined;
			}
			const next = { ...item };
			if (content !== item.content) next.content = content;
			if (summary !== item.summary) next.summary = summary;
			return next;
		}
		case "function_call": {
			// Every argument leak names `DSML`; skip parsing the rest.
			if (typeof item.arguments !== "string" || !item.arguments.includes("DSML")) return item;
			let args: unknown;
			try {
				args = JSON.parse(item.arguments);
			} catch {
				return item;
			}
			const stripped = stripArgumentLeaks(args);
			return stripped === args ? item : { ...item, arguments: JSON.stringify(stripped) };
		}
		default:
			return item;
	}
}

/**
 * Text parts (`output_text`, `reasoning_text`, `summary_text`) after
 * {@link stripDsmlToolMarkup}, dropping parts left blank like `content` drops
 * blank blocks. The same reference when unchanged.
 */
function stripTextParts(parts: unknown): unknown {
	return Array.isArray(parts) ? mapChanged<unknown>(parts, stripTextPart) : parts;
}

/** One text part after {@link stripDsmlToolMarkup}: the same reference when unchanged, `undefined` when left blank. */
function stripTextPart(part: unknown): unknown {
	if (!isRecord(part) || typeof part.text !== "string") return part;
	const stripped = stripDsmlToolMarkup(part.text);
	if (stripped === undefined) return part;
	return stripped.trim().length > 0 ? { ...part, text: stripped } : undefined;
}

function isEmptyList(value: unknown): boolean {
	return !Array.isArray(value) || value.length === 0;
}

/** `fn` applied to every entry, dropping `undefined` results; `list` itself when every entry came back unchanged. */
function mapChanged<T>(list: T[], fn: (entry: T) => T | undefined): T[] {
	let out: T[] | undefined;
	for (let index = 0; index < list.length; index++) {
		const entry = list[index]!;
		const next = fn(entry);
		if (next === entry) {
			out?.push(entry);
			continue;
		}
		out ??= list.slice(0, index);
		if (next !== undefined) out.push(next);
	}
	return out ?? list;
}

/**
 * Remove leaked DSML tool-call markup from an assistant message before commit,
 * including reasoning blocks, turns with valid structured calls, the string
 * arguments of those calls (see {@link stripDsmlArgumentLeak}), and the native
 * Responses replay payload, which same-model replay sends verbatim. Rewritten
 * thinking with an opaque signature is discarded; OpenAI-compatible reasoning
 * field names and `reasoning_details` envelopes are replay state, not
 * signatures, and survive cleanup. Envelope entries carry the turn's original
 * reasoning text, so rewriting any thinking block reduces every envelope of the
 * turn to its field marker.
 */
export function removeDsmlToolMarkupLeak(message: AssistantMessage): boolean {
	let content: AssistantMessage["content"] | undefined;
	let thinkingChanged = false;
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index]!;
		if (block.type === "toolCall") {
			const args = stripRecordLeaks(block.arguments);
			if (args === block.arguments) {
				content?.push(block);
				continue;
			}
			content ??= message.content.slice(0, index);
			const call = { ...block, arguments: args };
			copyCursorExecResolved(call, block);
			content.push(call);
			continue;
		}
		if (block.type !== "text" && block.type !== "thinking") {
			content?.push(block);
			continue;
		}
		const stripped = stripDsmlToolMarkup(block.type === "text" ? block.text : block.thinking);
		if (stripped === undefined) {
			content?.push(block);
			continue;
		}
		content ??= message.content.slice(0, index);
		if (block.type === "text") {
			if (stripped.trim().length > 0) content.push({ ...block, text: stripped });
		} else {
			thinkingChanged = true;
			const signature = block.thinkingSignature;
			const completionsTurn = message.api === "openai-completions" || message.api === "openrouter";
			const replayState =
				completionsTurn && (isReasoningField(signature) || parseReasoningDetailsSignature(signature) !== undefined);
			if ((!signature || replayState) && stripped.trim().length > 0) {
				content.push({ ...block, thinking: stripped });
			}
		}
	}
	if (content) message.content = thinkingChanged ? dropReasoningDetailsEnvelopes(content) : content;
	const payload = stripPayloadLeaks(message.providerPayload);
	if (payload) message.providerPayload = payload;
	return content !== undefined || payload !== undefined;
}
