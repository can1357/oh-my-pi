import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { DEFAULT_SHAKE_CONFIG } from "@oh-my-pi/pi-agent-core/compaction";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import type { Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const NATIVE_REPLAY_BULK = "NATIVE_REPLAY_BULK_SENTINEL ".repeat(1000);
const BODY_READ_TIMEOUT = "Timed out reading request body. Try again, or use a smaller request size.";

function completeResponse(): Response {
	return new Response(
		[
			'data: {"type":"response.created","response":{"id":"resp_recovered","status":"in_progress"}}',
			'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_recovered","role":"assistant","status":"in_progress","content":[]}}',
			'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_recovered","delta":"Recovered"}',
			'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_recovered","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Recovered"}]}}',
			'data: {"type":"response.completed","response":{"id":"resp_recovered","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
		].join("\n\n") + "\n\n",
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function model(baseUrl: string): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "Local Responses Test",
		id: "local-responses-test",
		provider: "openai",
		baseUrl,
		contextWindow: 200_000,
		maxTokens: 8192,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} satisfies ModelSpec<"openai-responses">);
}

type ResponseFactory = (body: string, requestNumber: number) => Response | Promise<Response>;

type SessionHarnessOptions = {
	compactionEnabled?: boolean;
	methodOrder?: string[];
	retryEnabled?: boolean;

	maxRetries?: number;
	messages?: AgentMessage[];
	respond?: ResponseFactory;
};

type SessionHarness = {
	requests: string[];
	server: Bun.Server<undefined>;
	tempDir: TempDir;
	authStorage: AuthStorage;
	sessionManager: SessionManager;
	session: AgentSession;
	cleanup: () => Promise<void>;
};

function timeoutResponse(): Response {
	return Response.json({ error: { code: "user_request_timeout", message: BODY_READ_TIMEOUT } }, { status: 408 });
}

function ordinaryTransientErrorResponse(): Response {
	return Response.json({ error: { message: "Provider returned error" } }, { status: 400 });
}

function defaultMessages(): AgentMessage[] {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return [
		{
			role: "user",
			content: `<context>\n${"historical fenced context ".repeat(200)}\n</context>`,
			timestamp: Date.now() - 4,
		},
		{ role: "user", content: "before tool history", timestamp: Date.now() - 3 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_historical", name: "read", arguments: { path: "large.log" } }],
			api: "openai-responses",
			provider: "openai",
			model: "local-responses-test",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now() - 2,
		},
		{
			role: "toolResult",
			toolCallId: "call_historical",
			toolName: "read",
			content: [{ type: "text", text: "historical tool result ".repeat(5000) }],
			isError: false,
			timestamp: Date.now() - 1,
		},
		{ role: "user", content: "recent protected tail ".repeat(20_000), timestamp: Date.now() - 1 },
	];
}

async function createSessionHarness(options: SessionHarnessOptions = {}): Promise<SessionHarness> {
	const requests: string[] = [];
	const respond =
		options.respond ?? ((_body, requestNumber) => (requestNumber === 1 ? timeoutResponse() : completeResponse()));
	const server = Bun.serve({
		port: 0,
		fetch: async request => {
			const body = await request.text();
			requests.push(body);
			return await respond(body, requests.length);
		},
	});
	const tempDir = TempDir.createSync("@pi-responses-body-read-");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("openai", "local-test-key");
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const activeModel = model(server.url.toString().replace(/\/$/, ""));
	const messages = options.messages ?? defaultMessages();
	for (const message of messages) sessionManager.appendMessage(message as never);
	await sessionManager.ensureOnDisk();
	const agent = new Agent({
		getApiKey: () => "local-test-key",
		initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages },
		streamFn: streamSimple,
	});
	const settings = Settings.isolated({
		"compaction.enabled": options.compactionEnabled ?? true,
		"compaction.methodOrder": options.methodOrder ?? ["shake"],
		"retry.enabled": options.retryEnabled ?? true,
		"retry.maxRetries": options.maxRetries ?? 10,
		"retry.baseDelayMs": 1,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings }),
	});
	return {
		requests,
		server,
		tempDir,
		authStorage,
		sessionManager,
		session,
		cleanup: async () => {
			await session.dispose();
			authStorage.close();
			server.stop(true);
			tempDir.removeSync();
		},
	};
}

