/**
 * The ask card: omp's questions inline in Tern's transcript, as {@link HtmlFormDialog} and
 * {@link AskDialogComponent} describe them natively. Every question stacks in one column; the
 * focused one is open, the rest fold to their question over a summary: the picked answer, the
 * typed one, or up to {@link PILL_LIMIT} option pills. The card is a layout-transition container,
 * so a question opening or folding glides instead of jumping.
 *
 * Roles Tern's stylesheets key on: `omp.ask.card` holds `omp.ask.card.head` (`omp.ask.card.tag`,
 * `omp.ask.card.progress`), `omp.ask.card.body` (its questions, `omp.ask.open` or `omp.ask.fold`;
 * `mark: "drop"` while a composer draft would skip the ask), `omp.ask.skip` saying so, and the
 * `omp.actions` bar. A fold is `omp.ask.fold.head` (`omp.ask.fold.mark`, `omp.ask.fold.question`)
 * over `omp.ask.pills` (`omp.ask.pill`, `omp.ask.pill.more`, `omp.ask.fold.note`),
 * `omp.ask.fold.answer` or `omp.ask.fold.well`, then its `omp.ask.error`.
 *
 * @example
 * askCard({
 * 	progress: "1 of 2 answered",
 * 	body: [
 * 		openQuestion("q0", [question, options], focusMoves),
 * 		foldQuestion({ key: "q1", question: [span("Rollout?")], answered: false, open: "open:1",
 * 			summary: { kind: "pills", more: "open:1", pills: [{ label: "Behind a flag", chosen: false, act: "pick:1:0" }] } }),
 * 	],
 * 	actions: actionBar([null, actionButton("Submit", "submit", { tone: "accent" })]),
 * });
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { Ellipsis, truncateToWidth } from "../utils";
import { col, row, span, text, withMotion } from "./describe";
import type { NativeChild, NativeNode } from "./node";

/** Option pills a folded question shows; the rest fold into `+N`. */
export const PILL_LIMIT = 4;
/** Widest a pill's label grows, in cells, before it is cut. */
export const PILL_LABEL_WIDTH = 20;

/** One option of a folded choice question. */
export interface AskPill {
	label: string;
	chosen: boolean;
	/** What a click does: picks the option, or flips it in a multi-select. */
	act: string;
}

/** What a folded question shows under its question. */
export type FoldSummary =
	/**
	 * Its options as pills: once any is chosen only the chosen ones (the summary of the answer, with
	 * its note), else the first {@link PILL_LIMIT}. `more` is the `+N` pill's action.
	 */
	| { kind: "pills"; pills: readonly AskPill[]; more: string; note?: string | undefined }
	/** A typed answer, on one line, with its note. */
	| { kind: "answer"; text: string; note?: string | undefined }
	/** An empty text field: its placeholder in a well. */
	| { kind: "well"; placeholder: string };

/** A question folded to one summary; see {@link foldQuestion}. */
export interface FoldedQuestion {
	/** Unique among the card's questions; its open shape takes the same key to glide between them. */
	key: string;
	question: readonly TspSpan[];
	answered: boolean;
	error?: string | undefined;
	summary: FoldSummary;
	/** What a click on the fold does: opens the question. */
	open: string;
}

/**
 * The card around the questions. `progress` heads it (`2 of 5 answered`), `skip` warns under the
 * questions that sending the composer's draft skips them, and dims them.
 */
export function askCard(parts: {
	progress?: string | undefined;
	body: readonly NativeChild[];
	skip?: string | undefined;
	actions: NativeNode;
}): NativeNode {
	const head = row(
		[
			text([span("ask", "accent")], { role: "omp.ask.card.tag" }),
			...(parts.progress ? [text([span(parts.progress, "muted")], { role: "omp.ask.card.progress" })] : []),
		],
		{ role: "omp.ask.card.head", gap: "sm", align: "baseline", justify: "between" },
	);
	const children: NativeChild[] = [
		withMotion(head, "head"),
		withMotion(
			col(parts.body, { role: "omp.ask.card.body", gap: "lg", ...(parts.skip ? { mark: "drop" } : {}) }),
			"body",
		),
	];
	if (parts.skip) {
		children.push(
			withMotion(text([span(`⚠ ${parts.skip}`, "warning")], { role: "omp.ask.skip", wrap: "word" }), "skip"),
		);
	}
	children.push(withMotion(parts.actions, "actions"));
	// Revealed at its top when it lands, so the first question shows whatever the transcript was scrolled to.
	return { ...col(children, { role: "omp.ask.card", gap: "md", transition: "layout" }), reveal: "start" };
}

