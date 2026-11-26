/**
 * State of the git app's diff pane: the document of the selected file (or a
 * streaming preview while it loads, or a media/binary comparison), the view
 * mode (`split`, `inline`, `hunk`, `file`), wrapping, scroll offsets, the
 * read-only cursor with its shift selection, and the selected hunk.
 *
 * Navigation works on visual rows of the current layout, measured at the
 * width the pane was last painted at (the terminal look reports it through
 * {@link DiffPaneModel.measure}).
 */
import { batch, type ScrollRequest, signal, untrack } from "@oh-my-pi/pi-tui";
import { Highlighter, type HighlightedLine } from "@oh-my-pi/pi-tui/text/highlight";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import type { DiffDocument, HunkBlock } from "../../../cli/git-tui/model/diff-pane";
import type { FileAssetSide, FileStreamUpdate } from "../../../cli/git-tui/model/state";
import { type DiffRow, displayLine } from "./document";

/** How the pane presents the document. */
export type ViewMode = "split" | "inline" | "hunk" | "file";

/** Placeholder states shown instead of a document. */
export type DiffPaneState = "empty" | "loading" | "streaming" | "asset" | "ready";

/** Hunk-button actions raised to the app. */
export type HunkAction = "stage" | "unstage" | "discard";

/** Result of a left click inside the pane. */
export type PaneClick = { type: "hunk-action"; hunk: HunkBlock; action: HunkAction } | { type: "handled" } | null;

/** One drawn row of the current layout. */
export type Visual =
	| { readonly t: "split"; readonly row: DiffRow; readonly seg: number; readonly rowIndex: number }
	| {
			readonly t: "line";
			readonly row: DiffRow;
			readonly side: "old" | "new" | "both";
			readonly seg: number;
			readonly rowIndex: number;
	  }
	| { readonly t: "file"; readonly index: number; readonly seg: number; readonly rowIndex: number }
	| { readonly t: "header"; readonly hunk: number }
	| { readonly t: "blank" };

/** Change class of a visual row (the minimap and change navigation read it). */
export type VisualKind = DiffRow["kind"] | "hunk" | null;

/** Lines of a file pair arriving from the native differ. */
export interface StreamingDocument {
	readonly filePath: string;
	readonly oldLines: string[];
	readonly newLines: string[];
	stableCommonLines: number;
	maxLineWidth: number;
}

/** A media/binary change. */
export interface AssetDocument {
	readonly filePath: string;
	readonly old: FileAssetSide;
	readonly new: FileAssetSide;
}

/** Syntax highlighting layered over the document, per side and line. */
export interface SyntaxHighlights {
	readonly old: readonly (HighlightedLine | undefined)[];
	readonly new: readonly (HighlightedLine | undefined)[];
}

/** Clickable hunk buttons of a drawn header row. */
export interface HeaderHit {
	readonly hunk: number;
	readonly primary?: readonly [number, number];
	readonly discard?: readonly [number, number];
}

/** Columns of the minimap at the pane's right edge. */
export const MINIMAP_COLUMNS = 2;

/** Change class of `visual`. */
export function visualKind(visual: Visual): VisualKind {
	switch (visual.t) {
		case "split":
			return visual.row.kind;
		case "line":
			return visual.row.kind === "change" ? (visual.side === "old" ? "del" : "add") : visual.row.kind;
		case "header":
			return "hunk";
		case "file":
			return "context";
		default:
			return null;
	}
}

/** Index into `doc.rows` a visual shows, or -1 (headers, blanks, hunk-view rows). */
function visualRowIndex(visual: Visual | undefined): number {
	return visual && (visual.t === "split" || visual.t === "line" || visual.t === "file") ? visual.rowIndex : -1;
}

/** The offset keeping `row` visible (`nearest` moves as little as possible; `center` centers it). */
function offsetForRow(current: number, row: number, total: number, height: number, center = false): number {
	if (total === 0 || height === 0) return 0;
	const target = Math.max(0, Math.min(row, total - 1));
	const top = clampOffset(current, total, height);
	let next = top;
	if (center) next = target - Math.floor(height / 2);
	else if (target < top) next = target;
	else if (target >= top + height) next = target - height + 1;
	return clampOffset(next, total, height);
}

function clampOffset(offset: number, total: number, height: number): number {
	return Math.max(0, Math.min(Math.trunc(offset), Math.max(0, total - height)));
}

