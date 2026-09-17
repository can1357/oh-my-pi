/**
 * TypeSafe Choice answer validation — ported from browser-use/jev-ultrafast model.py.
 * Ensures probability mass, finite values, and choice/max alignment before acting.
 */

export interface ChoiceAnswerWire {
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

/** Reject malformed System One choice payloads before they drive automation. */
export function validateChoiceAnswer(answer: ChoiceAnswerWire, allowedIds: ReadonlySet<string>): ChoiceAnswerWire {
	try {
		const { probabilities, confidence, choice } = answer;
		const numbers = [...Object.values(probabilities), confidence];
		const ids = new Set(Object.keys(probabilities));
		const valid =
			allowedIds.has(choice) &&
			ids.size === allowedIds.size &&
			[...ids].every(id => allowedIds.has(id)) &&
			numbers.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
			Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) < 0.02 &&
			(probabilities[choice] ?? 0) >= Math.max(...Object.values(probabilities)) - 1e-6;
		if (!valid) throw new Error("invalid");
	} catch {
		throw new Error("Invalid TypeSafe response; no action executed.");
	}
	return answer;
}
