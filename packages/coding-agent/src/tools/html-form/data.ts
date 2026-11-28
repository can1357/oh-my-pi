import type { ImageContent } from "@oh-my-pi/pi-ai";
import { flattenLine } from "@oh-my-pi/pi-tui/text/sanitize";
import {
	type ChoiceField,
	type ChoiceOption,
	type FormBlock,
	type FormField,
	type HtmlForm,
	spansText,
	type TextField,
} from "./parse";

/** Submitted value of one control: text, a number for `number`/`range` inputs, or a group's checked values. */
export type HtmlFormValue = string | number | string[];

/**
 * Submitted form data by control `name`. Radios, single checkboxes and single
 * selects give their value (omitted when nothing is chosen); checkbox groups
 * and multi-selects give an array; text fields always give their text.
 * Disabled options, unnamed controls and buttons never appear; hidden inputs do.
 */
export type HtmlFormData = Record<string, HtmlFormValue>;

/** One field as a question and its answer, both plain text. */
export interface FormAnswer {
	name: string;
	question: string;
	answer: string;
}

/** A note attached to one checked choice option, separate from submitted values. */
export interface OptionNote {
	name: string;
	question: string;
	/** The option's shown label. */
	option: string;
	/** The option's submitted value, as it appears in the form data. */
	value: string;
	/**
	 * In a form-dialog result, `[Image #N, WxH]` markers are numbered 1..K in order of appearance within this
	 * note; `images[N-1]` is marker N's image.
	 */
	text: string;
	/** Pasted images of the note; present only when non-empty. */
	images?: ImageContent[];
}

/** One reason submitted data is not an answer of the form: the field (or unknown key) and why. */
export interface FormDataError {
	name: string;
	message: string;
}

/** An option's plain label, as the dialog reports it, without terminal control bytes. */
export function optionText(option: ChoiceOption): string {
	return (
		spansText(option.label)
			.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
			.replace(/\s+/g, " ")
			.trim() || option.value
	);
}

/**
 * `data` and `notes` as the form's dialog would submit them, or why it never would.
 *
 * `data` is the whole answer, not a change to the form's defaults: a named field left out is
 * unanswered (a text field blank, a group empty, a single choice not chosen), so a caller can
 * leave a preselected option unanswered. Start from {@link defaultFormData} to keep what the
 * form prefills and preselects.
 */
export function formSubmission(
	form: HtmlForm,
	data: HtmlFormData,
	notes: readonly OptionNote[] = [],
): { data: HtmlFormData; notes: OptionNote[] } | { errors: FormDataError[] } {
	const errors: FormDataError[] = [];
	const fields = new Map(form.fields.filter(field => field.name).map(field => [field.name, field]));
	const hidden = new Map(form.hidden);
	const normalized: HtmlFormData = Object.create(null);
	for (const name of Object.keys(data)) {
		if (!fields.has(name) && !hidden.has(name)) errors.push({ name, message: "Unknown field" });
	}
	for (const [name, value] of hidden) {
		normalized[name] = value;
		if (Object.hasOwn(data, name) && data[name] !== value) {
			errors.push({ name, message: "Hidden input cannot be changed" });
		}
	}
	for (const field of form.fields) {
		const name = field.name;
		if (!name) continue;
		const raw = Object.hasOwn(data, name) ? data[name] : undefined;
		let value: HtmlFormValue | undefined;
		if (field.kind === "text") {
			if (raw === undefined) value = "";
			else if (
				typeof raw === "string" ||
				(typeof raw === "number" && (field.type === "number" || field.type === "range"))
			) {
				value = textValue(field, String(raw));
			} else errors.push({ name, message: "Expected text" });
		} else {
			const array = isArrayChoice(field);
			if (raw === undefined) value = array ? [] : undefined;
			else if (array ? !Array.isArray(raw) : typeof raw !== "string") {
				errors.push({ name, message: array ? "Expected an array of distinct strings" : "Expected one string" });
			} else {
				const values = Array.isArray(raw) ? raw : [raw];
				const seen = new Set<string>();
				const checked = new Set<number>();
				let other: string | undefined;
				for (const item of values) {
					if (typeof item !== "string" || seen.has(item)) {
						errors.push({ name, message: "Expected distinct strings" });
						continue;
					}
					seen.add(item);
					const index = field.options.findIndex(option => option.value === item && !option.disabled);
					if (index >= 0) {
						checked.add(index);
					} else if (
						field.other &&
						item.trim() &&
						!field.options.some(option => option.value === item || option.value === item.trim())
					) {
						if (other !== undefined) errors.push({ name, message: "Only one Other answer is allowed" });
						else other = item;
					} else errors.push({ name, message: `Unavailable option: ${item}` });
				}
				value = choiceValue(field, checked, other);
			}
		}
		if (value !== undefined) normalized[name] = value;
		const message = fieldError(field, value);
		if (message) errors.push({ name, message });
	}
	const questions = fieldQuestions(form);
	const selected: OptionNote[] = [];
	const noted = new Map<string, Set<string>>();
	for (const note of notes) {
		const field = fields.get(note.name);
		const name = note.name;
		const text = typeof note.text === "string" ? note.text.trim() : "";
		if (!text) errors.push({ name, message: "Note text is required" });
		if (field?.kind !== "choice") {
			errors.push({ name, message: "Notes need a choice field" });
			continue;
		}
		const options = field.options.filter(option => option.value === note.value && !option.disabled);
		// Equal-valued options still have distinct labels in the dialog's notes.
		const option = options.find(option => optionText(option) === note.option) ?? options[0];
		const value = normalized[name];
		if (!option || !(Array.isArray(value) ? value.includes(note.value) : value === note.value)) {
			errors.push({ name, message: "Note option must be enabled and checked" });
			continue;
		}
		let values = noted.get(name);
		if (!values) noted.set(name, (values = new Set()));
		if (values.has(note.value)) errors.push({ name, message: "Only one note per option is allowed" });
		values.add(note.value);
		selected.push({
			name,
			question: questions.get(field) ?? name,
			option: optionText(option),
			value: note.value,
			text,
			...(note.images?.length ? { images: [...note.images] } : {}),
		});
	}
	return errors.length ? { errors } : { data: normalized, notes: selected };
}

