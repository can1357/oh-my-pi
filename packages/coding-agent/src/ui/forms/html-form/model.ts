/**
 * State of the HTML form dialog: which field is open (or the Submit row),
 * each field's answer, the highlighted row of a choice field, an open select
 * dropdown, the note being written, and whether the card is collapsed to one
 * line. Answers breaking the form's rules are flagged as warnings only:
 * Submit always sends what the user entered.
 *
 * The form is shown one field at a time inside its section ("group"): the
 * open field's group lists its legend, text and fields (the others folded
 * to their answers); other groups show only their folded fields.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { batch, type KeyEvent, type Signal, signal, type TextEdit, untrack } from "@oh-my-pi/pi-tui";
import { applyEdit, applyMaskedEdit } from "../../overlays/panels/common";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { compactImageMarkers, formatVisionMarker } from "../../../modes/view-model/prompt/composer-attachments";
import { extractImagePastePathsFromText } from "../../../modes/view-model/prompt/custom-editor";
import {
	choiceValue,
	fieldError,
	fieldQuestions,
	type HtmlFormData,
	type HtmlFormValue,
	type OptionNote,
	textValue,
} from "../../../tools/html-form/data";
import type { ChoiceField, FormField, HtmlForm, TextField } from "../../../tools/html-form/parse";
import { spansText } from "../../../tools/html-form/parse";
import { type DialogVim, UndoHistory, VimEditor } from "../../composer/vim-editor";
import { editLine, type LineState } from "../../overlays/settings/line-edit";
import type { AskPill } from "../../overlays/panels/ask-dialog";
import { type FormLayout, formLayout } from "./layout";
import { listKeyId, matchesSelectCancel } from "../../../config/keybindings/matchers";

/** The free-text answer row of a choice field. */
export const OTHER_ROW = -1;

/** Action id prefix of an {@link HtmlFormAction} button: `action:<id>`. */
export const ACTION_ACT = "action:";

/** Where the dialog's keys go: a field (by index) or the Submit row. */
export type Active = number | "submit";

/** One field's answer. */
export interface FieldAnswer {
	/** Checked option indices (choice fields). */
	checked: ReadonlySet<number>;
	/** The free-text "Other" answer and whether it is chosen (radio) or checked (checkbox). */
	other: LineState;
	otherChosen: boolean;
	/** Text fields: the text. */
	text: LineState;
	/** Saved notes by option index. */
	notes: ReadonlyMap<number, string>;
	/** Images pasted into saved notes, by option index (`[Image #N…]` in the note is `images[N-1]`). */
	noteImages: ReadonlyMap<number, readonly ImageContent[]>;
}

/** A note being written for one option. */
export interface NoteDraft {
	readonly field: number;
	readonly option: number;
	readonly line: LineState;
	/** Images pasted into the note (see {@link HtmlFormModel.attachNoteImage}). */
	readonly images: readonly ImageContent[];
}

/** A button beside Submit that ends the form without submitting it (e.g. Decline): its `label`, and the `id` {@link HtmlFormCallbacks.onAction} receives. */
export interface HtmlFormAction {
	readonly id: string;
	readonly label: string;
}

/** How the host hears from the dialog. */
export interface HtmlFormCallbacks {
	onSubmit(data: HtmlFormData, notes: OptionNote[]): void;
	onCancel(): void;
	/** One of the form's {@link HtmlFormAction}s was pressed. */
	onAction?(id: string): void;
	/** The dialog gives keys back to the composer (Escape, Tab past Submit). */
	releaseKeys?(): void;
	/** A pointer event in the dialog: it takes keys again. */
	claimKeys?(): void;
	/** The countdown ran out: the draft is sent as it is. */
	onTimeout?(data: HtmlFormData, notes: OptionNote[]): void;
	/**
	 * Notes take pasted images: called for the image-paste key and an empty bracketed paste (the
	 * terminal's cue for an image-only clipboard) while a note is open. The host attaches what it
	 * reads with {@link HtmlFormModel.attachNoteImage}.
	 */
	onPasteImage?(): void;
	/** With {@link onPasteImage}: each path of a paste made only of image paths, while a note is open. */
	onPasteImagePath?(path: string): void;
	/**
	 * The paste key on a text box (a text field, an Other answer, a note without image support): the
	 * host reads the clipboard and delivers its text through {@link HtmlFormModel.paste}, resolving
	 * whether it did. Until it settles that text goes to the box the key was pressed in, and a submit
	 * waits for it.
	 */
	onPasteClipboard?(): Promise<boolean>;
}

/** A box the dialog types into: a text field, a choice field's Other answer, or the open note. */
export type TextBox = { readonly kind: "text" | "other"; readonly field: number } | { readonly kind: "note" };

/** A clipboard paste the host is reading; `open` until its text arrives. */
interface PasteReservation {
	readonly target: TextBox;
	open: boolean;
}

function boxKey(box: TextBox): string {
	return box.kind === "note" ? "note" : `${box.kind}:${box.field}`;
}

