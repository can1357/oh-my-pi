/**
 * Context-reducing surgical compaction ("shake").
 *
 * `shake` drops heavy content out of the live context mechanically:
 * tool-result text and large fenced/XML blocks are replaced with short
 * placeholders while non-text tool-result content is preserved. This module
 * is the pure layer — region detection and in-place
 * mutation only. Artifact offload, persistence, and provider-session teardown
 * are orchestrated by the caller (`AgentSession.shake`).
 *
 * Layering mirrors `pruning.ts`: no I/O here.
 */

import type { ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "./entries";
import { invalidateMessageCache } from "./message-cache";
import {
	collectToolCallsById,
	getToolResultMessage,
	isArtifactRecoveryToolResult,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "./tool-protection";

export interface ShakeConfig {
	/** Keep the most recent context tokens (across all entries) intact. */
	protectTokens: number;
	/** Only shake when total estimated savings meets this threshold. */
	minSavings: number;
	/** Tool-result protection matchers. String entries protect every result from that tool; predicates may inspect the paired tool call. */
	protectedTools: ProtectedToolMatcher[];
	/** Minimum token size for a fenced/XML block to be eligible. */
	fenceMinTokens: number;
	/**
	 * Compaction boundary (`firstKeptEntryId` of the latest compaction). Entries
	 * before it are summarized away and never sent, so they are skipped — shaking
	 * them only churns persisted history. Undefined = no compaction (whole branch
	 * is sent). Note: shake still elides the warm cached prefix at/after the
	 * boundary — that is its job as a compaction-class reducer.
	 */
	keepBoundaryId?: string;
}

/** Auto-shake config: protects the live tail, conservative thresholds. */
export const DEFAULT_SHAKE_CONFIG: ShakeConfig = {
	protectTokens: 16_000,
	minSavings: 4_000,
	protectedTools: ["skill", isSkillReadToolResult, isArtifactRecoveryToolResult],
	fenceMinTokens: 400,
};

/**
 * Manual `/shake`: aggressive — no savings threshold and drops eligible
 * regions across history, artifact recovery reads included (the user's full
 * escape hatch). Still keeps a small recent tail so it cannot strip the tool
 * results the agent is currently working from (#7776).
 */
export const AGGRESSIVE_SHAKE_CONFIG: ShakeConfig = {
	protectTokens: 4_000,
	minSavings: 0,
	protectedTools: ["skill", isSkillReadToolResult],
	fenceMinTokens: 400,
};

/** Compaction dead-end rescue: aggressive reach, but artifact recovery reads stay protected. */
export const RESCUE_SHAKE_CONFIG: ShakeConfig = {
	...AGGRESSIVE_SHAKE_CONFIG,
	// Rescue must be able to elide the newest oversized result even inside the
	// manual preset's recent-tail window (#7776) — a dead-end recovery that
	// cannot drop its blocker is not a recovery.
	protectTokens: 0,
	protectedTools: [...AGGRESSIVE_SHAKE_CONFIG.protectedTools, isArtifactRecoveryToolResult],
};

/** Rough token cost of a placeholder line; used only for the savings gate. */
const PLACEHOLDER_TOKEN_ESTIMATE = 16;

/** A located eligible region. */
export interface ToolResultShakeRegion {
	kind: "toolResult";
	entry: SessionMessageEntry;
	/** Estimated tokens in the removable text only; retained images are excluded. */
	tokens: number;
	originalText: string;
	/** Per-block lengths and image offsets when a tool result had multiple text blocks or preceding images. */
	textSlots?: Array<{ imageOffset: number; length: number }>;
	/** Human label for the offload doc (tool name). */
	label: string;
}

export interface BlockShakeRegion {
	kind: "block";
	entry: SessionMessageEntry | CustomMessageEntry;
	/** Index into the content array, or -1 for string-form content. */
	blockIndex: number;
	/** Character offsets into the target text (start inclusive, end exclusive). */
	start: number;
	end: number;
	tokens: number;
	originalText: string;
	/** Human label for the offload doc (role / customType). */
	label: string;
}

export type ShakeRegion = ToolResultShakeRegion | BlockShakeRegion;

// Mirror prompt.ts top-level XML detection. Lowercase tag names only —
// conservative by design (uppercase / mixed-case tags are ignored).
const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;
const CLOSING_XML = /^<\/([a-z_-]+)>$/;

function toolResultText(
	message: ToolResultMessage,
	tokenizer: Tokenizer,
): { originalText: string; tokens: number; textSlots?: Array<{ imageOffset: number; length: number }> } | undefined {
	const fragments: string[] = [];
	const slots: Array<{ imageOffset: number; length: number }> = [];
	let imageOffset = 0;
	for (const block of message.content) {
		if (block.type === "image") {
			imageOffset++;
		} else if (block.type === "text" && block.text.length > 0) {
			fragments.push(block.text);
			slots.push({ imageOffset, length: block.text.length });
		}
	}
	if (fragments.length === 0) return undefined;
	const needsSlots = slots.length > 1 || (slots[0]?.imageOffset ?? 0) > 0;
	return {
		originalText: fragments.join("\n"),
		tokens: tokenizer.countTokens(fragments),
		...(needsSlots ? { textSlots: slots } : {}),
	};
}

/** Estimate the token contribution of an entry for the protect-recent window. */
function entryTokens(entry: SessionEntry, tokenizer: Tokenizer): number {
	if (entry.type === "message") {
		return tokenizer.countMessage(entry.message);
	}
	if (entry.type === "custom_message") {
		const content = entry.content;
		if (typeof content === "string") return content.length === 0 ? 0 : tokenizer.countTokens(content);
		const fragments = content.filter((block): block is TextContent => block.type === "text").map(block => block.text);
		return fragments.length === 0 ? 0 : tokenizer.countTokens(fragments);
	}
	return 0;
}

/**
 * Locate fenced code blocks and top-level XML element spans inside `text`.
 * Returns character ranges `[start, end)` covering the full block (including the
 * opening and closing fence/tag lines, excluding the trailing newline).
 *
 * Conservative: unterminated fences/tags yield no range, and XML detection is
 * suppressed inside fences. Mirrors the toggling logic in
 * `@oh-my-pi/pi-utils` `format()` so behavior stays aligned with prompt rendering.
 */
function scanTextForBlockRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	let inFence = false;
	let fenceStart = -1;
	const tagStack: string[] = [];
	let xmlStart = -1;

	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i !== text.length && text[i] !== "\n") continue;
		const line = text.slice(lineStart, i);
		const lineEnd = i; // offset of the newline (or end of text); excludes the "\n"
		const trimmedStart = line.trimStart();

		const isFenceLine = trimmedStart.startsWith("```") || trimmedStart.startsWith("~~~");
		if (isFenceLine) {
			if (!inFence) {
				inFence = true;
				fenceStart = lineStart;
			} else {
				inFence = false;
				ranges.push({ start: fenceStart, end: lineEnd });
				fenceStart = -1;
			}
			lineStart = i + 1;
			continue;
		}

		if (!inFence) {
			const isOpeningXml = line.length === trimmedStart.length && OPENING_XML.test(trimmedStart);
			if (isOpeningXml) {
				const match = OPENING_XML.exec(trimmedStart);
				if (match) {
					if (tagStack.length === 0) xmlStart = lineStart;
					tagStack.push(match[1]);
				}
			} else {
				const closingMatch = CLOSING_XML.exec(trimmedStart);
				if (closingMatch && tagStack.length > 0 && tagStack[tagStack.length - 1] === closingMatch[1]) {
					tagStack.pop();
					if (tagStack.length === 0 && xmlStart >= 0) {
						ranges.push({ start: xmlStart, end: lineEnd });
						xmlStart = -1;
					}
				}
			}
		}

		lineStart = i + 1;
	}

	return mergeRanges(ranges);
}

