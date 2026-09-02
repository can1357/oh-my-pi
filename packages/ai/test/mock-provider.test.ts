import { afterEach, describe, expect, test } from "bun:test";
import { clearCustomApis, getCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import {
	createMockModel,
	isMockModel,
	MOCK_API,
	type MockHandler,
	registerMockApi,
	streamMock,
} from "@oh-my-pi/pi-ai/providers/mock";
import type { AssistantMessage, AssistantMessageEvent, Context, ToolCall } from "@oh-my-pi/pi-ai/types";

afterEach(() => {
	clearCustomApis();
});

function emptyContext(): Context {
	return {
		systemPrompt: [],
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
}

async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const out: AssistantMessageEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

describe("mock provider", () => {
	test("createMockModel produces a Model<'mock'> with the configured id and provider", () => {
		const mock = createMockModel({ id: "spec-1", provider: "tests" });
		expect(mock.model.api).toBe(MOCK_API);
		expect(mock.model.id).toBe("spec-1");
		expect(mock.model.provider).toBe("tests");
		expect(isMockModel(mock.model)).toBe(true);
	});

	test("emits start → text_start/delta/end → done for a single text response", async () => {
		const mock = createMockModel({
			responses: [{ content: ["hello world"] }],
		});

		const result = await mock.stream(mock.model, emptyContext()).result();
		expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
		expect(result.stopReason).toBe("stop");
		expect(result.usage.totalTokens).toBe(0);
	});

	test("emits a toolcall block and defaults stopReason to 'toolUse'", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", name: "read", arguments: { path: "/x" } }],
				},
			],
		});

		const stream = mock.stream(mock.model, emptyContext());
		const events = await collect(stream);
		const result = await stream.result();

		const ends = events.filter(e => e.type === "toolcall_end");
		expect(ends).toHaveLength(1);
		const toolCall = (ends[0] as { toolCall: ToolCall }).toolCall;
		expect(toolCall.name).toBe("read");
		expect(toolCall.arguments).toEqual({ path: "/x" });
		expect(toolCall.id).toMatch(/^mock-tc-\d+$/);

		expect(result.stopReason).toBe("toolUse");
	});

	test("scripts a sequence; each call consumes one response in order", async () => {
		const mock = createMockModel({
			responses: [{ content: ["first"] }, { content: ["second"] }],
		});

		const first = await mock.stream(mock.model, emptyContext()).result();
		const second = await mock.stream(mock.model, emptyContext()).result();

		expect(first.content).toEqual([{ type: "text", text: "first" }]);
		expect(second.content).toEqual([{ type: "text", text: "second" }]);
		expect(mock.calls).toHaveLength(2);
	});

	test("fallback handler runs when the script is exhausted", async () => {
		const mock = createMockModel({
			responses: [{ content: ["scripted"] }],
			handler: ctx => ({ content: [`fallback:${ctx.messages.length}`] }),
		});

		await mock.stream(mock.model, emptyContext()).result();
		const second = await mock.stream(mock.model, emptyContext()).result();
		expect(second.content).toEqual([{ type: "text", text: "fallback:1" }]);
	});

	test("handler receives the context and options", async () => {
		const mock = createMockModel({
			handler: (ctx, opts) => ({
				content: [`msgs=${ctx.messages.length} tier=${opts?.apiKey ?? "none"}`],
			}),
		});

		const result = await mock.stream(mock.model, emptyContext(), { apiKey: "k" }).result();
		expect(result.content).toEqual([{ type: "text", text: "msgs=1 tier=k" }]);
	});

	test("response.throw produces a terminal error event with the failure on stopReason/errorMessage", async () => {
		const mock = createMockModel({
			responses: [{ throw: "boom" }],
		});

		const result = await mock.stream(mock.model, emptyContext()).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("boom");
	});

	test("calling without a configured response rejects on the next call", async () => {
		const mock = createMockModel({});
		const stream = mock.stream(mock.model, emptyContext());
		await expect(stream.result()).rejects.toThrow(/no response or handler is configured/);
	});

	test("push() appends to the script at runtime", async () => {
		const mock = createMockModel({});
		mock.push({ content: ["late binding"] });
		const result = await mock.stream(mock.model, emptyContext()).result();
		expect(result.content).toEqual([{ type: "text", text: "late binding" }]);
	});

	test("reset() clears recorded calls and the extras queue but leaves the constructor source alone", async () => {
		const mock = createMockModel({
			responses: [{ content: ["a"] }, { content: ["b"] }],
		});
		mock.push({ content: ["pushed-pre-reset"] });
		await mock.stream(mock.model, emptyContext()).result();

		mock.reset();
		expect(mock.calls).toHaveLength(0);

		// The constructor source still has "b" pending; reset doesn't touch it.
		const next = await mock.stream(mock.model, emptyContext()).result();
		expect(next.content).toEqual([{ type: "text", text: "b" }]);

		// The pre-reset push() entry is gone.
		mock.push({ content: ["post-reset"] });
		const last = await mock.stream(mock.model, emptyContext()).result();
		expect(last.content).toEqual([{ type: "text", text: "post-reset" }]);
	});

	test("registerMockApi exposes streamMock through the custom-API registry", () => {
		registerMockApi();
		const entry = getCustomApi(MOCK_API);
		expect(entry).toBeDefined();
		expect(entry?.streamSimple).toBe(streamMock);
	});

	test("delayMs honors the AbortSignal and surfaces a terminal aborted result", async () => {
		const mock = createMockModel({
			responses: [{ content: ["never"], delayMs: 1000 }],
		});
		const controller = new AbortController();
		const stream = mock.stream(mock.model, emptyContext(), { signal: controller.signal });
		controller.abort();
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toMatch(/aborted/i);
	});

	test("streamMock with a foreign model fails with a clear message", async () => {
		const foreign = { api: MOCK_API, id: "x" } as unknown as Parameters<typeof streamMock>[0];
		const stream = streamMock(foreign, emptyContext());
		await expect(stream.result()).rejects.toThrow(/not produced by createMockModel/);
	});
});

