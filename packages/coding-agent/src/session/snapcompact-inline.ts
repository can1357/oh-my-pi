/**
 * Snapcompact inline imaging: per-request transform that swaps the system
 * prompt, loaded context-file instructions, and/or large tool results for
 * dense PNG frames on vision-capable models.
 * Runs inside the agent loop's `transformProviderContext` hook — after the
 * persisted history is converted to the outgoing `Context`, before the
 * provider stream call. It only ever builds NEW message objects/arrays; the
 * input context shares `content` array references with the persisted
 * `SessionMessageEntry` messages, so mutation would leak rendered images
 * into session.jsonl.
 *
 * The swap policy (budget, savings gate, skip rules) lives in
 * `planInlineSwaps`, shared by the transform and the `/context` savings
 * estimate (`estimateInlineSavings`) so the two can never disagree.
 */

import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { Context, ImageContent, Message, Model, TextContent, UserMessage } from "@oh-my-pi/pi-ai";
import {
	HL_FILE_HASH_LENGTH,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_LINE_BODY_SEP,
} from "@oh-my-pi/pi-tui/tools/hashline-format";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { prompt } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { SnapcompactFrameSink } from "../blob-broker/service";
import contextFramesNote from "../prompts/system/snapcompact-context-frames-note.md" with { type: "text" };
import contextStub from "../prompts/system/snapcompact-context-stub.md" with { type: "text" };
import readNoteTemplate from "../prompts/system/snapcompact-read-note.md" with { type: "text" };
import systemFramesNote from "../prompts/system/snapcompact-system-frames-note.md" with { type: "text" };
import systemStub from "../prompts/system/snapcompact-system-stub.md" with { type: "text" };
import toolResultNote from "../prompts/system/snapcompact-toolresult-note.md" with { type: "text" };
import { BRACKET_CONTEXT_ELLIPSIS } from "../tools/read-format";

export type SnapcompactSystemPromptMode = "none" | "agents-md" | "all";

export interface SnapcompactInlineOptions {
	renderSystemPrompt: SnapcompactSystemPromptMode;
	renderToolResults: boolean;
	/** Frame variant override; `"auto"`/omitted picks the provider's eval winner. */
	shape?: snapcompact.ShapeVariantName | "auto";
}

/**
 * Reports the per-tool-result tokens kept off the wire when a swap is applied.
 * `savedTokens` is `textTokens - frames * shape.frameTokenEstimate` for each
 * imaged tool result (always > 0; the savings gate guarantees it). Wired to the
 * append-only savings journal; never throws into the request path.
 */
export type SnapcompactSavingsSink = (
	savings: ReadonlyArray<{ toolCallId: string; savedTokens: number }>,
	model: Model,
) => void;

// Per-deployment image-count budgets come from the catalog via @oh-my-pi/snapcompact
// (`providerImageBudget`): snapcompact frames are 1568px (<2000px) so
// dimension/size limits never bind; only COUNT does. Once the budget is
// spent by already-attached archive/system-prompt images, tool results ship
// verbatim as text.
const MAX_SYSTEM_PROMPT_FRAMES = 6;
/** Tool results under this many tokens are never rasterized — the swap can't
 *  save enough to justify trading crisp text for an image. */
const MIN_TOOL_RESULT_TOKENS = 3000;
/** Render only if imageTokens <= textTokens * SAVINGS_MARGIN. */
const SAVINGS_MARGIN = 0.9;

/** Loose block-array view shared by live contexts and session-history estimates. */
type BlockViews = ReadonlyArray<{ type?: unknown; text?: unknown }>;

/** The one-line notice `prependSuffixResolutionNotice` writes ahead of a resolved read. */
const READ_NOTICE = "(?:\\[[^\\n]*\\]\\n)?";
/**
 * A `read` result's snapshot header (`[path#TAG]`), optionally after the notice.
 * Edits copy the tag, so it stays text.
 */
const READ_HEADER = new RegExp(
	`^${READ_NOTICE}${RegExp.escape(HL_FILE_PREFIX)}[^\\n]+${RegExp.escape(HL_FILE_HASH_SEP)}[0-9A-F]{${HL_FILE_HASH_LENGTH}}${RegExp.escape(HL_FILE_SUFFIX)}\\n`,
);
const READ_ROW_SEP = `[${RegExp.escape(HL_LINE_BODY_SEP)}|]`;
const READ_ROW_PREFIX = `\\d+(?:-\\d+)?${READ_ROW_SEP}`;
/**
 * Fallback for a read without `rowPrefixes` metadata (results from older
 * sessions, read paths that do not record it): its first two rows, after the
 * notice when no header lifted it, an elision row possibly between them. A raw
 * read never prefixes rows, but its lines can look like them (`200:  OK`), so
 * numbering is proven by the second row continuing the count.
 */