/**
 * Sort ascending by start and drop any range that overlaps an already-kept
 * range. Because fence/XML spans are always properly nested (XML detection is
 * suppressed inside fences), overlap means containment — keeping the
 * earlier-starting range keeps the outermost span.
 */
function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
	if (ranges.length <= 1) return ranges;
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const kept: Array<{ start: number; end: number }> = [];
	let lastEnd = -1;
	for (const range of sorted) {
		if (range.start < lastEnd) continue;
		kept.push(range);
		lastEnd = range.end;
	}
	return kept;
}

function pushBlockRegions(
	entry: SessionMessageEntry | CustomMessageEntry,
	blockIndex: number,
	text: string,
	tokenizer: Tokenizer,
	config: ShakeConfig,
	label: string,
	out: ShakeRegion[],
): void {
	for (const range of scanTextForBlockRanges(text)) {
		const slice = text.slice(range.start, range.end);
		if (slice.length === 0) continue;
		const tokens = tokenizer.countTokens(slice);
		if (tokens < config.fenceMinTokens) continue;
		out.push({
			kind: "block",
			entry,
			blockIndex,
			start: range.start,
			end: range.end,
			tokens,
			originalText: slice,
			label,
		});
	}
}

function collectBlockRegions(
	entry: SessionMessageEntry | CustomMessageEntry,
	tokenizer: Tokenizer,
	config: ShakeConfig,
	out: ShakeRegion[],
): void {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "assistant") {
			for (let bi = 0; bi < message.content.length; bi++) {
				const block = message.content[bi];
				if (block.type === "text") pushBlockRegions(entry, bi, block.text, tokenizer, config, "assistant", out);
			}
			return;
		}
		if (message.role === "user" || message.role === "developer") {
			scanContentBlocks(entry, message.content, tokenizer, config, message.role, out);
		}
		return;
	}
	// custom_message
	scanContentBlocks(entry, entry.content, tokenizer, config, entry.customType, out);
}

