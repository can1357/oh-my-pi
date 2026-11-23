/**
 * Puts an MCP server's form-mode elicitation to the user through the session's
 * form surface (`ui.formDialog`: the interactive TUI, RPC, ACP).
 *
 * The requested schema becomes an HTML form and the submitted data is typed
 * back to the schema. Choice fields are selects, so the user picks among the
 * server's values and never types an "Other" answer the schema does not allow.
 * A client that reports an explicit decline or cancel is taken at its word;
 * a form that was only closed asks whether to decline or cancel (or go back).
 * Answers that break the schema reopen the form as the user left it, with the
 * problem stated in it.
 */
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { fieldError, type HtmlFormData, type HtmlFormValue } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type {
	MCPElicitFieldSchema,
	MCPElicitRequest,
	MCPElicitResult,
	MCPElicitStringSchema,
	MCPElicitValue,
} from "./protocol";
import type { MCPElicitHandler } from "./types";

/** Placeholder label of the empty choice an optional select starts on. */
const NO_ANSWER_LABEL = "—";

/** Choices offered once the user closes the form without submitting it. */
export const ELICIT_DECLINE = "Decline: refuse the request";
export const ELICIT_CANCEL = "Cancel: send no answer";
export const ELICIT_BACK = "Back to the form";

/** The part of a tool call's or command's context an elicitation needs. */
type ElicitContext = Pick<AgentToolContext, "ui" | "hasUI" | "toolCall">;

/**
 * The elicitation handler of a request made for `ctx`, or undefined when it
 * cannot show the user a form (print, JSON and plain RPC modes, ACP clients
 * without forms): the request then declares no elicitation, and a server must
 * not ask.
 *
 * A message the user sends while the form is open closes it as `cancel`
 * without cancelling the tool call; aborting the request itself rejects.
 */
export function elicitHandler(ctx: ElicitContext | undefined): MCPElicitHandler | undefined {
	const ui = ctx?.hasUI ? ctx.ui : undefined;
	const formDialog = ui?.formDialog?.bind(ui);
	if (!ui || !formDialog) return undefined;
	const steering = ctx?.toolCall?.steeringSignal;
	return (serverName, request, signal) => elicitFromUser(ui, formDialog, serverName, request, signal, steering);
}

type FormDialog = NonNullable<ExtensionUIContext["formDialog"]>;

async function elicitFromUser(
	ui: ExtensionUIContext,
	formDialog: FormDialog,
	serverName: string,
	request: MCPElicitRequest,
	signal: AbortSignal | undefined,
	steering: AbortSignal | undefined,
): Promise<MCPElicitResult> {
	signal?.throwIfAborted();
	// Only the user's own message closes the form; other steering (peer messages, finished jobs) is not an answer.
	const dismissed = new AbortController();
	const onSteer = () => {
		if (steering?.reason === "user") dismissed.abort();
	};
	if (steering?.aborted) onSteer();
	else steering?.addEventListener("abort", onSteer, { once: true });
	const dialogSignal = signal ? AbortSignal.any([signal, dismissed.signal]) : dismissed.signal;
	try {
		// The form as the user last submitted it, and what was wrong with it: a reopened form shows both.
		let draft: HtmlFormData | undefined;
		let problem: string | undefined;
		for (;;) {
			const html = elicitationFormHtml(serverName, request, draft, problem);
			let explicit: "decline" | "cancel" | undefined;
			const submitted = await untilAborted(dialogSignal, () =>
				formDialog(html, {
					signal: dialogSignal,
					onDismiss: action => {
						explicit = action;
					},
				}),
			);
			if (!submitted) {
				if (explicit) return { action: explicit };
				const title = `You closed the form from ${serverName}. What should it hear?`;
				const options = [ELICIT_DECLINE, ELICIT_CANCEL, ELICIT_BACK];
				const choice = await untilAborted(dialogSignal, () => ui.select(title, options, { signal: dialogSignal }));
				if (choice === ELICIT_BACK) continue;
				return { action: choice === ELICIT_DECLINE ? "decline" : "cancel" };
			}
			draft = submitted.data;
			const content = elicitationContent(request, draft);
			problem = submissionError(request, html, draft, content);
			if (!problem) return { action: "accept", content };
		}
	} catch (error) {
		if (signal?.aborted) throw error;
		if (dismissed.signal.aborted) return { action: "cancel" };
		throw error;
	} finally {
		steering?.removeEventListener("abort", onSteer);
	}
}

/**
 * The form an elicitation is shown as: who asks, the server's message, what
 * was wrong with the last submit, then one control per schema property,
 * showing the user's draft where given and the schema's defaults otherwise.
 */
