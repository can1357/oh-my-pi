import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, getSegmenter } from "@oh-my-pi/pi-tui";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { formatThinkingForDisplay, hasDisplayableThinking } from "../../utils/thinking-display";
import type { AssistantMessageComponent } from "../components/assistant-message";

export const STREAMING_REVEAL_FRAME_MS = 1000 / 30;
export const MIN_STEP = 3;
export const CATCHUP_FRAMES = 8;

type AssistantContentBlock = AssistantMessage["content"][number];
type DisplayThinkingContentBlock = Extract<AssistantContentBlock, { type: "thinking" }> & { rawThinking?: string };
/** The concrete streaming-reveal target is an {@link AssistantMessageComponent}; the
 *  Component intersection is what lets the reveal request component-scoped renders
 *  through {@link TUI.requestComponentRender} instead of forcing a full-tree walk. */
type StreamingRevealComponent = Pick<AssistantMessageComponent, "updateContent"> & Component;
type GraphemeSlicer = (index: number, text: string, units: number) => string;

type StreamingRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	getHideThinkingBlock(): boolean;
	getProseOnlyThinking(): boolean;
	/** Called after each reveal tick with the component whose subtree changed;
	 *  callers scope the render to that subtree (a full tree walk here at 30fps
	 *  costs 5% of CPU on its own and drives the Box/Container overhead that
	 *  cascades into another ~15% — see issue #4377). */
	requestRender(component: Component): void;
};

const graphemeCountCache = new LRUCache<string, number>({ max: 128 });

function countGraphemes(text: string): number {
	if (text.length === 0) return 0;
	const cached = graphemeCountCache.get(text);
	if (cached !== undefined) return cached;
	let count = 0;
	for (const _segment of getSegmenter().segment(text)) {
		count += 1;
	}
	graphemeCountCache.set(text, count);
	return count;
}

/** Count graphemes of `text` from code-unit offset `start`, also reporting the
 *  start offset of the final grapheme (where an append could extend a cluster). */
function countGraphemesFrom(text: string, start: number): { count: number; tailStart: number } {
	let count = 0;
	let tailStart = start;
	for (const seg of getSegmenter().segment(start === 0 ? text : text.slice(start))) {
		count += 1;
		tailStart = start + seg.index;
	}
	return { count, tailStart };
}
/** Segment `text` from code-unit offset `start`, walking up to `clusters`
 *  graphemes. Returns the code-unit END of the final cluster walked, its START
 *  (`lastStart`), and how many clusters were found (`count` may be less than
 *  `clusters` if the suffix is shorter than requested). */
function segmentFrom(text: string, start: number, clusters: number): { end: number; lastStart: number; count: number } {
	let count = 0;
	let lastStart = start;
	let end = start;
	for (const seg of getSegmenter().segment(start === 0 ? text : text.slice(start))) {
		count += 1;
		lastStart = start + seg.index;
		end = start + seg.index + seg.segment.length;
		if (count >= clusters) break;
	}
	return { end, lastStart, count };
}

/** Memoizes per-block grapheme counts across reveal ticks. Streaming blocks only
 *  grow by appending, and an append can only alter the final grapheme cluster of
 *  the previous text, so only the suffix from that cluster needs re-segmenting. */
export class BlockUnitCounter {
	#entries = new Map<number, { text: string; count: number; tailStart: number }>();
	#sliceEntries = new Map<number, { text: string; units: number; end: number; lastStart: number }>();

	count(index: number, text: string): number {
		const entry = this.#entries.get(index);
		if (entry !== undefined) {
			if (entry.text === text) return entry.count;
			if (entry.count > 0 && text.length > entry.text.length && text.startsWith(entry.text)) {
				const tail = countGraphemesFrom(text, entry.tailStart);
				const next = { text, count: entry.count - 1 + tail.count, tailStart: tail.tailStart };
				this.#entries.set(index, next);
				return next.count;
			}
		}
		const full = countGraphemesFrom(text, 0);
		this.#entries.set(index, { text, count: full.count, tailStart: full.tailStart });
		return full.count;
	}

	reset(): void {
		this.#entries.clear();
		this.#sliceEntries.clear();
	}
	/** Slice `text` to its first `units` graphemes. Memoized across reveal ticks:
	 *  streaming blocks grow only by appending and the reveal target advances
	 *  monotonically, so a previously sliced prefix is reused and only the suffix
	 *  from the boundary cluster is re-segmented. Only an exact (text, units) hit
	 *  skips segmentation entirely — an append can extend the boundary cluster, so
	 *  the incremental path still re-segments from that cluster's start. */
	slice(index: number, text: string, units: number): string {
		if (units <= 0 || text.length === 0) return "";
		const entry = this.#sliceEntries.get(index);
		if (entry !== undefined && entry.text === text && entry.units === units) {
			return entry.end >= text.length ? text : text.slice(0, entry.end);
		}
		if (entry !== undefined && (entry.text === text || text.startsWith(entry.text)) && units >= entry.units) {
			const extra = units - entry.units + 1;
			const seg = segmentFrom(text, entry.lastStart, extra);
			this.#sliceEntries.set(index, { text, units, end: seg.end, lastStart: seg.lastStart });
			return seg.end >= text.length ? text : text.slice(0, seg.end);
		}
		const seg = segmentFrom(text, 0, units);
		this.#sliceEntries.set(index, { text, units, end: seg.end, lastStart: seg.lastStart });
		return seg.end >= text.length ? text : text.slice(0, seg.end);
	}
}

