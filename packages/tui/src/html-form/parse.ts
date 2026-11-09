/**
 * Reduces an agent-written HTML `<form>` to what a terminal form draws.
 *
 * The model is deliberately small: titled sections (one per top-level
 * `<fieldset>`, plus untitled runs of loose content between them), context
 * blocks (paragraphs, headings, lists, preformatted text, tables) and fields.
 * Radios and checkboxes join one {@link ChoiceField} per `type` + `name`
 * wherever they appear, so a group split across table cells or list items is
 * still one question. Layout-only markup (`<br>` between labels, wrapper
 * `<div>`s, `style`, buttons) is dropped: the renderer owns layout, and the
 * UI owns Submit/Cancel.
 *
 * @example
 * const form = parseHtmlForm(`<form><fieldset><legend>Database</legend>
 *   <label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
 *   <label><input type="radio" name="db" value="pg"> Postgres</label>
 * </fieldset></form>`);
 * form.sections[0].title; // [{ text: "Database" }]
 * form.fields[0];         // { kind: "choice", name: "db", multi: false, options: [sqlite ✓, pg] }
 */
import { Comment, type Document, Element, type Node, parseHTML, Text } from "@oh-my-pi/pi-utils/dom";

/** Inline emphasis a span keeps from `<code>`, `<strong>`/`<b>` and `<em>`/`<i>`. */
export type FormSpanStyle = "code" | "strong" | "em";

/** A run of inline text; `"\n"` inside `text` is a hard line break (`<br>`). */
export interface FormSpan {
	text: string;
	style?: FormSpanStyle;
}

/** One answer of a {@link ChoiceField}. */
export interface ChoiceOption {
	value: string;
	label: FormSpan[];
	checked: boolean;
	disabled: boolean;
}

/** A radio group (`multi: false`), checkbox group (`multi: true`) or `<select>` (`select: true`). */
export interface ChoiceField {
	kind: "choice";
	name: string;
	multi: boolean;
	/** From a `<select>`: a single select draws as a one-row dropdown instead of option rows. */
	select: boolean;
	/**
	 * The UI adds a free-text "Other" answer: set for radio and checkbox groups of
	 * two or more options that don't already offer one of their own.
	 */
	other: boolean;
	/** The control's own label; empty for radio/checkbox groups, whose question is the surrounding text. */
	label: FormSpan[];
	options: ChoiceOption[];
	required: boolean;
}

/** A single-line `<input>` (`multiline: false`) or a `<textarea>`. */
export interface TextField {
	kind: "text";
	name: string;
	/** The `<input type>` (`text`, `number`, `url`, …); `textarea` for textareas. */
	type: string;
	multiline: boolean;
	label: FormSpan[];
	value: string;
	placeholder: string;
	required: boolean;
	min?: number;
	max?: number;
	pattern?: string;
	minLength?: number;
	maxLength?: number;
	/** Visible rows a textarea asked for (`rows`), 1 for inputs. */
	rows: number;
}

/** Any control the user answers. */
export type FormField = ChoiceField | TextField;

/** A renderable unit of a section, in document order. */
export type FormBlock =
	| { kind: "text"; spans: FormSpan[]; heading: boolean }
	| { kind: "list"; items: FormSpan[][]; ordered: boolean }
	| { kind: "pre"; text: string }
	| { kind: "table"; rows: FormSpan[][][]; headerRows: number }
	/** An `<img>`: `src` is an http(s) or `data:` URL, a `file:` URL or a local path (see `media.ts`). */
	| { kind: "image"; src: string; alt: string }
	/** An inline `<svg>`, serialized whole. */
	| { kind: "svg"; markup: string; alt: string }
	| { kind: "field"; field: FormField };

/** A `<fieldset>` (titled by its `<legend>`) or loose content between fieldsets (untitled). */
export interface FormSection {
	title: FormSpan[];
	blocks: FormBlock[];
}

