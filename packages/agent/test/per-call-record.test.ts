/**
 * A per-call message rebuilt equal to the one the previous request sent at the same position is marked repeated,
 * and "previous" must mean a request the provider answered. A request can be prepared and still never reach the
 * provider: the provider dispatch layer calls the dispatch hook before the provider builds its request, and a stop can
 * land while the provider still awaits its payload hook (an extension's `before_provider_request`), image preparation
 * or its SDK; or the stream function can throw a refusal. The record is taken as the provider reports its response
 * (`onResponse`), so neither becomes the record. Taken when the request is prepared, or in the dispatch hook, it would
 * mark the next request's changed note repeated although no request carried it.
 *
 * "Previous" must also mean this conversation. `Agent.reset()` ends one (`newSession`, a cleared context, and the
 * memory release of a disposed parked-subagent session all call it), so the record is replaced there; a request of the
 * conversation that ended records nothing for the next one, whether the reset lands while the request is out or while
 * it is still being prepared.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Context, type FetchImpl, streamSimple } from "@oh-my-pi/pi-ai";
import {
	isPerCallContextMessage,
	isRepeatedPerCallContextMessage,
	markPerCallContextMessage,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://gateway.local",
	reasoning: false,
	input: ["text"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** A gateway stand-in: each request gets a one-text reply; `bodies` holds every request that reached it. */