/**
 * The focused question, open: its context, controls and error as `children`. Bump `reveal` whenever
 * focus lands on another question so the transcript scrolls it into view.
 */
export function openQuestion(key: string, children: readonly NativeChild[], reveal: number): NativeNode {
	return {
		...withMotion(col(children, { role: "omp.ask.open", gap: "sm" }), key),
		reveal: { at: "nearest", n: reveal },
	};
}

/** A question folded to its question over its summary; a click opens it. */
export function foldQuestion(question: FoldedQuestion): NativeNode {
	const mark = question.error ? span("!", "error") : question.answered ? span("✓", "success") : span("○", "muted");
	const children: NativeChild[] = [
		row(
			[
				text([mark], { role: "omp.ask.fold.mark" }),
				text([...question.question], { role: "omp.ask.fold.question", wrap: "word" }),
			],
			{ role: "omp.ask.fold.head", gap: "sm", align: "baseline" },
		),
		withMotion(foldSummary(question.summary), `${question.key}.summary`),
	];
	if (question.error) children.push(text([span(question.error, "error")], { role: "omp.ask.error" }));
	return withMotion(
		col(children, {
			role: "omp.ask.fold",
			gap: "xs",
			title: "Answer this question",
			actions: { click: question.open },
		}),
		question.key,
	);
}

function foldSummary(summary: FoldSummary): NativeNode {
	switch (summary.kind) {
		case "answer": {
			const answer = text([span(summary.text, "muted")], { role: "omp.ask.fold.answer", truncate: "end", lines: 1 });
			return summary.note
				? row([answer, foldNote(summary.note)], { role: "omp.ask.pills", gap: "xs", align: "center" })
				: answer;
		}
		case "well":
			return text([span(summary.placeholder || " ", "dim")], {
				role: "omp.ask.fold.well",
				truncate: "end",
				lines: 1,
			});
		case "pills":
			return pillRow(summary);
	}
}

function pillRow(summary: Extract<FoldSummary, { kind: "pills" }>): NativeNode {
	const chosen = summary.pills.filter(pill => pill.chosen);
	const pool = chosen.length > 0 ? chosen : summary.pills;
	const shown = pool.slice(0, PILL_LIMIT);
	const children: NativeChild[] = shown.map(pill => {
		// A cut that lands after a word keeps no space before its ellipsis.
		const label = truncateToWidth(pill.label, PILL_LABEL_WIDTH, Ellipsis.Unicode).replace(/\s+…$/, "…");
		return text(pill.chosen ? `✓ ${label}` : label, {
			role: "omp.ask.pill",
			truncate: "end",
			lines: 1,
			actions: { click: pill.act },
			...(pill.chosen ? { tone: "accent" } : {}),
			...(label === pill.label ? {} : { title: pill.label }),
		});
	});
	const hidden = pool.length - shown.length;
	if (hidden > 0) {
		children.push(
			text(`+${hidden}`, {
				role: "omp.ask.pill.more",
				title: "Show every option",
				actions: { click: summary.more },
			}),
		);
	}
	if (chosen.length > 0 && summary.note) children.push(foldNote(summary.note));
	return row(children, { role: "omp.ask.pills", gap: "xs", align: "center", wrap: true });
}

/** The note on a folded question's answer. */
function foldNote(note: string): NativeNode {
	return text([span("✎ ", "dim"), span(note, "em")], { role: "omp.ask.fold.note", truncate: "end", lines: 1 });
}