const READ_FIRST_ROWS = new RegExp(
	`^${READ_NOTICE}(\\d+)(?:-(\\d+))?${READ_ROW_SEP}[^\\n]*\\n(${RegExp.escape(BRACKET_CONTEXT_ELLIPSIS)}\\n)?(\\d+)(?:-\\d+)?${READ_ROW_SEP}`,
);

/**
 * Whether `rest` carries line-number prefixes. The read tool records the mode
 * as `rowPrefixes` (one-row reads included); without it, a hashline read opens
 * with its header, or the first two rows must count up.
 */
function isNumberedRead(header: string, rest: string, rowPrefixes: boolean | undefined): boolean {
	if (rowPrefixes !== undefined) return rowPrefixes;
	if (header) return true;
	const rows = READ_FIRST_ROWS.exec(rest);
	if (!rows) return false;
	const last = Number(rows[2] ?? rows[1]);
	const next = Number(rows[4]);
	return rows[3] ? next > last + 1 : next === last + 1;
}

/** A count bracket as the encoding draws it, or its `[0]` no-indentation marker. */
const COUNT_BRACKET = "\\[(?:0|(?:[»·]\\d+)+)\\]";
/**
 * A row's leading indentation, after an optional line-number prefix; or, on an
 * unindented row, text that itself opens with a count bracket, bare or behind a
 * prefix-shaped run (`200|[·4]`, which reads like an encoded numbered row). That
 * text gets the `[0]` marker, so only the first bracket after the prefix reads
 * as indentation. Anchored on `\n` only: a `m`-flag `^` would also match after
 * `\r` and U+2028 inside a row.
 */
const rowIndent = (prefix: string) =>
	new RegExp(`(^|\\n)(${prefix})?(?:([ \\t]+)|(?=(?:${READ_ROW_PREFIX})?${COUNT_BRACKET}))`, "g");
/** Numbered rows: `N:`, `N|`, or a collapsed block's `N-M:` / `N-M|`. */
const READ_ROW_INDENT = rowIndent(READ_ROW_PREFIX);
/** Unnumbered reads (`:raw`, line numbers off): a leading `12:` is file content, not a prefix. */
const READ_LINE_INDENT = rowIndent("");
const READ_INDENT_RUN = /\t+| +/g;
const TOOL_RESULT_NOTE = toolResultNote.trim();

interface ReadFramePayload {
	/** Body rendered into frames, indentation drawn as count brackets. */
	body: string;
	/** Text beside the frames: the tool-result note, the bracket legend when used, then the lifted header. */
	note: string;
}

/**
 * Frames collapse whitespace, so draw each row's leading indentation as a count
 * bracket and lift the snapshot header out to text (see snapcompact-read-note.md).
 * A read recorded without row prefixes (`:raw`, plain) has no header to lift:
 * a leading `[path#TAG]`-shaped line is content.
 */
function encodeReadForFrames(text: string, rowPrefixes: boolean | undefined): ReadFramePayload {
	const header = rowPrefixes === false ? "" : (READ_HEADER.exec(text)?.[0] ?? "");
	const rest = text.slice(header.length);
	const body = rest.replace(
		isNumberedRead(header, rest, rowPrefixes) ? READ_ROW_INDENT : READ_LINE_INDENT,
		(_, lineStart: string, prefix = "", indent: string | undefined) =>
			`${lineStart}${prefix}${indent ? indentBracket(indent) : "[0]"}`,
	);
	const note = prompt.render(readNoteTemplate, {
		note: TOOL_RESULT_NOTE,
		header: header.trimEnd(),
		indented: body !== rest,
	});
	return { body, note };
}

/** `\t\t  ` → `[»2·2]`: one count per tab or space run. */
function indentBracket(indent: string): string {
	return `[${indent.replace(READ_INDENT_RUN, run => `${run[0] === "\t" ? "»" : "·"}${run.length}`)}]`;
}

/** Count image blocks in one message's content. */
function messageImageCount(message: { content?: unknown }): number {
	if (!Array.isArray(message.content)) return 0;
	let count = 0;
	for (const block of message.content as BlockViews) {
		if (block.type === "image") count++;
	}
	return count;
}

/** Image tokens must undercut text tokens by the margin to be worth rendering. */
function passesSavingsGate(frames: number, shape: snapcompact.Shape, textTokens: number): boolean {
	return frames * shape.frameTokenEstimate <= textTokens * SAVINGS_MARGIN;
}

