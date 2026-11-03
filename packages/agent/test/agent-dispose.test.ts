import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentDisposalInput } from "@oh-my-pi/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { LiveSteerClaim } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function userText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	const { content } = message;
	return typeof content === "string" ? content : content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/** An agent on scripted responses that counts the provider requests it sends. */
function createCountingAgent(
	responses: MockResponse[],
	streamHook?: (call: number, options: Parameters<StreamFn>[2]) => Promise<void>,
) {
	const mock = createMockModel({ responses });
	let calls = 0;
	const agent = new Agent({
		initialState: { model: mock.model },
		streamFn: async (model, context, options) => {
			const call = ++calls;
			await streamHook?.(call, options);
			return mock.stream(model, context, options);
		},
	});
	const events: AgentEvent[] = [];
	agent.subscribe(event => events.push(event));
	return {
		agent,
		events,
		get calls() {
			return calls;
		},
	};
}

/** User text of every message the agent emitted as a transcript message. */
function emittedUserTexts(events: AgentEvent[]): string[] {
	return events.flatMap(event =>
		event.type === "message_end" && event.message.role === "user" ? [userText(event.message)] : [],
	);
}

function lastAssistantStopReason(agent: Agent): string | undefined {
	const last = agent.state.messages.at(-1);
	return last?.role === "assistant" ? last.stopReason : undefined;
}

const workSchema = type({});

function workTool(onExecute: () => void | Promise<void>): AgentTool<typeof workSchema, Record<string, never>> {
	return {
		name: "work",
		label: "Work",
		description: "Runs work",
		parameters: workSchema,
		async execute() {
			await onExecute();
			return { content: [{ type: "text", text: "worked" }], details: {} };
		},
	};
}

