import { expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { lastDispatchOrigin, transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";

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
		() => {
			if (++admitted > 1) throw new Error("cost cap reached");
		},
	);
	await fetch("https://first.invalid/v1/chat/completions", { method: "POST" });
	await expect(fetch("https://second.invalid/v1/chat/completions", { method: "POST" })).rejects.toThrow(
		"cost cap reached",
	);
	expect(sent).toBe(1);
	expect(lastDispatchOrigin(model)).toBe("https://first.invalid");
});

it("does not send a request whose signal aborted before it reached the transport", async () => {
	const model = buildModel({
		id: "aborted-before-transport",
		name: "Aborted Before Transport",
		api: "openai-completions",
		provider: "test-aborted-before-transport",
		baseUrl: "https://aborted.invalid/v1",
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
			return new Response("ok");
		},
		() => {
			admitted++;
		},
	);
	const url = "https://aborted.invalid/v1/chat/completions";
	const cancelled = new AbortController();
	const reason = new Error("caller cancelled");
	cancelled.abort(reason);
	await expect(fetch(url, { method: "POST", signal: cancelled.signal })).rejects.toBe(reason);
	expect(sent).toBe(0);
	expect(admitted).toBe(0);
	expect(lastDispatchOrigin(model)).toBeUndefined();

	await fetch(url, { method: "POST", signal: new AbortController().signal });
	expect(sent).toBe(1);
});

it("does not send a Request whose own signal aborted before it reached the transport", async () => {
	const model = buildModel({
		id: "aborted-request-before-transport",
		name: "Aborted Request Before Transport",
		api: "openai-completions",
		provider: "test-aborted-request-before-transport",
		baseUrl: "https://aborted-request.invalid/v1",
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
			return new Response("ok");
		},
		() => {
			admitted++;
		},
	);
	const url = "https://aborted-request.invalid/v1/chat/completions";
	const cancelled = new AbortController();
	const reason = new Error("caller cancelled the request");
	cancelled.abort(reason);
	const request = new Request(url, { method: "POST", signal: cancelled.signal });
	await expect(fetch(request)).rejects.toBe(reason);
	await expect(fetch(request, { signal: undefined })).rejects.toBe(reason);
	expect(sent).toBe(0);
	expect(admitted).toBe(0);
	expect(lastDispatchOrigin(model)).toBeUndefined();

	// As with `fetch`, a live `init.signal` replaces the request's own signal, and `signal: null` clears it.
	await fetch(request, { signal: new AbortController().signal });
	expect(sent).toBe(1);
	await fetch(request, { signal: null });
	expect(sent).toBe(2);
});