interface SystemPromptImageTarget {
	scope: Exclude<SnapcompactSystemPromptMode, "none">;
	text: string;
	replacement: string[];
	userNote: string;
}

const CONTEXT_SECTION_PATTERNS = [
	/<repo-rules>\n[\s\S]*?\n<\/repo-rules>/g,
	/## Context\n<instructions>\n[\s\S]*?\n<\/instructions>/g,
] as const;

function replaceContextSections(block: string, extracted: string[]): string {
	let replaced = block;
	for (const pattern of CONTEXT_SECTION_PATTERNS) {
		replaced = replaced.replace(pattern, match => {
			extracted.push(match.trim());
			return contextStub.trim();
		});
	}
	return replaced;
}

function selectSystemPromptImageTarget(
	systemPrompt: readonly string[] | undefined,
	mode: SnapcompactSystemPromptMode,
): SystemPromptImageTarget | undefined {
	if (!systemPrompt?.length || mode === "none") return undefined;
	if (mode === "all") {
		const text = systemPrompt.join("\n\n");
		if (!text) return undefined;
		return {
			scope: "all",
			text,
			replacement: [systemStub],
			userNote: systemFramesNote,
		};
	}

	const extracted: string[] = [];
	const replacement = systemPrompt.map(block => replaceContextSections(block, extracted));
	const text = extracted.join("\n\n");
	if (!text) return undefined;
	return {
		scope: "agents-md",
		text,
		replacement,
		userNote: contextFramesNote,
	};
}

// ============================================================================
// Swap planning (shared by the live transform and /context estimation)
// ============================================================================

/** Tool-result swap candidate, in context order. */
export interface InlineToolResultCandidate {
	/** Stable identifier for rendering cache key and applying the swap. */
	id: string;
	/**
	 * Text tokens a swap takes off the wire: all joined text blocks (including
	 * text beside images), less what an imaged `read` keeps as text beyond the
	 * shared note (its header and bracket legend).
	 */
	textTokens: number;
	/** Frames needed to render the joined text (0 = empty or below floor). */
	frames: number;
	/** Error tool results must stay text-only for provider API validation. */
	isError?: boolean;
	/** The tool that produced it; `read` results are imaged only for readers that opt in. */
	toolName?: string;
	/** Images in the context up to and including this tool result (its own source images count). */
	imagesThrough: number;
}

export interface InlineSystemPromptCandidate {
	textTokens: number;
	frames: number;
	/** Images up to and including the first user message, which carries the frames. */
	imagesThrough: number;
}

export interface InlinePlanInput {
	options: SnapcompactInlineOptions;
	shape: snapcompact.Shape;
	/** Provider per-request image cap (`providerImageBudget`). */
	imageLimit: number;
	/** Images already in the context, across all messages. */
	existingImages: number;
	/** All tool results in context order, INCLUDING the most recent one. */
	toolResults: readonly InlineToolResultCandidate[];
	/** Selected prompt text; undefined when system-prompt imaging is off or empty. */
	systemPrompt: InlineSystemPromptCandidate | undefined;
	/** Whether a user message exists to carry the prompt frames. */
	hasUserMessage: boolean;
	/** The reader opted in to `read` results as frames (`snapcompact.readerImagesReadResults`). */
	imageReadResults: boolean;
}

export interface InlineSwapPlan {
	/** Tool results to swap, oldest first. */
	toolResults: Array<{ id: string; textTokens: number; frames: number }>;
	/** Set when the system prompt should swap to frames (claims frames before any tool result). */
	systemPrompt: InlineSystemPromptCandidate | undefined;
	/**
	 * Swaps the provider-cap backstop gave back to text. An earlier request may
	 * have sent them as frames, so the transform treats them as a history rewrite.
	 */
	retracted: {
		toolResults: Array<{ id: string; frames: number }>;
		systemPrompt: InlineSystemPromptCandidate | undefined;
	};
}

/**
 * Decide which content gets swapped for frames. Pure — the same rules drive
 * the provider-request transform and the /context savings estimate.
 *
 * Every decision depends only on content at or before the item it swaps, so
 * appending turns never changes how an already-sent item goes out. A change
 * there would void the provider prompt cache from that point on and
 * invalidate every later signed thinking block on providers that bind
 * thinking to the exact bytes before it (Anthropic `block_binding`). Hence:
 * - a tool result is decided the first time it ships, the most recent one
 *   included, and keeps that form while it stays in context;
 * - the system prompt, whose frames ride the first user message, claims its
 *   frames before any tool result;
 * - the only revision is the provider-cap backstop at the end, which the
 *   transform stamps as a history rewrite (`stampCapRetractions`).
 */
