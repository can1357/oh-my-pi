/**
 * Terminal surface for an agent-written HTML form (parsed by `parse.ts`).
 *
 * Both surfaces stack the form in one column: the context before the first
 * question on top, then every question (a top-level `<fieldset>`, or a field of
 * loose content between fieldsets, with the context before it). The question
 * holding focus is open, its context and the focused field's controls shown;
 * every other field folds to its question over its answer or option pills.
 * Focus on Submit folds them all. A native (Tern) terminal gets the column as
 * an inline card in its transcript (`native/ask-card.ts`), whose clicks come
 * back through {@link HtmlFormDialog.handleNativeEvent}, a pill picking its
 * option without opening the question. Rows draw it in a fixed-height panel
 * ({@link DIALOG_HEIGHT_RATIO} of the terminal at most) that scrolls to keep the
 * focused row in view, with the open question's head when it fits, and past a
 * picture it would cut at an edge when it can; one it must cut, which a terminal
 * can't draw in part, is a dim frame naming it.
 *
 * Keys: ↑/↓ move between choices and fields, crossing from a question's last
 * row into the next, Tab/Shift+Tab jump fields, Space toggles (or opens a
 * dropdown), ←/→ change a dropdown, Enter picks a radio (or the focused box of
 * an empty checkbox group, or leaves a field) and moves on, Enter on Submit
 * validates and submits or opens the first question to fix, PgUp/PgDn (←/→ on
 * choices) open the previous or next question. Esc (outside an open dropdown or
 * note) and Tab on Submit hand the keys to the composer under the form
 * (`releaseKeys`), where Esc interrupts the turn and so cancels the ask. In rows,
 * ↑ on a question's first row first scrolls up to its head when that is cut off,
 * `app.ask.hide` collapses the form to one row, and the host draws
 * {@link HtmlFormDialog.keyHints} under the panel. Notes use `n` on
 * option rows and Alt+n on dropdowns, without selecting the option.
 * With a `timeout`, inactivity submits the current values through `onTimeout`.
 *
 * @example
 * const dialog = new HtmlFormDialog(parseHtmlForm(html), {
 * 	tui,
 * 	onSubmit: data => resolve(data), // { db: "sqlite", notes: "" }
 * 	onCancel: () => resolve(undefined),
 * });
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { formatKeyHint } from "../app-keybindings";
import { BracketedPasteHandler } from "../bracketed-paste";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { ASK_RESERVED_ROWS, type FoldedRows, renderFoldedQuestion } from "../chrome/ask-fold";
import { OverlayPanel, PanelRows } from "../chrome/overlay-box";
import { SvgFigure } from "../chat/svg-figure";
import { convertImageToPngShared } from "../png-conversion";
import { Editor } from "../components/editor";
import { Image, type ImageBudget, measureRender } from "../components/image";
import { Input } from "../components/input";
import { ScrollView } from "../components/scroll-view";
import { renderTableRowLines, type TableColumn } from "../components/table";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { getKeybindings } from "../keybindings";
import { extractPrintableText, type KeyId, matchesKey } from "../keys";
import { isSvgMedia, loadMedia, type Media, svgMedia } from "../media";
import { askCard, type AskPill, type FoldSummary, foldQuestion, openQuestion } from "../native/ask-card";
import { code, col, item, list, node, span, text, withMotion } from "../native/describe";
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
import { compactImageAttachments, formatVisionMarker, PLACEHOLDER_REGEX } from "../prompt/composer-attachments";
import { classifyImagePaste } from "../prompt/custom-editor";
import { OrderedPastes } from "../prompt/ordered-pastes";
import { wrapPrefixedLine } from "../render/hanging-wrap";
import { ImageProtocol, TERMINAL } from "../terminal-capabilities";
import { getEditorTheme, type ThemeColor, theme } from "../theme/theme";
import { optionMarker } from "../tools/ask";
import type { Component, Focusable } from "../tui";
import { Ellipsis, padding, replaceTabs, truncateToWidth, visibleWidth } from "../utils";
import {
	choiceValue,
	defaultFormData,
	fieldError,
	fieldQuestions,
	type HtmlFormData,
	type HtmlFormValue,
	type OptionNote,
	OTHER_LABEL,
	textValue,
} from "./data";
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

/** What the dialog needs from its `TUI`: the terminal's height, a way to ask for a frame, and its image budget. */
export interface HtmlFormHost {
	readonly terminal: { readonly rows: number };
	/** Gives pictures stable Kitty ids, so their placements leave with the form instead of outliving it. */
	readonly imageBudget?: ImageBudget;
	requestRender(): void;
}

/** Host wiring for {@link HtmlFormDialog}. */
export interface HtmlFormDialogOptions {
	/** Panel title; `Ask` when omitted. */
	title?: string;
	/** Sizes the panel and repaints when the countdown ticks or a picture lands. */
	tui?: HtmlFormHost;
	/** Inactivity in ms after which `onTimeout` receives the current values and notes; any input restarts it. */
	timeout?: number;
	onTimeout?(data: HtmlFormData, notes: OptionNote[]): void;
	/** Directory relative `<img src>` paths resolve against; the process's when omitted. */
	cwd?: string;
	/** Lets the open option note take pasted images; see {@link HtmlFormDialog.attachImage}. */
	acceptImages?: boolean;
	/**
	 * Called for an empty bracketed paste into an open note. Like HookEditor's, the host reserves with
	 * {@link HtmlFormDialog.beginPaste} synchronously, before its first await, and its
	 * {@link HtmlFormDialog.attachImage} returns the marker that reserved paste delivers.
	 */
	onPasteImage?(): Promise<boolean> | void;
	/** Called once per file path when a bracketed paste into an open note is only image paths. */
	onPasteImagePath?(path: string): void | Promise<void>;
	/**
	 * What the form warns while it returns text: sending the composer's draft would skip the form. Natively
	 * the card's warning line; in rows the panel's last line. The host requests a render when it changes.
	 */
	skipNotice?(): string | undefined;
	/** Natively, a pointer action on the card: the host gives it the keyboard, which the composer may hold. */
	claimKeys?(): void;
	/** Esc, or Tab past Submit: the host hands the keyboard to the composer under the form. */
	releaseKeys?(): void;
	/** Called on every editor the form creates (textareas, notes, Vim-mode one-line boxes), e.g. to wire Vim mode and the clipboard. */
	configureEditor?(editor: Editor): void;
	/** Vim mode: one-line boxes (text inputs, Other answers) become Vim-mode editors, and `j`/`k` step between rows. */
	vimMode?: boolean;
	onSubmit(data: HtmlFormData, notes: OptionNote[]): void;
	onCancel(): void;
}

/** Fraction of the terminal the panel may occupy, as the ask dialog. */
const DIALOG_HEIGHT_RATIO = 0.7;
/** Body rows the panel keeps even when the terminal is too short for them past its reserved rows. */
const MIN_BODY_ROWS = 6;
/** Top and bottom border. */
const CHROME_ROWS = 2;
/** Column where field inputs and errors start, under the cursor and marker. */
const FIELD_INDENT = 4;
const MAX_TEXTAREA_ROWS = 10;
const DEFAULT_TITLE = "Ask";
const SUBMIT_LABEL = "Submit";
/** A text block this short right before a field is its caption and sits right above it, without a blank row. */
const CAPTION_MAX_ROWS = 4;
/** Tallest a picture draws, in rows, and its share of the terminal below that. */
const MAX_PICTURE_ROWS = 16;
const PICTURE_SHARE = 0.35;
/** Options a PgUp/PgDn moves an open dropdown's highlight by. */
const DROPDOWN_PAGE = 5;
/** Native action a folded field's click sends, suffixed with the field index: opens it. */
const OPEN_ACT = "open:";
/** Native action an option pill's click sends, suffixed with `<field>:<option>`: picks or flips it. */
const PICK_ACT = "pick:";
/** List item key of a group's Other answer (option items are `o<index>`). */
const OTHER_ITEM = "other";
const OTHER_PLACEHOLDER = "type your own";
/** Rows a Vim-mode one-line answer (Other, `<input>`) grows to (`o` or a linewise put splits it) before it scrolls. */
const LINE_MAX_ROWS = 3;
/** A folded text field's well when the form gives no placeholder. */
const WELL_PLACEHOLDER = "type your answer";

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

/** A picture's rows in the column: measured, and rendered again only while the body shows it whole. */
interface PlacedPicture {
	start: number;
	end: number;
	component: Component;
	alt: string;
}

/** The rows' stacked column at one width, and where focus, the open question and the overlays sit in it. */
interface Layout {
	width: number;
	lines: string[];
	/** Rows `[start, end)` of the focused stop. */
	focus: { start: number; end: number };
	/** First row of the open question: 0 for the first (the intro above it too), Submit's row on Submit. */
	head: number;
	/** Where the open dropdown hangs from: its field's first row and its value row. */
	dropdown?: { top: number; row: number };
	/** Last row of the option whose note is open. */
	noteRow?: number;
	/**
	 * Pictures, measured under {@link measureRender} so one scrolled out of view claims no image slot;
	 * the body renders the ones it shows whole again, in display order.
	 */
	pictures: PlacedPicture[];
}

/** Rows of one block of the column, and the picture it draws, if any. */
interface BlockRows {
	lines: string[];
	picture?: { component: Component; alt: string };
}

/** One run of a field's rows: an option, a control, its label or error; `stop` when focus rests on it. */
interface FieldRun {
	lines: string[];
	stop: boolean;
}

/** Blocks `start` up to `end` (exclusive) of one form section. */
interface FormPart {
	section: number;
	start: number;
	end: number;
}