describe("Agent.beginDispose", () => {
	it("refuses the next request of a run that was streaming when disposal began", async () => {
		const harness = createCountingAgent([
			{ content: [{ type: "toolCall", id: "call-1", name: "work", arguments: {} }] },
			{ content: ["should not be sent"] },
		]);
		let taken: AgentDisposalInput | undefined;
		harness.agent.setTools([workTool(() => void (taken = harness.agent.beginDispose()))]);

		await harness.agent.prompt("start");

		expect(harness.calls).toBe(1);
		expect(taken).toEqual({ steering: [], followUp: [] });
		expect(harness.agent.isDisposing).toBe(true);
		expect(lastAssistantStopReason(harness.agent)).toBe("aborted");
	});

	it("refuses every request of a run started after disposal began", async () => {
		const harness = createCountingAgent([{ content: ["should not be sent"] }]);
		harness.agent.beginDispose();

		await harness.agent.prompt("after disposal");

		expect(harness.calls).toBe(0);
		// The prompt reached the agent, so its run records it once, then ends as aborted.
		expect(emittedUserTexts(harness.events)).toEqual(["after disposal"]);
		expect(lastAssistantStopReason(harness.agent)).toBe("aborted");
	});

	it("refuses a retry continuation after disposal began", async () => {
		const harness = createCountingAgent([{ content: ["should not be sent"] }]);
		harness.agent.replaceMessages([createUserMessage("resume me")]);
		harness.agent.beginDispose();

		await harness.agent.continue();

		expect(harness.calls).toBe(0);
		expect(lastAssistantStopReason(harness.agent)).toBe("aborted");
	});

	it("refuses a request whose before-model-call hook settles after disposal began", async () => {
		const harness = createCountingAgent([{ content: ["should not be sent"] }]);
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.agent.addBeforeModelCall(async () => {
			held.resolve();
			await release.promise;
		});
		const running = harness.agent.prompt("start");
		await held.promise;

		harness.agent.beginDispose();
		release.resolve();
		await running;

		expect(harness.calls).toBe(0);
	});

	it("takes back a steer the loop dequeued for its next request, which is neither sent nor recorded", async () => {
		const steer = createUserMessage("dequeued steer");
		const harness = createCountingAgent([
			{ content: [{ type: "toolCall", id: "call-1", name: "work", arguments: {} }] },
			{ content: ["should not be sent"] },
		]);
		harness.agent.setTools([workTool(() => harness.agent.steer(steer))]);
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let beforeCalls = 0;
		harness.agent.addBeforeModelCall(async () => {
			if (++beforeCalls !== 2) return;
			held.resolve();
			await release.promise;
		});
		const running = harness.agent.prompt("start");
		await held.promise;

		const taken = harness.agent.beginDispose();
		release.resolve();
		await running;

		expect(taken).toEqual({ steering: [steer], followUp: [] });
		expect(harness.calls).toBe(1);
		expect(emittedUserTexts(harness.events)).toEqual(["start"]);
		expect(harness.agent.state.messages).not.toContain(steer);
		expect(harness.agent.peekSteeringQueue()).toEqual([]);
	});

	it("takes back live steering the provider declined after disposal began, and sends no request for it", async () => {
		const steer = createUserMessage("declined live steer");
		let claimed: LiveSteerClaim | undefined;
		const claimedOnce = Promise.withResolvers<void>();
		const settle = Promise.withResolvers<void>();
		const harness = createCountingAgent(
			[{ content: ["first"] }, { content: ["should not be sent"] }],
			async (call, options) => {
				if (call !== 1) return;
				const live = options?.liveSteering;
				const signal = options?.signal;
				if (!live || !signal) throw new Error("live steering was not offered");
				await live.wait(signal);
				claimed = await live.claim(signal);
				claimedOnce.resolve();
				await settle.promise;
				claimed?.reject();
			},
		);
		const running = harness.agent.prompt("start");
		harness.agent.steer(steer);
		await claimedOnce.promise;
		expect(claimed).toBeDefined();

		const taken = harness.agent.beginDispose();
		settle.resolve();
		await running;

		expect(taken).toEqual({ steering: [steer], followUp: [] });
		expect(harness.calls).toBe(1);
		expect(emittedUserTexts(harness.events)).toEqual(["start"]);
		expect(harness.agent.state.messages).not.toContain(steer);
	});

	it("hands out no steering once disposing, so later input waits for the next take-back", async () => {
		const late = createUserMessage("late steer");
		const harness = createCountingAgent([
			{ content: [{ type: "toolCall", id: "call-1", name: "work", arguments: {} }] },
			{ content: ["should not be sent"] },
		]);
		harness.agent.setTools([
			workTool(() => {
				harness.agent.beginDispose();
				harness.agent.steer(late);
			}),
		]);

		await harness.agent.prompt("start");

		expect(harness.calls).toBe(1);
		expect(emittedUserTexts(harness.events)).toEqual(["start"]);
		expect(harness.agent.beginDispose()).toEqual({ steering: [late], followUp: [] });
		expect(harness.agent.beginDispose()).toEqual({ steering: [], followUp: [] });
	});

	it("takes back a batch whose preparation is running, and the preparation commits nothing", async () => {
		const steer = createUserMessage("steer in preparation");
		const followUp = createUserMessage("queued follow-up");
		const harness = createCountingAgent([
			{ content: [{ type: "toolCall", id: "call-1", name: "work", arguments: {} }] },
			{ content: ["should not be sent"] },
		]);
		const preparing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let committed = false;
		harness.agent.prepareQueuedMessages = async () => {
			preparing.resolve();
			await release.promise;
			return {
				commit: () => {
					committed = true;
					return [];
				},
			};
		};
		harness.agent.setTools([
			workTool(() => {
				harness.agent.steer(steer);
				harness.agent.followUp(followUp);
			}),
		]);
		const running = harness.agent.prompt("start");
		await preparing.promise;

		const taken = harness.agent.beginDispose();
		release.resolve();
		await running;

		expect(taken).toEqual({ steering: [steer], followUp: [followUp] });
		expect(committed).toBe(false);
		expect(harness.calls).toBe(1);
		expect(emittedUserTexts(harness.events)).toEqual(["start"]);
		expect(harness.agent.beginDispose()).toEqual({ steering: [], followUp: [] });
	});
});