function scanContentBlocks(
	entry: SessionMessageEntry | CustomMessageEntry,
	content: string | Array<{ type: string; text?: string }>,
	tokenizer: Tokenizer,
	config: ShakeConfig,
	label: string,
	out: ShakeRegion[],
): void {
	if (typeof content === "string") {
		pushBlockRegions(entry, -1, content, tokenizer, config, label, out);
		return;
	}
	for (let bi = 0; bi < content.length; bi++) {
		const block = content[bi];
		if (block.type === "text" && typeof block.text === "string") {
			pushBlockRegions(entry, bi, block.text, tokenizer, config, label, out);
		}
	}
}

/**
 * Pure detection: locate every eligible shake region on a branch.
 *
 * Walks the protect-recent window (most recent `protectTokens` of context is
 * kept intact), collects the text from eligible tool-result messages
 * (honoring `protectedTools` and skipping already-pruned results) and large
 * fenced/XML blocks inside user/developer/assistant/custom messages.
 * Contextually useless tool results bypass the protect window — there is
 * nothing recent
 * worth keeping in them. Returns regions in document order.
 *
 * `toolCall` blocks are never touched (tool-call/result pairing is preserved)
 * and regions never span a message boundary. When the combined estimated
 * savings is below `minSavings`, returns `[]` (no-op).
 */
export function collectShakeRegions(entries: SessionEntry[], tokenizer: Tokenizer, config: ShakeConfig): ShakeRegion[] {
	const n = entries.length;
	if (n === 0) return [];

	// Tokens of all entries strictly more recent than index i.
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const accumulatedAfter = new Array<number>(n);
	let acc = 0;
	for (let i = n - 1; i >= 0; i--) {
		accumulatedAfter[i] = acc;
		acc += entryTokens(entries[i], tokenizer);
	}

	const toolCallsById = collectToolCallsById(entries);

	// Entries before the compaction boundary are summarized away and never sent —
	// shaking them only churns persisted history (no prompt/cache effect).
	const boundaryIndex =
		config.keepBoundaryId === undefined
			? 0
			: Math.max(
					0,
					entries.findIndex(entry => entry.id === config.keepBoundaryId),
				);

	const regions: ShakeRegion[] = [];
	for (let i = 0; i < n; i++) {
		const entry = entries[i];
		if (i < boundaryIndex) continue;
		const toolResult = getToolResultMessage(entry);
		// Useless-flagged results carry no information once consumed; they are
		// eligible even inside the protect-recent window.
		const uselessResult = toolResult !== undefined && toolResult.useless === true && toolResult.isError !== true;
		if (!uselessResult && accumulatedAfter[i] < config.protectTokens) continue;
		if (toolResult) {
			if (toolResult.prunedAt !== undefined) continue;
			if (isProtectedToolResult(toolResult, toolCallsById.get(toolResult.toolCallId), config.protectedTools))
				continue;
			const text = toolResultText(toolResult, tokenizer);
			if (!text) continue;
			regions.push({
				kind: "toolResult",
				entry: entry as SessionMessageEntry,
				tokens: text.tokens,
				originalText: text.originalText,
				...(text.textSlots ? { textSlots: text.textSlots } : {}),
				label: toolResult.toolName,
			});
			continue;
		}

		if (entry.type === "message" || entry.type === "custom_message") {
			collectBlockRegions(entry as SessionMessageEntry | CustomMessageEntry, tokenizer, config, regions);
		}
	}

	let savings = 0;
	for (const region of regions) savings += Math.max(0, region.tokens - PLACEHOLDER_TOKEN_ESTIMATE);
	if (savings < config.minSavings) return [];

	return regions;
}

