import { describe, expect, test } from "bun:test";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Agent } from "../src/agent";

function message(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

describe("core queue revision and priority", () => {
	test("every public queue mutation invalidates a previously observed revision", () => {
		const agent = new Agent();
		const operations = [
			() => agent.steer(message("steer")),
			() => agent.followUp(message("follow")),
			() => agent.replaceQueues([...agent.peekSteeringQueue()], [...agent.peekFollowUpQueue()]),
			() => agent.popLastSteer(),
			() => agent.popLastFollowUp(),
			() => agent.clearSteeringQueue(),
			() => agent.clearFollowUpQueue(),
			() => agent.clearAllQueues(),
			() => agent.prependSteeringBatch([message("priority")]),
			() => agent.reset(),
		];
		for (const operation of operations) {
			const before = agent.queueRevision;
			operation();
			expect(agent.queueRevision).toBeGreaterThan(before);
		}
	});

	test("priority consumption advances revision and leaves other all-mode queues for later turns", async () => {
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: () => {
				started.resolve();
				return { content: ["held"], delayMs: 60_000 };
			},
		});
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: mock.stream,
			steeringMode: "all",
			followUpMode: "all",
			getApiKey: () => "test",
		});
		const other = message("later steer");
		const follow = message("later followup");
		const selected = message("selected first");
		agent.steer(other);
		agent.followUp(follow);
		agent.prependSteeringBatch([selected]);
		// Internal queue replacement must not erase the one-shot priority contract.
		agent.replaceQueues([...agent.peekSteeringQueue()], [...agent.peekFollowUpQueue()]);
		const before = agent.queueRevision;
		const running = agent.continue();
		try {
			await started.promise;
			expect(agent.queueRevision).toBeGreaterThan(before);
			expect(agent.peekSteeringQueue()).toEqual([other]);
			expect(agent.peekFollowUpQueue()).toEqual([follow]);
			expect(mock.calls[0]!.context.messages).toEqual([selected]);
		} finally {
			agent.abort();
			await running;
		}
	});

	test("normal follow-up consumption also advances the queue revision", async () => {
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: () => {
				started.resolve();
				return { content: ["held"], delayMs: 60_000 };
			},
		});
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream, getApiKey: () => "test" });
		agent.followUp(message("followup"));
		const before = agent.queueRevision;
		const running = agent.continue();
		try {
			await started.promise;
			expect(agent.queueRevision).toBeGreaterThan(before);
			expect(agent.hasQueuedMessages()).toBe(false);
		} finally {
			agent.abort();
			await running;
		}
	});
});
