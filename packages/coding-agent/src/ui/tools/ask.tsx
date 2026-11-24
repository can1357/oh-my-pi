/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `ask`: an HTML form the model asks the user with. While it waits, the ask
 * panel over the composer owns the questions (the transcript shows nothing);
 * the result lists each question over its answer (passwords masked), the
 * notes on selected options, and a notice when the deadline answered.
 *
 * Terminal look: `ask` (`src/ui/styles/tools/ask.ts`), fed by {@link AskTerm}.
 */
import { formatCount, isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { type FormAnswer, fieldQuestions, type OptionNote } from "../../tools/html-form/data";
import { type HtmlForm, parseHtmlForm } from "../../tools/html-form/parse";
import type { ToolHead, ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";
import { NoteText } from "./run";

/** Ask result details. */
export interface AskDetails {
	readonly answers?: unknown;
	readonly notes?: unknown;
	/** The deadline submitted the form's current values instead of the user. */
	readonly timedOut?: boolean;
}

interface AskArgs {
	readonly html?: string;
}

/** One answered question as the terminal shows it. */
export interface AskTermAnswer {
	readonly question: string;
	/** The shown answer ("" when left empty; masked for passwords). */
	readonly shown: string;
	/** `✎ option: note` lines. */
	readonly notes: readonly string[];
}

/** Terminal-only facts of an ask call (`term`). */
export interface AskTerm {
	readonly look: "ask";
	/** No answers in the details (cancelled, an error): a warning head over this text. */
	readonly fallback?: string;
	readonly answers?: readonly AskTermAnswer[];
	readonly timedOut?: boolean;
}

const TIMED_OUT_NOTE = "auto-selected after timeout — not a user choice";
const NO_ANSWER = "(no answer)";

/** Model-authored text made safe for a row: no controls, tabs expanded. */
function clean(value: string): string {
	return replaceTabs(sanitizeText(value));
}

function oneLine(value: string): string {
	return clean(value).replace(/\s+/g, " ").trim();
}

function argsForm(args: AskArgs | undefined): HtmlForm | undefined {
	const html = args?.html;
	if (typeof html !== "string" || html.trim() === "") return undefined;
	return parseHtmlForm(html);
}

function passwordNames(form: HtmlForm | undefined): Set<string> {
	const names = new Set<string>();
	for (const field of form?.fields ?? []) {
		if (field.kind === "text" && field.type === "password" && field.name) names.add(field.name);
	}
	return names;
}

function detailsAnswers(details: AskDetails | undefined): FormAnswer[] | undefined {
	const raw = details?.answers;
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

function detailsNotes(details: AskDetails | undefined): OptionNote[] {
	const raw = details?.notes;
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
		)
			notes.push({ name, question, option, value, text });
	}
	return notes;
}

function answerShown(answer: FormAnswer, passwords: ReadonlySet<string>): string {
	if (passwords.has(answer.name)) return "•".repeat(Math.min(answer.answer.length, 12));
	return clean(answer.answer);
}

function askHead(question: string | undefined, meta?: string): ToolHead {
	const first = question ? oneLine(question) : "";
	return { title: "Ask", ...(first ? { target: first } : {}), targetKind: "text", ...(meta ? { meta: [meta] } : {}) };
}

function namedQuestions(form: HtmlForm | undefined): string[] {
	if (!form) return [];
	const questions = fieldQuestions(form);
	return form.fields.flatMap(field => (field.name ? [questions.get(field) ?? field.name] : []));
}

function AnswerSection(props: {
	readonly question: string;
	readonly shown: string;
	readonly notes: readonly OptionNote[];
	readonly nodeKey: string;
}): JSXNode {
	return (
		<section key={props.nodeKey}>
			<text spans={[{ t: oneLine(props.question) }]} wrap="word" />
			{props.shown ? (
				<row gap="sm" align="baseline" role="omp.tool.answer">
					<icon name="check" tone="success" />
					<text spans={[{ t: props.shown, s: "toolOutput" }]} wrap="word" />
				</row>
			) : (
				<text spans={[{ t: NO_ANSWER, s: "dim" }]} role="omp.tool.answer.off" />
			)}
			{props.notes.map(note => (
				<text
					spans={[
						{ t: "✎ ", s: "dim" },
						{ t: `${oneLine(note.option)}: ${clean(note.text)}`, s: "em" },
					]}
					wrap="word"
					role="omp.tool.answer.note"
				/>
			))}
		</section>
	);
}

export const askPresenter: ToolPresenter<AskArgs, AskDetails> = {
	merge: true,
	call(args): ToolView {
		const questions = namedQuestions(argsForm(args));
		return {
			head: askHead(questions[0], questions.length > 1 ? formatCount("field", questions.length) : undefined),
			inline: true,
			body: <text spans={[{ t: "Waiting for your answer…", s: "muted" }]} />,
			term: { look: "ask" } satisfies AskTerm,
		};
	},
	result(result, _state, args): ToolView {
		const answers = detailsAnswers(result.details);
		const form = argsForm(args);
		if (!answers) {
			const fallback = clean(resultText(result));
			const first = result.content[0];
			return {
				head: askHead(namedQuestions(form)[0]),
				tone: "warning",
				...(fallback ? { body: <NoteText text={fallback} /> } : {}),
				term: {
					look: "ask",
					fallback: first?.type === "text" && first.text ? clean(first.text) : "",
				} satisfies AskTerm,
			};
		}
		const notes = detailsNotes(result.details);
		const passwords = passwordNames(form);
		const timedOut = result.details?.timedOut === true;
		const notesOf = (answer: FormAnswer): OptionNote[] =>
			notes.filter(note => note.name === answer.name && note.question === answer.question);
		return {
			head: askHead(answers[0]?.question, answers.length > 1 ? formatCount("question", answers.length) : undefined),
			...(timedOut ? { tone: "warning" as const } : {}),
			body: [
				answers.map((answer, index) => (
					<AnswerSection
						nodeKey={String(index)}
						question={answer.question}
						shown={answerShown(answer, passwords)}
						notes={notesOf(answer)}
					/>
				)),
				timedOut && <text spans={[{ t: TIMED_OUT_NOTE, s: "muted" }]} wrap="word" role="omp.tool.notice" />,
			],
			term: {
				look: "ask",
				timedOut,
				answers: answers.map(answer => ({
					question: oneLine(answer.question),
					shown: answerShown(answer, passwords),
					notes: notesOf(answer).map(note => `✎ ${oneLine(note.option)}: ${oneLine(note.text)}`),
				})),
			} satisfies AskTerm,
		};
	},
};

registerToolPresenter("ask", askPresenter);
