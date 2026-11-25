import { type FormAnswer, type OptionNote } from "../html-form/data";

/** Answers and selected-option notes displayed for an ask tool result. */
export interface AskToolDetails {
	/** Each named field's question and answer text, in form order (from `formAnswers`). */
	answers: FormAnswer[];
	/** Notes attached to selected options; separate from the answer data. */
	notes?: OptionNote[];
	/** The deadline submitted the form's current values instead of the user. */
	timedOut?: boolean;
}
