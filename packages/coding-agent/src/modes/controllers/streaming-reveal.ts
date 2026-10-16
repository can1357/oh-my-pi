import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { presentNarrationAsAnswer } from "@oh-my-pi/pi-ai/utils/narration";
import { type Component, getSegmenter } from "@oh-my-pi/pi-tui";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { formatThinkingForDisplay, hasDisplayableThinking } from "@oh-my-pi/pi-tui/chat/thinking-display";
import type { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";

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

/** Render `target` truncated to the revealed units. `revealed` is either the
 *  aggregate count spent from the first visible block, or a per-block budget
 *  array (aligned with `target.content`) when the reveal keeps a budget per
 *  block — a block hidden mid-reveal and shown again resumes at its own count
 *  instead of being credited the units a later block already spent (#15336). */
export function buildDisplayMessage(
	target: AssistantMessage,
	revealed: number | readonly number[],
	hideThinking: boolean,
	proseOnly = true,
	countOf: (index: number, text: string) => number = (_index, text) => countGraphemes(text),
	sliceOf: GraphemeSlicer = (_index, text, units) => sliceGraphemes(text, units),
): AssistantMessage {
	const perBlock = typeof revealed === "number" ? undefined : revealed;
	let remaining = typeof revealed === "number" ? Math.max(0, Math.floor(revealed)) : 0;
	const content: AssistantContentBlock[] = [];
	for (let i = 0; i < target.content.length; i++) {
		const block = target.content[i]!;
		const budget = perBlock === undefined ? remaining : Math.max(0, Math.floor(perBlock[i] ?? 0));
		if (block.type === "text") {
			const units = countOf(i, block.text);
			content.push(revealTextBlock(block, budget, units, i, sliceOf));
			if (perBlock === undefined) remaining = Math.max(0, remaining - units);
		} else if (block.type === "thinking" && !hideThinking) {
			const formatted = formatThinkingForDisplay(block.thinking, proseOnly);
			if (hasDisplayableThinking(block.thinking, formatted)) {
				const units = countOf(i, formatted);
				const displayBlock: DisplayThinkingContentBlock = {
					...block,
					thinking: formatted,
					rawThinking: block.thinking,
				};
				content.push(revealThinkingBlock(displayBlock, budget, units, i, sliceOf));
				if (perBlock === undefined) remaining = Math.max(0, remaining - units);
			} else {
				content.push(block);
			}
		} else {
			content.push(block);
		}
	}
	return { ...target, content };
}

/** A leading block as snapped at the tool-call boundary: the live object plus
 *  its own-property values at snap time (all primitives). */
type SnappedBlock = { block: AssistantContentBlock; fields: [string, unknown][] };

/** Record the live blocks and their primitive fields, or undefined when a block
 *  carries a nested object (a later in-place edit to it would be invisible to
 *  a field-identity check, so those snaps compare by value only). */
function snapBlockFields(content: AssistantMessage["content"]): SnappedBlock[] | undefined {
	const snapped: SnappedBlock[] = [];
	for (const block of content) {
		const fields = Object.entries(block);
		for (const [, value] of fields) {
			if (typeof value === "object" && value !== null) return undefined;
		}
		snapped.push({ block, fields });
	}
	return snapped;
}

/** Whether `content` holds the very blocks snapped, each with every field still
 *  `===` its snapped value. Strings are immutable, so an unchanged field is
 *  the same reference and the check is O(fields); an in-place rewrite
 *  (`block.text = …`) swaps the reference and fails it. A `true` proves the
 *  content equals the snap-time clone; a `false` proves nothing. */
function unchangedSinceSnap(snapped: SnappedBlock[], content: AssistantMessage["content"]): boolean {
	if (snapped.length !== content.length) return false;
	for (let i = 0; i < snapped.length; i++) {
		const { block, fields } = snapped[i]!;
		if (content[i] !== block || Object.keys(block).length !== fields.length) return false;
		for (const [key, value] of fields) {
			if (Reflect.get(block, key) !== value) return false;
		}
	}
	return true;
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
	// Revealed units per content block index, in transcript order. A per-block
	// budget rather than one aggregate count: a block hidden mid-reveal keeps
	// its own units (see `#hiddenBlockSpend`), so showing it again restores the
	// prefix the user watched WITHOUT the units a later block already earned —
	// collapsing both into the scalar credited their sum to the leading block,
	// which blanked the revealed answer behind it while the unseen reasoning
	// jumped forward (#15336). Streaming messages only append, so an index keeps
	// its block until the message is replaced (begin → stop resets it).
	#blockRevealed: number[] = [];
	#targetDirty = false;
	// Immutable deep clone of the leading content snapped at the tool-call
	// boundary. Kept independent of the live message so an in-place provider
	// rewrite of a previously emitted block (e.g. OpenAI Responses replacing
	// streamed text with authoritative terminal content) is still detected —
	// aliasing the live array would make the equality check compare it to itself.
	#snappedToolBoundaryContent: AssistantMessage["content"] | undefined;
	// Live blocks + field values recorded with the clone: while the leading
	// content is frozen (every flush of a tool-arg stream) they prove equality
	// in O(blocks) without walking the text; any mismatch defers to the clone.
	#snappedToolBoundaryBlocks: SnappedBlock[] | undefined;
	// Reveal units a block had earned while visible, kept while it is hidden.
	// Keyed by block index: streaming messages only append, so a hidden block
	// keeps its slot until the message is replaced (begin → stop clears it).
	// Without it a hide/show round trip loses the reveal-shaped prefix and the
	// show pass credits the whole regenerated block.
	#hiddenBlockSpend = new Map<number, { spent: number; before: number }>();
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
	#build(target: AssistantMessage): AssistantMessage {
		return buildDisplayMessage(
			target,
			this.#blockRevealed,
			this.#hideThinkingBlock,
			this.#proseOnlyThinking,
			this.#countOf,
			this.#sliceOf,
		);
	}

	/** Aggregate revealed units: the sum of the per-block budgets. A block the
	 *  fresh flags hide has no visible units, so its budget stays 0 and the
	 *  aggregate is measured against the visible layout only. */
	#revealedTotal(): number {
		let total = 0;
		for (const units of this.#blockRevealed) total += units;
		return total;
	}

	/** Grow the per-block budgets to the live content length (a new block
	 *  starts unrevealed) and drop budgets past it, then clamp every budget to
	 *  the block's current units so a shrinking block cannot stay over-drawn. */
	#alignBlocks(message: AssistantMessage): void {
		const live = message.content.length;
		if (this.#blockRevealed.length > live) this.#blockRevealed.length = live;
		for (let i = this.#blockRevealed.length; i < live; i++) this.#blockRevealed.push(0);
		for (let i = 0; i < live; i++) {
			const units = this.#blockUnits(message.content[i]!, this.#hideThinkingBlock, this.#proseOnlyThinking, i);
			if (this.#blockRevealed[i]! > units) this.#blockRevealed[i] = units;
		}
	}

	/** Credit every block its full visible budget: the boundary snap and the
	 *  no-smoothing path both finalize the leading segment whole. */
	#revealWhole(message: AssistantMessage): void {
		this.#alignBlocks(message);
		for (let i = 0; i < message.content.length; i++) {
			this.#blockRevealed[i] = this.#blockUnits(
				message.content[i]!,
				this.#hideThinkingBlock,
				this.#proseOnlyThinking,
				i,
			);
		}
	}

	/** Spend `units` on the first blocks that still owe reveal units, in
	 *  transcript order. The frontier walks forward exactly like the single
	 *  aggregate count did; a block that kept its own budget across a hide/show
	 *  round trip resumes where it stopped instead of being handed a later
	 *  block's units. */
	#advance(message: AssistantMessage, units: number): void {
		let budget = units;
		for (let i = 0; i < message.content.length && budget > 0; i++) {
			const size = this.#blockUnits(message.content[i]!, this.#hideThinkingBlock, this.#proseOnlyThinking, i);
			const granted = this.#blockRevealed[i] ?? 0;
			if (granted >= size) continue;
			const credit = Math.min(size - granted, budget);
			this.#blockRevealed[i] = granted + credit;
			budget -= credit;
		}
	}

	begin(component: StreamingRevealComponent, message: AssistantMessage, hasToolCalls: boolean): void {
		this.stop();
		this.#component = component;
		// Reveal counts narration as answer text, matching how the component renders it.
		message = presentNarrationAsAnswer(message);
		this.#target = message;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		this.#smoothStreaming = this.#getSmoothStreaming();
		if (!this.#smoothStreaming) {
			this.#revealWhole(message);
			component.updateContent(this.#build(message), { transient: true });
			return;
		}
		const total = this.#visibleUnits(message);
		if (hasToolCalls) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealWhole(message);
			component.updateContent(this.#build(message), { transient: true });
			this.#snapToolBoundary(message.content);
			return;
		}
		this.#alignBlocks(message);
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	setTarget(message: AssistantMessage, hasToolCalls: boolean): void {
		message = presentNarrationAsAnswer(message);
		this.#target = message;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		this.#smoothStreaming = this.#getSmoothStreaming();
		this.#alignBlocks(message);
		if (!this.#component) return;
		if (!this.#smoothStreaming) {
			// Switching to non-smooth streaming finalizes the leading segment whole
			// here, so the spend a hidden block saved during smooth reveal is spent
			// with it — keeping it armed would replay a stale partial prefix on the
			// next show pass over the committed whole block and strand the
			// remaining reasoning (#15336).
			this.#hiddenBlockSpend.clear();
			this.#revealWhole(message);
			this.#targetDirty = false;
			this.#stopTimer();
			this.#component.updateContent(this.#build(message), { transient: true });
			return;
		}
		const total = this.#visibleUnits(message);
		if (hasToolCalls) {
			let alreadySnapped = false;
			if (this.#revealedTotal() === total && this.#snappedToolBoundaryContent !== undefined) {
				const blocks = this.#snappedToolBoundaryBlocks;
				if (blocks !== undefined && unchangedSinceSnap(blocks, message.content)) {
					alreadySnapped = true;
				} else if (Bun.deepEquals(this.#snappedToolBoundaryContent, message.content)) {
					alreadySnapped = true;
					// Equal by value, not by reference (e.g. a block object was
					// replaced): re-anchor the fast check on the live blocks.
					this.#snappedToolBoundaryBlocks = snapBlockFields(message.content);
				}
			}
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			// The leading segment is committed whole here, so the spend a hidden
			// block saved for a later show pass is spent with it — restoring that
			// partial prefix afterwards would render less than the committed copy
			// above a running tool card and strand the remaining reasoning (#15336).
			this.#hiddenBlockSpend.clear();
			this.#revealWhole(message);
			this.#targetDirty = false;
			this.#stopTimer();
			if (alreadySnapped) return;
			this.#component.updateContent(this.#build(message), {
				transient: true,
			});
			this.#snapToolBoundary(message.content);
			return;
		}
		this.#snappedToolBoundaryContent = undefined;
		this.#snappedToolBoundaryBlocks = undefined;
		const revealed = this.#revealedTotal();
		if (revealed < total) {
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
		this.#blockRevealed = [];
		this.#targetDirty = false;
		this.#hiddenBlockSpend.clear();
		this.#snappedToolBoundaryContent = undefined;
		this.#snappedToolBoundaryBlocks = undefined;
		this.#unitCounter.reset();
	}

	#snapToolBoundary(content: AssistantMessage["content"]): void {
		this.#snappedToolBoundaryContent = structuredClone(content);
		this.#snappedToolBoundaryBlocks = snapBlockFields(content);
	}

	/**
	 * Re-read cached visibility flags (hideThinkingBlock, proseOnlyThinking)
	 * and re-render the current target. Called when the thinking level changes
	 * mid-stream so the reveal controller doesn't keep rendering with stale values.
	 *
	 * A visibility toggle changes which blocks are visible and how many units
	 * each one has, which would move every later block by the units the toggle
	 * adds or drops. Re-anchor per block instead: the revealed amount of every
	 * block that stays visible is preserved, so a hide/show after the reveal
	 * reached the answer leaves the answer where it was instead of clamping the
	 * whole budget to the text total (answer snapped to 100%) or spending the
	 * answer's units on the freshly shown thinking prefix (answer re-hidden).
	 * Each block is re-credited from its OWN saved units, so one block's budget
	 * can never fund another block's — the two are summed into one count and
	 * both were spent off the leading block, blanking the answer behind it
	 * (#15336). A block the old layout consumed whole stays whole under its new
	 * size, so a prose toggle that expands or shrinks it does not hand the
	 * difference to the block after it; a partially revealed one keeps its
	 * position, clamped to its new length. A block that just became visible is
	 * snapped whole only while the old budget still covers it — crediting one
	 * past that frontier hands units the reveal never earned to the blocks
	 * before it, so the visible answer jumps forward or completes — unless it
	 * was hidden mid-reveal, in which case the reveal it had earned is restored
	 * so a hide/show round trip keeps the prefix the user already watched
	 * stream out.
	 */
	resyncVisibility(): void {
		if (!this.#target || !this.#component) return;
		const target = this.#target;
		const hideBefore = this.#hideThinkingBlock;
		const proseBefore = this.#proseOnlyThinking;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		// Per-block unit counts under the old and the fresh flags, plus the
		// reveal each block had already earned under the old layout.
		const sizes: { before: number; after: number; spent: number }[] = [];
		for (let i = 0; i < target.content.length; i++) {
			const before = this.#blockUnits(target.content[i]!, hideBefore, proseBefore, i);
			const after = this.#blockUnits(target.content[i]!, this.#hideThinkingBlock, this.#proseOnlyThinking, i);
			sizes.push({ before, after, spent: Math.min(this.#blockRevealed[i] ?? 0, before) });
		}
		// First block that still owed units under the old layout: the reveal
		// frontier. A block at or past it may be credited whole; one before it
		// was never reached, and crediting it whole hands its units to the blocks
		// before it — the visible answer jumps forward or completes. No such
		// block means the old budget covered the whole old layout.
		let frontier = -1;
		for (let i = 0; i < sizes.length; i++) {
			const { before, spent } = sizes[i]!;
			if (before > 0 && spent < before) {
				frontier = i;
				break;
			}
		}
		// Walk the blocks, re-crediting each one from its own saved spend.
		const blocks: number[] = [];
		for (let i = 0; i < sizes.length; i++) {
			const { before, after, spent } = sizes[i]!;
			if (before > 0 && after > 0) {
				// Fully consumed under the old size: consume it whole under the
				// new one, so the prose-mode expansion of a fence is not funded by
				// the answer's saved units. Partially revealed: keep the position,
				// clamped to the new length.
				blocks.push(spent >= before ? after : Math.min(spent, after));
			} else if (before === 0 && after > 0) {
				// Newly visible. A block the hide pass took away keeps the reveal
				// it had earned: restoring that spend keeps the user's watched
				// prefix instead of crediting the whole regenerated block, which
				// would flash the remaining reasoning to completion (and, with a
				// later unrevealed text block, restart the reveal from zero).
				const latent = this.#hiddenBlockSpend.get(i);
				if (latent !== undefined) {
					this.#hiddenBlockSpend.delete(i);
					blocks.push(latent.spent >= latent.before ? after : Math.min(latent.spent, after));
				} else if (frontier < 0 || frontier >= i) {
					// Never revealed while hidden: snap it whole only if the old
					// frontier lies at or past it, or the old budget covered the
					// whole old layout.
					blocks.push(after);
				} else {
					blocks.push(0);
				}
			} else if (before > 0) {
				// Just hidden: retain the reveal it had earned for a later show
				// pass, which restores the shaped prefix instead of restarting
				// the block from zero.
				this.#hiddenBlockSpend.set(i, { spent, before });
				blocks.push(0);
			} else {
				blocks.push(0);
			}
		}
		this.#blockRevealed = blocks;
		const total = this.#visibleUnits(target);
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	/** Visible units of one block under an explicit visibility pair. */
	#blockUnits(block: AssistantContentBlock, hideThinking: boolean, proseOnly: boolean, index: number): number {
		if (block.type === "text") return this.#unitCounter.count(index, block.text);
		if (block.type !== "thinking" || hideThinking) return 0;
		const formatted = formatThinkingForDisplay(block.thinking, proseOnly);
		if (!hasDisplayableThinking(block.thinking, formatted)) return 0;
		return this.#unitCounter.count(index, formatted);
	}

	/** Total reveal units of `message`, memoized per block across ticks. */
	#visibleUnits(message: AssistantMessage): number {
		let total = 0;
		for (let i = 0; i < message.content.length; i++) {
			total += this.#blockUnits(message.content[i]!, this.#hideThinkingBlock, this.#proseOnlyThinking, i);
		}
		return total;
	}

	#renderCurrent(): void {
		if (!this.#target || !this.#component) return;
		// Every controller render is an in-flight streaming snapshot, even when
		// smooth reveal has temporarily caught up to the current target. The
		// message_end handler performs the only stable non-transient render.
		this.#component.updateContent(this.#build(this.#target), { transient: true });
	}

	#syncTimer(total = this.#target ? this.#visibleUnits(this.#target) : 0): void {
		if (!this.#target || !this.#component || this.#revealedTotal() >= total) {
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
		if (this.#revealedTotal() >= total) {
			if (this.#targetDirty) {
				this.#targetDirty = false;
				this.#revealWhole(target);
				this.#renderCurrent();
				this.#requestRender(component);
			}
			this.#stopTimer();
			return;
		}
		this.#advance(target, nextStep(total - this.#revealedTotal()));
		component.updateContent(this.#build(target), {
			transient: true,
		});
		this.#requestRender(component);
		if (this.#revealedTotal() >= total) {
			this.#stopTimer();
		}
	}
}