describe("AssistantMessage shape", () => {
	test("result carries api, provider, model id, timestamp, and a populated usage object", async () => {
		const mock = createMockModel({
			id: "spec",
			provider: "tests",
			responses: [{ content: ["x"], usage: { input: 5, output: 2 } }],
		});
		const result: AssistantMessage = await mock.stream(mock.model, emptyContext()).result();
		expect(result.api).toBe(MOCK_API);
		expect(result.provider).toBe("tests");
		expect(result.model).toBe("spec");
		expect(typeof result.timestamp).toBe("number");
		expect(result.usage.input).toBe(5);
		expect(result.usage.output).toBe(2);
	});

	test("partial usage without totalTokens recomputes the total from components", async () => {
		const mock = createMockModel({
			responses: [{ content: ["x"], usage: { input: 5, output: 2 } }],
		});
		const result = await mock.stream(mock.model, emptyContext()).result();
		expect(result.usage.totalTokens).toBe(7);
	});

	test("partial usage with explicit totalTokens is respected", async () => {
		const mock = createMockModel({
			responses: [{ content: ["x"], usage: { input: 5, output: 2, totalTokens: 999 } }],
		});
		const result = await mock.stream(mock.model, emptyContext()).result();
		expect(result.usage.totalTokens).toBe(999);
	});

	test("partial cost components recompute cost.total when total is omitted", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: ["x"],
					usage: { input: 5, output: 2, cost: { input: 0.5, output: 0.25, cacheRead: 0, cacheWrite: 0 } },
				},
			],
		});
		const result = await mock.stream(mock.model, emptyContext()).result();
		expect(result.usage.cost.total).toBeCloseTo(0.75, 10);
	});

	test("tool-call ID counter is scoped per mock instance and resets with reset()", async () => {
		const makeMock = () =>
			createMockModel({
				responses: [
					{ content: [{ type: "toolCall", name: "read", arguments: { path: "/x" } }] },
					{ content: [{ type: "toolCall", name: "read", arguments: { path: "/y" } }] },
				],
			});

		const a = makeMock();
		const b = makeMock();

		const a1 = await a.stream(a.model, emptyContext()).result();
		const a2 = await a.stream(a.model, emptyContext()).result();
		const b1 = await b.stream(b.model, emptyContext()).result();
		const b2 = await b.stream(b.model, emptyContext()).result();

		const idOf = (m: AssistantMessage): string => {
			const tc = m.content.find(c => c.type === "toolCall") as ToolCall;
			return tc.id;
		};

		expect(idOf(a1)).toBe("mock-tc-1");
		expect(idOf(a2)).toBe("mock-tc-2");
		expect(idOf(b1)).toBe("mock-tc-1");
		expect(idOf(b2)).toBe("mock-tc-2");

		a.reset();
		a.push({ content: [{ type: "toolCall", name: "read", arguments: { path: "/z" } }] });
		const a3 = await a.stream(a.model, emptyContext()).result();
		expect(idOf(a3)).toBe("mock-tc-1");
	});
});

