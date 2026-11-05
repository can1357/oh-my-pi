/**
 * The agent rebuilds a terminal message from a thrown provider error, and that
 * message is the only thing a reader of the turn sees. A wait a layer below
 * already refused has to reach it, or the turn reads as a bare provider
 * failure and a person is never told which bound stopped the retry.
 */
import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { assistantErrorText, assistantTurnError } from "@oh-my-pi/pi-ai/utils/retry-wait-display";
import type { RefusedRetryWait } from "@oh-my-pi/pi-ai/utils/retry-wait";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

const REFUSED: RefusedRetryWait = { waitMs: 30_000, limitMs: 10_000, option: "providerRetryWaitCeilingMs" };

describe("a refusal survives the agent's terminal message", () => {
	it("records a thrown refusal on the message the turn reports", async () => {
		const thrown = assistantTurnError({
			errorMessage: "503 overloaded",
			errorRetryWaitRefusal: REFUSED,
		});
		const agent = new Agent({
			streamFn: () => {
				throw thrown;
			},
		});
		agent.followUp({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
		await agent.continue().catch(() => undefined);

		const last = [...agent.state.messages].reverse().find(m => m.role === "assistant") as
			| AssistantMessage
			| undefined;
		if (!last) throw new Error("Expected the agent to report a failed turn");
		expect(last.errorRetryWaitRefusal).toEqual(REFUSED);
		expect(assistantErrorText(last)).toContain("the caller's 10 s providerRetryWaitCeilingMs refused it");
	});
});
