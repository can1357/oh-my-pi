import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

/**
 * Regression: a `steer` (or follow-up) queued on an empty transcript must be
 * delivered as the opening turn instead of leaving `continue()` to throw
 * `No messages to continue from`. Before the fix the steer stayed queued, so the
 * RPC idle-drain re-armed `continue()` on every microtask (gated only on
 * `hasQueuedMessages()`), an unbounded allocation loop that OOM-killed the
 * process (issue #6344).
 */
describe("Agent.continue() on an empty transcript", () => {
	it("runs a queued steer as the opening turn and drains the queue", async () => {
		const mock = createMockModel({ responses: [{ content: ["Answer"] }] });
		const agent = new Agent({ streamFn: mock.stream });

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		expect(mock.calls.length).toBe(1);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(agent.state.messages.map(m => m.role)).toEqual(["user", "assistant"]);
		const steerDelivered = agent.state.messages.some(
			m =>
				m.role === "user" &&
				Array.isArray(m.content) &&
				m.content.some(part => part.type === "text" && part.text === "hello"),
		);
		expect(steerDelivered).toBe(true);
	});

	it("runs a queued follow-up as the opening turn and drains the queue", async () => {
		const mock = createMockModel({ responses: [{ content: ["Answer"] }] });
		const agent = new Agent({ streamFn: mock.stream });

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "later" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		expect(mock.calls.length).toBe(1);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(agent.state.messages.map(m => m.role)).toEqual(["user", "assistant"]);
	});

	it("still throws when the transcript is empty and nothing is queued", async () => {
		const agent = new Agent();
		await expect(agent.continue()).rejects.toThrow("No messages to continue from");
	});
});
