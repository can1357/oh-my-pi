import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession live-attach delivery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-live-attach-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("rejects without queueing while a session identity transition holds the lock", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model: unknown, _context: Context) => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Done." }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: zeroUsage,
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		// Hold the identity chain open the way switchSession()/newSession() do.
		// The delivery must reject immediately instead of waiting out the
		// transition: waiting past the broker's delivery timeout would queue the
		// message after the broker already reported failure, executing an editor
		// retry twice.
		const guard = await session.enterSessionIdentityOperation();
		try {
			await expect(
				session.queueNonInterruptingUserMessage("hello", sessionManager.getSessionId(), sessionManager.getCwd()),
			).rejects.toThrow("Session changed before message delivery");
		} finally {
			guard[Symbol.dispose]();
		}
		expect(streamCalls).toBe(0);
	});

	it("accepts concurrent deliveries without reporting a session change", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model: unknown, _context: Context) => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Done." }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: zeroUsage,
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		// Overlapping editor sends share the identity chain without tripping the
		// transition guard: both must serialize and succeed instead of the
		// second rejecting with "Session changed" when no transition occurred.
		const sessionId = sessionManager.getSessionId();
		const cwd = sessionManager.getCwd();
		await Promise.all([
			session.queueNonInterruptingUserMessage("one", sessionId, cwd),
			session.queueNonInterruptingUserMessage("two", sessionId, cwd),
		]);
	});
});
