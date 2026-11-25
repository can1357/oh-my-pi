import type { SpotlightDetails } from "../../tools/details/spotlight";

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