describe("mock provider — async-iterable response sources", () => {
	test("consumes an async generator one call at a time", async () => {
		const mock = createMockModel({
			responses: (async function* () {
				yield { content: ["a"] };
				yield { content: ["b"] };
			})(),
		});
		const a = await mock.stream(mock.model, emptyContext()).result();
		const b = await mock.stream(mock.model, emptyContext()).result();
		expect(a.content).toEqual([{ type: "text", text: "a" }]);
		expect(b.content).toEqual([{ type: "text", text: "b" }]);
	});

	test("generator can await external coordination between yields", async () => {
		const gate = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: (async function* () {
				yield { content: ["before"] };
				await gate.promise;
				yield { content: ["after"] };
			})(),
		});

		const first = await mock.stream(mock.model, emptyContext()).result();
		expect(first.content).toEqual([{ type: "text", text: "before" }]);

		// Kick off the second call; it must wait on the gate.
		const secondPromise = mock.stream(mock.model, emptyContext()).result();
		let resolved = false;
		secondPromise.then(() => {
			resolved = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).toBe(false);

		gate.resolve();
		const second = await secondPromise;
		expect(second.content).toEqual([{ type: "text", text: "after" }]);
	});

	test("generator can react to call state via the shared handle", async () => {
		// Each yield reads `mock.calls` to react to what just happened.
		const gen = async function* () {
			yield { content: ["turn 0"] };
			// At this point mock.calls.length === 1.
			const last = handle.calls[handle.calls.length - 1];
			const msgs = last.context.messages.length;
			yield { content: [`saw ${msgs} message(s)`] };
		};
		const handle = createMockModel({ responses: gen() });

		const r1 = await handle.stream(handle.model, emptyContext()).result();
		expect(r1.content).toEqual([{ type: "text", text: "turn 0" }]);

		const ctx: Context = {
			systemPrompt: [],
			messages: [
				{ role: "user", content: "a", timestamp: 0 },
				{ role: "user", content: "b", timestamp: 0 },
			],
		};
		const r2 = await handle.stream(handle.model, ctx).result();
		expect(r2.content).toEqual([{ type: "text", text: "saw 2 message(s)" }]);
	});

	test("synchronous iterables work too (Set, custom iterator, etc.)", async () => {
		const set = new Set<MockHandler>([{ content: ["x"] }, { content: ["y"] }]);
		const mock = createMockModel({ responses: set });
		const a = await mock.stream(mock.model, emptyContext()).result();
		const b = await mock.stream(mock.model, emptyContext()).result();
		expect(a.content).toEqual([{ type: "text", text: "x" }]);
		expect(b.content).toEqual([{ type: "text", text: "y" }]);
	});

	test("falls through to handler when the iterable is exhausted", async () => {
		const mock = createMockModel({
			responses: (async function* () {
				yield { content: ["scripted"] };
			})(),
			handler: () => ({ content: ["fallback"] }),
		});
		await mock.stream(mock.model, emptyContext()).result();
		const next = await mock.stream(mock.model, emptyContext()).result();
		expect(next.content).toEqual([{ type: "text", text: "fallback" }]);
	});

	test("push() handlers run AFTER the iterable but BEFORE the fallback", async () => {
		const mock = createMockModel({
			responses: (async function* () {
				yield { content: ["scripted"] };
			})(),
			handler: () => ({ content: ["fallback"] }),
		});
		mock.push({ content: ["pushed"] });

		const a = await mock.stream(mock.model, emptyContext()).result();
		const b = await mock.stream(mock.model, emptyContext()).result();
		const c = await mock.stream(mock.model, emptyContext()).result();
		expect(a.content).toEqual([{ type: "text", text: "scripted" }]);
		expect(b.content).toEqual([{ type: "text", text: "pushed" }]);
		expect(c.content).toEqual([{ type: "text", text: "fallback" }]);
	});

	test("generator errors propagate to the stream", async () => {
		const mock = createMockModel({
			responses: (async function* () {
				yield { content: ["ok"] };
				throw new Error("script crashed");
			})(),
		});
		await mock.stream(mock.model, emptyContext()).result();
		await expect(mock.stream(mock.model, emptyContext()).result()).rejects.toThrow("script crashed");
	});
});
