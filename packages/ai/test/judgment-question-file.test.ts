import { describe, expect, it } from "bun:test";
import { judgeQuestions } from "@oh-my-pi/pi-ai";

describe("judgeQuestions", () => {
	it("derives each question's kind from the shape of its criteria", () => {
		const questions = judgeQuestions({
			severity: { instructions: "How bad?", criteria: ["calm", "angry"] },
			urgent: { instructions: "Urgent?" },
			stopped: { instructions: "Stopped?", criteria: { true: "Says it will act, then ends.", false: null } },
			tier: { instructions: "Which tier?", criteria: { low: "trivial", high: null } },
			row: { instructions: "Which row?", criteria: {} },
		});
		expect(questions).toEqual({
			severity: { type: "score", instructions: "How bad?", criteria: ["calm", "angry"] },
			urgent: { type: "noul", instructions: "Urgent?" },
			stopped: { type: "noul", instructions: "Stopped?", criteria: { true: "Says it will act, then ends." } },
			tier: { type: "choice", instructions: "Which tier?", criteria: { low: "trivial", high: null } },
			row: { type: "choice", instructions: "Which row?", criteria: {} },
		});
	});

	it("rejects a score question with a single level", () => {
		expect(() => judgeQuestions({ severity: { instructions: "How bad?", criteria: ["calm"] } })).toThrow(
			'score question "severity" needs at least two levels',
		);
	});
});
