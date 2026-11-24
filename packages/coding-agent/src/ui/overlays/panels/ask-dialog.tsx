/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The ask dialog: the ask tool's questions as one card (`omp.ask.card`).
 *
 * Every question stacks in one column; the focused one is open (its header,
 * the question, its answers as radio or check rows, the highlighted option's
 * preview), the rest fold to their question over option pills or the typed
 * answer. The action bar carries the countdown, Note, Cancel and Submit.
 *
 * Keys walk the rows (crossing into the neighbouring questions), Tab/←/→
 * switch questions, Enter picks and moves on (Space flips a multi-select
 * option), `n` notes the highlighted row; Other and notes ask the host for
 * text. Escape hands the keys back to the composer. The terminal draws the
 * same column in a scrolling box ({@link AskDialogModel} is what it reads).
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type Accessor, type JSXNode, onCleanup, signal, untrack } from "@oh-my-pi/pi-tui";
import { replaceTabs, truncate } from "@oh-my-pi/pi-tui/text/width";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import {
	type AskDialogPrompt,
	type AskDialogPromptDraft,
	type AskDialogPromptValue,
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type ExtensionAskDialogResultItem,
	normalizeDialogQuestions,
} from "../../../modes/view-model/overlays/ask-dialog";
import { disambiguateDisplayLabels, sanitizeCarriageReturns } from "../../../utils/render-utils";
import "../../styles/panels/ask-dialog";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { ActionButton } from "./common";

/** Label of the free-text row in the terminal. */
export const OTHER_OPTION = "Other (type your own)";
const RECOMMENDED_SUFFIX = " (Recommended)";
/** Native label of the free-text row. */
const OTHER_LABEL = "Other…";
/** Widest a folded question's text grows, in cells, before it is cut. */
const MAX_FOLD_QUESTION_WIDTH = 200;
/** Rows a guest participant appends; options sanitizing to them disambiguate the same way on both sides. */
const GUEST_ACTION_LABELS = ["Chat about this", "Next →"];
/** Option pills a folded question shows; the rest fold into `+N`. */
export const PILL_LIMIT = 4;
/** Widest a pill's label grows, in cells. */
export const PILL_LABEL_WIDTH = 20;

export interface AskDialogCallbacks {
	onSubmit(result: ExtensionAskDialogResult): void;
	onCancel(): void;
	/** Resolves the submitted text; on cancel, the editor's draft, or undefined when none is kept. */
	onPrompt(prompt: AskDialogPrompt, prefill?: string): Promise<string | AskDialogPromptDraft | undefined>;
	/** Prompt that accepts pasted images; without it prompts use `onPrompt`. */
	onImagePrompt?(
		prompt: AskDialogPrompt,
		prefill: AskDialogPromptValue | undefined,
	): Promise<AskDialogPromptValue | AskDialogPromptDraft | undefined>;
}

export interface AskDialogOptions {
	/** Answer the recommended options after this many ms without input. */
	readonly timeout?: number;
	onTimeout?(): void;
	/** While it returns text, the card dims its questions and warns with it (sending the draft skips the ask). */
	readonly skipNotice?: Accessor<string | undefined>;
	/** A pointer action on the card: the host gives it the keyboard. */
	claimKeys?(): void;
	/** Escape (and Tab past the last question): the host hands the keyboard to the composer. */
	releaseKeys?(): void;
	/** Terminal rows (the terminal box takes at most 70% of them). */
	readonly terminalRows?: Accessor<number>;
}

/** A question's answer state. */
export interface AskQuestionState {
	selected: Set<string>;
	customInput: string | undefined;
	customInputImages: ImageContent[] | undefined;
	/** Unsubmitted custom answer left by a cancelled prompt; prefills the next one. */
	customDraft: AskDialogPromptValue | undefined;
	note: string | undefined;
	noteImages: ImageContent[] | undefined;
	noteRowKey: string | undefined;
	cursor: number;
	timedOut: boolean;
}

