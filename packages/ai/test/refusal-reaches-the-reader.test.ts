/**
 * A refused retry wait is only useful if it reaches whoever needs it: a person
 * reading the failure, and a layer above deciding whether to try again.
 *
 * Four review rounds found six ways it did not. Every one was the same shape —
 * the refusal recorded on an object that is then replaced, or recorded as a
 * field nothing renders — so these guards assert at the two places that matter:
 * what a reader is shown, and what a recovery layer does. They do not assert
 * which function wrote it.
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { assistantErrorText, assistantTurnError } from "@oh-my-pi/pi-ai/utils/retry-wait-display";
import { type RefusedRetryWait, retryWaitRefusal } from "@oh-my-pi/pi-ai/utils/retry-wait";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";

const REFUSED: RefusedRetryWait = { waitMs: 30_000, limitMs: 10_000, option: "providerRetryWaitCeilingMs" };

function failedTurn(fields: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "wire",
		model: "wire-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		stopReason: "error",
		timestamp: 1,
		...fields,
	} as AssistantMessage;
}

describe("a recorded refusal reaches a reader", () => {
	it("says which bound refused the wait even when the provider sent no text", () => {
		// A failure with no text at all is a legal message, and the bound that
		// stopped the retry is then the whole of what there is to say about it.
		// Recording only the field left the reader the word "Error".
		const output = failedTurn();
		AIError.recordRefusedRetryWait(output, REFUSED);

		expect(output.errorRetryWaitRefusal).toEqual(REFUSED);
		expect(assistantErrorText(output)).toContain("the caller's 10 s providerRetryWaitCeilingMs refused it");
	});

	it("completes a refusal that arrived as the field alone", () => {
		// A relay copies fields, not the words built in the process it came
		// from, so a refusal crossing a process boundary arrives half-recorded.
		const relayed = failedTurn({ errorMessage: "503 overloaded", errorRetryWaitRefusal: REFUSED });
		AIError.recordRefusedRetryWait(relayed, REFUSED);

		expect(assistantErrorText(relayed)).toContain("the caller's 10 s providerRetryWaitCeilingMs refused it");
		// The provider's own words stay the provider's own: a classifier reads them.
		expect(relayed.errorMessage).toBe("503 overloaded");
	});

	it("appends the note once however many layers record the same refusal", () => {
		const output = failedTurn({ errorMessage: "503 overloaded" });
		AIError.recordRefusedRetryWait(output, REFUSED);
		AIError.recordRefusedRetryWait(output, REFUSED);

		const shown = assistantErrorText(output);
		expect(shown.indexOf("so the provider did not retry")).toBe(shown.lastIndexOf("so the provider did not retry"));
	});
});

describe("a refusal survives becoming an Error", () => {
	it("carries the mark a thrown turn failure is rebuilt from", () => {
		// The words survive for whoever prints this Error at once, which is why
		// the missing mark was easy to miss: everyone further away — a recovery
		// layer, a relay that rebuilds a message from it — saw nothing.
		const thrown = assistantTurnError(
			failedTurn({
				errorMessage: "503 overloaded",
				errorDisplayMessage:
					"503 overloaded (server asked to wait 30 s before retrying; the caller's 10 s providerRetryWaitCeilingMs refused it, so the provider did not retry)",
				errorRetryWaitRefusal: REFUSED,
			}),
		);

		expect(retryWaitRefusal(thrown)).toEqual(REFUSED);
		// And the provider's own text is still what the Error's message says.
		expect(thrown.message).toBe("503 overloaded");
	});

	it("leaves an unrefused failure unmarked", () => {
		expect(retryWaitRefusal(assistantTurnError(failedTurn({ errorMessage: "503 overloaded" })))).toBeUndefined();
	});
});