export function planInlineSwaps(input: InlinePlanInput): InlineSwapPlan {
	const { imageLimit } = input;

	let systemPrompt: InlineSystemPromptCandidate | undefined;
	const promptCandidate = input.systemPrompt;
	if (
		input.options.renderSystemPrompt !== "none" &&
		promptCandidate &&
		promptCandidate.frames > 0 &&
		promptCandidate.frames <= Math.min(imageLimit - promptCandidate.imagesThrough, MAX_SYSTEM_PROMPT_FRAMES) &&
		passesSavingsGate(promptCandidate.frames, input.shape, promptCandidate.textTokens) &&
		// No user message to carry the frames → leave the prompt as text.
		input.hasUserMessage
	) {
		systemPrompt = promptCandidate;
	}

	let frames = systemPrompt?.frames ?? 0;
	const toolResults: InlineSwapPlan["toolResults"] = [];
	if (input.options.renderToolResults) {
		// A candidate too big for the cap at its position is skipped, not a
		// stop — later smaller ones may fit.
		for (const candidate of input.toolResults) {
			if (candidate.isError) continue;
			// A reader that has not opted in edits from `read` output: frames lose
			// its exact indentation, so it stays text.
			if (candidate.toolName === "read" && !input.imageReadResults) continue;
			if (candidate.textTokens < MIN_TOOL_RESULT_TOKENS) continue;
			if (candidate.frames === 0 || candidate.imagesThrough + frames + candidate.frames > imageLimit) continue;
			if (!passesSavingsGate(candidate.frames, input.shape, candidate.textTokens)) continue;
			toolResults.push({ id: candidate.id, textTokens: candidate.textTokens, frames: candidate.frames });
			frames += candidate.frames;
		}
	}

	// Images that arrived after a swapped item (a pasted screenshot, an image
	// tool result) can push the request over the cap. Give back the newest
	// swaps first: reverting them to text keeps every real image, whereas the
	// downstream clamp would drop the oldest ones.
	const retracted: InlineSwapPlan["retracted"] = { toolResults: [], systemPrompt: undefined };
	while (input.existingImages + frames > imageLimit) {
		const swap = toolResults.pop();
		if (!swap) break;
		retracted.toolResults.push({ id: swap.id, frames: swap.frames });
		frames -= swap.frames;
	}
	if (systemPrompt && input.existingImages + frames > imageLimit) {
		retracted.systemPrompt = systemPrompt;
		systemPrompt = undefined;
	}

	return { toolResults, systemPrompt, retracted };
}

/**
 * Stamp the cap backstop's retractions as a history rewrite, the way pruning
 * stamps `prunedAt`. A retracted item may have gone out as frames in an
 * earlier request, and signed thinking after it is bound to those bytes; the
 * stamp makes `transformMessages` drop that thinking instead of the provider
 * rejecting it. Each item's rewrite time is the message that retracted it:
 * the backstop is replayed on every prefix of the history (the request that
 * message arrived in), newest swaps first, so an item that survived an
 * earlier crossing gets the later message that pushed it out, and thinking
 * minted while it was still frames is dropped. Items with no assistant turn
 * between them and that message were never followed by thinking in their
 * framed form and stay unstamped.
 */
