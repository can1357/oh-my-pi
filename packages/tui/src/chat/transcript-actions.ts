/**
 * Pointer actions on transcript blocks in a native terminal (a user message's
 * hover toolbar, an error frame's action row). Blocks describe the controls;
 * the interactive host registers the one handler that runs omp's existing
 * commands for them, so a click and the key binding take the same path.
 */
import type { TspMenuEntry } from "@oh-my-pi/pi-wire";
import type { SpotlightDetails } from "./spotlight";

/**
 * A transcript message a turn action names: its role and when it was sent (its `timestamp`, ms), which the
 * host resolves to the session entry on the current branch.
 */
export interface TurnMessage {
	readonly role: "user" | "assistant";
	readonly at: number;
}

/**
 * What a turn's hold menu runs on its message: `edit` rewinds past the prompt and puts it in the editor
 * (Edit & resend), `retry` rewinds past the prompt and sends it again, `rewind` opens the rewind selector on
 * the message, `fork` copies the session up to the message into a new one.
 */
export type TurnAct = "edit" | "retry" | "rewind" | "fork";

export type TranscriptAction =
	/** Retry the last failed turn (`app.retry`). */
	| { readonly act: "retry" }
	/** Open the temporary model picker (`app.model.selectTemporary`). */
	| { readonly act: "switch-model" }
	/** Open the transcript rewind selector. */
	| { readonly act: "rewind" }
	/** Run a turn's hold-menu action on `message`. */
	| { readonly act: "turn"; readonly turn: TurnAct; readonly message: TurnMessage }
	/** Resume the session stored at `path` (a welcome card's recent session). */
	| { readonly act: "resume"; readonly path: string }
	/** Put `text` on the clipboard. */
	| { readonly act: "copy"; readonly text: string }
	/**
	 * Open the Spotlight sheet of a shaped tool result: its original beside `reduced`, the text the model saw (a
	 * held-out result's sheet shows the would-be text its trace's `shapedUrl` names instead).
	 */
	| {
			readonly act: "spotlight";
			readonly toolCallId: string;
			readonly spotlight: SpotlightDetails;
			readonly reduced: string;
	  };

type Handler = (action: TranscriptAction) => void;

let handler: Handler | undefined;

/** Register (or clear, with `undefined`) the host's handler. */
export function setTranscriptActionHandler(next: Handler | undefined): void {
	handler = next;
}

/** Run `action` through the host; false when no host handles actions. */
export function runTranscriptAction(action: TranscriptAction): boolean {
	if (!handler) return false;
	handler(action);
	return true;
}

/** Whether a host handles actions (controls are only described when one does). */
export function hasTranscriptActions(): boolean {
	return handler !== undefined;
}

/** The hold-menu action names of each {@link TurnAct}. */
const TURN_ACTS: Readonly<Record<string, TurnAct>> = {
	"edit-turn": "edit",
	"retry-turn": "retry",
	"rewind-turn": "rewind",
	"fork-turn": "fork",
};

/**
 * A turn's `actions.hold`: what a long press on it offers on a phone, led by its copy entry (`copy`), then
 * Edit & resend (a prompt's only), Retry turn, Rewind to here… and Fork from here. A desktop ignores it, so
 * the hover toolbars stay its controls.
 */
export function turnHoldEntries(role: TurnMessage["role"], copy: TspMenuEntry): TspMenuEntry[] {
	return [
		copy,
		...(role === "user" ? [{ id: "edit-turn", label: "Edit & resend", icon: "edit", detail: "To composer" }] : []),
		{ id: "retry-turn", label: "Retry turn", icon: "refresh" },
		{ id: "rewind-turn", label: "Rewind to here…", icon: "rewind" },
		{ id: "fork-turn", label: "Fork from here", icon: "branch", detail: "New session" },
	];
}

/** Runs hold-menu action `act` (a {@link turnHoldEntries} id) on `message`; false when `act` is no turn action. */
export function runTurnAction(act: string, message: TurnMessage): boolean {
	const turn = TURN_ACTS[act];
	if (!turn) return false;
	runTranscriptAction({ act: "turn", turn, message });
	return true;
}
