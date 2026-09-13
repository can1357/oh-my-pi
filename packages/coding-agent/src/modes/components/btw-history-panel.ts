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
} from "@oh-my-pi/pi-tui";
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwTurns,
} from "../../session/btw-history";
import { getMarkdownTheme, type ThemeColor, theme } from "../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { sanitizeErrorLine } from "./error-block";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./extensions/display-text";
import { editorKey, rawKeyHint } from "./keybinding-hints";
import { bottomBorder, fit, row, splitBodyWidth, splitRow, topBorder } from "./overlay-box";
import { clampSelection, contentRowWidth, padLinesToHeight, renderScrollableList } from "./selector-helpers";

interface BtwHistoryPanelOptions {
	records: readonly BtwHistoryRecord[];
	onClose: () => void;
	onCopy: (record: BtwHistoryRecord) => void;
	onCancel: (record: BtwHistoryRecord) => void;
	canFollowUp?: (record: BtwHistoryRecord) => boolean;
	onFollowUp?: (record: BtwHistoryRecord, question: string, signal: AbortSignal) => Promise<boolean>;
	requestRender: () => void;
	getHeight: () => number;
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

const STATUS: Record<BtwHistoryRecord["status"], { label: string; color: ThemeColor }> = {
	running: { label: "Running", color: "accent" },
	complete: { label: "Complete", color: "success" },
	cancelled: { label: "Cancelled", color: "warning" },
	error: { label: "Error", color: "error" },
	interrupted: { label: "Interrupted", color: "warning" },
};

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
	readonly #detail = new ScrollView([], {
		height: 1,
		scrollbar: "auto",
		theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
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
		if (this.#composer && !records.some(record => record.id === this.#composer?.recordId)) {
			this.#composer = undefined;
		}
		if (!records.some(record => record.id === this.#selectedId)) {
			this.#selectedId = records[0]?.id;
			this.#listScroll = 0;
			this.#followLatest = false;
			this.#detail.scrollToTop();
		}
		this.#options.requestRender();
	}

	invalidate(): void {
		// Recreate Markdown with the current theme, retaining the viewport offset.
		this.#detailRecord = undefined;
		this.#turns = [];
		this.#composer?.input.invalidate();
		this.#detailDirty = true;
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

	#openComposer(record: BtwHistoryRecord): void {
		const input = new Input();
		input.prompt = theme.fg("accent", "Follow up: ");
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
				this.#followLatest = true;
			} else {
				composer.notice = "Follow-up was not started. Your draft is kept; Enter to retry.";
			}
		} catch {
			if (this.#composer === composer) {
				composer.notice = "Could not start the follow-up. Your draft is kept; Enter to retry.";
			}
		} finally {
			this.#followUpPending = false;
			this.#options.requestRender();
		}
	}

	/** Enhanced clipboard pastes belong only to the active composer. */
	pasteText(text: string): void {
		if (!this.#composer) return;
		this.#composer.input.pasteText(text);
		this.#options.requestRender();
	}
	handleInput(data: string): void {
		if (this.#composer) {
			// The input owns every key, including panel shortcuts and pasted text.
			this.#composer.input.handleInput(data);
			this.#options.requestRender();
			return;
		}
		const record = this.#selected();
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			if (record && getBtwLatestTurn(record).status === "running") this.#options.onCancel(record);
			else this.#options.onClose();
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
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "list" ? "answer" : "list";
		} else if (matchesKey(data, "right")) {
			this.#focus = "answer";
		} else if (matchesKey(data, "left")) {
			this.#focus = "list";
		} else if (this.#focus === "list") {
			const index = this.#selectedIndex();
			if (matchesSelectUp(data)) this.#select(index - 1);
			else if (matchesSelectDown(data)) this.#select(index + 1);
			else if (matchesSelectPageUp(data)) this.#select(index - this.#listHeight);
			else if (matchesSelectPageDown(data)) this.#select(index + this.#listHeight);
			else if (matchesKey(data, "home")) this.#select(0);
			else if (matchesKey(data, "end")) this.#select(this.#records.length - 1);
			else return;
		} else {
			if (matchesSelectUp(data)) this.#detail.scroll(-1);
			else if (matchesSelectDown(data)) this.#detail.scroll(1);
			else if (matchesSelectPageUp(data)) this.#detail.page(-1);
			else if (matchesSelectPageDown(data)) this.#detail.page(1);
			else if (!this.#detail.handleScrollKey(data)) return;
			this.#followLatest = matchesKey(data, "end");
		}
		this.#options.requestRender();
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
			lines.push(selected ? theme.bg("selectedBg", fit(text, contentWidth)) : truncateToWidth(text, contentWidth));
			if (rowSpan === 2) {
				const questionLine = `  ${selected ? theme.bold(snippet) : snippet}`;
				lines.push(selected ? theme.bg("selectedBg", fit(questionLine, contentWidth)) : questionLine);
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
		const wide = framed && width >= 96;
		const listWidth = Math.min(46, Math.floor(width * 0.42));
		const record = this.#selected();
		const composer = this.#composer;
		const latest = record ? getBtwLatestTurn(record) : undefined;
		const actions = composer
			? [rawKeyHint("Enter", this.#followUpPending ? "starting…" : "send"), rawKeyHint("Esc", "cancel")]
			: [rawKeyHint("Esc", latest?.status === "running" ? "cancel" : "close"), rawKeyHint("Tab", "switch pane")];
		if (!composer) {
			if (record && this.#canFollowUp(record)) actions.push(rawKeyHint("f/Enter", "follow up"));
			if (record && getBtwCopyText(record) !== undefined)
				actions.push(rawKeyHint("c", inner < 40 ? "copy" : "copy answer"));
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
		const detailWidth = wide ? splitBodyWidth(width, listWidth) : inner;
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
			lines.push(
				wide
					? splitRow(this.#focusLabel("list"), this.#focusLabel("answer"), width, listWidth)
					: row(this.#focusLabel(this.#focus), width),
			);
		} else if (height >= 3) {
			lines.push(truncateToWidth(this.#focusLabel(this.#focus), width));
		}
		if (wide) {
			const list = this.#renderList(listWidth, bodyHeight);
			for (let index = 0; index < bodyHeight; index++)
				lines.push(splitRow(list[index] ?? "", detail?.[index] ?? "", width, listWidth));
		} else {
			const body = this.#focus === "list" ? this.#renderList(inner, bodyHeight) : (detail ?? []);
			for (const line of padLinesToHeight(body, bodyHeight)) lines.push(framed ? row(line, width) : line);
		}
		for (const line of composerLines) lines.push(framed ? row(line, width) : line);
		if (framed) {
			if (showNavigation) {
				lines.push(
					row(
						rawKeyHint(
							`${editorKey("tui.select.up")}/${editorKey("tui.select.down")}`,
							this.#focus === "list" ? "select" : "scroll",
						),
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
