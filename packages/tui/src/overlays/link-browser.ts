/**
 * Fullscreen extension link browser: the transcript replayed on the alternate screen, so links
 * that have scrolled into terminal scrollback (which omp cannot draw over) can be picked too.
 *
 * Each extension link label ({@link extensionLinkLabels}) on the rows in view gets a hint tag that
 * it keeps while it stays in view (see {@link LinkHints.update}); typing a whole tag, or a left click on
 * a label, picks its link. Arrows, Page Up/Down, Home/End and the wheel scroll; Esc closes; other
 * keys do nothing. The browser stays open after a pick, so an extension redrawing the reply
 * ({@link LinkBrowserComponent.rerenderMessage}) is seen in place.
 *
 * The transcript is a snapshot taken when the browser opens: a reply still streaming shows as far
 * as it had come. Like `/copy`, it replays the recent part of a long branch first, and the rest
 * once the view scrolls to its top.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageComponent } from "../chat/assistant-message";
import { ChatTranscriptBuilder } from "../chat/chat-transcript-builder";
import type { AssistantTextRenderer, MessageRenderer } from "../chat/extension-types";
import { TranscriptBrowser, type TranscriptBrowserFrame } from "../chat/transcript-browser";
import { recentTranscriptEntries, type TranscriptEntryLike as TranscriptEntry } from "../chat/transcript-entry";
import { composeOutlineColumn } from "../chat/transcript-outline";
import { matchesSelectCancel } from "../keybinding-matchers";
import { matchesKey, parseKey } from "../keys";
import { routeSgrMouseInput } from "../mouse";
import { extensionLinkLabels } from "../render/extension-links";
import { LinkHints } from "../render/link-hints";
import { theme } from "../theme/theme";
import { sliceByColumn } from "../utils";
import type { Component, TUI } from "../tui";

export interface LinkBrowserDeps {
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
	/** The extension assistant text renderers the transcript draws with, which may write the links. */
	textRenderers: readonly AssistantTextRenderer[];
	requestRender: () => void;
	/** A link was picked: raise `link_activate` for `url`. */
	onActivate: (url: string) => void;
	onClose: () => void;
}

export class LinkBrowserComponent implements Component {
	readonly #deps: LinkBrowserDeps;
	#builder: ChatTranscriptBuilder;
	readonly #browser: TranscriptBrowser;
	readonly #hints = new LinkHints();
	/** The last frame without tags: what a click is traced back through. */
	#frame: readonly string[] = [];
	/** Some row in view has more links than their tags could fit side by side, so none are drawn. */
	#crowded = false;
	/** Opens at the bottom; afterwards the scroll offset only moves on the user's request. */
	#scrollToEnd = true;
	/** The whole branch: only its recent part is replayed until the view reaches the top. */
	readonly #entries: TranscriptEntry[];
	/** Older entries are still unreplayed. */
	#truncated: boolean;
	/**
	 * Body rows the older history added above the rows replayed first. Hint tags key a label by
	 * its content row less these, so a label keeps its tag when history loads above it.
	 */
	#prependedRows = 0;
	/** Frame width of the last render, which a history load lays out at; 0 before the first. */
	#width = 0;
	/**
	 * Body rows held after a reply was redrawn, blank below the transcript if it shrank, so the
	 * scroll offset is not clamped and the rows above it stay put; dropped once the user scrolls or
	 * the body reaches it.
	 */
	#rowFloor = 0;

