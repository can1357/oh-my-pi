/**
 * TTS/STT Submit Trigger options and evaluation logic.
 */

export const STT_SUBMIT_TRIGGER_VALUES = ["never", "release", "release-complete", "say-submit"] as const;

export type SttSubmitTrigger = (typeof STT_SUBMIT_TRIGGER_VALUES)[number];

export const STT_SUBMIT_TRIGGER_OPTIONS = [
	{
		value: "never",
		label: "Never",
		description: "Never automatically submit; insert dictation and remain in editor.",
	},
	{
		value: "release",
		label: "Release",
		description: "Submit on release if the utterance has 2+ words to avoid accidental sends.",
	},
	{
		value: "release-complete",
		label: "Release with complete sentence",
		description: "Submit on release if the utterance ends with sentence-terminal punctuation (. ? ! etc.).",
	},
	{
		value: "say-submit",
		label: "When I Say Submit",
		description: "Submit if the utterance ends with a word containing 'submit' (strips that word before submitting).",
	},
] satisfies ReadonlyArray<{ value: SttSubmitTrigger; label: string; description: string }>;

/**
 * Evaluate the submit trigger against a transcribed utterance.
 * Returns whether to submit, and the number of characters to trim from the end of the utterance.
 */
export function evaluateSubmitTrigger(
	utterance: string,
	trigger: SttSubmitTrigger,
): { submit: boolean; trimTrailing: number } {
	const trimmed = utterance.trim();
	if (!trimmed) {
		return { submit: false, trimTrailing: 0 };
	}

	if (trigger === "never") {
		return { submit: false, trimTrailing: 0 };
	}

	if (trigger === "release") {
		// Split by whitespace and count words
		const words = trimmed.split(/\s+/).filter(Boolean);
		const submit = words.length >= 2;
		return { submit, trimTrailing: 0 };
	}

	if (trigger === "release-complete") {
		// Matches typical sentence terminators: . ? ! ... or full-width equivalents, optionally followed by space
		const hasTerminalPunctuation = /[.?!…。？！]\s*$/.test(trimmed);
		return { submit: hasTerminalPunctuation, trimTrailing: 0 };
	}

	if (trigger === "say-submit") {
		// Matches space followed by any word containing "submit" (case-insensitive), optionally followed by punctuation/spaces
		// Also handles the case where "submit" is the only word in the utterance (no leading space)
		const match = utterance.match(/(?:^|\s+)(\S*submit\S*)[.?!…。？！]*\s*$/i);
		if (match && match.index !== undefined) {
			const trimTrailing = utterance.length - match.index;
			return { submit: true, trimTrailing };
		}
		return { submit: false, trimTrailing: 0 };
	}

	return { submit: false, trimTrailing: 0 };
}
