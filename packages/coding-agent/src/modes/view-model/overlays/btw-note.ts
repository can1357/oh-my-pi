import type { TspMenuEntry } from "@oh-my-pi/pi-wire";
import { type BtwHistoryRecord } from "../../../session/btw-history-model";
import { type BtwInjectState } from "./btw-inject";

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

/** The controller behind a note: its menu, its `<inject>` blocks, and what its presses do. */
export interface BtwNoteHost {
	/** Right-click (and a phone's long-press) entries for the note's topic as it stands. */
	menu(record: BtwHistoryRecord, folded: boolean): readonly TspMenuEntry[];
	/** How turn `turnIndex`'s `<inject>` block shows apart from its prose; undefined: as plain text. */
	injectState(record: BtwHistoryRecord, turnIndex: number): BtwInjectState | undefined;
	/** A click on the note, its folded line or its tools, or a chosen menu entry. */
	run(record: BtwHistoryRecord, action: BtwNoteAction): void;
}