/** One answer row of the open question. */
export interface AskRow {
	readonly kind: "option" | "other";
	readonly key: string;
	readonly label: string;
	readonly optionIndex: number | undefined;
}

/** A folded question's summary. */
export type AskFoldSummary =
	| { readonly kind: "pills"; readonly pills: readonly AskPill[]; readonly note?: string }
	| { readonly kind: "answer"; readonly text: string; readonly note?: string };

/** One option of a folded question. */
export interface AskPill {
	readonly label: string;
	readonly chosen: boolean;
	readonly act: string;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** Whitespace runs as one space, tabs expanded, trimmed. */
export function inlineText(input: string): string {
	return replaceTabs(input).replace(/\s+/g, " ").trim();
}

/** Inline code runs as `code` spans, the rest plain. */
export function inlineCodeSpans(value: string): TspSpan[] {
	return value
		.split(/(`[^`]+`)/)
		.flatMap(piece =>
			piece === ""
				? []
				: piece.length > 2 && piece.startsWith("`") && piece.endsWith("`")
					? [{ s: "code", t: piece.slice(1, -1) }]
					: [{ t: piece }],
		);
}

/** Display labels: sanitized, the recommendation badged, unique, never a reserved label. */
export function displayLabels(question: ExtensionAskDialogQuestion): string[] {
	const badged = question.options.map((option, index) => {
		const base = sanitizeCarriageReturns(option.label);
		return question.recommended === index && !base.endsWith(RECOMMENDED_SUFFIX)
			? `${base}${RECOMMENDED_SUFFIX}`
			: base;
	});
	return disambiguateDisplayLabels(badged, [OTHER_OPTION, ...GUEST_ACTION_LABELS]);
}

/** The native label of option `index`: without its badge, inline code mono. */
function optionLabelSpans(question: ExtensionAskDialogQuestion, index: number, label: string): TspSpan[] {
	const badged = question.recommended === index && label.endsWith(RECOMMENDED_SUFFIX);
	return inlineCodeSpans(badged ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label);
}

/** The pills a fold shows (the chosen ones always among them) and how many hide behind `+N`. */
export function foldPills(pills: readonly AskPill[]): { shown: (AskPill & { cut: string })[]; hidden: number } {
	let room = Math.max(0, PILL_LIMIT - pills.filter(pill => pill.chosen).length);
	const kept = pills.filter(pill => {
		if (pill.chosen) return true;
		if (room === 0) return false;
		room--;
		return true;
	});
	const shown = kept.slice(0, PILL_LIMIT).map(pill => ({
		...pill,
		cut: truncate(pill.label, PILL_LABEL_WIDTH, "…").replace(/\s+…$/, "…"),
	}));
	return { shown, hidden: pills.length - shown.length };
}

function isAnswered(state: AskQuestionState): boolean {
	return state.selected.size > 0 || state.customInput !== undefined;
}

/** A prompt's outcome: the submitted value, or after a cancel the draft the host kept. */
type PromptOutcome =
	| { readonly submitted: true; readonly text: string; readonly images: ImageContent[] | undefined }
	| { readonly submitted: false; readonly draft: AskDialogPromptValue | undefined };

function promptOutcome(result: string | AskDialogPromptValue | AskDialogPromptDraft | undefined): PromptOutcome {
	if (result === undefined) return { submitted: false, draft: undefined };
	if (typeof result === "string") return { submitted: true, text: result, images: undefined };
	if ("draft" in result) return { submitted: false, draft: result.draft };
	return { submitted: true, text: result.text, images: result.images?.length ? result.images : undefined };
}

function clearNote(state: AskQuestionState): void {
	state.note = undefined;
	state.noteImages = undefined;
	state.noteRowKey = undefined;
}

/** The note going out with the answer, and the option it is on (unset for Other). */
function submittedNote(
	question: ExtensionAskDialogQuestion,
	state: AskQuestionState,
): { text: string; option?: string } | undefined {
	if (state.note === undefined || state.noteRowKey === undefined) return undefined;
	if (state.noteRowKey === "other") return state.customInput !== undefined ? { text: state.note } : undefined;
	const index = Number(/^option:(\d+)$/.exec(state.noteRowKey)?.[1] ?? Number.NaN);
	const option = Number.isInteger(index) ? question.options[index] : undefined;
	return option && state.selected.has(option.label) ? { text: state.note, option: option.label } : undefined;
}

/**
 * The dialog's state and behaviour, apart from its look: what the native
 * card describes and the terminal box draws. `rev` changes on every change.
 */
export class AskDialogModel {
	readonly questions: ExtensionAskDialogQuestion[];
	readonly states: AskQuestionState[];
	readonly rev = signal(0);
	/** The open question. */
	open = 0;
	/** Bumped whenever another question opens (natively it scrolls into view). */
	reveal = 0;
	/** The terminal's expanded question header and descriptions. */
	expanded = false;
	/** The open question's header or a description is cut where the terminal last painted it (the painter sets it). */
	revealable = false;
	/** The terminal's one-line hidden form. */
	hidden = false;
	/** PgUp/PgDn paging of the terminal body (rows, the painter clamps). */
	pageOffset: number | undefined;
	/** Where the terminal body was last scrolled (it moves as little as it can). */
	scrollOffset = 0;
	/** Seconds left on the countdown, if any. */
	remaining: number | undefined;
	closed = false;
	#promptActive = false;
	#timeoutExpired = false;

	constructor(
		questions: ExtensionAskDialogQuestion[],
		readonly callbacks: AskDialogCallbacks,
		readonly options: AskDialogOptions,
	) {
		this.questions = normalizeDialogQuestions(questions);
		this.states = this.questions.map(question => ({
			selected: new Set<string>(),
			customInput: undefined,
			customInputImages: undefined,
			customDraft: undefined,
			note: undefined,
			noteImages: undefined,
			noteRowKey: undefined,
			cursor: clamp(question.recommended ?? 0, 0, Math.max(0, question.options.length - 1)),
			timedOut: false,
		}));
		if (options.timeout && options.timeout > 0) this.remaining = Math.ceil(options.timeout / 1000);
	}

	touch(): void {
		this.rev.set(untrack(this.rev) + 1);
	}

	get current(): number {
		return clamp(this.open, 0, Math.max(0, this.questions.length - 1));
	}

	answered(index: number): boolean {
		const state = this.states[index];
		return state !== undefined && isAnswered(state);
	}

	rows(question: ExtensionAskDialogQuestion): AskRow[] {
		const labels = displayLabels(question);
		const rows: AskRow[] = question.options.map((option, index) => ({
			kind: "option",
			key: `option:${index}`,
			label: labels[index] ?? sanitizeCarriageReturns(option.label),
			optionIndex: index,
		}));
		rows.push({ kind: "other", key: "other", label: OTHER_OPTION, optionIndex: undefined });
		return rows;
	}

	foldSummary(index: number): AskFoldSummary {
		const question = this.questions[index]!;
		const state = this.states[index]!;
		const labels = displayLabels(question);
		const noteText = submittedNote(question, state)?.text.trim();
		const note = noteText ? inlineText(noteText) : undefined;
		const custom = state.customInput === undefined ? undefined : `Other: “${inlineText(state.customInput)}”`;
		if (custom !== undefined && !question.multi) return { kind: "answer", text: custom, ...(note ? { note } : {}) };
		const pills: AskPill[] = question.options.map((option, optionIndex) => ({
			label: optionLabelSpans(question, optionIndex, labels[optionIndex] ?? option.label)
				.map(part => part.t)
				.join(""),
			chosen: state.selected.has(option.label),
			act: `pick:${index}:${optionIndex}`,
		}));
		if (custom !== undefined) pills.push({ label: custom, chosen: true, act: `open:${index}` });
		return { kind: "pills", pills, ...(note ? { note } : {}) };
	}

	/** A folded question's text on one line, cut to {@link MAX_FOLD_QUESTION_WIDTH}. */
	foldQuestion(index: number): string {
		return truncate(
			inlineText(sanitizeCarriageReturns(this.questions[index]!.question)),
			MAX_FOLD_QUESTION_WIDTH,
			"…",
		);
	}

	/** Restart the countdown (any input). */
	resetCountdown(): void {
		if (this.options.timeout && this.options.timeout > 0) this.remaining = Math.ceil(this.options.timeout / 1000);
	}

	/** One countdown second passed. */
	tick(): void {
		if (this.remaining === undefined || this.closed) return;
		this.remaining = Math.max(0, this.remaining - 1);
		if (this.remaining === 0) this.#timeout();
		this.touch();
	}

	openAt(index: number, row?: "first" | "last"): void {
		const question = this.questions[index];
		const state = this.states[index];
		if (!question || !state) return;
		if (row) state.cursor = row === "first" ? 0 : this.rows(question).length - 1;
		this.pageOffset = undefined;
		if (this.open === index) return;
		this.open = index;
		this.reveal += 1;
	}

	pick(questionIndex: number, optionIndex: number): void {
		const question = this.questions[questionIndex];
		const state = this.states[questionIndex];
		const option = question?.options[optionIndex];
		if (!question || !state || !option) return;
		const rowKey = `option:${optionIndex}`;
		if (question.multi) {
			if (state.selected.has(option.label)) {
				state.selected.delete(option.label);
				if (state.noteRowKey === rowKey) clearNote(state);
			} else state.selected.add(option.label);
			return;
		}
		state.selected = new Set([option.label]);
		state.customInput = undefined;
		state.customInputImages = undefined;
		if (state.noteRowKey !== undefined && state.noteRowKey !== rowKey) clearNote(state);
	}

	submitOrOpenUnanswered(): void {
		const unanswered = this.states.findIndex(state => !isAnswered(state));
		if (unanswered < 0 || unanswered === this.current) this.finishSubmit();
		else this.openAt(unanswered);
	}

	advance(): void {
		const current = this.current;
		if (current + 1 < this.questions.length) this.openAt(current + 1);
		else this.submitOrOpenUnanswered();
	}

	/** Enter (`enter`) or a multi-select Space on a row. */
	commit(row: AskRow, enter: boolean): void {
		const question = this.questions[this.current]!;
		if (row.kind === "other") {
			void this.#promptCustom(row);
			return;
		}
		if (!question.options[row.optionIndex ?? -1]) return;
		if (question.multi && enter) {
			this.advance();
			return;
		}
		this.pick(this.current, row.optionIndex!);
		if (!question.multi) this.advance();
	}

	/** Keys over the stacked questions; true when the key was the dialog's. */
	key(id: string, text: string | undefined): boolean {
		if (this.closed || this.#promptActive) return true;
		this.resetCountdown();
		if (matchesSelectCancel(id)) {
			this.options.releaseKeys?.();
			return true;
		}
		if (getKeybindings().matchesId(id, "app.ask.hide")) {
			this.hidden = !this.hidden;
			this.touch();
			return true;
		}
		if (id === "ctrl+o") {
			// Without anything to reveal the key stays the transcript's tool-output toggle (#7837).
			if (this.hidden || (!this.expanded && !this.revealable)) return false;
			this.expanded = !this.expanded;
			this.touch();
			return true;
		}
		const nav = selectKeyId(id);
		if (this.hidden) {
			if (nav === "enter") {
				this.hidden = false;
				this.touch();
			}
			return true;
		}
		const index = this.current;
		const question = this.questions[index];
		const state = this.states[index];
		if (!question || !state) return true;
		const rows = this.rows(question);
		const last = Math.max(0, rows.length - 1);
		state.cursor = clamp(state.cursor, 0, last);
		switch (nav) {
			case "pageDown":
			case "pageUp":
				this.pageOffset = (this.pageOffset ?? 0) + (nav === "pageDown" ? 1 : -1);
				this.touch();
				return true;
			case "up":
				if (state.cursor > 0) state.cursor -= 1;
				else if (index > 0) this.openAt(index - 1, "last");
				this.pageOffset = undefined;
				this.touch();
				return true;
			case "down":
				if (state.cursor < last) state.cursor += 1;
				else if (index + 1 < this.questions.length) this.openAt(index + 1, "first");
				this.pageOffset = undefined;
				this.touch();
				return true;
			case "tab":
			case "right":
				if (id === "tab" && index + 1 >= this.questions.length) {
					this.options.releaseKeys?.();
					return true;
				}
				if (index + 1 < this.questions.length) this.openAt(index + 1);
				this.touch();
				return true;
			case "shift+tab":
			case "left":
				if (index > 0) this.openAt(index - 1);
				this.touch();
				return true;
		}
		const row = rows[state.cursor];
		if (!row) return true;
		if (text === "n" || text === "N") {
			void this.#promptNote(row);
			return true;
		}
		const enter = nav === "enter" || id === "ctrl+j";
		if (!enter && !(question.multi && id === "space")) return true;
		this.commit(row, enter);
		this.touch();
		return true;
	}

	/** Pointer actions and list events. */
	action(act: string, keypath: string): void {
		if (this.closed || this.#promptActive) return;
		this.options.claimKeys?.();
		if (act === "cancel") return this.finishCancel();
		if (act === "submit") {
			this.resetCountdown();
			this.submitOrOpenUnanswered();
		} else if (act === "note") this.#noteFromPointer(keypath);
		else {
			const open = /^open:(\d+)$/.exec(act);
			const pick = /^pick:(\d+):(\d+)$/.exec(act);
			if (open && Number(open[1]) < this.questions.length) {
				this.resetCountdown();
				this.openAt(Number(open[1]));
			} else if (pick) {
				this.resetCountdown();
				this.pick(Number(pick[1]), Number(pick[2]));
			}
		}
		this.touch();
	}

	rowEvent(kind: "select" | "activate", list: string, item: string): void {
		if (this.closed || this.#promptActive) return;
		this.options.claimKeys?.();
		if (list.split("/").at(-1) !== `q${this.current}`) return;
		const question = this.questions[this.current]!;
		const state = this.states[this.current]!;
		const rows = this.rows(question);
		const at = rows.findIndex(row => row.key === item);
		if (at < 0) return;
		this.resetCountdown();
		state.cursor = at;
		this.pageOffset = undefined;
		const toggles = kind === "select" && question.multi === true && rows[at]!.kind === "option";
		this.commit(rows[at]!, !toggles);
		this.touch();
	}

	#noteFromPointer(keypath: string): void {
		const [list, rowKey] = keypath.split("/").slice(-2);
		if (list && /^q\d+$/.test(list)) {
			if (list !== `q${this.current}`) return;
			const question = this.questions[this.current]!;
			const at = this.rows(question).findIndex(row => row.key === rowKey);
			if (at < 0) return;
			this.states[this.current]!.cursor = at;
			this.pageOffset = undefined;
		}
		const question = this.questions[this.current];
		const state = this.states[this.current];
		const row = question && state ? this.rows(question)[state.cursor] : undefined;
		if (row) void this.#promptNote(row);
	}

	#prompt(
		prompt: AskDialogPrompt,
		prefill: AskDialogPromptValue | undefined,
	): Promise<string | AskDialogPromptValue | AskDialogPromptDraft | undefined> {
		return this.callbacks.onImagePrompt
			? this.callbacks.onImagePrompt(prompt, prefill)
			: this.callbacks.onPrompt(prompt, prefill?.text);
	}

	async #promptCustom(row: AskRow): Promise<void> {
		const index = this.current;
		const question = this.questions[index]!;
		const state = this.states[index]!;
		this.#promptActive = true;
		try {
			const prefill =
				state.customDraft ??
				(state.customInput === undefined
					? undefined
					: { text: state.customInput, images: state.customInputImages });
			const outcome = promptOutcome(
				await this.#prompt({ title: "Custom answer", question: question.question }, prefill),
			);
			if (this.closed) return;
			if (!outcome.submitted) {
				const draft = outcome.draft;
				state.customDraft = draft && (draft.text.trim() !== "" || draft.images?.length) ? draft : undefined;
				return;
			}
			state.customDraft = undefined;
			if (outcome.text.trim() === "") {
				state.customInput = undefined;
				state.customInputImages = undefined;
				if (state.noteRowKey === row.key) clearNote(state);
				return;
			}
			state.customInput = outcome.text;
			state.customInputImages = outcome.images;
			if (!question.multi) {
				state.selected.clear();
				if (state.noteRowKey !== undefined && state.noteRowKey !== row.key) clearNote(state);
			}
			if (!question.multi || this.questions.length > 1) this.advance();
		} finally {
			this.#promptActive = false;
			if (this.#timeoutExpired) {
				this.#timeoutExpired = false;
				this.#timeout();
			}
			this.touch();
		}
	}

	async #promptNote(row: AskRow): Promise<void> {
		this.resetCountdown();
		const question = this.questions[this.current]!;
		const state = this.states[this.current]!;
		this.#promptActive = true;
		try {
			const prefill =
				state.noteRowKey === row.key && state.note !== undefined
					? { text: state.note, images: state.noteImages }
					: undefined;
			const outcome = promptOutcome(
				await this.#prompt({ title: `Note for ${row.label}`, question: question.question }, prefill),
			);
			if (this.closed || !outcome.submitted) return;
			state.note = outcome.text;
			state.noteImages = outcome.images;
			state.noteRowKey = row.key;
		} finally {
			this.#promptActive = false;
			if (this.#timeoutExpired) {
				this.#timeoutExpired = false;
				this.#timeout();
			}
			this.touch();
		}
	}

	#timeout(): void {
		if (this.closed) return;
		if (this.#promptActive) {
			this.#timeoutExpired = true;
			return;
		}
		this.options.onTimeout?.();
		this.questions.forEach((question, index) => {
			const state = this.states[index]!;
			if (isAnswered(state)) return;
			const noted = Number(/^option:(\d+)$/.exec(state.noteRowKey ?? "")?.[1] ?? Number.NaN);
			const fallback =
				Number.isInteger(noted) && question.options[noted]
					? noted
					: clamp(question.recommended ?? 0, 0, Math.max(0, question.options.length - 1));
			const option = question.options[fallback];
			if (option) state.selected.add(option.label);
			state.timedOut = true;
		});
		this.finishSubmit();
	}

	finishSubmit(): void {
		if (this.closed) return;
		this.closed = true;
		this.callbacks.onSubmit({ kind: "submit", results: this.results() });
	}

	finishCancel(): void {
		if (this.closed) return;
		this.closed = true;
		this.callbacks.onCancel();
	}

	results(): ExtensionAskDialogResultItem[] {
		return this.questions.map((question, index) => {
			const state = this.states[index]!;
			const note = submittedNote(question, state);
			return {
				id: question.id,
				question: question.question,
				options: question.options.map(option => option.label),
				multi: question.multi ?? false,
				selectedOptions: question.options.map(option => option.label).filter(label => state.selected.has(label)),
				customInput: state.customInput,
				customInputImages: state.customInputImages,
				note: note?.text,
				noteImages: note === undefined ? undefined : state.noteImages,
				noteOption: note?.option,
				timedOut: state.timedOut || undefined,
			};
		});
	}
}

/** The pills (or typed answer) under a folded question, keyed `nodeKey`; the `+N` pill sends `more`. */
export function FoldSummaryNode(props: {
	readonly summary: AskFoldSummary;
	readonly nodeKey: string;
	readonly more: string;
}): JSXNode {
	const { summary, nodeKey: key } = props;
	const note = summary.note ? (
		<text
			role="omp.ask.fold.note"
			truncate="end"
			lines={1}
			spans={[
				{ s: "dim", t: "✎ " },
				{ s: "em", t: summary.note },
			]}
		/>
	) : null;
	if (summary.kind === "answer") {
		if (!note)
			return (
				<text
					key={key}
					motionKey={key}
					role="omp.ask.fold.answer"
					truncate="end"
					lines={1}
					spans={[{ s: "muted", t: summary.text }]}
				/>
			);
		return (
			<row key={key} motionKey={key} role="omp.ask.pills" gap="xs" align="center">
				<text role="omp.ask.fold.answer" truncate="end" lines={1} spans={[{ s: "muted", t: summary.text }]} />
				{note}
			</row>
		);
	}
	const { shown, hidden } = foldPills(summary.pills);
	return (
		<row key={key} motionKey={key} role="omp.ask.pills" gap="xs" align="center" wrap>
			{shown.map((pill, i) => (
				<button
					key={`p${i}`}
					role="omp.ask.pill"
					text={pill.cut}
					size="sm"
					actions={{ click: pill.act }}
					on={pill.chosen ? true : undefined}
					icon={pill.chosen ? "check" : undefined}
					title={pill.cut === pill.label ? undefined : pill.label}
				/>
			))}
			{hidden > 0 && (
				<button
					key="more"
					role="omp.ask.pill.more"
					text={`+${hidden}`}
					size="sm"
					actions={{ click: props.more }}
					title="Show every option"
				/>
			)}
			{shown.some(pill => pill.chosen) && note}
		</row>
	);
}

function FoldedQuestion(props: { readonly model: AskDialogModel; readonly index: number }): JSXNode {
	const { model, index } = props;
	const answered = model.answered(index);
	return (
		<col
			key={`q${index}`}
			motionKey={`q${index}`}
			role="omp.ask.fold"
			gap="xs"
			title="Answer this question"
			actions={{ click: `open:${index}` }}
		>
			<row role="omp.ask.fold.head" gap="sm" align="baseline">
				<text role="omp.ask.fold.mark" spans={[answered ? { s: "success", t: "✓" } : { s: "muted", t: "○" }]} />
				<text role="omp.ask.fold.question" wrap="word" spans={inlineCodeSpans(model.foldQuestion(index))} />
			</row>
			<FoldSummaryNode summary={model.foldSummary(index)} nodeKey={`q${index}.summary`} more={`open:${index}`} />
		</col>
	);
}

function OpenQuestion(props: { readonly model: AskDialogModel; readonly index: number }): JSXNode {
	const { model, index } = props;
	const question = model.questions[index]!;
	const state = model.states[index]!;
	const rows = model.rows(question);
	state.cursor = clamp(state.cursor, 0, Math.max(0, rows.length - 1));
	const header = question.header?.trim();
	const highlighted = rows[state.cursor];
	const preview =
		highlighted?.kind === "option" ? question.options[highlighted.optionIndex ?? -1]?.preview?.trim() : undefined;
	return (
		<col
			key={`q${index}`}
			motionKey={`q${index}`}
			role="omp.ask.open"
			gap="sm"
			reveal={{ at: "start", n: model.reveal }}
		>
			{header && <text role="omp.ask.header" spans={[{ s: "muted", t: replaceTabs(header) }]} />}
			<md key="question" role="omp.ask.question" text={replaceTabs(sanitizeCarriageReturns(question.question))} />
			<list key={`q${index}`} role="omp.ask.options" selected={highlighted?.key ?? null}>
				{rows.map(row => {
					const option = row.kind === "option" ? question.options[row.optionIndex ?? -1] : undefined;
					const checked =
						row.kind === "other"
							? state.customInput !== undefined
							: option !== undefined && state.selected.has(option.label);
					const detail: TspSpan[] = [];
					if (row.kind === "option") {
						const description = option?.description?.trim();
						if (description) detail.push(...inlineCodeSpans(inlineText(description)));
					} else if (state.customInput !== undefined) detail.push({ t: `“${inlineText(state.customInput)}”` });
					if (state.note && state.noteRowKey === row.key) {
						detail.push(
							{ s: "dim", t: `${detail.length > 0 ? "  " : ""}✎ ` },
							{ s: "em", t: inlineText(state.note) },
						);
					}
					if (detail.length === 0 && row.kind === "other") detail.push({ t: "Type your own answer" });
					const role =
						row.kind === "other"
							? question.multi
								? "omp.ask.other.check"
								: "omp.ask.other"
							: question.multi
								? "omp.ask.check"
								: "omp.ask.option";
					return (
						<item
							key={row.key}
							role={role}
							label={
								row.kind === "other"
									? [{ t: OTHER_LABEL }]
									: optionLabelSpans(question, row.optionIndex!, row.label)
							}
							detail={detail.length > 0 ? detail : undefined}
							value={
								row.kind === "option" && question.recommended === row.optionIndex
									? [{ t: "Recommended" }]
									: undefined
							}
							tone={checked ? "accent" : undefined}
							icon={checked && question.multi ? "check" : undefined}
							actions={{ menu: ["note"] }}
						/>
					);
				})}
			</list>
			{preview && (
				<md
					key="preview"
					role="omp.ask.preview"
					text={replaceTabs(question.options[highlighted!.optionIndex!]!.preview!)}
				/>
			)}
		</col>
	);
}

export interface AskDialogProps {
	readonly model: AskDialogModel;
}

export function AskDialog(props: AskDialogProps): JSXNode {
	const { model } = props;
	if (model.remaining !== undefined) {
		const timer = setInterval(() => model.tick(), 1000);
		timer.unref?.();
		onCleanup(() => clearInterval(timer));
	}
	const skip = () => model.options.skipNotice?.();
	return (
		<col
			role="omp.ask.card"
			gap="md"
			transition="layout"
			reveal="start"
			term={() => (model.rev(), { model })}
			onKey={key => model.key(key.id, key.text)}
			onAction={(act, event) => model.action(act, event.key)}
			onSelect={(item, event) => model.rowEvent("select", event.key, item)}
			onActivate={(item, event) => model.rowEvent("activate", event.key, item)}
		>
			{() => {
				model.rev();
				const total = model.questions.length;
				const answered = model.states.filter(isAnswered).length;
				return (
					<row key="head" motionKey="head" role="omp.ask.card.head" gap="sm" align="baseline" justify="between">
						<text role="omp.ask.card.tag" spans={[{ s: "accent", t: "ask" }]} />
						{total > 1 && (
							<text
								role="omp.ask.card.progress"
								spans={[{ s: "muted", t: `${answered} of ${total} answered` }]}
							/>
						)}
					</row>
				);
			}}
			<col key="body" role="omp.ask.card.body" gap="lg" mark={() => (skip() ? "drop" : undefined)}>
				{() => {
					model.rev();
					return model.questions.map((_, index) =>
						index === model.current ? (
							<OpenQuestion model={model} index={index} />
						) : (
							<FoldedQuestion model={model} index={index} />
						),
					);
				}}
			</col>
			{() => {
				const notice = skip();
				return (
					notice && (
						<text
							key="skip"
							motionKey="skip"
							role="omp.ask.skip"
							wrap="word"
							spans={[{ s: "warning", t: `⚠ ${notice}` }]}
						/>
					)
				);
			}}
			<row key="actions" motionKey="actions" role="omp.actions" align="center" gap="sm">
				{model.options.timeout !== undefined && model.options.timeout > 0 && (
					<elapsed format="short" age={-model.options.timeout} />
				)}
				<spacer grow={1} />
				<ActionButton id="note" label="Note" title="Add a note to the highlighted answer  n" keys={["n"]} />
				<ActionButton id="cancel" label="Cancel" title="Cancel without answering" />
				<ActionButton id="submit" label="Submit" title="Submit the answers" tone="accent" />
			</row>
		</col>
	);
}