function gateway(): { fetch: FetchImpl; bodies: string[] } {
	const bodies: string[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		bodies.push(typeof init?.body === "string" ? init.body : "");
		const events = [
			{ type: "message_start", message: { id: `msg_${bodies.length}`, model: model.id, usage } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
			{ type: "message_stop" },
		];
		const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req" } });
	};
	return { fetch, bodies };
}

describe("the per-call record is the last request the provider answered", () => {
	it("does not mark a note repeated after an abort while the provider prepared the request", async () => {
		const server = gateway();
		const contexts: Context[] = [];
		let note = "status: idle";
		let stopInPayloadHook = false;
		const agent: Agent = new Agent({
			initialState: { model },
			getApiKey: () => "not-a-secret",
			streamFn: (streamModel, context, options) => {
				contexts.push(context);
				return streamSimple(streamModel, context, {
					...options,
					fetch: server.fetch,
					// An extension's payload hook that awaits; the user stops the run while it runs.
					onPayload: async () => {
						if (!stopInPayloadHook) return undefined;
						await Promise.resolve();
						agent.abort();
						return undefined;
					},
				});
			},
			// A context hook's note ahead of the history, rebuilt for every request.
			transformContext: async messages => {
				const status: AgentMessage = { role: "user", content: note, timestamp: 0 };
				markPerCallContextMessage(status);
				return [status, ...messages];
			},
		});

		await agent.prompt("first");
		note = "status: busy";
		stopInPayloadHook = true;
		await agent.prompt("second");
		stopInPayloadHook = false;
		await agent.prompt("third");

		// Preconditions: three requests were prepared, and the second never reached the gateway.
		expect(contexts).toHaveLength(3);
		expect(server.bodies).toHaveLength(2);
		expect(server.bodies[1]).toContain("status: busy");
		expect(contexts[2]?.messages[0]?.content).toBe("status: busy");
		// The note changed since the last request that went out: no request carried it, so it is not repeated.
		expect(isPerCallContextMessage(contexts[2]?.messages[0])).toBe(true);
		expect(isRepeatedPerCallContextMessage(contexts[2]?.messages[0])).toBe(false);
	});

	it("marks a note repeated once the gateway answered the request that carried it", async () => {
		const server = gateway();
		const contexts: Context[] = [];
		const agent = new Agent({
			initialState: { model },
			getApiKey: () => "not-a-secret",
			streamFn: (streamModel, context, options) => {
				contexts.push(context);
				return streamSimple(streamModel, context, { ...options, fetch: server.fetch });
			},
			transformContext: async messages => {
				const status: AgentMessage = { role: "user", content: "status: idle", timestamp: 0 };
				markPerCallContextMessage(status);
				return [status, ...messages];
			},
		});

		await agent.prompt("first");
		await agent.prompt("second");

		expect(server.bodies).toHaveLength(2);
		expect(isPerCallContextMessage(contexts[0]?.messages[0])).toBe(true);
		expect(isRepeatedPerCallContextMessage(contexts[0]?.messages[0])).toBe(false);
		// The provider reported its answer to the first request, which carried the note at this position.
		expect(contexts[1]?.messages[0]?.content).toBe("status: idle");
		expect(isPerCallContextMessage(contexts[1]?.messages[0])).toBe(true);
		expect(isRepeatedPerCallContextMessage(contexts[1]?.messages[0])).toBe(true);
	});

	it("does not mark a note repeated after a refusal thrown by the stream function", async () => {
		const server = gateway();
		const contexts: Context[] = [];
		let note = "status: idle";
		let refuse = false;
		const agent = new Agent({
			initialState: { model },
			getApiKey: () => "not-a-secret",
			streamFn: (streamModel, context, options) => {
				contexts.push(context);
				// A spend cap checked again as the request goes out refuses it: nothing is sent.
				if (refuse) throw new Error("Session cost cap reached");
				return streamSimple(streamModel, context, { ...options, fetch: server.fetch });
			},
			transformContext: async messages => {
				const status: AgentMessage = { role: "user", content: note, timestamp: 0 };
				markPerCallContextMessage(status);
				return [status, ...messages];
			},
		});

		await agent.prompt("first");
		note = "status: busy";
		refuse = true;
		await agent.prompt("second");
		refuse = false;
		await agent.prompt("third");

		// Precondition: the second request never reached the gateway.
		expect(contexts).toHaveLength(3);
		expect(server.bodies).toHaveLength(2);
		expect(contexts[2]?.messages[0]?.content).toBe("status: busy");
		// The note changed since the last request answered: no request carried it, so it is not repeated.
		expect(isPerCallContextMessage(contexts[2]?.messages[0])).toBe(true);
		expect(isRepeatedPerCallContextMessage(contexts[2]?.messages[0])).toBe(false);
	});

	it("marks nothing repeated from the conversation a reset ended", async () => {
		const server = gateway();
		const contexts: Context[] = [];
		const agent = new Agent({
			initialState: { model },
			getApiKey: () => "not-a-secret",
			streamFn: (streamModel, context, options) => {
				contexts.push(context);
				return streamSimple(streamModel, context, { ...options, fetch: server.fetch });
			},
			// A context hook's note at the tail: the place it holds is the last history message.
			transformContext: async messages => {
				const status: AgentMessage = { role: "user", content: "status: idle", timestamp: 0 };
				markPerCallContextMessage(status);
				return [...messages, status];
			},
		});

		// A conversation seeded from the store carries the timestamps it was stored with, so the prompt the next
		// conversation starts from is the same bytes as this one's.
		const stored = (): AgentMessage[] => [{ role: "user", content: "first", timestamp: 1_000 }];
		await agent.prompt(stored());
		await agent.prompt(stored());
		agent.reset();
		await agent.prompt(stored());

		expect(server.bodies).toHaveLength(3);
		// Control: inside one conversation the note at this place is repeated, so the assertions below can fail.
		expect(isRepeatedPerCallContextMessage(contexts[1]?.messages.at(-1))).toBe(true);
		// The reset ended that conversation: this request compares with nothing.
		expect(contexts[2]?.messages.at(-1)?.content).toBe("status: idle");
		expect(isPerCallContextMessage(contexts[2]?.messages.at(-1))).toBe(true);
		expect(isRepeatedPerCallContextMessage(contexts[2]?.messages.at(-1))).toBe(false);
	});

	it("does not let the answer to a request of the ended conversation restore the record", async () => {
		const server = gateway();
		const contexts: Context[] = [];
		let hold = false;
		const atGateway = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		// The gateway holds the second request until the reset has landed, so its answer arrives after it.
		const fetch: FetchImpl = async (input, init) => {
			if (hold) {
				atGateway.resolve();
				await released.promise;
			}
			return server.fetch(input, init);
		};
		const agent = new Agent({
			initialState: { model },
			getApiKey: () => "not-a-secret",
			streamFn: (streamModel, context, options) => {
				contexts.push(context);
				return streamSimple(streamModel, context, { ...options, fetch });
			},
			transformContext: async messages => {
				const status: AgentMessage = { role: "user", content: "status: idle", timestamp: 0 };
				markPerCallContextMessage(status);
				return [...messages, status];
			},
		});

		const stored = (): AgentMessage[] => [{ role: "user", content: "first", timestamp: 1_000 }];
		await agent.prompt(stored());
		hold = true;
		const inFlight = agent.prompt(stored());
		await atGateway.promise;
		// A new session starts while the request is out.
		agent.reset();
		released.resolve();
		// The reset emptied the state under a running loop; what that run ends with is not this test's subject.
		await inFlight.catch(() => {});
		hold = false;
		await agent.prompt(stored());

		expect(server.bodies).toHaveLength(3);
		// Control: the record was live when the second request went out, and that request repeated the first's note.
		expect(isRepeatedPerCallContextMessage(contexts[1]?.messages.at(-1))).toBe(true);
		// Its answer came back after the reset, so it recorded nothing for this conversation to match.
		expect(contexts[2]?.messages.at(-1)?.content).toBe("status: idle");
		expect(isPerCallContextMessage(contexts[2]?.messages.at(-1))).toBe(true);
		expect(isRepeatedPerCallContextMessage(contexts[2]?.messages.at(-1))).toBe(false);
	});

	it("does not let a request prepared across a reset restore the record", async () => {
		const server = gateway();
		const contexts: Context[] = [];
		let hold = false;
		const inTransform = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const agent = new Agent({
			initialState: { model },
			getApiKey: () => "not-a-secret",
			streamFn: (streamModel, context, options) => {
				contexts.push(context);
				return streamSimple(streamModel, context, { ...options, fetch: server.fetch });
			},
			transformContext: async messages => {
				const status: AgentMessage = { role: "user", content: "status: idle", timestamp: 0 };
				markPerCallContextMessage(status);
				return [...messages, status];
			},
			// The host's provider-context transform awaits (an image description, a blob store); the reset lands then.
			transformProviderContext: async context => {
				if (hold) {
					inTransform.resolve();
					await released.promise;
				}
				return context;
			},
		});

		const stored = (): AgentMessage[] => [{ role: "user", content: "first", timestamp: 1_000 }];
		await agent.prompt(stored());
		await agent.prompt(stored());
		hold = true;
		const inFlight = agent.prompt(stored());
		await inTransform.promise;
		// A new session starts before the request is compared with the record.
		agent.reset();
		released.resolve();
		// The reset emptied the state under a running loop; what that run ends with is not this test's subject.
		await inFlight.catch(() => {});
		hold = false;
		await agent.prompt(stored());

		expect(server.bodies).toHaveLength(4);
		// Control: inside one conversation the note at this place is repeated, so the assertions below can fail.
		expect(isRepeatedPerCallContextMessage(contexts[1]?.messages.at(-1))).toBe(true);
		// The third request belonged to the conversation the reset ended, so its answer recorded nothing for this one.
		expect(contexts[3]?.messages.at(-1)?.content).toBe("status: idle");
		expect(isPerCallContextMessage(contexts[3]?.messages.at(-1))).toBe(true);
		expect(isRepeatedPerCallContextMessage(contexts[3]?.messages.at(-1))).toBe(false);
	});
});
