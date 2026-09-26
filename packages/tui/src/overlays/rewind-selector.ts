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
 * filter with the selection kept), Enter rewinds to the outlined item, Esc
 * cancels.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	extractPrintableText,
	matchesKey,
	padding,
	routeSgrMouseInput,
	sliceByColumn,
	type TUI,
	truncateToWidth,
} from "../index";
import type { MessageRenderer } from "../chat/extension-types";
import type { TranscriptEntryLike as TranscriptEntry } from "../chat/transcript-entry";
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

/** Blank columns between branch-strip columns. */
const STRIP_GAP = 2;
/** Duration of the branch-swap camera slide. */
const SLIDE_MS = 160;

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

	/** Filter query while the filter prompt is open; undefined shows the full transcript. */
	#filter: string | undefined;
	/** Main transcript rows from the last frame; the filter matches what is on screen. */
	#mainRows: readonly (readonly string[])[] = [];
	/** Lowercased plain text per rendered child row array (row arrays are cached, so identity is stable). */
	#rowText = new WeakMap<readonly string[], string>();

	constructor(
		entries: TranscriptEntry[],
		private readonly deps: RewindSelectorDeps,
	) {
		this.#builder = this.#newBuilder();
		this.#targets = appendOutlineEntries(this.#builder, entries);
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
		return new ChatTranscriptBuilder({
			ui: this.deps.ui,
			getTool: this.deps.getTool,
			isBuiltInTool: this.deps.isBuiltInTool,
			getMessageRenderer: this.deps.getMessageRenderer,
			cwd: this.deps.cwd,
			hideThinkingBlock: this.deps.hideThinkingBlock,
			proseOnlyThinking: this.deps.proseOnlyThinking,
			linkTargets: this.deps.linkTargets,
			requestRender: this.deps.requestRender,
		});
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
			builder.setExpanded(this.#expanded);
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
			this.#filter = "";
			this.#activeVariant = 0;
			this.#siblingSelected = 0;
			this.#stopSlide();
			this.deps.requestRender();
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
			if (this.#activeVariant > 0) this.#slideTo(this.#activeVariant - 1);
			else this.#move(-1, target => target.isUserTurn);
			return;
		}
		if (matchesKey(data, "right")) {
			const columns = this.#stripColumns();
			if (this.#activeVariant < columns.length) {
				this.#siblingSelected = 0;
				this.#slideTo(this.#activeVariant + 1);
			} else if (this.#activeVariant === 0) {
				this.#move(1, target => target.isUserTurn);
			}
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const target = this.#outlinedTarget();
			if (target) this.deps.onSelect(target.entryId);
			return;
		}
		// Page/home/end/shift+arrow scrolling without moving the selection.
		if (this.#browser.handleScrollKey(data)) {
			this.deps.requestRender();
		}
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
			const target = this.#filterMatches().includes(this.#selected) ? this.#targets[this.#selected] : undefined;
			if (target) this.deps.onSelect(target.entryId);
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
		if (matchesKey(data, "backspace")) {
			if (this.#filter!.length === 0) {
				this.#closeFilter();
				return;
			}
			this.#setFilter(this.#filter!.slice(0, -1));
			return;
		}
		const printable = extractPrintableText(data);
		if (printable) {
			this.#setFilter(this.#filter! + printable);
			return;
		}
		if (this.#browser.handleScrollKey(data)) {
			this.deps.requestRender();
		}
	}

	/** Leave the filter, keeping the selected item outlined in the full transcript. */
	#closeFilter(): void {
		this.#filter = undefined;
		this.deps.requestRender();
	}

	/** Update the query; keep the selection when it still matches, else rest on the newest match above it. */
	#setFilter(query: string): void {
		this.#filter = query;
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
	#filterMatches(): number[] {
		const words = (this.#filter ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		const patterns = words.map(word =>
			/^[\p{Script=Latin}\p{N}_]+$/u.test(word)
				? new RegExp(`(?<![\\p{L}\\p{N}_])${RegExp.escape(word)}(?![\\p{L}\\p{N}_])`, "u")
				: new RegExp(RegExp.escape(word), "u"),
		);
		const matches: number[] = [];
		for (let index = 0; index < this.#targets.length; index++) {
			if (!this.#isMainSelectable(index)) continue;
			const target = this.#targets[index]!;
			const texts = this.#mainRows.slice(target.start, target.end).map(rows => {
				let text = this.#rowText.get(rows);
				if (text === undefined) {
					text = Bun.stripANSI(rows.join("\n")).toLowerCase();
					this.#rowText.set(rows, text);
				}
				return text;
			});
			if (patterns.every(pattern => texts.some(text => pattern.test(text)))) matches.push(index);
		}
		return matches;
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

	/** Step the main selection by `delta` to the nearest visible target passing `accept`. */
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
	}

	#isMainSelectable(index: number): boolean {
		return this.#mainVisible?.[index] ?? true;
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
		const keys = `${upDown} step  ${lateral}  ${formatKeyHint("f")} filter  ${formatKeyHint("enter")} rewind  ${expandKeyHint()} expand  ${editorKey("tui.select.cancel")} cancel`;
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
				`${theme.fg("accent", "filter:")} ${query}${theme.fg("accent", "▏")}  ${count}  ${theme.fg("dim", keys)}`,
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
