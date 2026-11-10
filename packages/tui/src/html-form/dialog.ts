/**
 * Terminal surface for an agent-written HTML form (parsed by `parse.ts`).
 *
 * Row rendering lays the whole form out as one column — section titles,
 * context, choice rows, one-row dropdowns, text fields, then a Submit row —
 * inside a fixed-height panel. When the column is taller than the panel
 * allows ({@link DIALOG_HEIGHT_RATIO} of the terminal), it splits into pages
 * ({@link paginate}) at section boundaries where possible; focus drives the
 * visible page, so moving past a page's last control turns the page. A native
 * (Tern) terminal gets the form described semantically instead: one tab per
 * question (a top-level `<fieldset>`; context before it rides along) plus a
 * Review tab, the tab's content in a column the terminal scrolls, and an
 * action bar that stays in view below it, with Submit on the last question
 * tab and on Review. Clicks come back through
 * {@link HtmlFormDialog.handleNativeEvent}.
 *
 * Keys: ↑/↓ move between choices and fields, Tab/Shift+Tab jump fields,
 * Space toggles (or opens a dropdown), ←/→ change a dropdown, Enter picks a
 * radio (or leaves a field) and moves on, Enter on Submit validates and
 * submits, PgUp/PgDn (←/→ on choices) turn pages (question tabs natively),
 * `app.ask.hide` collapses the form to one row, Esc cancels. With a
 * `timeout`, inactivity submits the current values through `onTimeout`.
 *
 * @example
 * const dialog = new HtmlFormDialog(parseHtmlForm(html), {
 * 	tui,
 * 	onSubmit: data => resolve(data), // { db: "sqlite", notes: "" }
 * 	onCancel: () => resolve(undefined),
 * });
 */
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { SvgFigure } from "../chat/svg-figure";
import { Editor } from "../components/editor";
import { Image } from "../components/image";
import { Input } from "../components/input";
import { renderTableRow, type TableColumn } from "../components/table";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { getKeybindings } from "../keybindings";
import { extractPrintableText, matchesKey } from "../keys";
import { code, col, item, keyed, list, node, row, span, text } from "../native/describe";
import { nativeImageNode } from "../native/blobs";
import {
	type DescribeContext,
	leafKey,
	type NativeChild,
	type NativeNode,
	type NativeUiEvent,
	type TspSpan,
} from "../native/node";
import { actionBar, actionButton, itemIndex } from "../native/overlay";
import { isNativeRendering } from "../native/state";
import type { AskDialogInputGuard } from "../overlays/ask-dialog";
import { wrapPrefixedLine } from "../render/hanging-wrap";
import { getEditorTheme, type ThemeColor, theme } from "../theme/theme";
import { optionMarker } from "../tools/ask";
import type { Component, Focusable } from "../tui";
import { Ellipsis, padding, replaceTabs, truncateToWidth, visibleWidth } from "../utils";
import {
	choiceValue,
	fieldError,
	fieldQuestions,
	formAnswers,
	type HtmlFormData,
	type HtmlFormValue,
	OTHER_LABEL,
	textValue,
} from "./data";
import { type FormMedia, isSvgMedia, loadFormImage, svgMedia } from "./media";
import { BreakRank, type Page, type PageAtom, pageHeight, paginate } from "./paginate";
import {
	type ChoiceField,
	type ChoiceOption,
	type FormBlock,
	type FormField,
	type FormSpan,
	type HtmlForm,
	spansText,
	type TextField,
} from "./parse";

/** What the dialog needs from its `TUI`: the terminal's height and a way to ask for a frame. */
export interface HtmlFormHost {
	readonly terminal: { readonly rows: number };
	requestRender(): void;
}

/** Host wiring for {@link HtmlFormDialog}. */
export interface HtmlFormDialogOptions {
	/** Panel title; `Ask` when omitted. */
	title?: string;
	/** Sizes the panel and repaints when the countdown ticks or a picture lands. */
	tui?: HtmlFormHost;
	/** Inactivity in ms after which `onTimeout` receives the current values; any input restarts it. */
	timeout?: number;
	onTimeout?(data: HtmlFormData): void;
	/** A composer draft that keeps typing until ↑/↓ hands the keyboard to the form (as the ask dialog). */
	inputGuard?: AskDialogInputGuard;
	/** Directory relative `<img src>` paths resolve against; the process's when omitted. */
	cwd?: string;
	onSubmit(data: HtmlFormData): void;
	onCancel(): void;
}

/** Fraction of the terminal the panel may occupy, as the ask dialog. */
const DIALOG_HEIGHT_RATIO = 0.7;
const MIN_BODY_ROWS = 6;
/** Top border, footer divider, footer, bottom border. */
const CHROME_ROWS = 4;
/** Column where field inputs and errors start, under the cursor and marker. */
const FIELD_INDENT = 4;
const MAX_TEXTAREA_ROWS = 10;
const DEFAULT_TITLE = "Ask";
const SUBMIT_LABEL = "Submit";
/** A text block this short right before a field is its caption and never splits from it. */
const CAPTION_MAX_ROWS = 4;
/** Tallest a picture draws, in rows, and its share of the terminal below that. */
const MAX_PICTURE_ROWS = 16;
const PICTURE_SHARE = 0.35;
/** Options a PgUp/PgDn moves an open dropdown's highlight by. */
const DROPDOWN_PAGE = 5;
/** Native action a text well's click sends, suffixed with the field index. */
const EDIT_ACT = "edit:";
/** List item key of a group's Other answer (option items are `o<index>`). */
const OTHER_ITEM = "other";
const OTHER_PLACEHOLDER = "type your own";
/** Widest a question tab's label grows before it is clipped. */
const TAB_LABEL_WIDTH = 28;
const REVIEW_TAB = "Review";
/** Tab id of the Review tab (question tabs are `t<index>`). */
const REVIEW_ID = "review";

/** A picture block's state: still loading, failed (with why), or drawn by `rows` and described by `native`. */
type MediaSlot =
	| { state: "loading" }
	| { state: "failed"; reason: string }
	| { state: "ready"; rows: Image | SvgFigure; native: NativeNode };

type MediaBlock = Extract<FormBlock, { kind: "image" | "svg" }>;

/** A place focus can rest: one choice option, a dropdown, a text field, or the Submit row. */
type Stop =
	| { kind: "option"; field: ChoiceField; option: number }
	/** The free-text Other answer of a radio/checkbox group ({@link ChoiceField.other}). */
	| { kind: "other"; field: ChoiceField }
	| { kind: "select"; field: ChoiceField }
	| { kind: "text"; field: TextField }
	| { kind: "submit" };

interface Layout {
	atoms: PageAtom[];
	/** Atom index of each stop, parallel to the dialog's stops. */
	stopAtoms: number[];
	/** Where the open dropdown hangs from: its field's atom and the value row inside it. */
	dropdown?: { atom: number; row: number };
}

/** A native question tab: indices of the sections it shows, and the fields in them. */
interface FormTab {
	label: string;
	sections: number[];
	fields: FormField[];
}

/** Strip control bytes a model could smuggle into labels (escape sequences, `\r`); keep `\n`. */
function sanitize(text: string): string {
	return replaceTabs(text).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

/** A single select draws as a one-row dropdown; multi-selects keep option rows. */
function isDropdown(field: ChoiceField): boolean {
	return field.select && !field.multi;
}

function optionText(option: ChoiceOption): string {
	return sanitize(spansText(option.label)).replace(/\s+/g, " ").trim();
}

/** Split spans at hard breaks into display lines. */
function splitLines(spans: readonly FormSpan[]): FormSpan[][] {
	const lines: FormSpan[][] = [[]];
	for (const span of spans) {
		span.text.split("\n").forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part) lines[lines.length - 1]!.push({ text: part, style: span.style });
		});
	}
	return lines;
}

/** One line of spans styled over `base`; code keeps the markdown code color. */
function styleSpans(spans: readonly FormSpan[], base: (text: string) => string): string {
	let out = "";
	for (const span of spans) {
		const text = sanitize(span.text);
		if (span.style === "code") out += theme.fg("mdCode", text);
		else if (span.style === "strong") out += theme.bold(base(text));
		else if (span.style === "em") out += theme.italic(base(text));
		else out += base(text);
	}
	return out;
}

/** Spans wrapped under `prefix`, continuation and hard-break rows hanging at the prefix column. */
function hang(prefix: string, spans: readonly FormSpan[], base: (text: string) => string, width: number): string[] {
	const indent = padding(visibleWidth(prefix));
	return splitLines(spans).flatMap((line, index) =>
		wrapPrefixedLine(index === 0 ? prefix : indent, indent, styleSpans(line, base), width),
	);
}

/** Form spans as native spans; `extra` tokens apply to every run. */
function nativeSpans(spans: readonly FormSpan[], extra?: string): TspSpan[] {
	return spans.map(item => {
		const tokens = [item.style, extra].filter(Boolean).join(" ");
		return span(sanitize(item.text), tokens || undefined);
	});
}