function elicitationFormHtml(
	serverName: string,
	request: MCPElicitRequest,
	draft: HtmlFormData | undefined,
	problem: string | undefined,
): string {
	const { properties, required = [] } = request.requestedSchema;
	const parts = ["<form>", `<p><strong>${esc(serverName)}</strong> asks:</p>`, paragraph(request.message)];
	if (problem) parts.push(`<p><strong>Please fix:</strong> ${esc(problem)}</p>`);
	for (const name of Object.keys(properties)) {
		const shown = draft && Object.hasOwn(draft, name) ? draft[name] : undefined;
		parts.push(fieldHtml(name, properties[name], required.includes(name), shown));
	}
	parts.push("</form>");
	return parts.join("\n");
}

/**
 * The accepted content for submitted form data: each value typed as its
 * schema declares. Fields left empty are omitted, except a required list,
 * whose empty selection is an answer.
 */
function elicitationContent(request: MCPElicitRequest, data: HtmlFormData): Record<string, MCPElicitValue> {
	const { properties, required = [] } = request.requestedSchema;
	// No prototype: a property may be named `__proto__`.
	const content: Record<string, MCPElicitValue> = Object.create(null);
	for (const name of Object.keys(properties)) {
		const schema = properties[name];
		const value = typedValue(schema, Object.hasOwn(data, name) ? data[name] : undefined);
		if (value === undefined) continue;
		if (Array.isArray(value) && value.length === 0 && !required.includes(name)) continue;
		content[name] = value;
	}
	return content;
}

function typedValue(schema: MCPElicitFieldSchema, value: HtmlFormValue | undefined): MCPElicitValue | undefined {
	if (schema.type === "array") {
		// An untouched multi-select may submit nothing at all: that is an empty selection.
		const values = value === undefined ? [] : Array.isArray(value) ? value : [String(value)];
		return values.filter(item => item !== "");
	}
	if (value === undefined) return undefined;
	switch (schema.type) {
		case "boolean":
			return value === "true" ? true : value === "false" ? false : undefined;
		case "number":
		case "integer": {
			if (typeof value === "string" && value.trim() === "") return undefined;
			const number = typeof value === "number" ? value : Number(value);
			return Number.isFinite(number) ? number : undefined;
		}
		default: {
			const text = Array.isArray(value) ? value.join(",") : String(value);
			return text === "" ? undefined : text;
		}
	}
}

/**
 * Why the submitted form does not satisfy the request's schema, phrased for
 * the user, or undefined when it does. The form's own rules (required, number
 * bounds, lengths, email and URL shapes) are checked as every form host checks
 * them; what HTML cannot express is checked against the schema: whole numbers,
 * choices, list sizes and dates.
 */
function submissionError(
	request: MCPElicitRequest,
	html: string,
	draft: HtmlFormData,
	content: Record<string, MCPElicitValue>,
): string | undefined {
	const { properties } = request.requestedSchema;
	for (const field of parseHtmlForm(html).fields) {
		const name = field.name;
		if (!name || !Object.hasOwn(properties, name)) continue;
		const schema = properties[name];
		const problem =
			fieldError(field, Object.hasOwn(draft, name) ? draft[name] : undefined) ?? schemaError(schema, content[name]);
		if (problem) return `${schema.title ?? name}: ${problem}`;
	}
	return undefined;
}