interface TextSlot {
	read(): string;
	write(value: string): void;
}

function getBlockTextSlot(entry: SessionMessageEntry | CustomMessageEntry, blockIndex: number): TextSlot | undefined {
	if (entry.type === "message") {
		const message = entry.message as { content: unknown };
		if (blockIndex === -1) {
			if (typeof message.content !== "string") return undefined;
			return {
				read: () => message.content as string,
				write: value => {
					message.content = value;
				},
			};
		}
		if (!Array.isArray(message.content)) return undefined;
		const block = message.content[blockIndex] as TextContent | undefined;
		if (block?.type !== "text") return undefined;
		return {
			read: () => block.text,
			write: value => {
				block.text = value;
			},
		};
	}
	// custom_message
	if (blockIndex === -1) {
		if (typeof entry.content !== "string") return undefined;
		return {
			read: () => entry.content as string,
			write: value => {
				entry.content = value;
			},
		};
	}
	if (!Array.isArray(entry.content)) return undefined;
	const block = entry.content[blockIndex] as TextContent | undefined;
	if (block?.type !== "text") return undefined;
	return {
		read: () => block.text,
		write: value => {
			block.text = value;
		},
	};
}

export interface ShakenTextSlot {
	/** Number of image blocks that preceded this text block in the original content. */
	imageOffset: number;
	block: TextContent;
}

export interface ParsedShakeArtifactRegion {
	text: string;
	slots: ShakenTextSlot[];
}

const shakenToolResultSlots = new WeakMap<ToolResultMessage, ShakenTextSlot[]>();
const restoredToolResultCache = new WeakMap<
	ToolResultMessage,
	{ content: ToolResultMessage["content"]; restored: ToolResultMessage }
>();

const SHAKE_ARTIFACT_PLACEHOLDER_RE =
	/^\[shaken ~\d+ tokens — recover: artifact:\/\/([A-Za-z0-9_-]+) \(region (\d+)\)\]$/;

export interface ShakeArtifactRegionRef {
	artifactId: string;
	/** 1-based region number inside the shake artifact. */
	region: number;
}

export function parseShakeArtifactPlaceholder(text: string): ShakeArtifactRegionRef | undefined {
	const match = SHAKE_ARTIFACT_PLACEHOLDER_RE.exec(text.trim());
	if (!match) return undefined;
	const region = Number.parseInt(match[2]!, 10);
	if (!Number.isFinite(region) || region < 1) return undefined;
	return { artifactId: match[1]!, region };
}

/** Concatenate original regions into the persisted `.shake.log` artifact body. */
export function formatShakeArtifactText(regions: readonly ShakeRegion[]): string {
	const parts: string[] = [];
	for (let i = 0; i < regions.length; i++) {
		const region = regions[i]!;
		const slotsMeta =
			region.kind === "toolResult" && region.textSlots && region.textSlots.length > 0
				? `, blocks=${region.textSlots.map(s => `${s.imageOffset}:${s.length}`).join("+")}`
				: "";
		parts.push(
			`### region ${i + 1} (${region.label}, ~${region.tokens} tok, ${region.originalText.length} chars${slotsMeta})`,
			"",
			region.originalText,
			"",
		);
	}
	return parts.join("\n");
}

function parseShakenTextSlots(text: string, blocksSpec: string | undefined): ShakenTextSlot[] {
	if (!blocksSpec) return [{ imageOffset: 0, block: { type: "text", text } }];
	const slots: ShakenTextSlot[] = [];
	let cursor = 0;
	for (const part of blocksSpec.split("+")) {
		const colon = part.indexOf(":");
		if (colon <= 0) return [{ imageOffset: 0, block: { type: "text", text } }];
		const imageOffset = Number.parseInt(part.slice(0, colon), 10);
		const length = Number.parseInt(part.slice(colon + 1), 10);
		if (!Number.isFinite(imageOffset) || imageOffset < 0 || !Number.isFinite(length) || length < 0) {
			return [{ imageOffset: 0, block: { type: "text", text } }];
		}
		if (cursor + length > text.length) {
			return [{ imageOffset: 0, block: { type: "text", text } }];
		}
		slots.push({ imageOffset, block: { type: "text", text: text.slice(cursor, cursor + length) } });
		cursor += length + 1;
	}
	return slots.length > 0 ? slots : [{ imageOffset: 0, block: { type: "text", text } }];
}

