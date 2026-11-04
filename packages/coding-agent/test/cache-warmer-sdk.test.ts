/**
 * The prompt-cache warmer must schedule from the request the provider actually
 * sent. A `before_provider_request` extension may replace the payload; when it
 * drops the 1-hour `cache_control.ttl`, the wire carries 5-minute entries, and a
 * warmer still reading the original payload would wait ~54 minutes to refresh
 * an entry that expired after 5. This drives the real SDK session against a
 * local Messages API endpoint configured through models.yml.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CacheWarmingStatus } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "local-anthropic";
const MODEL_ID = "claude-sonnet-4-6";
const PROMPT = "warm the cache";
/** Refresh delays for the model's declared lifetimes: 90% of 300 s and of 3600 s. */
const SHORT_REFRESH_MS = 270_000;
const LONG_REFRESH_MS = 3_240_000;
/** Slack between the warmer's dispatch hook and the server reading the request. */
const SEND_SLACK_MS = 5_000;

interface CacheControl {
	type?: string;
	ttl?: string;
}

interface SentRequest {
	ttls: (string | undefined)[];
	/** The session's warming state when the server received the request. */
	status: CacheWarmingStatus | undefined;
	/** The warmer's next refresh, measured from when the server received the request. */
	refreshInMs: number | undefined;
}

/** One answer that reports a cache write without a per-TTL breakdown, so the response does not settle the tier. */
function answer(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_local",
				type: "message",
				role: "assistant",
				content: [],
				model: MODEL_ID,
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: 10,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 100_000,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A copy of the payload whose cache breakpoints carry no `ttl`, i.e. the provider's 5-minute default. */
function withoutCacheTtl(payload: unknown): unknown {
	return JSON.parse(JSON.stringify(payload), (key, value: unknown) => {
		if (key !== "cache_control" || typeof value !== "object" || value === null) return value;
		const { ttl: _ttl, ...rest } = value as CacheControl;
		return rest;
	});
}

const stripCacheTtl: ExtensionFactory = pi => {
	pi.on("before_provider_request", event => withoutCacheTtl(event.payload));
};

describe("prompt-cache warming through the SDK session", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	/**
	 * Runs two turns on a provider configured for 1-hour entries and reports the second request as the server
	 * received it. The first turn gives the warmer the prompt size it prices a refresh with; until then it
	 * schedules nothing.
	 */
	async function runConversation(extensions: ExtensionFactory[]) {
		const tempDir = TempDir.createSync("@pi-cache-warmer-sdk-");
		cleanups.push(() => tempDir.remove());
		const requests: SentRequest[] = [];
		const live: { session?: AgentSession } = {};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const receivedAt = Date.now();
				const text = await request.text();
				if (!text.includes(PROMPT)) return new Response("unexpected request", { status: 400 });
				const controls: CacheControl[] = [];
				JSON.parse(text, (key, value: unknown) => {
					if (key === "cache_control") controls.push(value as CacheControl);
					return value;
				});
				// The provider called `onPayload` before sending: the warmer has already scheduled from it.
				const status: CacheWarmingStatus | undefined = live.session?.cacheWarmingStatus;
				requests.push({
					ttls: controls.map(control => control.ttl),
					status,
					refreshInMs: status?.nextWarmAt === undefined ? undefined : status.nextWarmAt - receivedAt,
				});
				return answer();
			},
		});
		cleanups.push(() => server.stop(true));

		await Bun.write(
			tempDir.join("models.yml"),
			JSON.stringify({
				providers: {
					[PROVIDER]: {
						api: "anthropic-messages",
						baseUrl: `${server.url.origin}/v1`,
						apiKey: "local-test-key",
						cacheRetention: "long",
						compat: { supportsLongCacheRetention: true },
						models: [
							{
								id: MODEL_ID,
								name: "Local Sonnet",
								reasoning: false,
								input: ["text"],
								cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
								contextWindow: 200_000,
								maxTokens: 8192,
								promptCache: { short: 300, long: 3600 },
							},
						],
					},
				},
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime(PROVIDER, "local-test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		await modelRegistry.refresh();
		const model = modelRegistry.find(PROVIDER, MODEL_ID);
		if (!model) throw new Error("Expected the models.yml provider to register its model");

		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"providers.cacheWarming": "idle",
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
			model,
			disableExtensionDiscovery: true,
			extensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		cleanups.push(() => session.dispose());
		live.session = session;

		await session.prompt(`${PROMPT}: first`);
		await session.prompt(`${PROMPT}: second`);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		return { sent: requests[1]!, session };
	}

	it("schedules the refresh for the 5-minute entries an extension's replacement payload sent", async () => {
		const { sent, session } = await runConversation([stripCacheTtl]);

		expect(sent.ttls.length).toBeGreaterThan(0);
		expect(sent.ttls.every(ttl => ttl === undefined)).toBe(true);
		expect(sent.status).toMatchObject({ state: "scheduled" });
		expect(sent.refreshInMs).toBeLessThanOrEqual(SHORT_REFRESH_MS);
		expect(sent.refreshInMs).toBeGreaterThan(SHORT_REFRESH_MS - SEND_SLACK_MS);
		// Once idle, the warmer keeps the 5-minute entry warm instead of giving up on a 1-hour one.
		const entry = session.promptCacheEntry;
		expect(entry).toMatchObject({ tier: "short", ttlMs: 300_000 });
		const status = session.cacheWarmingStatus;
		expect(status?.state).toBe("scheduled");
		// The schedule counts from the send that touched the entry (the two clock reads may differ by a tick).
		const refreshAfterSendMs = status!.nextWarmAt! - entry!.touchedAt;
		expect(refreshAfterSendMs).toBeGreaterThanOrEqual(SHORT_REFRESH_MS);
		expect(refreshAfterSendMs).toBeLessThan(SHORT_REFRESH_MS + 1_000);
	});

	it("schedules the 1-hour refresh when the sent payload keeps the provider's 1-hour entries", async () => {
		const { sent, session } = await runConversation([]);

		expect(sent.ttls.length).toBeGreaterThan(0);
		expect(sent.ttls.every(ttl => ttl === "1h")).toBe(true);
		expect(sent.status).toMatchObject({ state: "scheduled" });
		expect(sent.refreshInMs).toBeLessThanOrEqual(LONG_REFRESH_MS);
		expect(sent.refreshInMs).toBeGreaterThan(LONG_REFRESH_MS - SEND_SLACK_MS);
		expect(session.promptCacheEntry).toMatchObject({ tier: "long", ttlMs: 3_600_000 });
	});
});
