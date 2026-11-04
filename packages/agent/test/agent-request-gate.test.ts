import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentHold, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { captureRequestHolds, completeSimple, type Model, runOutsideRequestHolds } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Settles after `count` turns of the event loop. */
async function eventLoopTurns(count = 10): Promise<void> {
	for (let turn = 0; turn < count; turn++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

/** A hold that holds while armed; `release()` lets every request it held go. */
function gate() {
	let armed: PromiseWithResolvers<void> | undefined;
	return {
		hold: (): AgentHold => ({ pending: () => armed?.promise }),
		arm(): void {
			armed ??= Promise.withResolvers<void>();
		},
		release(): void {
			const wait = armed;
			armed = undefined;
			wait?.resolve();
		},
	};
}

const SSE_REPLY = [
	'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}',
	'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
	"data: [DONE]",
	"",
].join("\n\n");

/** A local OpenAI-compatible endpoint that records every request it receives. */
function localModelServer() {
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: request => {
			requests.push(`${request.method} ${new URL(request.url).pathname}`);
			return new Response(SSE_REPLY, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	const model: Model = buildModel({
		api: "openai-completions",
		provider: "openai",
		id: "local",
		name: "local",
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_000,
		maxTokens: 1024,
	});
	return { requests, model, stop: () => server.stop(true) };
}

const servers: Array<{ stop(): void }> = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
});

const schema = type({});

describe("Agent holds reach every request sent from the agent's context", () => {
	it("holds the HTTP request when a hold is added inside the provider's onPayload hook", async () => {
		const server = localModelServer();
		servers.push(server);
		const holds = gate();
		const agent: Agent = new Agent({
			initialState: { model: server.model, systemPrompt: ["test"], messages: [], tools: [] },
			getApiKey: () => "test-key",
			onPayload: payload => {
				holds.arm();
				agent.addHold(holds.hold);
				return payload;
			},
		});
		const run = agent.prompt("go");
		await eventLoopTurns();
		expect(server.requests).toEqual([]);
		holds.release();
		await run;
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
	});

	it("holds the provider call when a hold is added by the chat span's onSpanStart", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const holds = gate();
		const events: string[] = [];
		const agent: Agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [] },
			streamFn: (...args) => {
				events.push("provider called");
				return mock.stream(...args);
			},
			telemetry: {
				onSpanStart: span => {
					if (span.kind !== "chat") return;
					holds.arm();
					agent.addHold(holds.hold);
				},
			},
		});
		const run = agent.prompt("go");
		await eventLoopTurns();
		expect(events).toEqual([]);
		holds.release();
		await run;
		expect(events).toEqual(["provider called"]);
	});

	it("holds a model request a tool starts, and one a timer the tool scheduled starts", async () => {
		const server = localModelServer();
		servers.push(server);
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const holds = gate();
		const started = Promise.withResolvers<{ direct: Promise<unknown>; timed: Promise<unknown> }>();
		const ask: AgentTool<typeof schema> = {
			name: "ask",
			label: "Ask",
			description: "Asks another model",
			parameters: schema,
			async execute() {
				holds.arm();
				agent.addHold(holds.hold);
				const request = () =>
					completeSimple(
						server.model,
						{ messages: [{ role: "user", content: "q", timestamp: 0 }] },
						{ apiKey: "k" },
					);
				const timed = Promise.withResolvers<unknown>();
				setTimeout(() => timed.resolve(request()), 0);
				started.resolve({ direct: request(), timed: timed.promise });
				return { content: [{ type: "text", text: "asked" }], details: {} };
			},
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [ask] },
			streamFn: mock.stream,
		});
		const run = agent.prompt("go");
		const { direct, timed } = await started.promise;
		await eventLoopTurns();
		expect(server.requests).toEqual([]);
		holds.release();
		await Promise.all([direct, timed, run]);
		expect(server.requests).toEqual(["POST /v1/chat/completions", "POST /v1/chat/completions"]);
	});

	it("holds the requests of an agent built inside another agent's tool call by the outer agent's holds", async () => {
		const server = localModelServer();
		servers.push(server);
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-1", name: "spawn", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const holds = gate();
		const childReady = Promise.withResolvers<Agent>();
		const spawn: AgentTool<typeof schema> = {
			name: "spawn",
			label: "Spawn",
			description: "Starts a helper agent",
			parameters: schema,
			async execute() {
				const child = new Agent({
					initialState: { model: server.model, systemPrompt: ["child"], messages: [], tools: [] },
					getApiKey: () => "k",
				});
				holds.arm();
				outer.addHold(holds.hold);
				childReady.resolve(child);
				return { content: [{ type: "text", text: "spawned" }], details: {} };
			},
		};
		const outer: Agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], messages: [], tools: [spawn] },
			streamFn: mock.stream,
		});
		const run = outer.prompt("go");
		// Prompted from outside any context: the child carries the context it was built in.
		const child = (await childReady.promise).prompt("go");
		await eventLoopTurns();
		expect(server.requests).toEqual([]);
		holds.release();
		await Promise.all([child, run]);
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
	});

	it("holds an agent given another agent's context by that agent's holds, whoever prompts it", async () => {
		const server = localModelServer();
		servers.push(server);
		const owner = new Agent({ initialState: { model: server.model, systemPrompt: ["owner"], messages: [] } });
		const holds = gate();
		holds.arm();
		owner.addHold(holds.hold);
		const helper = new Agent({
			initialState: { model: server.model, systemPrompt: ["helper"], messages: [], tools: [] },
			getApiKey: () => "k",
			requestHoldContext: owner.runInRequestContext(captureRequestHolds),
		});
		const run = helper.prompt("go");
		await eventLoopTurns();
		expect(server.requests).toEqual([]);
		holds.release();
		await run;
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
	});

	it("opens one view of a parent agent's holds per request of an agent built in its context", async () => {
		const server = localModelServer();
		servers.push(server);
		const parent = new Agent({ initialState: { model: server.model, systemPrompt: ["parent"], messages: [] } });
		let opened = 0;
		let released = 0;
		parent.addHold(() => {
			opened++;
			return { pending: () => undefined, release: () => released++ };
		});
		const child = parent.runInRequestContext(
			() =>
				new Agent({
					initialState: { model: server.model, systemPrompt: ["child"], messages: [], tools: [] },
					getApiKey: () => "k",
				}),
		);
		await child.prompt("go");
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
		// The child's loop checks and the transport's send share one view of the parent's hold.
		expect({ opened, released }).toEqual({ opened: 1, released: 1 });
	});

	it("does not hold an agent's own turn run as work its holds wait for", async () => {
		const server = localModelServer();
		servers.push(server);
		const agent = new Agent({
			initialState: { model: server.model, systemPrompt: ["test"], messages: [], tools: [] },
			getApiKey: () => "k",
		});
		const holds = gate();
		holds.arm();
		agent.addHold(holds.hold);
		// A `session_moved` handler's prompt: the hold waits for it, so it must not wait for the hold.
		await runOutsideRequestHolds(agent.requestHolds, () => agent.prompt("go"));
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
		holds.release();
	});

	it("opens one view per request although the loop and the transport both check it", async () => {
		const server = localModelServer();
		servers.push(server);
		const agent = new Agent({
			initialState: { model: server.model, systemPrompt: ["test"], messages: [], tools: [] },
			getApiKey: () => "k",
		});
		let opened = 0;
		let checks = 0;
		let released = 0;
		agent.addHold(() => {
			opened++;
			return {
				pending: () => {
					checks++;
					return undefined;
				},
				release: () => released++,
			};
		});
		await agent.prompt("go");
		expect(server.requests).toEqual(["POST /v1/chat/completions"]);
		// The loop's two checks and the transport's check share the one view.
		expect({ opened, released }).toEqual({ opened: 1, released: 1 });
		expect(checks).toBe(3);
	});
});