/** A parsed form: what to draw, the fields in document order, and `<input type="hidden">` pairs. */
export interface HtmlForm {
	sections: FormSection[];
	fields: FormField[];
	hidden: [name: string, value: string][];
}

const SKIPPED: Record<string, true> = {
	button: true,
	head: true,
	iframe: true,
	link: true,
	meta: true,
	noscript: true,
	script: true,
	style: true,
	template: true,
	title: true,
};

const BLOCK: Record<string, true> = {
	address: true,
	article: true,
	aside: true,
	blockquote: true,
	dd: true,
	details: true,
	div: true,
	dl: true,
	dt: true,
	figure: true,
	figcaption: true,
	footer: true,
	header: true,
	li: true,
	main: true,
	nav: true,
	p: true,
	section: true,
};

const HEADING: Record<string, true> = { h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, summary: true };

const STYLE_OF: Record<string, FormSpanStyle> = {
	b: "strong",
	code: "code",
	em: "em",
	i: "em",
	kbd: "code",
	samp: "code",
	strong: "strong",
	tt: "code",
};

const IGNORED_INPUTS: Record<string, true> = { button: true, file: true, image: true, reset: true, submit: true };

const CONTROL_SELECTOR = "input, select, textarea";

/** Parse agent-written form HTML; content outside the first `<form>` is ignored when one exists. */
export function parseHtmlForm(html: string): HtmlForm {
	const document = parseHTML(html).document;
	return new FormBuilder(document.querySelector("form") ?? document).build();
}

/** Append `text` to `spans`, merging into the previous span when the style matches. */
function appendSpan(spans: FormSpan[], text: string, style: FormSpanStyle | undefined): void {
	if (!text) return;
	const last = spans[spans.length - 1];
	if (last && last.style === style) last.text += text;
	else spans.push(style ? { text, style } : { text });
}

/**
 * Collapse whitespace like HTML layout does: runs become one space, spaces
 * next to a hard break vanish, and the ends are trimmed. Empty spans drop.
 */
function normalizeSpans(spans: FormSpan[]): FormSpan[] {
	const out: FormSpan[] = [];
	for (const span of spans) {
		const text = span.text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n");
		appendSpan(out, text, span.style);
	}
	const first = out[0];
	if (first) first.text = first.text.replace(/^\s+/, "");
	const last = out[out.length - 1];
	if (last) last.text = last.text.replace(/\s+$/, "");
	return out.filter(span => span.text !== "");
}

/** Plain text of spans, for labels that fall back to a single string. */
export function spansText(spans: readonly FormSpan[]): string {
	return spans.map(span => span.text).join("");
}

