import type { NativeToolHead, NativeToolView, ToolRenderer, ToolRenderResult } from "./renderer";
import { formatCount, isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { compact, node, row, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { noteText, resultText } from "./native-view";

import { type Component, replaceTabs, Text, visibleWidth } from "../index";

import type { RenderResultOptions } from "./renderer";

import type { Theme } from "../theme/theme";

import { renderStatusLine } from "../render";
import { framedToolCard } from "../render/tool-card";
import { wrapPrefixedLine } from "../render/hanging-wrap";

import { formatStatusIcon, PREVIEW_LIMITS } from "../render/render-utils";

import { type FormAnswer, fieldQuestions, type OptionNote } from "../html-form/data";
import { type HtmlForm, parseHtmlForm } from "../html-form/parse";

/** Answers and selected-option notes displayed for an ask tool result. */
export interface AskToolDetails {
	/** Each named field's question and answer text, in form order (from `formAnswers`). */
	answers: FormAnswer[];
	/** Notes attached to selected options; separate from the answer data. */
	notes?: OptionNote[];
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

/** Well-formed selected-option notes from persisted details. */
function detailsNotes(details: AskToolDetails | undefined): OptionNote[] {
	const raw: unknown = details?.notes;
	if (!Array.isArray(raw)) return [];
	const notes: OptionNote[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const { name, question, option, value, text } = entry;
		if (
			typeof name === "string" &&
			typeof question === "string" &&
			typeof option === "string" &&
			typeof value === "string" &&
			typeof text === "string"
		) {
			notes.push({ name, question, option, value, text });
		}
	}
	return notes;
}

function notesForAnswer(answer: FormAnswer, notes: readonly OptionNote[]): OptionNote[] {
	return notes.filter(note => note.name === answer.name && note.question === answer.question);
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

/** One answered field: its question over a checked answer row, notes, or a dim placeholder when left empty. */
function describeAnswer(answer: FormAnswer, shown: string, key: string, notes: readonly OptionNote[]): NativeNode {
	const body: NativeChild = shown
		? row([node("icon", { name: "check", tone: "success" }), text([span(shown, "toolOutput")], { wrap: "word" })], {
				gap: "sm",
				align: "baseline",
				role: "omp.tool.answer",
			})
		: text([span(NO_ANSWER, "dim")], { role: "omp.tool.answer.off" });
	const noteRows = notesForAnswer(answer, notes).map(note =>
		text([span("✎ ", "dim"), span(`${oneLine(note.option)}: ${clean(note.text)}`, "em")], {
			wrap: "word",
			role: "omp.tool.answer.note",
		}),
	);
	return node("section", {}, [text([span(oneLine(answer.question))], { wrap: "word" }), body, ...noteRows], key);
}

function describeAskResult(result: ToolRenderResult<AskToolDetails>, args: AskRenderArgs | undefined): NativeToolView {
	const answers = detailsAnswers(result.details);
	const notes = detailsNotes(result.details);
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
			...answers.map((answer, index) => describeAnswer(answer, answerShown(answer, passwords), `${index}`, notes)),
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
	renderCall(): undefined {
		// The ask panel over the composer owns the questions while they wait; the transcript shows the answers.
		return undefined;
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
			const notes = detailsNotes(result.details);
			const content = answers.flatMap((answer, index) => {
				const base = [
					...wrapPrefixedLine(" ", " ", uiTheme.fg("text", oneLine(answer.question)), contentWidth),
					...answerLines(uiTheme, shown[index]!, contentWidth, options.expanded),
				];
				const noteIndent = "   ";
				const noteLines: string[] = [];
				for (const note of notesForAnswer(answer, notes)) {
					const noteLabel = `✎ ${oneLine(note.option)}: ${oneLine(note.text)}`;
					noteLines.push(
						...wrapPrefixedLine(
							noteIndent,
							noteIndent,
							uiTheme.italic(uiTheme.fg("muted", noteLabel)),
							contentWidth,
						),
					);
				}
				return [
					...base,
					...capLines(
						uiTheme,
						noteLines,
						options.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED,
						noteIndent,
					),
				];
			});
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