function stampCapRetractions(
	messages: Message[],
	{
		original,
		plan,
		scan,
		imageLimit,
	}: { original: readonly Message[]; plan: InlineSwapPlan; scan: InlineContextScan; imageLimit: number },
): boolean {
	if (plan.retracted.toolResults.length === 0 && !plan.retracted.systemPrompt) return false;
	const toolResultIndex = new Map(scan.toolResults.map(built => [built.candidate.id, built.index]));
	// Every tool-result swap before the backstop ran, in context order. The
	// first pass decides each item from what precedes it, so a prefix holds
	// exactly the swaps at or before its end.
	const swaps: Array<{ index: number; frames: number; retracted: boolean }> = [];
	for (const swap of plan.toolResults) {
		const index = toolResultIndex.get(swap.id);
		if (index !== undefined) swaps.push({ index, frames: swap.frames, retracted: false });
	}
	for (const swap of plan.retracted.toolResults) {
		const index = toolResultIndex.get(swap.id);
		if (index !== undefined) swaps.push({ index, frames: swap.frames, retracted: true });
	}
	swaps.sort((a, b) => a.index - b.index);
	const prompt = plan.systemPrompt ?? plan.retracted.systemPrompt;
	const promptIndex = prompt ? scan.firstUserIndex : -1;

	// Message index of each retracted item → index of the message that retracted it.
	const retractedBy = new Map<number, number>();
	let images = 0;
	let next = 0;
	for (let end = 0; end < original.length; end++) {
		images += messageImageCount(original[end]);
		if (prompt && end === promptIndex) images += prompt.frames;
		while (next < swaps.length && swaps[next].index === end) images += swaps[next++].frames;
		let excess = images - imageLimit;
		for (let swap = next - 1; swap >= 0 && excess > 0; swap--) {
			excess -= swaps[swap].frames;
			if (swaps[swap].retracted && !retractedBy.has(swaps[swap].index)) retractedBy.set(swaps[swap].index, end);
		}
		const promptSent = promptIndex >= 0 && promptIndex <= end;
		if (excess > 0 && plan.retracted.systemPrompt && promptSent && !retractedBy.has(promptIndex)) {
			retractedBy.set(promptIndex, end);
		}
	}

	let stamped = false;
	for (const [index, by] of retractedBy) {
		if (!original.slice(index + 1, by).some(message => message.role === "assistant")) continue;
		const rewriteAt = original[by].timestamp;
		const message = messages[index];
		if (message.role === "toolResult") {
			messages[index] = { ...message, prunedAt: Math.max(message.prunedAt ?? rewriteAt, rewriteAt) };
			stamped = true;
		} else if (message.role === "user") {
			messages[index] = {
				...message,
				historyRewriteAt: Math.max(message.historyRewriteAt ?? rewriteAt, rewriteAt),
			};
			stamped = true;
		}
	}
	return stamped;
}

// ============================================================================
// /context savings estimation
// ============================================================================

/**
 * Minimal structural view of a history message — both pi-ai `Message`s (the
 * outgoing context) and agent-core `AgentMessage`s (the live session) satisfy
 * it, so the estimator can read session state without conversion.
 */
export interface InlineMessageView {
	role: string;
	toolCallId?: string;
	toolName?: string;
	content?: unknown;
	isError?: boolean;
	/** Tool metadata; a `read` result's `rowPrefixes` tells numbered rows from content. */
	details?: unknown;
}

interface BuiltInlineToolResultCandidate {
	candidate: InlineToolResultCandidate;
	/** What the frames render: the result's text, or an eligible `read`'s encoded body. */
	frameText: string;
	read?: ReadFramePayload;
}

/**
 * Build the exact same frame payload and planning candidate for estimation and
 * live transformation. Image blocks do not suppress co-resident text. Frames
 * are counted on the payload the swap renders; `textTokens` is the text the
 * swap removes, so the savings gate and journal see the net trade.
 */
function buildInlineToolResultCandidate(
	toolCallId: string,
	toolName: string | undefined,
	content: unknown,
	messageIsError: boolean | undefined,
	details: unknown,
	imagesThrough: number,
	tokenizer: Tokenizer,
	shape: snapcompact.Shape,
	imageReadResults: boolean,
): BuiltInlineToolResultCandidate {
	const blocks: BlockViews = Array.isArray(content) ? (content as BlockViews) : [];
	const textBlocks: string[] = [];
	let sourceImageIndex = 0;
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") {
			textBlocks.push(block.text);
		} else if (block.type === "image") {
			sourceImageIndex++;
			textBlocks.push(`[Source image ${sourceImageIndex} was attached here in the original tool result.]`);
		}
	}
	const text = textBlocks.join("\n");
	const textTokens = text.length > 0 ? tokenizer.countTokens(text) : 0;
	const isError = messageIsError === true;
	const readDetails = details as Pick<ReadToolDetails, "rowPrefixes" | "displayReadTargets"> | null | undefined;
	// A delimited multi-path read nests several headers and row modes under one
	// notice; no single encoding fits it, so it stays text.
	const composite = toolName === "read" && (readDetails?.displayReadTargets?.length ?? 0) > 0;
	const eligible = !isError && !composite && textTokens >= MIN_TOOL_RESULT_TOKENS;
	// The planner keeps `read` as text for a reader that has not opted in; skip encoding it.
	const read =
		eligible && toolName === "read" && imageReadResults
			? encodeReadForFrames(text, readDetails?.rowPrefixes)
			: undefined;
	const frameText = read?.body ?? text;
	// An imaged `read` keeps its header and legend beside the frames: not saved.
	const keptTokens = read ? Math.max(0, tokenizer.countTokens(read.note) - tokenizer.countTokens(toolResultNote)) : 0;
	return {
		candidate: {
			id: toolCallId,
			textTokens: textTokens - keptTokens,
			frames: eligible ? snapcompact.frames(frameText, { shape }) : 0,
			isError,
			...(toolName !== undefined && { toolName }),
			imagesThrough,
		},
		frameText,
		...(read && { read }),
	};
}