async function runPrompt(harness: SessionHarness): Promise<void> {
	await harness.session.prompt("continue");
	await harness.session.waitForIdle();
}

function persistedAssistantErrors(harness: SessionHarness): AgentMessage[] {
	return harness.sessionManager
		.getBranch()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"
				? [entry.message as AgentMessage]
				: [],
		);
}

function activeAssistantErrors(harness: SessionHarness): AgentMessage[] {
	return harness.session.agent.state.messages.filter(
		message => message.role === "assistant" && message.stopReason === "error",
	);
}

function messageContainsText(message: AgentMessage, needle: string): boolean {
	if (!("content" in message)) return false;
	if (typeof message.content === "string") return message.content.includes(needle);
	return message.content.some(
		block => "text" in block && typeof block.text === "string" && block.text.includes(needle),
	);
}

function assertTerminalErrorState(harness: SessionHarness): void {
	expect(persistedAssistantErrors(harness).length).toBeGreaterThan(0);
	expect(activeAssistantErrors(harness)).toHaveLength(0);
}

describe("AgentSession Responses request-body timeout recovery", () => {
	it("retries once with a mechanically smaller artifact-backed Responses request", async () => {
		const harness = await createSessionHarness({ maxRetries: 1 });
		try {
			await runPrompt(harness);
			expect(harness.requests).toHaveLength(2);
			expect(Buffer.byteLength(harness.requests[1]!)).toBeLessThan(Buffer.byteLength(harness.requests[0]!));
			expect(harness.requests[1]).toContain("artifact://");
			expect(harness.requests[1]).not.toContain("data:image/png");
			const artifactId = /artifact:\/\/([^\s)]+)/.exec(harness.requests[1]!)?.[1];
			expect(artifactId).toBeDefined();
			const artifactPath = await harness.sessionManager.getArtifactPath(artifactId!);
			expect(artifactPath).not.toBeNull();
			expect(await Bun.file(artifactPath!).text()).toContain("historical tool result");
			expect(harness.requests[1]).toContain("historical fenced context");
			expect(harness.requests[1]).not.toContain("historical tool result");
			expect(harness.session.agent.state.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Recovered" }],
			});
		} finally {
			await harness.cleanup();
		}
	}, 30_000);

	it("preserves native Responses replay payloads while eliding tool-result text", async () => {
		const messages = defaultMessages();
		messages.splice(2, 0, {
			role: "assistant",
			content: [{ type: "text", text: "native assistant visible" }],
			api: "openai-responses",
			provider: "openai",
			model: "local-responses-test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			providerPayload: createOpenAIResponsesHistoryPayload("openai", [
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: NATIVE_REPLAY_BULK }] },
			]),
			timestamp: Date.now() - 3,
		});
		const harness = await createSessionHarness({
			messages,
			respond: async (_body, requestNumber) => (requestNumber === 2 ? timeoutResponse() : completeResponse()),
		});
		try {
			const activeModel = harness.session.agent.state.model as Model<"openai-responses">;
			await streamOpenAIResponses(
				activeModel,
				{ messages: messages as Context["messages"] },
				{
					apiKey: "local-test-key",
					providerSessionState: harness.session.providerSessionState,
					sessionId: harness.session.sessionId,
				},
			).result();
			await runPrompt(harness);
			expect(harness.requests).toHaveLength(3);
			expect(harness.requests[1]).toContain(NATIVE_REPLAY_BULK);
			expect(harness.requests[2]).toContain(NATIVE_REPLAY_BULK);
			expect(harness.requests[2]).not.toContain("historical tool result");
			const artifactId = /artifact:\/\/([^\s)]+)/.exec(harness.requests[2] ?? "")?.[1];
			expect(artifactId).toBeDefined();
			const artifactPath = await harness.sessionManager.getArtifactPath(artifactId!);
			expect(artifactPath).not.toBeNull();
			expect(await Bun.file(artifactPath!).text()).toContain("historical tool result");
		} finally {
			await harness.cleanup();
		}
	}, 30_000);

	for (const [maxRetries, expectedRequests, changedRetry] of [
		[1, 2, false],
		[2, 3, true],
	] as const) {
		it(`honors an ordinary retry already spent before the special path (maxRetries=${maxRetries})`, async () => {
			const harness = await createSessionHarness({
				maxRetries,
				respond: async (_body, requestNumber) =>
					requestNumber === 1
						? ordinaryTransientErrorResponse()
						: requestNumber === 2
							? timeoutResponse()
							: completeResponse(),
			});
			try {
				await runPrompt(harness);
				expect(harness.requests).toHaveLength(expectedRequests);
				if (changedRetry) {
					expect(harness.requests[2]).toContain("artifact://");
					expect(harness.session.agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
				} else {
					expect(harness.requests[1]).not.toContain("artifact://");
					assertTerminalErrorState(harness);
				}
			} finally {
				await harness.cleanup();
			}
		});
	}
	// Partial visible/tool output safety is covered by the dedicated full-replay
	// timeout cases in turn-recovery-replay-unsafe.test.ts; an HTTP request-body 408
	// arrives before a response stream exists, so one provider attempt cannot carry both.
	it("terminates without shake when compaction is disabled", async () => {
		const harness = await createSessionHarness({ compactionEnabled: false });
		try {
			await runPrompt(harness);
			expect(harness.requests).toHaveLength(1);
			assertTerminalErrorState(harness);
		} finally {
			await harness.cleanup();
		}
	});

	it("terminates without shake when the configured method order excludes shake", async () => {
		const harness = await createSessionHarness({ methodOrder: ["soft"] });
		try {
			await runPrompt(harness);
			expect(harness.requests).toHaveLength(1);
			assertTerminalErrorState(harness);
		} finally {
			await harness.cleanup();
		}
	});

	for (const [label, options] of [
		["retry disabled", { retryEnabled: false }],
		["retry budget zero", { maxRetries: 0 }],
	] satisfies Array<[string, SessionHarnessOptions]>) {
		it(`terminates without mutation when ${label}`, async () => {
			const harness = await createSessionHarness(options);
			try {
				await runPrompt(harness);
				expect(harness.requests).toHaveLength(1);
				assertTerminalErrorState(harness);
			} finally {
				await harness.cleanup();
			}
		});
	}

	it("terminates without mutation when shake has no eligible regions", async () => {
		const harness = await createSessionHarness({
			messages: [{ role: "user", content: "small history", timestamp: Date.now() - 1 }],
		});
		try {
			await runPrompt(harness);
			expect(harness.requests).toHaveLength(1);
			assertTerminalErrorState(harness);
		} finally {
			await harness.cleanup();
		}
	});

	it("does not retry when the actual artifact placeholder misses minimum savings", async () => {
		const harness = await createSessionHarness({ messages: [] });
		const artifactsDir = harness.sessionManager.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected session artifacts directory");
		const artifactId = "artifact-segment-".repeat(20);
		const allocateArtifactPath = vi
			.spyOn(harness.sessionManager, "allocateArtifactPath")
			.mockResolvedValue({ id: artifactId, path: path.join(artifactsDir, "reserved-shake.log") });
		try {
			const legacyPlaceholderEstimate = 16;
			let toolResultText = "";
			let withinBoundary = false;
			for (let index = 0; index < DEFAULT_SHAKE_CONFIG.minSavings + 128; index++) {
				toolResultText += ` item-${index}`;
				const tokens = harness.session.agent.tokenizer.countTokens([toolResultText]);
				const placeholder = `[shaken ~${tokens} tokens — recover: artifact://${artifactId} (region 1)]`;
				const actualSavings = tokens - harness.session.agent.tokenizer.countTokens(placeholder);
				if (
					tokens - legacyPlaceholderEstimate >= DEFAULT_SHAKE_CONFIG.minSavings &&
					actualSavings < DEFAULT_SHAKE_CONFIG.minSavings
				) {
					withinBoundary = true;
					break;
				}
			}
			expect(withinBoundary).toBe(true);
			const timestamp = Date.now();
			harness.sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_near_threshold",
						name: "bash",
						arguments: { command: "printf near-threshold" },
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "local-responses-test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp,
			});
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "call_near_threshold",
				toolName: "bash",
				content: [{ type: "text", text: toolResultText }],
				isError: false,
				timestamp,
			});
			harness.sessionManager.appendMessage({
				role: "user",
				content: "near threshold tail ".repeat(8_000),
				timestamp,
			});
			harness.session.agent.replaceMessages(harness.sessionManager.buildSessionContext().messages);
			await runPrompt(harness);
			expect(harness.requests).toHaveLength(1);
			expect(await fs.readdir(artifactsDir).catch(() => [])).toEqual([]);
			assertTerminalErrorState(harness);
		} finally {
			allocateArtifactPath.mockRestore();
			await harness.cleanup();
		}
	});

	it("owns a repeated exact 408 after the one changed retry", async () => {
		const harness = await createSessionHarness({
			respond: async (_body, requestNumber) => (requestNumber <= 2 ? timeoutResponse() : completeResponse()),
		});
		try {
			await runPrompt(harness);
			expect(harness.requests).toHaveLength(2);
			assertTerminalErrorState(harness);
			expect(harness.requests[1]).toContain("artifact://");
		} finally {
			await harness.cleanup();
		}
	});

	it("allows a later independent prompt to recover its own full-replay timeout", async () => {
		const messages = defaultMessages();
		const firstTail = messages.at(-1);
		if (firstTail?.role !== "user") throw new Error("Expected seeded user tail");
		firstTail.content = "first protected tail ".repeat(8_000);
		const harness = await createSessionHarness({
			messages,
			respond: async (_body, requestNumber) =>
				requestNumber === 1 || requestNumber === 3 ? timeoutResponse() : completeResponse(),
		});
		try {
			await runPrompt(harness);
			const priorAssistant = harness.session.agent.state.messages.find(
				(message): message is Extract<AgentMessage, { role: "assistant" }> =>
					message.role === "assistant" && message.stopReason === "stop",
			);
			expect(priorAssistant).toBeDefined();
			const callId = "call_independent_prompt";
			harness.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "printf fresh" } }],
				api: priorAssistant!.api,
				provider: priorAssistant!.provider,
				model: priorAssistant!.model,
				usage: priorAssistant!.usage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			});
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: [{ type: "text", text: "independent historical tool result ".repeat(5000) }],
				isError: false,
				timestamp: Date.now(),
			});
			harness.sessionManager.appendMessage({
				role: "user",
				content: "next protected tail ".repeat(8_000),
				timestamp: Date.now(),
			});
			harness.session.agent.replaceMessages(harness.sessionManager.buildSessionContext().messages);
			await harness.session.prompt("next independent prompt");
			await harness.session.waitForIdle();
			expect(harness.requests).toHaveLength(4);
			expect(harness.requests[1]).toContain("artifact://");
			expect(harness.requests[2]).toContain("independent historical tool result");
			expect(harness.requests[3]).not.toContain("independent historical tool result");
			expect(harness.requests[3]).toContain("artifact://");
			expect(harness.session.agent.state.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Recovered" }],
			});
		} finally {
			await harness.cleanup();
		}
	});
	it("does not rewrite when the recovery artifact cannot be saved", async () => {
		const harness = await createSessionHarness();
		const allocateArtifactPath = vi
			.spyOn(harness.sessionManager, "allocateArtifactPath")
			.mockResolvedValue({ id: "reserved", path: harness.tempDir.path() });
		try {
			await runPrompt(harness);
			expect(harness.requests).toHaveLength(1);
			expect(
				harness.sessionManager
					.getBranch()
					.some(
						entry =>
							entry.type === "message" &&
							messageContainsText(entry.message as AgentMessage, "historical tool result"),
					),
			).toBe(true);
			assertTerminalErrorState(harness);
		} finally {
			allocateArtifactPath.mockRestore();
			await harness.cleanup();
		}
	});

	it("rolls back the in-memory rewrite when durable history write fails", async () => {
		const harness = await createSessionHarness();
		const rewriteEntries = vi
			.spyOn(harness.sessionManager, "rewriteEntries")
			.mockRejectedValueOnce(new Error("injected rewrite failure"));
		try {
			await runPrompt(harness);
			expect(harness.requests).toHaveLength(1);
			expect(
				harness.sessionManager
					.getBranch()
					.some(
						entry =>
							entry.type === "message" &&
							messageContainsText(entry.message as AgentMessage, "historical tool result"),
					),
			).toBe(true);
			assertTerminalErrorState(harness);
		} finally {
			rewriteEntries.mockRestore();
			await harness.cleanup();
		}
	});

	it("cancels while artifact reservation is pending without rewriting or retrying", async () => {
		const artifactStarted = Promise.withResolvers<void>();
		const releaseArtifact = Promise.withResolvers<{ id?: string; path?: string }>();
		const harness = await createSessionHarness();
		const allocateArtifactPath = vi
			.spyOn(harness.sessionManager, "allocateArtifactPath")
			.mockImplementation(async () => {
				artifactStarted.resolve();
				return await releaseArtifact.promise;
			});
		try {
			const prompt = harness.session.prompt("continue");
			await artifactStarted.promise;
			const abort = harness.session.abort({ reason: "negative-test-cancel" });
			releaseArtifact.resolve({});
			await abort;
			await prompt;
			await harness.session.waitForIdle();
			expect(harness.requests).toHaveLength(1);
			assertTerminalErrorState(harness);
		} finally {
			allocateArtifactPath.mockRestore();
			await harness.cleanup();
		}
	});

	it("keeps the committed rewrite authoritative after abort during the durable write", async () => {
		const rewriteStarted = Promise.withResolvers<void>();
		const releaseRewrite = Promise.withResolvers<void>();
		const harness = await createSessionHarness();
		const originalRewrite = harness.sessionManager.rewriteEntries.bind(harness.sessionManager);
		let blocked = true;
		const rewriteEntries = vi.spyOn(harness.sessionManager, "rewriteEntries").mockImplementation(async () => {
			if (blocked) {
				blocked = false;
				rewriteStarted.resolve();
				await releaseRewrite.promise;
			}
			await originalRewrite();
		});
		try {
			const firstPrompt = harness.session.prompt("continue");
			await rewriteStarted.promise;
			const abort = harness.session.abort({ reason: "negative-test-abort-during-rewrite" });
			releaseRewrite.resolve();
			await abort;
			await firstPrompt;
			await harness.session.waitForIdle();

			const activeAfterAbort = harness.session.agent.state.messages;
			expect(activeAfterAbort.some(message => messageContainsText(message, "artifact://"))).toBe(true);
			expect(activeAfterAbort.some(message => messageContainsText(message, "historical tool result"))).toBe(false);
			expect(activeAfterAbort.some(message => messageContainsText(message, "historical fenced context"))).toBe(true);
			const sessionFile = harness.sessionManager.getSessionFile();
			expect(sessionFile).toBeDefined();
			const reloaded = await SessionManager.open(sessionFile!, harness.tempDir.path());
			try {
				expect(
					reloaded
						.getBranch()
						.some(
							entry =>
								entry.type === "message" && messageContainsText(entry.message as AgentMessage, "artifact://"),
						),
				).toBe(true);
			} finally {
				await reloaded.close();
			}

			await harness.session.prompt("next");
			await harness.session.waitForIdle();
			expect(harness.requests).toHaveLength(2);
			expect(harness.requests[1]).toContain("artifact://");
			expect(harness.requests[1]).toContain("historical fenced context");
			expect(harness.requests[1]).not.toContain("historical tool result");
			expect(harness.session.agent.state.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Recovered" }],
			});
		} finally {
			rewriteEntries.mockRestore();
			await harness.cleanup();
		}
	});
});