/** See the module docs. */
export class DiffPaneModel {
	readonly #doc = signal<DiffDocument | null>(null);
	readonly #highlights = signal<SyntaxHighlights | null>(null);
	readonly #streaming = signal<StreamingDocument | null>(null);
	/** Bumped when the streaming document grows in place. */
	readonly #streamVersion = signal(0);
	readonly #asset = signal<AssetDocument | null>(null);
	readonly #state = signal<DiffPaneState>("empty");
	readonly #emptyMessage = signal("No changes");
	readonly #mode = signal<ViewMode>("split");
	readonly #wrap = signal(false);
	readonly #patchTarget = signal<"stage" | "unstage" | null>(null);
	readonly #selectedHunk = signal(0);
	readonly #scrollTop = signal(0);
	readonly #scrollLeft = signal(0);
	readonly #focused = signal(false);
	readonly #cursor = signal(0);
	readonly #anchor = signal<number | null>(null);
	readonly #nativeScroll = signal<ScrollRequest | undefined>(undefined);
	#docVersion = 0;
	#lastWidth = 0;
	#lastHeight = 1;
	#layoutCache: { key: string; visuals: Visual[] } | undefined;
	#hits: (HeaderHit | undefined)[] = [];

	get doc(): DiffDocument | null {
		return this.#doc();
	}
	get highlights(): SyntaxHighlights | null {
		return this.#highlights();
	}
	get streaming(): StreamingDocument | null {
		this.#streamVersion();
		return this.#streaming();
	}
	get asset(): AssetDocument | null {
		return this.#asset();
	}
	get state(): DiffPaneState {
		return this.#state();
	}
	set state(value: DiffPaneState) {
		this.#state.set(value);
	}
	/** Message of the empty state. */
	get emptyMessage(): string {
		return this.#emptyMessage();
	}
	set emptyMessage(value: string) {
		this.#emptyMessage.set(value);
	}
	get mode(): ViewMode {
		return this.#mode();
	}
	set mode(value: ViewMode) {
		this.#mode.set(value);
	}
	get wrap(): boolean {
		return this.#wrap();
	}
	set wrap(value: boolean) {
		this.#wrap.set(value);
	}
	/** Which hunk buttons apply: staging (unstaged file), unstaging (staged file), or none. */
	get patchTarget(): "stage" | "unstage" | null {
		return this.#patchTarget();
	}
	set patchTarget(value: "stage" | "unstage" | null) {
		this.#patchTarget.set(value);
	}
	get selectedHunk(): number {
		return this.#selectedHunk();
	}
	set selectedHunk(value: number) {
		this.#selectedHunk.set(value);
	}
	get scrollTop(): number {
		return this.#scrollTop();
	}
	set scrollTop(value: number) {
		this.#scrollTop.set(value);
	}
	get scrollLeft(): number {
		return this.#scrollLeft();
	}
	set scrollLeft(value: number) {
		this.#scrollLeft.set(value);
	}
	/** The pane holds the keyboard: the cursor band shows at full strength. */
	get focused(): boolean {
		return this.#focused();
	}
	set focused(value: boolean) {
		this.#focused.set(value);
	}
	/** Cursor as a visual-row index. */
	get cursor(): number {
		return this.#cursor();
	}
	set cursor(value: number) {
		this.#cursor.set(value);
	}
	/** Shift-selection anchor (visual-row index), or null. */
	get anchor(): number | null {
		return this.#anchor();
	}
	set anchor(value: number | null) {
		this.#anchor.set(value);
	}

	/** The width and height the pane was last painted at (navigation measures by them). */
	measure(width: number, height: number): void {
		this.#lastWidth = width;
		this.#lastHeight = height;
		this.#hits = Array.from({ length: Math.max(0, height) });
	}

	/** Record the hunk buttons drawn on screen row `row`. */
	recordHit(row: number, hit: HeaderHit): void {
		this.#hits[row] = hit;
	}