/**
 * Native question tabs: one per section holding fields, labeled by its legend
 * (else its first field's question). Sections of context alone join the next
 * tab, or the last one when nothing follows.
 */
function buildTabs(form: HtmlForm, questions: ReadonlyMap<FormField, string>): FormTab[] {
	const tabs: FormTab[] = [];
	let lead: number[] = [];
	form.sections.forEach((section, index) => {
		const fields = section.blocks.flatMap(block => (block.kind === "field" ? [block.field] : []));
		if (fields.length === 0) {
			lead.push(index);
			return;
		}
		const title = sanitize(spansText(section.title)).replace(/\s+/g, " ").trim();
		const label = title || sanitize(questions.get(fields[0]!) ?? "") || `Question ${tabs.length + 1}`;
		tabs.push({
			label: truncateToWidth(label, TAB_LABEL_WIDTH, Ellipsis.Unicode),
			sections: [...lead, index],
			fields,
		});
		lead = [];
	});
	if (lead.length > 0) {
		const last = tabs.at(-1);
		if (last) last.sections.push(...lead);
		else tabs.push({ label: "", sections: lead, fields: [] });
	}
	return tabs;
}

/** Interactive pager over an {@link HtmlForm}; see the module docs for layout and keys. */
export class HtmlFormDialog implements Component, Focusable {
	readonly #form: HtmlForm;
	readonly #options: HtmlFormDialogOptions;
	readonly #stops: Stop[] = [];
	readonly #fieldIndex = new Map<FormField, number>();
	readonly #checked = new Map<ChoiceField, Set<number>>();
	readonly #inputs = new Map<TextField, Input>();
	/** The Other answer's text of each group that offers one. */
	readonly #others = new Map<ChoiceField, Input>();
	/** Each radio group's Other text as last seen, to notice typing from keys or the terminal. */
	readonly #otherSeen = new Map<ChoiceField, string>();
	readonly #editors = new Map<TextField, Editor>();
	readonly #errors = new Map<FormField, string>();
	readonly #panel: OverlayPanel;
	readonly #body = new PanelRows();
	readonly #footer = new PanelRows();
	#focused = false;
	#focus = 0;
	#page = 0;
	/**
	 * Whether the visible page follows focus. False while showing a page without
	 * stops: at open when the form leads with context, or after turning to one.
	 */
	#followFocus = false;
	#pages: Page[] = [];
	#stopAtoms: number[] = [];
	#height: { key: string; rows: number } | undefined;
	/** The dropdown showing its options, and the option its highlight sits on. */
	#open: { field: ChoiceField; highlight: number } | undefined;
	#guardReleased = false;
	#deadline = 0;
	#tick: NodeJS.Timeout | undefined;
	/** Whole seconds left on the countdown; undefined without one. */
	#remaining: number | undefined;
	/** Bumped on every state change; the native description is rebuilt only when it moved. */
	#version = 0;
	#native: { key: string; node: NativeNode } | undefined;
	readonly #media = new Map<MediaBlock, MediaSlot>();
	readonly #mediaAbort = new AbortController();
	/** Bumped when a picture loads, fails or rasterizes: its rows change the panel's natural height. */
	#mediaVersion = 0;
	/** Each field's question ({@link fieldQuestions}): Review keys and the hidden row's summary. */
	readonly #questions: Map<FormField, string>;
	/** Native question tabs; drawn only when there are two or more. */
	readonly #tabs: FormTab[];
	readonly #fieldTab = new Map<FormField, number>();
	/** The tab the native form shows: a question tab, or `#tabs.length` for Review. */
	#tab = 0;
	/** Question tabs the user has moved off; only these get a check, so preselected answers on unseen tabs stay unmarked. */
	readonly #leftTabs = new Set<number>();
	/** Collapsed to one row (`app.ask.hide` / Hide) while the form stays pending. */
	#hidden = false;