/** An inline svg's accessible name: its `aria-label`, else its `<title>`. */
function svgTitle(svg: Element): string {
	const label = svg.getAttribute("aria-label");
	if (label) return label.trim();
	const title = svg.children.find(child => child.localName === "title");
	return (title?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function numberAttr(element: Element, name: string): number | undefined {
	const raw = element.getAttribute(name);
	if (raw === null || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

class FormBuilder {
	readonly #root: Document | Element;
	readonly #sections: FormSection[] = [];
	readonly #fields: FormField[] = [];
	readonly #hidden: [string, string][] = [];
	/** Radio/checkbox groups by `type\0name`. */
	readonly #groups = new Map<string, ChoiceField>();
	/** `<label for>` elements by the id of the control they name. */
	readonly #labelFor = new Map<string, Element>();
	#section: FormSection = { title: [], blocks: [] };
	#inline: FormSpan[] = [];
	#fieldsetDepth = 0;

	constructor(root: Document | Element) {
		this.#root = root;
		this.#sections.push(this.#section);
	}

	build(): HtmlForm {
		const ids = new Set<string>();
		for (const control of this.#root.querySelectorAll(CONTROL_SELECTOR)) {
			if (control.id) ids.add(control.id);
		}
		for (const label of this.#root.querySelectorAll("label")) {
			const target = label.getAttribute("for");
			if (target && ids.has(target) && !this.#labelFor.has(target)) this.#labelFor.set(target, label);
		}
		this.#children(this.#root, undefined);
		this.#flush(false);
		for (const field of this.#fields) {
			if (field.kind !== "choice" || field.select || field.options.length < 2) continue;
			field.other = !field.options.some(option => /^\s*other\b/i.test(spansText(option.label)));
		}
		return {
			sections: this.#sections.filter(section => section.blocks.length > 0 || section.title.length > 0),
			fields: this.#fields,
			hidden: this.#hidden,
		};
	}

	#children(node: Node, style: FormSpanStyle | undefined): void {
		for (const child of node.childNodes) this.#walk(child, style);
	}

	#walk(node: Node, style: FormSpanStyle | undefined): void {
		if (node instanceof Comment) return;
		if (node instanceof Text) {
			appendSpan(this.#inline, node.data, style);
			return;
		}
		if (!(node instanceof Element)) return;
		const tag = node.localName;
		if (SKIPPED[tag]) return;
		switch (tag) {
			case "br":
				appendSpan(this.#inline, "\n", undefined);
				return;
			case "hr":
				this.#flush(false);
				return;
			case "input":
			case "select":
			case "textarea":
				this.#control(node, undefined);
				return;
			case "label":
				this.#label(node, style);
				return;
			case "fieldset":
				this.#fieldset(node);
				return;
			case "legend":
				this.#flush(false);
				this.#children(node, style);
				this.#flush(true);
				return;
			case "ul":
			case "ol":
				this.#list(node, tag === "ol");
				return;
			case "pre":
				this.#flush(false);
				this.#section.blocks.push({ kind: "pre", text: (node.textContent ?? "").replace(/^\n/, "").trimEnd() });
				return;
			case "table":
				this.#table(node);
				return;
			case "img": {
				const src = node.getAttribute("src")?.trim();
				if (!src) return;
				this.#flush(false);
				this.#section.blocks.push({ kind: "image", src, alt: (node.getAttribute("alt") ?? "").trim() });
				return;
			}
			case "svg":
				this.#flush(false);
				this.#section.blocks.push({ kind: "svg", markup: node.outerHTML, alt: svgTitle(node) });
				return;
		}
		if (HEADING[tag]) {
			this.#flush(false);
			this.#children(node, style);
			this.#flush(true);
			return;
		}
		if (BLOCK[tag]) {
			this.#flush(false);
			this.#children(node, style);
			this.#flush(false);
			return;
		}
		this.#children(node, STYLE_OF[tag] ?? style);
	}

	/** Emit buffered inline content as a text block. */
	#flush(heading: boolean): void {
		const spans = normalizeSpans(this.#inline);
		this.#inline = [];
		if (spans.length > 0) this.#section.blocks.push({ kind: "text", spans, heading });
	}

	/** Inline spans of `element`, skipping controls (their label is the text around them). */
	#spansOf(element: Element): FormSpan[] {
		const spans: FormSpan[] = [];
		const visit = (node: Node, style: FormSpanStyle | undefined): void => {
			if (node instanceof Comment) return;
			if (node instanceof Text) {
				appendSpan(spans, node.data, style);
				return;
			}
			if (!(node instanceof Element)) return;
			const tag = node.localName;
			if (SKIPPED[tag] || tag === "input" || tag === "select" || tag === "textarea" || tag === "svg") return;
			if (tag === "br") {
				appendSpan(spans, "\n", undefined);
				return;
			}
			// Labels stay text: a picture inside one reads as its alt text.
			if (tag === "img") {
				appendSpan(spans, node.getAttribute("alt") ?? "", style);
				return;
			}
			if (BLOCK[tag] || HEADING[tag]) appendSpan(spans, " ", undefined);
			for (const child of node.childNodes) visit(child, STYLE_OF[tag] ?? style);
		};
		for (const child of element.childNodes) visit(child, undefined);
		return normalizeSpans(spans);
	}

	#label(label: Element, style: FormSpanStyle | undefined): void {
		const target = label.getAttribute("for");
		if (target && this.#labelFor.get(target) === label) return;
		const controls = label.querySelectorAll(CONTROL_SELECTOR);
		if (controls.length === 0) {
			this.#children(label, style);
			return;
		}
		this.#flush(false);
		const spans = this.#spansOf(label);
		for (const control of controls) this.#control(control, spans);
	}

	#fieldset(fieldset: Element): void {
		this.#flush(false);
		const legend = fieldset.children.find(child => child.localName === "legend");
		if (this.#fieldsetDepth > 0) {
			// Nested fieldsets stay in the outer section; their legend becomes a heading.
			if (legend) this.#walk(legend, undefined);
		} else {
			this.#startSection(legend ? this.#spansOf(legend) : []);
		}
		this.#fieldsetDepth++;
		for (const child of fieldset.childNodes) {
			if (child !== legend) this.#walk(child, undefined);
		}
		this.#flush(false);
		this.#fieldsetDepth--;
		if (this.#fieldsetDepth === 0) this.#startSection([]);
	}

	#startSection(title: FormSpan[]): void {
		if (this.#section.blocks.length === 0 && this.#section.title.length === 0) {
			this.#section.title = title;
			return;
		}
		this.#section = { title, blocks: [] };
		this.#sections.push(this.#section);
	}

	#list(list: Element, ordered: boolean): void {
		this.#flush(false);
		if (list.querySelector(CONTROL_SELECTOR)) {
			// A list of controls is layout, not content: walk it as flow.
			this.#children(list, undefined);
			this.#flush(false);
			return;
		}
		const items = list.children
			.filter(child => child.localName === "li")
			.map(item => this.#spansOf(item))
			.filter(spans => spans.length > 0);
		if (items.length > 0) this.#section.blocks.push({ kind: "list", items, ordered });
	}

	#table(table: Element): void {
		this.#flush(false);
		const rows = table.querySelectorAll("tr").filter(row => row.closest("table") === table);
		const cellsOf = (row: Element) => row.children.filter(cell => cell.localName === "td" || cell.localName === "th");
		if (!table.querySelector(CONTROL_SELECTOR)) {
			const cells = rows.map(row => cellsOf(row).map(cell => this.#spansOf(cell)));
			let headerRows = 0;
			while (
				headerRows < rows.length &&
				(rows[headerRows]!.closest("thead") !== null ||
					cellsOf(rows[headerRows]!).every(cell => cell.localName === "th"))
			) {
				headerRows++;
			}
			if (cells.some(row => row.length > 0)) this.#section.blocks.push({ kind: "table", rows: cells, headerRows });
			return;
		}
		// A table of controls (a decision matrix): each row's text becomes a line and each
		// unlabeled control borrows its column header as its label.
		let header: FormSpan[][] = [];
		for (const row of rows) {
			const cells = cellsOf(row);
			if (cells.every(cell => cell.localName === "th") && !row.querySelector(CONTROL_SELECTOR)) {
				header = cells.map(cell => this.#spansOf(cell));
				continue;
			}
			const text: FormSpan[] = [];
			for (const cell of cells) {
				if (cell.querySelector(CONTROL_SELECTOR)) continue;
				const spans = this.#spansOf(cell);
				if (spans.length === 0) continue;
				if (text.length > 0) appendSpan(text, " · ", undefined);
				for (const span of spans) appendSpan(text, span.text, span.style);
			}
			if (text.length > 0) this.#section.blocks.push({ kind: "text", spans: text, heading: false });
			cells.forEach((cell, column) => {
				for (const control of cell.querySelectorAll(CONTROL_SELECTOR)) {
					const own = control.closest("label");
					const spans = own && cell.contains(own) ? this.#spansOf(own) : this.#spansOf(cell);
					this.#control(control, spans.length > 0 ? spans : (header[column] ?? []));
				}
			});
		}
	}

	/** Label of a control outside any wrapping `<label>`: `<label for>`, then `aria-label`, `title`. */
	#detachedLabel(control: Element): FormSpan[] {
		const label = control.id ? this.#labelFor.get(control.id) : undefined;
		if (label) return this.#spansOf(label);
		const text = control.getAttribute("aria-label") ?? control.getAttribute("title");
		return text ? normalizeSpans([{ text }]) : [];
	}

	#control(control: Element, wrapping: FormSpan[] | undefined): void {
		this.#flush(false);
		const label = wrapping && wrapping.length > 0 ? wrapping : this.#detachedLabel(control);
		const name = control.getAttribute("name") ?? "";
		const required = control.hasAttribute("required");
		const tag = control.localName;
		if (tag === "select") {
			const multi = control.hasAttribute("multiple");
			const options: ChoiceOption[] = control.querySelectorAll("option").map(option => {
				const text = (option.textContent ?? "").replace(/\s+/g, " ").trim();
				return {
					value: option.getAttribute("value") ?? text,
					label: [{ text }],
					checked: option.hasAttribute("selected"),
					disabled: option.hasAttribute("disabled"),
				};
			});
			// A single select always has a selection: the first enabled option unless one is marked.
			if (!multi && !options.some(option => option.checked)) {
				const first = options.find(option => !option.disabled);
				if (first) first.checked = true;
			}
			this.#addField({ kind: "choice", name, multi, select: true, other: false, label, options, required });
			return;
		}
		if (tag === "textarea") {
			this.#addField({
				kind: "text",
				name,
				type: "textarea",
				multiline: true,
				label: label.length > 0 ? label : this.#nameLabel(name),
				value: (control.textContent ?? "").replace(/^\r?\n/, ""),
				placeholder: control.getAttribute("placeholder") ?? "",
				required,
				minLength: numberAttr(control, "minlength"),
				maxLength: numberAttr(control, "maxlength"),
				rows: numberAttr(control, "rows") ?? 4,
			});
			return;
		}
		const type = (control.getAttribute("type") ?? "text").toLowerCase();
		if (IGNORED_INPUTS[type]) return;
		const value = control.getAttribute("value");
		if (type === "hidden") {
			if (name) this.#hidden.push([name, value ?? ""]);
			return;
		}
		if (type === "radio" || type === "checkbox") {
			const option: ChoiceOption = {
				value: value ?? "on",
				label: label.length > 0 ? label : [{ text: value ?? name }],
				checked: control.hasAttribute("checked"),
				disabled: control.hasAttribute("disabled"),
			};
			const key = `${type}\0${name}`;
			const group = this.#groups.get(key);
			if (group) {
				group.options.push(option);
				group.required ||= required;
				return;
			}
			const field: ChoiceField = {
				kind: "choice",
				name,
				multi: type === "checkbox",
				select: false,
				other: false,
				label: [],
				options: [option],
				required,
			};
			this.#groups.set(key, field);
			this.#addField(field);
			return;
		}
		this.#addField({
			kind: "text",
			name,
			type,
			multiline: false,
			label: label.length > 0 ? label : this.#nameLabel(name),
			value: value ?? "",
			placeholder: control.getAttribute("placeholder") ?? "",
			required,
			min: numberAttr(control, "min"),
			max: numberAttr(control, "max"),
			pattern: control.getAttribute("pattern") ?? undefined,
			minLength: numberAttr(control, "minlength"),
			maxLength: numberAttr(control, "maxlength"),
			rows: 1,
		});
	}

	/** Last-resort label from the control name: `sentry_dsn` → `sentry dsn`. */
	#nameLabel(name: string): FormSpan[] {
		return name ? [{ text: name.replace(/[_-]+/g, " ") }] : [];
	}

	#addField(field: FormField): void {
		this.#fields.push(field);
		this.#section.blocks.push({ kind: "field", field });
	}
}
