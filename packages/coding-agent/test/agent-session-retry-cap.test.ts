import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ApiKeyResolveContext, AssistantMessage, ToolCall } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

function resolveInitialApiKey(
	apiKey: string | ((ctx: ApiKeyResolveContext) => string | Promise<string | undefined> | undefined) | undefined,
): string {
	const resolved = typeof apiKey === "function" ? apiKey({ lastChance: false, error: undefined }) : apiKey;
	if (typeof resolved !== "string") {
		throw new Error("Expected API key to be resolved before streaming");
	}
	return resolved;
}

/**
 * Contract: when the provider asks us to wait longer than `retry.maxDelayMs`
 * and we have no credential/model fallback to switch to, the auto-retry
 * loop MUST fail fast — preserving the terminal error message in agent
 * state and skipping the long sleep entirely.
 *
 * Without this defense, an Anthropic `429 rate_limit_error` with
 * `retry-after-ms=11180000` (≈3 hours) pinned a subagent in the retry
 * sleep, leaving the parent task tool stuck on the review phase for hours
 * (see GitHub issue #607).
 */
describe("AgentSession retry delay cap", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-retry-cap-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("bails immediately when retry-after exceeds retry.maxDelayMs", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		// 11.18M ms == ~3.1 hours, matching the report on the original incident.
		const rateLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=11180000';

		const mock = createMockModel({ handler: () => ({ throw: rateLimitError }) });
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Spy after construction so the constructor's no-op work isn't intercepted.
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger rate limit with long retry-after");
		await session.waitForIdle();

		// Only one model call: the auto-retry MUST NOT loop into a fresh attempt
		// because the cap fired before scheduler.wait was even reached.
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
		expect(retryEndEvents[0].finalError).toContain("11180000");
		// No multi-hour (or any) sleep — the cap path skips scheduler.wait entirely.
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}

		// The terminal error stays as the last assistant message so the caller
		// (interactive UI, parent task tool, SDK consumer) can act on it.
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("rate_limit_error");
		expect(session.isRetrying).toBe(false);
	});

	it("switches credentials instead of failing the delay cap for account rate limits", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		authStorage.removeRuntimeApiKey("anthropic");
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
		]);

		const rateLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=11180000';
		const mock = createMockModel();
		const requestedKeys: string[] = [];
		let agent!: Agent;
		agent = new Agent({
			getApiKey: model => modelRegistry.resolver(model, agent.sessionId),
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const apiKey = resolveInitialApiKey(options?.apiKey);
				requestedKeys.push(apiKey);
				if (requestedKeys.length === 1) {
					mock.push({ throw: rateLimitError });
				} else {
					mock.push({ content: ["recovered after credential switch"] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger account rate limit with long retry-after");
		await session.waitForIdle();

		expect(requestedKeys).toHaveLength(2);
		expect(new Set(requestedKeys).size).toBe(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({ delayMs: 0 });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after credential switch" });
	});

	it("waits for the earliest sibling unblock instead of failing the delay cap", async () => {
		// Regression: with every sibling credential momentarily blocked (e.g. a
		// short post-401 or usage-probe block), a usage-limit 429 with a
		// multi-hour retry-after used to adopt the full provider wait and trip
		// the fail-fast cap ("gave up after 1 attempt") — even though a sibling
		// would have been usable seconds later. The retry delay must track the
		// earliest sibling unblock, not the provider window.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		authStorage.removeRuntimeApiKey("anthropic");
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
		]);

		// Another session holds one credential and parks it for 2s — the test
		// session lands on the sibling.
		await modelRegistry.getApiKeyForProvider("anthropic", "other-session");
		const blocked = await authStorage.markUsageLimitReached("anthropic", "other-session", { retryAfterMs: 2_000 });
		expect(blocked.switched).toBe(true);

		const rateLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=11180000';
		const mock = createMockModel();
		let attempts = 0;
		let agent!: Agent;
		agent = new Agent({
			getApiKey: model => modelRegistry.resolver(model, agent.sessionId),
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				attempts += 1;
				mock.push(attempts === 1 ? { throw: rateLimitError } : { content: ["recovered after sibling unblock"] });
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger account rate limit while the sibling is briefly blocked");
		await session.waitForIdle();

		expect(attempts).toBe(2);
		expect(retryStartEvents).toHaveLength(1);
		// ~2s sibling block + 1s buffer — NOT the provider's 11180s window and
		// NOT the fail-fast bail (which would emit zero start events).
		expect(retryStartEvents[0].delayMs).toBeGreaterThanOrEqual(1_000);
		expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(3_000);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(5_000);
		}
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after sibling unblock" });
	});

	it("still retries normally when the delay is under retry.maxDelayMs", async () => {
		// Sanity check: a small retry-after MUST still go through the retry
		// loop so we don't regress the existing transient-error recovery.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=50" },
				{ content: ["recovered after short backoff"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger transient with short retry-after");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(5_000);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(waitSpy).toHaveBeenCalled();
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
	});

	it("does not auto-retry a timeout after streaming a complete write tool call", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				streamCalls += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					const toolCall: ToolCall = {
						type: "toolCall",
						id: "tc-write",
						name: "write",
						arguments: { path: "doc/report.md", content: "large report chunk" },
					};
					partial.content.push(toolCall);
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: JSON.stringify(toolCall.arguments),
						partial,
					});
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...partial,
							stopReason: "error",
							errorMessage: "The operation timed out.",
							duration: 1000,
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Write a large report");
		await session.waitForIdle();

		expect(streamCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
		expect(session.agent.state.messages.at(-1)?.role).toBe("toolResult");
		const lastError = [...session.agent.state.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		expect(lastError?.stopReason).toBe("error");
		expect(lastError?.errorMessage).toBe("The operation timed out.");
	});

	it("retries a transient socket close after partial text and thinking", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				streamCalls += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};

					if (streamCalls === 1) {
						const thinking = { type: "thinking" as const, thinking: "partial thought" };
						const text = { type: "text" as const, text: "partial text" };
						const toolCall: ToolCall = {
							type: "toolCall",
							id: "tc-incomplete",
							name: "bash",
							arguments: { command: "bun probe-archive3.ts" },
						};
						partial.content.push(thinking, text, toolCall);
						stream.push({ type: "start", partial });
						stream.push({ type: "thinking_start", contentIndex: 0, partial });
						stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking.thinking, partial });
						stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
						stream.push({ type: "text_start", contentIndex: 1, partial });
						stream.push({ type: "text_delta", contentIndex: 1, delta: text.text, partial });
						stream.push({ type: "text_end", contentIndex: 1, content: text.text, partial });
						stream.push({ type: "toolcall_start", contentIndex: 2, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex: 2,
							delta: JSON.stringify(toolCall.arguments),
							partial,
						});
						stream.push({
							type: "error",
							reason: "error",
							error: {
								...partial,
								stopReason: "error",
								errorMessage:
									"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
								duration: 1000,
							},
						});
						return;
					}

					const recovered = { type: "text" as const, text: "recovered after partial socket close" };
					partial.content.push(recovered);
					stream.push({ type: "start", partial });
					stream.push({ type: "text_start", contentIndex: 0, partial });
					stream.push({ type: "text_delta", contentIndex: 0, delta: recovered.text, partial });
					stream.push({ type: "text_end", contentIndex: 0, content: recovered.text, partial });
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...partial,
							stopReason: "stop",
							duration: 1000,
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger partial socket close");
		await session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after partial socket close" });
	});

	it("retries on Bun HTTP/2 stream reset errors", async () => {
		// Regression: Bun's fetch surfaces HTTP/2 RST_STREAM as `Error: HTTP2StreamReset
		// fetching "<url>". For more information, pass \`verbose: true\` ...`. The verbatim
		// message contains no "503", "overloaded", or "network error" hooks, so without the
		// dedicated HTTP2(StreamReset|RefusedStream|EnhanceYourCalm) carveout the assistant
		// turn fails terminally even though the underlying condition is transient.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					throw: 'HTTP2StreamReset fetching "https://chatgpt.com/backend-api/codex/responses". For more information, pass `verbose: true` in the second argument to fetch()',
				},
				{ content: ["recovered after stream reset"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger HTTP/2 stream reset");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
	});
	it("retries generic upstream_error gateway failures", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "upstream_error: Upstream request failed" },
				{ content: ["recovered after generic gateway upstream error"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger generic upstream_error");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after generic gateway upstream error" });
	});

	it("retries empty reasonless aborted turns", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ stopReason: "aborted", errorMessage: "Request was aborted" },
				{ content: ["recovered after empty reasonless abort"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		await session.prompt("Trigger empty aborted turn");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(fallbackEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after empty reasonless abort" });
	});

	it("does not retry reasonless aborted turns that have partial content", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [{ content: ["partial"], stopReason: "aborted", errorMessage: "Request was aborted" }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});

		await session.prompt("Trigger partial aborted turn");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("aborted");
		expect(last.content).toContainEqual({ type: "text", text: "partial" });
	});

	it("does not auto-retry empty reasonless aborts once the session is disposing", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		// A dispose-driven abort produces the same empty/reason-less shape as a
		// transient provider abort. It MUST settle the turn instead of entering
		// auto-retry: a retry here schedules a continuation that the disposed guard
		// skips without resolving #retryPromise, hanging prompt() during shutdown.
		const mock = createMockModel({
			responses: [
				{ stopReason: "aborted", errorMessage: "Request was aborted" },
				{ content: ["should not be reached after dispose"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});

		// Enter the disposing window before the empty abort lands. Without the
		// #isDisposed guard this prompt would hang on an orphaned retry promise.
		session.beginDispose();
		await session.prompt("Trigger empty aborted turn while disposing");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		// No retry continuation fired, so the second scripted response is untouched.
		expect(mock.calls).toHaveLength(1);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("aborted");
	});

	it("defaults 502 auto-retry to ten capped backoff attempts", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel();
		let attempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				attempts += 1;
				mock.push(
					attempts <= 10
						? { throw: "502 Bad Gateway upstream_error" }
						: { content: ["recovered after default 502 retry budget"] },
				);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger repeated 502s");
		await session.waitForIdle();

		expect(attempts).toBe(11);
		expect(retryStartEvents).toHaveLength(10);
		expect(retryStartEvents.map(event => event.maxAttempts)).toEqual(new Array(10).fill(10));
		expect(retryStartEvents.map(event => event.delayMs)).toEqual([
			500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000,
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 10 });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after default 502 retry budget" });
	});
});
