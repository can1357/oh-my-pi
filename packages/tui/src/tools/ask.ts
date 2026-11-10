import type { NativeToolHead, NativeToolView, ToolRenderer, ToolRenderResult } from "./renderer";
import { formatCount, isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { compact, node, row, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { noteText, resultText } from "./native-view";

import { type Component, replaceTabs, Text, truncateToWidth, visibleWidth } from "../index";

import type { RenderResultOptions } from "./renderer";

import type { Theme } from "../theme/theme";

import { renderStatusLine } from "../render";
import { framedToolCard, type ToolCardSection } from "../render/tool-card";
import { wrapPrefixedLine } from "../render/hanging-wrap";

import { formatStatusIcon, formatTitle, PREVIEW_LIMITS } from "../render/render-utils";

import { type FormAnswer, fieldQuestions, OTHER_LABEL } from "../html-form/data";
import {
	type ChoiceField,
	type FormField,
	type HtmlForm,
	parseHtmlForm,
	spansText,
	type TextField,
} from "../html-form/parse";

/** Answers displayed for an ask tool result. */
export interface AskToolDetails {
	/** Each named field's question and answer text, in form order (from `formAnswers`). */
	answers: FormAnswer[];
	/** The deadline submitted the form's current values instead of the user. */
	timedOut?: boolean;
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface AskRenderArgs {
	/** The form the model asks with; streams in partially. */
	html?: string;
}

const TIMED_OUT_NOTE = "auto-selected after timeout — not a user choice";
const NO_ANSWER = "(no answer)";

/**
 * Marker glyph for a question option. Single-choice questions render circular radio
 * buttons (pick one); multi-select questions render rectangular checkboxes (pick many).
 */
export function optionMarker(uiTheme: Theme, multi: boolean | undefined, selected: boolean): string {
	if (multi) return selected ? uiTheme.checkbox.checked : uiTheme.checkbox.unchecked;
	return selected ? uiTheme.radio.selected : uiTheme.radio.unselected;
}

/** Model-authored text made safe for a terminal row: no escapes or control characters, tabs expanded. */
function clean(value: string): string {
	return replaceTabs(sanitizeText(value));
}

/** {@link clean} text folded onto one line. */
function oneLine(value: string): string {
	return clean(value).replace(/\s+/g, " ").trim();
}

/** The form in untrusted (streamed or model-mangled) call args; undefined until markup arrives. */
function argsForm(args: AskRenderArgs | undefined): HtmlForm | undefined {
	const html = args?.html;
	if (typeof html !== "string" || html.trim() === "") return undefined;
	return parseHtmlForm(html);
}

/** Names of the form's password fields, whose values never reach the transcript. */
function passwordNames(form: HtmlForm | undefined): Set<string> {
	const names = new Set<string>();
	for (const field of form?.fields ?? []) {
		if (field.kind === "text" && field.type === "password" && field.name) names.add(field.name);
	}
	return names;
}

/** Well-formed answers from persisted details; undefined for errors and sessions predating HTML forms. */
function detailsAnswers(details: AskToolDetails | undefined): FormAnswer[] | undefined {
	const raw: unknown = details?.answers;
	if (!Array.isArray(raw)) return undefined;
	const answers: FormAnswer[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const { name, question, answer } = entry;
		if (typeof question !== "string" || typeof answer !== "string") continue;
		answers.push({ name: typeof name === "string" ? name : "", question, answer });
	}
	return answers;
}

/** Shown text of an answer: masked for password fields, sanitized otherwise. */
function answerShown(answer: FormAnswer, passwords: ReadonlySet<string>): string {
	if (passwords.has(answer.name)) return "•".repeat(Math.min(answer.answer.length, 12));
	return clean(answer.answer);
}

/** `lines` capped at `limit`, with a dim `… N more lines` row standing in for the rest. */
function capLines(uiTheme: Theme, lines: string[], limit: number, indent: string): string[] {
	if (lines.length <= limit) return lines;
	return [
		...lines.slice(0, limit),
		`${indent}${uiTheme.fg("dim", `… ${formatCount("more line", lines.length - limit)}`)}`,
	];
}

/** Option rows of a choice field with its preselected state marked, capped unless expanded. */
function choiceFieldLines(uiTheme: Theme, field: ChoiceField, width: number, expanded: boolean): string[] {
	const limit = expanded ? field.options.length : PREVIEW_LIMITS.COLLAPSED_ITEMS;
	const out: string[] = [];
	for (const option of field.options.slice(0, limit)) {
		const marker = uiTheme.fg(option.checked ? "success" : "dim", optionMarker(uiTheme, field.multi, option.checked));
		const color = option.disabled ? "dim" : option.checked ? "toolOutput" : "muted";
		const prefix = ` ${marker} `;
		const label = oneLine(spansText(option.label)) || oneLine(option.value);
		out.push(...wrapPrefixedLine(prefix, " ".repeat(visibleWidth(prefix)), uiTheme.fg(color, label), width));
	}
	const hidden = field.options.length - limit;
	if (hidden > 0) out.push(`   ${uiTheme.fg("dim", `… ${formatCount("more option", hidden)}`)}`);
	else if (field.other)
		out.push(` ${uiTheme.fg("dim", `${optionMarker(uiTheme, field.multi, false)} ${OTHER_LABEL}…`)}`);
	return out;
}

/** Input rows of a text field: its prefilled value, else its placeholder dimmed, behind an input bar. */
function textFieldLines(uiTheme: Theme, field: TextField, width: number, expanded: boolean): string[] {
	const prefix = `   ${uiTheme.fg("border", uiTheme.boxRound.vertical)} `;
	const inner = Math.max(1, width - visibleWidth(prefix));
	const shown = field.type === "password" ? "•".repeat(Math.min(field.value.length, 12)) : clean(field.value);
	const lines = shown
		? shown.split("\n").map(line => `${prefix}${uiTheme.fg("toolOutput", truncateToWidth(line, inner))}`)
		: [`${prefix}${uiTheme.fg("dim", truncateToWidth(oneLine(field.placeholder), inner))}`];
	return capLines(uiTheme, lines, expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES, "   ");
}

/** Pending form summary: one card section per fieldset, each field's question over its options or input. */
function formSections(
	uiTheme: Theme,
	form: HtmlForm,
	questions: ReadonlyMap<FormField, string>,
	width: number,
	expanded: boolean,
): ToolCardSection[] {
	const sections: ToolCardSection[] = [];
	for (const section of form.sections) {
		const title = oneLine(spansText(section.title));
		const content: string[] = title
			? wrapPrefixedLine(" ", " ", uiTheme.bold(uiTheme.fg("accent", title)), width)
			: [];
		for (const block of section.blocks) {
			if (block.kind !== "field") continue;
			const field = block.field;
			const question = oneLine(questions.get(field) ?? field.name);
			// A fieldset's lone group answers its legend; the title already says it.
			if (question && question !== title) {
				const required = field.required ? uiTheme.fg("error", " *") : "";
				content.push(...wrapPrefixedLine(" ", " ", `${uiTheme.fg("text", question)}${required}`, width));
			}
			content.push(
				...(field.kind === "choice"
					? choiceFieldLines(uiTheme, field, width, expanded)
					: textFieldLines(uiTheme, field, width, expanded)),
			);
		}
		if (content.length > 0) sections.push({ content, separator: sections.length > 0 });
	}
	return sections;
}

/** Answer rows: a success check before the answer with continuation rows beneath it, or a dim placeholder. */
function answerLines(uiTheme: Theme, shown: string, width: number, expanded: boolean): string[] {
	if (shown === "") return [`   ${uiTheme.fg("dim", NO_ANSWER)}`];
	const prefix = ` ${formatStatusIcon("success", uiTheme)} `;
	const indent = " ".repeat(visibleWidth(prefix));
	const rows = shown
		.split("\n")
		.flatMap((line, index) =>
			wrapPrefixedLine(index === 0 ? prefix : indent, indent, uiTheme.fg("toolOutput", line), width),
		);
	return capLines(uiTheme, rows, expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED, indent);
}

function askHead(question: string | undefined, meta?: string): NativeToolHead {
	const first = question ? oneLine(question) : "";
	return { title: "Ask", target: first || undefined, targetKind: "text", meta: meta ? [meta] : undefined };
}

/** Questions of the form's named fields, in form order. */
function namedQuestions(form: HtmlForm | undefined): string[] {
	if (!form) return [];
	const questions = fieldQuestions(form);
	return form.fields.flatMap(field => (field.name ? [questions.get(field) ?? field.name] : []));
}

/** Pending ask: an inline head naming the first question; the form dialog owns the interaction. */
function describeAskCall(args: AskRenderArgs): NativeToolView {
	const questions = namedQuestions(argsForm(args));
	return {
		tool: askHead(questions[0], questions.length > 1 ? formatCount("field", questions.length) : undefined),
		inline: true,
		body: [text([span("Waiting for your answer…", "muted")])],
	};
}

/** One answered field: its question over a checked answer row, or a dim placeholder when left empty. */
function describeAnswer(answer: FormAnswer, shown: string, key: string): NativeNode {
	const body: NativeChild = shown
		? row([node("icon", { name: "check", tone: "success" }), text([span(shown, "toolOutput")], { wrap: "word" })], {
				gap: "sm",
				align: "baseline",
				role: "omp.tool.answer",
			})
		: text([span(NO_ANSWER, "dim")], { role: "omp.tool.answer.off" });
	return node("section", {}, [text([span(oneLine(answer.question))], { wrap: "word" }), body], key);
}

function describeAskResult(result: ToolRenderResult<AskToolDetails>, args: AskRenderArgs | undefined): NativeToolView {
	const answers = detailsAnswers(result.details);
	const form = argsForm(args);
	if (!answers) {
		const fallback = clean(resultText(result));
		return {
			tool: askHead(namedQuestions(form)[0]),
			tone: "warning",
			body: fallback ? [noteText(fallback)] : undefined,
		};
	}
	const passwords = passwordNames(form);
	const timedOut = result.details?.timedOut === true;
	return {
		tool: askHead(answers[0]?.question, answers.length > 1 ? formatCount("question", answers.length) : undefined),
		tone: timedOut ? "warning" : undefined,
		body: compact<NativeChild>([
			...answers.map((answer, index) => describeAnswer(answer, answerShown(answer, passwords), `${index}`)),
			timedOut ? text([span(TIMED_OUT_NOTE, "muted")], { wrap: "word", role: "omp.tool.notice" }) : undefined,
		]),
	};
}

const askCallMemo = new OwnerMemo<NativeToolView | undefined>();
const askResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render HTML question forms and their submitted answers. */
export const askToolRenderer = {
	describeCall(args: AskRenderArgs): NativeToolView | undefined {
		return askCallMemo.get(args, [args.html], () => describeAskCall(args));
	},
	describeResult(
		result: ToolRenderResult<AskToolDetails>,
		_options?: RenderResultOptions,
		args?: AskRenderArgs,
	): NativeToolView | undefined {
		return askResultMemo.get(result, [], () => describeAskResult(result, args));
	},
	mergeCallAndResult: true,
	renderCall(args: AskRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		// Call args are untrusted (partially streamed or model-mangled); the parser tolerates truncated markup.
		const form = argsForm(args);
		const questions = form ? fieldQuestions(form) : undefined;
		const named = form?.fields.filter(field => field.name).length ?? 0;
		const footerMeta = named > 0 ? uiTheme.fg("dim", formatCount("field", named)) : undefined;
		return framedToolCard(uiTheme, ({ contentWidth }) => ({
			header: formatTitle("Ask", uiTheme),
			sections: form && questions ? formSections(uiTheme, form, questions, contentWidth, options.expanded) : [],
			footerMeta,
			phase: "pending",
			borderColor: "borderMuted",
		}));
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AskToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AskRenderArgs,
	): Component {
		const answers = detailsAnswers(result.details);
		if (!answers) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? clean(txt.text) : "";
			const header = renderStatusLine({ icon: "warning", title: "Ask" }, uiTheme);
			const body = fallback ? `\n${uiTheme.fg("dim", fallback)}` : "";
			return new Text(`${header}${body}`, 0, 0);
		}
		const timedOut = result.details?.timedOut === true;
		const passwords = passwordNames(argsForm(args));
		const shown = answers.map(answer => answerShown(answer, passwords));
		const header = renderStatusLine(
			timedOut
				? { icon: "warning", title: "Ask" }
				: { iconOverride: uiTheme.styledSymbol("tool.ask", "accent"), title: "Ask" },
			uiTheme,
		);
		return framedToolCard(uiTheme, ({ contentWidth }) => {
			const content = answers.flatMap((answer, index) => [
				...wrapPrefixedLine(" ", " ", uiTheme.fg("text", oneLine(answer.question)), contentWidth),
				...answerLines(uiTheme, shown[index]!, contentWidth, options.expanded),
			]);
			// Distinguish the deadline's submission from a real user choice in the transcript.
			if (timedOut) content.push(...wrapPrefixedLine(" ", " ", uiTheme.fg("dim", TIMED_OUT_NOTE), contentWidth));
			return {
				header,
				sections: content.length > 0 ? [{ content }] : [],
				phase: timedOut ? "warning" : "success",
				borderColor: "borderMuted",
			};
		});
	},
} satisfies ToolRenderer<AskRenderArgs, AskToolDetails>;
