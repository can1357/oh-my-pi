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
 */

import {
	DEEPSEEK_TOOL_CALL_END,
	DEEPSEEK_TOOL_CALL_TOKENS,
	DEEPSEEK_TOOL_CALLS_END,
	findDeepSeekTemplateToken,
} from "../dialect/deepseek";
import type { AssistantMessage, Model } from "../types";

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
 * Remove leaked DSML tool-call markup from an assistant message before commit,
 * including reasoning blocks and turns with valid structured calls. Rewritten
 * thinking with an opaque signature is discarded; OpenAI-compatible reasoning
 * field names are replay markers, not signatures, and survive cleanup.
 */
export function removeDsmlToolMarkupLeak(message: AssistantMessage): boolean {
	let content: AssistantMessage["content"] | undefined;
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index]!;
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
			const signature = block.thinkingSignature;
			const reasoningField =
				(message.api === "openai-completions" || message.api === "openrouter") &&
				(signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text");
			if ((!signature || reasoningField) && stripped.trim().length > 0) {
				content.push({ ...block, thinking: stripped });
			}
		}
	}
	if (content) message.content = content;
	return content !== undefined;
}
