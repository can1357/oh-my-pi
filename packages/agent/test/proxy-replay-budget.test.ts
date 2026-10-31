/**
 * `streamProxy` sends the call to a remote server, which runs the provider and
 * its replays. A caller's `replayBudgetMs` must reach that server, or a proxied
 * call runs to the server's own retry ceiling whatever budget the caller set.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { streamProxy } from "@oh-my-pi/pi-agent-core/proxy";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const stops: Array<() => void> = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

/** A local proxy endpoint that records each request's forwarded options and answers a finished turn. */
function startProxy(): { url: string; forwarded: Array<Record<string, unknown>> } {
	const forwarded: Array<Record<string, unknown>> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { options: Record<string, unknown> };
			forwarded.push(body.options);
			const frames = [{ type: "start" }, { type: "done", reason: "stop", usage }];
			return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	stops.push(() => server.stop(true));
	return { url: `http://127.0.0.1:${server.port}`, forwarded };
}

describe("streamProxy and the caller's replay budget", () => {
	it("forwards replayBudgetMs to the server that runs the call", async () => {
		const proxy = startProxy();

		await streamProxy(model, context, {
			authToken: "proxy-token",
			proxyUrl: proxy.url,
			replayBudgetMs: 2_000,
		}).result();

		expect(proxy.forwarded).toHaveLength(1);
		expect(proxy.forwarded[0]!.replayBudgetMs).toBe(2_000);
	});

	it("sends no budget when the caller set none, so the server keeps its own ceiling", async () => {
		const proxy = startProxy();

		await streamProxy(model, context, { authToken: "proxy-token", proxyUrl: proxy.url }).result();

		expect(proxy.forwarded).toHaveLength(1);
		expect("replayBudgetMs" in proxy.forwarded[0]!).toBe(false);
	});
});