/** What the schema rules out that the form cannot: typed `value` is what {@link typedValue} made of the answer. */
function schemaError(schema: MCPElicitFieldSchema, value: MCPElicitValue | undefined): string | undefined {
	if (value === undefined) return undefined;
	switch (schema.type) {
		case "array": {
			const picked = Array.isArray(value) ? value : [];
			const allowed = choices(schema.items.anyOf, schema.items.enum).map(choice => choice.value);
			if (picked.some(item => !allowed.includes(item))) return "Pick only the listed options";
			if (schema.minItems !== undefined && picked.length < schema.minItems)
				return `Pick at least ${schema.minItems}`;
			if (schema.maxItems !== undefined && picked.length > schema.maxItems) return `Pick at most ${schema.maxItems}`;
			return undefined;
		}
		case "integer":
			return Number.isInteger(value) ? undefined : "Enter a whole number";
		case "string": {
			const allowed = choices(schema.oneOf, schema.enum).map(choice => choice.value);
			if (allowed.length > 0 && !allowed.includes(String(value))) return "Pick one of the listed options";
			if (schema.format === "date" && !isCalendarDate(String(value))) return "Enter a real date as YYYY-MM-DD";
			if (schema.format === "date-time" && !isDateTime(String(value))) {
				return "Enter a date and time as YYYY-MM-DDTHH:MM:SSZ";
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

/** Whether `value` is an RFC 3339 `full-date` naming a day that exists. */
function isCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Whether `value` is an RFC 3339 `date-time`: a real date, a time and an offset. */
function isDateTime(value: string): boolean {
	const match = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
	if (!match || !isCalendarDate(match[1])) return false;
	const [hours, minutes, seconds] = [Number(match[2]), Number(match[3]), Number(match[4])];
	const offsetOk = match[7] === undefined || (Number(match[7]) < 24 && Number(match[8]) < 60);
	return hours < 24 && minutes < 60 && seconds <= 60 && offsetOk;
}

function fieldHtml(name: string, schema: MCPElicitFieldSchema, required: boolean, shown: HtmlFormValue | undefined) {
	const title = esc(schema.title ?? name);
	const description = schema.description ? `${paragraph(schema.description)}\n` : "";
	return `${description}<label>${title} ${controlHtml(name, schema, required, shown)}</label>`;
}

/** One field's control, showing `shown` (the user's draft) when given and the schema's default otherwise. */
function controlHtml(
	name: string,
	schema: MCPElicitFieldSchema,
	required: boolean,
	shown: HtmlFormValue | undefined,
): string {
	const nameAttr = `name="${esc(name)}"`;
	const requiredAttr = required ? " required" : "";
	switch (schema.type) {
		case "boolean": {
			// A required yes/no without a default opens on "No": submitting untouched never approves anything.
			const fallback = schema.default === undefined ? (required ? "false" : undefined) : String(schema.default);
			const chosen = shown === undefined ? fallback : String(shown);
			const options: Choice[] = [
				{ value: "true", label: "Yes" },
				{ value: "false", label: "No" },
			];
			return selectHtml(nameAttr, requiredAttr, options, chosen ? [chosen] : [], !required);
		}
		case "array": {
			const chosen = shown === undefined ? (schema.default ?? []) : Array.isArray(shown) ? shown : [String(shown)];
			const opts = choices(schema.items.anyOf, schema.items.enum).map(option =>
				optionHtml(option, chosen.includes(option.value)),
			);
			// HTML `required` demands a pick; a required list may still allow an empty one.
			const mustPick = (schema.minItems ?? 0) >= 1 ? " required" : "";
			return `<select ${nameAttr} multiple${mustPick}>${opts.join("")}</select>`;
		}
		case "number":
		case "integer": {
			const attrs = [nameAttr, 'type="number"'];
			if (schema.minimum !== undefined) attrs.push(`min="${esc(String(schema.minimum))}"`);
			if (schema.maximum !== undefined) attrs.push(`max="${esc(String(schema.maximum))}"`);
			const value = shown === undefined ? schema.default : shown;
			if (value !== undefined) attrs.push(`value="${esc(String(value))}"`);
			return `<input ${attrs.join(" ")}${requiredAttr}>`;
		}
		case "string": {
			const value = shown === undefined ? schema.default : String(shown);
			const options = choices(schema.oneOf, schema.enum);
			if (options.length > 0) return selectHtml(nameAttr, requiredAttr, options, value ? [value] : [], !required);
			return `<input ${[nameAttr, ...textAttrs(schema, value)].join(" ")}${requiredAttr}>`;
		}
	}
}

function textAttrs(schema: MCPElicitStringSchema, value: string | undefined): string[] {
	const attrs: string[] = [];
	switch (schema.format) {
		case "email":
			attrs.push('type="email"');
			break;
		case "uri":
			attrs.push('type="url"');
			break;
		case "date":
			attrs.push('type="text"', 'placeholder="YYYY-MM-DD"');
			break;
		case "date-time":
			attrs.push('type="text"', 'placeholder="YYYY-MM-DDTHH:MM:SSZ"');
			break;
		default:
			attrs.push('type="text"');
	}
	if (schema.minLength !== undefined) attrs.push(`minlength="${esc(String(schema.minLength))}"`);
	if (schema.maxLength !== undefined) attrs.push(`maxlength="${esc(String(schema.maxLength))}"`);
	if (value !== undefined) attrs.push(`value="${esc(value)}"`);
	return attrs;
}

interface Choice {
	value: string;
	label: string;
}

/** Choices from titled `oneOf`/`anyOf` entries, else from untitled `enum` values. */
function choices(titled: { const: string; title?: string }[] | undefined, values: string[] | undefined): Choice[] {
	if (titled) return titled.map(entry => ({ value: entry.const, label: entry.title ?? entry.const }));
	return (values ?? []).map(value => ({ value, label: value }));
}

/** A single select. An optional one starts on an empty choice unless something is chosen. */
function selectHtml(
	nameAttr: string,
	requiredAttr: string,
	options: Choice[],
	chosen: string[],
	optional: boolean,
): string {
	const rows = options.map(option => optionHtml(option, chosen.includes(option.value)));
	if (optional) rows.unshift(optionHtml({ value: "", label: NO_ANSWER_LABEL }, chosen.length === 0));
	return `<select ${nameAttr}${requiredAttr}>${rows.join("")}</select>`;
}

function optionHtml(option: Choice, selected: boolean): string {
	return `<option value="${esc(option.value)}"${selected ? " selected" : ""}>${esc(option.label)}</option>`;
}

/** Text as a paragraph, its line breaks kept. */
function paragraph(text: string): string {
	return `<p>${esc(text).replaceAll("\n", "<br>")}</p>`;
}

function esc(text: string): string {
	return Bun.escapeHTML(text);
}