function emptyAnswer(field: FormField): FieldAnswer {
	const text = field.kind === "text" ? field.value : "";
	const checked = field.kind === "choice" ? field.options.flatMap((o, i) => (o.checked ? [i] : [])) : [];
	return {
		// Several checked radios: the last one wins, as in a browser.
		checked: new Set(field.kind === "choice" && !field.multi ? checked.slice(-1) : checked),
		other: { text: "", cursor: 0 },
		otherChosen: false,
		text: { text, cursor: 0 },
		notes: new Map(),
		noteImages: new Map(),
	};
}

/** `text` with markers of deleted images dropped and the rest renumbered by appearance, and the images they keep. */
function compactNote(text: string, images: readonly ImageContent[]): { text: string; images: ImageContent[] } {
	const compacted = compactImageMarkers(text, images.length, { byAppearance: true });
	if (!compacted) return { text, images: [...images] };
	return { text: compacted.text, images: compacted.keep.map(index => images[index]!) };
}

/** The caret of a multi-line box one line up or down, keeping its column where the line reaches it. */
function lineStep(line: LineState, delta: 1 | -1): LineState {
	const { text, cursor } = line;
	const start = text.slice(0, cursor).lastIndexOf("\n") + 1;
	const column = cursor - start;
	if (delta < 0) {
		const above = text.slice(0, Math.max(0, start - 1)).lastIndexOf("\n") + 1;
		return { text, cursor: Math.min(above + column, start - 1) };
	}
	const end = text.indexOf("\n", cursor);
	const below = text.indexOf("\n", end + 1);
	return { text, cursor: Math.min(end + 1 + column, below === -1 ? text.length : below) };
}

/** Whether `value` leaves its field unanswered, as {@link fieldError} counts emptiness. */
function isBlank(value: HtmlFormValue | undefined): boolean {
	return value === undefined || (Array.isArray(value) ? value.length === 0 : String(value).trim() === "");
}

/** Whether `key` types a character (a dropdown's type-ahead), not a Ctrl/Alt/Super chord. */
function isPrintable(key: KeyEvent): boolean {
	return key.text !== undefined && key.text !== "" && !/(?:^|\+)(?:ctrl|alt|super)\+/.test(key.id);
}

/** Whether `field` draws as a one-row dropdown (a single `<select>`). */
export function isDropdown(field: FormField): boolean {
	return field.kind === "choice" && field.select && !field.multi;
}

export class HtmlFormModel {
	readonly form: HtmlForm;
	readonly questions: Map<FormField, string>;
	/** The intro and the question groups the dialog shows. */
	readonly layout: FormLayout;
	/** The keys reach one field only: Enter on it submits, there being no next field to move to. */
	readonly sole: boolean;
	/** Whether Tern draws the form: it sits in the transcript there, hiding nothing, so it never hides. */
	readonly #native: () => boolean;
	readonly answers = signal<readonly FieldAnswer[]>([]);
	readonly active = signal<Active>(0);
	/** Highlighted row of the active choice field: an option index or {@link OTHER_ROW}. */
	readonly row = signal(0);
	/** Highlighted option of the open dropdown; undefined while it is closed. */
	readonly dropdown = signal<number | undefined>(undefined);
	readonly note = signal<NoteDraft | undefined>(undefined);
	readonly hidden = signal(false);
	/**
	 * Where the highlighted row sits when the open group is taller than the
	 * card: on top, or on the bottom after Up at the very first row (showing
	 * the text above it).
	 */
	readonly scrollAnchor = signal<"top" | "bottom">("top");
	readonly focused: Signal<boolean>;
	/** The buttons beside Submit; empty when the host passed none. */
	readonly actions: readonly HtmlFormAction[];
	/** The Submit row's button Enter presses: 0 for Submit, else `actions[button - 1]`. */
	readonly button = signal(0);
	readonly #callbacks: HtmlFormCallbacks;
	#done = false;
	/** Clipboard pastes still reading, oldest first; a submit waits for them. */
	readonly #pastes: PasteReservation[] = [];
	#submitAfterPastes = false;
	/** Vim editors of the text boxes by {@link boxKey}; empty without Vim mode. */
	readonly #vims = new Map<string, VimEditor>();
	/** The note editor's undo, cleared as each note opens. */
	#noteHistory: UndoHistory | undefined;

