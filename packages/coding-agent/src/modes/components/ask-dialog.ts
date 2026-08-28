import {
	type Component,
	Ellipsis,
	extractPrintableText,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Markdown,
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
import { formatKeyHints } from "../../config/keybindings";
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
import { type AskQuestionRow, askRowPrefixColumns, renderAskRow } from "./ask-row";
import { CountdownTimer } from "./countdown-timer";
import { editorKey } from "./keybinding-hints";
import { bottomBorder, divider, dividerSplit, fit, row, topBorder, topBorderSplit } from "./overlay-box";

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
const PREVIEW_FACET_MIN_WIDTH = 60;
const MIN_LIST_FACET_WIDTH = 28;

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
	expandedRowKey: string | undefined;
	manualScroll: boolean;
	timedOut: boolean;
}

type QuestionRow = AskQuestionRow;

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
		rendered = renderPreviewContent(preview, width);
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

function askActionKey(action: "app.ask.expand" | "app.ask.note" | "app.ask.filter"): string {
	// `n` and `shift+n` are the same physical key — an uppercase N arrives
	// canonicalized as `shift+n` — so collapse the pair into one label
	// instead of printing "N/Shift+N". Other modifiers are left untouched.
	const keys = getKeybindings().getKeys(action);
	const distinct = keys.filter(
		key => !(key.length === 7 && key.startsWith("shift+") && keys.some(prev => prev === key.slice(6))),
	);
	return formatKeyHints(distinct);
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

function questionHasPreviewContent(question: ExtensionAskDialogQuestion): boolean {
	return question.options.some(option => option.preview?.trim());
}

function previewFacetWidths(
	innerWidth: number,
	hasPreviewContent: boolean,
): { listWidth: number; previewWidth: number; split: boolean } {
	if (!hasPreviewContent || innerWidth < PREVIEW_FACET_MIN_WIDTH) {
		return { listWidth: innerWidth, previewWidth: 0, split: false };
	}
	const listWidth = Math.max(MIN_LIST_FACET_WIDTH, Math.floor(innerWidth / 2));
	const previewWidth = Math.max(0, innerWidth - listWidth - 1);
	return { listWidth, previewWidth, split: previewWidth > 0 };
}

function countedMoreCue(hidden: number, width: number): string {
	const glyph = theme.nav.expand || "▾";
	const noun = hidden === 1 ? "line" : "lines";
	// Name the key that reveals the rest: the facet cannot scroll, so a bare
	// count would advertise unread lines with no way to reach them. The full
	// form outgrows the narrowest split facet (29 columns), so shed count
	// wording — never the reveal — as the facet narrows. The key sits ahead
	// of the verb so even an over-long custom binding clips its tail first.
	const reveal = `${askActionKey("app.ask.expand")} expand`;
	const full = `${glyph} ${hidden} more ${noun} · ${reveal}`;
	if (visibleWidth(full) <= width) return theme.fg("dim", full);
	const counted = `${glyph} ${hidden} more · ${reveal}`;
	if (visibleWidth(counted) <= width) return theme.fg("dim", counted);
	return theme.fg("dim", `${glyph} ${reveal}`);
}

function truncateFooter(parts: string[], maxWidth: number): string {
	if (parts.length === 0) return "";
	const join = (items: string[]): string => items.join(" · ");
	const kept = parts.slice();
	// Pin the last part (cancel). Overflow drops lower-priority middle hints
	// first so cancellation stays advertised whenever it is available.
	while (kept.length > 1 && visibleWidth(join(kept)) > maxWidth) {
		kept.splice(kept.length - 2, 1);
	}
	const text = join(kept);
	if (visibleWidth(text) <= maxWidth) return text;
	// Dropping middle hints was not enough and only the cancel hint remains.
	// Preserve the trailing "cancel" affordance by left-truncating the
	// keybinding prefix; a right-truncating ellipsis would clip the word
	// itself, hiding the only signal that cancellation is available.
	const cancelHint = kept[kept.length - 1] ?? text;
	if (kept.length === 1 && cancelHint.endsWith("cancel")) {
		const affordance = "cancel";
		const affordanceWidth = visibleWidth(affordance);
		if (maxWidth > affordanceWidth) {
			const prefix = cancelHint.slice(0, cancelHint.length - affordance.length).trimEnd();
			const prefixBudget = Math.max(1, maxWidth - affordanceWidth - 1);
			return `${truncateToWidth(prefix, prefixBudget, Ellipsis.Unicode)} ${affordance}`;
		}
		return truncateToWidth(affordance, Math.max(1, maxWidth), Ellipsis.Unicode);
	}
	return truncateToWidth(text, Math.max(1, maxWidth), Ellipsis.Unicode);
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

export class AskDialogComponent implements Component, Focusable {
	focused = false;
	#states: QuestionState[];
	#activeTabIndex = 0;
	#submitScrollOffset = 0;
	#submitLineCount = 0;
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
	#filterOpen = false;
	#filterInput: Input | undefined;
	#filterQuery = "";
	#filterAvailable = false;
	#hiddenDescriptionLines = 0;
	#suppressedPreview = false;
	#footerWidth = 80;

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
				expandedRowKey: undefined,
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
		this.#filterInput?.invalidate();
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
		const overflows =
			wrapQuestionTitle(question, this.#headerTitleWidth(this.#contentWidth, question)).length > MAX_HEADER_ROWS;
		if (!overflows) return false;
		this.#expanded = !this.#expanded;
		this.invalidate();
		this.#requestRender();
		return true;
	}
	/** Width used to wrap the question title, matching the filter-count suffix
	 *  reservation in `#renderHeader`. Toggle and the expandable flag must use
	 *  this same width or Ctrl+O is a no-op while the rendered title is truncated. */
	#headerTitleWidth(width: number, question: ExtensionAskDialogQuestion): number {
		const filterActive = this.#filterOpen || this.#filterQuery.length > 0;
		if (!filterActive) return width;
		const visible = this.#visibleRows(question).length;
		const total = this.#questionRows(question).length;
		return Math.max(1, width - (2 + visibleWidth(`${visible}/${total}`)));
	}

	handleInput(keyData: string): void {
		if (this.#closed || this.#promptActive) return;
		// Reset the inactivity countdown on any key that reaches past the
		// closed/prompt guards, matching HookSelector/HookInput semantics.
		this.#countdown?.reset();
		if (matchesSelectCancel(keyData)) {
			if (this.#filterOpen || this.#filterQuery.length > 0) {
				this.#clearFilter();
				this.#requestRender();
				return;
			}
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
		if (this.#filterOpen && this.#filterInput) {
			// Keep list navigation live while the filter input is open: arrows
			// and paging move among filtered rows instead of becoming query text.
			// Enter is handled by Input.onSubmit (close filter, keep query,
			// activate). Space toggles the focused multi-select row along the same
			// activation path Space takes outside the filter, so a keyboard user
			// can narrow a multi-select list and toggle a match without closing
			// the filter; Space never becomes query text in multi mode.
			// Single-select Space has no toggle, so it stays filter input.
			// The filter key itself toggles the editor closed while keeping the
			// query and the filtered focus: Enter activates the focused row and
			// Escape discards the filter, so this is the only route to the
			// advertised note shortcut for a narrowed match.
			if (getKeybindings().matches(keyData, "app.ask.filter")) {
				this.#filterQuery = this.#filterInput.getValue();
				this.#filterOpen = false;
				this.#filterInput = undefined;
				this.#requestRender();
				return;
			}
			// Tab keeps switching tabs while the filter is open; switching
			// clears the filter exactly as it does outside the editor.
			if (this.#hasSubmitTab() && this.#matchesTabSwitch(keyData)) {
				this.#requestRender();
				return;
			}
			// Expand/collapse are control keys with no query-text meaning, so
			// they keep acting on the focused filtered row instead of moving
			// the query caret. The note key is printable, so it stays query
			// text while the editor is open — closing the editor with the
			// filter key above is the route to it.
			if (
				getKeybindings().matches(keyData, "app.ask.expand") ||
				getKeybindings().matches(keyData, "app.ask.collapse")
			) {
				this.#handleQuestionInput(keyData);
				return;
			}
			const active = this.#activeQuestionState();
			const isSpace = matchesKey(keyData, "space") || keyData === " ";
			if (active?.question.multi && isSpace) {
				this.#handleQuestionInput(keyData);
				return;
			}
			if (
				matchesSelectUp(keyData) ||
				matchesSelectDown(keyData) ||
				matchesSelectPageUp(keyData) ||
				matchesSelectPageDown(keyData)
			) {
				this.#handleQuestionInput(keyData);
				return;
			}
			const prevFocusedKey = active ? this.#visibleRows(active.question)[active.state.cursorIndex]?.key : undefined;
			this.#filterInput.handleInput(keyData);
			if (this.#filterInput) {
				this.#filterQuery = this.#filterInput.getValue();
				if (active) this.#reanchorCursor(active.question, active.state, prevFocusedKey);
				this.#requestRender();
			}
			return;
		}
		if (this.#hasSubmitTab() && this.#matchesTabSwitch(keyData)) {
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
		this.#footerWidth = innerWidth;
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
		const currentQuestion = this.#isSubmitTab() ? undefined : this.#questions[this.#currentQuestionIndex()];
		const { listWidth, split } = previewFacetWidths(
			innerWidth,
			currentQuestion ? questionHasPreviewContent(currentQuestion) : false,
		);
		const splitChrome = split && !this.#isSubmitTab();
		// Body concatenates list|preview without the extra spaces splitRow uses,
		// so the inner │ sits at listWidth+2. overlay-box tees at sidebarWidth+3.
		const splitSidebar = Math.max(0, listWidth - 1);
		const out: string[] = [
			splitChrome ? topBorderSplit(width, this.#titleText(), splitSidebar) : topBorder(width, this.#titleText()),
		];
		out.push(...headerLines.map(line => row(line, width)));
		out.push(splitChrome ? dividerSplit(width, splitSidebar) : divider(width));
		const bodyLines = this.#isSubmitTab()
			? this.#renderSubmitBody(innerWidth, bodyRows)
			: this.#renderQuestionBody(innerWidth, bodyRows);
		out.push(...bodyLines.lines.map(line => row(line, width)));
		out.push(splitChrome ? dividerSplit(width, splitSidebar) : divider(width));
		out.push(row(theme.fg("dim", this.#footerHintText(bodyLines.indicator)), width));
		out.push(bottomBorder(width));
		return out;
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
			const rowItems = this.#questionRows(question);
			// Reserve the widest filter-count suffix ("M/M" over all rows) before
			// wrapping the title: with filtering on, #renderHeader wraps at
			// width - suffixWidth, and an extra title line there must already be
			// inside the frozen height or the rendered panel outgrows it — the
			// body cannot shrink past MIN_BODY_ROWS to absorb a late wrap.
			const suffixWidth = 2 + visibleWidth(`${rowItems.length}/${rowItems.length}`);
			const headerRows =
				tabBarRows + renderQuestionTitle(question, Math.max(1, width - suffixWidth), titleRows).length;
			const { listWidth } = previewFacetWidths(width, questionHasPreviewContent(question));
			let body = 0;
			for (const rowItem of rowItems) {
				body += renderAskRow(rowItem, {
					question,
					focused: false,
					checked: false,
					jumpDigit: undefined,
					expanded: false,
					note: undefined,
					customInput: undefined,
					width: listWidth,
					mdTheme,
					declareCursor: false,
				}).lines.length;
			}
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
		const titleWidth = this.#headerTitleWidth(width, question);
		this.#headerExpandable = wrapQuestionTitle(question, titleWidth).length > MAX_HEADER_ROWS;
		const maxRows = this.#expanded ? maxTitleRows : MAX_HEADER_ROWS;
		const filterActive = this.#filterOpen || this.#filterQuery.length > 0;
		if (filterActive) {
			const rows = this.#visibleRows(question);
			const total = this.#questionRows(question).length;
			const countText = `${rows.length}/${total}`;
			const title = renderQuestionTitle(question, titleWidth, maxRows);
			const count = theme.fg("dim", countText);
			if (title.length > 0) {
				title[0] = `${title[0] ?? ""}  ${count}`;
			} else {
				title.push(count);
			}
			lines.push(...title);
			return lines;
		}
		const title = renderQuestionTitle(question, width, maxRows);
		lines.push(...title);
		return lines;
	}

	/**
	 * Hint for the truncated-question toggle, as a bare footer part. The row
	 * expand key carries its own "expand" label, so this one names its target.
	 */
	#expandHint(): string {
		if (!this.#headerExpandable) return "";
		return `${expandKeyHint()} ${this.#expanded ? "collapse" : "expand"} question`;
	}

	#footerHintText(indicator: string): string {
		const cancel = `${cancelKeyLabel()} cancel`;
		const inputGuard = this.options.inputGuard;
		if (inputGuard?.isBlocked()) {
			const expand = this.#expandHint();
			return `${inputGuard.hint}${expand ? ` · ${expand}` : ""} · ${cancel}`;
		}
		if (this.#isSubmitTab()) {
			return truncateFooter(
				[`Enter submit`, `↑/↓ scroll`, ...(indicator ? [`${indicator} scroll`] : []), cancel],
				this.#footerWidth,
			);
		}
		const question = this.#questions[this.#currentQuestionIndex()];
		// Enter advances in multi-question dialogs and submits single-question ones.
		const enterAction = this.#questions.length > 1 ? "next" : "submit";
		const action = question?.multi ? `Space toggle · Enter ${enterAction}` : "Enter select";
		const parts: string[] = [action, "↑/↓ move"];
		if (this.#hiddenDescriptionLines > 0 || this.#suppressedPreview) {
			parts.push(`${askActionKey("app.ask.expand")} expand`);
		}
		parts.push(`${askActionKey("app.ask.note")} note`);
		if (this.#filterAvailable) {
			parts.push(`${askActionKey("app.ask.filter")} filter`);
		}
		const expand = this.#expandHint();
		if (expand) parts.push(expand);
		if (this.#hasSubmitTab()) parts.push("Tab/S-Tab");
		if (this.#questionCanPage && indicator) {
			parts.push(`${pageKeysLabel()} ${indicator}`);
		} else if (indicator) {
			parts.push(`${indicator} scroll`);
		}
		parts.push(cancel);
		return truncateFooter(parts, this.#footerWidth);
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

	#visibleRows(question: ExtensionAskDialogQuestion): QuestionRow[] {
		const rows = this.#questionRows(question);
		const query = this.#filterOpen ? (this.#filterInput?.getValue() ?? this.#filterQuery) : this.#filterQuery;
		if (!query.trim()) return rows;
		const options = rows.filter(rowItem => rowItem.kind === "option");
		const other = rows.find(rowItem => rowItem.kind === "other");
		const filtered = fuzzyFilter(options, query, rowItem => rowItem.label);
		return other ? [...filtered, other] : filtered;
	}

	/** Re-anchor `cursorIndex` after a filter query narrows the visible rows.
	 *  Preserve focus on the prior row when it remains visible; otherwise reset
	 *  to the first matching option row — never to `Other` and never to a stale
	 *  numeric index that clamps onto the trailing `Other` row. */
	#reanchorCursor(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		prevFocusedKey: string | undefined,
	): void {
		const rows = this.#visibleRows(question);
		if (rows.length === 0) return;
		if (prevFocusedKey !== undefined) {
			const idx = rows.findIndex(r => r.key === prevFocusedKey);
			if (idx >= 0) {
				state.cursorIndex = idx;
				state.manualScroll = false;
				return;
			}
		}
		const firstOption = rows.findIndex(r => r.kind === "option");
		state.cursorIndex = firstOption >= 0 ? firstOption : 0;
		state.manualScroll = false;
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

	#matchesTabSwitch(keyData: string): boolean {
		if (matchesKey(keyData, "tab")) {
			this.#switchTab(1);
			return true;
		}
		if (matchesKey(keyData, "shift+tab")) {
			this.#switchTab(-1);
			return true;
		}
		return false;
	}

	#clearFilter(): void {
		this.#filterOpen = false;
		this.#filterInput = undefined;
		this.#filterQuery = "";
	}

	#openFilter(): void {
		this.#filterOpen = true;
		this.#filterInput = new Input();
		this.#filterInput.prompt = "/ ";
		this.#filterInput.setValue(this.#filterQuery);
		this.#filterInput.focused = true;
		this.#filterInput.onSubmit = () => {
			this.#filterQuery = this.#filterInput?.getValue() ?? this.#filterQuery;
			this.#filterOpen = false;
			this.#filterInput = undefined;
			const active = this.#activeQuestionState();
			if (!active) {
				this.#requestRender();
				return;
			}
			this.#activateFocusedRow(active.question, active.state, "enter");
		};
	}

	#handleQuestionInput(keyData: string): void {
		const active = this.#activeQuestionState();
		if (!active) return;
		const { question, state } = active;
		const rows = this.#visibleRows(question);
		// Availability must agree with the rendered frame: wrapped labels and
		// the focused description can overflow the body without the option
		// count exceeding it, so keep any overflow the last render measured
		// (#renderQuestionList recomputes it every frame) and only fall back
		// to the count bound for keys that arrive before a first render, when
		// #bodyRows still holds the minimum. The count bound implies the
		// rendered one — every option is at least one line — so widening can
		// never contradict a rendered frame.
		this.#filterAvailable ||= this.#questionRows(question).length > this.#bodyRows;

		if (getKeybindings().matches(keyData, "app.ask.filter") && this.#filterAvailable) {
			this.#openFilter();
			this.#requestRender();
			return;
		}
		if (getKeybindings().matches(keyData, "app.ask.expand")) {
			const rowItem = rows[state.cursorIndex];
			if (rowItem) {
				state.expandedRowKey = state.expandedRowKey === rowItem.key ? undefined : rowItem.key;
				this.#requestRender();
			}
			return;
		}
		if (getKeybindings().matches(keyData, "app.ask.collapse")) {
			state.expandedRowKey = undefined;
			this.#requestRender();
			return;
		}
		if (getKeybindings().matches(keyData, "app.ask.note")) {
			const rowItem = rows[state.cursorIndex];
			if (rowItem && (rowItem.kind === "option" || rowItem.kind === "other")) {
				void this.#promptForNote(question, state, rowItem);
			}
			return;
		}

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

		// Decode through the shared key parser so Kitty numpad digits (CSI-u
		// sequences like `\x1b[57400u`) reach the jump handler, not just raw
		// bytes.
		const decodedDigit = extractPrintableText(keyData);
		if (decodedDigit && /^[1-9]$/.test(decodedDigit)) {
			const index = Number.parseInt(decodedDigit, 10) - 1;
			if (index >= 0 && index < rows.length) {
				state.cursorIndex = index;
				state.manualScroll = false;
				this.#requestRender();
			}
			return;
		}

		const rowItem = rows[state.cursorIndex];
		if (!rowItem) return;
		const isEnter = matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n";
		const isSpace = matchesKey(keyData, "space") || keyData === " ";
		if (!isEnter && !(question.multi && isSpace)) return;
		this.#activateFocusedRow(question, state, isSpace ? "space" : "enter");
	}

	#activateFocusedRow(question: ExtensionAskDialogQuestion, state: QuestionState, mode: "enter" | "space"): void {
		const rows = this.#visibleRows(question);
		// Clamp the cursor against the current filtered row list before
		// activation so Enter/Space always acts on a visible row even when a
		// query narrowed the list between the last render and this activation
		// (#renderQuestionBody is the only other clamp, and a fast
		// query-plus-Enter can outpace it).
		state.cursorIndex = clamp(state.cursorIndex, 0, Math.max(0, rows.length - 1));
		const rowItem = rows[state.cursorIndex];
		if (!rowItem) return;
		if (rowItem.kind === "other") {
			void this.#promptForCustomInput(question, state, rowItem);
			return;
		}
		const option = question.options[rowItem.optionIndex ?? -1];
		if (!option) return;
		if (question.multi) {
			if (mode === "enter") {
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
		const maxOffset = Math.max(0, this.#submitLineCount - this.#bodyRows);
		if (matchesSelectUp(keyData)) {
			this.#submitScrollOffset = Math.max(0, this.#submitScrollOffset - 1);
			this.#requestRender();
			return;
		}
		if (matchesSelectDown(keyData)) {
			this.#submitScrollOffset = clamp(this.#submitScrollOffset + 1, 0, maxOffset);
			this.#requestRender();
			return;
		}
		const isEnter = matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n";
		if (isEnter) this.#finishSubmit();
	}

	#setActiveTab(index: number): void {
		const previous = this.#activeTabIndex;
		const maxIndex = this.#hasSubmitTab() ? this.#submitTabIndex() : Math.max(0, this.#questions.length - 1);
		this.#activeTabIndex = clamp(index, 0, maxIndex);
		this.#submitScrollOffset = 0;
		if (previous !== this.#activeTabIndex && !this.#isSubmitTab()) {
			const state = this.#states[this.#currentQuestionIndex()];
			if (state) state.expandedRowKey = undefined;
		}
		this.#clearFilter();
	}

	#switchTab(direction: 1 | -1): void {
		const tabCount = this.#questions.length + (this.#hasSubmitTab() ? 1 : 0);
		this.#setActiveTab((this.#activeTabIndex + direction + tabCount) % tabCount);
	}

	#advanceAfterQuestion(): void {
		const current = this.#currentQuestionIndex();
		if (this.#questions.length === 1) {
			this.#finishSubmit();
			return;
		}
		this.#setActiveTab(current + 1 < this.#questions.length ? current + 1 : this.#submitTabIndex());
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
		const rowItems = this.#visibleRows(question);
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
		const { listWidth, previewWidth, split } = previewFacetWidths(width, questionHasPreviewContent(question));
		const filterRows = this.#filterOpen ? 1 : 0;
		const listRows = Math.max(1, rows - filterRows);
		const declareCursor = this.focused && !this.#promptActive;

		const focusedRow = rowItems[state.cursorIndex];
		const focusedOption = focusedRow?.kind === "option" ? question.options[focusedRow.optionIndex ?? -1] : undefined;
		const expanded = focusedRow !== undefined && state.expandedRowKey === focusedRow.key;
		const hasPreview = Boolean(focusedOption?.preview?.trim());
		this.#suppressedPreview = hasPreview && !split && !expanded;

		const renderRows = (contentWidth: number): { allLines: string[]; lineStartByRow: number[]; hidden: number } => {
			const allLines: string[] = [];
			const lineStartByRow: number[] = [];
			let hidden = 0;
			for (let index = 0; index < rowItems.length; index++) {
				lineStartByRow.push(allLines.length);
				const rowItem = rowItems[index];
				if (!rowItem) continue;
				const isFocused = index === state.cursorIndex;
				const option = rowItem.kind === "option" ? question.options[rowItem.optionIndex ?? -1] : undefined;
				const checked =
					option !== undefined
						? state.selectedOptions.has(option.label)
						: rowItem.kind === "other" && state.customInput !== undefined;
				const rowExpanded = isFocused && state.expandedRowKey === rowItem.key;
				const rendered = renderAskRow(rowItem, {
					question,
					focused: isFocused,
					checked,
					jumpDigit: index < 9 ? String(index + 1) : undefined,
					expanded: rowExpanded,
					note: state.noteRowKey === rowItem.key ? state.note : undefined,
					customInput: rowItem.kind === "other" ? state.customInput : undefined,
					width: contentWidth,
					mdTheme,
					declareCursor: isFocused && declareCursor,
				});
				allLines.push(...rendered.lines);
				if (isFocused) hidden = rendered.hiddenDescriptionLines;
				// The side facet is a fixed-height glance, so `expand` is the only
				// way to read a preview longer than that window. Inline it in both
				// layouts: in split mode the facet keeps showing the head while the
				// expanded row carries the full text.
				if (isFocused && rowExpanded && option?.preview?.trim()) {
					const prefixColumns = askRowPrefixColumns(question.multi);
					const previewWidthInner = Math.max(1, contentWidth - prefixColumns);
					const indent = padding(prefixColumns);
					for (const line of renderCachedPreview(this.#previewCache, option.preview, previewWidthInner)) {
						allLines.push(`${indent}${line}`);
					}
				}
			}
			return { allLines, lineStartByRow, hidden };
		};

		// cursorIndex keys the focused row's own render: a long focused
		// description overflows where a short option fits, so one row's
		// overflow verdict must not be carried onto another by the cache.
		// noteRowKey keys the note-bearing row's render: a note marker adds a
		// line to the noted row, so moving a note away from a long row must
		// not reuse the stale one-column-narrow overflow verdict the note
		// caused there.
		const layoutKey = `${listWidth}:${listRows}:${this.#filterQuery}:${state.cursorIndex}:${state.expandedRowKey ?? ""}:${state.customInput === undefined ? 0 : 1}:${state.noteRowKey ?? ""}`;
		let overflowLayouts = this.#overflowLayouts.get(question);
		const knownOverflow = overflowLayouts?.has(layoutKey) ?? false;
		let renderedRows = renderRows(knownOverflow && listWidth > 1 ? listWidth - 1 : listWidth);
		if (!knownOverflow && listWidth > 1 && renderedRows.allLines.length > listRows) {
			if (!overflowLayouts) {
				overflowLayouts = new Set();
				this.#overflowLayouts.set(question, overflowLayouts);
			}
			overflowLayouts.add(layoutKey);
			renderedRows = renderRows(listWidth - 1);
		}
		const { allLines, lineStartByRow, hidden } = renderedRows;
		this.#hiddenDescriptionLines = hidden;
		// Availability follows the rendered height, not the option count:
		// wrapped labels and the focused description can overflow the list
		// while the count still fits, and every overflowing list must be
		// filterable. Set here — after the overflow-aware re-render settles
		// the final line set — so the footer hint and the "/"-opens check
		// read the same flag in the same frame. While a query is retained
		// (editor open, or kept after closing it with the filter key) the
		// filtered render can fit even though the unfiltered list overflows;
		// availability must survive that fit or the editor could never be
		// reopened to refine the query — only Escape, which discards it.
		this.#filterAvailable = this.#filterOpen || this.#filterQuery.length > 0 || allLines.length > listRows;
		const cursorStart = lineStartByRow[state.cursorIndex] ?? 0;
		const cursorEnd = lineStartByRow[state.cursorIndex + 1] ?? allLines.length;
		this.#questionCanPage = cursorEnd - cursorStart > listRows;
		state.scrollOffset = this.#scrollOffsetForCursor(
			state.scrollOffset,
			cursorStart,
			cursorEnd,
			listRows,
			allLines.length,
			state.manualScroll,
		);
		const scrollView = new ScrollView(allLines, {
			height: listRows,
			scrollbar: "auto",
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		scrollView.setScrollOffset(state.scrollOffset);
		const listWindow = [...scrollView.render(listWidth)];
		while (listWindow.length < listRows) listWindow.push("");

		const previewLines = this.#renderPreviewFacet(question, focusedRow, previewWidth, rows, split);

		const body: string[] = [];
		const filterBar: string[] = [];
		if (filterRows > 0 && this.#filterInput) {
			this.#filterInput.focused = true;
			// Controller deviation from the brief's above-the-list slot: the
			// filter renders as a vim-style bottom bar (below the facet rows,
			// above the footer) so both facets stay continuous and the input's
			// cursor marker lands bottom-most — the TUI takes the bottom-most
			// marker, so the filter owns the hardware cursor while open while
			// the focused row keeps its own Change-7 declaration. Facet columns
			// never shift: the bar spans only the list width and the row still
			// composes divider + preview-facet cell like every other split row.
			filterBar.push(...this.#filterInput.render(split ? listWidth : width));
			while (filterBar.length < 1) filterBar.push("");
		}
		for (let i = 0; i < listRows; i++) {
			if (split) {
				const dividerCol = theme.fg("border", "│");
				body.push(`${fit(listWindow[i] ?? "", listWidth)}${dividerCol}${fit(previewLines[i] ?? "", previewWidth)}`);
			} else {
				body.push(listWindow[i] ?? "");
			}
		}
		if (filterBar.length > 0) {
			if (split) {
				const dividerCol = theme.fg("border", "│");
				body.push(
					`${fit(filterBar[0] ?? "", listWidth)}${dividerCol}${fit(previewLines[listRows] ?? "", previewWidth)}`,
				);
			} else {
				body.push(filterBar[0] ?? "");
			}
		}
		while (body.length < rows) body.push("");
		return {
			lines: body.slice(0, rows),
			scrollOffset: state.scrollOffset,
			indicator: this.#clipIndicator(state.scrollOffset, listRows, allLines.length),
		};
	}

	#renderPreviewFacet(
		question: ExtensionAskDialogQuestion,
		focusedRow: QuestionRow | undefined,
		previewWidth: number,
		rows: number,
		split: boolean,
	): string[] {
		if (!split || previewWidth <= 0) {
			return Array.from({ length: rows }, () => "");
		}
		const option = focusedRow?.kind === "option" ? question.options[focusedRow.optionIndex ?? -1] : undefined;
		const title = truncateToWidth(
			replaceTabs((focusedRow?.label ?? "").replace(/[\r\n]+/g, " ")),
			previewWidth,
			Ellipsis.Unicode,
		);
		const titleLine = theme.bold(theme.fg("accent", title));
		const bodyBudget = Math.max(0, rows - 1);
		const previewText = option?.preview?.trim() ? option.preview : "";
		const content = previewText ? [...renderCachedPreview(this.#previewCache, previewText, previewWidth)] : [];
		const out: string[] = [fit(titleLine, previewWidth)];
		if (bodyBudget === 0) return out.slice(0, rows);
		const window = content.slice(0, bodyBudget);
		const hiddenBelow = Math.max(0, content.length - window.length);
		if (hiddenBelow > 0 && window.length > 0) {
			// Replace the last visible row with a counted overflow cue so the
			// facet height stays fixed while still advertising unread lines.
			window[window.length - 1] = countedMoreCue(hiddenBelow + 1, previewWidth);
		}
		for (const line of window) out.push(fit(line, previewWidth));
		while (out.length < rows) out.push("");
		return out.slice(0, rows);
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
		this.#submitLineCount = allLines.length;
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
