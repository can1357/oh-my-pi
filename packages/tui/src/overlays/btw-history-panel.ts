import {
	type Component,
	type Focusable,
	Input,
	Markdown,
	matchesKey,
	ScrollView,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../index";
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwTurns,
} from "./btw-history";
import { getMarkdownTheme, type ThemeColor, theme } from "../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import type { SpaceHoldHandler } from "../space-hold";
import { sanitizeErrorLine } from "../chrome/error-block";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./extensions/display-text";
import { editorKey, editorKeys, keyHint, rawKeyHint } from "../chrome/keybinding-hints";
import { formatKeyHint, type KeyId } from "../app-keybindings";
import { bottomBorder, row, topBorder } from "../chrome/overlay-box";
import { padToWidth } from "../render/utils";
import { SplitPane } from "../components/layout/split-pane";
import { clampSelection, contentRowWidth, padLinesToHeight, renderScrollableList } from "../chrome/selector-helpers";
import type { TspScrollBy, TspSpan } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { col, md, node, span, text } from "../native/describe";
import { actionBar, actionButton } from "../native/overlay";

interface BtwHistoryPanelOptions {
	records: readonly BtwHistoryRecord[];
	onClose: () => void;
	onCopy: (record: BtwHistoryRecord) => void;
	onCancel: (record: BtwHistoryRecord) => void;
	canFollowUp?: (record: BtwHistoryRecord) => boolean;
	onFollowUp?: (record: BtwHistoryRecord, question: string, signal: AbortSignal) => Promise<boolean>;
	/** Configured push-to-talk keys for a follow-up composer. */
	spaceHoldKeys?: readonly KeyId[];
	spaceHold?: (input: Input) => SpaceHoldHandler;
	requestRender: () => void;
	getHeight: () => number;
	/**
	 * Esc closes the panel even while the selected answer runs (it keeps
	 * streaming in the background) and `x` cancels it, instead of Esc cancelling
	 * first. For a host with no inline panel to fall back to (Tern).
	 */
	escapeHides?: boolean;
}

interface FollowUpComposer {
	recordId: string;
	input: Input;
	abortController: AbortController;
	notice?: string;
}

interface RenderedTurn {
	turn: BtwHistoryTurn;
	question: Markdown;
	answer: Markdown;
	lines: readonly string[];
	width: number;
}

/** The visible inputs of the last native description; any change rebuilds it. */
interface BtwHistoryNativeMemo {
	records: readonly BtwHistoryRecord[];
	selectedId: string | undefined;
	focus: "list" | "answer";
	focused: boolean;
	composer: FollowUpComposer | undefined;
	notice: string | undefined;
	followUpPending: boolean;
	canFollowUp: boolean;
	copied: boolean;
	scroll: NativeScroll | undefined;
	node: NativeNode;
}

const STATUS: Record<BtwHistoryRecord["status"], { label: string; color: ThemeColor }> = {
	running: { label: "Running", color: "accent" },
	complete: { label: "Complete", color: "success" },
	cancelled: { label: "Cancelled", color: "warning" },
	error: { label: "Error", color: "error" },
	interrupted: { label: "Interrupted", color: "warning" },
};

const SHEET = { role: "omp.overlay.btwHistory", anchor: "center", size: "lg", head: "BTW history" } as const;
const EMPTY_SHEET = { role: "omp.overlay.btwHistory", anchor: "center", size: "md", head: "BTW history" } as const;

/** A status worth naming next to an answer natively; an answered question needs none. */
function describeStatus(status: BtwHistoryTurn["status"]): TspSpan[] | undefined {
	switch (status) {
		case "running":
			return [span("●", "accent", { fx: "pulse" }), span(" Answering", "accent")];
		case "cancelled":
			return [span("Cancelled", "warning")];
		case "error":
			return [span("Failed", "error")];
		case "interrupted":
			return [span("Interrupted", "warning")];
		case "complete":
			return undefined;
	}
}

