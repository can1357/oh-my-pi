import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createAssistantMessage, createUserMessage } from "./helpers";

/**
 * Regression coverage for the public continuation branch added with `/continue`:
 * a trailing assistant message with `stopReason: "aborted"` (a user-interrupted
 * partial turn) is the one resumable assistant tail — `Agent.continue()` replays
 * it as assistant prefill so the model continues where the stream cut off,
 * without injecting a new message. Any other assistant tail keeps its existing
 * contract: throw when nothing is queued, drain the queue when it is.
 *
 * These tests drive `Agent.continue()` and assert the provider context carries
 * the original `[user, assistant]` history (no new agent message on the wire),
 * plus the settled-assistant rejection and queued-message precedence that a
 * later role/queue change could silently remove.
 */
describe("Agent.continue() on an aborted assistant tail", () => {
	it("replays the aborted assistant tail as prefill without injecting a new message", async () => {
		const mock = createMockModel({ responses: [{ content: ["ready"] }] });
		const agent = new Agent({ streamFn: mock.stream });

		agent.replaceMessages([
			createUserMessage("Hello"),
			createAssistantMessage([{ type: "text", text: "partial response" }], "aborted"),
		]);

		await expect(agent.continue()).resolves.toBeUndefined();

		expect(mock.calls).toHaveLength(1);
		const wireMessages = mock.calls[0]!.context.messages;
		expect(wireMessages.map(message => message.role)).toEqual(["user", "assistant"]);
		// No new agent message was injected by our side — the aborted tail is
		// replayed verbatim as the last (assistant-prefill) message.
		expect(wireMessages[wireMessages.length - 1]?.role).toBe("assistant");
		expect(agent.state.messages[agent.state.messages.length - 1]?.role).toBe("assistant");
	});

	it("still throws on a settled (non-aborted) assistant tail with nothing queued", async () => {
		const mock = createMockModel({ responses: [{ content: ["ready"] }] });
		const agent = new Agent({ streamFn: mock.stream });

		agent.replaceMessages([createUserMessage("Hello"), createAssistantMessage([{ type: "text", text: "complete" }])]);

		await expect(agent.continue()).rejects.toThrow("Cannot continue from message role: assistant");
		expect(mock.calls).toHaveLength(0);
	});

	it("still drains a queued follow-up after a settled assistant tail", async () => {
		const mock = createMockModel({ responses: [{ content: ["Processed"] }] });
		const agent = new Agent({ streamFn: mock.stream });

		agent.replaceMessages([createUserMessage("Hello"), createAssistantMessage([{ type: "text", text: "complete" }])]);
		agent.followUp(createUserMessage("Queued follow-up"));

		await expect(agent.continue()).resolves.toBeUndefined();

		expect(mock.calls).toHaveLength(1);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(agent.state.messages[agent.state.messages.length - 1]?.role).toBe("assistant");
	});
});