/** A native question group: the section parts it shows while open, and the fields in them. */
interface QuestionGroup {
	parts: FormPart[];
	fields: FormField[];
}

/** A note saved on an option: its text, and the images its `[Image #N]` markers index. */
interface SavedNote {
	text: string;
	images: ImageContent[];
}

/** The note being edited; dropped when it closes, so nothing of it outlives the note. */
interface OpenNote {
	field: ChoiceField;
	option: number;
	editor: Editor;
	/** Saved images of the option plus those pasted since the note opened. */
	images: ImageContent[];
	pastes: OrderedPastes;
	pasteHandler: BracketedPasteHandler;
}

/** Strip control bytes a model could smuggle into labels (escape sequences, `\r`); keep `\n`. */
function sanitize(text: string): string {
	return replaceTabs(text).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

/** Kitty's `f=100` transmit takes PNG only, so a WebP/JPEG/GIF picture's rows draw from a PNG copy or draw blank. */
async function kittyReady(media: Media): Promise<Media> {
	if (TERMINAL.imageProtocol !== ImageProtocol.Kitty || media.mime === "image/png" || isSvgMedia(media)) return media;
	const { data } = await convertImageToPngShared({
		type: "image",
		data: media.bytes.toBase64(),
		mimeType: media.mime,
	});
	return { bytes: Uint8Array.fromBase64(data), mime: "image/png" };
}

/** What a picture stands for in text: its alt, else its source or `drawing`. */
function mediaName(block: MediaBlock): string {
	return sanitize(block.alt || (block.kind === "image" ? block.src.slice(0, 80) : "drawing"));
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

/** Whether the keyboard can reach `field`: a text field, or a choice with an enabled option or an Other answer. */
function reachable(field: FormField): boolean {
	return field.kind === "text" || field.other || field.options.some(option => !option.disabled);
}

/**
 * Native question groups: one per `<fieldset>` holding fields, and one per
 * field of loose content between fieldsets, each with the context before it.
 * Sections of context alone before the first group are the `intro`, shown above
 * every group; later ones join the next group, or the last one when nothing
 * follows.
 */
function buildGroups(form: HtmlForm): { intro: FormPart[]; groups: QuestionGroup[] } {
	const intro: FormPart[] = [];
	const groups: QuestionGroup[] = [];
	let lead: FormPart[] = [];
	form.sections.forEach((section, index) => {
		const end = section.blocks.length;
		if (!section.blocks.some(block => block.kind === "field")) {
			(groups.length === 0 ? intro : lead).push({ section: index, start: 0, end });
			return;
		}
		// Where each question of this section ends: after each loose field, the last one at the section's
		// end. A group's question also keeps the text between its options, unless its options straddle the
		// next field: then that field keeps the context before it. A field the keyboard cannot reach (only
		// disabled options) is no question of its own: it joins the next one.
		const fieldBlocks = section.blocks.flatMap((block, at) =>
			block.kind === "field" ? [{ at, through: Math.max(at + 1, block.optionsEnd ?? 0), field: block.field }] : [],
		);
		const cuts = section.fieldset
			? []
			: fieldBlocks.flatMap(({ at, through, field }, nth) => {
					if (!reachable(field)) return [];
					return [through <= (fieldBlocks[nth + 1]?.at ?? end) ? through : at + 1];
				});
		if (cuts.length === 0) cuts.push(end);
		else cuts[cuts.length - 1] = end;
		let start = 0;
		for (const cut of cuts) {
			const fields = section.blocks
				.slice(start, cut)
				.flatMap(block => (block.kind === "field" ? [block.field] : []));
			groups.push({ parts: [...lead, { section: index, start, end: cut }], fields });
			lead = [];
			start = cut;
		}
	});
	groups.at(-1)?.parts.push(...lead);
	return { intro, groups };
}

/**
 * `offset` moved so fewer pictures straddle an edge of a body `rows` tall (a picture draws only whole;
 * a cut one draws as a frame): among the offsets that put a picture's top or bottom on an edge, the one
 * cutting the fewest, nearest `offset`, that keeps rows `keep` (the focused stop) in view and stays at
 * or above `limit` (where ↑ peeks up from). `offset` itself when none cuts fewer.
 */
function clearPictureEdges(
	offset: number,
	rows: number,
	max: number,
	pictures: readonly PlacedPicture[],
	keep: { start: number; end: number } | undefined,
	limit: number,
): number {
	const cuts = (at: number): number =>
		pictures.filter(
			picture => (picture.start < at && at < picture.end) || (picture.start < at + rows && at + rows < picture.end),
		).length;
	const own = cuts(offset);
	let best = offset;
	let fewest = own;
	for (const picture of pictures) {
		for (const at of [picture.start, picture.end, picture.end - rows, picture.start - rows]) {
			if (own === 0 || at < 0 || at > Math.min(max, limit)) continue;
			if (keep && (keep.start < at || (keep.end > at + rows && keep.start !== at))) continue;
			const count = cuts(at);
			const nearer = Math.abs(at - offset) < Math.abs(best - offset);
			if (count < fewest || (count === fewest && fewest < own && nearer)) {
				best = at;
				fewest = count;
			}
		}
	}
	return best;
}

/**
 * The rows a picture the body cuts off draws instead of nothing: a dim frame naming it over its
 * `visible` rows, open on each side the body cuts (`cut`), so its place reads as a picture to scroll to.
 */
function cutPictureRows(alt: string, visible: number, width: number, cut: { top: boolean; bottom: boolean }): string[] {
	const name = `▣ ${alt}`;
	if (visible <= 1) return [theme.fg("dim", truncateToWidth(name, width, Ellipsis.Unicode))];
	// A column short of the body so the frame doesn't run into the scrollbar.
	const inner = Math.max(0, width - 3);
	const fill = (text: string, pad: string) => text + pad.repeat(Math.max(0, inner - visibleWidth(text)));
	const label = truncateToWidth(cut.top ? ` ${name}` : `─ ${name} `, inner, Ellipsis.Unicode);
	const rows = [cut.top ? `│${fill(label, " ")}│` : `╭${fill(label, "─")}╮`];
	for (let row = 1; row < visible - 1; row++) rows.push(`│${" ".repeat(inner)}│`);
	rows.push(cut.bottom ? `│${" ".repeat(inner)}│` : `╰${"─".repeat(inner)}╯`);
	return rows.map(row => theme.fg("dim", row));
}

/** Interactive dialog over an {@link HtmlForm}; see the module docs for layout and keys. */
export class HtmlFormDialog implements Component, Focusable {
	readonly #form: HtmlForm;
	readonly #options: HtmlFormDialogOptions;
	readonly #stops: Stop[] = [];
	/** The keys reach one field only: Enter on it submits, there being no next field to move to. */
	readonly #sole: boolean;
	readonly #fieldIndex = new Map<FormField, number>();
	readonly #checked = new Map<ChoiceField, Set<number>>();
	readonly #inputs = new Map<TextField, Input>();
	readonly #notes = new Map<ChoiceField, Map<number, SavedNote>>();
	#noteEditor: OpenNote | undefined;
	#savedNoteEditor: Editor | undefined;
	#useTerminalCursor = false;
	/** The Other answer of each group that offers one: a Vim-mode editor when the host turns Vim mode on, else a one-line input. */
	readonly #others = new Map<ChoiceField, Input | Editor>();
	/** Each radio group's Other text as last seen, to notice typing from keys or the terminal. */
	readonly #otherSeen = new Map<ChoiceField, string>();
	readonly #editors = new Map<TextField, Editor>();
	readonly #errors = new Map<FormField, string>();
	readonly #panel: OverlayPanel;
	readonly #body = new PanelRows();
	/** The skip notice's warning row, under the body while there is one. */
	readonly #notice = new PanelRows();
	#focused = false;
	#focus = 0;
	/** First column row the rows' body shows. */
	#scrollOffset = 0;
	/**
	 * Set while ↑ scrolls up to the open question's cut-off head (see {@link #moveStop}): the body
	 * keeps its offset instead of following focus until another key brings focus back.
	 */
	#peek = false;
	/** The last rows render's body: the focus it showed, its offset, height and the open question's head row. */
	#view: { focus: number; offset: number; rows: number; head: number } | undefined;
	#height: { key: string; rows: number } | undefined;
	/** The dropdown showing its options, and the option its highlight sits on. */
	#open: { field: ChoiceField; highlight: number } | undefined;
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
	/** Each field's question ({@link fieldQuestions}): folded fields and the hidden row's summary. */
	readonly #questions: Map<FormField, string>;
	/** Native context above every question group. */
	readonly #intro: FormPart[];
	/** Native question groups, the one holding focus open. */
	readonly #groups: QuestionGroup[];
	readonly #fieldGroup = new Map<FormField, number>();
	/** Bumped when focus lands on another group, so the terminal scrolls the open one into view. */
	#reveal = 0;
	/** Collapsed to one row (`app.ask.hide`) while the rows' form stays pending; natively never. */
	#hidden = false;

	constructor(form: HtmlForm, options: HtmlFormDialogOptions) {
		this.#form = form;
		this.#options = options;
		form.fields.forEach((field, index) => this.#fieldIndex.set(field, index));
		this.#questions = fieldQuestions(form);
		const { intro, groups } = buildGroups(form);
		this.#intro = intro;
		this.#groups = groups;
		this.#groups.forEach((group, index) => {
			for (const field of group.fields) this.#fieldGroup.set(field, index);
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
					this.#others.set(field, this.#otherBox());
					this.#stops.push({ kind: "other", field });
				}
			}
		}
		this.#stops.push({ kind: "submit" });
		this.#sole = new Set(this.#stops.flatMap(stop => (stop.kind === "submit" ? [] : [stop.field]))).size === 1;
		// Open where the answer is, so Enter accepts a preselected choice instead of overwriting it.
		this.#focus = this.#answerStop(this.#fieldOfStop(0));
		this.#panel = new OverlayPanel(options.title ?? DEFAULT_TITLE);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(this.#notice);
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
		this.#useTerminalCursor = useTerminalCursor;
		this.#savedNoteEditor?.setUseTerminalCursor(useTerminalCursor);
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

	/**
	 * What the user answered so far, for a form closed before its submit: the named fields whose value
	 * differs from the form's defaults, and the notes on selected options. Undefined when there are neither.
	 */
	givenAnswers(): { data: HtmlFormData; notes: OptionNote[] } | undefined {
		const defaults = defaultFormData(this.#form);
		const current = this.data();
		const data: HtmlFormData = {};
		let changed = false;
		for (const name in current) {
			const value = current[name]!;
			if (JSON.stringify(value) === JSON.stringify(defaults[name])) continue;
			data[name] = value;
			changed = true;
		}
		const notes = this.optionNotes();
		return changed || notes.length > 0 ? { data, notes } : undefined;
	}

	/** Saved notes on selected options; unselected drafts stay private to the dialog. */
	optionNotes(): OptionNote[] {
		const selected: OptionNote[] = [];
		for (const [field, notes] of this.#notes) {
			if (!field.name) continue;
			this.#otherChosen(field);
			const checked = this.#checked.get(field)!;
			field.options.forEach((option, index) => {
				const saved = notes.get(index);
				const text = saved?.text.trim();
				if (!text || option.disabled || !checked.has(index)) return;
				const images = saved?.images;
				selected.push({
					name: field.name,
					question: this.#questions.get(field) ?? field.name,
					option: optionText(option) || option.value,
					value: option.value,
					text,
					...(images?.length ? { images: [...images] } : {}),
				});
			});
		}
		return selected;
	}

	debugState(): Record<string, unknown> {
		const stop = this.#stops[this.#focus];
		return {
			scroll: this.#scrollOffset,
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
			notes: Object.fromEntries(
				[...this.#notes].map(([field, notes]) => [
					field.name,
					Object.fromEntries([...notes].map(([option, note]) => [option, note.text])),
				]),
			),
			noteEdit: this.#noteEditor
				? `${this.#noteEditor.field.name}=${this.#noteEditor.field.options[this.#noteEditor.option]!.value}`
				: undefined,
		};
	}

	/** The editor holding the keys: an open note, else the focused textarea or Vim-mode one-line box; none on other rows. */
	activeEditor(): Editor | undefined {
		if (this.#hidden) return undefined;
		if (this.#noteEditor) return this.#noteEditor.editor;
		const stop = this.#stops[this.#focus];
		if (stop?.kind === "text") return this.#editors.get(stop.field);
		if (stop?.kind !== "other") return undefined;
		const box = this.#others.get(stop.field);
		return box instanceof Editor ? box : undefined;
	}

	handleInput(data: string): void {
		this.#resetCountdown();
		this.#changed();
		if (getKeybindings().matches(data, "app.ask.hide")) {
			// Natively the form sits in the transcript, hiding nothing: there is nothing to hide it from.
			if (!isNativeRendering()) this.#setHidden(!this.#hidden);
			return;
		}
		if (this.#noteEditor && !this.#hidden) {
			this.#noteEditorInput(data);
			return;
		}
		if (this.#open) {
			this.#dropdownInput(this.#open, data);
			return;
		}
		const stop = this.#stops[this.#focus]!;
		// A text box in Vim mode takes Esc first: it leaves Insert mode or cancels a half-typed command.
		const editor = this.activeEditor();
		if (editor?.vimConsumesEscape() && matchesKey(data, "escape")) {
			editor.handleInput(data);
			return;
		}
		// Esc hands the keys to the composer, where Esc interrupts the turn and so cancels the ask.
		if (matchesSelectCancel(data)) {
			this.#options.releaseKeys?.();
			return;
		}
		if (this.#hidden) {
			if (getKeybindings().matches(data, "tui.select.confirm")) this.#setHidden(false);
			return;
		}
		const confirm = getKeybindings().matches(data, "tui.select.confirm");
		const step = this.#vimStep(stop, data);
		if (this.#peek && !matchesSelectUp(data) && step !== -1) {
			// Focus sits below the rows shown: the keys that would act on it bring it back instead of acting unseen.
			this.#peek = false;
			if (matchesSelectDown(data) || step === 1 || matchesKey(data, "space") || confirm) return;
		}
		if (matchesSelectPageDown(data) || matchesSelectPageUp(data)) {
			this.#jumpQuestion(matchesSelectPageDown(data) ? 1 : -1);
			return;
		}
		if (step !== 0) {
			this.#moveStop(step);
			return;
		}
		if (matchesKey(data, "tab") && stop.kind === "submit") {
			this.#options.releaseKeys?.();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#moveField(matchesKey(data, "shift+tab") ? -1 : 1);
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
			this.#jumpQuestion(matchesKey(data, "right") ? 1 : -1);
			return;
		}
		if (stop.kind === "submit") {
			if (confirm) this.#submit();
			return;
		}
		if (this.#matchesNoteKey(data, false)) {
			this.#startNote();
			return;
		}
		if (matchesKey(data, "space")) {
			this.#toggle(stop.field, stop.option);
			return;
		}
		if (confirm) {
			// Enter picks a radio; on a checkbox group with nothing checked yet it checks the focused box, so
			// Enter alone never leaves the group empty.
			if (!stop.field.multi || this.#checked.get(stop.field)?.size === 0) this.#toggle(stop.field, stop.option);
			this.#advance();
		}
	}

	/**
	 * `j`/`k` in Vim mode: one row down or up, as ↓/↑, on a row that takes no typing (an option, a closed
	 * dropdown, Submit), and from a text box in Normal mode on its last or first line. 0 otherwise, so
	 * text boxes keep their letters and an open dropdown its type-ahead.
	 */
	#vimStep(stop: Stop, data: string): -1 | 0 | 1 {
		if (!this.#options.vimMode) return 0;
		const step = matchesKey(data, "j") ? 1 : matchesKey(data, "k") ? -1 : 0;
		if (step === 0 || (stop.kind !== "text" && stop.kind !== "other")) return step;
		const editor = this.activeEditor();
		if (editor?.vimMode !== "normal" || editor.vimPending !== "") return 0;
		const line = editor.getCursor().line;
		return line === (step === 1 ? editor.getLines().length - 1 : 0) ? step : 0;
	}

	/** Clicks on folded fields, their pills, option rows and the action bar of the native description. */
	handleNativeEvent(event: NativeUiEvent): void {
		this.#options.claimKeys?.();
		this.#resetCountdown();
		this.#changed();
		if (this.#noteEditor) {
			if (event.type === "action" && event.act === "save-note") this.#requestSave();
			else if (event.type === "action" && event.act === "cancel") this.#closeNote();
			return;
		}
		if (event.type === "action") {
			if (event.act === "cancel") {
				this.#cancel();
				return;
			}
			if (event.act === "submit") this.#submit();
			else if (event.act === "note") this.#noteFromPointer(event.key);
			else if (event.act.startsWith(OPEN_ACT)) this.#openField(Number(event.act.slice(OPEN_ACT.length)));
			else if (event.act.startsWith(PICK_ACT)) {
				const [fieldIndex, option] = event.act.slice(PICK_ACT.length).split(":").map(Number);
				this.#pick(this.#form.fields[fieldIndex!], option!);
			}
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		const leaf = leafKey(event.key);
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
		if (this.#hidden) return this.#renderHidden(width);
		const innerWidth = Math.max(1, width - 4);
		const skip = this.#options.skipNotice?.();
		// The notice takes a body row, so the panel keeps its height while it comes and goes.
		const rows = Math.max(1, this.#bodyRows(innerWidth) - (skip ? 1 : 0));
		const highlight = this.#focused ? this.#focus : -1;
		let layout = this.#layout(innerWidth, this.#focus, highlight);
		// An overflowing column gives the scrollbar a column.
		if (layout.lines.length > rows && innerWidth > 1) layout = this.#layout(innerWidth - 1, this.#focus, highlight);
		this.#panel.title = this.#titleText();
		this.#body.setLines(this.#renderBody(layout, rows, innerWidth));
		this.#body.setHeight(rows);
		this.#notice.setLines(skip ? [theme.fg("warning", `⚠ ${sanitize(skip).replace(/\s+/g, " ")}`)] : []);
		return this.#panel.render(width);
	}

	/**
	 * The rows form's key hints on one themed line, for the host to draw under the panel: the focused
	 * stop's keys, moving, hiding, Esc to the composer and jumping questions; the open note's or
	 * dropdown's keys while one is open.
	 */
	keyHints(): string {
		return theme.fg("dim", this.#keyHintText());
	}

	/**
	 * The form natively: the inline ask card (see the module docs), its action bar
	 * at its foot. Option lists `select` to focus/pick (a checkbox `select`
	 * toggles); the focused text field is its live `Input`/`Editor`.
	 */
	describe(_cx: DescribeContext): NativeNode {
		// Other answers are typed into the terminal's own inputs, which don't pass through handleInput.
		const others = [...this.#others.keys()].map(field => this.#otherText(field)).join("\0");
		const skip = this.#options.skipNotice?.();
		const key = `${this.#version}\0${others}\0${skip ?? ""}`;
		if (this.#native?.key === key) return this.#native.node;
		const described = this.#describeForm(skip);
		this.#native = { key, node: described };
		return described;
	}

	invalidate(): void {
		this.#height = undefined;
		this.#native = undefined;
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#noteEditor?.pastes.clear();
		this.#noteEditor = undefined;
		this.#stopCountdown();
		if (this.#savedNoteEditor) this.#savedNoteEditor.focused = false;
		this.#mediaAbort.abort();
		for (const slot of this.#media.values()) {
			if (slot.state !== "ready") continue;
			// By the component's own id: one retired and sent again no longer maps from a key.
			slot.rows.release();
			if (slot.rows instanceof SvgFigure) slot.rows.dispose();
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
		loadMedia(block.src, { cwd: this.#options.cwd ?? process.cwd(), signal })
			.then(async media => ({ media, raster: await kittyReady(media) }))
			.then(
				// A picture landing after dispose must not take an image key nobody will release.
				({ media, raster }) =>
					signal.aborted || this.#settleMedia(block, this.#readyMedia(media, block.alt || "image", raster)),
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

	/**
	 * Rows draw a raster through {@link Image} and an SVG through {@link SvgFigure}; natively both are image blobs.
	 * Both go through the TUI's image budget: without an id, a Kitty image is a self-contained
	 * `a=T` placement that repainting the rows never removes, so it outlives the form.
	 * `raster` is what the rows draw; the native blob keeps the original bytes (a GIF stays animated).
	 */
	#readyMedia(media: Media, alt: string, raster: Media = media): MediaSlot {
		const maxRows = this.#pictureRows();
		const budget = this.#options.tui?.imageBudget;
		const native = nativeImageNode(media.bytes, media.mime, { alt, max: { h: `${maxRows}lines` } });
		if (isSvgMedia(media)) {
			const figure = new SvgFigure({
				budget,
				releaseSuperseded: true,
				maxRows: () => maxRows,
				onChange: () => this.#mediaChanged(),
			});
			figure.update(new TextDecoder().decode(media.bytes), true);
			return { state: "ready", rows: figure, native };
		}
		const image = new Image(
			raster.bytes.toBase64(),
			raster.mime,
			{ fallbackColor: text => theme.fg("dim", text) },
			{ maxHeightCells: maxRows, filename: alt, budget, requestRender: () => this.#mediaChanged() },
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
		const name = mediaName(block);
		if (slot.state === "failed") return `▣ ${name} — couldn't load: ${sanitize(slot.reason)}`;
		return `▣ ${name} — loading…`;
	}

	// ── State ────────────────────────────────────────────────────────────────

	#changed(): void {
		this.#version++;
	}

	#initChoice(field: ChoiceField): void {
		this.#notes.set(field, new Map());
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
			const editor = this.#newEditor();
			editor.setBorderVisible(false);
			editor.setMaxHeight(this.#textareaRows(field));
			// Enter leaves the field (handled before the editor); Shift+Enter inserts newlines.
			editor.disableSubmit = true;
			editor.placeholder = () => field.placeholder || undefined;
			// Prefilled drafts (a commit message) open at their first line, not scrolled to the end.
			editor.setText(field.value, { cursor: "start" });
			// Host edits (a Tern paste) reach the editor directly, past `handleNativeEvent`; they are activity too.
			editor.onChange = () => this.#resetCountdown();
			this.#editors.set(field, editor);
			return;
		}
		// A password keeps the masked input; any other one-line field takes Vim mode when the host turns it on.
		const vim = field.type === "password" ? undefined : this.#vimLineEditor(field.placeholder || undefined);
		if (vim) {
			vim.setText(field.value, { cursor: "start" });
			this.#editors.set(field, vim);
			return;
		}
		const input = new Input();
		input.prompt = "";
		input.mask = field.type === "password";
		input.placeholder = field.placeholder || undefined;
		input.setValue(field.value, { cursor: "start" });
		input.onSubmit = () => this.#advance();
		this.#inputs.set(field, input);
	}

	/**
	 * A one-line answer box (an `<input>`, a group's Other) as a Vim-mode editor, or undefined when
	 * Vim mode is off and the box stays a plain input.
	 */
	#vimLineEditor(placeholder: string | undefined): Editor | undefined {
		if (!this.#options.vimMode) return undefined;
		const editor = this.#newEditor();
		editor.setBorderVisible(false);
		editor.setMaxHeight(LINE_MAX_ROWS);
		// Enter moves on to the next field (handled before the editor).
		editor.disableSubmit = true;
		editor.placeholder = () => placeholder;
		editor.onChange = () => this.#resetCountdown();
		return editor;
	}

	/** A new editor for the form: the host's wiring, then the form's Vim mode. */
	#newEditor(): Editor {
		const editor = new Editor(getEditorTheme());
		this.#options.configureEditor?.(editor);
		editor.setVimMode(this.#options.vimMode === true);
		return editor;
	}

	/** Fixed textarea height: the `rows` asked for, grown to fit a prefilled draft, capped. */
	#textareaRows(field: TextField): number {
		const draftRows = field.value.split("\n").length;
		return Math.min(MAX_TEXTAREA_ROWS, Math.max(2, field.rows, draftRows));
	}

	#textValue(field: TextField): string {
		return this.#editors.get(field)?.getExpandedText() ?? this.#inputs.get(field)!.getValue();
	}

	#value(field: FormField): HtmlFormValue | undefined {
		if (field.kind === "text") return textValue(field, this.#textValue(field));
		const other = this.#otherChosen(field) ? this.#otherText(field) : undefined;
		return choiceValue(field, this.#checked.get(field)!, other);
	}

	/**
	 * Whether a group's Other answer counts: it has text and, for a radio group, no
	 * option is picked. Typing into a radio group's Other (from keys or the
	 * terminal's own edits) drops the picked option; picking an option afterwards
	 * keeps the text but sets Other aside.
	 */
	#otherChosen(field: ChoiceField): boolean {
		if (!this.#others.has(field)) return false;
		const text = this.#otherText(field);
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
			this.#options.onSubmit(this.data(), this.optionNotes());
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
			if (this.#noteEditor) this.#saveNote();
			this.#options.onTimeout?.(this.data(), this.optionNotes());
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

	#startNote(target?: number): void {
		const stop = this.#stops[this.#focus];
		if (this.#hidden || (stop?.kind !== "option" && stop?.kind !== "select")) return;
		// The editor draws under the focused stop, so the body must show it.
		this.#peek = false;
		const option =
			target ?? (stop.kind === "option" ? stop.option : (this.#open?.highlight ?? this.#current(stop.field)));
		if (option === undefined || stop.field.options[option]?.disabled !== false) return;
		const editor = (this.#savedNoteEditor ??= this.#newEditor());
		// Each note opens in Insert mode, wherever Vim mode was left when the last one closed.
		editor.resetVimMode();
		editor.setBorderVisible(false);
		editor.setMaxHeight(4);
		editor.disableSubmit = true;
		editor.setUseTerminalCursor(this.#useTerminalCursor);
		editor.onChange = () => this.#resetCountdown();
		const saved = this.#notes.get(stop.field)?.get(option);
		editor.setText(saved?.text ?? "", { cursor: "start" });
		if (this.#options.acceptImages) editor.atomicTokenPattern = PLACEHOLDER_REGEX;
		const note: OpenNote = {
			field: stop.field,
			option,
			editor,
			images: [...(saved?.images ?? [])],
			pasteHandler: new BracketedPasteHandler(),
			pastes: new OrderedPastes({
				deliver: text => editor.pasteText(text),
				run: () => this.#saveNote(),
				live: () => this.#noteEditor === note,
				afterSettle: () => this.#changed(),
			}),
		};
		this.#noteEditor = note;
		this.#syncControlFocus();
	}

	/** Keys that open a note on an option row, or on a dropdown, where type-ahead keeps the text keys. */
	#noteKeys(dropdown: boolean): KeyId[] {
		const keys = getKeybindings().getKeys("app.ask.note");
		// A text-typing key (`n`, `shift+n`) is a dropdown's type-ahead.
		return dropdown ? keys.filter(key => key.length !== 1 && !/^shift\+.$/.test(key)) : keys;
	}

	#matchesNoteKey(data: string, dropdown: boolean): boolean {
		return this.#noteKeys(dropdown).some(key => matchesKey(data, key));
	}

	/** The open note's key hints; a note on an unchosen option is kept but not submitted. */
	#noteEditHint(): string {
		const active = this.#noteEditor!;
		const unsent = this.#checked.get(active.field)!.has(active.option) ? "" : " · sent only if chosen";
		return `enter save · blank removes · esc keep${unsent}`;
	}

	/** Marker after a noted option: a submitted note, or a draft on an unchosen option. */
	#noteTag(field: ChoiceField, option: number): { text: string; color: ThemeColor } | undefined {
		if (!this.#notes.get(field)?.has(option)) return undefined;
		return this.#checked.get(field)!.has(option)
			? { text: "  ✎ note", color: "success" }
			: { text: "  ✎ draft", color: "dim" };
	}

	#noteEditorInput(data: string): void {
		const note = this.#noteEditor!;
		if (this.#options.acceptImages) {
			const paste = note.pasteHandler.process(data);
			if (paste.handled) {
				if (paste.pasteContent !== undefined) this.#notePaste(note, paste.pasteContent);
				if (paste.remaining.length > 0) this.handleInput(paste.remaining);
				return;
			}
		}
		// In Vim mode the first Esc leaves Insert mode (or a half-typed command); the next closes the note.
		if (matchesSelectCancel(data) && !(note.editor.vimConsumesEscape() && matchesKey(data, "escape"))) {
			this.#closeNote();
		} else if (getKeybindings().matches(data, "tui.input.submit")) this.#requestSave();
		else note.editor.handleInput(data);
	}

	#notePaste(note: OpenNote, content: string): void {
		const { onPasteImage, onPasteImagePath } = this.#options;
		const image = classifyImagePaste(content);
		if (image.kind === "clipboard" && onPasteImage) {
			void onPasteImage();
			return;
		}
		if (image.kind === "paths" && onPasteImagePath) {
			for (const path of image.paths) void onPasteImagePath(path);
			return;
		}
		note.pastes.paste(content);
	}

	#requestSave(): void {
		if (!this.#noteEditor!.pastes.holdAction()) this.#saveNote();
	}

	#saveNote(): void {
		const note = this.#noteEditor!;
		const { text, images } = compactImageAttachments(note.editor.getExpandedText().trim(), note.images);
		const notes = this.#notes.get(note.field)!;
		if (text) notes.set(note.option, { text, images });
		else notes.delete(note.option);
		this.#closeNote();
	}

	#closeNote(): void {
		const note = this.#noteEditor;
		if (note) {
			note.pastes.clear();
			// The editor is reused: a later note's literal `[Paste #1]` must not expand to this one's paste.
			note.editor.clearPasteState();
			note.editor.setText("");
		}
		this.#noteEditor = undefined;
		this.#syncControlFocus();
		this.#changed();
	}

	// ── Pasted images ────────────────────────────────────────────────────────

	/** Whether the form takes a new image paste now: a note is open and the form is shown. */
	get acceptsImages(): boolean {
		return !!this.#options.acceptImages && this.#noteEditor !== undefined && !this.#hidden;
	}

	/**
	 * Defined only while {@link acceptsImages}. A host routes Ctrl+V and pastes to any focused component that
	 * has `pasteText`, so with no note open the form must behave as a plain dialog.
	 */
	get pasteText(): ((text: string) => void) | undefined {
		return this.acceptsImages ? text => this.#pasteText(text) : undefined;
	}

	/**
	 * Adds an image to the open note; returns its `[Image #N, WxH]` marker for the caller to deliver.
	 * Takes it while the form is hidden too: a paste reserved before Alt+H still lands in its note.
	 */
	attachImage(image: ImageContent, dims?: { width: number; height: number }): string | undefined {
		const note = this.#options.acceptImages ? this.#noteEditor : undefined;
		if (!note) return undefined;
		note.images.push(image);
		return formatVisionMarker("image", note.images.length, dims);
	}

	/** Ordered delivery into the open note; refuses when {@link acceptsImages} is false. */
	beginPaste(): (text: string | undefined) => boolean {
		return this.acceptsImages ? this.#noteEditor!.pastes.begin() : () => false;
	}

	#pasteText(text: string): void {
		const note = this.#noteEditor;
		if (note && text) this.#notePaste(note, text);
	}

	#noteFromPointer(key: string): void {
		if (this.#hidden) return;
		const [listKey, rowKey] = key.split("/").slice(-2);
		if (listKey && /^f\d+$/.test(listKey)) {
			if (!rowKey || !/^o\d+$/.test(rowKey)) return;
			const field = this.#form.fields[Number(listKey.slice(1))];
			const option = Number(rowKey.slice(1));
			// Only the focused field shows its rows natively: an event from any other is stale.
			const shown = this.#stops[this.#focus];
			if (
				field?.kind !== "choice" ||
				field.options[option]?.disabled !== false ||
				shown?.kind === "submit" ||
				shown?.field !== field
			)
				return;
			const index = this.#stops.findIndex(
				stop =>
					(stop.kind === "option" || stop.kind === "select") &&
					stop.field === field &&
					(stop.kind === "select" || stop.option === option),
			);
			if (index === -1) return;
			this.#setFocus(index);
			this.#startNote(option);
			return;
		} else if (leafKey(key) !== "note") return;
		this.#startNote();
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
			this.#advance();
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
		if (getKeybindings().matches(data, "tui.select.confirm")) {
			// Back on Other after picking an option: Enter makes the kept text the answer again.
			if (!field.multi && this.#otherText(field).trim() !== "") this.#checked.get(field)!.clear();
			this.#advance();
			return;
		}
		const before = this.#otherText(field);
		this.#others.get(field)!.handleInput(data);
		if (this.#otherText(field) !== before) this.#errors.delete(field);
	}

	/** The Other answer's box. With Vim mode it is an editor, so Vim keys and Esc work as in a textarea. */
	#otherBox(): Input | Editor {
		const editor = this.#vimLineEditor(OTHER_PLACEHOLDER);
		if (editor) return editor;
		const input = new Input();
		input.prompt = "";
		input.placeholder = OTHER_PLACEHOLDER;
		return input;
	}

	#otherText(field: ChoiceField): string {
		const box = this.#others.get(field);
		if (box === undefined) return "";
		return box instanceof Editor ? box.getExpandedText() : box.getValue();
	}

	/** A closed dropdown: ←/→ change it, Space opens it, a letter jumps to a matching option. */
	#selectInput(field: ChoiceField, data: string): void {
		if (this.#matchesNoteKey(data, true)) {
			this.#startNote();
			return;
		}
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
			this.#advance();
			return;
		}
		const typed = extractPrintableText(data);
		const match = typed ? this.#typeAhead(field, current, typed) : undefined;
		if (match !== undefined) this.#choose(field, match);
	}

	/** An open dropdown owns the keys until a pick (Enter/Space), Esc or Tab closes it. */
	#dropdownInput(open: { field: ChoiceField; highlight: number }, data: string): void {
		if (this.#matchesNoteKey(data, true)) {
			this.#startNote(open.highlight);
			return;
		}
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
		const group = this.#groupOfStop(this.#focus);
		this.#focus = Math.max(0, Math.min(this.#stops.length - 1, index));
		this.#peek = false;
		this.#syncControlFocus();
		if (this.#groupOfStop(this.#focus) !== group) this.#reveal++;
	}

	/**
	 * Move focus `delta` stops, across questions. In rows, ↑ on an open question's first stop whose head
	 * the body cuts off scrolls up toward that head first, a body less a row at a time; the next ↑ at
	 * the head crosses into the previous question.
	 */
	#moveStop(delta: number): void {
		const view = this.#view;
		const group = this.#groupOfStop(this.#focus);
		if (
			delta < 0 &&
			view?.focus === this.#focus &&
			view.offset > view.head &&
			!isNativeRendering() &&
			(this.#focus === 0 || this.#groupOfStop(this.#focus - 1) !== group)
		) {
			this.#peek = true;
			this.#scrollOffset = Math.max(view.head, view.offset - Math.max(1, view.rows - 1));
			return;
		}
		this.#setFocus(this.#focus + delta);
	}

	/** Enter on a field: the next field, or submit when the form asks only this one. */
	#advance(): void {
		if (this.#sole) this.#submit();
		else this.#moveField(1);
	}

	/** Jump to the first stop of the next (or previous) field; Submit counts as a field. */
	#moveField(delta: number): void {
		const current = this.#fieldOfStop(this.#focus);
		let index = this.#focus;
		while (index + delta >= 0 && index + delta < this.#stops.length && this.#fieldOfStop(index) === current) {
			index += delta;
		}
		// Moving back lands on the previous field, not its last stop; either way at its answer.
		const target = this.#fieldOfStop(index);
		this.#setFocus(target ? this.#answerStop(target) : index);
	}

	/** The field of stop `index`; undefined for Submit. */
	#fieldOfStop(index: number): FormField | undefined {
		const stop = this.#stops[index];
		return stop && stop.kind !== "submit" ? stop.field : undefined;
	}

	/** Open the previous or next question group at its first field's answer; past the last, Submit. */
	#jumpQuestion(delta: number): void {
		const target = this.#groupOfStop(this.#focus) + delta;
		const first = this.#stops.findIndex((_, index) => this.#groupOfStop(index) === target);
		if (first !== -1) this.#setFocus(this.#answerStop(this.#fieldOfStop(first)));
	}

	#syncControlFocus(): void {
		const stop = this.#stops[this.#focus];
		const live = this.#focused && !this.#hidden && !this.#noteEditor;
		const active = stop?.kind === "text" ? stop.field : undefined;
		const other = stop?.kind === "other" ? stop.field : undefined;
		for (const [field, input] of this.#inputs) input.focused = live && field === active;
		for (const [field, input] of this.#others) input.focused = live && field === other;
		for (const [field, editor] of this.#editors) editor.focused = live && field === active;
		if (this.#savedNoteEditor) this.#savedNoteEditor.focused = this.#focused && !this.#hidden && !!this.#noteEditor;
	}

	// ── Native groups and hiding ─────────────────────────────────────────────

	/** The question group holding stop `index`; `#groups.length` for Submit. */
	#groupOfStop(index: number): number {
		const stop = this.#stops[index];
		if (!stop || stop.kind === "submit") return this.#groups.length;
		return this.#fieldGroup.get(stop.field) ?? 0;
	}

	/** Focus field `index` at its answer (see {@link #answerStop}). */
	#openField(index: number): void {
		const field = this.#form.fields[index];
		if (field && this.#stops.some(stop => stop.kind !== "submit" && stop.field === field)) {
			this.#setFocus(this.#answerStop(field));
		}
	}

	/**
	 * The stop where `field`'s answer is: its checked option, its chosen Other, else its first stop.
	 * Submit's stop when `field` has none.
	 */
	#answerStop(field: FormField | undefined): number {
		const stops = this.#stops.flatMap((stop, at) => (stop.kind !== "submit" && stop.field === field ? [at] : []));
		if (stops.length === 0) return this.#stops.length - 1;
		const checked = field?.kind === "choice" ? this.#checked.get(field)! : undefined;
		const answer = stops.find(at => {
			const stop = this.#stops[at]!;
			return (
				(stop.kind === "option" && checked?.has(stop.option)) ||
				(stop.kind === "other" && this.#otherChosen(stop.field))
			);
		});
		return answer ?? stops[0]!;
	}

	/** A folded field's pill: picks option `option` of `field` (flips it in a multi-select), focus staying put. */
	#pick(field: FormField | undefined, option: number): void {
		if (field?.kind !== "choice" || field.options[option]?.disabled !== false) return;
		if (field.multi) this.#toggle(field, option);
		else this.#choose(field, option);
	}

	#setHidden(hidden: boolean): void {
		if (this.#hidden === hidden) return;
		this.#hidden = hidden;
		// A hidden form takes no new paste (see acceptsImages), but one already reserved still lands
		// in its note, and an Enter held behind it still saves.
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
		const show = hideKey ? `${hideKey}/${enter}` : enter;
		const hints = [`${show} show`, `${editorKey("tui.select.cancel")} composer`];
		const hint = theme.fg("dim", ` · ${hints.join(" · ")}`);
		const label = theme.fg("accent", `${this.#titleText()} hidden:`);
		const room = Math.max(1, width - visibleWidth(label) - visibleWidth(hint) - 1);
		const summary = truncateToWidth(this.#hiddenSummary(), room, Ellipsis.Unicode);
		return [truncateToWidth(`${label} ${theme.fg("muted", summary)}${hint}`, width, Ellipsis.Unicode)];
	}

	// ── Rows ─────────────────────────────────────────────────────────────────

	#titleText(): string {
		const progress = this.#progress();
		const title = `${this.#options.title ?? DEFAULT_TITLE}${progress ? ` · ${progress}` : ""}`;
		return this.#remaining === undefined ? title : `${title} (${this.#remaining}s)`;
	}

	/** `2 of 5 answered`, for forms of two or more questions the keyboard reaches. */
	#progress(): string | undefined {
		const named = this.#form.fields.filter(field => field.name && reachable(field));
		if (named.length < 2) return undefined;
		return `${named.filter(field => this.#answered(field)).length} of ${named.length} answered`;
	}

	/**
	 * Body rows: the column's natural height (the tallest it gets with any one question open, or with
	 * Submit focused), capped by the terminal. Fixed per width, terminal height, pictures and errors, so
	 * moving focus or typing never resizes the panel; only a failed submit (new error rows) may.
	 */
	#bodyRows(width: number): number {
		const termRows = this.#options.tui?.terminal.rows ?? process.stdout.rows ?? 40;
		const errors = [...this.#errors].map(([field, error]) => `${this.#fieldIndex.get(field)}=${error}`).join("\0");
		const key = `${width}:${termRows}:${this.#mediaVersion}:${errors}`;
		if (this.#height?.key === key) return this.#height.rows;
		// The panel leaves the composer and status its reserved rows, but keeps a usable body on a tiny terminal.
		const panelRows = Math.min(Math.floor(termRows * DIALOG_HEIGHT_RATIO), termRows - ASK_RESERVED_ROWS);
		const cap = Math.max(MIN_BODY_ROWS, panelRows - CHROME_ROWS);
		let rows = 1;
		// A field opens alike whichever of its stops holds focus, so its first stop measures it.
		for (let stop = 0; stop < this.#stops.length && rows < cap; stop++) {
			if (stop > 0 && this.#fieldOfStop(stop - 1) === this.#fieldOfStop(stop)) continue;
			rows = Math.max(rows, this.#layout(width, stop, -1).lines.length);
		}
		rows = Math.min(cap, rows);
		this.#height = { key, rows };
		return rows;
	}

	/**
	 * `rows` rows of the column from the scroll offset, the shown pictures drawn, the open note editor or
	 * dropdown over them, and a scrollbar while the column overflows.
	 *
	 * The offset moves as little as keeps the focused stop's rows in view (its top when it is taller than
	 * the body), then up to the open question's head when that fits along, then to the nearest offset
	 * that cuts fewer pictures ({@link clearPictureEdges}). While ↑ peeks at a cut-off head (`#peek`) it
	 * keeps the peeked offset, or one above where the body was that cuts fewer. An open note keeps rows
	 * under its option for the editor.
	 */
	#renderBody(layout: Layout, rows: number, width: number): string[] {
		const { lines, focus, head } = layout;
		const max = Math.max(0, lines.length - rows);
		let offset = Math.min(this.#scrollOffset, max);
		if (!this.#peek) {
			if (focus.start < offset || focus.end - focus.start >= rows) offset = focus.start;
			else if (focus.end > offset + rows) offset = focus.end - rows;
			if (head < offset && focus.end - head <= rows) offset = head;
			offset = Math.min(offset, max);
		}
		// Like the dropdown, the note editor covers the rows under its option rather than pushing them.
		const noteRow = this.#noteEditor ? layout.noteRow : undefined;
		if (noteRow !== undefined) offset = Math.max(offset, noteRow - Math.max(0, rows - 3));
		else {
			// ↑ peeking toward the head moves the body up at least a row, never back down.
			const limit = this.#peek ? Math.max(offset, (this.#view?.offset ?? offset) - 1) : max;
			offset = clearPictureEdges(offset, rows, max, layout.pictures, this.#peek ? undefined : focus, limit);
		}
		this.#scrollOffset = offset;
		this.#view = { focus: this.#focus, offset, rows, head };
		const shown = lines.slice(offset, offset + rows);
		while (shown.length < rows) shown.push("");
		for (const picture of layout.pictures) {
			const top = picture.start - offset;
			const bottom = picture.end - offset;
			if (bottom <= 0 || top >= rows) continue;
			// Drawn only whole, so only shown pictures take image slots and none draws past the body's edge;
			// a cut one is a frame naming it.
			const from = Math.max(0, top);
			const to = Math.min(rows, bottom);
			const drawn =
				top >= 0 && bottom <= rows
					? picture.component.render(layout.width)
					: cutPictureRows(picture.alt, to - from, layout.width, { top: top < 0, bottom: bottom > rows });
			for (let row = from; row < to; row++) shown[row] = drawn[row - from] ?? "";
		}
		if (noteRow !== undefined) {
			const active = this.#noteEditor!;
			const inner = Math.max(1, layout.width - FIELD_INDENT);
			const top = noteRow - offset + 1;
			active.editor.setMaxHeight(Math.max(1, Math.min(4, rows - top - 1)));
			const header = theme.fg(
				"muted",
				truncateToWidth(
					`Note for ${optionText(active.field.options[active.option]!)} · ${this.#noteEditHint()}`,
					inner,
				),
			);
			const editing = [header, ...active.editor.render(inner)].map(line => padding(FIELD_INDENT) + line);
			shown.splice(top, editing.length, ...editing);
		} else if (layout.dropdown && this.#open) {
			const row = layout.dropdown.row - offset;
			const top = Math.max(0, layout.dropdown.top - offset);
			if (row >= 0 && row < rows) this.#overlayDropdown(shown, { top, row }, rows, layout.width);
		}
		const view = new ScrollView(shown.slice(0, rows), {
			height: rows,
			totalRows: Math.max(lines.length, offset + rows),
			scrollbar: "auto",
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		view.setScrollOffset(offset);
		return [...view.render(width)];
	}

	/**
	 * Draw the open dropdown over the body rows below its value row, or above
	 * its field when there is more room there. It covers rows rather than
	 * pushing them, so the column keeps its layout while it is open.
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
		const labels = options.map(
			(option, index) => optionText(option) + (this.#noteTag(open.field, index)?.text ?? ""),
		);
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
			const tag = this.#noteTag(open.field, index);
			const note = tag ? theme.fg(tag.color, tag.text) : "";
			const label = truncateToWidth(
				optionText(option),
				Math.max(1, inner - 4 - visibleWidth(note)),
				Ellipsis.Unicode,
			);
			const cell = `${theme.fg(color, `${cursor}${label}`)}${note}${padding(Math.max(0, inner - 3 - visibleWidth(label) - visibleWidth(note)))}${mark}`;
			out.push(`${theme.fg("accent", `${box.vertical} `)}${cell}${theme.fg("accent", ` ${box.vertical}`)}`);
		}
		out.push(edge(box.bottomLeft, box.bottomRight, first + visible < options.length, "↓"));
		return out;
	}

	#keyHintText(): string {
		if (this.#noteEditor) return this.#noteEditHint();
		const hideKey = editorKey("app.ask.hide");
		const composer = `${editorKey("tui.select.cancel")} composer${hideKey ? ` · ${hideKey} hide` : ""}`;
		const stop = this.#stops[this.#focus]!;
		const [noteKey] = this.#noteKeys(stop.kind === "select");
		const noteHint = noteKey ? ` · ${formatKeyHint(noteKey)} note` : "";
		const enter = formatKeyHint("enter");
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		if (this.#open)
			return `${upDown} highlight · ${enter} choose${noteHint} · ${editorKey("tui.select.cancel")} close`;
		const next = this.#sole ? "submit" : "next";
		let action: string;
		if (stop.kind === "submit") action = `${enter} submit`;
		else if (stop.kind === "text") action = `${enter} ${next}`;
		else if (stop.kind === "other") action = `type your own · ${enter} ${next}`;
		else if (stop.kind === "select")
			action = `${formatKeyHint("space")} open · ${formatKeyHint("left")}/${formatKeyHint("right")} change · ${enter} ${next}`;
		else if (stop.field.multi) action = `${formatKeyHint("space")} toggle · ${enter} ${next}`;
		else action = `${enter} ${this.#sole ? "submit" : "choose"}`;
		if (stop.kind === "option" || stop.kind === "select") action += noteHint;
		const hints = [action, `${upDown} move`];
		if (stop.kind !== "submit") hints.push(`${formatKeyHint("tab")} next field`);
		hints.push(composer);
		if (this.#groups.length > 1) {
			const keys =
				stop.kind === "text" || stop.kind === "select"
					? editorKeys("tui.select.pageUp", "tui.select.pageDown")
					: `${formatKeyHint("left")}/${formatKeyHint("right")}`;
			hints.push(`${keys} question`);
		}
		return hints.join(" · ");
	}

	/**
	 * The stacked column at `width`, stop `focus` holding focus and stop `highlight` drawn focused (-1:
	 * none): the intro, then each question group (the one holding focus open: its context, its focused
	 * field's controls and its other fields folded; the rest folded field by field), then the Submit row.
	 */
	#layout(width: number, focus: number, highlight: number): Layout {
		const lines: string[] = [];
		const layout: Layout = { width, lines, focus: { start: 0, end: 0 }, head: 0, pictures: [] };
		const focusField = this.#fieldOfStop(focus);
		const open = this.#groupOfStop(focus);
		/** Pushes `rows` a blank row under the rows before them (none when `tight`); returns their first row. */
		const emit = (rows: readonly string[], tight = false): number => {
			if (lines.length > 0 && !tight) lines.push("");
			const start = lines.length;
			lines.push(...rows);
			return start;
		};
		const emitParts = (parts: readonly FormPart[]): void => {
			for (const { section: index, start, end } of parts) {
				const section = this.#form.sections[index]!;
				// A title keeps the block after it under it; a short text block right before a field, that field.
				let keep: "title" | "caption" | undefined;
				if (start === 0 && section.title.length > 0) {
					emit(hang("", section.title, text => theme.bold(theme.fg("text", text)), width));
					keep = "title";
				}
				for (let at = start; at < end; at++) {
					const block = section.blocks[at]!;
					if (block.kind !== "field") {
						if (this.#isFoldCaption(section.blocks, at, focusField)) continue;
						const { lines: rows, picture } = this.#contextRows(block, width);
						const top = emit(rows, keep === "title");
						if (picture) layout.pictures.push({ start: top, end: top + rows.length, ...picture });
						keep = block.kind === "text" && rows.length <= CAPTION_MAX_ROWS ? "caption" : undefined;
						continue;
					}
					const field = block.field;
					const tight = keep !== undefined;
					keep = undefined;
					if (field !== focusField) {
						emit(renderFoldedQuestion(this.#folded(field), width), tight);
						continue;
					}
					const first = this.#stops.findIndex(stop => stop.kind !== "submit" && stop.field === field);
					const runs = this.#fieldRuns(field, width, highlight, first);
					const top = emit(
						runs.flatMap(run => run.lines),
						tight,
					);
					let row = top;
					let stop = first;
					for (const run of runs) {
						if (run.stop && stop++ === focus) layout.focus = { start: row, end: row + run.lines.length };
						row += run.lines.length;
					}
					if (field.kind === "choice" && this.#open?.field === field) {
						// The value row, above the error.
						const errorRows = this.#errors.has(field) ? 1 : 0;
						layout.dropdown = { top, row: top + runs[0]!.lines.length - 1 - errorRows };
					}
					if (this.#noteEditor?.field === field) layout.noteRow = layout.focus.end - 1;
				}
			}
		};
		emitParts(this.#intro);
		this.#groups.forEach((group, index) => {
			if (index !== open) {
				for (const field of group.fields) emit(renderFoldedQuestion(this.#folded(field), width));
				return;
			}
			const before = lines.length;
			emitParts(group.parts);
			// The first group's head is the intro's too.
			layout.head = index === 0 || before === 0 ? 0 : before + 1;
		});
		const submit =
			highlight === this.#stops.length - 1
				? theme.fg("accent", theme.bold(`${theme.nav.cursor} ${SUBMIT_LABEL}`))
				: theme.fg("muted", `  ${SUBMIT_LABEL}`);
		const pending = this.#errors.size > 0 ? theme.fg("error", `  ${this.#errors.size} to fix`) : "";
		const submitRow = emit([`${submit}${pending}`]);
		if (focusField === undefined) {
			layout.focus = { start: submitRow, end: submitRow + 1 };
			layout.head = submitRow;
		}
		return layout;
	}

	/** Rows of one open field in runs, each flagged when it is a focus stop; stops are numbered from `firstStop`. */
	#fieldRuns(field: FormField, width: number, focusedStop: number, firstStop: number): FieldRun[] {
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
			const stop = field.kind === "text" || field.options.some(option => !option.disabled);
			return [{ lines: [...lines, ...errorLines], stop }];
		}
		const out: FieldRun[] = [];
		if (field.label.length > 0) {
			out.push({ lines: hang("  ", field.label, text => theme.fg("text", text), width), stop: false });
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
			const tag = this.#noteTag(field, index);
			const noteMarker = tag ? theme.fg(tag.color, tag.text) : "";
			const lines = hang(
				`${cursor}${marker} `,
				option.label,
				text => theme.fg(color, text),
				Math.max(1, width - visibleWidth(noteMarker)),
			);
			lines[0] = `${lines[0] ?? ""}${noteMarker}`;
			out.push({ lines, stop: !option.disabled });
		});
		if (field.other) out.push({ lines: this.#otherLines(field, focusedStop === stop, width), stop: true });
		if (errorLines.length > 0) out.push({ lines: errorLines, stop: false });
		return out;
	}

	/** `○ Other: <text>` — an inline input while focused, else the text or a dim prompt. */
	#otherLines(field: ChoiceField, focused: boolean, width: number): string[] {
		const chosen = this.#otherChosen(field);
		const box = this.#others.get(field)!;
		const cursor = focused ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
		const marker = theme.fg(chosen ? "success" : "dim", optionMarker(theme, field.multi, chosen));
		const label = theme.fg(focused ? "accent" : chosen ? "toolOutput" : "text", `${OTHER_LABEL}: `);
		const prefix = `${cursor}${marker} ${label}`;
		const inner = Math.max(1, width - visibleWidth(prefix));
		const value = this.#otherText(field);
		if (focused && box instanceof Editor) {
			// Rows past the first sit under the text, not under the label.
			const indent = " ".repeat(visibleWidth(prefix));
			return box.render(inner).map((row, index) => `${index === 0 ? prefix : indent}${row}`);
		}
		if (focused) {
			box.cursorOverride =
				value === ""
					? `\x1b[7m \x1b[27m${theme.fg("dim", truncateToWidth(OTHER_PLACEHOLDER, Math.max(1, inner - 1)))}`
					: undefined;
			return [`${prefix}${box.render(inner)[0] ?? ""}`];
		}
		const shown = value
			? theme.fg(
					chosen ? "toolOutput" : "dim",
					truncateToWidth(sanitize(value).replace(/\s+/g, " "), inner, Ellipsis.Unicode),
				)
			: theme.fg("dim", OTHER_PLACEHOLDER);
		return [`${prefix}${shown}`];
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
		const tag = current === undefined ? undefined : this.#noteTag(field, current);
		const note = tag ? theme.fg(tag.color, tag.text) : "";
		const position =
			(current === undefined ? "" : theme.fg("dim", `  ${current + 1}/${field.options.length}`)) + note;
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
		} else if (focused && this.#editors.has(field)) {
			rows = [...this.#editors.get(field)!.render(inner)];
		} else if (focused) {
			const input = this.#inputs.get(field)!;
			input.cursorOverride =
				value === "" && field.placeholder
					? `\x1b[7m \x1b[27m${theme.fg("dim", truncateToWidth(sanitize(field.placeholder), Math.max(1, inner - 1)))}`
					: undefined;
			rows = [...input.render(inner)];
		} else if (value) {
			// A Vim-mode box can hold a line break (`o`, a linewise put); folded, the answer stays one row.
			const shown = field.type === "password" ? "•".repeat(value.length) : sanitize(value).replace(/\s+/g, " ");
			rows = [theme.fg("toolOutput", truncateToWidth(shown, inner, Ellipsis.Unicode))];
		} else {
			rows = [theme.fg("dim", truncateToWidth(sanitize(field.placeholder), inner, Ellipsis.Unicode))];
		}
		return [...label, ...rows.map(row => `${prefix}${row}`)];
	}

	/** Rows of a non-field block: its wrapped lines, list items or table rows, or a picture. */
	#contextRows(block: Exclude<FormBlock, { kind: "field" }>, width: number): BlockRows {
		switch (block.kind) {
			case "text": {
				const base = block.heading
					? (text: string) => theme.bold(theme.fg("text", text))
					: (text: string) => theme.fg("muted", text);
				return { lines: hang("", block.spans, base, width) };
			}
			case "list":
				return {
					lines: block.items.flatMap((item, index) => {
						const bullet = theme.fg("mdListBullet", block.ordered ? `${index + 1}. ` : "• ");
						return hang(bullet, item, text => theme.fg("muted", text), width);
					}),
				};
			case "pre":
				return {
					lines: sanitize(block.text)
						.split("\n")
						.map(
							line =>
								`  ${theme.fg("mdCodeBlock", truncateToWidth(line, Math.max(1, width - 2), Ellipsis.Unicode))}`,
						),
				};
			case "image":
			case "svg": {
				const slot = this.#media.get(block)!;
				const rows = slot.state === "ready" ? measureRender(() => slot.rows.render(width)).value : [];
				if (rows.length > 0 && slot.state === "ready") {
					return { lines: [...rows], picture: { component: slot.rows, alt: mediaName(block) } };
				}
				return {
					lines: [theme.fg("dim", truncateToWidth(this.#mediaNote(block, slot), width, Ellipsis.Unicode))],
				};
			}
			case "table": {
				const cells = block.rows.map(row => row.map(cell => sanitize(spansText(cell))));
				const count = Math.max(0, ...cells.map(row => row.length));
				const columns: TableColumn[] = Array.from({ length: count }, (_, column) => ({
					width: Math.max(
						1,
						...cells.flatMap(row => (row[column] ?? "").split("\n").map(line => visibleWidth(line))),
					),
					minWidth: 4,
					align: "left",
					overflow: "wrap",
				}));
				const lines: string[] = [];
				cells.forEach((row, index) => {
					if (index > 0 && index === block.headerRows) lines.push(theme.fg("dim", "─".repeat(width)));
					const style =
						index < block.headerRows
							? (text: string) => theme.bold(theme.fg("text", text))
							: (text: string) => theme.fg("muted", text);
					const padded = Array.from({ length: count }, (_, column) => ({ text: row[column] ?? "", style }));
					lines.push(...renderTableRowLines(padded, columns, width, { gap: "  " }));
				});
				return { lines };
			}
		}
	}

	// ── Native ───────────────────────────────────────────────────────────────

	/**
	 * The ask card: the intro, then each question group. The group holding focus is open (its context,
	 * its focused field's controls, its other fields folded); every other one folds field by field. A
	 * group of one field folds to that field under the group's motion key, so opening it glides.
	 */
	#describeForm(skip: string | undefined): NativeNode {
		const open = this.#groupOfStop(this.#focus);
		const body: NativeChild[] = [];
		if (this.#intro.length > 0) {
			body.push(withMotion(col(this.#describeParts(this.#intro), { gap: "md", role: "omp.ask.intro" }), "intro"));
		}
		this.#groups.forEach((group, index) => {
			const key = `g${index}`;
			if (index === open) {
				body.push(openQuestion(key, this.#describeParts(group.parts), this.#reveal));
			} else if (group.fields.length === 1) {
				body.push(this.#foldField(group.fields[0]!, key));
			} else {
				const folds = group.fields.map(field => this.#foldField(field, `q${this.#fieldIndex.get(field)}`));
				body.push(withMotion(col(folds, { gap: "md", role: "omp.ask.group" }), key));
			}
		});
		return askCard({
			progress: this.#progress(),
			body,
			skip,
			actions: this.#describeActions(),
		});
	}

	/** Section parts as the card's children: a fieldset's legend, its context and its fields. */
	#describeParts(parts: readonly FormPart[]): NativeChild[] {
		const focused = this.#fieldOfStop(this.#focus);
		return parts.flatMap(({ section: index, start, end }) => {
			const section = this.#form.sections[index]!;
			const children = section.blocks.slice(start, end).flatMap((block, offset) => {
				const at = start + offset;
				if (this.#isFoldCaption(section.blocks, at, focused)) return [];
				const described = this.#describeBlock(block);
				// Fields carry their own motion keys; context fades in and out with its group.
				return [block.kind === "field" ? described : withMotion(described, `c${index}.${at}`)];
			});
			if (start === 0 && section.title.length > 0) {
				const legend = text(nativeSpans(section.title), { wrap: "word", role: "omp.ask.legend" });
				children.unshift(withMotion(legend, `l${index}`));
			}
			return children;
		});
	}

	/** Whether `field` holds an answer that passes its rules. */
	#answered(field: FormField): boolean {
		const value = this.#value(field);
		if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return false;
		return fieldError(field, value) === undefined;
	}

	/**
	 * Whether `blocks[at]` is the caption of a folded field right after it: the field shows it as its
	 * question, so drawn above it too it would read twice.
	 */
	#isFoldCaption(blocks: readonly FormBlock[], at: number, focused: FormField | undefined): boolean {
		const block = blocks[at];
		const next = blocks[at + 1];
		return (
			block?.kind === "text" &&
			next?.kind === "field" &&
			next.field !== focused &&
			this.#questions.get(next.field) === spansText(block.spans).replace(/\s+/g, " ").trim()
		);
	}

	/** What `field` shows folded, natively and in rows: its question over its answer or option pills. */
	#folded(field: FormField): FoldedRows {
		return {
			question: sanitize(this.#questions.get(field) ?? field.name),
			answered: this.#answered(field),
			error: this.#errors.get(field),
			summary: this.#foldSummary(field, this.#fieldIndex.get(field)!),
		};
	}

	/** `field` folded under motion key `key`. */
	#foldField(field: FormField, key: string): NativeNode {
		const { question, ...folded } = this.#folded(field);
		return foldQuestion({
			key,
			question: [span(question)],
			...folded,
			open: `${OPEN_ACT}${this.#fieldIndex.get(field)}`,
		});
	}

	#foldSummary(field: FormField, index: number): FoldSummary {
		if (field.kind === "text") {
			const value = this.#textValue(field);
			if (value.trim() === "") return { kind: "well", placeholder: sanitize(field.placeholder) || WELL_PLACEHOLDER };
			const shown =
				field.type === "password" ? "•".repeat(value.length) : sanitize(value).replace(/\s+/g, " ").trim();
			return { kind: "answer", text: shown };
		}
		// Before reading the checks: typing a radio group's Other drops its picked option.
		const other = this.#otherChosen(field);
		const checked = this.#checked.get(field)!;
		const pills: AskPill[] = field.options.flatMap((option, at) =>
			option.disabled && !checked.has(at)
				? []
				: [
						{
							label: optionText(option) || option.value,
							chosen: checked.has(at),
							act: `${PICK_ACT}${index}:${at}`,
						},
					],
		);
		if (other) {
			const typed = sanitize(this.#otherText(field)).replace(/\s+/g, " ").trim();
			pills.push({ label: `${OTHER_LABEL}: ${typed}`, chosen: true, act: `${OPEN_ACT}${index}` });
		}
		const notes = this.#notes.get(field);
		const note = [...checked].map(at => notes?.get(at)?.text.trim()).find(Boolean);
		return { kind: "pills", pills, more: `${OPEN_ACT}${index}`, note: note && sanitize(note).replace(/\s+/g, " ") };
	}

	/**
	 * The countdown, then Cancel, Note on an option, and Submit, which validates the whole form and opens
	 * the first answer that needs a fix. An open note shows Keep and Save instead.
	 */
	#describeActions(): NativeNode {
		if (this.#noteEditor) {
			return actionBar([
				text(this.#noteEditHint(), { role: "omp.ask.note" }),
				actionButton("Keep", "cancel", { keys: "escape" }),
				actionButton("Save", "save-note", { keys: "enter" }),
			]);
		}
		const lead = this.#remaining !== undefined ? `Submits these answers in ${this.#remaining}s` : undefined;
		const stop = this.#stops[this.#focus]!;
		const [noteKey] = this.#noteKeys(stop.kind === "select");
		return actionBar([
			lead ? text([span(lead, "muted")], { truncate: "end", role: "omp.ask.summary" }) : null,
			...(lead ? [null] : []),
			actionButton("Cancel", "cancel"),
			...(stop.kind === "option" || stop.kind === "select"
				? [
						actionButton(
							"Note",
							"note",
							noteKey
								? { keys: noteKey, title: `Add a note to the highlighted answer  ${formatKeyHint(noteKey)}` }
								: { title: "Add a note to the highlighted answer" },
						),
					]
				: []),
			actionButton(SUBMIT_LABEL, "submit", {
				...(stop.kind === "submit" || this.#sole ? { keys: "enter" } : {}),
				tone: "accent",
			}),
		]);
	}

	/** One block of a section; a field open (the focused one) or folded, under its motion key `q<index>`. */
	#describeBlock(block: FormBlock): NativeNode {
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
			case "field": {
				const key = `q${this.#fieldIndex.get(block.field)}`;
				const stop = this.#stops[this.#focus];
				return stop && stop.kind !== "submit" && stop.field === block.field
					? withMotion(this.#describeField(block.field), key)
					: this.#foldField(block.field, key);
			}
		}
	}

	/**
	 * The focused field, open. A text field is its live `Input`/`Editor`, the only editor node the form
	 * describes (every other field is folded), so the terminal's keyboard focus (the first editor of the
	 * focused component) follows the form's.
	 */
	#describeField(field: FormField): NativeNode {
		const index = this.#fieldIndex.get(field)!;
		const error = this.#errors.get(field);
		const children: NativeChild[] = [];
		if (field.label.length > 0) {
			const required = field.required ? [span(" *", "error")] : [];
			children.push(text([...nativeSpans(field.label), ...required], { wrap: "word", role: "omp.ask.label" }));
		}
		if (field.kind === "text") {
			children.push(this.#editors.get(field) ?? this.#inputs.get(field)!);
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
				const note = this.#notes.get(field)?.get(optionIndex)?.text;
				return item(`o${optionIndex}`, {
					label: nativeSpans(option.label),
					role,
					tone: isChecked ? "accent" : undefined,
					icon: field.multi && isChecked ? "check" : undefined,
					disabled: option.disabled || undefined,
					detail: note
						? [span(isChecked ? "  ✎ " : "  ✎ draft · ", "dim"), span(sanitize(note).replace(/\s+/g, " "), "em")]
						: undefined,
					actions: !option.disabled ? { menu: ["note"] } : undefined,
				});
			});
			if (field.other) {
				const typed = sanitize(this.#otherText(field).trim());
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
			if (this.#noteEditor?.field === field) {
				children.push(
					text(`Note for ${optionText(field.options[this.#noteEditor.option]!)}`, {
						role: "omp.ask.note",
						wrap: "word",
					}),
					this.#noteEditor.editor,
				);
			}
			// Typing the Other answer: its input is the form's one live editor, so the terminal focuses it.
			if (focusedOption === OTHER_ITEM) children.push(this.#others.get(field)!);
		}
		if (error) children.push(text([span(error, "error")], { role: "omp.ask.error" }));
		return col(children, { gap: "xs", role: "omp.ask.field" });
	}
}