/** Label of the free-text answer the UI adds to radio and checkbox groups ({@link ChoiceField.other}). */
export const OTHER_LABEL = "Other";

/** Whether a choice field reports an array (checkbox group, multi-select) rather than one value. */
export function isArrayChoice(field: ChoiceField): boolean {
	return field.multi && field.options.length > 1;
}

/**
 * Value a choice field contributes given its checked option indices and, when
 * the user chose its "Other" answer, that answer's text: the typed text stands
 * in for a radio's value, or joins a checkbox group's array. Undefined when the
 * field contributes nothing; blank Other text counts as no answer.
 */
export function choiceValue(
	field: ChoiceField,
	checked: ReadonlySet<number>,
	other?: string,
): HtmlFormValue | undefined {
	const typed = field.other ? other?.trim() : undefined;
	const values = field.options.flatMap((option, index) =>
		checked.has(index) && !option.disabled ? [option.value] : [],
	);
	if (isArrayChoice(field)) return typed ? [...values, typed] : values;
	return typed || values[0];
}

/** Value a text field contributes: a number for non-empty numeric `number`/`range` inputs, else the text. */
export function textValue(field: TextField, text: string): HtmlFormValue {
	if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
		const number = Number(text);
		if (Number.isFinite(number)) return number;
	}
	return text;
}

/**
 * Why `value` is not an acceptable answer for `field`, or undefined when it is.
 * Enforces `required`, numeric `min`/`max`, `minlength`/`maxlength`, `email`
 * and `url` shapes, and `pattern` (anchored, as HTML does; an invalid pattern
 * is ignored).
 */
export function fieldError(field: FormField, value: HtmlFormValue | undefined): string | undefined {
	if (field.kind === "choice") {
		const empty = value === undefined || (Array.isArray(value) && value.length === 0);
		if (!field.required || !empty) return undefined;
		return isArrayChoice(field) ? "Select at least one" : "Required";
	}
	const text = value === undefined ? "" : String(value);
	if (text.trim() === "") return field.required ? "Required" : undefined;
	if (field.type === "number" || field.type === "range") {
		const number = Number(text);
		if (!Number.isFinite(number)) return "Enter a number";
		if (field.min !== undefined && number < field.min) return `Must be at least ${field.min}`;
		if (field.max !== undefined && number > field.max) return `Must be at most ${field.max}`;
	}
	if (field.minLength !== undefined && text.length < field.minLength)
		return `Needs at least ${field.minLength} characters`;
	if (field.maxLength !== undefined && text.length > field.maxLength) return `At most ${field.maxLength} characters`;
	if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
	if (field.type === "url" && !URL.canParse(text)) return "Enter a full URL";
	if (field.pattern && compilePattern(field.pattern)?.test(text) === false) {
		return `Must match ${field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern}`;
	}
	return undefined;
}

/** `^(?:pattern)$` as HTML matches `pattern`, or undefined when the model wrote an invalid one. */
function compilePattern(pattern: string): RegExp | undefined {
	try {
		return new RegExp(`^(?:${pattern})$`, "v");
	} catch {
		return undefined;
	}
}

/** Data the form submits untouched: hidden inputs, preselected options and prefilled text. */
export function defaultFormData(form: HtmlForm): HtmlFormData {
	// A null prototype keeps a control named `__proto__` an ordinary key instead of hitting the inherited setter.
	const data: HtmlFormData = Object.create(null);
	for (const [name, value] of form.hidden) data[name] = value;
	for (const field of form.fields) {
		if (!field.name) continue;
		const value =
			field.kind === "text"
				? textValue(field, field.value)
				: choiceValue(field, new Set(field.options.flatMap((option, index) => (option.checked ? [index] : []))));
		if (value !== undefined) data[field.name] = value;
	}
	return data;
}

