import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentDisposalInput } from "@oh-my-pi/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { LiveSteerClaim } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
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
		expect(taken).toEqual({ steering: [], followUp: [], asides: [] });
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

		expect(taken).toEqual({ steering: [steer], followUp: [], asides: [] });
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

		expect(taken).toEqual({ steering: [steer], followUp: [], asides: [] });
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
		expect(harness.agent.beginDispose()).toEqual({ steering: [late], followUp: [], asides: [] });
		expect(harness.agent.beginDispose()).toEqual({ steering: [], followUp: [], asides: [] });
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

		expect(taken).toEqual({ steering: [steer], followUp: [followUp], asides: [] });
		expect(committed).toBe(false);
		expect(harness.calls).toBe(1);
		expect(emittedUserTexts(harness.events)).toEqual(["start"]);
		expect(harness.agent.beginDispose()).toEqual({ steering: [], followUp: [], asides: [] });
	});

	it("takes back an aside the loop already built while a later dequeue of its step is held", async () => {
		const aside = createUserMessage("built background result");
		const followUp = createUserMessage("queued follow-up");
		const harness = createCountingAgent([{ content: ["first"] }, { content: ["should not be sent"] }], async call => {
			if (call === 1) harness.agent.followUp(followUp);
		});
		let built = false;
		harness.agent.setAsideMessageProvider(boundary =>
			boundary === "stop" && !built
				? [
						() => {
							built = true;
							return aside;
						},
					]
				: [],
		);
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.agent.addBeforeQueuedMessageDequeueHook(async () => {
			if (!built) return;
			held.resolve();
			await release.promise;
		});
		const running = harness.agent.prompt("start");
		await held.promise;

		const taken = harness.agent.beginDispose();
		release.resolve();
		await running;

		expect(harness.calls).toBe(1);
		expect(emittedUserTexts(harness.events)).toEqual(["start"]);
		expect(harness.agent.state.messages).not.toContain(aside);
		expect(taken).toEqual({ steering: [], followUp: [followUp], asides: [aside] });
		expect(harness.agent.beginDispose()).toEqual({ steering: [], followUp: [], asides: [] });
	});

	it("keeps an aside the loop resolves after disposal began for the next take-back, and does not hand it to the loop", async () => {
		const aside = createUserMessage("peer message drained at disposal");
		const harness = createCountingAgent([{ content: ["first"] }, { content: ["should not be sent"] }]);
		let first: AgentDisposalInput | undefined;
		harness.agent.setAsideMessageProvider(boundary => {
			if (boundary !== "stop" || first) return [];
			// The provider gives the message up; disposal begins before the loop resolves it.
			first = harness.agent.beginDispose();
			return [() => aside];
		});

		await harness.agent.prompt("start");

		expect(harness.calls).toBe(1);
		expect(emittedUserTexts(harness.events)).toEqual(["start"]);
		expect(harness.agent.state.messages).not.toContain(aside);
		expect(first).toEqual({ steering: [], followUp: [], asides: [] });
		expect(harness.agent.beginDispose()).toEqual({ steering: [], followUp: [], asides: [aside] });
	});

	for (const callback of ["metadata resolution", "cwd resolution"] as const) {
		it(`sends no HTTP request when ${callback} begins disposal right before the send`, async () => {
			const requests: string[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					requests.push(request.url);
					return new Response(anthropicStream("provider answer"), {
						headers: { "content-type": "text/event-stream" },
					});
				},
			});
			const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!bundled) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");
			const agent: Agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model: { ...bundled, baseUrl: `http://127.0.0.1:${server.port}` } },
				cwdResolver:
					callback === "cwd resolution"
						? () => {
								agent.beginDispose();
								return undefined;
							}
						: undefined,
			});
			if (callback === "metadata resolution") {
				agent.setMetadataResolver(() => {
					agent.beginDispose();
					return {};
				});
			}
			try {
				await agent.prompt("start");

				expect(requests).toEqual([]);
				expect(lastAssistantStopReason(agent)).toBe("aborted");
			} finally {
				server.stop(true);
			}
		});
	}
});

/** A complete Anthropic Messages event stream that answers `text`. */
function anthropicStream(text: string): string {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