	constructor(form: HtmlForm, options: HtmlFormDialogOptions) {
		this.#form = form;
		this.#options = options;
		form.fields.forEach((field, index) => this.#fieldIndex.set(field, index));
		this.#questions = fieldQuestions(form);
		this.#tabs = buildTabs(form, this.#questions);
		this.#tabs.forEach((tab, index) => {
			for (const field of tab.fields) this.#fieldTab.set(field, index);
		});
		for (const section of form.sections) {
			for (const block of section.blocks) {
				if (block.kind === "image" || block.kind === "svg") this.#initMedia(block);
				if (block.kind !== "field") continue;
				const field = block.field;
				if (field.kind === "text") {
					this.#initText(field);
					this.#stops.push({ kind: "text", field });
					continue;
				}
				this.#initChoice(field);
				if (isDropdown(field)) {
					if (field.options.some(option => !option.disabled)) this.#stops.push({ kind: "select", field });
					continue;
				}
				field.options.forEach((option, index) => {
					if (!option.disabled) this.#stops.push({ kind: "option", field, option: index });
				});
				if (field.other) {
					const input = new Input();
					input.prompt = "";
					input.placeholder = OTHER_PLACEHOLDER;
					this.#others.set(field, input);
					this.#stops.push({ kind: "other", field });
				}
			}
		}
		this.#stops.push({ kind: "submit" });
		this.#panel = new OverlayPanel(options.title ?? DEFAULT_TITLE);
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
		this.#startCountdown();
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.#syncControlFocus();
		this.#changed();
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		for (const input of this.#inputs.values()) input.setUseTerminalCursor(useTerminalCursor);
		for (const input of this.#others.values()) input.setUseTerminalCursor(useTerminalCursor);
		for (const editor of this.#editors.values()) editor.setUseTerminalCursor(useTerminalCursor);
	}

	/** Current answers, as submission would report them (without validating). */
	data(): HtmlFormData {
		const data: HtmlFormData = {};
		for (const [name, value] of this.#form.hidden) data[name] = value;
		for (const field of this.#form.fields) {
			if (!field.name) continue;
			const value = this.#value(field);
			if (value !== undefined) data[field.name] = value;
		}
		return data;
	}

	debugState(): Record<string, unknown> {
		const stop = this.#stops[this.#focus];
		return {
			page: this.#page + 1,
			pages: this.#pages.length,
			focus:
				stop?.kind === "option"
					? `${stop.field.name}=${stop.field.options[stop.option]?.value}`
					: stop?.kind === "other"
						? `${stop.field.name}=${OTHER_ITEM}`
						: stop?.kind === "select" || stop?.kind === "text"
							? stop.field.name
							: "submit",
			open: this.#open ? this.#open.field.name : null,
			media: [...this.#media.values()].map(slot =>
				slot.state === "ready" ? { state: slot.state, ...slot.rows.debugState() } : slot,
			),
			remaining: this.#remaining ?? null,
			errors: Object.fromEntries([...this.#errors].map(([field, error]) => [field.name, error])),
			data: this.data(),
		};
	}

	handleInput(data: string): void {
		this.#resetCountdown();
		this.#changed();
		if (getKeybindings().matches(data, "app.ask.hide")) {
			this.#setHidden(!this.#hidden);
			return;
		}
		if (this.#open) {
			this.#dropdownInput(this.#open, data);
			return;
		}
		if (matchesSelectCancel(data)) {
			this.#cancel();
			return;
		}
		if (this.#guardBlocks()) {
			if (matchesSelectUp(data) || matchesSelectDown(data)) this.#guardReleased = true;
			else this.#options.inputGuard?.handleInput(data);
			return;
		}
		if (this.#hidden) {
			if (getKeybindings().matches(data, "tui.select.confirm")) this.#setHidden(false);
			return;
		}
		if (matchesSelectPageDown(data) || matchesSelectPageUp(data)) {
			this.#turnPage(matchesSelectPageDown(data) ? 1 : -1);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#moveField(matchesKey(data, "shift+tab") ? -1 : 1);
			return;
		}
		const stop = this.#stops[this.#focus]!;
		// Only paged rows can hide focus; native terminals and an unrendered form never do.
		if (!isNativeRendering() && !this.#followFocus && this.#pages.length > 1) {
			// Focus sits on another page: ←/→ keep paging, and the keys that would act on
			// it bring it into view instead of acting unseen. Anything else is ignored.
			if (matchesKey(data, "left") || matchesKey(data, "right")) {
				this.#turnPage(matchesKey(data, "right") ? 1 : -1);
			} else if (
				matchesSelectUp(data) ||
				matchesSelectDown(data) ||
				matchesKey(data, "space") ||
				getKeybindings().matches(data, "tui.select.confirm")
			) {
				this.#followFocus = true;
			}
			return;
		}
		if (stop.kind === "text") {
			this.#textInput(stop.field, data);
			return;
		}
		if (stop.kind === "select") {
			this.#selectInput(stop.field, data);
			return;
		}
		if (stop.kind === "other") {
			this.#otherInput(stop.field, data);
			return;
		}
		if (matchesSelectUp(data) || matchesSelectDown(data)) {
			this.#moveStop(matchesSelectDown(data) ? 1 : -1);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.#turnPage(matchesKey(data, "right") ? 1 : -1);
			return;
		}
		const confirm = getKeybindings().matches(data, "tui.select.confirm");
		if (stop.kind === "submit") {
			if (confirm) this.#submit();
			return;
		}
		if (matchesKey(data, "space")) {
			this.#toggle(stop.field, stop.option);
			return;
		}
		if (confirm) {
			if (!stop.field.multi) this.#toggle(stop.field, stop.option);
			this.#moveField(1);
		}
	}

	/** Clicks on tabs, option rows and the action bar of the native description. */
	handleNativeEvent(event: NativeUiEvent): void {
		this.#resetCountdown();
		this.#changed();
		if (event.type === "action") {
			if (event.act === "cancel") this.#cancel();
			else if (event.act === "hide" || event.act === "show") this.#setHidden(event.act === "hide");
			else if (this.#hidden) return;
			else if (event.act === "submit") this.#submit();
			else if (event.act === "next") this.#showTab(this.#tab + 1);
			else if (event.act.startsWith(EDIT_ACT)) {
				const field = this.#form.fields[Number(event.act.slice(EDIT_ACT.length))];
				const stop = this.#stops.findIndex(candidate => candidate.kind === "text" && candidate.field === field);
				if (stop !== -1) this.#setFocus(stop);
			}
			return;
		}
		if (this.#hidden || (event.type !== "select" && event.type !== "activate")) return;
		const leaf = leafKey(event.key);
		if (leaf === "tabs") {
			const index = event.item === REVIEW_ID ? this.#tabs.length : itemIndex(event.item, "t");
			if (this.#tabbed() && index >= 0) this.#showTab(index);
			return;
		}
		const field = leaf.startsWith("f") ? this.#form.fields[Number(leaf.slice(1))] : undefined;
		if (field?.kind === "choice" && field.other && event.item === OTHER_ITEM) {
			// The Other row takes the keyboard (its input becomes the live editor); a radio
			// group drops its pick so the typed text is the answer.
			this.#setFocus(this.#stops.findIndex(stop => stop.kind === "other" && stop.field === field));
			if (!field.multi) this.#checked.get(field)!.clear();
			this.#errors.delete(field);
			return;
		}
		const option = itemIndex(event.item, "o");
		if (field?.kind !== "choice" || field.options[option]?.disabled !== false) return;
		const stop = this.#stops.findIndex(
			candidate =>
				(candidate.kind === "option" && candidate.field === field && candidate.option === option) ||
				(candidate.kind === "select" && candidate.field === field),
		);
		if (stop !== -1) this.#setFocus(stop);
		if (!field.multi) this.#choose(field, option);
		else if (event.type === "select") this.#toggle(field, option);
	}

	render(width: number): readonly string[] {
		this.#options.inputGuard?.syncPresentation?.(this.#guardBlocks());
		if (this.#hidden) return this.#renderHidden(width);
		const innerWidth = Math.max(1, width - 4);
		const layout = this.#layout(innerWidth);
		const rows = this.#bodyRows(innerWidth, layout.atoms);
		this.#pages = paginate(layout.atoms, rows);
		this.#stopAtoms = layout.stopAtoms;
		const focusPage = this.#pageOfAtom(layout.stopAtoms[this.#focus] ?? 0);
		if (this.#followFocus) this.#page = focusPage;
		this.#page = Math.min(this.#page, this.#pages.length - 1);
		if (this.#page === focusPage) this.#followFocus = true;
		const paging = this.#pages.length > 1 ? ` · ${this.#page + 1}/${this.#pages.length}` : "";
		this.#panel.title = `${this.#titleText()}${paging}`;
		this.#body.setLines(this.#renderPage(layout, this.#pages[this.#page]!, rows, innerWidth));
		this.#body.setHeight(rows);
		this.#footer.setLines([theme.fg("dim", this.#footerText())]);
		return this.#panel.render(width);
	}

	/**
	 * The form natively: question tabs and a Review tab (two or more questions),
	 * the shown tab's sections in a height-capped column the terminal scrolls,
	 * then the action bar, which stays in view however long the form is. Option
	 * lists `select` to focus/pick (a checkbox `select` toggles); the focused text
	 * field is its live `Input`/`Editor`. Hidden, it is one summary row.
	 */
	describe(_cx: DescribeContext): NativeNode {
		const blocked = this.#guardBlocks();
		this.#options.inputGuard?.syncPresentation?.(blocked);
		// Other answers are typed into the terminal's own inputs, which don't pass through handleInput.
		const others = [...this.#others.values()].map(input => input.getValue()).join("\0");
		const key = `${this.#version}\0${blocked}\0${others}`;
		if (this.#native?.key === key) return this.#native.node;
		const described = this.#hidden ? this.#describeHidden() : this.#describeForm(blocked);
		this.#native = { key, node: described };
		return described;
	}

	invalidate(): void {
		this.#height = undefined;
		this.#native = undefined;
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#stopCountdown();
		this.#mediaAbort.abort();
		for (const slot of this.#media.values()) {
			if (slot.state === "ready" && slot.rows instanceof SvgFigure) slot.rows.dispose();
		}
		this.#panel.dispose();
	}

	// ── Pictures ─────────────────────────────────────────────────────────────

	/** An inline `<svg>` is ready at once; an `<img>` loads in the background and re-renders when it lands. */
	#initMedia(block: MediaBlock): void {
		if (block.kind === "svg") {
			this.#media.set(block, this.#readyMedia(svgMedia(block.markup), block.alt || "drawing"));
			return;
		}
		this.#media.set(block, { state: "loading" });
		const signal = this.#mediaAbort.signal;
		loadFormImage(block.src, { cwd: this.#options.cwd ?? process.cwd(), signal }).then(
			media => this.#settleMedia(block, this.#readyMedia(media, block.alt || "image")),
			(error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				this.#settleMedia(block, { state: "failed", reason });
			},
		);
	}

	#settleMedia(block: MediaBlock, slot: MediaSlot): void {
		if (this.#mediaAbort.signal.aborted) return;
		this.#media.set(block, slot);
		this.#mediaChanged();
	}

	#mediaChanged(): void {
		this.#mediaVersion++;
		this.#changed();
		this.#options.tui?.requestRender();
	}

	/** Rows draw a raster through {@link Image} and an SVG through {@link SvgFigure}; natively both are image blobs. */
	#readyMedia(media: FormMedia, alt: string): MediaSlot {
		const maxRows = this.#pictureRows();
		const native = nativeImageNode(media.bytes, media.mime, { alt, max: { h: `${maxRows}lines` } });
		if (isSvgMedia(media)) {
			const figure = new SvgFigure({ maxRows: () => maxRows, onChange: () => this.#mediaChanged() });
			figure.update(new TextDecoder().decode(media.bytes), true);
			return { state: "ready", rows: figure, native };
		}
		const image = new Image(
			media.bytes.toBase64(),
			media.mime,
			{ fallbackColor: text => theme.fg("dim", text) },
			{ maxHeightCells: maxRows, filename: alt, requestRender: () => this.#mediaChanged() },
		);
		return { state: "ready", rows: image, native };
	}

	/** Rows one picture may fill: a third of the terminal, within sensible bounds. */
	#pictureRows(): number {
		const termRows = this.#options.tui?.terminal.rows ?? process.stdout.rows ?? 40;
		return Math.max(4, Math.min(MAX_PICTURE_ROWS, Math.floor(termRows * PICTURE_SHARE)));
	}

	/** One dim row standing in for a picture that is loading or could not be shown. */
	#mediaNote(block: MediaBlock, slot: MediaSlot): string {
		const name = sanitize(block.alt || (block.kind === "image" ? block.src.slice(0, 80) : "drawing"));
		if (slot.state === "failed") return `▣ ${name} — couldn't load: ${sanitize(slot.reason)}`;
		return `▣ ${name} — loading…`;
	}

	// ── State ────────────────────────────────────────────────────────────────

	#changed(): void {
		this.#version++;
	}

	#initChoice(field: ChoiceField): void {
		const checked = new Set<number>();
		field.options.forEach((option, index) => {
			if (!option.checked) return;
			// Several checked radios: the last one wins, as in a browser.
			if (!field.multi) checked.clear();
			checked.add(index);
		});
		this.#checked.set(field, checked);
	}

	#initText(field: TextField): void {
		if (field.multiline) {
			const editor = new Editor(getEditorTheme());
			editor.setBorderVisible(false);
			editor.setMaxHeight(this.#textareaRows(field));
			// Enter leaves the field (handled before the editor); Shift+Enter inserts newlines.
			editor.disableSubmit = true;
			editor.placeholder = () => field.placeholder || undefined;
			// Prefilled drafts (a commit message) open at their first line, not scrolled to the end.
			editor.setText(field.value, { cursor: "start" });
			this.#editors.set(field, editor);
			return;
		}
		const input = new Input();
		input.prompt = "";
		input.mask = field.type === "password";
		input.placeholder = field.placeholder || undefined;
		input.setValue(field.value, { cursor: "start" });
		input.onSubmit = () => this.#moveField(1);
		this.#inputs.set(field, input);
	}

	/** Fixed textarea height: the `rows` asked for, grown to fit a prefilled draft, capped. */
	#textareaRows(field: TextField): number {
		const draftRows = field.value.split("\n").length;
		return Math.min(MAX_TEXTAREA_ROWS, Math.max(2, field.rows, draftRows));
	}

	#textValue(field: TextField): string {
		return field.multiline ? this.#editors.get(field)!.getExpandedText() : this.#inputs.get(field)!.getValue();
	}

	#value(field: FormField): HtmlFormValue | undefined {
		if (field.kind === "text") return textValue(field, this.#textValue(field));
		const other = this.#otherChosen(field) ? this.#others.get(field)!.getValue() : undefined;
		return choiceValue(field, this.#checked.get(field)!, other);
	}

	/**
	 * Whether a group's Other answer counts: it has text and, for a radio group, no
	 * option is picked. Typing into a radio group's Other (from keys or the
	 * terminal's own edits) drops the picked option; picking an option afterwards
	 * keeps the text but sets Other aside.
	 */
	#otherChosen(field: ChoiceField): boolean {
		const input = this.#others.get(field);
		if (!input) return false;
		const text = input.getValue();
		if (!field.multi && text !== (this.#otherSeen.get(field) ?? "")) {
			this.#otherSeen.set(field, text);
			if (text.trim() !== "") this.#checked.get(field)!.clear();
		}
		if (text.trim() === "") return false;
		return field.multi || this.#checked.get(field)!.size === 0;
	}

	/** The first checked option of a single-choice field. */
	#current(field: ChoiceField): number | undefined {
		return this.#checked.get(field)!.values().next().value;
	}

	#toggle(field: ChoiceField, option: number): void {
		if (!field.multi) {
			this.#choose(field, option);
			return;
		}
		const checked = this.#checked.get(field)!;
		if (!checked.delete(option)) checked.add(option);
		this.#errors.delete(field);
	}

	#choose(field: ChoiceField, option: number): void {
		const checked = this.#checked.get(field)!;
		checked.clear();
		checked.add(option);
		this.#errors.delete(field);
	}

	/** The nearest enabled option `delta` steps from `from`, clamped to the ends; `from` when none. */
	#step(field: ChoiceField, from: number, delta: number): number {
		const direction = Math.sign(delta);
		let found = from;
		let remaining = Math.abs(delta);
		for (
			let index = from + direction;
			index >= 0 && index < field.options.length && remaining > 0;
			index += direction
		) {
			if (field.options[index]!.disabled) continue;
			found = index;
			remaining--;
		}
		return found;
	}

	/** The next enabled option after `from` (wrapping) whose label starts with `typed`. */
	#typeAhead(field: ChoiceField, from: number, typed: string): number | undefined {
		const prefix = typed.toLowerCase();
		const count = field.options.length;
		for (let offset = 1; offset <= count; offset++) {
			const index = (from + offset) % count;
			const option = field.options[index]!;
			if (!option.disabled && optionText(option).toLowerCase().startsWith(prefix)) return index;
		}
		return undefined;
	}

	#submit(): void {
		this.#errors.clear();
		for (const field of this.#form.fields) {
			const error = fieldError(field, this.#value(field));
			if (error) this.#errors.set(field, error);
		}
		if (this.#errors.size === 0) {
			this.#stopCountdown();
			this.#options.onSubmit(this.data());
			return;
		}
		const first = this.#stops.findIndex(stop => stop.kind !== "submit" && this.#errors.has(stop.field));
		if (first !== -1) this.#setFocus(first);
	}

	#cancel(): void {
		this.#stopCountdown();
		this.#options.onCancel();
	}

	// ── Countdown ────────────────────────────────────────────────────────────

	#startCountdown(): void {
		const timeout = this.#options.timeout;
		if (timeout === undefined || timeout <= 0) return;
		this.#deadline = Date.now() + timeout;
		this.#remaining = Math.ceil(timeout / 1000);
		this.#tick = setInterval(() => this.#onTick(), 1000);
	}

	#onTick(): void {
		const left = this.#deadline - Date.now();
		this.#changed();
		if (left <= 0) {
			this.#stopCountdown();
			this.#options.onTimeout?.(this.data());
			return;
		}
		this.#remaining = Math.ceil(left / 1000);
		this.#options.tui?.requestRender();
	}