	constructor(entries: TranscriptEntry[], deps: LinkBrowserDeps) {
		this.#deps = deps;
		this.#entries = entries;
		const recent = recentTranscriptEntries(entries);
		this.#truncated = recent.length < entries.length;
		this.#builder = this.#replay(recent);
		// Not following the tail: a reply redrawn taller grows in place below the rows in view.
		this.#browser = new TranscriptBrowser({
			getHeight: () => deps.ui.terminal?.rows || process.stdout.rows || 40,
			frame: context => this.#compose(context.contentWidth),
		});
	}

	/**
	 * Whether the transcript draws any extension link at frame width `width`. The recent part is
	 * checked first; the whole branch is replayed only when that part has none.
	 */
	hasLinks(width: number): boolean {
		const contentWidth = Math.max(1, width - 1);
		const drawsLink = () => this.#body(contentWidth).some(row => extensionLinkLabels(row).length > 0);
		return drawsLink() || (this.#loadOlder() && drawsLink());
	}

	/**
	 * Redraw the browser's copy of the reply sent at `timestamp`, re-running the text renderers;
	 * returns whether it holds one. The rows above it stay where they are on screen, and the links
	 * below it keep their tags on the rows they move to.
	 */
	rerenderMessage(timestamp: number): boolean {
		const children = this.#builder.container.children;
		const contentWidth = Math.max(1, this.#width - 1);
		const heights = () => this.#browser.renderOutlineRows(children, contentWidth).map(rows => rows.length);
		const before = this.#width > 0 ? heights() : undefined;
		let redrawn = false;
		for (const child of children) {
			if (child instanceof AssistantMessageComponent && child.rerenderMessage(timestamp)) redrawn = true;
		}
		if (!redrawn) return false;
		if (before) {
			// The body row each resized reply ended on, and how far the rows from there on moved.
			const moves: { end: number; by: number }[] = [];
			let end = 0;
			let by = 0;
			for (const [index, height] of heights().entries()) {
				end += before[index]!;
				if (height === before[index]) continue;
				by += height - before[index]!;
				moves.push({ end, by });
			}
			// Tags key a label by its body row less the rows history loaded above.
			const prepended = this.#prependedRows;
			this.#hints.moveRows(row => row + (moves.findLast(move => row + prepended >= move.end)?.by ?? 0));
		}
		this.#rowFloor = this.#browser.visibleEnd;
		this.#deps.requestRender();
		return true;
	}

	invalidate(): void {
		this.#builder.container.invalidate();
		this.#browser.invalidate();
	}

	dispose(): void {
		this.#builder.dispose();
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					// Dropping the floor lets the offset settle within the transcript: draw that too.
					const moved = this.#browser.scroll(event.wheel * 3) || this.#rowFloor > 0;
					this.#rowFloor = 0;
					if (this.#loadOlderAtTop() || moved) this.#deps.requestRender();
				} else if (event.leftClick) {
					const url = extensionLinkLabels(this.#frame[event.row] ?? "").find(
						label => event.col >= label.start && event.col < label.end,
					)?.url;
					if (url !== undefined) this.#deps.onActivate(url);
				}
				return true;
			});
			return;
		}
		if (matchesKey(data, "escape") || matchesSelectCancel(data)) {
			this.#deps.onClose();
			return;
		}
		if (this.#browser.handleScrollKey(data)) {
			this.#rowFloor = 0;
			this.#loadOlderAtTop();
			this.#deps.requestRender();
			return;
		}
		const key = parseKey(data);
		if (this.#crowded || key === undefined || !/^[a-z]$/.test(key)) return;
		const picked = this.#hints.type(key);
		if (typeof picked === "object") this.#deps.onActivate(picked.url);
		this.#deps.requestRender();
	}

	render(width: number): readonly string[] {
		// A resize rewraps every row, so the rows above a redrawn reply cannot stay put anyway.
		if (width !== this.#width) this.#rowFloor = 0;
		this.#width = width;
		if (this.#scrollToEnd) {
			this.#scrollToEnd = false;
			this.#browser.render(width);
			this.#browser.scrollToBottom();
		}
		const contentWidth = Math.max(1, width - 1);
		let frame = this.#browser.render(width);
		// Without the scrollbar column: a label wrapped at the row's end must end its row to be
		// read as one link with its continuation below.
		this.#hints.update(
			frame.map(row => sliceByColumn(row, 0, contentWidth)),
			this.#browser.frameRowOffset - this.#prependedRows,
		);
		const crowded = this.#hints.crowded(contentWidth);
		if (crowded !== this.#crowded) {
			// The footer says why no tags are drawn; it takes the same row, so the labels stay put.
			this.#crowded = crowded;
			frame = this.#browser.render(width);
		}
		this.#frame = frame;
		// The last column is the scrollbar's: tags stay left of it.
		return crowded ? frame : this.#hints.paint(frame, contentWidth);
	}

	#replay(entries: TranscriptEntry[]): ChatTranscriptBuilder {
		const builder = new ChatTranscriptBuilder({
			ui: this.#deps.ui,
			getTool: this.#deps.getTool,
			isBuiltInTool: this.#deps.isBuiltInTool,
			getMessageRenderer: this.#deps.getMessageRenderer,
			cwd: this.#deps.cwd,
			hideThinkingBlock: this.#deps.hideThinkingBlock,
			proseOnlyThinking: this.#deps.proseOnlyThinking,
			expandThinkingBlocks: this.#deps.expandThinkingBlocks,
			linkTargets: this.#deps.linkTargets,
			textRenderers: this.#deps.textRenderers,
			requestRender: this.#deps.requestRender,
		});
		builder.rebuild(entries);
		return builder;
	}

	/** Replay the older history once the view has scrolled to the top of what is replayed. */
	#loadOlderAtTop(): boolean {
		return this.#browser.atTop && this.#loadOlder();
	}

	/**
	 * Replay the whole branch, keeping the rows in view where they are on screen; returns whether
	 * there was older history to load. Pays the full replay once, only when it is needed.
	 */
	#loadOlder(): boolean {
		if (!this.#truncated) return false;
		const contentWidth = Math.max(1, this.#width - 1);
		const before = this.#width > 0 ? this.#body(contentWidth).length : 0;
		const previous = this.#builder;
		this.#builder = this.#replay(this.#entries);
		previous.dispose();
		this.#truncated = false;
		this.#browser.invalidate();
		if (this.#width === 0) return true;
		const added = this.#body(contentWidth).length - before;
		this.#prependedRows += added;
		this.#browser.render(this.#width);
		this.#browser.scroll(added);
		return true;
	}

	/** The whole transcript's rows at `contentWidth`, indented as the other transcript browsers draw it. */
	#body(contentWidth: number): string[] {
		const children = this.#builder.container.children;
		const rows = this.#browser.renderOutlineRows(children, contentWidth);
		return composeOutlineColumn(rows, 0, children.length, [], -1, contentWidth, undefined).lines;
	}

	#compose(contentWidth: number): TranscriptBrowserFrame {
		const hint = this.#crowded
			? theme.fg("warning", "Too many links on one row to tag; widen the terminal · PgUp/PgDn scroll · Esc close")
			: theme.fg("dim", "Type a tag or click a link · PgUp/PgDn scroll · Esc close");
		const body = this.#body(contentWidth);
		if (body.length >= this.#rowFloor) this.#rowFloor = 0;
		else body.push(...Array<string>(this.#rowFloor - body.length).fill(""));
		return {
			header: [
				`${theme.bold("Extension links")}${theme.sep.dot}${theme.fg("dim", "pick one anywhere in the transcript")}`,
			],
			body: { lines: body },
			footer: [hint],
		};
	}
}