/**
 * Parse a persisted `.shake.log` artifact body into its 1-based region entries
 * (including exact length-delimited bodies and multimodal text-block slots).
 */
export function parseShakeArtifactEntries(artifactText: string): Map<number, ParsedShakeArtifactRegion> {
	const entries = new Map<number, ParsedShakeArtifactRegion>();
	const headerRe = /(?<=^|\n\n)### region (\d+) \([^\n]*, ~\d+ tok(?:, (\d+) chars(?:, blocks=([0-9:+]+))?)?\)\n\n/g;
	const matches: Array<{
		region: number;
		separatorStart: number;
		bodyStart: number;
		charLen?: number;
		blocksSpec?: string;
	}> = [];
	let match: RegExpExecArray | null;
	while ((match = headerRe.exec(artifactText)) !== null) {
		const region = Number.parseInt(match[1]!, 10);
		if (region !== matches.length + 1) continue;
		const matchIndex = match.index;
		const bodyStart = matchIndex + match[0].length;
		const parsedLen = match[2] !== undefined ? Number.parseInt(match[2], 10) : undefined;
		const charLen = parsedLen !== undefined && Number.isFinite(parsedLen) && parsedLen >= 0 ? parsedLen : undefined;
		matches.push({
			region,
			separatorStart: matchIndex === 0 ? 0 : matchIndex - 2,
			bodyStart,
			charLen,
			blocksSpec: match[3],
		});
		if (charLen !== undefined) {
			headerRe.lastIndex = Math.min(artifactText.length, bodyStart + charLen);
		}
	}
	for (let i = 0; i < matches.length; i++) {
		const current = matches[i]!;
		const next = matches[i + 1];
		const bodyEnd =
			current.charLen !== undefined
				? Math.min(artifactText.length, current.bodyStart + current.charLen)
				: next
					? next.separatorStart
					: artifactText.endsWith("\n")
						? artifactText.length - 1
						: artifactText.length;
		const text = artifactText.slice(current.bodyStart, bodyEnd);
		entries.set(current.region, {
			text,
			slots: parseShakenTextSlots(text, current.blocksSpec),
		});
	}
	return entries;
}

/**
 * Parse a persisted `.shake.log` artifact body back into its 1-based region map.
 */
export function parseShakeArtifactRegions(artifactText: string): Map<number, string> {
	const regions = new Map<number, string>();
	for (const [region, entry] of parseShakeArtifactEntries(artifactText)) {
		regions.set(region, entry.text);
	}
	return regions;
}

export function isToolResultMessage(value: unknown): value is ToolResultMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"role" in value &&
		value.role === "toolResult" &&
		"toolCallId" in value &&
		typeof value.toolCallId === "string" &&
		"toolName" in value &&
		typeof value.toolName === "string" &&
		"content" in value &&
		Array.isArray(value.content) &&
		"isError" in value &&
		typeof value.isError === "boolean" &&
		"timestamp" in value &&
		typeof value.timestamp === "number"
	);
}

/**
 * Restore the original display text of a tool result elided by `shake` while
 * leaving the stored/LLM-facing message untouched.
 */
