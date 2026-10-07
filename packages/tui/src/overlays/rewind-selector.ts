/**
 * Fullscreen esc-esc rewind selector.
 *
 * Replays the current session's branch with {@link ChatTranscriptBuilder} on
 * the alternate screen (`ui.showOverlay(..., { fullscreen: true })`) and moves
 * a dotted outline over the rendered transcript block the rewind would land
 * on, instead of listing user messages in a detached picker. Entries that
 * render nothing (notices, hidden custom messages, tool results folded into
 * their call cards) are never outlined: results fold into the turn that
 * rendered their call so rewinding a turn keeps its tool output, and the rest
 * are skipped entirely.
 *
 * When the outlined turn has sibling branches in the session tree, the region
 * below the divergence renders as a horizontal strip of half-width columns —
 * the current path first, each alternate branch beside it — and Left/Right
 * slide between them with an eased camera animation. Sibling columns are
 * fully rendered transcripts of that branch's most-recent path, built lazily
 * and cached per divergence.
 *
 * Keys: Up/Down step through rendered items in transcript order (within the
 * active column when a strip is open), Left/Right slide between branch
 * variants at a fork and jump between user turns elsewhere, `f` opens a
 * filter (typing narrows the current path to matching items; Esc leaves the
 * filter with the selection kept), Enter rewinds to the outlined item, A loads
 * earlier turns without changing selection (stepping above the oldest replayed
 * turn loads them too), Esc cancels.
 *
 * In a TSP terminal (Tern) the same replay is a page, not a sheet: a screen
 * surface of the transcript's own blocks with `pick`/`drop` marks in place of
 * the dotted outline (see `describeScreen`).
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	Input,
	matchesKey,
	padding,
	routeSgrMouseInput,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../index";
import type { MessageRenderer } from "../chat/extension-types";
import { recentTranscriptEntries, type TranscriptEntryLike as TranscriptEntry } from "../chat/transcript-entry";
import { theme } from "../theme/theme";
import { matchesAppToolsExpand, matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { ChatTranscriptBuilder } from "../chat/chat-transcript-builder";
import { TranscriptBrowser, type TranscriptBrowserFrame } from "../chat/transcript-browser";
import { padToWidth } from "../render/utils";
import { expandKeyHint } from "../render/render-utils";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import {
	appendOutlineEntries,
	type ComposedColumn,
	composeOutlineColumn,
	type OutlineTarget,
	isUserTurnEntry,
	outlineVisibility,
	positionRail,
	userTurnLabel,
} from "../chat/transcript-outline";
import type { TspMark } from "@oh-my-pi/pi-wire";
import { kbd, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeScreen, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, actionHint, hintsRow } from "../native/overlay";
import { isNativeRendering } from "../native/state";
import { collectBlocks, targetCopy } from "./copy-selector";

/** One alternate branch at a divergence: its root and message path root → most-recent leaf. */
export interface BranchVariantPath {
	rootId: string;
	entries: TranscriptEntry[];
}

export interface RewindSelectorDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandThinkingBlocks?: () => boolean;
	linkTargets?: ReadonlyMap<string, string>;
	requestRender: () => void;
	/** Sibling branch paths of `entryId`'s turn (excluding the turn itself). */
	siblingPaths?: (entryId: string) => BranchVariantPath[];
	/** Rewind the session to `entryId` (a message entry anywhere in the tree). */
	onSelect: (entryId: string) => void;
	onCancel: () => void;
}

/** Lazily built transcript column for one alternate branch. */
interface SiblingColumn {
	rootId: string;
	builder: ChatTranscriptBuilder;
	targets: OutlineTarget[];
	/** Short label for the column header: the branch's first user prompt. */
	label: string;
}

/**
 * A replayed block on the rewind page, carrying a transient `mark`: it
 * describes as the block with the mark merged into its root props, and hands
 * events and rendering to the block.
 */
class MarkedBlock implements Component {
	mark: TspMark | undefined;
	#memo: { node: NativeNode; mark: TspMark; out: NativeNode } | undefined;

	constructor(readonly block: Component) {}

	render(width: number): readonly string[] {
		return this.block.render(width);
	}

	invalidate(): void {
		this.block.invalidate?.();
	}

	describe(cx: DescribeContext): NativeNode | null {
		const described = this.block.describe?.(cx) ?? null;
		const mark = this.mark;
		if (!described || !mark) return described;
		const memo = this.#memo;
		if (memo?.node === described && memo.mark === mark) return memo.out;
		const out = node(described.k, { ...described.p, mark }, described.c, described.key);
		this.#memo = { node: described, mark, out };
		return out;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		this.block.handleNativeEvent?.(event);
	}
}

const kMarked = Symbol("rewind.marked");

/** A replayed block tagged with its page wrapper, so stepping reuses one wrapper per block. */
interface MarkTagged {
	[kMarked]?: MarkedBlock;
}

/** The page's first row while older history is unreplayed: `a` loads it. */
const EARLIER_TURNS = node(
	"row",
	{ role: "omp.rewind.earlier", gap: "xs", align: "center" },
	[kbd("a"), text([span("load earlier turns", "muted")])],
	"earlier",
);

