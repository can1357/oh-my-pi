/**
 * Answers of a parsed {@link HtmlForm}: the data shape a submission reports,
 * the defaults a form opens with, and a readable question/answer listing for
 * transcripts and non-interactive hosts.
 *
 * @example
 * const form = parseHtmlForm(html);
 * const data = defaultFormData(form);   // { db: "sqlite", notes: "" }
 * formAnswers(form, data);              // [{ name: "db", question: "Database", answer: "SQLite" }, …]
 */
import { type ChoiceField, type FormField, type HtmlForm, spansText, type TextField } from "./parse";

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
	text: string;
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
	const data: HtmlFormData = {};
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
				questions.set(field, oneLine(own || caption || title || lone || field.name));
				caption = "";
				continue;
			}
			caption = block.kind === "text" ? spansText(block.spans) : "";
		}
	}
	return questions;
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
		if (option) return oneLine(spansText(option.label)) || raw;
		return field.other ? `${OTHER_LABEL}: ${raw}` : raw;
	};
	return Array.isArray(value) ? value.map(labelOf).join(", ") : labelOf(String(value));
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
