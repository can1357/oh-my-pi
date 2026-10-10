import { afterEach, describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as AIError from "../src/error";
import { getProviderDefinition } from "../src/registry";
import { completeSimple } from "../src/stream";
import { Effort, type Api, type Model, type SimpleStreamOptions } from "../src/types";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.reverse()) cleanup();
	cleanups.length = 0;
});

function loopback() {
	const requests: Record<string, unknown>[] = [];
	const state: { reply?: () => Response } = {};
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			requests.push((await request.json()) as Record<string, unknown>);
			return (
				state.reply?.() ??
				new Response(
					'data: {"id":"governed","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
						'data: {"id":"governed","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
						"data: [DONE]\n\n",
					{ headers: { "Content-Type": "text/event-stream" } },
				)
			);
		},
	});
	cleanups.push(() => server.stop(true));
	return { requests, state, baseUrl: `${server.url}v1` };
}

function model(baseUrl: string, api: Api = "openai-completions", maxTokens = 65_536): Model {
	return buildModel({
		provider:
			api === "anthropic-messages" ? "anthropic" : api === "google-gemini-cli" ? "google-gemini-cli" : "openai",
		id:
			api === "anthropic-messages"
				? "claude-sonnet-4-5"
				: api === "google-gemini-cli"
					? "gemini-2.5-flash"
					: "gpt-5.6",
		name: "Governed loopback",
		api,
		baseUrl,
		reasoning: true,
		thinking: {
			mode: api === "anthropic-messages" || api === "google-gemini-cli" ? "budget" : "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		},
		...(api === "openai-completions" ? { compat: { supportsReasoningEffort: true } } : {}),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens,
	});
}

async function request(selected: Model, options: SimpleStreamOptions) {
	const result = await completeSimple(
		selected,
		{ messages: [{ role: "user", content: "Say ok", timestamp: 1 }] },
		{
			apiKey: "loopback-only-key",
			preserveModelSelection: true,
			preserveThinkingEffort: true,
			reasoning: Effort.High,
			...options,
		},
	);
	if (result.stopReason === "error" && AIError.is(AIError.classifyMessage(result), AIError.Flag.HostAdmission)) {
		throw new AIError.ModelSelectionError(result.errorMessage ?? "Governed dispatch rejected");
	}
	return result;
}

function replacePreparation(key: "prepareRequest" | "mapSimpleOptions", value: unknown): void {
	const definition = getProviderDefinition("openai")!;
	const previous = Object.getOwnPropertyDescriptor(definition, key);
	Object.defineProperty(definition, key, { configurable: true, writable: true, enumerable: true, value });
	cleanups.push(() => {
		if (previous) Object.defineProperty(definition, key, previous);
		else Reflect.deleteProperty(definition, key);
	});
}

describe("governed stream preparation and actual inference", () => {
	it("retains protected flags and the host gate after late option replacement and stops a revoked HTTP retry", async () => {
		const wire = loopback();
		const selected = model(wire.baseUrl);
		let allowed = true;
		let admissions = 0;
		let payloadHooks = 0;
		wire.state.reply = () => {
			allowed = false;
			return new Response("overloaded", { status: 503, headers: { "Retry-After": "0" } });
		};
		replacePreparation("prepareRequest", (serving: Model, options: SimpleStreamOptions) => ({
			model: serving,
			options: {
				...options,
				preserveModelSelection: false,
				preserveThinkingEffort: false,
				onBeforeRequest: undefined,
			},
		}));
		await expect(
			request(selected, {
				onPayload: () => {
					payloadHooks++;
				},
				onBeforeRequest: () => {
					admissions++;
					if (!allowed) throw new AIError.ModelSelectionError("Original authority revoked");
				},
			}),
		).rejects.toThrow(AIError.ModelSelectionError);
		expect(wire.requests).toHaveLength(1);
		expect(wire.requests[0]).toMatchObject({
			model: selected.requestModelId ?? selected.id,
			reasoning_effort: "high",
		});
		expect(admissions).toBe(2);
		expect(payloadHooks).toBe(1);
	});

	it("retains admission after simple option mapping and allows a real permitted retry without hook replay", async () => {
		const wire = loopback();
		let attempts = 0;
		let admissions = 0;
		let hooks = 0;
		wire.state.reply = () => {
			attempts++;
			if (attempts === 1) return new Response("overloaded", { status: 503, headers: { "Retry-After": "0" } });
			return new Response(
				'data: {"id":"ok","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		};
		replacePreparation("mapSimpleOptions", () => ({
			preserveModelSelection: false,
			preserveThinkingEffort: false,
			onBeforeRequest: undefined,
		}));
		const result = await request(model(wire.baseUrl), {
			onBeforeRequest: () => {
				admissions++;
			},
			onPayload: () => {
				hooks++;
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(
			result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join(""),
		).toBe("ok");
		expect(wire.requests).toHaveLength(2);
		expect(wire.requests[1]).toEqual(wire.requests[0]);
		expect(admissions).toBe(2);
		expect(hooks).toBe(1);
	});

	for (const escape of ["model", "transport", "endpoint", "effort"] as const) {
		it(`rejects a late actual ${escape} override before HTTP`, async () => {
			const wire = loopback();
			replacePreparation("prepareRequest", (serving: Model, options: SimpleStreamOptions) => ({
				model:
					escape === "model"
						? { ...serving, id: "unlisted" }
						: escape === "transport"
							? { ...serving, api: "openai-responses" }
							: escape === "endpoint"
								? { ...serving, baseUrl: `${wire.baseUrl}/unadmitted` }
								: serving,
				options: escape === "effort" ? { ...options, reasoning: Effort.Low } : options,
			}));
			await expect(request(model(wire.baseUrl), {})).rejects.toThrow(AIError.ModelSelectionError);
			expect(wire.requests).toHaveLength(0);
		});
	}

	it("rejects mapped fixed Anthropic high with budget zero before native inference", async () => {
		const wire = loopback();
		await expect(
			request(model(wire.baseUrl, "anthropic-messages"), { thinkingBudgets: { high: 0 } }),
		).rejects.toThrow(AIError.ModelSelectionError);
		expect(wire.requests).toHaveLength(0);
	});

	it("rejects fixed Gemini CLI budget suppression instead of falling through to reasoning off", async () => {
		const wire = loopback();
		await expect(
			request(model(wire.baseUrl, "google-gemini-cli", 256), { thinkingBudgets: { high: 4096 }, maxTokens: 64 }),
		).rejects.toThrow(AIError.ModelSelectionError);
		expect(wire.requests).toHaveLength(0);
	});

	it("allows unpinned explicit effort to follow ordinary provider behavior without changing the model", async () => {
		const wire = loopback();
		const selected = model(wire.baseUrl);
		const result = await request(selected, {
			preserveThinkingEffort: false,
			onPayload: payload => {
				(payload as Record<string, unknown>).reasoning_effort = "low";
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(wire.requests).toHaveLength(1);
		expect(wire.requests[0]).toMatchObject({
			model: selected.requestModelId ?? selected.id,
			reasoning_effort: "low",
		});
	});
});

it("rejects a late proxy-defined serving model without invoking its traps", async () => {
	const wire = loopback();
	let traps = 0;
	replacePreparation("prepareRequest", (serving: Model, options: SimpleStreamOptions) => ({
		model: new Proxy(serving, {
			get(target, key, receiver) {
				traps++;
				return Reflect.get(target, key, receiver);
			},
			getOwnPropertyDescriptor(target, key) {
				traps++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		}),
		options,
	}));
	await expect(request(model(wire.baseUrl), {})).rejects.toThrow(AIError.ModelSelectionError);
	expect(traps).toBe(0);
	expect(wire.requests).toHaveLength(0);
});

for (const escape of ["model", "endpoint"] as const) {
	it(`rejects header resolution changing the admitted ${escape} before HTTP`, async () => {
		const wire = loopback();
		const selected = model(wire.baseUrl);
		selected.resolveHeaders = async () => {
			if (escape === "model") selected.id = "unlisted";
			else selected.baseUrl = `${wire.baseUrl}/unadmitted`;
			return { "X-Trace": "harmless" };
		};
		await expect(request(selected, {})).rejects.toThrow(AIError.ModelSelectionError);
		expect(wire.requests).toHaveLength(0);
	});
}

it("rejects a supplied endpoint accessor without invoking it or sending HTTP", async () => {
	const wire = loopback();
	const selected = model(wire.baseUrl);
	let getters = 0;
	Object.defineProperty(selected, "baseUrl", {
		enumerable: true,
		configurable: true,
		get() {
			getters++;
			return wire.baseUrl;
		},
	});
	await expect(request(selected, {})).rejects.toThrow(AIError.ModelSelectionError);
	expect(getters).toBe(0);
	expect(wire.requests).toHaveLength(0);
});

it("rejects an unsafe supplied endpoint without coercion or HTTP", async () => {
	const wire = loopback();
	const selected = model(wire.baseUrl);
	let coercions = 0;
	Object.defineProperty(selected, "baseUrl", {
		enumerable: true,
		configurable: true,
		value: {
			toString() {
				coercions++;
				return wire.baseUrl;
			},
		},
	});
	await expect(request(selected, {})).rejects.toThrow(AIError.ModelSelectionError);
	expect(coercions).toBe(0);
	expect(wire.requests).toHaveLength(0);
});

for (const redirect of [false, true]) {
	it(`${redirect ? "rejects a changed" : "serves an unchanged"} endpoint after final admission`, async () => {
		const wire = loopback();
		const selected = model(wire.baseUrl);
		let admissions = 0;
		const pending = request(selected, {
			onBeforeRequest: () => {
				admissions++;
				selected.baseUrl = redirect ? `${wire.baseUrl}/unadmitted` : wire.baseUrl;
			},
		});
		if (redirect) {
			await expect(pending).rejects.toThrow(AIError.ModelSelectionError);
			expect(wire.requests).toHaveLength(0);
		} else {
			const result = await pending;
			expect(result.stopReason).toBe("stop");
			expect(
				result.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join(""),
			).toBe("ok");
			expect(wire.requests).toHaveLength(1);
		}
		expect(admissions).toBe(1);
	});
}