	get #width(): number {
		return this.#lastWidth || 80;
	}

	// ── content ────────────────────────────────────────────────────────────

	setDocument(doc: DiffDocument | null, state: DiffPaneState): void {
		batch(() => {
			this.#docVersion++;
			this.#doc.set(doc);
			this.#highlights.set(null);
			this.#streaming.set(null);
			this.#asset.set(null);
			this.#state.set(state);
			this.#scrollTop.set(0);
			this.#scrollLeft.set(0);
			this.#selectedHunk.set(0);
			this.#cursor.set(0);
			this.#anchor.set(null);
			const mode = untrack(this.#mode);
			if (doc && mode !== "file" && mode !== "hunk") {
				// Open on the first change, in the upper third.
				const visuals = this.layout(this.#width);
				const first = visuals.findIndex(visual => visualKind(visual) !== "context");
				if (first > 0) {
					this.#cursor.set(first);
					this.#scrollTop.set(
						clampOffset(first - Math.floor(this.#lastHeight / 3), visuals.length, this.#lastHeight),
					);
				}
			}
		});
	}

	/** Show a media/binary comparison. */
	setAsset(filePath: string, old: FileAssetSide, next: FileAssetSide): void {
		batch(() => {
			this.setDocument(null, "asset");
			this.#asset.set({ filePath, old, new: next });
		});
	}

	/** Start a provisional view while the native differ ingests both sides. */
	startStream(filePath: string): void {
		batch(() => {
			this.setDocument(null, "streaming");
			this.#streaming.set({ filePath, oldLines: [], newLines: [], stableCommonLines: 0, maxLineWidth: 0 });
		});
	}

	/** Merge newly completed lines into the provisional view. */
	updateStream(update: FileStreamUpdate): void {
		const streaming = untrack(this.#streaming);
		if (!streaming) return;
		const oldLines = update.oldLines.map(displayLine);
		const newLines = update.newLines.map(displayLine);
		streaming.oldLines.splice(update.oldLineOffset, streaming.oldLines.length - update.oldLineOffset, ...oldLines);
		streaming.newLines.splice(update.newLineOffset, streaming.newLines.length - update.newLineOffset, ...newLines);
		for (const line of [...oldLines, ...newLines])
			streaming.maxLineWidth = Math.max(streaming.maxLineWidth, line.length);
		streaming.stableCommonLines = update.progress.stableCommonLines;
		batch(() => {
			this.#streamVersion.update(v => v + 1);
			this.#clampScroll();
		});
	}

	/** Syntax-highlight the document (both sides), yielding between batches. */
	async highlightAsync(signal: AbortSignal, onProgress?: () => void): Promise<void> {
		const doc = untrack(this.#doc);
		if (!doc || signal.aborted) return;
		const language = languageFromPath(doc.filePath);
		const sides = [
			{ lines: doc.oldDisplayLines, endsNewline: doc.oldEndsNewline },
			{ lines: doc.newDisplayLines, endsNewline: doc.newEndsNewline },
		].map(side => ({ ...side, highlighter: new Highlighter(language), out: [] as HighlightedLine[], offset: 0 }));
		if (!sides[0]!.highlighter.supported) return;
		const BATCH = 32;
		while (sides.some(side => side.offset < side.lines.length)) {
			if (signal.aborted || untrack(this.#doc) !== doc) return;
			for (const side of sides) {
				if (side.offset >= side.lines.length) continue;
				const end = Math.min(side.lines.length, side.offset + BATCH);
				const final = end === side.lines.length;
				const chunk = `${side.lines.slice(side.offset, end).join("\n")}${!final || side.endsNewline ? "\n" : ""}`;
				const lines = side.highlighter.push(chunk);
				if (!chunk.endsWith("\n")) lines.push(...side.highlighter.finish());
				for (let index = side.offset; index < end; index++) {
					side.out[index] = lines[index - side.offset] ?? [{ t: side.lines[index]! }];
				}
				side.offset = end;
			}
			this.#highlights.set({ old: [...sides[0]!.out], new: [...sides[1]!.out] });
			onProgress?.();
			if (sides.some(side => side.offset < side.lines.length)) await Bun.sleep(0);
		}
	}

	// ── view ───────────────────────────────────────────────────────────────

	setMode(mode: ViewMode): void {
		if (untrack(this.#mode) === mode) return;
		batch(() => {
			this.#mode.set(mode);
			this.#scrollTop.set(0);
			this.#scrollLeft.set(0);
			this.#cursor.set(0);
			this.#anchor.set(null);
			if (mode === "hunk") this.#selectedHunk.set(0);
		});
	}

	cycleMode(): void {
		const order: ViewMode[] = ["split", "inline", "hunk", "file"];
		this.setMode(order[(order.indexOf(untrack(this.#mode)) + 1) % order.length]!);
	}

	toggleWrap(): void {
		batch(() => {
			this.#wrap.update(on => !on);
			this.#scrollLeft.set(0);
		});
	}

	// ── layout ─────────────────────────────────────────────────────────────

	/** Text columns per side in the split view at `width`. */
	splitTextWidth(width: number): number {
		const gutter = untrack(this.#doc)?.gutterWidth ?? 4;
		return Math.max(8, Math.floor((width - 2 * (gutter + 2) - 1 - MINIMAP_COLUMNS) / 2));
	}

	/** Text columns of the inline and hunk views at `width`. */
	lineTextWidth(width: number): number {
		const gutter = untrack(this.#doc)?.gutterWidth ?? 4;
		return Math.max(8, width - 2 * (gutter + 1) - 3);
	}

	/** Text columns of the file view at `width`. */
	fileTextWidth(width: number): number {
		return Math.max(8, width - (untrack(this.#doc)?.gutterWidth ?? 4) - 1 - 2 - 2);
	}

	/** The visual rows of the document at `width`. */
	layout(width: number): Visual[] {
		const doc = this.#doc();
		const mode = this.#mode();
		const wrap = this.#wrap();
		if (!doc) return [];
		const key = `${this.#docVersion}\u0000${mode}\u0000${wrap}\u0000${width}`;
		if (this.#layoutCache?.key === key) return this.#layoutCache.visuals;
		const visuals: Visual[] = [];
		const segments = (textWidth: number, ...widths: number[]): number =>
			wrap ? Math.max(1, Math.ceil(Math.max(...widths, 1) / textWidth)) : 1;
		const lines = (row: DiffRow, rowIndex: number, textWidth: number): void => {
			if (row.kind === "change") {
				for (let seg = 0; seg < segments(textWidth, row.oldWidth); seg++)
					visuals.push({ t: "line", row, side: "old", seg, rowIndex });
				for (let seg = 0; seg < segments(textWidth, row.newWidth); seg++)
					visuals.push({ t: "line", row, side: "new", seg, rowIndex });
				return;
			}
			const side = row.kind === "del" ? "old" : row.kind === "add" ? "new" : "both";
			const rowWidth = side === "old" ? row.oldWidth : row.newWidth;
			for (let seg = 0; seg < segments(textWidth, rowWidth); seg++)
				visuals.push({ t: "line", row, side, seg, rowIndex });
		};
		switch (mode) {
			case "split": {
				const textWidth = this.splitTextWidth(width);
				doc.rows.forEach((row, rowIndex) => {
					for (let seg = 0; seg < segments(textWidth, row.oldWidth, row.newWidth); seg++)
						visuals.push({ t: "split", row, seg, rowIndex });
				});
				break;
			}
			case "inline": {
				const textWidth = this.lineTextWidth(width);
				doc.rows.forEach((row, rowIndex) => lines(row, rowIndex, textWidth));
				break;
			}
			case "hunk": {
				const textWidth = this.lineTextWidth(width);
				doc.hunks.forEach((hunk, index) => {
					visuals.push({ t: "header", hunk: index });
					for (const row of hunk.rows) lines(row, -1, textWidth);
					visuals.push({ t: "blank" });
				});
				break;
			}
			case "file": {
				const textWidth = this.fileTextWidth(width);
				doc.fileLines.forEach((line, index) => {
					const rowIndex = doc.rowIndexByNewLine[index + 1] ?? -1;
					for (let seg = 0; seg < segments(textWidth, line.width); seg++)
						visuals.push({ t: "file", index, seg, rowIndex });
				});
				break;
			}
		}
		this.#layoutCache = { key, visuals };
		return visuals;
	}

	// ── scrolling and the cursor ───────────────────────────────────────────

	/** Keyboard scroll requests for the native diff, whose viewport is sized by Tern. */
	get nativeScroll(): ScrollRequest | undefined {
		return this.#nativeScroll();
	}

	/** Forward a line or page step without assuming the native viewport's row count. */
	requestScroll(by: ScrollRequest["by"]): void {
		this.#nativeScroll.update(previous => ({ by, n: (previous?.n ?? 0) + 1 }));
	}

	#total(): number {
		if (untrack(this.#doc)) return untrack(() => this.layout(this.#width)).length;
		const streaming = untrack(this.#streaming);
		return streaming ? Math.max(streaming.oldLines.length, streaming.newLines.length) : 0;
	}

	/** Keep the offsets inside the content (called by every move and paint). */
	clampScroll(): void {
		untrack(() => this.#clampScroll());
	}

	#clampScroll(): void {
		const top = untrack(this.#scrollTop);
		const next = clampOffset(top, this.#total(), this.#lastHeight);
		if (next !== top) this.#scrollTop.set(next);
		const maxLineWidth = untrack(this.#doc)?.maxLineWidth ?? untrack(this.#streaming)?.maxLineWidth ?? 0;
		const maxLeft = untrack(this.#wrap) ? 0 : Math.max(0, maxLineWidth - 8);
		const left = untrack(this.#scrollLeft);
		const clamped = Math.max(0, Math.min(left, maxLeft));
		if (clamped !== left) this.#scrollLeft.set(clamped);
	}

	scrollBy(delta: number): void {
		batch(() => {
			this.#scrollTop.update(top => top + delta);
			this.#clampScroll();
		});
	}

	pageBy(direction: 1 | -1): void {
		this.scrollBy(direction * Math.max(1, this.#lastHeight - 2));
	}

	scrollLeftBy(delta: number): void {
		batch(() => {
			this.#scrollLeft.update(left => left + delta);
			this.#clampScroll();
		});
	}

	/** Move the cursor; `extend` grows the shift selection. */
	moveCursor(delta: number, extend: boolean): void {
		const total = this.#total();
		if (total === 0) return;
		batch(() => {
			if (!extend) this.#anchor.set(null);
			else if (untrack(this.#anchor) === null) this.#anchor.set(untrack(this.#cursor));
			const cursor = Math.max(0, Math.min(total - 1, untrack(this.#cursor) + delta));
			this.#cursor.set(cursor);
			this.#syncHunkToCursor();
			this.#scrollTop.set(offsetForRow(untrack(this.#scrollTop), cursor, total, this.#lastHeight));
			this.#clampScroll();
		});
	}

	/** Drop the shift selection; true when there was one. */
	clearSelection(): boolean {
		if (untrack(this.#anchor) === null) return false;
		this.#anchor.set(null);
		return true;
	}

	/** The selected span as indices into `doc.rows` (the cursor row alone without a selection). */
	get selection(): { from: number; to: number; explicit: boolean } | null {
		if (!untrack(this.#doc)) return null;
		const visuals = untrack(() => this.layout(this.#width));
		const cursor = untrack(this.#cursor);
		const anchor = untrack(this.#anchor);
		const a = anchor === null ? cursor : Math.min(anchor, cursor);
		const b = anchor === null ? cursor : Math.max(anchor, cursor);
		let from = Number.POSITIVE_INFINITY;
		let to = -1;
		for (let i = a; i <= b; i++) {
			const index = visualRowIndex(visuals[i]);
			if (index >= 0) {
				from = Math.min(from, index);
				to = Math.max(to, index);
			}
		}
		return to >= 0 ? { from, to, explicit: anchor !== null } : null;
	}

	/** Center the viewport on visual row `row` (minimap seek). */
	seekTo(row: number): void {
		batch(() => {
			this.#scrollTop.set(offsetForRow(untrack(this.#scrollTop), row, this.#total(), this.#lastHeight, true));
			this.#clampScroll();
		});
	}

	/** Jump to the next/previous change (hunk in the hunk view); false at the boundary. */
	jumpHunk(direction: 1 | -1): boolean {
		const doc = untrack(this.#doc);
		if (!doc || doc.hunks.length === 0) return false;
		const visuals = untrack(() => this.layout(this.#width));
		if (untrack(this.#mode) === "hunk") {
			const next = untrack(this.#selectedHunk) + direction;
			if (next < 0 || next >= doc.hunks.length) return false;
			this.#focusHunkHeader(next, visuals);
			return true;
		}
		const starts = this.#changeStarts(visuals);
		const cursor = untrack(this.#cursor);
		const next = direction > 0 ? starts.find(start => start > cursor) : starts.findLast(start => start < cursor);
		if (next === undefined) return false;
		this.#focusChange(next);
		return true;
	}

	/** Land on the first/last change (hunk navigation crossing files). */
	seekHunk(edge: "first" | "last"): void {
		const doc = untrack(this.#doc);
		if (!doc || doc.hunks.length === 0) return;
		const visuals = untrack(() => this.layout(this.#width));
		if (untrack(this.#mode) === "hunk") {
			this.#focusHunkHeader(edge === "first" ? 0 : doc.hunks.length - 1, visuals);
			return;
		}
		const starts = this.#changeStarts(visuals);
		if (starts.length > 0) this.#focusChange(edge === "first" ? starts[0]! : starts[starts.length - 1]!);
	}

	/** Cursor to the first/last row (home/end). */
	cursorToEdge(edge: "start" | "end"): void {
		const total = this.#total();
		if (total === 0) return;
		batch(() => {
			this.#anchor.set(null);
			const cursor = edge === "start" ? 0 : total - 1;
			this.#cursor.set(cursor);
			this.#syncHunkToCursor();
			this.#scrollTop.set(offsetForRow(untrack(this.#scrollTop), cursor, total, this.#lastHeight));
			this.#clampScroll();
		});
	}

	#focusHunkHeader(index: number, visuals: Visual[]): void {
		batch(() => {
			this.#selectedHunk.set(index);
			const header = visuals.findIndex(visual => visual.t === "header" && visual.hunk === index);
			if (header < 0) return;
			this.#cursor.set(header);
			this.#anchor.set(null);
			this.#scrollTop.set(clampOffset(header - 1, visuals.length, this.#lastHeight));
			this.#clampScroll();
		});
	}

	#syncHunkToCursor(): void {
		if (untrack(this.#mode) !== "hunk") return;
		const visuals = untrack(() => this.layout(this.#width));
		for (let row = untrack(this.#cursor); row >= 0; row--) {
			const visual = visuals[row];
			if (visual?.t === "header") {
				this.#selectedHunk.set(visual.hunk);
				return;
			}
		}
	}

	#changeKind(visual: Visual): VisualKind {
		if (visual.t !== "file") return visualKind(visual);
		const row = visual.rowIndex >= 0 ? untrack(this.#doc)?.rows[visual.rowIndex] : undefined;
		return row?.kind ?? "context";
	}

	#changeStarts(visuals: Visual[]): number[] {
		const starts: number[] = [];
		let inChange = false;
		visuals.forEach((visual, index) => {
			const kind = this.#changeKind(visual);
			const changed = kind !== "context" && kind !== null;
			if (changed && !inChange) starts.push(index);
			inChange = changed;
		});
		return starts;
	}

	#focusChange(row: number): void {
		batch(() => {
			this.#cursor.set(row);
			this.#anchor.set(null);
			this.#scrollTop.set(clampOffset(row - Math.floor(this.#lastHeight / 3), this.#total(), this.#lastHeight));
			this.#clampScroll();
		});
	}

	/** The selected hunk (hunk view). */
	get currentHunk(): HunkBlock | null {
		return untrack(this.#doc)?.hunks[untrack(this.#selectedHunk)] ?? null;
	}

	/** A left click at pane-local (`col`, `row`). */
	clickAt(col: number, row: number, shift = false): PaneClick {
		if (this.#lastWidth > 0 && col >= this.#lastWidth - MINIMAP_COLUMNS) {
			const total = this.#total();
			if (total > 0 && this.#lastHeight > 0) this.seekTo(Math.floor(((row + 0.5) / this.#lastHeight) * total));
			return { type: "handled" };
		}
		const doc = untrack(this.#doc);
		const hit = this.#hits[row];
		if (hit && doc) {
			const target = untrack(this.#patchTarget);
			batch(() => {
				this.#selectedHunk.set(hit.hunk);
				if (untrack(this.#mode) === "hunk") {
					this.#cursor.set(untrack(this.#scrollTop) + row);
					this.#anchor.set(null);
				}
			});
			if (hit.primary && col >= hit.primary[0] && col < hit.primary[1] && target) {
				return { type: "hunk-action", hunk: doc.hunks[hit.hunk]!, action: target };
			}
			if (hit.discard && col >= hit.discard[0] && col < hit.discard[1] && target === "stage") {
				return { type: "hunk-action", hunk: doc.hunks[hit.hunk]!, action: "discard" };
			}
			return { type: "handled" };
		}
		const visual = untrack(this.#scrollTop) + row;
		if (visual >= this.#total()) return null;
		batch(() => {
			if (!shift) this.#anchor.set(null);
			else if (untrack(this.#anchor) === null) this.#anchor.set(untrack(this.#cursor));
			this.#cursor.set(visual);
			this.#syncHunkToCursor();
		});
		return { type: "handled" };
	}
}