function sliceGraphemes(text: string, units: number): string {
	if (units <= 0 || text.length === 0) return "";
	let count = 0;
	for (const { index, segment } of getSegmenter().segment(text)) {
		count += 1;
		if (count >= units) {
			const end = index + segment.length;
			return end >= text.length ? text : text.slice(0, end);
		}
	}
	return text;
}

export function visibleUnits(message: AssistantMessage, hideThinking: boolean, proseOnly = true): number {
	let total = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			total += countGraphemes(block.text);
		} else if (block.type === "thinking" && !hideThinking) {
			const formatted = formatThinkingForDisplay(block.thinking, proseOnly);
			if (hasDisplayableThinking(block.thinking, formatted)) {
				total += countGraphemes(formatted);
			}
		}
	}
	return total;
}

function revealTextBlock(
	block: Extract<AssistantContentBlock, { type: "text" }>,
	remaining: number,
	units: number,
	index: number,
	sliceOf: GraphemeSlicer,
): AssistantContentBlock {
	if (remaining <= 0) return block.text.length === 0 ? block : { ...block, text: "" };
	if (remaining >= units) return block;
	return { ...block, text: sliceOf(index, block.text, remaining) };
}

function revealThinkingBlock(
	block: Extract<AssistantContentBlock, { type: "thinking" }>,
	remaining: number,
	units: number,
	index: number,
	sliceOf: GraphemeSlicer,
): AssistantContentBlock {
	if (remaining <= 0) return block.thinking.length === 0 ? block : { ...block, thinking: "" };
	if (remaining >= units) return block;
	return { ...block, thinking: sliceOf(index, block.thinking, remaining) };
}

export function buildDisplayMessage(
	target: AssistantMessage,
	revealed: number,
	hideThinking: boolean,
	proseOnly = true,
	countOf: (index: number, text: string) => number = (_index, text) => countGraphemes(text),
	sliceOf: GraphemeSlicer = (_index, text, units) => sliceGraphemes(text, units),
): AssistantMessage {
	let remaining = Math.max(0, Math.floor(revealed));
	const content: AssistantContentBlock[] = [];
	for (let i = 0; i < target.content.length; i++) {
		const block = target.content[i]!;
		if (block.type === "text") {
			const units = countOf(i, block.text);
			content.push(revealTextBlock(block, remaining, units, i, sliceOf));
			remaining = Math.max(0, remaining - units);
		} else if (block.type === "thinking" && !hideThinking) {
			const formatted = formatThinkingForDisplay(block.thinking, proseOnly);
			if (hasDisplayableThinking(block.thinking, formatted)) {
				const units = countOf(i, formatted);
				const displayBlock: DisplayThinkingContentBlock = {
					...block,
					thinking: formatted,
					rawThinking: block.thinking,
				};
				content.push(revealThinkingBlock(displayBlock, remaining, units, i, sliceOf));
				remaining = Math.max(0, remaining - units);
			} else {
				content.push(block);
			}
		} else {
			content.push(block);
		}
	}
	return { ...target, content };
}

export function nextStep(backlog: number): number {
	return Math.max(MIN_STEP, Math.ceil(Math.max(0, backlog) / CATCHUP_FRAMES));
}

