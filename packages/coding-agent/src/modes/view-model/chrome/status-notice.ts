/** A button on a notice's native toast (the Undo after a rewind). */
export interface StatusNoticeAction {
	/** The toast's action name (`undo`). */
	readonly act: string;
	/** The button's text. */
	readonly label: string;
	/** Runs when the button is clicked. */
	readonly run: () => void;
}