/** Session-local side questions. Selecting or copying never promotes them into chat. */
export class BtwHistoryPanel implements Component, Focusable {
	readonly #options: BtwHistoryPanelOptions;
	#records: readonly BtwHistoryRecord[] = [];
	#selectedId: string | undefined;
	#focus: "list" | "answer" = "list";
	#listScroll = 0;
	#listHeight = 1;
	#focused = false;
	#composer: FollowUpComposer | undefined;
	#followUpPending = false;
	#followLatest = false;
	#turns: RenderedTurn[] = [];
	#detailRecord: BtwHistoryRecord | undefined;
	#detailWidth = 0;
	#detailDirty = true;
	#lastCopiedId: string | undefined;
	#lastCopiedText: string | undefined;
	#native: BtwHistoryNativeMemo | undefined;
	/** The last answer-pane scroll key, forwarded natively (see {@link NativeNode.scroll}). */
	#scroll: NativeScroll | undefined;
	readonly #detail = new ScrollView([], {
		height: 1,
		scrollbar: "auto",
		theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
	});
	// Persistent two-pane layouts: the body (list + answer) and the one-row
	// pane focus labels above it. Both share sizing so divider geometry
	// matches; framed decorations apply only when the panel draws a frame.
	#listCache: readonly string[] = [];
	#detailCache: readonly string[] = [];
	#bodyHeightLast = 1;
	readonly #framePrefix = () => `${theme.fg("border", theme.boxRound.vertical)} `;
	readonly #frameDivider = () => ` ${theme.fg("border", theme.boxRound.vertical)} `;
	readonly #frameSuffix = () => ` ${theme.fg("border", theme.boxRound.vertical)}`;
	#listPaneLines = (_width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(0, Math.floor(height ?? this.#bodyHeightLast));
		return padLinesToHeight(this.#listCache, rows).slice(0, rows);
	};
	#detailPaneLines = (_width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(0, Math.floor(height ?? this.#bodyHeightLast));
		return padLinesToHeight(this.#detailCache, rows).slice(0, rows);
	};
	readonly #split = new SplitPane({
		left: this.#listPaneLines,
		right: this.#detailPaneLines,
		leftSize: { ratio: 0.42, max: 46 },
		splitAt: 96,
		narrowPane: "left",
	});
	readonly #labels = new SplitPane({
		left: () => [this.#focusLabel("list")],
		right: () => [this.#focusLabel("answer")],
		leftSize: { ratio: 0.42, max: 46 },
		splitAt: 96,
		narrowPane: "left",
		height: 1,
	});
	readonly #timeFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	readonly #dateFormat = new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});

	constructor(options: BtwHistoryPanelOptions) {
		this.#options = options;
		this.#records = options.records;
		this.#selectedId = options.records[0]?.id;
		if (options.records.length === 1) this.#focus = "answer";
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
	}

	update(records: readonly BtwHistoryRecord[]): void {
		this.#records = records;
		this.#detailDirty = true;
		const copied =
			this.#lastCopiedId !== undefined ? records.find(record => record.id === this.#lastCopiedId) : undefined;
		if (!copied || getBtwCopyText(copied) !== this.#lastCopiedText) {
			this.#lastCopiedId = undefined;
			this.#lastCopiedText = undefined;
		}
		if (this.#composer && !records.some(record => record.id === this.#composer?.recordId)) {
			this.#composer = undefined;
		}
		if (!records.some(record => record.id === this.#selectedId)) {
			this.#selectedId = records[0]?.id;
			this.#listScroll = 0;
			this.#followLatest = false;
			this.#detail.scrollToTop();
		}
		// One side question has nothing to pick: its answer keeps the arrow keys.
		if (records.length === 1) this.#focus = "answer";
		this.#options.requestRender();
	}

	/** Visual confirmation that `c` copied this record's answer to the clipboard. */
	markCopied(recordId: string, text: string): void {
		this.#lastCopiedId = recordId;
		this.#lastCopiedText = text;
		this.#detailDirty = true;
		this.#options.requestRender();
	}

	/** The confirmation survives only while the record still holds the copied text. */
	#isCopied(record: BtwHistoryRecord): boolean {
		return record.id === this.#lastCopiedId && getBtwCopyText(record) === this.#lastCopiedText;
	}

	invalidate(): void {
		// Recreate Markdown with the current theme, retaining the viewport offset.
		this.#detailRecord = undefined;
		this.#turns = [];
		this.#composer?.input.invalidate();
		this.#detailDirty = true;
		this.#native = undefined;
		this.#split.invalidate();
		this.#labels.invalidate();
	}

	#selectedIndex(): number {
		return Math.max(
			0,
			this.#records.findIndex(record => record.id === this.#selectedId),
		);
	}

	#selected(): BtwHistoryRecord | undefined {
		return this.#records[this.#selectedIndex()];
	}

	#select(index: number): void {
		const record = this.#records[Math.max(0, Math.min(index, this.#records.length - 1))];
		if (!record || record.id === this.#selectedId) return;
		this.#selectedId = record.id;
		this.#followLatest = false;
		this.#detail.scrollToTop();
	}

	#canFollowUp(record: BtwHistoryRecord): boolean {
		return !this.#followUpPending && !!this.#options.onFollowUp && !!this.#options.canFollowUp?.(record);
	}

	openFollowUp(recordId: string): boolean {
		if (this.#composer) return false;
		const index = this.#records.findIndex(record => record.id === recordId);
		const record = this.#records[index];
		if (!record || !this.#canFollowUp(record)) return false;
		this.#select(index);
		this.#openComposer(record);
		return true;
	}

	/** Select a record with its answer pane focused, read from the top (a just-asked /btw). */
	showRecord(recordId: string): void {
		const index = this.#records.findIndex(record => record.id === recordId);
		if (index === -1) return;
		this.#select(index);
		this.#focus = "answer";
		this.#options.requestRender();
	}

	/**
	 * Jump the answer pane to its bottom once (opening or sending a follow-up):
	 * text mode keeps following the newest row at render until a scroll key;
	 * natively the sheet body scrolls to its end. Tern reports no wheel scroll,
	 * so streamed updates never re-pin it there and a reader is never yanked.
	 */
	#jumpToEnd(): void {
		this.#followLatest = true;
		this.#scroll = { by: "end", n: (this.#scroll?.n ?? 0) + 1 };
	}

	#openComposer(record: BtwHistoryRecord): void {
		const input = new Input();
		input.prompt = theme.fg("accent", "Follow up: ");
		input.placeholder = "Ask about this answer…";
		if (this.#options.spaceHoldKeys !== undefined) input.spaceHold.keys = this.#options.spaceHoldKeys;
		input.spaceHold.handler = this.#options.spaceHold?.(input);
		const composer: FollowUpComposer = { recordId: record.id, input, abortController: new AbortController() };
		input.onEscape = () => {
			composer.abortController.abort();
			this.#composer = undefined;
		};
		input.onSubmit = value => {
			void this.#submitFollowUp(composer, value);
		};
		this.#composer = composer;
		this.#focus = "answer";
		// Following up reads from the newest turn, right above the composer.
		this.#jumpToEnd();
		this.#options.requestRender();
	}

	async #submitFollowUp(composer: FollowUpComposer, value: string): Promise<void> {
		if (this.#followUpPending || this.#composer !== composer) return;
		const question = value.trim();
		if (!question) {
			composer.notice = "Enter a follow-up question.";
			return;
		}
		const record = this.#records.find(record => record.id === composer.recordId);
		if (!record || !this.#canFollowUp(record)) {
			composer.notice = "A BTW request is busy. Try again when it finishes.";
			return;
		}
		this.#followUpPending = true;
		composer.notice = "Starting follow-up…";
		this.#options.requestRender();
		try {
			const accepted = await this.#options.onFollowUp!(record, question, composer.abortController.signal);
			if (this.#composer !== composer) return;
			if (accepted) {
				this.#composer = undefined;
				this.#selectedId = composer.recordId;
				this.#focus = "answer";
				this.#jumpToEnd();
			} else {
				composer.notice = `Follow-up was not started. Your draft is kept; ${editorKey("tui.input.submit")} to retry.`;
			}
		} catch {
			if (this.#composer === composer) {
				composer.notice = `Could not start the follow-up. Your draft is kept; ${editorKey("tui.input.submit")} to retry.`;
			}
		} finally {
			this.#followUpPending = false;
			this.#options.requestRender();
		}
	}

	/** Only an active follow-up composer can claim its configured push-to-talk keys. */
	capturesInput(data: string): boolean {
		return this.#composer?.input.capturesInput(data) ?? false;
	}

	/** Enhanced clipboard pastes belong only to the active composer. */
	pasteText(text: string): void {
		if (!this.#composer) return;
		this.#composer.input.pasteText(text);
		this.#options.requestRender();
	}
	handleInput(data: string): void {
		if (this.#composer) {
			// The input owns every key it handles, including panel shortcuts and
			// pasted text; the line keys it ignores still scroll the answer above.
			if (!this.#composer.input.handleInput(data)) this.#scrollDetail(data);
			this.#options.requestRender();
			return;
		}
		const record = this.#selected();
		const running = record !== undefined && getBtwLatestTurn(record).status === "running" ? record : undefined;
		const hides = this.#options.escapeHides === true;
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			if (running && !hides) this.#options.onCancel(running);
			else this.#options.onClose();
			return;
		}
		if (hides && matchesKey(data, "x")) {
			if (running) this.#options.onCancel(running);
			return;
		}
		if (matchesKey(data, "f") || matchesKey(data, "enter")) {
			if (record) this.openFollowUp(record.id);
			return;
		}
		if (matchesKey(data, "c")) {
			if (record && getBtwCopyText(record) !== undefined) this.#options.onCopy(record);
			return;
		}
		// Legacy terminals deliver Ctrl+/ (and Ctrl+_) as US without Kitty protocol.
		if (
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab") ||
			matchesKey(data, "ctrl+/") ||
			matchesKey(data, "ctrl+_") ||
			data === String.fromCharCode(31)
		) {
			// One side question has nothing to pick: its answer keeps the arrow keys.
			if (this.#records.length > 1) this.#focus = this.#focus === "list" ? "answer" : "list";
		} else if (matchesKey(data, "right")) {
			this.#focus = "answer";
		} else if (matchesKey(data, "left")) {
			if (this.#records.length > 1) this.#focus = "list";
		} else if (this.#focus === "list") {
			const index = this.#selectedIndex();
			if (matchesSelectUp(data)) this.#select(index - 1);
			else if (matchesSelectDown(data)) this.#select(index + 1);
			else if (matchesSelectPageUp(data)) this.#select(index - this.#listHeight);
			else if (matchesSelectPageDown(data)) this.#select(index + this.#listHeight);
			else if (matchesKey(data, "home")) this.#select(0);
			else if (matchesKey(data, "end")) this.#select(this.#records.length - 1);
			else return;
		} else if (!this.#scrollDetail(data)) {
			return;
		}
		this.#options.requestRender();
	}

	/** Apply an answer-pane scroll key; a scroll stops following the newest row unless it is End. */
	#scrollDetail(data: string): boolean {
		const by: TspScrollBy | undefined = matchesSelectUp(data)
			? "line-up"
			: matchesSelectDown(data)
				? "line-down"
				: matchesSelectPageUp(data)
					? "page-up"
					: matchesSelectPageDown(data)
						? "page-down"
						: matchesKey(data, "home")
							? "start"
							: matchesKey(data, "end")
								? "end"
								: undefined;
		if (by === "line-up") this.#detail.scroll(-1);
		else if (by === "line-down") this.#detail.scroll(1);
		else if (by === "page-up") this.#detail.page(-1);
		else if (by === "page-down") this.#detail.page(1);
		else if (!this.#detail.handleScrollKey(data)) return false;
		if (by) this.#scroll = { by, n: (this.#scroll?.n ?? 0) + 1 };
		this.#followLatest = matchesKey(data, "end");
		return true;
	}

	/** A large glass sheet (the list beside the reader), palette-sized while there is nothing to list. */
	get nativeOverlay(): NonNullable<Component["nativeOverlay"]> {
		return this.#records.length > 0 ? SHEET : EMPTY_SHEET;
	}

	describe(): NativeNode {
		const record = this.#selected();
		const composer = this.#composer;
		const canFollowUp = record !== undefined && this.#canFollowUp(record);
		const copied = record !== undefined && this.#isCopied(record);
		const memo = this.#native;
		if (
			memo?.records === this.#records &&
			memo.selectedId === this.#selectedId &&
			memo.focus === this.#focus &&
			memo.focused === this.#focused &&
			memo.composer === composer &&
			memo.notice === composer?.notice &&
			memo.followUpPending === this.#followUpPending &&
			memo.canFollowUp === canFollowUp &&
			memo.copied === copied &&
			memo.scroll === this.#scroll
		) {
			return memo.node;
		}
		// The body row fills the sheet: the list and the reader scroll on their own,
		// so the list stays put while a long answer scrolls. Plain columns, not
		// `section`s (Tern draws those as foldable `##` headings). With one side
		// question the list is noise: the reader alone.
		const children: NativeChild[] = [];
		if (record) {
			const reader: NativeNode = {
				...node(
					"col",
					{ role: "omp.btw.reader", grow: 1, basis: 0, min: { w: 0 } },
					[this.#describeThread(record)],
					"details",
				),
				// Arrow/page keys on the answer pane move its scroller.
				scroll: this.#scroll,
			};
			const panes = this.#records.length > 1 ? [this.#describeList(), reader] : [reader];
			children.push(node("row", { role: "omp.btw.body" }, panes, "body"));
		} else {
			children.push(this.#describeEmpty());
		}
		children.push(this.#describeActions(record, canFollowUp, copied));
		// The sheet is the frame (`nativeOverlay`); its last row is the pinned footer.
		const described = col(children, { gap: "none" });
		this.#native = {
			records: this.#records,
			selectedId: this.#selectedId,
			focus: this.#focus,
			focused: this.#focused,
			composer,
			notice: composer?.notice,
			followUpPending: this.#followUpPending,
			canFollowUp,
			copied,
			scroll: this.#scroll,
			node: described,
		};
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action") {
			const record = this.#selected();
			switch (event.act) {
				case "close":
					this.#options.onClose();
					return;
				case "copy-answer":
					if (record && getBtwCopyText(record) !== undefined) this.#options.onCopy(record);
					break;
				case "follow-up":
					if (record) this.openFollowUp(record.id);
					break;
				case "stop":
					if (record && getBtwLatestTurn(record).status === "running") this.#options.onCancel(record);
					break;
				case "send":
					this.#composer?.input.submit();
					break;
				case "discard":
					this.#composer?.input.onEscape?.();
					break;
				default:
					return;
			}
			this.#options.requestRender();
			return;
		}
		if ((event.type !== "select" && event.type !== "activate") || this.#composer) return;
		const index = this.#records.findIndex(record => record.id === event.item);
		if (index === -1) return;
		this.#select(index);
		this.#focus = "list";
		// Enter on a history row opens the follow-up composer.
		if (event.type === "activate") this.openFollowUp(event.item);
		this.#options.requestRender();
	}

	/**
	 * The questions, newest first, as two-line palette rows: the question, then
	 * its time, follow-up count and any status other than answered. While the
	 * reader has the keys the selection rests (`omp.btw.list.idle`).
	 */
	#describeList(): NativeNode {
		const items = this.#records.map(record => {
			const followUps = record.followUps?.length ?? 0;
			const detail: TspSpan[] = [span(this.#timeFormat.format(record.createdAt), "mono")];
			if (followUps > 0) detail.push(span(` · ${followUps} follow-up${followUps === 1 ? "" : "s"}`));
			const status = describeStatus(getBtwLatestTurn(record).status);
			// The question is markdown: its `code` reads as mono, without the backticks.
			const label = sanitizeDisplayLine(record.question)
				.split(/`([^`]+)`/)
				.flatMap((part, index) => (part ? [span(part, index % 2 === 1 ? "mono" : undefined)] : []));
			return node("item", { label, detail, ...(status ? { value: status } : {}) }, undefined, record.id);
		});
		const role = this.#focus === "list" ? "omp.btw.list" : "omp.btw.list.idle";
		return node(
			"col",
			{ role: "omp.btw.history", shrink: 0 },
			[node("list", { role, selected: this.#selectedId ?? null }, items, "records")],
			"history",
		);
	}

	/** The selected side question as a short document: the asked question titles each answer. */
	#describeThread(record: BtwHistoryRecord): NativeNode {
		const turns = getBtwTurns(record);
		const children: NativeChild[] = turns.map((turn, index) => this.#describeTurn(turn, index, `turn-${index}`));
		if (this.#composer) children.push(this.#describeComposer(this.#composer));
		return node("col", { role: "omp.btw.thread" }, children, "thread");
	}

	#describeTurn(turn: BtwHistoryTurn, index: number, key: string): NativeNode {
		const meta: TspSpan[] =
			index === 0
				? [span(this.#dateFormat.format(turn.createdAt))]
				: [span("Follow-up · "), span(this.#timeFormat.format(turn.createdAt))];
		const status = describeStatus(turn.status);
		if (status) meta.push(span("  ·  "), ...status);
		// The question stays markdown so its inline code and links render.
		const children: NativeChild[] = [
			md(sanitizeDisplayText(turn.question), { role: index === 0 ? "omp.btw.question" : "omp.btw.followup" }),
			text(meta, { role: "omp.btw.meta", truncate: "end", lines: 1 }),
		];
		// A failed turn with no text says only why it failed.
		if (turn.answer.trim() || !turn.error) {
			const answer = turn.answer.trim()
				? md(sanitizeDisplayText(turn.answer), { stream: turn.status === "running" })
				: text([span(turn.status === "running" ? "Thinking…" : "No answer text.", "dim")], {
						role: "omp.btw.pending",
					});
			children.push(node("col", { role: "omp.btw.answer" }, [answer], "answer"));
		}
		if (turn.error) {
			children.push(text([span(sanitizeErrorLine(turn.error), "error")], { role: "omp.btw.error", wrap: "word" }));
		}
		if (turn.status === "interrupted") {
			children.push(text([span("Not resumed in this view.", "muted")], { role: "omp.btw.note" }));
		}
		return node("col", { role: "omp.btw.turn" }, children, key);
	}

	/** The follow-up field under the newest answer, where the conversation continues. */
	#describeComposer(composer: FollowUpComposer): NativeNode {
		composer.input.focused = this.#focused;
		const children: NativeChild[] = [composer.input];
		if (composer.notice) {
			children.push(
				text([span(composer.notice, this.#followUpPending ? "dim" : "warning")], {
					role: "omp.btw.notice",
					wrap: "word",
				}),
			);
		}
		return node("col", { role: "omp.btw.composer", gap: "sm" }, children, "composer");
	}

	#describeEmpty(): NativeNode {
		return node(
			"col",
			{ role: "omp.btw.empty", align: "center", gap: "sm" },
			[
				text("No side questions yet", { role: "omp.btw.empty.title" }),
				text(
					[
						span("Ask one with "),
						span("/btw <question>", "code"),
						span(". The answer stays out of the main conversation."),
					],
					{ role: "omp.btw.empty.hint", wrap: "word" },
				),
			],
			"empty",
		);
	}

	/**
	 * The footer: what the selected answer allows on the left, Close and the one
	 * primary action (Follow up, or Send while composing) in the corner. Keys
	 * live in the buttons' tooltips.
	 */
	#describeActions(record: BtwHistoryRecord | undefined, canFollowUp: boolean, copied: boolean): NativeNode {
		if (this.#composer) {
			return actionBar([
				null,
				actionButton("Cancel", "discard", { keys: "escape" }),
				actionButton(this.#followUpPending ? "Sending…" : "Send", "send", { keys: "enter", tone: "accent" }),
			]);
		}
		const running = record !== undefined && getBtwLatestTurn(record).status === "running";
		const hides = this.#options.escapeHides === true;
		const buttons: (NativeNode | null)[] = [];
		if (running) buttons.push(actionButton("Stop answer", "stop", { keys: hides ? "x" : "escape" }));
		if (record && getBtwCopyText(record) !== undefined) {
			buttons.push(actionButton(copied ? "Copy again" : "Copy answer", "copy-answer", { keys: "c" }));
			if (copied) buttons.push(text([span("✓ Copied", "success")], { role: "omp.btw.copied" }));
		}
		buttons.push(null);
		// Clicking Close always dismisses the sheet; its tooltip names Esc only where Esc does too.
		buttons.push(actionButton("Close", "close", running && !hides ? undefined : { keys: "escape" }));
		if (canFollowUp) buttons.push(actionButton("Follow up", "follow-up", { keys: "f", tone: "accent" }));
		return actionBar(buttons);
	}

	#renderList(width: number, height: number): readonly string[] {
		const rowSpan = width < 36 && height >= 2 ? 2 : 1;
		this.#listHeight = Math.max(1, Math.floor(height / rowSpan));
		if (this.#records.length === 0) {
			return new Text(theme.fg("muted", "No side questions yet.\n\nUse /btw QUESTION to start one."), 0, 0)
				.render(width)
				.slice(0, height);
		}
		const selectedIndex = this.#selectedIndex();
		const selection = clampSelection(selectedIndex, this.#listScroll, this.#records.length, this.#listHeight);
		this.#listScroll = Math.min(selection.scrollOffset, Math.max(0, this.#records.length - this.#listHeight));
		const contentWidth = contentRowWidth(width, this.#records.length * rowSpan, height);
		const lines: string[] = [];
		for (
			let index = this.#listScroll;
			index < Math.min(this.#records.length, this.#listScroll + this.#listHeight);
			index++
		) {
			const record = this.#records[index]!;
			const selected = index === selectedIndex;
			const status = STATUS[getBtwLatestTurn(record).status];
			const cursor = selected ? theme.fg(this.#focus === "list" ? "accent" : "muted", theme.nav.cursor) : " ";
			const time = theme.fg("dim", this.#timeFormat.format(record.createdAt));
			const badge = theme.fg(status.color, status.label);
			const prefix = `${cursor} ${time} ${badge} `;
			const question = sanitizeDisplayLine(record.question);
			const snippet = truncateToWidth(
				question,
				Math.max(0, contentWidth - (rowSpan === 2 ? 2 : visibleWidth(prefix))),
			);
			const text = rowSpan === 2 ? prefix : `${prefix}${selected ? theme.bold(snippet) : snippet}`;
			lines.push(
				selected
					? theme.bg("selectedBg", contentWidth > 0 ? padToWidth(text, contentWidth) : "")
					: truncateToWidth(text, contentWidth),
			);
			if (rowSpan === 2) {
				const questionLine = `  ${selected ? theme.bold(snippet) : snippet}`;
				lines.push(
					selected
						? theme.bg("selectedBg", contentWidth > 0 ? padToWidth(questionLine, contentWidth) : "")
						: questionLine,
				);
			}
		}
		return renderScrollableList(padLinesToHeight(lines, height), {
			width,
			totalRows: this.#records.length * rowSpan,
			scrollOffset: this.#listScroll * rowSpan,
		});
	}

	#renderTurn(turn: BtwHistoryTurn, cached: RenderedTurn | undefined, width: number): RenderedTurn {
		const previous = cached?.turn;
		if (
			cached &&
			cached.width === width &&
			turn.question === previous?.question &&
			turn.answer === previous?.answer &&
			turn.status === previous?.status &&
			turn.error === previous?.error &&
			turn.createdAt === previous?.createdAt
		) {
			return cached;
		}
		const question = cached?.question ?? new Markdown("", 0, 0, getMarkdownTheme());
		const answer = cached?.answer ?? new Markdown("", 0, 0, getMarkdownTheme());
		if (turn.question !== previous?.question) question.setText(sanitizeDisplayText(turn.question));
		if (turn.answer !== previous?.answer) answer.setText(sanitizeDisplayText(turn.answer));
		const status = STATUS[turn.status];
		const lines = [
			...wrapTextWithAnsi(
				theme.fg(status.color, `${status.label} · ${this.#dateFormat.format(turn.createdAt)}`),
				width,
			),
			"",
			theme.bold(theme.fg("accent", "Question")),
			...question.render(width),
			"",
			theme.bold(theme.fg("accent", "Answer")),
		];
		if (turn.answer.trim()) lines.push(...answer.render(width));
		else
			lines.push(
				...wrapTextWithAnsi(
					theme.fg("dim", turn.status === "running" ? "Waiting for response…" : "No answer text."),
					width,
				),
			);
		if (turn.error) lines.push("", ...wrapTextWithAnsi(theme.fg("error", sanitizeErrorLine(turn.error)), width));
		if (turn.status === "interrupted")
			lines.push("", ...wrapTextWithAnsi(theme.fg("muted", "Not resumed in this view."), width));
		return {
			turn: {
				question: turn.question,
				answer: turn.answer,
				status: turn.status,
				error: turn.error,
				createdAt: turn.createdAt,
				updatedAt: turn.updatedAt,
			},
			question,
			answer,
			lines,
			width,
		};
	}

	#renderDetail(width: number, height: number): readonly string[] {
		const record = this.#selected();
		if (record?.id !== this.#detailRecord?.id) this.#turns = [];
		if (this.#detailDirty || record !== this.#detailRecord || this.#detailWidth !== width) {
			const inner = Math.max(1, width - 1);
			const lines: string[] = [];
			if (record && this.#isCopied(record)) {
				lines.push(...wrapTextWithAnsi(theme.fg("success", "✓ Copied to clipboard"), inner), "");
			}
			if (record) {
				const turns = getBtwTurns(record);
				for (let index = 0; index < turns.length; index++) {
					const cached = this.#renderTurn(turns[index]!, this.#turns[index], inner);
					this.#turns[index] = cached;
					if (index > 0) lines.push("", theme.fg("dim", theme.boxRound.horizontal.repeat(inner)), "");
					lines.push(...cached.lines);
				}
				this.#turns.length = turns.length;
			} else {
				lines.push(
					...wrapTextWithAnsi(theme.fg("muted", "No side questions yet. Use /btw QUESTION to start one."), inner),
				);
			}
			this.#detailRecord = record;
			this.#detail.setLines(lines);
			this.#detailWidth = width;
			this.#detailDirty = false;
		}
		this.#detail.setHeight(height);
		return this.#detail.render(width);
	}

	#focusLabel(focus: "list" | "answer"): string {
		const label = focus === "list" ? `History (${this.#records.length})` : "Details";
		return this.#focus === focus
			? theme.bold(theme.fg("accent", `${theme.nav.cursor} ${label}`))
			: theme.fg("muted", `  ${label}`);
	}

	render(width: number): readonly string[] {
		const height = Math.max(0, Math.floor(this.#options.getHeight()));
		width = Math.max(0, Math.floor(width));
		if (width === 0 || height === 0) return [];
		const framed = width >= 12 && height >= 8;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const narrowPane = this.#focus === "answer" ? "right" : "left";
		const framePrefix = framed ? this.#framePrefix : undefined;
		const frameDivider = framed ? this.#frameDivider : undefined;
		const frameSuffix = framed ? this.#frameSuffix : undefined;
		this.#split.setNarrowPane(narrowPane);
		this.#split.setDecorations(framePrefix, frameDivider, frameSuffix);
		this.#labels.setNarrowPane(narrowPane);
		this.#labels.setDecorations(framePrefix, frameDivider, frameSuffix);
		const geometry = framed ? this.#split.measure(width) : undefined;
		const wide = geometry?.mode === "split";
		const listWidth = wide && geometry?.left ? geometry.left.width : inner;
		const record = this.#selected();
		const composer = this.#composer;
		const latest = record ? getBtwLatestTurn(record) : undefined;
		const running = latest?.status === "running";
		const actions = composer
			? [
					keyHint("tui.input.submit", this.#followUpPending ? "starting…" : "send"),
					keyHint("tui.select.cancel", "cancel"),
				]
			: [
					keyHint("tui.select.cancel", running && !this.#options.escapeHides ? "cancel" : "close"),
					...(running && this.#options.escapeHides ? [rawKeyHint("x", "cancel")] : []),
					...(this.#records.length > 1 ? [rawKeyHint(["tab", "ctrl+/"], "switch pane")] : []),
				];
		if (!composer) {
			if (record && this.#canFollowUp(record)) actions.push(rawKeyHint(["f", "enter"], "follow up"));
			if (record && getBtwCopyText(record) !== undefined) {
				if (this.#isCopied(record))
					actions.push(theme.fg("success", `✓ copied · ${formatKeyHint("c")} to copy again`));
				else actions.push(rawKeyHint("c", inner < 40 ? "copy" : "copy answer"));
			}
		}
		const actionLines = wrapTextWithAnsi(actions.join(" · "), inner).slice(0, framed ? 2 : 1);
		const chrome = framed ? 3 + actionLines.length : height >= 3 ? 2 : 0;
		const composerLines: string[] = [];
		if (composer) {
			const availableRows = Math.max(1, height - chrome - 1);
			if (availableRows >= 2) {
				composerLines.push(
					theme.fg("dim", truncateToWidth(`Topic: ${sanitizeDisplayLine(record?.question ?? "")}`, inner)),
				);
			}
			if (composer.notice && availableRows >= 3) {
				composerLines.push(
					theme.fg(this.#followUpPending ? "dim" : "warning", truncateToWidth(composer.notice, inner)),
				);
			}
			composer.input.focused = this.#focused;
			composerLines.push(...composer.input.render(inner));
		}
		let bodyHeight = Math.max(composer ? 0 : 1, height - chrome - composerLines.length);
		const detailWidth = wide && geometry?.right ? geometry.right.width : inner;
		const detailScroll = this.#detail.getScrollOffset();
		let detail = wide || this.#focus === "answer" ? this.#renderDetail(detailWidth, bodyHeight) : undefined;
		const showNavigation = framed && !composer && (this.#focus === "list" || this.#detail.getMaxScrollOffset() > 0);
		if (showNavigation) {
			bodyHeight = Math.max(1, bodyHeight - 1);
			if (detail) {
				// Measuring without a footer can clamp the last row off an End jump.
				this.#detail.setHeight(bodyHeight);
				this.#detail.setScrollOffset(detailScroll);
				detail = this.#detail.render(detailWidth);
			}
		}
		if (detail && this.#followLatest) {
			this.#detail.scrollToBottom();
			detail = this.#detail.render(detailWidth);
		}
		const lines: string[] = [];
		if (framed) {
			lines.push(topBorder(width, "BTW history"));
			lines.push(this.#labels.render(width)[0] ?? "");
		} else if (height >= 3) {
			lines.push(truncateToWidth(this.#focusLabel(this.#focus), width));
		}
		if (framed) {
			this.#bodyHeightLast = bodyHeight;
			this.#detailCache = detail ?? [];
			this.#listCache = wide || this.#focus === "list" ? this.#renderList(listWidth, bodyHeight) : [];
			this.#split.setHeight(bodyHeight);
			lines.push(...this.#split.render(width));
		} else {
			const body = this.#focus === "list" ? this.#renderList(inner, bodyHeight) : (detail ?? []);
			for (const line of padLinesToHeight(body, bodyHeight)) lines.push(framed ? row(line, width) : line);
		}
		for (const line of composerLines) lines.push(framed ? row(line, width) : line);
		if (framed) {
			if (showNavigation) {
				lines.push(
					row(
						theme.fg("dim", editorKeys("tui.select.up", "tui.select.down")) +
							theme.fg("muted", ` ${this.#focus === "list" ? "select" : "scroll"}`),
						width,
					),
				);
			}
			for (const line of actionLines) lines.push(row(line, width));
			lines.push(bottomBorder(width));
		} else if (height >= 3) {
			lines.push(actionLines[0] ?? "");
		}
		return lines.slice(0, height).map(line => truncateToWidth(line, width));
	}
}