export class StreamingRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #getHideThinkingBlock: () => boolean;
	readonly #getProseOnlyThinking: () => boolean;
	readonly #requestRender: (component: Component) => void;
	#target: AssistantMessage | undefined;
	#component: StreamingRevealComponent | undefined;
	#timer: NodeJS.Timeout | undefined;
	#revealed = 0;
	#targetDirty = false;
	#hideThinkingBlock = false;
	#proseOnlyThinking = true;
	#smoothStreaming = true;
	readonly #unitCounter = new BlockUnitCounter();
	readonly #countOf = (index: number, text: string): number => this.#unitCounter.count(index, text);
	readonly #sliceOf = (index: number, text: string, units: number): string =>
		this.#unitCounter.slice(index, text, units);

	constructor(options: StreamingRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#getHideThinkingBlock = options.getHideThinkingBlock;
		this.#getProseOnlyThinking = options.getProseOnlyThinking;
		this.#requestRender = options.requestRender;
	}
	#build(target: AssistantMessage, revealed: number): AssistantMessage {
		return buildDisplayMessage(
			target,
			revealed,
			this.#hideThinkingBlock,
			this.#proseOnlyThinking,
			this.#countOf,
			this.#sliceOf,
		);
	}

	begin(component: StreamingRevealComponent, message: AssistantMessage): void {
		this.stop();
		this.#component = component;
		this.#target = message;
		this.#revealed = 0;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		this.#smoothStreaming = this.#getSmoothStreaming();
		if (!this.#smoothStreaming) {
			const total = this.#visibleUnits(message);
			component.updateContent(this.#build(message, total), { transient: true });
			return;
		}
		const total = this.#visibleUnits(message);
		if (message.content.some(block => block.type === "toolCall")) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealed = total;
			component.updateContent(this.#build(message, this.#revealed), {
				transient: true,
			});
			return;
		}
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	setTarget(message: AssistantMessage): void {
		this.#target = message;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		this.#smoothStreaming = this.#getSmoothStreaming();
		if (!this.#component) return;
		if (!this.#smoothStreaming) {
			const total = this.#visibleUnits(message);
			this.#revealed = total;
			this.#targetDirty = false;
			this.#stopTimer();
			this.#component.updateContent(this.#build(message, total), { transient: true });
			return;
		}
		const total = this.#visibleUnits(message);
		if (message.content.some(block => block.type === "toolCall")) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealed = total;
			this.#stopTimer();
			this.#component.updateContent(this.#build(message, this.#revealed), {
				transient: true,
			});
			return;
		}
		if (this.#revealed > total) {
			this.#revealed = total;
		}
		if (this.#revealed < total) {
			// Behind: the running reveal tick renders the newest target at the
			// cadence; skip the redundant per-delta render (the reveal cadence
			// bounds markdown work even when the provider deltas arrive faster).
			this.#targetDirty = false;
			this.#syncTimer(total);
			return;
		}
		// Caught up: defer the render to the next reveal tick so a burst of
		// post-catch-up deltas coalesces into one render instead of one per
		// token. The tick always renders the latest target — nothing is lost.
		if (!this.#timer) this.#startTimer();
		this.#targetDirty = true;
	}

	stop(): void {
		this.#stopTimer();
		this.#target = undefined;
		this.#component = undefined;
		this.#revealed = 0;
		this.#targetDirty = false;
		this.#unitCounter.reset();
	}

	/**
	 * Re-read cached visibility flags (hideThinkingBlock, proseOnlyThinking)
	 * and re-render the current target. Called when the thinking level changes
	 * mid-stream so the reveal controller doesn't keep rendering with stale values.
	 */
	resyncVisibility(): void {
		if (!this.#target || !this.#component) return;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		// Recalculate visible units — hiding thinking blocks may reduce the total,
		// and the reveal position may now exceed it.
		const total = this.#visibleUnits(this.#target);
		this.#revealed = Math.min(this.#revealed, total);
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	/** Total reveal units of `message`, memoized per block across ticks. */
	#visibleUnits(message: AssistantMessage): number {
		let total = 0;
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i]!;
			if (block.type === "text") {
				total += this.#unitCounter.count(i, block.text);
			} else if (block.type === "thinking" && !this.#hideThinkingBlock) {
				const formatted = formatThinkingForDisplay(block.thinking, this.#proseOnlyThinking);
				if (hasDisplayableThinking(block.thinking, formatted)) {
					total += this.#unitCounter.count(i, formatted);
				}
			}
		}
		return total;
	}

	#renderCurrent(): void {
		if (!this.#target || !this.#component) return;
		// Every controller render is an in-flight streaming snapshot, even when
		// smooth reveal has temporarily caught up to the current target. The
		// message_end handler performs the only stable non-transient render.
		this.#component.updateContent(this.#build(this.#target, this.#revealed), { transient: true });
	}

	#syncTimer(total = this.#target ? this.#visibleUnits(this.#target) : 0): void {
		if (!this.#target || !this.#component || this.#revealed >= total) {
			this.#stopTimer();
			return;
		}
		this.#startTimer();
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick();
		}, STREAMING_REVEAL_FRAME_MS);
		this.#timer.unref?.();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#tick(): void {
		const target = this.#target;
		const component = this.#component;
		if (!target || !component) {
			this.stop();
			return;
		}
		const total = this.#visibleUnits(target);
		if (this.#revealed >= total) {
			if (this.#targetDirty) {
				this.#targetDirty = false;
				this.#revealed = total;
				this.#renderCurrent();
				this.#requestRender(component);
			}
			this.#stopTimer();
			return;
		}
		this.#revealed = Math.min(total, this.#revealed + nextStep(total - this.#revealed));
		component.updateContent(this.#build(target, this.#revealed), {
			transient: true,
		});
		this.#requestRender(component);
		if (this.#revealed >= total) {
			this.#stopTimer();
		}
	}
}
