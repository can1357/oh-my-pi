import type { TspMenuEntry, TspSpan } from "@oh-my-pi/pi-wire";
import type { Component, TUI } from "../tui";
import { sanitizeErrorLine } from "../chrome/error-block";
import { col, keyed, md, node, row, span, text } from "../native/describe";
import type { NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwTopicLabel,
	getBtwTurns,
	splitBtwInject,
} from "./btw-history";
import { describeBtwStatus } from "./btw-history-panel";
import { type BtwInjectState, describeBtwInjectAnswer } from "./btw-inject";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./extensions/display-text";

/** What a press on a note asks of its controller; also the ids of its menu entries. */
export type BtwNoteAction =
	| "btw-focus"
	| "btw-expand"
	| "btw-fold"
	| "btw-copy"
	| "btw-inject"
	| "btw-branch"
	| "btw-stop"
	| "btw-history";

const ACTIONS: Record<BtwNoteAction, true> = {
	"btw-focus": true,
	"btw-expand": true,
	"btw-fold": true,
	"btw-copy": true,
	"btw-inject": true,
	"btw-branch": true,
	"btw-stop": true,
	"btw-history": true,
};

function isNoteAction(act: string): act is BtwNoteAction {
	return Object.hasOwn(ACTIONS, act);
}

/** The controller behind a note: its menu, its `<inject>` blocks, and what its presses do. */
export interface BtwNoteHost {
	/** Right-click (and a phone's long-press) entries for the note's topic as it stands. */
	menu(record: BtwHistoryRecord, folded: boolean): readonly TspMenuEntry[];
	/** How turn `turnIndex`'s `<inject>` block shows apart from its prose; undefined: as plain text. */
	injectState(record: BtwHistoryRecord, turnIndex: number): BtwInjectState | undefined;
	/** A click on the note, its folded line or its tools, or a chosen menu entry. */
	run(record: BtwHistoryRecord, action: BtwNoteAction): void;
}

const NO_ROWS: readonly string[] = [];

/**
 * A `/btw` side question drawn in Tern's transcript where it was asked: the topic, its
 * answers and follow-ups, never part of the session or sent to the model. Clicking it
 * makes the composer talk to it (`active`); its × folds it to one line, which a click
 * opens again. Native only: the text renderer keeps its inline panel.
 */
export class BtwNoteComponent implements Component {
	readonly #tui: TUI;
	readonly #host: BtwNoteHost;
	#record: BtwHistoryRecord;
	#folded: boolean;
	#active = false;
	#native: NativeNode | undefined;

	constructor(options: { record: BtwHistoryRecord; folded: boolean; tui: TUI; host: BtwNoteHost }) {
		this.#record = options.record;
		this.#folded = options.folded;
		this.#tui = options.tui;
		this.#host = options.host;
	}

	get record(): BtwHistoryRecord {
		return this.#record;
	}

	get folded(): boolean {
		return this.#folded;
	}

	/** Takes the topic's latest snapshot (a streamed delta, a new follow-up, a status change). */
	update(record: BtwHistoryRecord): void {
		this.#record = record;
		this.refresh();
	}

