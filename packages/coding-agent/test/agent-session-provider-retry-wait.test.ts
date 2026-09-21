/**
 * Contract: a provider-INTERNAL retry backoff (pi-ai sleeping between its own
 * stream attempts) surfaces on the session built by `createAgentSession` as
 * `provider_retry_wait_start` / `provider_retry_wait_end`.
 *
 * Before this wiring those sleeps were silent: `StreamOptions.providerRetryWait`
 * was never supplied outside packages/ai, so the session only learned about a
 * provider problem after pi-ai had exhausted its own retries and the
 * session-level saga emitted `auto_retry_start`. A multi-second — or, with a
 * `retry-after` header, multi-minute — wait looked like a frozen turn.
 *
 * This drives the REAL SDK stream function (`session.agent.streamFn`, the
 * settings-aware wrapper createAgentSession installs), so it fails if sdk.ts
 * stops passing its observer. The wait is not a turn supersession, so
 * `auto_retry_start` must stay silent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

/** Minimal well-formed Anthropic SSE turn; shape copied from packages/ai/test/anthropic-stream-timeout.test.ts. */
function anthropicSseResponse(text: string): Response {
	const events: Array<Record<string, unknown>> = [
		{
			type: "message_start",
			message: {
				id: "msg_retry_wait",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", "request-id": "req_retry_wait" },
	});
}

describe("createAgentSession provider retry wait visibility", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-provider-retry-wait-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await Promise.all(sessions.map(session => session.dispose().catch(() => {})));
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	it("reports the provider's own stream-retry backoff as session events, with no auto-retry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);

		// The stream-retry backoff goes through `scheduler.wait`, so the whole
		// saga settles instantly.
		mockSchedulerWaitWithClock();

		// First attempt: a 200 SSE body that ends before `message_start`. That is
		// exactly the pre-content envelope failure pi-ai classifies as
		// provider-retryable, so the anthropic stream loop backs off through
		// `providerRetryWait` and re-issues the request.
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls++;
			if (fetchCalls === 1) {
				return new Response('event: ping\ndata: {"type":"ping"}\n\n', {
					status: 200,
					headers: { "content-type": "text/event-stream", "request-id": "req_truncated" },
				});
			}
			return anthropicSseResponse("hi");
		};

		const seen: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type.startsWith("provider_retry_wait") || event.type === "auto_retry_start") seen.push(event);
		});
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [],
			systemPrompt: [],
		};
		try {
			// The SDK wrapper chain (provider concurrency) is async, so the stream
			// itself arrives through a promise.
			const stream = await session.agent.streamFn(model, context, { apiKey: "sk-ant-test", fetch: fetchMock });
			const message = await stream.result();
			// The retry recovered: the caller sees the second attempt's real turn.
			expect(message.stopReason).toBe("stop");
		} finally {
			unsubscribe();
		}

		expect(fetchCalls).toBe(2);
		expect(seen).toHaveLength(2);
		const [start, end] = seen;
		expect(start).toMatchObject({
			type: "provider_retry_wait_start",
			model: model.id,
			provider: model.provider,
			api: model.api,
		});
		expect((start as Extract<AgentSessionEvent, { type: "provider_retry_wait_start" }>).delayMs).toBeGreaterThan(0);
		expect(end).toEqual({ type: "provider_retry_wait_end", aborted: false });
	});
});
