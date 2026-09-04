/**
 * Snapcompact inline imaging: per-request transform that swaps the system
 * prompt, loaded context-file instructions, and/or large historical tool
 * results for dense PNG frames on vision-capable models.
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
import type { Context, ImageContent, Model, TextContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { SnapcompactFrameSink } from "../blob-broker/service";
import contextFramesNote from "../prompts/system/snapcompact-context-frames-note.md" with { type: "text" };
import contextStub from "../prompts/system/snapcompact-context-stub.md" with { type: "text" };
import systemFramesNote from "../prompts/system/snapcompact-system-frames-note.md" with { type: "text" };
import systemStub from "../prompts/system/snapcompact-system-stub.md" with { type: "text" };
import toolResultNote from "../prompts/system/snapcompact-toolresult-note.md" with { type: "text" };

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

// Per-provider image-count budgets live in @oh-my-pi/snapcompact
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

/** Count image blocks already present across message contents. */
function countMessageImages(messages: readonly { content?: unknown }[]): number {
	let count = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as BlockViews) {
			if (block.type === "image") count++;
		}
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
	/** Token count of all joined text blocks, including text beside images. */
	textTokens: number;
	/** Frames needed to render the joined text (0 = empty or below floor). */
	frames: number;
	/** Error tool results must stay text-only for provider API validation. */
	isError?: boolean;
}

export interface InlineSystemPromptCandidate {
	textTokens: number;
	frames: number;
}

export interface InlinePlanInput {
	options: SnapcompactInlineOptions;
	shape: snapcompact.Shape;
	/** Provider image-count budget minus images already present in the context. */
	budget: number;
	/** All tool results in context order, INCLUDING the most recent one. */
	toolResults: readonly InlineToolResultCandidate[];
	/** Selected prompt text; undefined when system-prompt imaging is off or empty. */
	systemPrompt: InlineSystemPromptCandidate | undefined;
	/** Whether a user message exists to carry the prompt frames. */
	hasUserMessage: boolean;
}

export interface InlineSwapPlan {
	/** Tool results to swap, oldest first. */
	toolResults: Array<{ id: string; textTokens: number; frames: number }>;
	/** Set when the system prompt should swap to frames (uses leftover budget). */
	systemPrompt: InlineSystemPromptCandidate | undefined;
}

/**
 * Decide which content gets swapped for frames. Pure — the same rules drive
 * the provider-request transform and the /context savings estimate.
 */
export function planInlineSwaps(input: InlinePlanInput): InlineSwapPlan {
	let budget = input.budget;

	const toolResults: InlineSwapPlan["toolResults"] = [];
	if (input.options.renderToolResults) {
		// Oldest-first for cache-stable bytes; skip the LAST tool result so the
		// freshest output stays crisp text. A candidate too big for the
		// remaining budget is skipped, not a stop — later smaller ones may fit.
		for (let k = 0; k < input.toolResults.length - 1 && budget > 0; k++) {
			const candidate = input.toolResults[k];
			if (candidate.isError) continue;
			if (candidate.textTokens < MIN_TOOL_RESULT_TOKENS) continue;
			if (candidate.frames === 0 || candidate.frames > budget) continue;
			if (!passesSavingsGate(candidate.frames, input.shape, candidate.textTokens)) continue;
			toolResults.push({ id: candidate.id, textTokens: candidate.textTokens, frames: candidate.frames });
			budget -= candidate.frames;
		}
	}

	let systemPrompt: InlineSystemPromptCandidate | undefined;
	if (
		input.options.renderSystemPrompt !== "none" &&
		input.systemPrompt &&
		budget > 0 &&
		input.systemPrompt.frames > 0 &&
		input.systemPrompt.frames <= Math.min(budget, MAX_SYSTEM_PROMPT_FRAMES) &&
		passesSavingsGate(input.systemPrompt.frames, input.shape, input.systemPrompt.textTokens) &&
		// No user message to carry the frames → leave the prompt as text.
		input.hasUserMessage
	) {
		systemPrompt = input.systemPrompt;
	}

	return { toolResults, systemPrompt };
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
	content?: unknown;
	isError?: boolean;
}

interface BuiltInlineToolResultCandidate {
	candidate: InlineToolResultCandidate;
	text: string;
}

/**
 * Build the exact same text payload and planning candidate for estimation and
 * live transformation. Image blocks do not suppress co-resident text.
 */