export function restoreShakenToolResultMessage(
	message: ToolResultMessage,
	resolveArtifactRegion?: (ref: ShakeArtifactRegionRef) => string | ParsedShakeArtifactRegion | undefined,
): ToolResultMessage {
	if (message.prunedAt === undefined) return message;
	let slots = shakenToolResultSlots.get(message);
	if (!slots && resolveArtifactRegion) {
		const textBlock = message.content.find((block): block is TextContent => block.type === "text");
		const ref = textBlock ? parseShakeArtifactPlaceholder(textBlock.text) : undefined;
		if (ref) {
			const recovered = resolveArtifactRegion(ref);
			if (recovered !== undefined) {
				slots =
					typeof recovered === "string"
						? [{ imageOffset: 0, block: { type: "text", text: recovered } }]
						: recovered.slots;
				shakenToolResultSlots.set(message, slots);
			}
		}
	}
	if (!slots || slots.length === 0) return message;
	const cached = restoredToolResultCache.get(message);
	if (cached && cached.content === message.content) return cached.restored;
	const images = message.content.filter((block): block is ImageContent => block.type === "image");
	const content: (TextContent | ImageContent)[] = [];
	if (images.length === 0) {
		for (const slot of slots) content.push(slot.block);
	} else {
		for (let imgIndex = 0; imgIndex <= images.length; imgIndex++) {
			for (const slot of slots) {
				if (imgIndex < images.length ? slot.imageOffset === imgIndex : slot.imageOffset >= images.length) {
					content.push(slot.block);
				}
			}
			if (imgIndex < images.length) {
				content.push(images[imgIndex]!);
			}
		}
	}
	const restored: ToolResultMessage = { ...message, content };
	shakenToolResultSlots.set(restored, slots);
	restoredToolResultCache.set(message, { content: message.content, restored });
	restoredToolResultCache.set(restored, { content: restored.content, restored });
	return restored;
}

/**
 * Pure mutation: replace a single region's content in place.
 *
 * Tool-result: replaces its first non-empty text block with the placeholder,
 * removes its other text blocks, preserves every non-text block, and stamps
 * `prunedAt`. Block: splices `replacement` (`replacementTokens` long) over
 * `[start, end)` of the target text block, and on an assistant turn adds the
 * tokens removed to `elidedOutputTokens`. When several block regions share one
 * text block they MUST be applied highest-start-first so earlier offsets stay
 * valid — use {@link applyShakeRegions}, which orders them correctly.
 */
export function applyShakeRegion(region: ShakeRegion, replacement: string, replacementTokens: number): void {
	if (region.kind === "toolResult") {
		const message = region.entry.message as ToolResultMessage;
		const replacementIndex = message.content.findIndex(block => block.type === "text" && block.text.length > 0);
		if (replacementIndex < 0) return;
		if (!shakenToolResultSlots.has(message)) {
			const slots: ShakenTextSlot[] = [];
			let imageOffset = 0;
			for (const block of message.content) {
				if (block.type === "image") {
					imageOffset++;
				} else if (block.type === "text") {
					slots.push({ imageOffset, block: { ...block } });
				}
			}
			shakenToolResultSlots.set(message, slots);
		}
		const kept: typeof message.content = [];
		for (let index = 0; index < message.content.length; index++) {
			const block = message.content[index];
			if (block.type !== "text") kept.push(block);
			else if (index === replacementIndex) kept.push({ type: "text", text: replacement });
		}
		message.content = kept;
		message.prunedAt = Date.now();
		invalidateMessageCache(message as AgentMessage);
		return;
	}
	const slot = getBlockTextSlot(region.entry, region.blockIndex);
	if (!slot) return;
	const text = slot.read();
	slot.write(text.slice(0, region.start) + replacement + text.slice(region.end));
	// Message entries keep a stable `entry.message` identity across context
	// rebuilds, so an in-place block rewrite must drop its cached estimate/convert.
	// Custom-message entries are re-materialized into a fresh AgentMessage on every
	// buildSessionContext, so they carry no stable cached identity to invalidate.
	if (region.entry.type !== "message") return;
	const message = region.entry.message;
	// `usage.output` keeps billing the removed text; the persisted tally lets
	// every later count of a replayed turn take it off again.
	if (message.role === "assistant") {
		message.elidedOutputTokens = (message.elidedOutputTokens ?? 0) + Math.max(0, region.tokens - replacementTokens);
	}
	invalidateMessageCache(message);
}

/**
 * Apply many regions at once. Block regions are applied highest-start-first so
 * that splicing one region never shifts the offsets of another in the same text
 * block; tool-result regions are independent.
 */
export function applyShakeRegions(
	items: Array<{ region: ShakeRegion; replacement: string; replacementTokens: number }>,
): void {
	const ordered = [...items].sort((a, b) => {
		const aStart = a.region.kind === "block" ? a.region.start : -1;
		const bStart = b.region.kind === "block" ? b.region.start : -1;
		return bStart - aStart;
	});
	for (const { region, replacement, replacementTokens } of ordered)
		applyShakeRegion(region, replacement, replacementTokens);
}