/** Blank columns between branch-strip columns. */
const STRIP_GAP = 2;
/** Duration of the branch-swap camera slide. */
const SLIDE_MS = 160;

/** Same length and identical elements (or both undefined). */
function sameElements<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export class RewindSelectorComponent implements Component {
	#builder: ChatTranscriptBuilder;
	#browser: TranscriptBrowser;
	#targets: OutlineTarget[] = [];
	#selected = 0;
	/** Per-main-target "renders at least one non-blank row", refreshed each frame. */
	#mainVisible: boolean[] | undefined;
	/** Same, for the active sibling column. */
	#siblingVisible: boolean[] | undefined;
	#expanded = false;

	// Branch strip: present when the selected turn has sibling branches.
	// Column 0 is the current path; siblings follow in tree order.
	#variantCache = new Map<string, SiblingColumn[]>();
	/** 0 = current path column; 1..n = sibling column index + 1. */
	#activeVariant = 0;
	/** Selected target within the active sibling column. */
	#siblingSelected = 0;
	/** Camera slide between variant positions (fractional column index). */
	#slide: { from: number; to: number; startedAt: number } | undefined;
	#slideTimer: NodeJS.Timeout | undefined;

	/** Whole branch; the selector may currently replay only its tail. */
	#entries: TranscriptEntry[];
	/** True while older history is still unreplayed. */
	#truncated = false;
	/** Filter field while the filter prompt is open; undefined shows the full transcript. */
	#filterInput: Input | undefined;
	/** Filter query while the filter prompt is open; undefined shows the full transcript. */
	get #filter(): string | undefined {
		return this.#filterInput?.getValue();
	}
	/** Main transcript rows from the last frame; the filter matches what is on screen. */
	#mainRows: readonly (readonly string[])[] = [];
	/** Lowercased plain text per rendered child row array (row arrays are cached, so identity is stable). */
	#rowText = new WeakMap<readonly string[], string>();
	/** Native filter haystack: lowercased turn text per main target (no rendered rows under TSP). */
	#nativeTexts: { targets: OutlineTarget[]; texts: string[] } | undefined;
	/** Compiled word patterns of the last filter query. */
	#filterPatterns: { query: string; patterns: RegExp[] } | undefined;
	/**
	 * Last {@link #filterMatches} result and its inputs. Frames hand back fresh
	 * outer `mainRows`/`mainVisible` arrays over cached per-child rows, so those
	 * compare element-wise.
	 */
	#filterMemo:
		| {
				query: string;
				targets: OutlineTarget[];
				expanded: boolean;
				native: boolean;
				mainRows: readonly (readonly string[])[];
				mainVisible: readonly boolean[] | undefined;
				matches: readonly number[];
		  }
		| undefined;
	/** Last described bar and the state it was built from. */
	#bar: { memo: string; targets: OutlineTarget[]; node: NativeNode } | undefined;

	constructor(
		entries: TranscriptEntry[],
		private readonly deps: RewindSelectorDeps,
	) {
		this.#entries = entries;
		const tail = recentTranscriptEntries(entries);
		this.#truncated = tail.length < entries.length;
		this.#builder = this.#replay(tail);
		this.#selected = Math.max(0, this.#targets.length - 1);
		this.#browser = new TranscriptBrowser({
			getHeight: () => this.deps.ui.terminal?.rows || process.stdout.rows || 40,
			frame: context => this.#frame(context.contentWidth),
		});
	}

	/** Number of selectable rewind points on the current path; hosts skip mounting when zero. */
	get targetCount(): number {
		return this.#targets.length;
	}

	#newBuilder(): ChatTranscriptBuilder {
		const builder = new ChatTranscriptBuilder({
			ui: this.deps.ui,
			getTool: this.deps.getTool,
			isBuiltInTool: this.deps.isBuiltInTool,
			getMessageRenderer: this.deps.getMessageRenderer,
			cwd: this.deps.cwd,
			hideThinkingBlock: this.deps.hideThinkingBlock,
			proseOnlyThinking: this.deps.proseOnlyThinking,
			expandThinkingBlocks: this.deps.expandThinkingBlocks,
			linkTargets: this.deps.linkTargets,
			requestRender: this.deps.requestRender,
		});
		builder.setExpanded(this.#expanded);
		return builder;
	}

	/** Build a transcript for `entries` and adopt its targets. */
	#replay(entries: TranscriptEntry[]): ChatTranscriptBuilder {
		const builder = this.#newBuilder();
		this.#targets = appendOutlineEntries(builder, entries);
		return builder;
	}

	/** Replay the whole branch, keeping the main outline on the same turn. */
	#loadFullHistory(): void {
		if (!this.#truncated) return;
		const selectedId = this.#targets[this.#selected]?.turnId;
		const previous = this.#builder;
		this.#builder = this.#replay(this.#entries);
		previous.dispose();
		this.#truncated = false;
		this.#mainVisible = undefined;
		this.#mainRows = [];
		const restored = selectedId ? this.#targets.findIndex(target => target.turnId === selectedId) : -1;
		this.#selected = restored >= 0 ? restored : Math.max(0, this.#targets.length - 1);
		this.deps.requestRender();
	}

	invalidate(): void {
		this.#builder.container.invalidate();
		for (const columns of this.#variantCache.values()) {
			for (const column of columns) column.builder.container.invalidate();
		}
		this.#browser.invalidate();
	}

	dispose(): void {
		this.#stopSlide();
		this.#builder.dispose();
		for (const columns of this.#variantCache.values()) {
			for (const column of columns) column.builder.dispose();
		}
		this.#variantCache.clear();
	}

	// ========================================================================
	// Branch strip
	// ========================================================================

	/** Sibling columns for the selected turn, built lazily and cached per divergence. */
	#stripColumns(): SiblingColumn[] {
		const target = this.#targets[this.#selected];
		if (!target || !this.deps.siblingPaths) return [];
		const cached = this.#variantCache.get(target.turnId);
		if (cached) return cached;
		const columns: SiblingColumn[] = [];
		for (const sibling of this.deps.siblingPaths(target.turnId)) {
			if (sibling.entries.length === 0) continue;
			const builder = this.#newBuilder();
			const targets = appendOutlineEntries(builder, sibling.entries);
			const firstUser = sibling.entries.find(isUserTurnEntry);
			const label = (firstUser && userTurnLabel(firstUser)) || sibling.rootId;
			columns.push({ rootId: sibling.rootId, builder, targets, label });
		}
		this.#variantCache.set(target.turnId, columns);
		return columns;
	}

	/** The target the dotted outline currently rests on. */
	#outlinedTarget(): OutlineTarget | undefined {
		if (this.#activeVariant > 0) {
			return this.#stripColumns()[this.#activeVariant - 1]?.targets[this.#siblingSelected];
		}
		return this.#targets[this.#selected];
	}

	#slideTo(variant: number): void {
		const now = Date.now();
		const from = this.#slidePosition(now);
		this.#slide = { from, to: variant, startedAt: now };
		this.#activeVariant = variant;
		// The camera slide is repaint-only; a native surface has no camera to move.
		if (isNativeRendering()) {
			this.deps.requestRender();
			return;
		}
		this.#slideTimer ??= setInterval(() => {
			if (!this.#slide || Date.now() - this.#slide.startedAt >= SLIDE_MS) this.#stopSlide();
			this.deps.requestRender();
		}, 16);
		this.deps.requestRender();
	}

	#stopSlide(): void {
		this.#slide = undefined;
		if (this.#slideTimer !== undefined) {
			clearInterval(this.#slideTimer);
			this.#slideTimer = undefined;
		}
	}

	/** Fractional variant position of the camera at `now` (eased). */
	#slidePosition(now: number): number {
		if (!this.#slide) return this.#activeVariant;
		const t = Math.min(1, (now - this.#slide.startedAt) / SLIDE_MS);
		const eased = 1 - (1 - t) ** 3;
		return this.#slide.from + (this.#slide.to - this.#slide.from) * eased;
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					// A wheel notch at either end moves nothing: repainting it
					// anyway makes the frame twitch under a fast wheel.
					if (this.#browser.scroll(event.wheel * 3)) this.deps.requestRender();
				}
				return true;
			});
			return;
		}
		if (this.#filter !== undefined) {
			this.#handleFilterInput(data);
			return;
		}
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			this.deps.onCancel();
			return;
		}
		if (matchesKey(data, "f")) {
			this.#openFilter();
			return;
		}
		if (matchesAppToolsExpand(data)) {
			this.#toggleExpanded();
			return;
		}
		if (matchesSelectUp(data)) {
			this.#moveVertical(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#moveVertical(1);
			return;
		}
		if (matchesKey(data, "left")) {
			this.#left();
			return;
		}
		if (matchesKey(data, "right")) {
			this.#right();
			return;
		}
		if (data === "a" || data === "A") {
			this.#loadFullHistory();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#selectOutlined();
			return;
		}
		// Page/home/end/shift+arrow scrolling without moving the selection.
		if (this.#browser.handleScrollKey(data)) {
			this.deps.requestRender();
		}
	}

	/** `f`: open the filter over the whole branch. */
	#openFilter(): void {
		// The filter must search the whole branch, not just the startup tail.
		this.#loadFullHistory();
		const input = new Input();
		input.prompt = `${theme.fg("accent", "filter:")} `;
		input.placeholder = "words…";
		this.#filterInput = input;
		this.#activeVariant = 0;
		this.#siblingSelected = 0;
		this.#stopSlide();
		this.deps.requestRender();
	}

	/** Left: the previous branch at a fork, else the previous user turn. */
	#left(): void {
		if (this.#activeVariant > 0) this.#slideTo(this.#activeVariant - 1);
		else this.#move(-1, target => target.isUserTurn);
	}

	/** Right: the next branch at a fork, else the next user turn. */
	#right(): void {
		const columns = this.#stripColumns();
		if (this.#activeVariant < columns.length) {
			this.#siblingSelected = 0;
			this.#slideTo(this.#activeVariant + 1);
		} else if (this.#activeVariant === 0) {
			this.#move(1, target => target.isUserTurn);
		}
	}

	/** Enter while filtering: rewind to the selection when it matches. */
	#selectFiltered(): void {
		const target = this.#filterMatches().includes(this.#selected) ? this.#targets[this.#selected] : undefined;
		if (target) this.deps.onSelect(target.entryId);
	}

	/** Enter: rewind to the outlined turn (main path or the active branch column). */
	#selectOutlined(): void {
		const target = this.#outlinedTarget();
		if (target) this.deps.onSelect(target.entryId);
	}

	#toggleExpanded(): void {
		this.#expanded = !this.#expanded;
		this.#builder.setExpanded(this.#expanded);
		for (const columns of this.#variantCache.values()) {
			for (const column of columns) column.builder.setExpanded(this.#expanded);
		}
		this.deps.requestRender();
	}

	// ========================================================================
	// Filter
	// ========================================================================

	#handleFilterInput(data: string): void {
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			this.#closeFilter();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#selectFiltered();
			return;
		}
		if (matchesAppToolsExpand(data)) {
			this.#toggleExpanded();
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "left")) {
			const userTurnsOnly = !matchesSelectUp(data);
			this.#stepFiltered(-1, userTurnsOnly);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "right")) {
			const userTurnsOnly = !matchesSelectDown(data);
			this.#stepFiltered(1, userTurnsOnly);
			return;
		}
		const input = this.#filterInput!;
		const before = input.getValue();
		if (matchesKey(data, "backspace") && before.length === 0) {
			this.#closeFilter();
			return;
		}
		if (input.handleInput(data)) {
			if (input.getValue() !== before) this.#filterChanged();
			else this.deps.requestRender();
			return;
		}
		if (this.#browser.handleScrollKey(data)) {
			this.deps.requestRender();
		}
	}

	/** Leave the filter, keeping the selected item outlined in the full transcript. */
	#closeFilter(): void {
		this.#filterInput = undefined;
		this.deps.requestRender();
	}

	/** The query changed; keep the selection when it still matches, else rest on the newest match above it. */
	#filterChanged(): void {
		const matches = this.#filterMatches();
		if (!matches.includes(this.#selected)) {
			this.#selected = matches.findLast(index => index < this.#selected) ?? matches.at(-1) ?? this.#selected;
		}
		this.deps.requestRender();
	}

	#stepFiltered(delta: -1 | 1, userTurnsOnly: boolean): void {
		const matches = this.#filterMatches().filter(index => !userTurnsOnly || this.#targets[index]!.isUserTurn);
		const next =
			delta < 0 ? matches.findLast(index => index < this.#selected) : matches.find(index => index > this.#selected);
		if (next === undefined) return;
		this.#selected = next;
		this.deps.requestRender();
	}

	/**
	 * Visible main-path target indices whose rendered text contains every
	 * whitespace-separated Latin query word as a whole word (case-insensitive:
	 * `ls` matches `ls -la` but not `tools`). Other scripts match substrings so
	 * a Chinese query can find text inside a sentence without spaces.
	 * All visible targets match an empty query.
	 * Matching the rendered rows keeps results honest: collapsed tool output
	 * only matches once Ctrl+O expands it.
	 */
	#filterMatches(): readonly number[] {
		const query = this.#filter ?? "";
		const native = isNativeRendering();
		const memo = this.#filterMemo;
		if (
			memo &&
			memo.query === query &&
			memo.targets === this.#targets &&
			memo.expanded === this.#expanded &&
			memo.native === native &&
			sameElements(memo.mainVisible, this.#mainVisible) &&
			(native || sameElements(memo.mainRows, this.#mainRows))
		) {
			memo.mainRows = this.#mainRows;
			memo.mainVisible = this.#mainVisible;
			return memo.matches;
		}
		const patterns = this.#compileFilter(query);
		if (native && this.#nativeTexts?.targets !== this.#targets) {
			this.#nativeTexts = {
				targets: this.#targets,
				// Turn text plus its commands and tool output, like the expanded rendered rows.
				texts: this.#targets.map(target => {
					const blocks = collectBlocks(target.entries);
					const parts = [targetCopy(target, blocks).content, ...blocks.map(block => block.content)];
					return parts.join("\n").toLowerCase();
				}),
			};
		}
		const matches: number[] = [];
		for (let index = 0; index < this.#targets.length; index++) {
			if (!this.#isMainSelectable(index)) continue;
			const target = this.#targets[index]!;
			const matched = native
				? patterns.every(pattern => pattern.test(this.#nativeTexts?.texts[index] ?? ""))
				: patterns.every(pattern => {
						for (let child = target.start; child < target.end; child++) {
							const rows = this.#mainRows[child];
							if (rows !== undefined && pattern.test(this.#plainRowText(rows))) return true;
						}
						return false;
					});
			if (matched) matches.push(index);
		}
		this.#filterMemo = {
			query,
			targets: this.#targets,
			expanded: this.#expanded,
			native,
			mainRows: this.#mainRows,
			mainVisible: this.#mainVisible,
			matches,
		};
		return matches;
	}

	/** Word patterns of `query`, compiled once per distinct query. */
	#compileFilter(query: string): RegExp[] {
		const cached = this.#filterPatterns;
		if (cached?.query === query) return cached.patterns;
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const patterns = words.map(word =>
			/^[\p{Script=Latin}\p{N}_]+$/u.test(word)
				? new RegExp(`(?<![\\p{L}\\p{N}_])${RegExp.escape(word)}(?![\\p{L}\\p{N}_])`, "u")
				: new RegExp(RegExp.escape(word), "u"),
		);
		this.#filterPatterns = { query, patterns };
		return patterns;
	}

	/** Lowercased plain text of one rendered child row array, cached by array identity. */
	#plainRowText(rows: readonly string[]): string {
		let text = this.#rowText.get(rows);
		if (text === undefined) {
			text = Bun.stripANSI(rows.join("\n")).toLowerCase();
			this.#rowText.set(rows, text);
		}
		return text;
	}

	/** Up/Down: step within the active column; leaving a sibling column's top exits the strip. */
	#moveVertical(delta: -1 | 1): void {
		if (this.#activeVariant > 0) {
			const targets = this.#stripColumns()[this.#activeVariant - 1]?.targets ?? [];
			let index = this.#siblingSelected + delta;
			while (index >= 0 && index < targets.length && this.#siblingVisible?.[index] === false) index += delta;
			if (index >= 0 && index < targets.length) {
				this.#siblingSelected = index;
				this.deps.requestRender();
			} else if (delta === -1) {
				// Off the top of an alternate: return to the current path above the fork.
				this.#activeVariant = 0;
				this.#siblingSelected = 0;
				this.#stopSlide();
				this.#move(-1, () => true);
			}
			return;
		}
		this.#move(delta, () => true);
	}

	/**
	 * Step the main selection by `delta` to the nearest visible target passing
	 * `accept`; stepping above the replayed tail loads the earlier history first.
	 */
	#move(delta: -1 | 1, accept: (target: OutlineTarget) => boolean): void {
		let index = this.#selected + delta;
		while (index >= 0 && index < this.#targets.length) {
			if (this.#isMainSelectable(index) && accept(this.#targets[index]!)) {
				this.#selected = index;
				this.#activeVariant = 0;
				this.#siblingSelected = 0;
				this.#stopSlide();
				this.deps.requestRender();
				return;
			}
			index += delta;
		}
		if (delta < 0 && this.#truncated) {
			this.#loadFullHistory();
			this.#move(delta, accept);
		}
	}

	#isMainSelectable(index: number): boolean {
		return this.#mainVisible?.[index] ?? true;
	}

	// ========================================================================
	// Native: the transcript as a page
	// ========================================================================

	/**
	 * The rewind page: the replayed transcript fills a screen surface block by
	 * block, as the live one reads, the outlined turn marked `pick` under a
	 * "Continue from here" caption (revealed as the outline moves) and what the
	 * rewind drops marked `drop`. At a fork the region below it becomes a strip
	 * of branch columns, the current path first. The bar is this component's
	 * own node, docked under the page, so the filter field keeps the caret.
	 */
	describeScreen(_cx: DescribeContext): NativeScreen {
		return { role: "omp.rewind", main: this.#page(), dock: [this] };
	}

	/** The page's blocks, marked for the current outline. */
	#page(): NativeChild[] {
		const blocks = this.#builder.container.children;
		const page: NativeChild[] = [];
		const filter = this.#filter;
		if (filter !== undefined) {
			// Only the matching turns of the current path, like the filtered frame.
			const matches = this.#filterMatches();
			for (const index of matches) {
				const target = this.#targets[index]!;
				const picked = index === this.#selected;
				if (picked) page.push(this.#caption(this.#targets, index, "main"));
				for (let i = target.start; i < target.end; i++)
					page.push(this.#marked(blocks[i]!, picked ? "pick" : undefined));
			}
			if (matches.length === 0) {
				page.push(text([span(`No turns match "${filter}"`, "muted")], { role: "omp.rewind.empty" }));
			}
			return page;
		}
		if (this.#truncated) page.push(EARLIER_TURNS);
		const columns = this.#stripColumns();
		const anchor = this.#targets[this.#selected];
		if (columns.length === 0 || !anchor) {
			this.#markRun(page, blocks, 0, this.#targets, this.#selected, "main");
			return page;
		}
		// Shared history above the fork at full width, then the branches side by side.
		for (let i = 0; i < anchor.start; i++) page.push(this.#marked(blocks[i]!, undefined));
		const count = columns.length + 1;
		const current: NativeChild[] = [this.#columnHead(0, count, "current")];
		this.#markRun(
			current,
			blocks,
			anchor.start,
			this.#targets,
			this.#activeVariant === 0 ? this.#selected : -1,
			"main",
		);
		const strip = [this.#column(0, current, "current")];
		for (let index = 0; index < columns.length; index++) {
			const column = columns[index]!;
			const active = this.#activeVariant === index + 1;
			const children: NativeChild[] = [this.#columnHead(index + 1, count, column.label)];
			const picked = active ? this.#siblingSelected : -1;
			this.#markRun(children, column.builder.container.children, 0, column.targets, picked, column.rootId);
			strip.push(this.#column(index + 1, children, column.rootId));
		}
		page.push(node("row", { role: "omp.rewind.strip", gap: "lg", align: "start" }, strip, "strip"));
		return page;
	}

	/**
	 * Push `blocks[from..]` marked for `targets[picked]` (-1: none): unmarked
	 * above it, then the caption and `pick` on its blocks, `drop` below.
	 */
	#markRun(
		out: NativeChild[],
		blocks: readonly Component[],
		from: number,
		targets: readonly OutlineTarget[],
		picked: number,
		column: string,
	): void {
		const target = targets[picked];
		for (let i = from; i < blocks.length; i++) {
			if (target && i === target.start) out.push(this.#caption(targets, picked, column));
			const mark = !target || i < target.start ? undefined : i < target.end ? "pick" : "drop";
			out.push(this.#marked(blocks[i]!, mark));
		}
	}

	/**
	 * The line over the outlined turn: what Enter does and what it drops.
	 * Keyed by the turn, so every step adds a fresh one that scrolls into view.
	 */
	#caption(targets: readonly OutlineTarget[], picked: number, column: string): NativeNode {
		const target = targets[picked]!;
		const below = targets.length - picked - 1;
		const spans = [
			span(`${theme.icon.rewind} `, "accent"),
			span(target.isUserTurn ? "Rewind to here" : "Continue from here", "accent strong"),
		];
		if (target.isUserTurn) spans.push(span(`${theme.sep.dot}the prompt returns to the editor`, "dim"));
		spans.push(
			span(
				below > 0
					? `${theme.sep.dot}${below} turn${below === 1 ? "" : "s"} below dropped`
					: `${theme.sep.dot}nothing below to drop`,
				"dim",
			),
		);
		const caption = text(spans, { role: "omp.rewind.here", wrap: "none" });
		return { ...caption, key: `here:${column}:${target.turnId}`, reveal: "start" };
	}

	/** One branch column of the strip; the active one carries the accent tone. */
	#column(index: number, children: readonly NativeChild[], key: string): NativeNode {
		const active = index === this.#activeVariant;
		return node(
			"col",
			{ role: "omp.rewind.branch", gap: "lg", ...(active ? { tone: "accent" } : {}) },
			children,
			key,
		);
	}

	/** A strip column's caption: `⎇ i/n · label`. */
	#columnHead(index: number, count: number, label: string): NativeNode {
		const active = index === this.#activeVariant;
		return text(
			[
				span(`${theme.icon.branch} `, active ? "accent" : "dim"),
				span(`${index + 1}/${count}`, active ? "accent" : "dim"),
				span(`${theme.sep.dot}${label}`, active ? "strong" : "dim"),
			],
			{ role: "omp.rewind.branch.head", wrap: "none" },
		);
	}

	/** `block` wrapped to carry `mark`; one wrapper per block, so ids and view state persist while stepping. */
	#marked(block: Component & MarkTagged, mark: TspMark | undefined): MarkedBlock {
		const marked = (block[kMarked] ??= new MarkedBlock(block));
		marked.mark = mark;
		return marked;
	}

	/** The bar docked under the page: position, key hints, Cancel and Rewind; the filter field while filtering. */
	describe(_cx: DescribeContext): NativeNode {
		const filter = this.#filter;
		const columns = filter === undefined ? this.#stripColumns() : [];
		const memo = `${this.#selected}|${this.#activeVariant}|${this.#siblingSelected}|${this.#truncated}|${columns.length}|${filter ?? "\0"}`;
		if (this.#bar?.memo === memo && this.#bar.targets === this.#targets) return this.#bar.node;

		const title = text([span(`${theme.icon.rewind} `, "accent"), span("Rewind", "strong")], { wrap: "none" });
		const upDown = actionHint(["tui.select.up", "tui.select.down"], "step");
		const rewind = actionButton("Rewind here", "rewind", { keys: "enter", tone: "accent" });
		let children: NativeChild[];
		if (filter === undefined) {
			const column = columns[this.#activeVariant - 1];
			const at = column ? this.#siblingSelected : this.#selected;
			const of = column ? column.targets.length : this.#targets.length;
			children = [
				title,
				text([span(`${at + 1}/${of}`, "dim")], { wrap: "none" }),
				hintsRow([
					upDown,
					{ keys: ["left", "right"], label: columns.length > 0 ? "branches" : "user turns" },
					{ keys: ["f"], label: "filter" },
					this.#truncated ? { keys: ["a"], label: "earlier turns" } : undefined,
				]),
				actionBar([null, actionButton("Cancel", "cancel", { keys: "escape" }), rewind]),
			];
		} else {
			const matches = this.#filterMatches();
			const at = matches.indexOf(this.#selected);
			children = [
				title,
				this.#filterInput!,
				text(
					[
						matches.length === 0
							? span("no matches", "error")
							: span(`${at >= 0 ? at + 1 : "-"}/${matches.length}`, "dim"),
					],
					{ wrap: "none" },
				),
				hintsRow([upDown, { keys: ["left", "right"], label: "user turns" }]),
				actionBar([null, actionButton("Show all", "cancel", { keys: "escape" }), rewind]),
			];
		}
		const root = node("row", { role: "omp.rewind.bar", gap: "md", align: "center", wrap: true }, children);
		this.#bar = { memo, targets: this.#targets, node: root };
		return root;
	}

	/** The bar's buttons run their keys' paths; everything else belongs to the blocks. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		const filtering = this.#filter !== undefined;
		if (event.act === "rewind") {
			if (filtering) this.#selectFiltered();
			else this.#selectOutlined();
		} else if (event.act === "cancel") {
			if (filtering) this.#closeFilter();
			else this.deps.onCancel();
		}
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		return this.#browser.render(width);
	}

	#frame(contentWidth: number): TranscriptBrowserFrame {
		// The outline consumes two columns each side ("┆ " / " ┆"), unselected
		// rows a matching two-column left gutter so blocks never shift while stepping.
		const children = this.#builder.container.children;
		const prepared = this.#browser.prepareOutline(children, this.#targets, this.#selected, contentWidth);
		this.#mainVisible = prepared.visible;
		this.#mainRows = prepared.childRows;
		if (prepared.selected !== this.#selected) {
			// The current target collapsed (e.g. expansion toggle): rest on the
			// nearest visible one and leave the strip.
			this.#selected = prepared.selected;
			this.#activeVariant = 0;
			this.#siblingSelected = 0;
		}

		if (this.#filter !== undefined) return this.#filterFrame(this.#filter, prepared.childRows, contentWidth);

		const columns = this.#stripColumns();
		const composed =
			columns.length > 0
				? this.#renderStrip(prepared.childRows, columns, contentWidth)
				: this.#browser.composeOutline({
						children,
						targets: this.#targets,
						selected: this.#selected,
						columnWidth: contentWidth,
						prepared,
					}).column;
		const position = this.#targets.length > 0 ? `${this.#selected + 1}/${this.#targets.length}  ` : "";
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		const leftRight = formatKeyHints(["left", "right"]);
		const lateral = columns.length > 0 ? `${leftRight} branches` : `${leftRight} user turns`;
		const keys = `${upDown} step  ${lateral}  ${formatKeyHint("f")} filter  ${formatKeyHint("enter")} rewind  ${this.#truncated ? `${formatKeyHint("a")} earlier turns  ` : ""}${expandKeyHint()} expand  ${editorKey("tui.select.cancel")} cancel`;
		return {
			header: [this.#header()],
			body: {
				lines: composed.lines,
				anchor: this.#outlineAnchor(composed),
			},
			footer: [theme.fg("dim", `${position}${keys}`)],
		};
	}

	#header(): string {
		return `${theme.icon.rewind} ${theme.bold("Rewind")}${theme.sep.dot}${theme.fg("dim", "pick the point to continue from")}`;
	}

	/** Only the matching items of the current path, concatenated; no branch strip. */
	#filterFrame(
		query: string,
		childRows: readonly (readonly string[])[],
		contentWidth: number,
	): TranscriptBrowserFrame {
		const matches = this.#filterMatches();
		const rows: (readonly string[])[] = [];
		const targets: OutlineTarget[] = [];
		for (const index of matches) {
			const target = this.#targets[index]!;
			const start = rows.length;
			rows.push(...childRows.slice(target.start, target.end));
			targets.push({ ...target, start, end: rows.length });
		}
		const selected = matches.indexOf(this.#selected);
		const composed = composeOutlineColumn(rows, 0, rows.length, targets, selected, contentWidth, undefined);
		const lines = matches.length > 0 ? composed.lines : [theme.fg("muted", `  No items match "${query}"`)];
		const count =
			matches.length === 0
				? theme.fg("error", "no matches")
				: theme.fg("dim", `${selected >= 0 ? selected + 1 : "-"}/${matches.length}`);
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		const keys = `${upDown} step  ${formatKeyHints(["left", "right"])} user turns  ${formatKeyHint("enter")} rewind  ${editorKey("tui.select.cancel")} show all`;
		return {
			header: [this.#header()],
			body: {
				lines,
				anchor:
					composed.selStart >= 0
						? {
								id: `rewind:filter:${query}:${this.#targets[this.#selected]?.turnId ?? this.#selected}`,
								start: composed.selStart,
								end: composed.selEnd,
							}
						: undefined,
			},
			footer: [
				`${this.#filterInput!.render(visibleWidth(`filter: ${query}`) + 1)[0]}  ${count}  ${theme.fg("dim", keys)}`,
			],
		};
	}

	/** Selection anchor keyed by the outlined turn/sibling identity plus its composed range. */
	#outlineAnchor(composed: ComposedColumn): { id: string; start: number; end: number } | undefined {
		if (composed.selStart < 0) return undefined;
		const outlined = this.#outlinedTarget();
		const id =
			this.#activeVariant > 0
				? `rewind:sibling:${this.#stripColumns()[this.#activeVariant - 1]?.rootId ?? this.#activeVariant}:${outlined?.entryId ?? this.#siblingSelected}`
				: `rewind:main:${outlined?.turnId ?? this.#selected}`;
		return { id, start: composed.selStart, end: composed.selEnd };
	}

	/**
	 * Shared prefix at full width, then the divergence as a camera-positioned
	 * strip of half-width branch columns (current path first, siblings after).
	 */
	#renderStrip(mainRows: (readonly string[])[], columns: SiblingColumn[], contentWidth: number): ComposedColumn {
		const anchor = this.#targets[this.#selected]!;
		const colWidth = Math.max(24, Math.floor((contentWidth - STRIP_GAP) / 2));
		const count = columns.length + 1;

		// Shared history above the fork, full width, never outlined.
		const prefix = composeOutlineColumn(mainRows, 0, anchor.start, [], -1, contentWidth, undefined);

		// Column 0: the current path from the fork down, re-rendered at column width.
		const suffixRows = this.#browser.renderOutlineRows(
			this.#builder.container.children.slice(anchor.start),
			colWidth,
		);
		const suffixTargets = this.#targets.slice(this.#selected).map(target => ({
			...target,
			start: target.start - anchor.start,
			end: target.end - anchor.start,
		}));
		const composedColumns: ComposedColumn[] = [
			composeOutlineColumn(
				suffixRows,
				0,
				suffixRows.length,
				suffixTargets,
				this.#activeVariant === 0 ? 0 : -1,
				colWidth,
				this.#columnHeader(0, count, "current", colWidth),
			),
		];
		for (let index = 0; index < columns.length; index++) {
			const column = columns[index]!;
			const rows = this.#browser.renderOutlineRows(column.builder.container.children, colWidth);
			if (this.#activeVariant === index + 1) {
				this.#siblingVisible = outlineVisibility(rows, column.targets);
			}
			composedColumns.push(
				composeOutlineColumn(
					rows,
					0,
					rows.length,
					column.targets,
					this.#activeVariant === index + 1 ? this.#siblingSelected : -1,
					colWidth,
					this.#columnHeader(index + 1, count, column.label, colWidth),
				),
			);
		}

		// Camera over the strip: keep the active (possibly mid-slide) column centered.
		const stride = colWidth + STRIP_GAP;
		const totalWidth = count * colWidth + (count - 1) * STRIP_GAP;
		const cameraAt = (position: number) =>
			Math.max(
				0,
				Math.min(position * stride - (contentWidth - colWidth) / 2, Math.max(0, totalWidth - contentWidth)),
			);
		const position = this.#slidePosition(Date.now());
		const camera = cameraAt(position);

		const height = Math.max(...composedColumns.map(column => column.lines.length));
		const lines = prefix.lines;
		// With more branches than the window fits, a dot rail tracks the active
		// column and dim ellipses flag content beyond the visible edge.
		// Edge markers follow the slide's destination, not the eased camera,
		// so they flip in step with the dot rail.
		if (count > 2) {
			const settled = cameraAt(this.#activeVariant);
			lines.push(
				positionRail(
					count,
					this.#activeVariant,
					settled > 0.5,
					settled + contentWidth < totalWidth - 0.5,
					contentWidth,
				),
				"",
			);
		}
		const active = composedColumns[this.#activeVariant]!;
		const selStart = active.selStart >= 0 ? lines.length + active.selStart : -1;
		const selEnd = active.selEnd >= 0 ? lines.length + active.selEnd : -1;
		for (let row = 0; row < height; row++) {
			let line = "";
			let filled = 0;
			for (let index = 0; index < count; index++) {
				const x0 = index * stride - camera;
				const x1 = x0 + colWidth;
				const visible0 = Math.max(0, x0);
				const visible1 = Math.min(contentWidth, x1);
				if (visible1 <= visible0) continue;
				const source = colWidth > 0 ? padToWidth(composedColumns[index]!.lines[row] ?? "", colWidth) : "";
				const slice = sliceByColumn(source, visible0 - x0, visible1 - visible0, true);
				line +=
					padding(Math.max(0, visible0 - filled)) +
					(visible1 - visible0 > 0 ? padToWidth(slice, visible1 - visible0) : "");
				filled = visible1;
			}
			lines.push(line);
		}
		return { lines, selStart, selEnd };
	}

	/** Two caption rows leading a strip column: `⎇ i/n · label` plus a spacer. */
	#columnHeader(index: number, count: number, label: string, columnWidth: number): string[] {
		const caption = truncateToWidth(
			`${theme.icon.branch} ${index + 1}/${count} ${theme.sep.dot} ${label}`,
			columnWidth - 2,
		);
		const active = index === this.#activeVariant;
		return [` ${theme.fg(active ? "accent" : "dim", caption)}`, ""];
	}
}