function buildInlineToolResultCandidate(
	toolCallId: string,
	content: unknown,
	messageIsError: boolean | undefined,
	tokenizer: Tokenizer,
	shape: snapcompact.Shape,
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
	return {
		candidate: {
			id: toolCallId,
			textTokens,
			frames: !isError && textTokens >= MIN_TOOL_RESULT_TOKENS ? snapcompact.frames(text, { shape }) : 0,
			isError,
		},
		text,
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
		/** Text tokens of the swapped results only. */
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
	const existingImages = countMessageImages(input.messages);
	const budget = snapcompact.providerImageBudget(model.provider) - existingImages;

	const candidates: InlineToolResultCandidate[] = [];
	if (options.renderToolResults) {
		for (const message of input.messages) {
			if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
			const built = buildInlineToolResultCandidate(
				message.toolCallId,
				message.content,
				message.isError,
				tokenizer,
				shape,
			);
			candidates.push(built.candidate);
		}
	}

	let systemPromptTarget: SystemPromptImageTarget | undefined;
	let systemPromptCandidate: InlineSystemPromptCandidate | undefined;
	if (options.renderSystemPrompt !== "none") {
		systemPromptTarget = selectSystemPromptImageTarget(input.systemPrompt, options.renderSystemPrompt);
		if (systemPromptTarget) {
			systemPromptCandidate = {
				textTokens: tokenizer.countTokens(systemPromptTarget.text),
				frames: snapcompact.frames(systemPromptTarget.text, { shape }),
			};
		}
	}

	const plan = planInlineSwaps({
		options,
		shape,
		budget,
		toolResults: candidates,
		systemPrompt: systemPromptCandidate,
		hasUserMessage: true,
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
			const leftover = budget - plan.toolResults.reduce((sum, swap) => sum + swap.frames, 0);
			if (candidate.frames === 0) reason = "empty";
			else if (candidate.frames > Math.min(leftover, MAX_SYSTEM_PROMPT_FRAMES)) reason = "budget";
			else reason = "margin";
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
	frames: ImageContent[];
}

/**
 * Stateless with respect to the model (passed per call, so mid-session model
 * switches re-resolve shape and budget); stateful only for the render caches,
 * which live as long as the session's Agent.
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
		// Vision gate: providers silently DROP images on text-only models —
		// rendering would lose the content entirely.
		if (!model.input.includes("image")) return context;

		const shape = snapcompact.resolveShape(model, this.options.shape);
		const tokenizer = new Tokenizer(model);
		const budget = snapcompact.providerImageBudget(model.provider) - countMessageImages(context.messages);
		if (budget <= 0) return context;

		const messages = [...context.messages];

		// Collect tool-result candidates (in order) for the planner, plus the
		// text/index needed to apply swaps and the live ids for cache eviction.
		const candidates: InlineToolResultCandidate[] = [];
		const targets = new Map<string, { index: number; message: ToolResultMessage; text: string }>();
		const liveToolCallIds = new Set<string>();
		if (this.options.renderToolResults) {
			for (let i = 0; i < messages.length; i++) {
				const message = messages[i];
				if (message.role !== "toolResult") continue;
				liveToolCallIds.add(message.toolCallId);
				const built = buildInlineToolResultCandidate(
					message.toolCallId,
					message.content,
					message.isError,
					tokenizer,
					shape,
				);
				candidates.push(built.candidate);
				targets.set(message.toolCallId, { index: i, message, text: built.text });
			}
		}

		let systemPromptTarget: SystemPromptImageTarget | undefined;
		let systemPromptCandidate: InlineSystemPromptCandidate | undefined;
		if (this.options.renderSystemPrompt !== "none") {
			systemPromptTarget = selectSystemPromptImageTarget(context.systemPrompt, this.options.renderSystemPrompt);
			if (systemPromptTarget) {
				systemPromptCandidate = {
					textTokens: tokenizer.countTokens(systemPromptTarget.text),
					frames: snapcompact.frames(systemPromptTarget.text, { shape }),
				};
			}
		}

		const userIndex = messages.findIndex(message => message.role === "user");
		const plan = planInlineSwaps({
			options: this.options,
			shape,
			budget,
			toolResults: candidates,
			systemPrompt: systemPromptCandidate,
			hasUserMessage: userIndex >= 0,
		});

		let changed = false;
		const savings: Array<{ toolCallId: string; savedTokens: number }> = [];
		for (const swap of plan.toolResults) {
			const target = targets.get(swap.id);
			if (!target) continue;
			const frames = await this.#framesFor(this.#toolCache, swap.id, target.text, shape);
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: toolResultNote }, ...frames];
			let sourceImageIndex = 0;
			for (const block of target.message.content) {
				if (block.type !== "image") continue;
				sourceImageIndex++;
				content.push({
					type: "text",
					text: `[Original source image ${sourceImageIndex}; corresponds to its marker in the compacted text.]`,
				});
				content.push(block);
			}
			messages[target.index] = { ...target.message, content };
			changed = true;
			savings.push({
				toolCallId: swap.id,
				savedTokens: Math.max(0, swap.textTokens - swap.frames * shape.frameTokenEstimate),
			});
		}
		if (savings.length > 0) this.onToolResultSavings?.(savings, model);
		if (this.options.renderToolResults) {
			// Drop cache entries for tool calls no longer in the context
			// (compacted away) so the cache stays bounded by live history.
			for (const key of this.#toolCache.keys()) {
				if (!liveToolCallIds.has(key)) this.#toolCache.delete(key);
			}
		}

		let systemPrompt = context.systemPrompt;
		if (plan.systemPrompt && userIndex >= 0 && systemPromptTarget) {
			const hash = Bun.hash(systemPromptTarget.text);
			let cached = this.#systemCache;
			if (!cached || cached.hash !== hash) {
				cached = {
					hash,
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

		if (!changed) return context;
		return { ...context, systemPrompt, messages };
	}

	async #framesFor(
		cache: Map<string, FrameCacheEntry>,
		key: string,
		text: string,
		shape: snapcompact.Shape,
	): Promise<ImageContent[]> {
		const hash = Bun.hash(text);
		const cached = cache.get(key);
		if (cached && cached.hash === hash) return cached.frames;
		// A frame sink defers rasterization until a provider actually fetches
		// the frame URL — the cache then holds tiny placeholders, not pixels.
		const frames = (await this.frameSink?.framesFor(text, shape)) ?? (await snapcompact.renderMany(text, { shape }));
		cache.set(key, { hash, frames });
		return frames;
	}
}
