/**
 * Turn recovery holds the fallback chain for a cut stream only when the
 * failure reports it went out exactly once (`providerReplays === 0`). Through
 * `streamProxy`, that count has to survive the proxy's terminal frame:
 * dropped, every proxied cut walks the chain at once, and a replay budget
 * reading it undercounts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { streamProxy } from "@oh-my-pi/pi-agent-core/proxy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
const fallback = getBundledModel("anthropic", "claude-haiku-4-5");
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A session on `primary` with `fallback` in its chain, whose model calls go
 * through a real local proxy. The proxy cuts every `primary` turn (with
 * `providerReplays` set on the frame when `replays` is given) and answers
 * `fallback`. Returns the model id of each proxy request, in order.
 */
async function runProxiedSession(replays: number | undefined): Promise<string[]> {
	const requests: string[] = [];
	const proxy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { model: { id: string } };
			requests.push(body.model.id);
			const terminal =
				body.model.id === primary.id
					? {
							type: "error",
							reason: "error",
							errorMessage: "read ECONNRESET",
							usage,
							...(replays === undefined ? {} : { providerReplays: replays }),
						}
					: { type: "done", reason: "stop", usage, content: [{ type: "text", text: "ok" }] };
			return new Response(`data: ${JSON.stringify({ type: "start" })}\n\ndata: ${JSON.stringify(terminal)}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	cleanups.push(() => proxy.stop(true));
	const dir = TempDir.createSync("@pi-proxy-replays-");
	cleanups.push(() => dir.removeSync());
	const auth = await AuthStorage.create(`${dir.path()}/auth.db`);
	cleanups.push(() => auth.close());
	auth.keys.setRuntime("anthropic", "test-key");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: primary, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: (model, context, options) =>
			streamProxy(model, context, {
				...options,
				authToken: "proxy-token",
				proxyUrl: `http://127.0.0.1:${proxy.port}`,
			}),
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 1,
		"retry.maxDelayMs": 1000,
		"retry.maxRetries": 3,
		"retry.modelFallback": true,
		"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
	});
	settings.setModelRole("default", `${primary.provider}/${primary.id}`);
	const manager = SessionManager.create(dir.path(), `${dir.path()}/sessions`);
	cleanups.push(() => manager.close());
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(auth, `${dir.path()}/models.yml`),
	});
	cleanups.push(() => session.dispose());
	await session.prompt("test");
	await session.waitForIdle();
	return requests;
}

describe("turn recovery reads the proxied replay count", () => {
	it("holds the chain for a proxied cut that reports going out once", async () => {
		const requests = await runProxiedSession(0);
		// The first cut and two held retries on the primary, then the chain.
		expect(requests).toEqual([primary.id, primary.id, primary.id, fallback.id]);
	}, 60_000);

	it("walks the chain at once when the proxied cut reports no count", async () => {
		const requests = await runProxiedSession(undefined);
		expect(requests).toEqual([primary.id, fallback.id]);
	}, 60_000);
});
