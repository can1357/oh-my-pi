/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A side-question note in the transcript (native face): the topic head
 * (`btw` tag, question, copy/fold tools), one column per turn, and the
 * latest turn's status; folded, a one-line topic that opens on click.
 *
 * The host supplies the right-click menu, how each turn's `<inject>` block
 * shows, and runs presses. Host answers are read when the note renders:
 * bump `revision` after they change.
 */
import { type Accessor, type JSXNode, untrack } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { BtwInjectState } from "../../../modes/view-model/overlays/btw-inject";
import type { BtwNoteAction, BtwNoteHost } from "../../../modes/view-model/overlays/btw-note";
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwTurns,
} from "../../../session/btw-history-model";
import { BtwAnswerBody, flatError, topicSpans } from "./btw-answer";

export interface BtwNoteProps {
	readonly record: Accessor<BtwHistoryRecord>;
	readonly folded: Accessor<boolean>;
	/** The note the composer's follow-ups go to. */
	readonly active?: Accessor<boolean>;
	/** Bumped when the host's answers (menu, inject states) changed. */
	readonly revision?: Accessor<number>;
	readonly host: BtwNoteHost;
}

/** A turn's status line, when it has one. */
export function turnStatusSpans(turn: BtwHistoryTurn): TspSpan[] | undefined {
	switch (turn.status) {
		case "running":
			return [
				{ s: "accent", t: "●", fx: "pulse" },
				{ s: "accent", t: " Answering" },
			];
		case "error":
			return [{ s: "error", t: "Failed" }];
		case "interrupted":
			return [{ s: "warning", t: "Interrupted" }];
		case "cancelled":
			return [{ s: "warning", t: "Cancelled" }];
		default:
			return undefined;
	}
}

/** The body of one turn: its answer, a placeholder, and its error. */
export function BtwTurnBody(props: {
	readonly turn: BtwHistoryTurn;
	readonly inject: BtwInjectState | undefined;
}): JSXNode {
	const { turn } = props;
	const hasAnswer = turn.answer.trim() !== "";
	const out: JSXNode[] = [];
	if (hasAnswer)
		out.push(<BtwAnswerBody answer={turn.answer} inject={props.inject} stream={turn.status === "running"} />);
	else if (turn.status === "running") out.push(<text role="omp.btw.pending" spans={[{ s: "dim", t: "Thinking…" }]} />);
	if (turn.status === "error") {
		out.push(<text role="omp.btw.error" wrap="word" spans={[{ s: "error", t: flatError(turn.error) }]} />);
	} else if (!hasAnswer && turn.status !== "running") {
		out.push(<text role="omp.btw.pending" spans={[{ s: "dim", t: "No answer text." }]} />);
	}
	return out;
}

const NOTE_ACTIONS: ReadonlySet<string> = new Set<BtwNoteAction>([
	"btw-focus",
	"btw-blur",
	"btw-expand",
	"btw-fold",
	"btw-copy",
	"btw-inject",
	"btw-branch",
	"btw-stop",
	"btw-history",
]);

export function BtwNote(props: BtwNoteProps): JSXNode {
	const run = (action: string): void => {
		if (NOTE_ACTIONS.has(action)) props.host.run(props.record(), action as BtwNoteAction);
	};
	return () => {
		const record = props.record();
		const folded = props.folded();
		const active = props.active?.() ?? false;
		props.revision?.();
		return untrack(() => {
			const menu = props.host.menu(record, folded);
			const latest = getBtwLatestTurn(record);
			const topic = record.title ?? record.question;
			if (folded) {
				return (
					<row
						role="omp.btw.note.folded"
						align="center"
						gap="sm"
						title="Show this side answer"
						actions={{ click: "btw-expand", menu, hold: menu }}
						onAction={run}
					>
						<icon key="chev" name="chev-r" />
						<text
							role="omp.btw.note.topic"
							lines={1}
							truncate="end"
							spans={[{ s: "accent", t: "btw" }, { t: "  " }, ...topicSpans(topic)]}
						/>
						{latest.status === "running" && <spinner key="spinner" />}
					</row>
				);
			}
			const status = turnStatusSpans(latest);
			return (
				<col
					role={active ? "omp.btw.note.active" : "omp.btw.note"}
					gap="sm"
					actions={
						active
							? { click: "btw-focus", menu, hold: menu, outside: "btw-blur" }
							: { click: "btw-focus", menu, hold: menu }
					}
					onAction={run}
				>
					<row key="head" role="omp.btw.note.head" align="start" gap="sm">
						<text role="omp.btw.note.tag" spans={[{ s: "accent", t: "btw" }]} />
						<md role="omp.btw.note.question" text={topic} />
						<row role="omp.btw.note.tools" align="center" gap="xs">
							{getBtwCopyText(record) !== undefined && (
								<icon
									key="copy"
									role="omp.btw.note.tool"
									name="copy"
									title="Copy answer"
									actions={{ click: "btw-copy" }}
								/>
							)}
							<icon
								key="fold"
								role="omp.btw.note.tool"
								name="x"
								title="Fold to one line"
								actions={{ click: "btw-fold" }}
							/>
						</row>
					</row>
					{getBtwTurns(record).map((turn, index) => (
						<col key={`turn-${index}`} role="omp.btw.note.turn" gap="sm">
							{index > 0 && <md role="omp.btw.followup" text={turn.question} />}
							<BtwTurnBody turn={turn} inject={props.host.injectState(record, index)} />
						</col>
					))}
					{status && <text key="status" role="omp.btw.note.status" spans={status} />}
				</col>
			);
		});
	};
}