	constructor(
		form: HtmlForm,
		callbacks: HtmlFormCallbacks,
		options: {
			focused?: boolean;
			/** Vim mode: the text boxes take Vim keys (a password stays plain) and `j`/`k` step between option rows. */
			vim?: DialogVim;
			/** Whether Tern draws the form (reactive); a plain terminal when omitted. */
			native?: () => boolean;
			/**
			 * Buttons beside Submit that end the form without submitting it. On the Submit row ←/→ pick
			 * one and Enter presses it; they replace the Cancel button, so include a cancel when wanted.
			 */
			actions?: readonly HtmlFormAction[];
		} = {},
	) {
		this.actions = options.actions ?? [];
		this.form = form;
		this.questions = fieldQuestions(form);
		this.layout = formLayout(form);
		this.#native = options.native ?? (() => false);
		this.#callbacks = callbacks;
		this.focused = signal(options.focused ?? true);
		this.answers.set(form.fields.map(emptyAnswer));
		if (options.vim) {
			const vim = options.vim;
			form.fields.forEach((field, index) => {
				if (field.kind === "text" && field.type !== "password") this.#addVim(vim, { kind: "text", field: index });
				else if (field.kind === "choice" && field.other && !isDropdown(field))
					this.#addVim(vim, { kind: "other", field: index });
			});
			this.#addVim(vim, { kind: "note" });
		}
		const reachable = form.fields.flatMap((_, index) => (this.#reachable(index) ? [index] : []));
		this.sole = reachable.length === 1;
		// Open where the answer is, so Enter accepts a preselected choice instead of overwriting it.
		if (reachable.length > 0) this.#enter(reachable[0]!);
		else this.active.set("submit");
	}

	#addVim(options: DialogVim, box: TextBox): void {
		const history = new UndoHistory();
		if (box.kind === "note") this.#noteHistory = history;
		const vim = new VimEditor({
			...options,
			text: () => this.#line(box).text,
			cursor: () => this.#line(box).cursor,
			set: (text, cursor) => this.#setLine(box, { text, cursor }),
			history,
			// `k`/`j` past a field's first or last line step to the previous or next row, as ↑/↓.
			...(box.kind === "note"
				? {}
				: {
						historyStep: (older: boolean) => this.#move(older ? -1 : 1),
					}),
		});
		vim.begin();
		this.#vims.set(boxKey(box), vim);
	}

	/** The Vim editor of `box`; undefined without Vim mode and in a password. */
	vim(box: TextBox): VimEditor | undefined {
		return this.#vims.get(boxKey(box));
	}

	/** The line and caret of `box`. */
	#line(box: TextBox): LineState {
		if (box.kind === "note") return untrack(this.note)?.line ?? { text: "", cursor: 0 };
		const answer = untrack(() => this.answer(box.field));
		return box.kind === "text" ? answer.text : answer.other;
	}