interface InlineContextScan {
	toolResults: Array<BuiltInlineToolResultCandidate & { index: number }>;
	totalImages: number;
	/** The system-prompt frame carrier, or -1. */
	firstUserIndex: number;
	/** Images through the first user message; all of them when there is none yet. */
	imagesThroughFirstUser: number;
}

/**
 * One pass over the outgoing history, stamping each tool result with the
 * images that precede it so the planner can decide from the prefix alone.
 */
function scanInlineContext(
	messages: readonly InlineMessageView[],
	renderToolResults: boolean,
	tokenizer: Tokenizer,
	shape: snapcompact.Shape,
	imageReadResults: boolean,
): InlineContextScan {
	const toolResults: InlineContextScan["toolResults"] = [];
	let images = 0;
	let firstUserIndex = -1;
	let imagesThroughFirstUser: number | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		images += messageImageCount(message);
		if (message.role === "user" && firstUserIndex < 0) {
			firstUserIndex = index;
			imagesThroughFirstUser = images;
		}
		if (!renderToolResults || message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		const built = buildInlineToolResultCandidate(
			message.toolCallId,
			message.toolName,
			message.content,
			message.isError,
			message.details,
			images,
			tokenizer,
			shape,
			imageReadResults,
		);
		toolResults.push({ ...built, index });
	}
	return {
		toolResults,
		totalImages: images,
		firstUserIndex,
		imagesThroughFirstUser: imagesThroughFirstUser ?? images,
	};
}

export interface SnapcompactSavingsEstimate {
	/** Frames only ship on models that accept image input. */
	visionCapable: boolean;
	/** Present iff system-prompt imaging is enabled. */
	systemPrompt?: {
		applied: boolean;
		/** Why the prompt stays text when `applied` is false. */
		reason?: "empty" | "margin" | "budget";
		textTokens: number;
		frames: number;
		/** Estimated billed tokens for the frames (0 when there are none). */
		imageTokens: number;
		savedTokens: number;
		scope: Exclude<SnapcompactSystemPromptMode, "none">;
	};
	/** Present iff tool-result imaging is enabled. */
	toolResults?: {
		/** Tool results currently in history. */
		total: number;
		swapped: number;
		/** Text tokens the swaps remove (an imaged `read` keeps its header and legend as text). */
		textTokens: number;
		frames: number;
		imageTokens: number;
		savedTokens: number;
	};
	/** Net estimated wire savings for the next request. */
	savedTokens: number;
}

/**
 * Estimate what `SnapcompactInlineTransformer.transform` would save on the
 * NEXT request, given the session's live system prompt and message history.
 *
 * Mirrors the transform exactly via `planInlineSwaps`, with one deliberate
 * difference: `hasUserMessage` is assumed true, because the request being
 * estimated is always triggered by a user prompt — even when the current
 * history is still empty.
 */
