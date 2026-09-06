import {
	type Component,
	Ellipsis,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	ScrollView,
	type Tab,
	TabBar,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type {
	ExtensionAskDialogOption,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResultItem,
	ExtensionAskDialogSubmitResult,
} from "../../extensibility/extensions";
import { expandKeyHint } from "../../tools/render-utils";
import { getTabBarTheme } from "../shared";
import { getMarkdownTheme, highlightCode, theme } from "../theme/theme";
import {
	matchesAppToolsExpand,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { editorKey } from "./keybinding-hints";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";
import { handleTabSwitchKey } from "./selector-helpers";

const OTHER_OPTION = "Other (type your own)";
const SUBMIT_OPTION = "Submit";

/** Fraction of the terminal the dialog may occupy. The box height is fixed
 *  at spawn from the tallest tab's content (re-measured only on viewport
 *  resize) and clamped to this ratio; it rises from the bottom as a stable
 *  panel that never resizes on tab switches or cursor moves. */
const DIALOG_HEIGHT_RATIO = 0.7;
const MIN_DIALOG_ROWS = 12;
const MIN_BODY_ROWS = 5;
const MAX_HEADER_CHIP_WIDTH = 16;
/** Maximum number of title lines shown in the prompt editor overlay, so a
 *  long or multi-line question cannot push the input row off-screen. Mirrors
 *  the bounded-title pattern from the legacy ask path without its option-window
 *  coupling. */
const MAX_PROMPT_TITLE_ROWS = 3;
/** Border (2) + padX (2) columns consumed by the HookEditor chrome. */
const PROMPT_TITLE_CHROME_COLUMNS = 4;
/** Maximum number of wrapped lines for an in-body question header, so a long
 *  or multi-line question cannot push the option list off-screen. Mirrors the
 *  row-cap pattern used by boundPromptTitle for the prompt editor overlay. */
const MAX_HEADER_ROWS = 4;

function promptTitleContentWidth(): number {
	const cols = process.stdout.columns ?? 80;
	return Math.max(1, cols - PROMPT_TITLE_CHROME_COLUMNS);
}

/** Bound a prompt editor title to a fixed row/width budget so long or
 *  multi-line questions stay usable inside the small prompt overlay. */
export function boundPromptTitle(prefix: string, question: string): string {
	const width = promptTitleContentWidth();
	const flat = normalizedInlineInput(`${prefix}${question}`);
	const wrapped = wrapTextWithAnsi(flat, width);
	if (wrapped.length <= MAX_PROMPT_TITLE_ROWS) return wrapped.join("\n");
	const kept = wrapped.slice(0, MAX_PROMPT_TITLE_ROWS - 1);
	const last = truncateToWidth(wrapped[MAX_PROMPT_TITLE_ROWS - 1] ?? "", width, Ellipsis.Unicode);
	return [...kept, last].join("\n");
}

interface AskDialogCallbacks {
	onSubmit(result: ExtensionAskDialogSubmitResult): void;
	onCancel(): void;
	onPrompt(title: string, prefill?: string): Promise<string | undefined>;
}

interface AskDialogInputGuard {
	isBlocked(): boolean;
	handleInput(keyData: string): void;
	hint: string;
	/** Mirror the guard's blocked state onto the proxied draft surface each
	 *  render, so a draft that owns input shows a visible insertion cursor even
	 *  though this dialog holds TUI focus. */
	syncPresentation?(): void;
}

interface AskDialogOptions {
	timeout?: number;
	onTimeout?: () => void;
	tui?: TUI;
	inputGuard?: AskDialogInputGuard;
}

interface QuestionState {
	selectedOptions: Set<string>;
	customInput: string | undefined;
	note: string | undefined;
	noteRowKey: string | undefined;
	cursorIndex: number;
	scrollOffset: number;
	manualScroll: boolean;
	timedOut: boolean;
}

type QuestionRowKind = "option" | "other";

interface QuestionRow {
	kind: QuestionRowKind;
	key: string;
	label: string;
	optionIndex: number | undefined;
}

interface RenderedList {
	lines: string[];
	scrollOffset: number;
	indicator: string;
}

interface PreviewSegment {
	kind: "markdown" | "code";
	text: string;
	language: string | undefined;
}

type PreviewRenderCache = Map<string, Map<number, readonly string[]>>;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function questionTabLabel(question: ExtensionAskDialogQuestion, index: number): string {
	const base = question.header?.trim() || question.id || `Q${index + 1}`;
	return truncateToWidth(replaceTabs(base), MAX_HEADER_CHIP_WIDTH, Ellipsis.Unicode);
}

function wrapQuestionTitle(question: ExtensionAskDialogQuestion, width: number): string[] {
	const mdTheme = getMarkdownTheme();
	const questionText = renderInlineMarkdown(replaceTabs(question.question), mdTheme, t => theme.fg("text", t));
	return wrapTextWithAnsi(questionText, Math.max(1, width));
}

function renderQuestionTitle(question: ExtensionAskDialogQuestion, width: number, maxRows = MAX_HEADER_ROWS): string[] {
	const wrapped = wrapQuestionTitle(question, width);
	if (wrapped.length <= maxRows) return wrapped;
	return [
		...wrapped.slice(0, maxRows - 1),
		truncateToWidth(wrapped.slice(maxRows - 1).join(" "), Math.max(1, width), Ellipsis.Unicode),
	];
}

function splitPreviewSegments(preview: string): PreviewSegment[] {
	const segments: PreviewSegment[] = [];
	const markdownBuffer: string[] = [];
	let fenceChar: string | undefined;
	let fenceLength = 0;
	let fenceLanguage: string | undefined;
	let codeBuffer: string[] = [];

	const flushMarkdown = (): void => {
		if (markdownBuffer.length === 0) return;
		segments.push({ kind: "markdown", text: markdownBuffer.join("\n"), language: undefined });
		markdownBuffer.length = 0;
	};
	const flushCode = (): void => {
		segments.push({ kind: "code", text: codeBuffer.join("\n"), language: fenceLanguage });
		codeBuffer = [];
		fenceChar = undefined;
		fenceLength = 0;
		fenceLanguage = undefined;
	};

	for (const line of replaceTabs(preview).split("\n")) {
		const fenceMatch = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenceChar !== undefined) {
			if (fenceMatch) {
				const marker = fenceMatch[2] ?? "";
				const info = fenceMatch[3]?.trim() ?? "";
				if (marker.startsWith(fenceChar) && marker.length >= fenceLength && info === "") {
					flushCode();
					continue;
				}
			}
			codeBuffer.push(line);
			continue;
		}
		if (fenceMatch) {
			flushMarkdown();
			const marker = fenceMatch[2] ?? "";
			fenceChar = marker[0];
			fenceLength = marker.length;
			fenceLanguage = fenceMatch[3]?.trim().split(/\s+/, 1)[0] || undefined;
			codeBuffer = [];
			continue;
		}
		markdownBuffer.push(line);
	}

	if (fenceChar !== undefined) {
		segments.push({ kind: "code", text: codeBuffer.join("\n"), language: fenceLanguage });
	} else {
		flushMarkdown();
	}
	return segments;
}

function renderPreviewContent(preview: string, width: number): string[] {
	const out: string[] = [];
	const mdTheme = getMarkdownTheme();
	const accentStyle = { color: (text: string) => theme.fg("muted", text) };
	for (const segment of splitPreviewSegments(preview)) {
		if (segment.kind === "code") {
			const highlighted = highlightCode(segment.text, segment.language);
			const text = new Text(highlighted.join("\n"), 0, 0);
			out.push(...text.render(Math.max(1, width)));
			continue;
		}
		const markdown = new Markdown(segment.text, 0, 0, mdTheme, accentStyle);
		out.push(...markdown.render(Math.max(1, width)));
	}
	return out;
}

function renderCachedPreview(cache: PreviewRenderCache, preview: string, width: number): readonly string[] {
	let byWidth = cache.get(preview);
	if (!byWidth) {
		byWidth = new Map();
		cache.set(preview, byWidth);
	}
	let rendered = byWidth.get(width);
	if (!rendered) {
		rendered = renderPreviewContent(preview, width).map(line => `      ${theme.fg("border", "│")} ${line}`);
		byWidth.set(width, rendered);
	}
	return rendered;
}

function pageKeysLabel(): string {
	const pageUp = editorKey("tui.select.pageUp");
	const pageDown = editorKey("tui.select.pageDown");
	return `${pageUp === "pageup" ? "PgUp" : pageUp}/${pageDown === "pagedown" ? "PgDn" : pageDown}`;
}

function cancelKeyLabel(): string {
	const [key = ""] = editorKey("tui.select.cancel").split("/");
	return key === "escape" ? "Esc" : key;
}

function normalizedInlineInput(input: string): string {
	return replaceTabs(input).replace(/\s+/g, " ").trim();
}

function renderAnswerSummary(question: ExtensionAskDialogQuestion, state: QuestionState): string {
	const selected = question.options.map(option => option.label).filter(label => state.selectedOptions.has(label));
	if (question.multi) {
		const answers = [...selected];
		if (state.customInput !== undefined) answers.push(`Other: “${normalizedInlineInput(state.customInput)}”`);
		return answers.length > 0 ? answers.join(", ") : theme.fg("warning", "unanswered");
	}
	if (state.customInput !== undefined) return `“${normalizedInlineInput(state.customInput)}”`;
	if (selected.length === 0) return theme.fg("warning", "unanswered");
	return selected[0] ?? theme.fg("warning", "unanswered");
}

function clearNote(state: QuestionState): void {
	state.note = undefined;
	state.noteRowKey = undefined;
}

function clearNoteIfRow(state: QuestionState, rowKey: string): void {
	if (state.noteRowKey === rowKey) clearNote(state);
}

function clearNoteUnlessRow(state: QuestionState, rowKey: string): void {
	if (state.noteRowKey !== undefined && state.noteRowKey !== rowKey) clearNote(state);
}

function noteForSubmittedAnswer(question: ExtensionAskDialogQuestion, state: QuestionState): string | undefined {
	if (state.note === undefined || state.noteRowKey === undefined) return undefined;
	if (state.noteRowKey === "other") return state.customInput !== undefined ? state.note : undefined;
	const match = /^option:(\d+)$/.exec(state.noteRowKey);
	const optionIndex = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
	const option = Number.isInteger(optionIndex) ? question.options[optionIndex] : undefined;
	return option && state.selectedOptions.has(option.label) ? state.note : undefined;
}

function optionMarker(question: ExtensionAskDialogQuestion, checked: boolean): string {
	if (question.multi) return checked ? theme.checkbox.checked : theme.checkbox.unchecked;
	return checked ? theme.radio.selected : theme.radio.unselected;
}

function renderRowLabel(
	rowItem: QuestionRow,
	question: ExtensionAskDialogQuestion,
	state: QuestionState,
	selected: boolean,
	mdTheme: MarkdownTheme,
	previewCache: PreviewRenderCache,
	width: number,
): string[] {
	const isOption = rowItem.kind === "option";
	const isOther = rowItem.kind === "other";
	const option = isOption ? question.options[rowItem.optionIndex ?? -1] : undefined;
	const checked =
		option !== undefined ? state.selectedOptions.has(option.label) : isOther && state.customInput !== undefined;
	const color = selected ? "accent" : checked ? "toolOutput" : "text";
	const marker = `${theme.fg(checked ? "success" : "dim", optionMarker(question, checked))} `;
	const cursor = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
	const label = renderInlineMarkdown(rowItem.label, mdTheme, t => theme.fg(color, t));
	const noteMarker = state.note && state.noteRowKey === rowItem.key ? theme.fg("success", "  ✎ note") : "";
	// `width` is already the inner content width consumed by row(); when a
	// scrollbar is needed, renderRows() calls this again with one less column.
	// Keep the cursor, option marker, first wrapped label line, and optional
	// note marker within that budget so the outer fit() never truncates them.
	const noteWidth = noteMarker ? visibleWidth(noteMarker) : 0;
	const labelWidth = Math.max(1, width - visibleWidth(cursor) - visibleWidth(marker) - noteWidth);
	const wrappedLabel = wrapTextWithAnsi(label, labelWidth);
	const indent = padding(visibleWidth(cursor) + visibleWidth(marker));
	const lines = [`${cursor}${marker}${wrappedLabel[0] ?? ""}${noteMarker}`];
	for (let i = 1; i < wrappedLabel.length; i++) {
		lines.push(`${indent}${wrappedLabel[i] ?? ""}`);
	}
	if (rowItem.kind === "option") {
		const option = question.options[rowItem.optionIndex ?? -1];
		if (option?.description?.trim()) {
			const description = renderInlineMarkdown(option.description.trim(), mdTheme, t => theme.fg("muted", t));
			const wrapped = wrapTextWithAnsi(description, Math.max(1, width - 6));
			for (const line of wrapped.slice(0, 2)) {
				lines.push(`      ${truncateToWidth(line, Math.max(1, width - 6), Ellipsis.Unicode)}`);
			}
		}
		if (option?.preview?.trim()) {
			const previewWidth = Math.max(1, width - 8);
			lines.push(...renderCachedPreview(previewCache, option.preview, previewWidth));
		}
	}
	if (isOther && state.customInput !== undefined) {
		const preview = replaceTabs(state.customInput).replace(/\s+/g, " ").trim();
		lines.push(theme.fg("muted", `      ${truncateToWidth(preview, Math.max(1, width - 6), Ellipsis.Unicode)}`));
	}
	return lines;
}

/**
 * Coerce untrusted dialog questions into a render-safe shape. The live ask
 * dialog is reached from the public `askDialog` extension surface and from
 * streamed tool args, where a question entry can arrive with a missing or
 * non-string `question` field. The render helpers (`replaceTabs`,
 * `renderQuestionTitle`, `questionTabLabel`) assume strings, so a malformed
 * entry throws and takes down the whole TUI render loop. Mirrors
 * `normalizeRenderQuestions` on the transcript path.
 */
function normalizeDialogQuestions(questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogQuestion[] {
	if (!Array.isArray(questions)) return [];
	const out: ExtensionAskDialogQuestion[] = [];
	for (const entry of questions) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as Partial<ExtensionAskDialogQuestion>;
		const options: ExtensionAskDialogOption[] = [];
		if (Array.isArray(q.options)) {
			for (const opt of q.options) {
				if (!opt || typeof opt !== "object") continue;
				const o = opt as Partial<ExtensionAskDialogOption>;
				options.push({
					label: typeof o.label === "string" ? o.label : "",
					...(typeof o.description === "string" ? { description: o.description } : {}),
					...(typeof o.preview === "string" ? { preview: o.preview } : {}),
				});
			}
		}
		out.push({
			id: typeof q.id === "string" ? q.id : "?",
			question: typeof q.question === "string" ? q.question : "",
			...(typeof q.header === "string" ? { header: q.header } : {}),
			options,
			...(typeof q.multi === "boolean" ? { multi: q.multi } : {}),
			...(Number.isInteger(q.recommended) ? { recommended: q.recommended } : {}),
		});
	}
	return out;
}

export class AskDialogComponent implements Component {
	#states: QuestionState[];
	#activeTabIndex = 0;
	#submitScrollOffset = 0;
	#bodyRows = MIN_BODY_ROWS;
	#questionCanPage = false;
	#remainingSeconds: number | undefined;
	#countdown: CountdownTimer | undefined;
	#promptActive = false;
	#timeoutExpired = false;
	#closed = false;
	#tabBar: TabBar | undefined;
	#stableHeight: { key: string; total: number } | undefined;
	#previewCache: PreviewRenderCache = new Map();
	#overflowLayouts = new WeakMap<ExtensionAskDialogQuestion, Set<string>>();
	#expanded = false;
	#contentWidth = 76;
	#headerExpandable = false;
	readonly #questions: ExtensionAskDialogQuestion[];

	constructor(
		questions: ExtensionAskDialogQuestion[],
		private readonly callbacks: AskDialogCallbacks,
		private readonly options: AskDialogOptions = {},
	) {
		this.#questions = normalizeDialogQuestions(questions);
		this.#states = this.#questions.map(question => {
			const recommended = Number.isInteger(question.recommended) ? question.recommended : 0;
			const maxIndex = Math.max(0, question.options.length - 1);
			return {
				selectedOptions: new Set<string>(),
				customInput: undefined,
				note: undefined,
				noteRowKey: undefined,
				cursorIndex: clamp(recommended ?? 0, 0, maxIndex),
				scrollOffset: 0,
				manualScroll: false,
				timedOut: false,
			};
		});
		if (options.timeout && options.timeout > 0) {
			this.#countdown = new CountdownTimer(
				options.timeout,
				options.tui,
				seconds => {
					this.#remainingSeconds = seconds;
				},
				() => this.#handleTimeout(),
			);
		}
	}

	invalidate(): void {
		this.#stableHeight = undefined;
		this.#previewCache.clear();
		this.#overflowLayouts = new WeakMap();
		this.#tabBar?.invalidate();
	}

	dispose(): void {
		this.#closed = true;
		this.#countdown?.dispose();
	}

	/**
	 * Toggle a truncated question header. Returns false when there is nothing
	 * to expand so the global Ctrl+O listener can still expand transcript tools.
	 */
	toggleQuestionExpansion(): boolean {
		if (this.#closed || this.#isSubmitTab()) return false;
		const question = this.#questions[this.#currentQuestionIndex()];
		if (!question) return false;
		const overflows = wrapQuestionTitle(question, this.#contentWidth).length > MAX_HEADER_ROWS;
		if (!overflows) return false;
		this.#expanded = !this.#expanded;
		this.invalidate();
		this.#requestRender();
		return true;
	}

	handleInput(keyData: string): void {
		if (this.#closed || this.#promptActive) return;
		// Reset the inactivity countdown on any key that reaches past the
		// closed/prompt guards, matching HookSelector/HookInput semantics.
		this.#countdown?.reset();
		if (matchesSelectCancel(keyData)) {
			this.#finishCancel();
			return;
		}
		// Expand before the draft-input guard so Ctrl+O can reveal a truncated
		// question even while a pending prompt still owns typing.
		if (matchesAppToolsExpand(keyData)) {
			this.toggleQuestionExpansion();
			return;
		}
		const inputGuard = this.options.inputGuard;
		if (inputGuard?.isBlocked()) {
			inputGuard.handleInput(keyData);
			this.#requestRender();
			return;
		}
		if (this.#hasSubmitTab() && handleTabSwitchKey(keyData, direction => this.#switchTab(direction))) {
			this.#requestRender();
			return;
		}
		if (this.#isSubmitTab()) {
			this.#handleSubmitTabInput(keyData);
			return;
		}
		this.#handleQuestionInput(keyData);
	}

	render(width: number): readonly string[] {
		// Keep the proxied draft's cursor visible while it owns input (the editor
		// renders as the next sibling in the same container, so this lands in the
		// same frame).
		this.options.inputGuard?.syncPresentation?.();
		const innerWidth = Math.max(1, width - 4);
		this.#contentWidth = innerWidth;
		// Fixed panel height: measured from the tallest tab at spawn and
		// re-measured only when the viewport changes. Tab switches, cursor
		// moves, and later answers never resize the box; content that
		// outgrows it scrolls. Expanding a truncated question uses the space
		// available within the existing height cap.
		const totalRows = this.#dialogHeight(innerWidth, process.stdout.rows || 40);
		const tabBarRows = this.#hasSubmitTab() ? 1 : 0;
		const maxTitleRows = Math.max(1, totalRows - 5 - MIN_BODY_ROWS - tabBarRows);
		const headerLines = this.#renderHeader(innerWidth, maxTitleRows);
		// topBorder(1) + header(N) + divider(1) + divider(1) + footer(1) +
		// bottomBorder(1) = N + 5 fixed rows outside the body. Without the
		// bottomBorder term the dialog overflowed the viewport by one row
		// (PRRT_kwDOQxs0bc6OFbDY).
		const fixedRows = 1 + headerLines.length + 1 + 1 + 1 + 1;
		const bodyRows = Math.max(MIN_BODY_ROWS, totalRows - fixedRows);
		this.#bodyRows = bodyRows;
		const bodyLines = this.#isSubmitTab()
			? this.#renderSubmitBody(innerWidth, bodyRows)
			: this.#renderQuestionBody(innerWidth, bodyRows);
		const footer = this.#footerHintText(bodyLines.indicator);
		return [
			topBorder(width, this.#titleText()),
			...headerLines.map(line => row(line, width)),
			divider(width),
			...bodyLines.lines.map(line => row(line, width)),
			divider(width),
			row(theme.fg("dim", footer), width),
			bottomBorder(width),
		];
	}

	#dialogHeight(width: number, termRows: number): number {
		const key = `${width}:${termRows}:${this.#expanded ? 1 : 0}`;
		if (this.#stableHeight?.key === key) return this.#stableHeight.total;
		const total = this.#measureHeight(width, termRows);
		this.#stableHeight = { key, total };
		return total;
	}

	/** Measure the tallest tab's natural content height, clamped to
	 *  DIALOG_HEIGHT_RATIO of the terminal. Derived from questions and
	 *  viewport only — never from cursor, tab, or answer state — so the box
	 *  size is stable for the dialog's lifetime at a given terminal size. */
	#measureHeight(width: number, termRows: number): number {
		const maxHeight = Math.max(MIN_DIALOG_ROWS, Math.floor(termRows * DIALOG_HEIGHT_RATIO));
		const chrome = 5; // topBorder + divider + divider + footer + bottomBorder
		const tabBarRows = this.#hasSubmitTab() ? 1 : 0;
		const mdTheme = getMarkdownTheme();
		let needed = MIN_DIALOG_ROWS;
		for (let index = 0; index < this.#questions.length; index++) {
			const question = this.#questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			const titleRows = this.#expanded ? Number.POSITIVE_INFINITY : MAX_HEADER_ROWS;
			const headerRows = tabBarRows + renderQuestionTitle(question, width, titleRows).length;
			const rowItems = this.#questionRows(question);
			const listRows = (listWidth: number): number => {
				let total = 0;
				for (const rowItem of rowItems) {
					total += renderRowLabel(rowItem, question, state, false, mdTheme, this.#previewCache, listWidth).length;
				}
				return total;
			};
			const body = listRows(width);
			needed = Math.max(needed, chrome + headerRows + Math.max(MIN_BODY_ROWS, body));
		}
		if (this.#hasSubmitTab()) {
			// Warning line + blank, one summary line per question, blank, and
			// the Submit row; note lines added later scroll within the body.
			const body = 2 + this.#questions.length + 2;
			needed = Math.max(needed, chrome + tabBarRows + 1 + Math.max(MIN_BODY_ROWS, body));
		}
		return Math.min(needed, maxHeight);
	}

	#titleText(): string {
		return this.#remainingSeconds === undefined ? "Ask" : `Ask (${this.#remainingSeconds}s)`;
	}

	#hasSubmitTab(): boolean {
		// Multi questions confirm on the Submit tab (Enter toggles, never
		// submits), so any multi question forces the tab even when there is
		// only one question.
		return this.#questions.length > 1 || this.#questions.some(question => question.multi);
	}

	#submitTabIndex(): number {
		return this.#questions.length;
	}

	#isSubmitTab(): boolean {
		return this.#hasSubmitTab() && this.#activeTabIndex === this.#submitTabIndex();
	}

	#currentQuestionIndex(): number {
		return clamp(this.#activeTabIndex, 0, Math.max(0, this.#questions.length - 1));
	}

	#requestRender(): void {
		this.options.tui?.requestRender();
	}

	#renderHeader(width: number, maxTitleRows: number): string[] {
		const lines: string[] = [];
		if (this.#hasSubmitTab()) {
			const tabs: Tab[] = [
				...this.#questions.map((question, index) => ({
					id: String(index),
					label: questionTabLabel(question, index),
				})),
				{ id: "submit", label: "Submit" },
			];
			this.#tabBar = new TabBar("", tabs, getTabBarTheme(), this.#activeTabIndex);
			this.#tabBar.showHint = false;
			lines.push(...this.#tabBar.render(width));
		}
		if (this.#isSubmitTab()) {
			this.#headerExpandable = false;
			lines.push(theme.bold(theme.fg("accent", "Review answers")));
			return lines;
		}
		const questionIndex = this.#currentQuestionIndex();
		const question = this.#questions[questionIndex];
		if (!question) {
			this.#headerExpandable = false;
			return lines;
		}
		const wrapped = wrapQuestionTitle(question, width);
		this.#headerExpandable = wrapped.length > MAX_HEADER_ROWS;
		const maxRows = this.#expanded ? maxTitleRows : MAX_HEADER_ROWS;
		lines.push(...renderQuestionTitle(question, width, maxRows));
		return lines;
	}

	#expandHint(): string {
		if (!this.#headerExpandable) return "";
		return ` · ${expandKeyHint()} ${this.#expanded ? "collapse" : "expand"}`;
	}

	#footerHintText(indicator: string): string {
		const cancel = `${cancelKeyLabel()} cancel`;
		const inputGuard = this.options.inputGuard;
		if (inputGuard?.isBlocked()) return `${inputGuard.hint}${this.#expandHint()} · ${cancel}`;
		if (this.#isSubmitTab()) {
			const scroll = indicator ? ` ${indicator} scroll ·` : "";
			return `Enter submit · ↑/↓ scroll ·${scroll} ${cancel}`;
		}
		const question = this.#questions[this.#currentQuestionIndex()];
		// Enter advances in multi-question dialogs and submits single-question ones.
		const enterAction = this.#questions.length > 1 ? "next" : "submit";
		const action = question?.multi ? `Space toggle · Enter ${enterAction}` : "Enter select · n note";
		const tabs = this.#hasSubmitTab() ? " · Tab/←/→" : "";
		const expand = this.#expandHint();
		if (this.#questionCanPage && indicator) {
			return `${action} · ↑/↓${tabs} · ${cancel}${expand} · ${pageKeysLabel()} ${indicator}`;
		}
		const scroll = indicator ? ` ${indicator} scroll ·` : "";
		return `${action} · ↑/↓ move${tabs} ·${scroll} ${cancel}${expand}`;
	}

	#questionRows(question: ExtensionAskDialogQuestion): QuestionRow[] {
		const rows: QuestionRow[] = question.options.map((option, index) => ({
			kind: "option",
			key: `option:${index}`,
			label: this.#optionLabel(question, option.label, index),
			optionIndex: index,
		}));
		rows.push({ kind: "other", key: "other", label: OTHER_OPTION, optionIndex: undefined });
		return rows;
	}

	#optionLabel(question: ExtensionAskDialogQuestion, label: string, index: number): string {
		const suffix = " (Recommended)";
		if (question.recommended !== index || label.endsWith(suffix)) return label;
		return `${label}${suffix}`;
	}

	#activeQuestionState(): { question: ExtensionAskDialogQuestion; state: QuestionState } | undefined {
		const question = this.#questions[this.#currentQuestionIndex()];
		const state = this.#states[this.#currentQuestionIndex()];
		if (!question || !state) return undefined;
		return { question, state };
	}

	#handleQuestionInput(keyData: string): void {
		const active = this.#activeQuestionState();
		if (!active) return;
		const { question, state } = active;
		const rows = this.#questionRows(question);
		if (matchesSelectPageUp(keyData)) {
			state.scrollOffset = Math.max(0, state.scrollOffset - Math.max(1, this.#bodyRows - 1));
			state.manualScroll = true;
			this.#requestRender();
			return;
		}
		if (matchesSelectPageDown(keyData)) {
			state.scrollOffset += Math.max(1, this.#bodyRows - 1);
			state.manualScroll = true;
			this.#requestRender();
			return;
		}
		if (matchesSelectUp(keyData)) {
			state.cursorIndex = clamp(state.cursorIndex - 1, 0, Math.max(0, rows.length - 1));
			state.manualScroll = false;
			this.#requestRender();
			return;
		}
		if (matchesSelectDown(keyData)) {
			state.cursorIndex = clamp(state.cursorIndex + 1, 0, Math.max(0, rows.length - 1));
			state.manualScroll = false;
			this.#requestRender();
			return;
		}
		const rowItem = rows[state.cursorIndex];
		if (!rowItem) return;
		if (keyData === "n" || keyData === "N") {
			if (rowItem.kind === "option" || rowItem.kind === "other") {
				void this.#promptForNote(question, state, rowItem);
			}
			return;
		}
		const isEnter = matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n";
		const isSpace = matchesKey(keyData, "space") || keyData === " ";
		if (!isEnter && !(question.multi && isSpace)) return;
		if (rowItem.kind === "other") {
			void this.#promptForCustomInput(question, state, rowItem);
			return;
		}
		const option = question.options[rowItem.optionIndex ?? -1];
		if (!option) return;
		if (question.multi) {
			if (isEnter) {
				// Enter confirms the current selection without toggling the
				// focused option; Space toggles. Advances to the next question
				// (submitting only for a single-question dialog), matching
				// single-select Enter (#8252).
				this.#advanceAfterQuestion();
				return;
			}
			if (state.selectedOptions.has(option.label)) {
				state.selectedOptions.delete(option.label);
				clearNoteIfRow(state, rowItem.key);
			} else {
				state.selectedOptions.add(option.label);
			}
			this.#requestRender();
			return;
		}
		state.selectedOptions = new Set([option.label]);
		state.customInput = undefined;
		clearNoteUnlessRow(state, rowItem.key);
		this.#advanceAfterQuestion();
	}

	#handleSubmitTabInput(keyData: string): void {
		if (matchesSelectUp(keyData)) {
			this.#submitScrollOffset = Math.max(0, this.#submitScrollOffset - 1);
			this.#requestRender();
			return;
		}
		if (matchesSelectDown(keyData)) {
			// Clamped against the rendered line count in #renderSubmitBody.
			this.#submitScrollOffset += 1;
			this.#requestRender();
			return;
		}
		const isEnter = matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n";
		if (isEnter) this.#finishSubmit();
	}

	#switchTab(direction: 1 | -1): void {
		const tabCount = this.#questions.length + 1;
		this.#activeTabIndex = (this.#activeTabIndex + direction + tabCount) % tabCount;
		this.#submitScrollOffset = 0;
	}

	#advanceAfterQuestion(): void {
		const current = this.#currentQuestionIndex();
		if (this.#questions.length === 1) {
			this.#finishSubmit();
			return;
		}
		this.#activeTabIndex = current + 1 < this.#questions.length ? current + 1 : this.#submitTabIndex();
		this.#submitScrollOffset = 0;
		this.#requestRender();
	}

	async #promptForCustomInput(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItem: QuestionRow,
	): Promise<void> {
		this.#promptActive = true;
		try {
			const input = await this.callbacks.onPrompt(
				boundPromptTitle("Custom answer: ", question.question),
				state.customInput,
			);
			if (input === undefined || this.#closed) return;
			if (input.trim() === "") {
				// Submitting an empty value unselects the custom answer.
				state.customInput = undefined;
				clearNoteIfRow(state, rowItem.key);
				return;
			}
			state.customInput = input;
			if (!question.multi) {
				state.selectedOptions.clear();
				clearNoteUnlessRow(state, rowItem.key);
				this.#advanceAfterQuestion();
			}
		} finally {
			this.#promptActive = false;
			this.#runDeferredTimeout();
			this.#requestRender();
		}
	}

	async #promptForNote(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItem: QuestionRow,
	): Promise<void> {
		this.#promptActive = true;
		try {
			const input = await this.callbacks.onPrompt(
				boundPromptTitle(`Note for ${rowItem.label}: `, question.question),
				state.noteRowKey === rowItem.key ? state.note : undefined,
			);
			if (input === undefined || this.#closed) return;
			state.note = input;
			state.noteRowKey = rowItem.key;
		} finally {
			this.#promptActive = false;
			this.#runDeferredTimeout();
			this.#requestRender();
		}
	}

	#renderQuestionBody(width: number, maxRows: number): RenderedList {
		const active = this.#activeQuestionState();
		if (!active) return { lines: [], scrollOffset: 0, indicator: "" };
		const { question, state } = active;
		const rowItems = this.#questionRows(question);
		state.cursorIndex = clamp(state.cursorIndex, 0, Math.max(0, rowItems.length - 1));
		return this.#renderQuestionList(question, state, rowItems, width, maxRows);
	}

	#renderQuestionList(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItems: QuestionRow[],
		width: number,
		rows: number,
	): RenderedList {
		const mdTheme = getMarkdownTheme();
		const renderRows = (contentWidth: number): { allLines: string[]; lineStartByRow: number[] } => {
			const allLines: string[] = [];
			const lineStartByRow: number[] = [];
			for (let index = 0; index < rowItems.length; index++) {
				lineStartByRow.push(allLines.length);
				const rowItem = rowItems[index];
				if (!rowItem) continue;
				allLines.push(
					...renderRowLabel(
						rowItem,
						question,
						state,
						index === state.cursorIndex,
						mdTheme,
						this.#previewCache,
						contentWidth,
					),
				);
			}
			return { allLines, lineStartByRow };
		};
		const layoutKey = `${width}:${rows}:${state.customInput === undefined ? 0 : 1}`;
		let overflowLayouts = this.#overflowLayouts.get(question);
		const knownOverflow = overflowLayouts?.has(layoutKey) ?? false;
		let renderedRows = renderRows(knownOverflow && width > 1 ? width - 1 : width);
		if (!knownOverflow && width > 1 && renderedRows.allLines.length > rows) {
			if (!overflowLayouts) {
				overflowLayouts = new Set();
				this.#overflowLayouts.set(question, overflowLayouts);
			}
			overflowLayouts.add(layoutKey);
			renderedRows = renderRows(width - 1);
		}
		const { allLines, lineStartByRow } = renderedRows;
		const cursorStart = lineStartByRow[state.cursorIndex] ?? 0;
		const cursorEnd = lineStartByRow[state.cursorIndex + 1] ?? allLines.length;
		this.#questionCanPage = cursorEnd - cursorStart > rows;
		state.scrollOffset = this.#scrollOffsetForCursor(
			state.scrollOffset,
			cursorStart,
			cursorEnd,
			rows,
			allLines.length,
			state.manualScroll,
		);
		const scrollView = new ScrollView(allLines, {
			height: rows,
			scrollbar: "auto",
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		scrollView.setScrollOffset(state.scrollOffset);
		const lines = [...scrollView.render(width)];
		while (lines.length < rows) lines.push("");
		return {
			lines: lines.slice(0, rows),
			scrollOffset: state.scrollOffset,
			indicator: this.#clipIndicator(state.scrollOffset, rows, allLines.length),
		};
	}

	#renderSubmitBody(width: number, rows: number): RenderedList {
		const allLines: string[] = [];
		const unanswered = this.#unansweredCount();
		if (unanswered > 0) {
			allLines.push(
				theme.fg(
					"warning",
					`${unanswered} unanswered question${unanswered === 1 ? "" : "s"}; Enter still submits.`,
				),
			);
			allLines.push("");
		}
		for (let index = 0; index < this.#questions.length; index++) {
			const question = this.#questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			const label = questionTabLabel(question, index);
			const answer = renderAnswerSummary(question, state);
			allLines.push(`${theme.fg("dim", `${index + 1}. ${label}:`)} ${answer}`);
			const submittedNote = noteForSubmittedAnswer(question, state);
			if (submittedNote?.trim()) {
				const note = normalizedInlineInput(submittedNote);
				allLines.push(
					theme.fg("muted", `   Note: ${truncateToWidth(note, Math.max(1, width - 9), Ellipsis.Unicode)}`),
				);
			}
		}
		allLines.push("");
		allLines.push(theme.fg("accent", `${theme.nav.cursor} ${SUBMIT_OPTION}`));
		this.#submitScrollOffset = clamp(this.#submitScrollOffset, 0, Math.max(0, allLines.length - rows));
		const scrollView = new ScrollView(allLines, {
			height: rows,
			scrollbar: "auto",
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		scrollView.setScrollOffset(this.#submitScrollOffset);
		const rendered = scrollView.render(width);
		const lines = [...rendered];
		while (lines.length < rows) lines.push("");
		return {
			lines: lines.slice(0, rows),
			scrollOffset: this.#submitScrollOffset,
			indicator: this.#clipIndicator(this.#submitScrollOffset, rows, allLines.length),
		};
	}

	#scrollOffsetForCursor(
		currentOffset: number,
		cursorStart: number,
		cursorEnd: number,
		rows: number,
		totalRows: number,
		manualScroll: boolean,
	): number {
		const maxOffset = Math.max(0, totalRows - rows);
		if (maxOffset === 0) return 0;
		let nextOffset = clamp(currentOffset, 0, maxOffset);
		const cursorRows = cursorEnd - cursorStart;
		if (manualScroll && cursorRows > rows) {
			// A page must not expose another option while Enter still targets this one.
			nextOffset = clamp(nextOffset, cursorStart, cursorEnd - rows);
		} else if (cursorStart < nextOffset || cursorEnd > nextOffset + rows) {
			nextOffset = cursorRows <= rows ? cursorEnd - rows : cursorStart;
		}
		return clamp(nextOffset, 0, maxOffset);
	}

	#clipIndicator(offset: number, rows: number, totalRows: number): string {
		const above = offset > 0;
		const below = offset + rows < totalRows;
		if (above && below) return "↕";
		if (above) return "↑";
		if (below) return "↓";
		return "";
	}

	#unansweredCount(): number {
		let count = 0;
		for (let index = 0; index < this.#questions.length; index++) {
			const question = this.#questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			if (state.selectedOptions.size === 0 && state.customInput === undefined) count += 1;
		}
		return count;
	}

	#handleTimeout(): void {
		if (this.#closed) return;
		if (this.#promptActive) {
			this.#timeoutExpired = true;
			return;
		}
		this.options.onTimeout?.();
		for (let index = 0; index < this.#questions.length; index++) {
			const question = this.#questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			if (state.selectedOptions.size === 0 && state.customInput === undefined) {
				const noteMatch = /^option:(\d+)$/.exec(state.noteRowKey ?? "");
				const notedIndex = noteMatch ? Number.parseInt(noteMatch[1], 10) : Number.NaN;
				const fallbackIndex =
					Number.isInteger(notedIndex) && question.options[notedIndex]
						? notedIndex
						: clamp(question.recommended ?? 0, 0, Math.max(0, question.options.length - 1));
				const fallback = question.options[fallbackIndex];
				if (fallback) state.selectedOptions.add(fallback.label);
				state.timedOut = true;
			}
		}
		this.#finishSubmit();
	}

	#runDeferredTimeout(): void {
		if (!this.#timeoutExpired) return;
		this.#timeoutExpired = false;
		this.#handleTimeout();
	}

	#finishSubmit(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		this.callbacks.onSubmit({ kind: "submit", results: this.#buildResults() });
	}

	#finishCancel(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		this.callbacks.onCancel();
	}

	#buildResults(): ExtensionAskDialogResultItem[] {
		const results: ExtensionAskDialogResultItem[] = [];
		for (let index = 0; index < this.#questions.length; index++) {
			const question = this.#questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			const selectedOptions = question.options
				.map(option => option.label)
				.filter(label => state.selectedOptions.has(label));
			results.push({
				id: question.id,
				question: question.question,
				options: question.options.map(option => option.label),
				multi: question.multi ?? false,
				selectedOptions,
				customInput: state.customInput,
				note: noteForSubmittedAnswer(question, state),
				timedOut: state.timedOut || undefined,
			});
		}
		return results;
	}
}
