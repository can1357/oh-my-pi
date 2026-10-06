/**
 * State machine behind `DialogDesk.uiContextFor(...).askDialog`.
 *
 * Lifeos received one RPC `select` frame per question and answered each frame
 * separately; natively `askDialog` is handed the whole question list and must
 * return every answer in one `ExtensionAskDialogResult`. This module keeps the
 * question cursor, the toggle set of a multi-select question and the finished
 * results, so `dialog-desk.ts` only has to render each transition.
 */
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResultItem } from "../extensibility/extensions/types";
import { ASK_DONE_INDEX, ASK_OTHER_INDEX, CANCEL_INDEX } from "./dialog-keys";

/** What the desk must do after one answer. */
export type AskOutcome =
	| { kind: "render" }
	| { kind: "submit"; results: ExtensionAskDialogResultItem[] }
	| { kind: "cancel" }
	| { kind: "stale" };

/** Cursor over one ask dialog's questions. */
export interface AskFlow {
	/** The question on screen, or null once every question has an answer. */
	question(): ExtensionAskDialogQuestion | null;
	/** 1-based position of the current question. */
	at(): number;
	total(): number;
	multi(): boolean;
	selected(): ReadonlySet<string>;
	/** True while a free-text "Other" answer is awaited. */
	awaitingText(): boolean;
	/** Answers of the finished questions, in order. */
	results(): readonly ExtensionAskDialogResultItem[];
	/** Applies a keyboard answer. */
	press(index: number): AskOutcome;
	/** Applies a free-text "Other" answer. */
	reply(text: string): AskOutcome;
}

export function createAskFlow(questions: readonly ExtensionAskDialogQuestion[]): AskFlow {
	let at = 0;
	let selected = new Set<string>();
	let customInput: string | undefined;
	let awaiting = false;
	const results: ExtensionAskDialogResultItem[] = [];

	const question = (): ExtensionAskDialogQuestion | null => questions[at] ?? null;

	function done(): AskOutcome {
		return question() === null ? { kind: "submit", results: [...results] } : { kind: "render" };
	}

	function record(): void {
		const current = question();
		if (current === null) return;
		results.push({
			id: current.id,
			question: current.question,
			options: current.options.map(option => option.label),
			multi: current.multi === true,
			selectedOptions: [...selected],
			...(customInput === undefined ? {} : { customInput }),
		});
		at += 1;
		selected = new Set();
		customInput = undefined;
		awaiting = false;
	}

	return {
		question,
		at: () => at + 1,
		total: () => questions.length,
		multi: () => question()?.multi === true,
		selected: () => selected,
		awaitingText: () => awaiting,
		results: () => results,
		press(index) {
			const current = question();
			if (current === null) return { kind: "stale" };
			if (index === CANCEL_INDEX) return { kind: "cancel" };
			if (index === ASK_OTHER_INDEX) {
				awaiting = true;
				return { kind: "render" };
			}
			if (index === ASK_DONE_INDEX) {
				if (current.multi !== true) return { kind: "stale" };
				record();
				return done();
			}
			const option = current.options[index];
			if (option === undefined) return { kind: "stale" };
			if (current.multi === true) {
				const next = new Set(selected);
				if (next.has(option.label)) next.delete(option.label);
				else next.add(option.label);
				selected = next;
				return { kind: "render" };
			}
			selected = new Set([option.label]);
			record();
			return done();
		},
		reply(text) {
			if (question() === null || !awaiting) return { kind: "stale" };
			customInput = text;
			record();
			return done();
		},
	};
}
