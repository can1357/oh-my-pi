import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { readThinkingCapability } from "@oh-my-pi/pi-catalog/thinking-capability";
import { isRecord, TempDir, untilAborted } from "@oh-my-pi/pi-utils";

const context: Context = { messages: [{ role: "user", content: "the real task", timestamp: 1 }] };

function unknownModel<TApi extends Api>(api: TApi): Model<TApi> {
	return buildModel({
		id: "unlisted-reasoner",
		name: "Unlisted reasoner",
		provider: "thinking-probe-test",
		api,
		baseUrl: "https://thinking-probe.example/v1",
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function bodyRecord(init: RequestInit | undefined): Record<string, unknown> {
	if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
	const parsed: unknown = JSON.parse(init.body);
	if (!isRecord(parsed)) throw new Error("Expected a request object");
	return parsed;
}

function rejection(): Response {
	return Response.json(
		{
			error: {
				message: "reasoning effort not supported; allowed levels: low, high, max",
				type: "invalid_request_error",
			},
		},
		{ status: 400 },
	);
}

function transientFailure(): Response {
	return Response.json({ error: { message: "too many requests" } }, { status: 429 });
}

function isCapabilityProbe(body: Record<string, unknown>): boolean {
	return JSON.stringify(body.messages ?? "").includes("17 times 23");
}

function chatSuccess(reasoningTokens = 0): Response {
	const chunks = [
		{ id: "probe", choices: [{ index: 0, delta: { content: "391" } }] },
		{
			id: "probe",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 3,
				completion_tokens_details: { reasoning_tokens: reasoningTokens },
			},
		},
	];
	return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function anthropicSuccess(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "probe",
				type: "message",
				role: "assistant",
				content: [],
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "391" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function googleSuccess(): Response {
	return new Response(
		`data: ${JSON.stringify({
			candidates: [{ content: { parts: [{ text: "391" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
		})}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function nested(body: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = body[key];
	return isRecord(value) ? value : {};
}

describe("unknown-model thinking negotiation", () => {
	it("tests the full string ladder concurrently, persists rejections, and clamps later turns without probing again", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const dbPath = temp.join("models.db");
		const model = unknownModel("openai-completions");
		const gate = Promise.withResolvers<void>();
		const requests: Record<string, unknown>[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			if (requests.length === THINKING_EFFORTS.length + 1) gate.resolve();
			await untilAborted(init?.signal ?? undefined, () => gate.promise);
			const effort = body.reasoning_effort;
			return effort === undefined || effort === "low" || effort === "high" || effort === "max"
				? chatSuccess()
				: rejection();
		};
		const options = {
			apiKey: "test",
			fetch,
			thinkingCapabilityDbPath: dbPath,
			signal: AbortSignal.timeout(4000),
		};
		const first = await streamSimple(model, context, { ...options, reasoning: Effort.XHigh }).result();
		expect(first.stopReason).toBe("stop");
		expect(
			requests
				.slice(0, 7)
				.flatMap(body => (body.reasoning_effort === undefined ? [] : [body.reasoning_effort]))
				.sort(),
		).toEqual([...THINKING_EFFORTS].sort());
		expect(requests).toHaveLength(8);
		expect(requests.at(-1)?.reasoning_effort).toBe("high");
		const saved = readThinkingCapability(model, dbPath);
		expect(saved?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(saved?.observed).toBe(false);
		expect(
			saved?.attempts
				.filter(attempt => !attempt.accepted)
				.map(attempt => attempt.effort)
				.sort(),
		).toEqual([Effort.Medium, Effort.Minimal, Effort.XHigh]);
		const second = await streamSimple(unknownModel("openai-completions"), context, {
			...options,
			reasoning: Effort.Max,
		}).result();
		expect(second.stopReason).toBe("stop");
		expect(requests).toHaveLength(9);
		expect(requests.at(-1)?.reasoning_effort).toBe("max");
	});

	it("learns nested reasoning.effort after top-level strings fail and uses that format for the real turn", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		const requests: Record<string, unknown>[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			if (body.reasoning_effort !== undefined) return rejection();
			const effort = nested(body, "reasoning").effort;
			if (effort !== undefined) return effort === "medium" || effort === "high" ? chatSuccess() : rejection();
			if (body.thinking || body.enable_thinking || body.chat_template_kwargs) return rejection();
			return chatSuccess();
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.Max,
			thinkingCapabilityDbPath: temp.join("models.db"),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(readThinkingCapability(model, temp.join("models.db"))?.format).toBe("openrouter");
		expect(requests.at(-1)?.reasoning).toEqual({ effort: "high" });
		expect(requests.at(-1)?.reasoning_effort).toBeUndefined();
	});

	it("falls back from Anthropic adaptive effort to budget thinking and retains answer room", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("anthropic-messages");
		const requests: Record<string, unknown>[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			return nested(body, "thinking").type === "adaptive" ? rejection() : anthropicSuccess();
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.High,
			maxTokens: 256,
			thinkingCapabilityDbPath: temp.join("models.db"),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(readThinkingCapability(model, temp.join("models.db"))?.format).toBe("anthropic-budget");
		const sent = requests.at(-1);
		if (!sent) throw new Error("Missing real request");
		expect(nested(sent, "thinking")).toMatchObject({ type: "enabled", budget_tokens: 16384 });
		expect(Number(sent.max_tokens)).toBeGreaterThan(16384);
		expect(sent.output_config).toBeUndefined();
	});

	it("falls back from Google levels to thinkingBudget and sends the learned budget on the real turn", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("google-generative-ai");
		const requests: Record<string, unknown>[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			const thinking = nested(nested(body, "generationConfig"), "thinkingConfig");
			return thinking.thinkingLevel === undefined ? googleSuccess() : rejection();
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.Medium,
			thinkingCapabilityDbPath: temp.join("models.db"),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(readThinkingCapability(model, temp.join("models.db"))?.format).toBe("google-budget");
		const sent = requests.at(-1);
		if (!sent) throw new Error("Missing real request");
		expect(nested(nested(sent, "generationConfig"), "thinkingConfig")).toMatchObject({ thinkingBudget: 8192 });
	});

	it("does not save a rate-limit failure as lack of thinking support", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		let calls = 0;
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			calls++;
			if (calls <= 7) return Response.json({ error: { message: "too many requests" } }, { status: 429 });
			expect(body.reasoning_effort).toBe("high");
			return chatSuccess();
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.High,
			thinkingCapabilityDbPath: temp.join("models.db"),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(readThinkingCapability(model, temp.join("models.db"))).toBeUndefined();
	});

	it("shares one probe across simultaneous turns without letting one caller's abort cancel the other", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		const ready = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const controller = new AbortController();
		let calls = 0;
		const fetch: FetchImpl = async (_url, init) => {
			calls++;
			if (calls === 7) ready.resolve();
			await untilAborted(init?.signal ?? undefined, () => gate.promise);
			return chatSuccess();
		};
		const options = {
			apiKey: "test",
			fetch,
			reasoning: Effort.High,
			thinkingCapabilityDbPath: temp.join("models.db"),
		};
		const first = streamSimple(model, context, { ...options, signal: controller.signal }).result();
		const second = streamSimple(model, context, { ...options, signal: AbortSignal.timeout(4000) }).result();
		await ready.promise;
		controller.abort(new Error("first caller cancelled"));
		await expect(first).rejects.toThrow("first caller cancelled");
		gate.resolve();
		expect((await second).stopReason).toBe("stop");
		expect(calls).toBe(8);
		expect(readThinkingCapability(model, temp.join("models.db"))?.efforts).toEqual(THINKING_EFFORTS);
	});

	it("retains native reasoning without inventing an effort dial when every control format is rejected", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		const requests: Record<string, unknown>[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			return body.reasoning_effort ||
				body.reasoning ||
				body.thinking ||
				body.enable_thinking ||
				body.chat_template_kwargs
				? rejection()
				: chatSuccess(2);
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.High,
			thinkingCapabilityDbPath: temp.join("models.db"),
		}).result();
		expect(result.usage.reasoningTokens).toBe(2);
		expect(readThinkingCapability(model, temp.join("models.db"))).toMatchObject({
			format: "none",
			observed: true,
			efforts: [],
		});
		expect(requests.at(-1)?.reasoning_effort).toBeUndefined();
	});

	it("saves a finished alternate format when another format in the batch fails transiently", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		const dbPath = temp.join("models.db");
		const requests: Record<string, unknown>[] = [];
		let sawTransient = false;
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			if (!isCapabilityProbe(body)) return chatSuccess();
			if (typeof body.reasoning_effort === "string") return rejection();
			const effort = nested(body, "reasoning").effort;
			if (typeof effort === "string") return chatSuccess();
			const kwargs = body.chat_template_kwargs;
			if (isRecord(kwargs) && kwargs.thinking === true) {
				if (kwargs.reasoning_effort === "minimal") {
					sawTransient = true;
					return transientFailure();
				}
				return rejection();
			}
			if (body.thinking || body.enable_thinking || body.chat_template_kwargs) return rejection();
			return chatSuccess();
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.Max,
			thinkingCapabilityDbPath: dbPath,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(sawTransient).toBe(true);
		expect(readThinkingCapability(model, dbPath)?.format).toBe("openrouter");
		expect(requests.at(-1)?.reasoning).toEqual({ effort: "max" });
		expect(requests.at(-1)?.reasoning_effort).toBeUndefined();
	});

	it("prefers an earlier partly-accepted format over a later finished format without caching", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		const dbPath = temp.join("models.db");
		const requests: Record<string, unknown>[] = [];
		let failMediumOnce = true;
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			if (!isCapabilityProbe(body)) return chatSuccess();
			if (typeof body.reasoning_effort === "string") return rejection();
			const effort = nested(body, "reasoning").effort;
			if (typeof effort === "string") {
				if (effort === "high") return chatSuccess();
				if (effort === "medium") {
					if (failMediumOnce) {
						failMediumOnce = false;
						return transientFailure();
					}
					return chatSuccess();
				}
				return rejection();
			}
			if (isRecord(body.thinking)) return chatSuccess();
			if (body.enable_thinking || body.chat_template_kwargs) return rejection();
			return chatSuccess();
		};
		const first = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.Max,
			thinkingCapabilityDbPath: dbPath,
		}).result();
		expect(first.stopReason).toBe("stop");
		expect(failMediumOnce).toBe(false);
		expect(readThinkingCapability(model, dbPath)).toBeUndefined();
		expect(requests.at(-1)?.reasoning).toEqual({ effort: "high" });
		expect(requests.at(-1)?.thinking).toBeUndefined();
		expect(requests.at(-1)?.reasoning_effort).toBeUndefined();

		const second = await streamSimple(unknownModel("openai-completions"), context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.Medium,
			thinkingCapabilityDbPath: dbPath,
		}).result();
		expect(second.stopReason).toBe("stop");
		expect(readThinkingCapability(model, dbPath)).toMatchObject({
			format: "openrouter",
			efforts: [Effort.Medium, Effort.High],
		});
		expect(requests.at(-1)?.reasoning).toEqual({ effort: "medium" });
		expect(requests.at(-1)?.thinking).toBeUndefined();
	});

	it("does not cache a later finished format when a preferred format is inconclusive without accepted tiers", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		const dbPath = temp.join("models.db");
		const requests: Record<string, unknown>[] = [];
		let failHighOnce = true;
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			if (!isCapabilityProbe(body)) return chatSuccess();
			if (typeof body.reasoning_effort === "string") return rejection();
			const effort = nested(body, "reasoning").effort;
			if (typeof effort === "string") {
				if (effort === "high") {
					if (failHighOnce) {
						failHighOnce = false;
						return transientFailure();
					}
					return chatSuccess();
				}
				return rejection();
			}
			if (isRecord(body.thinking)) return chatSuccess();
			if (body.enable_thinking || body.chat_template_kwargs) return rejection();
			return chatSuccess();
		};
		const first = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.Max,
			thinkingCapabilityDbPath: dbPath,
		}).result();
		expect(first.stopReason).toBe("stop");
		expect(failHighOnce).toBe(false);
		expect(readThinkingCapability(model, dbPath)).toBeUndefined();
		expect(requests.at(-1)?.thinking).toEqual({ type: "enabled" });
		expect(requests.at(-1)?.reasoning).toBeUndefined();
		expect(requests.at(-1)?.reasoning_effort).toBeUndefined();

		const second = await streamSimple(unknownModel("openai-completions"), context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.Max,
			thinkingCapabilityDbPath: dbPath,
		}).result();
		expect(second.stopReason).toBe("stop");
		expect(readThinkingCapability(model, dbPath)).toMatchObject({
			format: "openrouter",
			efforts: [Effort.High],
		});
		expect(requests.at(-1)?.reasoning).toEqual({ effort: "high" });
		expect(requests.at(-1)?.thinking).toBeUndefined();
	});

	it("uses an accepted effort from an unfinished ladder and does not repeat a rejected format", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		const dbPath = temp.join("models.db");
		const requests: Record<string, unknown>[] = [];
		let sawTransient = false;
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			if (!isCapabilityProbe(body)) return chatSuccess();
			if (typeof body.reasoning_effort === "string") return rejection();
			const effort = nested(body, "reasoning").effort;
			if (typeof effort === "string") {
				if (effort === "high") return chatSuccess();
				if (effort === "medium") {
					sawTransient = true;
					return transientFailure();
				}
				return rejection();
			}
			if (body.thinking || body.enable_thinking || body.chat_template_kwargs) return rejection();
			return chatSuccess();
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.Max,
			thinkingCapabilityDbPath: dbPath,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(sawTransient).toBe(true);
		expect(readThinkingCapability(model, dbPath)).toBeUndefined();
		expect(requests.at(-1)?.reasoning).toEqual({ effort: "high" });
		expect(requests.at(-1)?.reasoning_effort).toBeUndefined();
	});

	it("skips thinking formats the probe already rejected when a later one did not finish", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		const dbPath = temp.join("models.db");
		const requests: Record<string, unknown>[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			if (!isCapabilityProbe(body)) return chatSuccess();
			if (typeof body.reasoning_effort === "string") return rejection();
			if (typeof nested(body, "reasoning").effort === "string") return rejection();
			if (isRecord(body.thinking)) return rejection();
			if (body.enable_thinking || body.chat_template_kwargs) return transientFailure();
			return chatSuccess();
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.High,
			thinkingCapabilityDbPath: dbPath,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(readThinkingCapability(model, dbPath)).toBeUndefined();
		expect(requests.at(-1)?.enable_thinking).toBe(true);
		expect(requests.at(-1)?.thinking).toBeUndefined();
		expect(requests.at(-1)?.reasoning_effort).toBeUndefined();
		expect(requests.at(-1)?.reasoning).toBeUndefined();
	});

	it("does not send an effort the probe already rejected when the rest of that ladder is inconclusive", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		const dbPath = temp.join("models.db");
		const requests: Record<string, unknown>[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			if (!isCapabilityProbe(body)) return chatSuccess();
			if (typeof body.reasoning_effort === "string") return rejection();
			const effort = nested(body, "reasoning").effort;
			if (effort === "max") return rejection();
			if (typeof effort === "string") return transientFailure();
			if (body.thinking || body.enable_thinking || body.chat_template_kwargs) return transientFailure();
			return chatSuccess();
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.Max,
			thinkingCapabilityDbPath: dbPath,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(readThinkingCapability(model, dbPath)).toBeUndefined();
		expect(requests.at(-1)?.reasoning).toEqual({ effort: "xhigh" });
		expect(requests.at(-1)?.reasoning_effort).toBeUndefined();
	});

	it("sends a plain request and does not save it when the plain check does not finish and every thinking style is refused", async () => {
		await using temp = await TempDir.create("@thinking-probe-");
		const model = unknownModel("openai-completions");
		const dbPath = temp.join("models.db");
		const requests: Record<string, unknown>[] = [];
		let plainProbeFailed = false;
		const fetch: FetchImpl = async (_url, init) => {
			const body = bodyRecord(init);
			requests.push(body);
			if (!isCapabilityProbe(body)) return chatSuccess();
			if (
				body.reasoning_effort ||
				body.reasoning ||
				body.thinking ||
				body.enable_thinking ||
				body.chat_template_kwargs
			) {
				return rejection();
			}
			plainProbeFailed = true;
			return transientFailure();
		};
		const result = await streamSimple(model, context, {
			apiKey: "test",
			fetch,
			reasoning: Effort.High,
			thinkingCapabilityDbPath: dbPath,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(plainProbeFailed).toBe(true);
		expect(requests.some(body => typeof body.reasoning_effort === "string")).toBe(true);
		expect(readThinkingCapability(model, dbPath)).toBeUndefined();
		const sent = requests.at(-1);
		if (!sent) throw new Error("Missing real request");
		expect(isCapabilityProbe(sent)).toBe(false);
		expect(sent.reasoning_effort).toBeUndefined();
		expect(sent.reasoning).toBeUndefined();
		expect(sent.thinking).toBeUndefined();
		expect(sent.enable_thinking).toBeUndefined();
		expect(sent.chat_template_kwargs).toBeUndefined();
	});
});