	setFolded(folded: boolean): void {
		if (this.#folded === folded) return;
		this.#folded = folded;
		this.refresh();
	}

	/** Marks the note the composer talks to. */
	setActive(active: boolean): void {
		if (this.#active === active) return;
		this.#active = active;
		this.refresh();
	}

	/** Describes the note again: its menu or inject state changed outside it. */
	refresh(): void {
		this.#native = undefined;
		this.#tui.requestComponentRender(this);
	}

	render(): readonly string[] {
		return NO_ROWS;
	}

	invalidate(): void {
		this.#native = undefined;
	}

	describe(): NativeNode {
		this.#native ??= this.#folded ? this.#describeFolded() : this.#describeOpen();
		return this.#native;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && isNoteAction(event.act)) this.#host.run(this.#record, event.act);
	}

	/** One line: the tag and the topic, a spinner while it answers. */
	#describeFolded(): NativeNode {
		const menu = this.#host.menu(this.#record, true);
		const running = getBtwLatestTurn(this.#record).status === "running";
		const topic: TspSpan[] = [span("btw", "accent"), span("  "), ...topicSpans(getBtwTopicLabel(this.#record))];
		return row(
			[
				node("icon", { name: "chev-r" }, undefined, "chev"),
				text(topic, { role: "omp.btw.note.topic", truncate: "end", lines: 1 }),
				...(running ? [node("spinner", {}, undefined, "spinner")] : []),
			],
			{
				role: "omp.btw.note.folded",
				gap: "sm",
				align: "center",
				title: "Show this side answer",
				actions: { click: "btw-expand", menu, hold: menu },
			},
		);
	}

	/** The topic over its answers; follow-ups under a hairline each, then the status. */
	#describeOpen(): NativeNode {
		const record = this.#record;
		const menu = this.#host.menu(record, false);
		const tools: NativeChild[] = [];
		if (getBtwCopyText(record) !== undefined) {
			tools.push(
				node(
					"icon",
					{ name: "copy", role: "omp.btw.note.tool", title: "Copy answer", actions: { click: "btw-copy" } },
					undefined,
					"copy",
				),
			);
		}
		tools.push(
			node(
				"icon",
				{ name: "x", role: "omp.btw.note.tool", title: "Fold to one line", actions: { click: "btw-fold" } },
				undefined,
				"fold",
			),
		);
		const head = row(
			[
				text([span("btw", "accent")], { role: "omp.btw.note.tag" }),
				// Markdown, so the question's inline code and links render.
				md(sanitizeDisplayText(getBtwTopicLabel(record)), { role: "omp.btw.note.question" }),
				row(tools, { role: "omp.btw.note.tools", gap: "xs", align: "center" }),
			],
			{ role: "omp.btw.note.head", gap: "sm", align: "start" },
		);
		const children: NativeChild[] = [keyed(head, "head")];
		getBtwTurns(record).forEach((turn, index) => {
			children.push(this.#describeTurn(turn, index));
		});
		const status = describeBtwStatus(getBtwLatestTurn(record).status);
		if (status) children.push(keyed(text(status, { role: "omp.btw.note.status" }), "status"));
		return col(children, {
			role: this.#active ? "omp.btw.note.active" : "omp.btw.note",
			gap: "sm",
			actions: { click: "btw-focus", menu, hold: menu },
		});
	}

	/** An answer; a follow-up's question heads its own. A failed turn says why. */
	#describeTurn(turn: BtwHistoryTurn, index: number): NativeNode {
		const children: NativeChild[] = [];
		if (index > 0) {
			children.push(md(sanitizeDisplayText(turn.question), { role: "omp.btw.followup" }));
		}
		const stream = turn.status === "running";
		if (turn.answer.trim() || !turn.error) {
			const state = this.#host.injectState(this.#record, index);
			const parts = state ? splitBtwInject(turn.answer) : undefined;
			// An unclosed block in a finished answer stays plain text.
			children.push(
				parts && (parts.closed || stream)
					? describeBtwInjectAnswer(parts, state === "sent", stream)
					: turn.answer.trim()
						? md(sanitizeDisplayText(turn.answer), { stream })
						: text([span(stream ? "Thinking…" : "No answer text.", "dim")], { role: "omp.btw.pending" }),
			);
		}
		if (turn.error) {
			children.push(text([span(sanitizeErrorLine(turn.error), "error")], { role: "omp.btw.error", wrap: "word" }));
		}
		return keyed(col(children, { role: "omp.btw.note.turn", gap: "sm" }), `turn-${index}`);
	}
}

/** A topic on one line: its `code` as mono, without the backticks. */
function topicSpans(label: string): TspSpan[] {
	return sanitizeDisplayLine(label)
		.split(/`([^`]+)`/)
		.flatMap((part, index) => (part ? [span(part, index % 2 === 1 ? "mono" : undefined)] : []));
}