export function estimateInlineSavings(input: {
	options: SnapcompactInlineOptions;
	model: Model | undefined;
	systemPrompt: readonly string[];
	messages: readonly InlineMessageView[];
}): SnapcompactSavingsEstimate {
	const { options, model } = input;
	if (!model?.input.includes("image")) {
		return { visionCapable: false, savedTokens: 0 };
	}

	const shape = snapcompact.resolveShape(model, options.shape);
	const tokenizer = new Tokenizer(model);
	const imageLimit = snapcompact.providerImageBudget(model);
	const imageReadResults = snapcompact.readerImagesReadResults(model);
	const scan = scanInlineContext(input.messages, options.renderToolResults, tokenizer, shape, imageReadResults);
	const candidates = scan.toolResults.map(built => built.candidate);

	let systemPromptTarget: SystemPromptImageTarget | undefined;
	let systemPromptCandidate: InlineSystemPromptCandidate | undefined;
	if (options.renderSystemPrompt !== "none") {
		systemPromptTarget = selectSystemPromptImageTarget(input.systemPrompt, options.renderSystemPrompt);
		if (systemPromptTarget) {
			systemPromptCandidate = {
				textTokens: tokenizer.countTokens(systemPromptTarget.text),
				frames: snapcompact.frames(systemPromptTarget.text, { shape }),
				imagesThrough: scan.imagesThroughFirstUser,
			};
		}
	}

	const plan = planInlineSwaps({
		options,
		shape,
		imageLimit,
		existingImages: scan.totalImages,
		toolResults: candidates,
		systemPrompt: systemPromptCandidate,
		hasUserMessage: true,
		imageReadResults,
	});

	let savedTokens = 0;
	let systemPromptEstimate: SnapcompactSavingsEstimate["systemPrompt"];
	if (options.renderSystemPrompt !== "none") {
		const candidate = systemPromptCandidate ?? { textTokens: 0, frames: 0 };
		const applied = plan.systemPrompt !== undefined;
		const imageTokens = candidate.frames * shape.frameTokenEstimate;
		const saved = applied ? Math.max(0, candidate.textTokens - imageTokens) : 0;
		let reason: "empty" | "margin" | "budget" | undefined;
		if (!applied) {
			if (candidate.frames === 0) reason = "empty";
			else if (
				candidate.frames <= MAX_SYSTEM_PROMPT_FRAMES &&
				!passesSavingsGate(candidate.frames, shape, candidate.textTokens)
			)
				reason = "margin";
			else reason = "budget";
		}
		systemPromptEstimate = {
			applied,
			...(reason ? { reason } : {}),
			textTokens: candidate.textTokens,
			frames: candidate.frames,
			imageTokens,
			savedTokens: saved,
			scope: systemPromptTarget?.scope ?? options.renderSystemPrompt,
		};
		savedTokens += saved;
	}

	let toolResultsEstimate: SnapcompactSavingsEstimate["toolResults"];
	if (options.renderToolResults) {
		let textTokens = 0;
		let frames = 0;
		for (const swap of plan.toolResults) {
			textTokens += swap.textTokens;
			frames += swap.frames;
		}
		const imageTokens = frames * shape.frameTokenEstimate;
		const saved = Math.max(0, textTokens - imageTokens);
		toolResultsEstimate = {
			total: candidates.length,
			swapped: plan.toolResults.length,
			textTokens,
			frames,
			imageTokens,
			savedTokens: saved,
		};
		savedTokens += saved;
	}

	return {
		visionCapable: true,
		...(systemPromptEstimate ? { systemPrompt: systemPromptEstimate } : {}),
		...(toolResultsEstimate ? { toolResults: toolResultsEstimate } : {}),
		savedTokens,
	};
}

// ============================================================================
// Provider-request transform
// ============================================================================

interface FrameCacheEntry {
	hash: number | bigint;
	/** Serialized shape the frames were rendered with; a shape change re-renders. */
	shapeKey: string;
	frames: ImageContent[];
	/** Frame-sink generation the frames were minted under. */
	generation: number | undefined;
}

/**
 * Stateless with respect to the model (passed per call, so mid-session model
 * switches re-resolve shape and budget); stateful only for the render caches,
 * which live as long as the session's Agent. `options` is re-read at the start
 * of every {@link transform} call, so a live (getter-backed) view makes
 * settings changes apply on the next request.
 */
export class SnapcompactInlineTransformer {
	/** Rendered tool-result frames keyed by toolCallId. */
	#toolCache = new Map<string, FrameCacheEntry>();
	#systemCache?: FrameCacheEntry;

	constructor(
		private readonly options: SnapcompactInlineOptions,
		private readonly onToolResultSavings?: SnapcompactSavingsSink,
		private readonly frameSink?: SnapcompactFrameSink,
	) {}