/**
 * The question each field answers: its own label, else the text block right
 * before it (`<p>Which database?</p>` above a radio group), else its section
 * title, else a lone option's label (a single checkbox), else its name.
 */
export function fieldQuestions(form: HtmlForm): Map<FormField, string> {
	const questions = new Map<FormField, string>();
	for (const section of form.sections) {
		const title = spansText(section.title);
		let caption = "";
		for (const block of section.blocks) {
			if (block.kind === "field") {
				const field = block.field;
				const own = spansText(field.label);
				const lone =
					field.kind === "choice" && field.options.length === 1 ? spansText(field.options[0]!.label) : "";
				questions.set(field, flattenLine(own || caption || title || lone || field.name));
				caption = "";
				continue;
			}
			caption = block.kind === "text" ? spansText(block.spans) : "";
		}
	}
	return questions;
}

/**
 * Plain text of a context block (paragraph or heading, list, preformatted
 * text, table) for hosts that cannot draw the form; undefined for fields and
 * pictures.
 */
export function blockText(block: FormBlock): string | undefined {
	switch (block.kind) {
		case "text":
			return spansText(block.spans);
		case "pre":
			return block.text;
		case "list":
			return block.items
				.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${spansText(item)}`)
				.join("\n");
		case "table":
			return block.rows.map(cells => cells.map(cell => spansText(cell)).join(" | ")).join("\n");
		default:
			return undefined;
	}
}

/**
 * The form's section titles and context blocks as plain text, in order, for a
 * host that shows the whole form with each named field titled by its question
 * ({@link fieldQuestions}): text that already is such a question is left out,
 * so it shows once. Blank parts are dropped.
 */
export function formContext(form: HtmlForm): string[] {
	const questions = new Set<string>();
	for (const [field, question] of fieldQuestions(form)) if (field.name) questions.add(question);
	const parts: string[] = [];
	for (const section of form.sections) {
		for (const text of [spansText(section.title).trim(), ...section.blocks.map(blockText)]) {
			if (text?.trim() && !questions.has(flattenLine(text))) parts.push(text);
		}
	}
	return parts;
}

/**
 * The form text each named field's prompt carries when a host asks the form
 * one field at a time: section titles and context blocks since the previous
 * named field, text between the field's own options (unless another named
 * field sits among them), and, for the last field, the text after it. Text
 * that already is the field's question ({@link fieldQuestions}) is left out.
 * Parts are separated by blank lines; a field without context maps to `""`.
 */
export function fieldContexts(form: HtmlForm): Map<FormField, string> {
	const questions = fieldQuestions(form);
	const parts = new Map<FormField, string[]>();
	let pending: string[] = [];
	let last: string[] | undefined;
	for (const section of form.sections) {
		const title = spansText(section.title).trim();
		if (title) pending.push(title);
		// A radio/checkbox group with text between its options keeps that text until `ownerEnd`, unless a named
		// field sits among those options: the text then stays with the field it precedes.
		let owner: string[] | undefined;
		let ownerEnd = 0;
		for (const [index, block] of section.blocks.entries()) {
			if (block.kind === "field") {
				if (!block.field.name) continue;
				const question = questions.get(block.field);
				const own = pending.filter(part => flattenLine(part) !== question);
				parts.set(block.field, own);
				pending = [];
				last = own;
				owner = own;
				const end = block.optionsEnd ?? 0;
				const intervening = section.blocks.some(
					(later, at) => at > index && at < end && later.kind === "field" && later.field.name,
				);
				ownerEnd = intervening ? 0 : end;
				continue;
			}
			const text = blockText(block);
			if (!text?.trim()) continue;
			if (owner && index < ownerEnd) owner.push(text);
			else pending.push(text);
		}
	}
	last?.push(...pending);
	const contexts = new Map<FormField, string>();
	for (const [field, own] of parts) contexts.set(field, own.join("\n\n"));
	return contexts;
}

/** Answers of every named field, in form order, with option values shown as their labels. */
export function formAnswers(form: HtmlForm, data: HtmlFormData): FormAnswer[] {
	const questions = fieldQuestions(form);
	const answers: FormAnswer[] = [];
	for (const field of form.fields) {
		if (!field.name) continue;
		const value = data[field.name];
		answers.push({
			name: field.name,
			question: questions.get(field) ?? field.name,
			answer: answerText(field, value),
		});
	}
	return answers;
}

function answerText(field: FormField, value: HtmlFormValue | undefined): string {
	if (value === undefined) return "";
	if (field.kind === "text") return String(value);
	const labelOf = (raw: string): string => {
		const option = field.options.find(candidate => candidate.value === raw);
		if (option) return flattenLine(spansText(option.label)) || raw;
		return field.other ? `${OTHER_LABEL}: ${raw}` : raw;
	};
	return Array.isArray(value) ? value.map(labelOf).join(", ") : labelOf(String(value));
}