	#setLine(box: TextBox, line: LineState): void {
		if (box.kind === "note") {
			const note = untrack(this.note);
			if (note) this.note.set({ ...note, line });
		} else if (box.kind === "text") this.#editText(box.field, line);
		else this.#editOther(box.field, line);
	}

	/** An edit typed or pasted into `box`; its Vim editor records it for undo and `.`. */
	#editBox(box: TextBox, line: LineState): void {
		const before = this.#line(box);
		this.#setLine(box, line);
		this.vim(box)?.edited(before);
	}

	/** An edit from the mounted native field, against the text the terminal actually drew. */
	edit(box: TextBox, edit: TextEdit): void {
		const active = this.#activeBox();
		if (!active || boxKey(box) !== boxKey(active)) return;
		const field = box.kind === "text" ? this.field(box.field) : undefined;
		const apply = field?.kind === "text" && field.type === "password" ? applyMaskedEdit : applyEdit;
		const next = apply(this.#line(box), edit);
		if (next) this.#editBox(box, next);
	}

	/** A key typed into `box`: Vim takes it first in Vim mode, else it edits the line (`accept` may refuse). */
	#typeKey(box: TextBox, key: KeyEvent, accept?: (next: LineState) => boolean): void {
		if (this.vim(box)?.handle(key)) return;
		const next = editLine(this.#line(box), key);
		if (next && (accept?.(next) ?? true)) this.#editBox(box, next);
	}

	get fields(): readonly FormField[] {
		return this.form.fields;
	}

	field(index: number): FormField {
		return this.form.fields[index]!;
	}

	answer(index: number): FieldAnswer {
		return this.answers()[index]!;
	}

	question(index: number): string {
		return this.questions.get(this.field(index)) ?? this.field(index).name;
	}

	// ─── Answers ────────────────────────────────────────────────────────────

	/** The value field `index` submits (undefined: nothing). */
	value(index: number): HtmlFormValue | undefined {
		const field = this.field(index);
		const answer = this.answer(index);
		if (field.kind === "text") return textValue(field, answer.text.text);
		return choiceValue(field, answer.checked, answer.otherChosen ? answer.other.text : undefined);
	}

	/** Whether field `index` holds an acceptable, non-empty answer. */
	answered(index: number): boolean {
		const value = this.value(index);
		if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return false;
		return fieldError(this.field(index), value) === undefined;
	}

	/**
	 * Why field `index`'s answer breaks the form's rules, shown as a warning; Submit sends it regardless.
	 * An empty required field is flagged only once the highlight has moved past it.
	 */
	error(index: number): string | undefined {
		if (!this.#reachable(index)) return undefined;
		const value = this.value(index);
		const active = this.active();
		if (isBlank(value) && active !== "submit" && active <= index) return undefined;
		return fieldError(this.field(index), value);
	}

	/** How many fields {@link error} flags, for the Submit row. */
	errorCount(): number {
		return this.fields.reduce((count, _, index) => (this.error(index) === undefined ? count : count + 1), 0);
	}

	/**
	 * What choice field `index` shows folded: its options as pills (a disabled one only while it is
	 * checked), its chosen Other answer, and the note on its answer (the first checked option's).
	 */
	foldChoice(index: number): { pills: AskPill[]; note: string | undefined } {
		const field = this.field(index);
		const answer = this.answer(index);
		if (field.kind !== "choice") return { pills: [], note: undefined };
		const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
		const pills: AskPill[] = field.options.flatMap((option, at) =>
			option.disabled && !answer.checked.has(at)
				? []
				: [
						{
							label: oneLine(spansText(option.label)) || option.value,
							chosen: answer.checked.has(at),
							act: `pick:${index}:${at}`,
						},
					],
		);
		const typed = oneLine(answer.other.text);
		if (field.other && answer.otherChosen && typed !== "")
			pills.push({ label: `Other: ${typed}`, chosen: true, act: `open:${index}` });
		const note = [...answer.checked].map(option => answer.notes.get(option)?.trim()).find(Boolean);
		return { pills, note: note === undefined ? undefined : oneLine(note) };
	}

	/** `2 of 5 answered`, for forms of two or more named questions the keyboard reaches. */
	progress(): string | undefined {
		const named = this.fields.flatMap((field, index) => (field.name && this.#reachable(index) ? [index] : []));
		if (named.length < 2) return undefined;
		return `${named.filter(index => this.answered(index)).length} of ${named.length} answered`;
	}

	#update(index: number, change: (answer: FieldAnswer) => FieldAnswer): void {
		const answers = [...untrack(this.answers)];
		answers[index] = change(answers[index]!);
		this.answers.set(answers);
	}

	/** Choose option `option` of a radio group or select; toggle it in a checkbox group. */
	pick(index: number, option: number): void {
		const field = this.field(index);
		if (field.kind !== "choice" || field.options[option]?.disabled) return;
		this.#update(index, answer => {
			if (field.multi) {
				const checked = new Set(answer.checked);
				if (checked.has(option)) checked.delete(option);
				else checked.add(option);
				return { ...answer, checked };
			}
			return { ...answer, checked: new Set([option]), otherChosen: false };
		});
	}

	/** Choose (radio) or check (checkbox) the free-text answer. */
	chooseOther(index: number): void {
		const field = this.field(index);
		if (field.kind !== "choice" || !field.other) return;
		this.#update(index, answer =>
			field.multi ? { ...answer, otherChosen: true } : { ...answer, checked: new Set(), otherChosen: true },
		);
	}

	#editOther(index: number, next: LineState): void {
		const field = this.field(index) as ChoiceField;
		this.#update(index, answer => {
			const typed = next.text.trim() !== "";
			if (field.multi) return { ...answer, other: next, otherChosen: typed || answer.otherChosen };
			return { ...answer, other: next, ...(typed ? { checked: new Set<number>(), otherChosen: true } : {}) };
		});
	}

	#editText(index: number, next: LineState): void {
		this.#update(index, answer => ({ ...answer, text: next }));
	}

	// ─── Navigation ─────────────────────────────────────────────────────────

	/** Rows of a choice field the highlight moves through: enabled options, then Other. */
	rows(index: number): number[] {
		const field = this.field(index);
		if (field.kind !== "choice") return [];
		const rows = field.options.flatMap((option, i) => (option.disabled ? [] : [i]));
		if (field.other && !isDropdown(field)) rows.push(OTHER_ROW);
		return rows;
	}

	/** Whether the keyboard can reach field `index`: a text field, or a choice with an enabled option or an Other answer. */
	#reachable(index: number): boolean {
		return this.field(index).kind === "text" || this.rows(index).length > 0;
	}

	/** The reachable field after (`1`) or before (`-1`) field `from`; undefined past either end. */
	#fieldFrom(from: number, delta: 1 | -1): number | undefined {
		for (let index = from + delta; index >= 0 && index < this.fields.length; index += delta)
			if (this.#reachable(index)) return index;
		return undefined;
	}

	/**
	 * Open field `index` with the highlight where its answer is (its checked option, its chosen Other,
	 * else its first row), or on its `first` or `last` row.
	 */
	#enter(index: number, at: "answer" | "first" | "last" = "answer"): void {
		const field = this.field(index);
		let row = 0;
		if (field.kind === "choice") {
			const rows = this.rows(index);
			const answer = untrack(() => this.answer(index));
			if (isDropdown(field)) row = [...answer.checked][0] ?? rows[0] ?? 0;
			else if (at === "first") row = rows[0]!;
			else if (at === "last") row = rows[rows.length - 1]!;
			else {
				const other = field.other && answer.other.text.trim() !== "" && (field.multi || answer.checked.size === 0);
				row = rows.find(option => answer.checked.has(option)) ?? (other ? OTHER_ROW : rows[0]!);
			}
		}
		batch(() => {
			this.active.set(index);
			this.row.set(row);
			this.dropdown.set(undefined);
		});
	}

	/** Open field `index` at its answer; nothing for a field the keyboard cannot reach. */
	open(index: number): void {
		if (index >= 0 && index < this.fields.length && this.#reachable(index)) this.#enter(index);
	}

	/** The next field at its answer, or the Submit row after the last. */
	next(): void {
		const active = untrack(this.active);
		if (active === "submit") return;
		const target = this.#fieldFrom(active, 1);
		if (target === undefined) this.active.set("submit");
		else this.#enter(target);
	}

	/** The previous field at its answer; on the first field, its own answer. */
	previous(): void {
		const active = untrack(this.active);
		const target = this.#fieldFrom(active === "submit" ? this.fields.length : active, -1);
		if (target !== undefined) this.#enter(target);
		else if (active !== "submit") this.#enter(active);
	}

	/** Enter on a field: the next field, or submit when the form asks only this one. */
	#advance(): void {
		if (this.sole) this.submit();
		else this.next();
	}

	/** Open the next (`1`) or previous (`-1`) question group at its first field's answer; past the last, Submit. */
	jumpQuestion(delta: 1 | -1): void {
		const groups = this.layout.groups;
		const active = untrack(this.active);
		const target =
			(active === "submit" ? groups.length : groups.findIndex(group => group.fields.includes(active))) + delta;
		if (target === groups.length) {
			this.active.set("submit");
			return;
		}
		const field = groups[target]?.fields.find(index => this.#reachable(index));
		if (field !== undefined) this.#enter(field);
	}

	/** The highlight moves a row: through the open field's rows, then onto the neighbouring field's nearest row. */
	#move(delta: 1 | -1): void {
		const active = untrack(this.active);
		if (active !== "submit" && !isDropdown(this.field(active))) {
			const rows = this.rows(active);
			const next = rows.indexOf(untrack(this.row)) + delta;
			if (next >= 0 && next < rows.length) {
				this.row.set(rows[next]!);
				return;
			}
		}
		const target = this.#fieldFrom(active === "submit" ? this.fields.length : active, delta);
		if (target !== undefined) this.#enter(target, delta < 0 ? "last" : "first");
		else if (delta > 0 && active !== "submit") this.active.set("submit");
	}

	// ─── Submit ─────────────────────────────────────────────────────────────

	/** Data the form submits now. */
	data(): HtmlFormData {
		const data: HtmlFormData = Object.create(null);
		for (const [name, value] of this.form.hidden) data[name] = value;
		this.fields.forEach((field, index) => {
			if (!field.name) return;
			const value = untrack(() => this.value(index));
			if (value !== undefined) data[field.name] = value;
		});
		return data;
	}

	/** Notes on checked options. */
	notes(): OptionNote[] {
		const out: OptionNote[] = [];
		this.fields.forEach((field, index) => {
			if (field.kind !== "choice") return;
			const answer = untrack(() => this.answer(index));
			for (const [option, text] of answer.notes) {
				if (!answer.checked.has(option)) continue;
				const images = answer.noteImages.get(option);
				out.push({
					name: field.name,
					question: untrack(() => this.question(index)),
					option: spansText(field.options[option]!.label),
					value: field.options[option]!.value,
					text,
					...(images?.length ? { images: [...images] } : {}),
				});
			}
		});
		return out;
	}

	/** Send the answers as entered, rule breaks included (they were flagged, never blocking). */
	submit(): void {
		if (this.#done) return;
		if (this.#pastes.length > 0) {
			this.#submitAfterPastes = true;
			return;
		}
		this.#callbacks.onSubmit(this.data(), this.notes());
	}

	cancel(): void {
		this.#submitAfterPastes = false;
		this.#callbacks.onCancel();
	}

	/** End the form with one of its {@link actions}, whatever the fields hold. */
	act(id: string): void {
		if (this.#done) return;
		this.#submitAfterPastes = false;
		this.#callbacks.onAction?.(id);
	}

	/** The action the Submit row's Enter presses, or undefined for Submit itself. */
	pressed(): HtmlFormAction | undefined {
		const button = this.button();
		return button > 0 ? this.actions[button - 1] : undefined;
	}

	timeout(): void {
		if (this.#done) return;
		this.#done = true;
		this.#callbacks.onTimeout?.(this.data(), this.notes());
	}

	// ─── Notes ──────────────────────────────────────────────────────────────

	/** Start a note for the highlighted option (of the open dropdown, or the choice list). */
	startNote(target?: number): void {
		const active = untrack(this.active);
		if (active === "submit") return;
		const field = this.field(active);
		const option = target ?? untrack(this.dropdown) ?? untrack(this.row);
		if (field.kind !== "choice" || field.options[option]?.disabled !== false) return;
		if (target !== undefined) {
			this.row.set(target);
			if (untrack(this.dropdown) !== undefined) this.dropdown.set(target);
		}
		const answer = untrack(() => this.answer(active));
		const text = answer.notes.get(option) ?? "";
		const images = answer.noteImages.get(option) ?? [];
		this.note.set({ field: active, option, line: { text, cursor: text.length }, images });
		// Each note opens in the start mode with its own undo, wherever the last one was left.
		this.#noteHistory?.clear();
		this.vim({ kind: "note" })?.begin();
	}

	/** Replace the open note's text (a history pick); false without an open note. */
	setNoteText(text: string): boolean {
		if (!untrack(this.note)) return false;
		this.#editBox({ kind: "note" }, { text, cursor: text.length });
		return true;
	}

	/** Attach `image` to the open note at its caret; false without an open note. */
	attachNoteImage(image: ImageContent, dims?: { readonly width: number; readonly height: number }): boolean {
		const note = untrack(this.note);
		if (!note) return false;
		const images = [...note.images, image];
		const marker = formatVisionMarker("image", images.length, dims);
		const { text, cursor } = note.line;
		this.note.set({ ...note, images });
		this.#editBox(
			{ kind: "note" },
			{ text: text.slice(0, cursor) + marker + text.slice(cursor), cursor: cursor + marker.length },
		);
		return true;
	}

	/** Save the note (blank removes it). */
	saveNote(): void {
		const note = untrack(this.note);
		if (!note) return;
		batch(() => {
			this.#update(note.field, answer => {
				const notes = new Map(answer.notes);
				const noteImages = new Map(answer.noteImages);
				const saved = compactNote(note.line.text, note.images);
				if (note.line.text.trim() === "") notes.delete(note.option);
				else notes.set(note.option, saved.text);
				if (note.line.text.trim() === "" || saved.images.length === 0) noteImages.delete(note.option);
				else noteImages.set(note.option, saved.images);
				return { ...answer, notes, noteImages };
			});
			this.note.set(undefined);
		});
	}

	/** Close the note editor, keeping the note as it was saved. */
	keepNote(): void {
		this.note.set(undefined);
	}

	// ─── Keys ───────────────────────────────────────────────────────────────

	key(key: KeyEvent): boolean {
		const step = this.#vimRowStep(key);
		const routed: KeyEvent = step ? { id: step, kind: key.kind, raw: key.raw } : key;
		const active = untrack(this.active);
		const first = active === 0 && untrack(this.row) === this.rows(0)[0];
		const id = listKeyId(routed);
		this.scrollAnchor.set(
			id === "up" && first ? "bottom" : id === "up" || id === "down" ? "top" : untrack(this.scrollAnchor),
		);
		return this.#key(routed);
	}

	/**
	 * `j`/`k` in Vim mode on a row that takes no typing (an option, Submit): `down`/`up`. A dropdown,
	 * closed or open, keeps its letter type-ahead; text boxes step on their own (Normal mode's `j`/`k`
	 * past the first or last line).
	 */
	#vimRowStep(key: KeyEvent): "down" | "up" | undefined {
		if (this.#vims.size === 0 || (key.id !== "j" && key.id !== "k")) return undefined;
		if (untrack(this.hidden) || untrack(this.note) || untrack(this.dropdown) !== undefined) return undefined;
		const active = untrack(this.active);
		if (active !== "submit") {
			const field = this.field(active);
			if (field.kind !== "choice" || isDropdown(field) || untrack(this.row) === OTHER_ROW) return undefined;
		}
		return key.id === "j" ? "down" : "up";
	}

	#key(key: KeyEvent): boolean {
		const id = listKeyId(key);
		const hidden = untrack(this.hidden);
		if (getKeybindings().matches(key, "app.ask.hide")) {
			if (!this.#native()) {
				// A hidden form shows no dropdown.
				batch(() => {
					this.hidden.set(!hidden);
					this.dropdown.set(undefined);
				});
			}
			return true;
		}
		if (!hidden) {
			if (getKeybindings().matches(key, "app.clipboard.pasteImage")) {
				this.#pasteKey();
				return true;
			}
			// A box in Vim mode takes Escape first: it leaves Insert or Visual mode, or drops a half-typed command.
			const box = this.#activeBox();
			const vim = box && this.vim(box);
			if (vim?.consumesEscape() && (key.id === "escape" || key.id === "ctrl+[")) {
				vim.handle(key);
				return true;
			}
			if (untrack(this.note)) return this.#noteKey(key);
			if (untrack(this.dropdown) !== undefined) return this.#dropdownKey(key);
		}
		// Esc hands the keys to the composer, where Esc interrupts the turn and so cancels the ask.
		if (matchesSelectCancel(key)) {
			this.#callbacks.releaseKeys?.();
			return true;
		}
		if (hidden) {
			if (getKeybindings().matches(key, "tui.select.confirm")) this.hidden.set(false);
			return true;
		}
		const active = untrack(this.active);
		if (id === "pageUp" || id === "pageDown") {
			this.jumpQuestion(id === "pageDown" ? 1 : -1);
			return true;
		}
		if (active === "submit") return this.#submitKey(key);
		const field = this.field(active);
		if (id === "tab") {
			this.next();
			return true;
		}
		if (id === "shift+tab") {
			this.previous();
			return true;
		}
		if (field.kind === "text") return this.#textKey(active, field, key);
		if (isDropdown(field)) return this.#selectKey(active, field, key);
		return this.#choiceKey(active, field, key);
	}

	#submitKey(key: KeyEvent): boolean {
		const id = listKeyId(key);
		if (this.actions.length > 0 && (id === "left" || id === "right")) {
			const buttons = this.actions.length + 1;
			this.button.set((untrack(this.button) + (id === "right" ? 1 : buttons - 1)) % buttons);
			return true;
		}
		switch (id) {
			case "enter": {
				const action = untrack(() => this.pressed());
				if (action) this.act(action.id);
				else this.submit();
				return true;
			}
			case "tab":
				this.#callbacks.releaseKeys?.();
				return true;
			case "shift+tab":
				this.previous();
				return true;
			case "up":
				this.#move(-1);
				return true;
			case "left":
				this.jumpQuestion(-1);
				return true;
		}
		return true;
	}

	#choiceKey(index: number, field: ChoiceField, key: KeyEvent): boolean {
		const id = listKeyId(key);
		const row = untrack(this.row);
		if (id === "up" || id === "down") {
			this.#move(id === "up" ? -1 : 1);
			return true;
		}
		const answer = untrack(() => this.answer(index));
		if (row === OTHER_ROW) {
			// The Other row is a text box: every other key types into it.
			if (getKeybindings().matches(key, "tui.select.confirm")) {
				// Back on Other after picking an option: Enter makes the kept text the answer again.
				if (!field.multi && answer.other.text.trim() !== "") this.chooseOther(index);
				this.#advance();
			} else this.#typeKey({ kind: "other", field: index }, key);
			return true;
		}
		switch (id) {
			case "left":
			case "right":
				this.jumpQuestion(id === "right" ? 1 : -1);
				return true;
			case "space":
				this.pick(index, row);
				return true;
			case "enter":
				// Enter picks a radio; on a checkbox group with nothing checked yet it checks the highlighted
				// box, so Enter alone never leaves the group empty.
				if (!field.multi || answer.checked.size === 0) this.pick(index, row);
				this.#advance();
				return true;
		}
		if (getKeybindings().matches(key, "app.ask.note")) this.startNote();
		return true;
	}

	#selectKey(index: number, field: ChoiceField, key: KeyEvent): boolean {
		const id = listKeyId(key);
		// Printable keys type ahead here; only a non-printable note key opens a note.
		if (!isPrintable(key) && getKeybindings().matches(key, "app.ask.note")) {
			this.startNote();
			return true;
		}
		const options = this.rows(index);
		const chosen = [...untrack(() => this.answer(index)).checked][0] ?? options[0]!;
		const at = options.indexOf(chosen);
		switch (id) {
			case "space":
				this.dropdown.set(chosen);
				return true;
			case "left":
			case "right": {
				const next = options[Math.max(0, Math.min(options.length - 1, at + (id === "left" ? -1 : 1)))]!;
				this.pick(index, next);
				this.row.set(next);
				return true;
			}
			case "up":
				this.#move(-1);
				return true;
			case "down":
				this.#move(1);
				return true;
			case "enter":
				this.#advance();
				return true;
		}
		// Type-ahead: the next option whose label starts with the letter.
		const typed = key.text?.toLowerCase();
		if (typed && typed.length === 1) {
			const order = [...options.slice(at + 1), ...options.slice(0, at + 1)];
			const match = order.find(i => spansText(field.options[i]!.label).toLowerCase().startsWith(typed));
			if (match !== undefined) {
				this.pick(index, match);
				this.row.set(match);
			}
		}
		return true;
	}

	#dropdownKey(key: KeyEvent): boolean {
		const id = listKeyId(key);
		// Printable keys type ahead here; only a non-printable note key opens a note.
		if (!isPrintable(key) && getKeybindings().matches(key, "app.ask.note")) {
			this.startNote();
			return true;
		}
		const active = untrack(this.active) as number;
		const options = this.rows(active);
		const at = options.indexOf(untrack(this.dropdown)!);
		const to = (i: number) => this.dropdown.set(options[Math.max(0, Math.min(options.length - 1, i))]);
		switch (id) {
			case "up":
				to(at - 1);
				return true;
			case "down":
				to(at + 1);
				return true;
			case "pageUp":
				to(0);
				return true;
			case "pageDown":
				to(options.length - 1);
				return true;
			case "enter": {
				const option = untrack(this.dropdown)!;
				batch(() => {
					this.pick(active, option);
					this.row.set(option);
					this.dropdown.set(undefined);
				});
				return true;
			}
			case "escape":
				this.dropdown.set(undefined);
				return true;
		}
		const typed = key.text?.toLowerCase();
		const field = this.field(active) as ChoiceField;
		if (typed && typed.length === 1) {
			const order = [...options.slice(at + 1), ...options.slice(0, at + 1)];
			const match = order.find(i => spansText(field.options[i]!.label).toLowerCase().startsWith(typed));
			if (match !== undefined) this.dropdown.set(match);
		}
		return true;
	}

	#textKey(index: number, field: TextField, key: KeyEvent): boolean {
		const id = listKeyId(key);
		const box: TextBox = { kind: "text", field: index };
		if (id === "up" || id === "down") {
			// A textarea's caret moves between its lines; from its first or last line the highlight moves on.
			const { text, cursor } = this.#line(box);
			const inside = (id === "up" ? text.slice(0, cursor) : text.slice(cursor)).includes("\n");
			if (field.multiline && inside) this.#setLine(box, lineStep({ text, cursor }, id === "up" ? -1 : 1));
			else this.#move(id === "up" ? -1 : 1);
			return true;
		}
		const keybindings = getKeybindings();
		if (field.multiline && keybindings.matches(key, "tui.input.newLine")) {
			const { text, cursor } = this.#line(box);
			if (!this.vim(box)?.handle(key))
				this.#editBox(box, { text: `${text.slice(0, cursor)}\n${text.slice(cursor)}`, cursor: cursor + 1 });
			return true;
		}
		if (keybindings.matches(key, "tui.input.submit")) this.#advance();
		else this.#typeKey(box, key);
		return true;
	}

	#noteKey(key: KeyEvent): boolean {
		if (getKeybindings().matches(key, "tui.input.submit")) {
			this.saveNote();
			return true;
		}
		if (matchesSelectCancel(key)) {
			this.keepNote();
			return true;
		}
		this.#typeKey({ kind: "note" }, key);
		return true;
	}

	/** A paste into the focused editor (text field, Other answer, note). */
	paste(text: string): void {
		// Text the host read for the paste key goes where that key was pressed.
		const reserved = this.#pastes.find(paste => paste.open);
		if (reserved) {
			reserved.open = false;
			if (text !== "") this.#pasteInto(reserved.target, text);
			return;
		}
		const note = untrack(this.note);
		if (note && this.#callbacks.onPasteImage) {
			// An empty paste is an image-only clipboard; a paste of image paths attaches them.
			if (text === "") return this.#callbacks.onPasteImage();
			const paths = extractImagePastePathsFromText(text);
			if (paths && this.#callbacks.onPasteImagePath) {
				for (const path of paths) this.#callbacks.onPasteImagePath(path);
				return;
			}
		}
		const target = this.#activeBox();
		if (target) this.#pasteInto(target, text);
	}

	/** The box taking keys and pastes: the open note, the open text field, or the highlighted Other answer. */
	#activeBox(): TextBox | undefined {
		if (untrack(this.hidden)) return undefined;
		if (untrack(this.note)) return { kind: "note" };
		const active = untrack(this.active);
		if (active === "submit") return undefined;
		const field = this.field(active);
		if (field.kind === "text") return { kind: "text", field: active };
		if (!isDropdown(field) && untrack(this.dropdown) === undefined && untrack(this.row) === OTHER_ROW)
			return { kind: "other", field: active };
		return undefined;
	}

	#pasteInto(target: TextBox, text: string): void {
		if (target.kind === "note" && !untrack(this.note)) return;
		const field = target.kind === "note" ? undefined : this.field(target.field);
		// Only a textarea keeps line breaks.
		const flat =
			field?.kind === "text" && field.multiline ? text.replace(/\r\n?/g, "\n") : text.replace(/\r?\n/g, " ");
		const line = this.#line(target);
		this.#editBox(target, {
			text: line.text.slice(0, line.cursor) + flat + line.text.slice(line.cursor),
			cursor: line.cursor + flat.length,
		});
	}

	/**
	 * The paste key: a note that takes images reads the clipboard through the host's image paste;
	 * any other text box asks the host for the clipboard's text, reserving the box until it arrives.
	 */
	#pasteKey(): void {
		const pasteImage = this.#callbacks.onPasteImage;
		if (untrack(this.note) && pasteImage) return pasteImage();
		const target = this.#activeBox();
		const read = this.#callbacks.onPasteClipboard;
		if (!target || !read) return;
		const reservation: PasteReservation = { target, open: true };
		this.#pastes.push(reservation);
		read().then(
			pasted => this.#settlePaste(reservation, pasted),
			() => this.#settlePaste(reservation, false),
		);
	}

	/** A clipboard read ended: a submit held behind it goes ahead once the last one lands, or is dropped when one failed. */
	#settlePaste(reservation: PasteReservation, pasted: boolean): void {
		const at = this.#pastes.indexOf(reservation);
		if (at !== -1) this.#pastes.splice(at, 1);
		const delivered = pasted && !reservation.open;
		reservation.open = false;
		if (!delivered) this.#submitAfterPastes = false;
		if (this.#pastes.length === 0 && this.#submitAfterPastes) {
			this.#submitAfterPastes = false;
			this.submit();
		}
	}

	// ─── Pointer / native events ────────────────────────────────────────────

	/** A UI action (`open:<field>`, `pick:<field>:<option>`, `note`, `save-note`, `submit`, `cancel`). */
	action(act: string, key: string): void {
		this.#callbacks.claimKeys?.();
		if (untrack(this.note)) {
			if (act === "save-note") this.saveNote();
			else if (act === "cancel") this.keepNote();
			return;
		}
		const open = /^open:(\d+)$/.exec(act);
		if (open) return this.open(Number(open[1]));
		const pick = /^pick:(\d+):(\d+)$/.exec(act);
		if (pick) return this.pick(Number(pick[1]), Number(pick[2]));
		if (act.startsWith(ACTION_ACT)) return this.act(act.slice(ACTION_ACT.length));
		switch (act) {
			case "note": {
				const row = /(?:^|\/)f(\d+)\/o(\d+)$/.exec(key);
				if (row && untrack(this.active) === Number(row[1])) this.startNote(Number(row[2]));
				else if (key.split("/").at(-1) === "note") this.startNote();
				return;
			}
			case "submit":
				return this.submit();
			case "cancel":
				return this.cancel();
		}
	}

	/** A checkbox toggles on select only, not again on the following activation. */
	select(field: number, item: string, activate: boolean): void {
		this.#callbacks.claimKeys?.();
		const target = this.fields[field];
		if (target?.kind !== "choice" || untrack(this.note)) return;
		const option = /^o(\d+)$/.exec(item);
		const index = option ? Number(option[1]) : OTHER_ROW;
		if (index === OTHER_ROW ? item !== "other" || !target.other : target.options[index]?.disabled !== false) return;
		batch(() => {
			if (untrack(this.active) !== field) this.open(field);
			this.row.set(index);
			if (index === OTHER_ROW) {
				if (!target.multi) this.chooseOther(field);
			} else if (!target.multi || !activate) this.pick(field, index);
		});
	}
}