	async transform(context: Context, model: Model): Promise<Context> {
		// One consistent snapshot per request, even if settings change mid-transform.
		const options: SnapcompactInlineOptions = {
			renderSystemPrompt: this.options.renderSystemPrompt,
			renderToolResults: this.options.renderToolResults,
			shape: this.options.shape,
		};
		if (!options.renderToolResults) this.#toolCache.clear();
		if (options.renderSystemPrompt === "none") this.#systemCache = undefined;
		if (!options.renderToolResults && options.renderSystemPrompt === "none") return context;
		// Vision gate: providers silently DROP images on text-only models —
		// rendering would lose the content entirely.
		if (!model.input.includes("image")) return context;

		const shape = snapcompact.resolveShape(model, options.shape);
		const shapeKey = JSON.stringify(shape);
		const tokenizer = new Tokenizer(model);
		const imageLimit = snapcompact.providerImageBudget(model);
		const messages = [...context.messages];

		// Tool-result candidates (in order) for the planner, plus the text/index
		// needed to apply swaps and the live ids for cache eviction.
		const imageReadResults = snapcompact.readerImagesReadResults(model);
		const scan = scanInlineContext(messages, options.renderToolResults, tokenizer, shape, imageReadResults);
		const targets = new Map(scan.toolResults.map(built => [built.candidate.id, built]));

		let systemPromptTarget: SystemPromptImageTarget | undefined;
		let systemPromptCandidate: InlineSystemPromptCandidate | undefined;
		if (options.renderSystemPrompt !== "none") {
			systemPromptTarget = selectSystemPromptImageTarget(context.systemPrompt, options.renderSystemPrompt);
			if (systemPromptTarget) {
				systemPromptCandidate = {
					textTokens: tokenizer.countTokens(systemPromptTarget.text),
					frames: snapcompact.frames(systemPromptTarget.text, { shape }),
					imagesThrough: scan.imagesThroughFirstUser,
				};
			}
		}

		const userIndex = scan.firstUserIndex;
		const plan = planInlineSwaps({
			options,
			shape,
			imageLimit,
			existingImages: scan.totalImages,
			toolResults: scan.toolResults.map(built => built.candidate),
			systemPrompt: systemPromptCandidate,
			hasUserMessage: userIndex >= 0,
			imageReadResults,
		});

		let changed = false;
		const savings: Array<{ toolCallId: string; savedTokens: number }> = [];
		for (const swap of plan.toolResults) {
			const target = targets.get(swap.id);
			if (!target) continue;
			const message = messages[target.index];
			if (message.role !== "toolResult") continue;
			const frames = await this.#framesFor(this.#toolCache, swap.id, target.frameText, shape, shapeKey);
			const note = target.read?.note ?? toolResultNote;
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: note }, ...frames];
			let sourceImageIndex = 0;
			for (const block of message.content) {
				if (block.type !== "image") continue;
				sourceImageIndex++;
				content.push({
					type: "text",
					text: `[Original source image ${sourceImageIndex}; corresponds to its marker in the compacted text.]`,
				});
				content.push(block);
			}
			messages[target.index] = { ...message, content };
			changed = true;
			savings.push({
				toolCallId: swap.id,
				savedTokens: Math.max(0, swap.textTokens - swap.frames * shape.frameTokenEstimate),
			});
		}
		if (savings.length > 0) this.onToolResultSavings?.(savings, model);
		if (options.renderToolResults) {
			// Drop cache entries for tool calls no longer in the context
			// (compacted away) so the cache stays bounded by live history.
			for (const key of this.#toolCache.keys()) {
				if (!targets.has(key)) this.#toolCache.delete(key);
			}
		}

		let systemPrompt = context.systemPrompt;
		if (plan.systemPrompt && userIndex >= 0 && systemPromptTarget) {
			const hash = Bun.hash(systemPromptTarget.text);
			let cached = this.#systemCache;
			const generation = this.frameSink?.generation;
			if (!cached || cached.hash !== hash || cached.shapeKey !== shapeKey || cached.generation !== generation) {
				cached = {
					hash,
					shapeKey,
					generation,
					frames:
						(await this.frameSink?.framesFor(systemPromptTarget.text, shape, MAX_SYSTEM_PROMPT_FRAMES)) ??
						(await snapcompact.renderMany(systemPromptTarget.text, {
							shape,
							maxFrames: MAX_SYSTEM_PROMPT_FRAMES,
						})),
				};
				this.#systemCache = cached;
			}
			const frames = cached.frames;
			const original = messages[userIndex] as UserMessage;
			const originalContent: (TextContent | ImageContent)[] =
				typeof original.content === "string" ? [{ type: "text", text: original.content }] : original.content;
			messages[userIndex] = {
				...original,
				content: [{ type: "text", text: systemPromptTarget.userNote }, ...frames, ...originalContent],
			};
			systemPrompt = systemPromptTarget.replacement;
			changed = true;
		}

		if (stampCapRetractions(messages, { original: context.messages, plan, scan, imageLimit })) changed = true;

		if (!changed) return context;
		return { ...context, systemPrompt, messages };
	}

	async #framesFor(
		cache: Map<string, FrameCacheEntry>,
		key: string,
		text: string,
		shape: snapcompact.Shape,
		shapeKey: string,
	): Promise<ImageContent[]> {
		const hash = Bun.hash(text);
		const generation = this.frameSink?.generation;
		const cached = cache.get(key);
		if (cached && cached.hash === hash && cached.shapeKey === shapeKey && cached.generation === generation) {
			return cached.frames;
		}
		// A frame sink defers rasterization until a provider actually fetches
		// the frame URL — the cache then holds tiny placeholders, not pixels.
		const frames = (await this.frameSink?.framesFor(text, shape)) ?? (await snapcompact.renderMany(text, { shape }));
		cache.set(key, { hash, shapeKey, frames, generation });
		return frames;
	}
}
