import { afterEach, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ReplayBudget } from "@oh-my-pi/pi-ai/utils/replay-budget";
import { lastDispatchOrigin, transportFetch, withRequestTransport } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { RetryRefusedError } from "@oh-my-pi/pi-utils";

afterEach(() => vi.restoreAllMocks());

it("refuses a later HTTP attempt after the cost gate closes without recording a dispatch", async () => {
	const model = buildModel({
		id: "cost-gate-attempt",
		name: "Cost Gate Attempt",
		api: "openai-completions",
		provider: "test-cost-gate-transport",
		baseUrl: "https://first.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	});
	let admitted = 0;
	let sent = 0;
	const fetch = transportFetch(
		model,
		async () => {
			sent++;
			return new Response("retryable", { status: 429 });
		},
		{
			beforeDispatch: () => {
				if (++admitted > 1) throw new Error("cost cap reached");
			},
		},
	);
	await fetch("https://first.invalid/v1/chat/completions", { method: "POST" });
	await expect(fetch("https://second.invalid/v1/chat/completions", { method: "POST" })).rejects.toThrow(
		"cost cap reached",
	);
	expect(sent).toBe(1);
	expect(lastDispatchOrigin(model)).toBe("https://first.invalid");
});

it("checks the current call's budget after a prebuilt transport's preparation hook", async () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const model = buildModel({
		id: "prebuilt-budget",
		name: "Prebuilt Budget",
		api: "openai-completions",
		provider: "test-prebuilt-budget",
		baseUrl: "https://prebuilt.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	});
	let sent = 0;
	const prebuilt = transportFetch(
		model,
		async () => {
			sent++;
			return new Response("ok");
		},
		{
			beforeDispatch: () => {
				now += 30;
			},
		},
	);
	const options = withRequestTransport(model, { fetch: prebuilt, replayBudgetMs: 10 });
	const budget = ReplayBudget.forCall(options);
	budget?.arm(new Error("503 original overload"));
	await expect(
		options.fetch("https://prebuilt.invalid/v1/chat/completions", { method: "POST" }),
	).rejects.toBeInstanceOf(RetryRefusedError);
	expect(now).toBe(30);
	expect(sent).toBe(0);
});

it("rebinds a built transport to new hooks without changing another call's hooks", async () => {
	const model = buildModel({
		id: "transport-hooks",
		name: "Transport Hooks",
		api: "openai-completions",
		provider: "test-transport-hooks",
		baseUrl: "https://hooks.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	});
	const dispatches: string[] = [];
	let sent = 0;
	const original = transportFetch(
		model,
		async () => {
			sent++;
			return new Response("ok");
		},
		{
			beforeDispatch: () => {
				dispatches.push("original");
			},
		},
	);
	const rebound = transportFetch(model, original, {
		beforeDispatch: () => {
			dispatches.push("new");
		},
	});
	await rebound("https://hooks.invalid/v1/chat/completions", { method: "POST" });
	await original("https://hooks.invalid/v1/chat/completions", { method: "POST" });
	expect(dispatches).toEqual(["new", "original"]);
	expect(sent).toBe(2);
});