	#resetCountdown(): void {
		const timeout = this.#options.timeout;
		if (this.#tick === undefined || timeout === undefined) return;
		this.#deadline = Date.now() + timeout;
		this.#remaining = Math.ceil(timeout / 1000);
	}

	#stopCountdown(): void {
		clearInterval(this.#tick);
		this.#tick = undefined;
		this.#remaining = undefined;
	}

	// ── Keys ─────────────────────────────────────────────────────────────────

	/** True while a draft that predates the form still owns typing. */
	#guardBlocks(): boolean {
		return !this.#guardReleased && (this.#options.inputGuard?.isBlocked() ?? false);
	}

	#guardHint(guard: AskDialogInputGuard): string {
		return `${editorKeys("tui.select.up", "tui.select.down")} answer · ${guard.hint}`;
	}

	#textInput(field: TextField, data: string): void {
		const up = matchesSelectUp(data);
		const down = matchesSelectDown(data);
		const editor = this.#editors.get(field);
		if (!editor) {
			if (up || down) {
				this.#moveStop(down ? 1 : -1);
				return;
			}
			const before = this.#textValue(field);
			this.#inputs.get(field)!.handleInput(data);
			if (this.#textValue(field) !== before) this.#errors.delete(field);
			return;
		}
		const cursor = editor.getCursor();
		if ((up && cursor.line === 0) || (down && cursor.line === editor.getLines().length - 1)) {
			this.#moveStop(down ? 1 : -1);
			return;
		}
		if (getKeybindings().matches(data, "tui.input.submit")) {
			this.#moveField(1);
			return;
		}
		const before = editor.getText();
		editor.handleInput(data);
		if (editor.getText() !== before) this.#errors.delete(field);
	}

	/**
	 * The Other row is a text field: keys type into it (typing in a radio group's
	 * Other drops the picked option), ↑/↓ leave it, Enter moves to the next field.
	 */
	#otherInput(field: ChoiceField, data: string): void {
		if (matchesSelectUp(data) || matchesSelectDown(data)) {
			this.#moveStop(matchesSelectDown(data) ? 1 : -1);
			return;
		}
		const input = this.#others.get(field)!;
		if (getKeybindings().matches(data, "tui.select.confirm")) {
			// Back on Other after picking an option: Enter makes the kept text the answer again.
			if (!field.multi && input.getValue().trim() !== "") this.#checked.get(field)!.clear();
			this.#moveField(1);
			return;
		}
		const before = input.getValue();
		input.handleInput(data);
		if (input.getValue() !== before) this.#errors.delete(field);
	}

	/** A closed dropdown: ←/→ change it, Space opens it, a letter jumps to a matching option. */
	#selectInput(field: ChoiceField, data: string): void {
		const current = this.#current(field) ?? -1;
		if (matchesSelectUp(data) || matchesSelectDown(data)) {
			this.#moveStop(matchesSelectDown(data) ? 1 : -1);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const next = this.#step(field, current, matchesKey(data, "right") ? 1 : -1);
			if (next >= 0) this.#choose(field, next);
			return;
		}
		if (matchesKey(data, "space")) {
			this.#open = { field, highlight: current >= 0 ? current : this.#step(field, -1, 1) };
			return;
		}
		if (getKeybindings().matches(data, "tui.select.confirm")) {
			this.#moveField(1);
			return;
		}
		const typed = extractPrintableText(data);
		const match = typed ? this.#typeAhead(field, current, typed) : undefined;
		if (match !== undefined) this.#choose(field, match);
	}

	/** An open dropdown owns the keys until a pick (Enter/Space), Esc or Tab closes it. */
	#dropdownInput(open: { field: ChoiceField; highlight: number }, data: string): void {
		if (matchesSelectCancel(data)) {
			this.#open = undefined;
			return;
		}
		if (matchesSelectUp(data) || matchesSelectDown(data)) {
			open.highlight = this.#step(open.field, open.highlight, matchesSelectDown(data) ? 1 : -1);
			return;
		}
		if (matchesSelectPageUp(data) || matchesSelectPageDown(data)) {
			const delta = matchesSelectPageDown(data) ? DROPDOWN_PAGE : -DROPDOWN_PAGE;
			open.highlight = this.#step(open.field, open.highlight, delta);
			return;
		}
		if (matchesKey(data, "space") || getKeybindings().matches(data, "tui.select.confirm")) {
			if (open.highlight >= 0) this.#choose(open.field, open.highlight);
			this.#open = undefined;
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#open = undefined;
			this.#moveField(matchesKey(data, "shift+tab") ? -1 : 1);
			return;
		}
		const typed = extractPrintableText(data);
		const match = typed ? this.#typeAhead(open.field, open.highlight, typed) : undefined;
		if (match !== undefined) open.highlight = match;
	}

	#setFocus(index: number): void {
		this.#focus = Math.max(0, Math.min(this.#stops.length - 1, index));
		this.#followFocus = true;
		this.#syncControlFocus();
		if (this.#tabbed()) this.#enterTab(this.#tabOfStop(this.#focus));
	}

	#moveStop(delta: number): void {
		this.#setFocus(this.#focus + delta);
	}

	/** Jump to the first stop of the next (or previous) field; Submit counts as a field. */
	#moveField(delta: number): void {
		const fieldOf = (stop: Stop | undefined) => (stop && stop.kind !== "submit" ? stop.field : stop);
		const current = fieldOf(this.#stops[this.#focus]);
		let index = this.#focus;
		while (index + delta >= 0 && index + delta < this.#stops.length && fieldOf(this.#stops[index]) === current) {
			index += delta;
		}
		// Moving back lands on the previous field's first stop, not its last.
		const target = fieldOf(this.#stops[index]);
		while (delta < 0 && index > 0 && fieldOf(this.#stops[index - 1]) === target) index--;
		this.#setFocus(index);
	}

	#turnPage(delta: number): void {
		if (isNativeRendering()) {
			if (this.#tabbed()) this.#showTab(this.#tab + delta);
			return;
		}
		if (this.#pages.length < 2) return;
		const target = Math.max(0, Math.min(this.#pages.length - 1, this.#page + delta));
		const page = this.#pages[target]!;
		const stop = this.#stopAtoms.findIndex(atom => atom >= page.start && atom < page.end);
		if (stop !== -1) {
			this.#setFocus(stop);
			return;
		}
		this.#page = target;
		this.#followFocus = false;
	}

	#pageOfAtom(atom: number): number {
		const index = this.#pages.findIndex(page => atom >= page.start && atom < page.end);
		return index === -1 ? 0 : index;
	}

	#syncControlFocus(): void {
		const stop = this.#stops[this.#focus];
		const live = this.#focused && !this.#hidden;
		const active = stop?.kind === "text" ? stop.field : undefined;
		const other = stop?.kind === "other" ? stop.field : undefined;
		for (const [field, input] of this.#inputs) input.focused = live && field === active;
		for (const [field, input] of this.#others) input.focused = live && field === other;
		for (const [field, editor] of this.#editors) editor.focused = live && field === active;
	}

	// ── Tabs and hiding ──────────────────────────────────────────────────────

	/** Question tabs (and Review) show natively only for two or more questions. */
	#tabbed(): boolean {
		return this.#tabs.length > 1;
	}

	/** The tab holding stop `index`: its field's question tab, or Review for Submit. */
	#tabOfStop(index: number): number {
		const stop = this.#stops[index];
		if (!stop || stop.kind === "submit") return this.#tabs.length;
		return this.#fieldTab.get(stop.field) ?? 0;
	}

	/** Show tab `index` (`#tabs.length` is Review), focusing its first stop. */
	#showTab(index: number): void {
		const tab = Math.max(0, Math.min(this.#tabs.length, index));
		const stop = this.#stops.findIndex((_, stopIndex) => this.#tabOfStop(stopIndex) === tab);
		if (stop !== -1) this.#setFocus(stop);
		this.#enterTab(tab);
	}

	#enterTab(tab: number): void {
		if (tab !== this.#tab) this.#leftTabs.add(this.#tab);
		this.#tab = tab;
	}

	#setHidden(hidden: boolean): void {
		if (this.#hidden === hidden) return;
		this.#hidden = hidden;
		this.#open = undefined;
		this.#syncControlFocus();
	}

	/** The question in focus (else the first) for the hidden row, with how many more there are. */
	#hiddenSummary(): string {
		const stop = this.#stops[this.#focus];
		const field = stop && stop.kind !== "submit" ? stop.field : this.#form.fields[0];
		const question = field ? sanitize(this.#questions.get(field) ?? "").replace(/\s+/g, " ") : "";
		const more = this.#form.fields.length - 1;
		return more > 0 ? `${question} (+${more} more)` : question;
	}

	/** Hidden: one row in the composer's place, the title, the question clipped to fit, and how to bring it back. */
	#renderHidden(width: number): readonly string[] {
		const hideKey = editorKey("app.ask.hide");
		const enter = formatKeyHint("enter");
		const guard = this.#options.inputGuard;
		const blocked = this.#guardBlocks();
		// While a draft owns input, Enter goes to the draft, so only the hide key restores.
		const show = blocked ? hideKey : hideKey ? `${hideKey}/${enter}` : enter;
		const hints: string[] = [];
		if (blocked && guard) hints.push(this.#guardHint(guard));
		if (show) hints.push(`${show} show`);
		hints.push(`${editorKey("tui.select.cancel")} cancel`);
		const hint = theme.fg("dim", ` · ${hints.join(" · ")}`);
		const label = theme.fg("accent", `${this.#titleText()} hidden:`);
		const room = Math.max(1, width - visibleWidth(label) - visibleWidth(hint) - 1);
		const summary = truncateToWidth(this.#hiddenSummary(), room, Ellipsis.Unicode);
		return [truncateToWidth(`${label} ${theme.fg("muted", summary)}${hint}`, width, Ellipsis.Unicode)];
	}

	// ── Rows ─────────────────────────────────────────────────────────────────

	#titleText(): string {
		const title = this.#options.title ?? DEFAULT_TITLE;
		return this.#remaining === undefined ? title : `${title} (${this.#remaining}s)`;
	}

	/**
	 * Body rows: the whole form's natural height, capped by the terminal. Fixed
	 * per width, terminal height and error count, so moving focus or typing
	 * never resizes the panel; only a failed submit (new error rows) may.
	 */
	#bodyRows(width: number, atoms: readonly PageAtom[]): number {
		const termRows = this.#options.tui?.terminal.rows ?? process.stdout.rows ?? 40;
		const key = `${width}:${termRows}:${this.#errors.size}:${this.#mediaVersion}`;
		if (this.#height?.key === key) return this.#height.rows;
		const cap = Math.max(MIN_BODY_ROWS, Math.floor(termRows * DIALOG_HEIGHT_RATIO) - CHROME_ROWS);
		const rows = Math.min(cap, Math.max(1, pageHeight(atoms, 0, atoms.length)));
		this.#height = { key, rows };
		return rows;
	}

	#renderPage(layout: Layout, page: Page, rows: number, width: number): string[] {
		const { atoms, dropdown } = layout;
		const lines: string[] = [];
		const continuation = atoms[page.start]?.continuation;
		if (continuation !== undefined) {
			lines.push(theme.fg("dim", truncateToWidth(`${continuation} (cont.)`, width, Ellipsis.Unicode)));
		}
		let anchor: { top: number; row: number } | undefined;
		for (let index = page.start; index < page.end; index++) {
			const atom = atoms[index]!;
			if (index > page.start) for (let gap = 0; gap < atom.gap; gap++) lines.push("");
			if (dropdown?.atom === index) anchor = { top: lines.length, row: lines.length + dropdown.row };
			lines.push(...atom.lines);
		}
		const shown = lines.slice(0, rows);
		if (anchor && this.#open && anchor.row < rows) this.#overlayDropdown(shown, anchor, rows, width);
		return shown;
	}

	/**
	 * Draw the open dropdown over the page rows below its value row, or above
	 * its field when there is more room there. It covers rows rather than
	 * pushing them, so pages keep their layout while it is open.
	 */
	#overlayDropdown(lines: string[], anchor: { top: number; row: number }, rows: number, width: number): void {
		const open = this.#open!;
		const below = rows - anchor.row - 1;
		const above = anchor.top;
		const wanted = open.field.options.length + 2;
		const placeBelow = below >= Math.min(wanted, 5) || below >= above;
		const box = this.#dropdownLines(open, width, placeBelow ? below : above);
		if (box.length === 0) return;
		const start = placeBelow ? anchor.row + 1 : anchor.top - box.length;
		while (lines.length < start + box.length) lines.push("");
		box.forEach((line, offset) => {
			lines[start + offset] = `${padding(FIELD_INDENT - 2)}${line}`;
		});
	}

	/** The dropdown box at most `maxRows` tall, scrolled to keep the highlight visible; empty when it cannot fit. */
	#dropdownLines(open: { field: ChoiceField; highlight: number }, width: number, maxRows: number): string[] {
		const options = open.field.options;
		const visible = Math.min(options.length, maxRows - 2);
		if (visible < 1) return [];
		const box = theme.boxRound;
		const labels = options.map(optionText);
		// Content columns: cursor (2) + label + gap (1) + current-value mark (1), padded by a column each side.
		const inner = Math.max(
			4,
			Math.min(width - FIELD_INDENT - 4, Math.max(...labels.map(label => visibleWidth(label))) + 4),
		);
		const first = Math.max(0, Math.min(options.length - visible, open.highlight - Math.floor(visible / 2)));
		const current = this.#current(open.field);
		const edge = (left: string, right: string, more: boolean, arrow: string): string => {
			const rule = box.horizontal.repeat(inner + 2);
			const marked = more ? `${box.horizontal}${arrow}${rule.slice(2)}` : rule;
			return theme.fg("accent", `${left}${marked}${right}`);
		};
		const out = [edge(box.topLeft, box.topRight, first > 0, "↑")];
		for (let index = first; index < first + visible; index++) {
			const highlighted = index === open.highlight;
			const option = options[index]!;
			const cursor = highlighted ? `${theme.nav.cursor} ` : "  ";
			const mark = index === current ? theme.fg("success", "✓") : " ";
			const color: ThemeColor = option.disabled ? "dim" : highlighted ? "accent" : "text";
			const label = truncateToWidth(labels[index]!, Math.max(1, inner - 4), Ellipsis.Unicode);
			const cell = `${theme.fg(color, `${cursor}${label}`)}${padding(inner - 3 - visibleWidth(label))}${mark}`;
			out.push(`${theme.fg("accent", `${box.vertical} `)}${cell}${theme.fg("accent", ` ${box.vertical}`)}`);
		}
		out.push(edge(box.bottomLeft, box.bottomRight, first + visible < options.length, "↓"));
		return out;
	}

	#footerText(): string {
		const hideKey = editorKey("app.ask.hide");
		const cancel = `${editorKey("tui.select.cancel")} cancel${hideKey ? ` · ${hideKey} hide` : ""}`;
		const guard = this.#options.inputGuard;
		if (guard && this.#guardBlocks()) return `${this.#guardHint(guard)} · ${cancel}`;
		const stop = this.#stops[this.#focus]!;
		const enter = formatKeyHint("enter");
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		if (this.#open) return `${upDown} highlight · ${enter} choose · ${editorKey("tui.select.cancel")} close`;
		let action: string;
		if (stop.kind === "submit") action = `${enter} submit`;
		else if (stop.kind === "text") action = `${enter} next`;
		else if (stop.kind === "other") action = `type your own · ${enter} next`;
		else if (stop.kind === "select")
			action = `${formatKeyHint("space")} open · ${formatKeyHint("left")}/${formatKeyHint("right")} change · ${enter} next`;
		else if (stop.field.multi) action = `${formatKeyHint("space")} toggle · ${enter} next`;
		else action = `${enter} choose`;
		const hints = [action, `${upDown} move`, `${formatKeyHint("tab")} next field`, cancel];
		if (this.#pages.length > 1) {
			const keys =
				stop.kind === "text" || stop.kind === "select"
					? editorKeys("tui.select.pageUp", "tui.select.pageDown")
					: `${formatKeyHint("left")}/${formatKeyHint("right")}`;
			hints.push(`${keys} page`);
		}
		return hints.join(" · ");
	}

	#layout(width: number): Layout {
		const atoms: PageAtom[] = [];
		const stopAtoms: number[] = [];
		let dropdown: Layout["dropdown"];
		let stop = 0;
		const focusedStop = this.#focused ? this.#focus : -1;
		this.#form.sections.forEach((section, sectionIndex) => {
			const title = sanitize(spansText(section.title)).replace(/\s+/g, " ");
			let gap = sectionIndex === 0 ? 0 : 1;
			let rank = BreakRank.Section;
			if (title) {
				atoms.push({
					lines: hang("", section.title, text => theme.bold(theme.fg("text", text)), width),
					gap,
					breakRank: rank,
				});
				gap = 0;
				rank = BreakRank.Never;
			}
			/** Atom range of the text block just emitted, a candidate caption for a following field. */
			let caption: { start: number; end: number } | undefined;
			for (const block of section.blocks) {
				const blockAtoms: PageAtom[] = [];
				if (block.kind === "field") {
					// Models ask a group's question in a `<p>` right before it: keep the two as one unit.
					if (caption && caption.end - caption.start <= CAPTION_MAX_ROWS) {
						for (let index = caption.start + 1; index < caption.end; index++) {
							atoms[index]!.breakRank = BreakRank.Never;
						}
						gap = 0;
						rank = BreakRank.Never;
					}
					const field = block.field;
					for (const [atom, isStop] of this.#fieldAtoms(field, width, focusedStop, stop)) {
						if (isStop) stopAtoms[stop++] = atoms.length + blockAtoms.length;
						blockAtoms.push(atom);
					}
					if (field.kind === "choice" && this.#open?.field === field) {
						dropdown = { atom: atoms.length, row: field.label.length > 0 ? blockAtoms[0]!.lines.length - 1 : 0 };
					}
				} else {
					blockAtoms.push(...this.#contextAtoms(block, width));
				}
				if (blockAtoms.length === 0) continue;
				blockAtoms[0]!.gap = gap;
				blockAtoms[0]!.breakRank = rank;
				// No orphans or widows: a split block keeps at least two atoms on each page.
				if (blockAtoms.length > 1) {
					blockAtoms[1]!.breakRank = BreakRank.Never;
					blockAtoms[blockAtoms.length - 1]!.breakRank = BreakRank.Never;
				}
				caption =
					block.kind === "text" ? { start: atoms.length, end: atoms.length + blockAtoms.length } : undefined;
				for (const atom of blockAtoms) {
					if (title) atom.continuation = title;
					atoms.push(atom);
				}
				gap = 1;
				rank = BreakRank.Block;
			}
		});
		const submitFocused = focusedStop === this.#stops.length - 1;
		const submit = submitFocused
			? theme.fg("accent", theme.bold(`${theme.nav.cursor} ${SUBMIT_LABEL}`))
			: theme.fg("muted", `  ${SUBMIT_LABEL}`);
		const pending = this.#errors.size > 0 ? theme.fg("error", `  ${this.#errors.size} to fix`) : "";
		stopAtoms[stop] = atoms.length;
		atoms.push({ lines: [`${submit}${pending}`], gap: 1, breakRank: BreakRank.Block });
		return { atoms, stopAtoms, dropdown };
	}

	/** Atoms of one field, each flagged when it is a focus stop; stops are numbered from `firstStop`. */
	#fieldAtoms(field: FormField, width: number, focusedStop: number, firstStop: number): [PageAtom, boolean][] {
		const error = this.#errors.get(field);
		const errorLines = error
			? [padding(FIELD_INDENT) + theme.fg("error", truncateToWidth(error, Math.max(1, width - FIELD_INDENT)))]
			: [];
		if (field.kind === "text" || isDropdown(field)) {
			const focused = focusedStop === firstStop;
			const lines =
				field.kind === "text"
					? this.#textFieldLines(field, focused, width)
					: this.#dropdownFieldLines(field, focused, width);
			const hasStop = field.kind === "text" || field.options.some(option => !option.disabled);
			return [[{ lines: [...lines, ...errorLines], gap: 0, breakRank: BreakRank.Inside }, hasStop]];
		}
		const out: [PageAtom, boolean][] = [];
		if (field.label.length > 0) {
			out.push([
				{
					lines: hang("  ", field.label, text => theme.fg("text", text), width),
					gap: 0,
					breakRank: BreakRank.Inside,
				},
				false,
			]);
		}
		const checked = this.#checked.get(field)!;
		let stop = firstStop;
		field.options.forEach((option, index) => {
			const focused = !option.disabled && focusedStop === stop;
			if (!option.disabled) stop++;
			const isChecked = checked.has(index);
			const cursor = focused ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const marker = theme.fg(isChecked ? "success" : "dim", optionMarker(theme, field.multi, isChecked));
			const color: ThemeColor = option.disabled ? "dim" : focused ? "accent" : isChecked ? "toolOutput" : "text";
			const lines = hang(`${cursor}${marker} `, option.label, text => theme.fg(color, text), width);
			out.push([{ lines, gap: 0, breakRank: BreakRank.Inside }, !option.disabled]);
		});
		if (field.other)
			out.push([
				{ lines: [this.#otherLine(field, focusedStop === stop, width)], gap: 0, breakRank: BreakRank.Inside },
				true,
			]);
		if (errorLines.length > 0) out.push([{ lines: errorLines, gap: 0, breakRank: BreakRank.Never }, false]);
		return out;
	}

	/** `○ Other: <text>` — an inline input while focused, else the text or a dim prompt. */
	#otherLine(field: ChoiceField, focused: boolean, width: number): string {
		const chosen = this.#otherChosen(field);
		const input = this.#others.get(field)!;
		const cursor = focused ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
		const marker = theme.fg(chosen ? "success" : "dim", optionMarker(theme, field.multi, chosen));
		const label = theme.fg(focused ? "accent" : chosen ? "toolOutput" : "text", `${OTHER_LABEL}: `);
		const prefix = `${cursor}${marker} ${label}`;
		const inner = Math.max(1, width - visibleWidth(prefix));
		const value = input.getValue();
		if (focused) {
			input.cursorOverride =
				value === ""
					? `\x1b[7m \x1b[27m${theme.fg("dim", truncateToWidth(OTHER_PLACEHOLDER, Math.max(1, inner - 1)))}`
					: undefined;
			return `${prefix}${input.render(inner)[0] ?? ""}`;
		}
		const shown = value
			? theme.fg(chosen ? "toolOutput" : "dim", truncateToWidth(sanitize(value), inner, Ellipsis.Unicode))
			: theme.fg("dim", OTHER_PLACEHOLDER);
		return `${prefix}${shown}`;
	}

	/** Label rows with the focus cursor, a required star and an optional dim suffix. */
	#labelLines(field: FormField, focused: boolean, suffix: string, width: number): string[] {
		const cursor = focused ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
		const required = field.required ? theme.fg("error", " *") : "";
		const label = hang(cursor, field.label, text => theme.fg(focused ? "accent" : "text", text), width);
		if (label.length === 0) label.push(cursor);
		label[label.length - 1] += required + suffix;
		return label;
	}

	/** A dropdown's label and its one value row: `‹ us-east-1 (N. Virginia) ›  1/8`. */
	#dropdownFieldLines(field: ChoiceField, focused: boolean, width: number): string[] {
		const current = this.#current(field);
		const enabled = field.options.filter(option => !option.disabled).length;
		const position = current === undefined ? "" : theme.fg("dim", `  ${current + 1}/${field.options.length}`);
		const inner = Math.max(1, width - FIELD_INDENT - 4 - visibleWidth(position));
		const value =
			current === undefined
				? theme.fg("dim", "—")
				: theme.fg(
						focused ? "accent" : "toolOutput",
						truncateToWidth(optionText(field.options[current]!), inner, Ellipsis.Unicode),
					);
		const arrows = focused && enabled > 1 ? "accent" : "dim";
		const row = `${theme.fg(arrows, "‹ ")}${value}${theme.fg(arrows, " ›")}${position}`;
		if (field.label.length === 0) {
			const cursor = focused ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const required = field.required ? theme.fg("error", " *") : "";
			return [`${cursor}${row}${required}`];
		}
		const bar = theme.fg(focused ? "accent" : "border", theme.boxRound.vertical);
		return [...this.#labelLines(field, focused, "", width), `${padding(FIELD_INDENT - 2)}${bar} ${row}`];
	}

	#textFieldLines(field: TextField, focused: boolean, width: number): string[] {
		const bounds =
			field.min !== undefined && field.max !== undefined
				? `${field.min}–${field.max}`
				: field.min !== undefined
					? `≥ ${field.min}`
					: field.max !== undefined
						? `≤ ${field.max}`
						: "";
		const label = this.#labelLines(field, focused, bounds ? theme.fg("dim", `  ${bounds}`) : "", width);
		const bar = theme.fg(focused ? "accent" : "border", theme.boxRound.vertical);
		const prefix = `${padding(FIELD_INDENT - 2)}${bar} `;
		const inner = Math.max(1, width - FIELD_INDENT);
		const value = this.#textValue(field);
		let rows: string[];
		if (field.multiline) {
			const height = this.#textareaRows(field);
			rows = focused
				? [...this.#editors.get(field)!.render(inner)]
				: value
					? sanitize(value)
							.split("\n")
							.map(line => theme.fg("toolOutput", truncateToWidth(line, inner, Ellipsis.Unicode)))
					: [theme.fg("dim", truncateToWidth(sanitize(field.placeholder), inner, Ellipsis.Unicode))];
			if (rows.length > height) {
				rows = rows.slice(0, height);
				if (!focused) rows[height - 1] = theme.fg("dim", truncateToWidth("…", inner));
			}
			while (rows.length < height) rows.push("");
		} else if (focused) {
			const input = this.#inputs.get(field)!;
			input.cursorOverride =
				value === "" && field.placeholder
					? `\x1b[7m \x1b[27m${theme.fg("dim", truncateToWidth(sanitize(field.placeholder), Math.max(1, inner - 1)))}`
					: undefined;
			rows = [...input.render(inner)];
		} else if (value) {
			const shown = field.type === "password" ? "•".repeat(value.length) : sanitize(value);
			rows = [theme.fg("toolOutput", truncateToWidth(shown, inner, Ellipsis.Unicode))];
		} else {
			rows = [theme.fg("dim", truncateToWidth(sanitize(field.placeholder), inner, Ellipsis.Unicode))];
		}
		return [...label, ...rows.map(row => `${prefix}${row}`)];
	}

	/** Atoms of a non-field block: one per wrapped line, list item or table row. */
	#contextAtoms(block: Exclude<FormBlock, { kind: "field" }>, width: number): PageAtom[] {
		const atom = (lines: string[], breakRank = BreakRank.Inside): PageAtom => ({ lines, gap: 0, breakRank });
		switch (block.kind) {
			case "text": {
				const base = block.heading
					? (text: string) => theme.bold(theme.fg("text", text))
					: (text: string) => theme.fg("muted", text);
				return hang("", block.spans, base, width).map(line => atom([line]));
			}
			case "list":
				return block.items.map((item, index) => {
					const bullet = theme.fg("mdListBullet", block.ordered ? `${index + 1}. ` : "• ");
					return atom(hang(bullet, item, text => theme.fg("muted", text), width));
				});
			case "pre":
				return sanitize(block.text)
					.split("\n")
					.map(line =>
						atom([
							`  ${theme.fg("mdCodeBlock", truncateToWidth(line, Math.max(1, width - 2), Ellipsis.Unicode))}`,
						]),
					);
			case "image":
			case "svg": {
				const slot = this.#media.get(block)!;
				const rows = slot.state === "ready" ? slot.rows.render(width) : [];
				if (rows.length > 0) return [atom([...rows])];
				return [atom([theme.fg("dim", truncateToWidth(this.#mediaNote(block, slot), width, Ellipsis.Unicode))])];
			}
			case "table": {
				const cells = block.rows.map(row => row.map(cell => sanitize(spansText(cell)).replace(/\s+/g, " ")));
				const count = Math.max(0, ...cells.map(row => row.length));
				const columns: TableColumn[] = Array.from({ length: count }, (_, column) => ({
					width: Math.max(1, ...cells.map(row => visibleWidth(row[column] ?? ""))),
					minWidth: 4,
					align: "left",
					overflow: "truncate",
				}));
				const atoms = cells.map((row, index) => {
					const style =
						index < block.headerRows
							? (text: string) => theme.bold(theme.fg("text", text))
							: (text: string) => theme.fg("muted", text);
					const padded = Array.from({ length: count }, (_, column) => ({ text: row[column] ?? "", style }));
					return atom([renderTableRow(padded, columns, width, { gap: "  " })]);
				});
				if (block.headerRows > 0 && block.headerRows < atoms.length) {
					atoms.splice(block.headerRows, 0, atom([theme.fg("dim", "─".repeat(width))], BreakRank.Never));
				}
				return atoms;
			}
		}
	}

	// ── Native ───────────────────────────────────────────────────────────────

	/**
	 * Tern's stylesheet caps the ask card at 60vh, clips what overflows, and lets only a few of
	 * its direct children shrink and scroll: a `list` in the `omp.ask.options` role and a `kv` in
	 * `omp.ask.answers`. A tab's content therefore sits in one such list (a `col` capped by `max`
	 * only clips), so it scrolls inside the card and the action bar below stays in view.
	 */
	#describeForm(blocked: boolean): NativeNode {
		const tabbed = this.#tabbed();
		const review = tabbed && this.#tab === this.#tabs.length;
		const children: NativeChild[] = [];
		if (tabbed) children.push(this.#describeTabs());
		if (review) {
			children.push(...this.#describeReview());
		} else {
			const form = col(this.#describeSections(this.#tabs[this.#tab]?.sections ?? []), {
				gap: "lg",
				role: "omp.ask.form",
			});
			// Keyed per tab, so a tab switch mounts a fresh scroller that opens at its top. The key
			// stays clear of `f<index>`, the option lists' keys `handleNativeEvent` reads.
			children.push(list([form], { role: "omp.ask.options" }, `body${this.#tab}`));
		}
		const next = tabbed && !review;
		const submit = !next || this.#tab === this.#tabs.length - 1;
		children.push(this.#describeActions(blocked, next, submit));
		return col(children, { role: "omp.editor.ask", gap: "md" });
	}

	/** One tab per question, checked once the user has left it with no field failing validation, then Review. */
	#describeTabs(): NativeNode {
		const items = this.#tabs.map((tab, index) => ({
			id: `t${index}`,
			label:
				this.#leftTabs.has(index) &&
				tab.fields.length > 0 &&
				tab.fields.every(field => fieldError(field, this.#value(field)) === undefined)
					? [span("✓ ", "success"), span(tab.label)]
					: [span(tab.label)],
		}));
		items.push({ id: REVIEW_ID, label: [span(REVIEW_TAB)] });
		const active = this.#tab === this.#tabs.length ? REVIEW_ID : `t${this.#tab}`;
		const tabs = node(
			"tabs",
			{
				items,
				active,
				role: "omp.ask.questions",
				title: "Previous/next question  ←/→",
				actions: { click: "select" },
			},
			undefined,
			"tabs",
		);
		return keyed(row([tabs], { role: "omp.ask.head", align: "center" }), "head");
	}

	#describeSections(sections: readonly number[]): NativeChild[] {
		return sections.map(index => {
			const section = this.#form.sections[index]!;
			const blocks = section.blocks.map(block => this.#describeBlock(block));
			return section.title.length > 0
				? node("section", { head: nativeSpans(section.title), role: "omp.ask.section" }, blocks, `s${index}`)
				: keyed(col(blocks, { gap: "md", role: "omp.ask.section" }), `s${index}`);
		});
	}

	/**
	 * Review tab: whether anything still needs fixing, then every answer under its question. The
	 * answers sit straight in the card as `omp.ask.answers`, the list Tern's stylesheet lets shrink
	 * and scroll inside the card.
	 */
	#describeReview(): NativeChild[] {
		const problems = this.#form.fields.filter(field => fieldError(field, this.#value(field)) !== undefined).length;
		const notice =
			problems > 0
				? [
						span(`${problems} ${problems === 1 ? "answer needs" : "answers need"} a fix`, "warning"),
						span(" · Submit opens the first"),
					]
				: [span("All set · Submit sends these answers")];
		const named = this.#form.fields.filter(field => field.name);
		const items = formAnswers(this.#form, this.data()).map((answer, index) => {
			const field = named[index]!;
			const shown =
				field.kind === "text" && field.type === "password"
					? "•".repeat(answer.answer.length)
					: sanitize(answer.answer).replace(/\s+/g, " ");
			return { k: sanitize(answer.question), v: shown ? [span(shown)] : [span("—", "dim")] };
		});
		return [
			text(notice, { wrap: "word", role: "omp.ask.notice" }),
			node("kv", { items, role: "omp.ask.answers" }, undefined, REVIEW_ID),
		];
	}

	/**
	 * Hide, the countdown or draft hint, then Cancel, Next on a question tab, and Submit where
	 * `submit` says: an untabbed form, the last question tab, and Review. Submit validates the
	 * whole form and opens the first answer that needs a fix.
	 */
	#describeActions(blocked: boolean, next: boolean, submit: boolean): NativeNode {
		const hideKey = getKeybindings().getKeys("app.ask.hide")[0];
		const guard = this.#options.inputGuard;
		const lead =
			blocked && guard
				? this.#guardHint(guard)
				: this.#remaining !== undefined
					? `Submits these answers in ${this.#remaining}s`
					: undefined;
		return actionBar([
			actionButton("Hide", "hide", hideKey ? { keys: hideKey } : {}),
			lead ? text([span(lead, "muted")], { truncate: "end", role: "omp.ask.summary" }) : null,
			...(lead ? [null] : []),
			actionButton("Cancel", "cancel", { keys: "escape" }),
			...(next ? [actionButton("Next", "next", submit ? {} : { tone: "accent" })] : []),
			...(submit
				? [actionButton(SUBMIT_LABEL, "submit", { ...(next ? {} : { keys: "enter" }), tone: "accent" })]
				: []),
		]);
	}

	/** Hidden: one row in the composer's place, the countdown, the question clipped to a line, Cancel and Show. */
	#describeHidden(): NativeNode {
		const hideKey = getKeybindings().getKeys("app.ask.hide")[0];
		const items: NativeNode[] = [];
		if (this.#remaining !== undefined) items.push(text([span(`${this.#remaining}s`, "muted")]));
		items.push(
			// The summary grows (`omp.ask.summary`), end-aligning Cancel and Show.
			text([span("Question  ", "muted"), span(this.#hiddenSummary())], { truncate: "end", role: "omp.ask.summary" }),
			actionButton("Cancel", "cancel", { keys: "escape" }),
			actionButton("Show", "show", { tone: "accent", ...(hideKey ? { keys: hideKey } : {}) }),
		);
		return col([actionBar(items)], { role: "omp.editor.ask.hidden", gap: "md" });
	}

	#describeBlock(block: FormBlock): NativeChild {
		switch (block.kind) {
			case "text":
				return text(nativeSpans(block.spans), {
					wrap: "word",
					role: block.heading ? "omp.ask.heading" : "omp.ask.text",
				});
			case "list":
				return col(
					block.items.map((entry, index) =>
						text([span(block.ordered ? `${index + 1}.` : "•", "muted"), span(" "), ...nativeSpans(entry)], {
							wrap: "word",
							role: "omp.ask.text",
						}),
					),
					{ gap: "xs", role: "omp.ask.bullets" },
				);
			case "pre":
				return code(sanitize(block.text), { role: "omp.ask.pre" });
			case "image":
			case "svg": {
				const slot = this.#media.get(block)!;
				if (slot.state === "ready") return slot.native;
				return text([span(this.#mediaNote(block, slot), "muted")], { role: "omp.ask.text", truncate: "end" });
			}
			case "table": {
				const count = Math.max(0, ...block.rows.map(row => row.length));
				const header = block.headerRows > 0 ? block.rows[0] : undefined;
				const cols = Array.from({ length: count }, (_, column) => ({
					id: `c${column}`,
					head: header ? nativeSpans(header[column] ?? []) : undefined,
				}));
				const rows = block.rows.slice(block.headerRows > 0 ? 1 : 0).map((row, index) => ({
					id: `r${index}`,
					cells: Object.fromEntries(cols.map((column, cell) => [column.id, nativeSpans(row[cell] ?? [])])),
				}));
				return node("table", { cols, rows, role: "omp.ask.table" });
			}
			case "field":
				return this.#describeField(block.field);
		}
	}

	/**
	 * The focused text field is its live `Input`/`Editor` — the only editor node
	 * the form describes, so the terminal's keyboard focus (the first editor of
	 * the focused component) follows the form's. Every other text field is a
	 * well showing its value or placeholder; clicking it focuses the field.
	 */
	#describeTextControl(field: TextField, index: number): NativeChild {
		const stop = this.#stops[this.#focus];
		if (stop?.kind === "text" && stop.field === field) {
			return field.multiline ? this.#editors.get(field)! : this.#inputs.get(field)!;
		}
		const value = this.#textValue(field);
		const shown = field.type === "password" ? "•".repeat(value.length) : sanitize(value);
		const content = shown ? [span(shown)] : [span(sanitize(field.placeholder) || " ", "dim")];
		return text(content, {
			wrap: field.multiline ? "word" : "none",
			truncate: field.multiline ? undefined : "end",
			lines: field.multiline ? this.#textareaRows(field) : 1,
			role: field.multiline ? "omp.ask.well.multi" : "omp.ask.well",
			actions: { click: `${EDIT_ACT}${index}` },
		});
	}

	#describeField(field: FormField): NativeNode {
		const index = this.#fieldIndex.get(field)!;
		const error = this.#errors.get(field);
		const children: NativeChild[] = [];
		if (field.label.length > 0) {
			const required = field.required ? [span(" *", "error")] : [];
			children.push(text([...nativeSpans(field.label), ...required], { wrap: "word", role: "omp.ask.label" }));
		}
		if (field.kind === "text") {
			children.push(this.#describeTextControl(field, index));
		} else {
			const stop = this.#stops[this.#focus];
			const focusedOption =
				stop?.kind === "option" && stop.field === field
					? `o${stop.option}`
					: stop?.kind === "select" && stop.field === field && this.#current(field) !== undefined
						? `o${this.#current(field)}`
						: stop?.kind === "other" && stop.field === field
							? OTHER_ITEM
							: null;
			const checked = this.#checked.get(field)!;
			const role = field.multi ? "omp.ask.check" : "omp.ask.option";
			const items = field.options.map((option, optionIndex) => {
				const isChecked = checked.has(optionIndex);
				return item(`o${optionIndex}`, {
					label: nativeSpans(option.label),
					role,
					tone: isChecked ? "accent" : undefined,
					icon: field.multi && isChecked ? "check" : undefined,
					disabled: option.disabled || undefined,
				});
			});
			if (field.other) {
				const typed = sanitize(this.#others.get(field)!.getValue().trim());
				const chosen = this.#otherChosen(field);
				items.push(
					item(OTHER_ITEM, {
						label: typed ? [span(`${OTHER_LABEL}: `, "muted"), span(typed)] : [span(`${OTHER_LABEL}…`)],
						role,
						tone: chosen ? "accent" : undefined,
						icon: field.multi && chosen ? "check" : undefined,
					}),
				);
			}
			children.push(list(items, { selected: focusedOption, role: "omp.ask.options" }, `f${index}`));
			// Typing the Other answer: its input is the form's one live editor, so the terminal focuses it.
			if (focusedOption === OTHER_ITEM) children.push(this.#others.get(field)!);
		}
		if (error) children.push(text([span(error, "error")], { role: "omp.ask.error" }));
		return col(children, { gap: "xs", role: "omp.ask.field" });
	}
}
