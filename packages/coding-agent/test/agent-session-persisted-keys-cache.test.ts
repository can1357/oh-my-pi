import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";
import { logger, removeSyncWithRetries, Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession persistence-keys cache", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let authDir: TempDir;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authDir = TempDir.createSync("@pi-cache-auth-");
		authStorage = await AuthStorage.create(authDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "fake-key");
		modelRegistry = new ModelRegistry(authStorage, authDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		authDir.removeSync();
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-cache-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		const tools: AgentTool[] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("bundled model claude-sonnet-4-5 not found");
		}
		const agent = new Agent({
			getApiKey: () => "fake-key",
			initialState: { model, systemPrompt: [], tools },
		});

		sessionManager = SessionManager.create(tempDir, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});

		session.subscribe(() => {});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("does not duplicate a message on re-persist attempts", async () => {
		const msg: AgentMessage = { role: "user", content: [{ type: "text", text: "Hello cache" }], timestamp: 1000 };

		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		const count1 = sessionManager.getBranch().filter(e => e.type === "message").length;
		expect(count1).toBe(1);

		// Re-emit should be ignored due to cache
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		const count2 = sessionManager.getBranch().filter(e => e.type === "message").length;
		expect(count2).toBe(1);
	});

	it("caches missing-key checks across a growing branch", async () => {
		const getBranch = spyOn(sessionManager, "getBranchView");

		try {
			for (let i = 0; i < 25; i++) {
				const msg: AgentMessage = {
					role: "user",
					content: [{ type: "text", text: `Cache perf ${i}` }],
					timestamp: 2000 + i,
				};
				session.agent.emitExternalEvent({ type: "message_end", message: msg });
				await sessionManager.flush();
				for (let spin = 0; spin < 5; spin++) {
					await Promise.resolve();
				}
			}

			expect(getBranch).toHaveBeenCalledTimes(1);
		} finally {
			getBranch.mockRestore();
		}

		const entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(25);
	});

	it("reflects the NEW branch after a rewind (stale cache would wrongly skip)", async () => {
		// 1. Send first message (assistant)
		const msg1: AssistantMessage = createAssistantMessage("Msg 1");
		session.agent.emitExternalEvent({ type: "message_end", message: msg1 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// 2. Send second message (user)
		const msg2: AgentMessage = { role: "user", content: [{ type: "text", text: "Msg 2" }], timestamp: 1002 };
		session.agent.emitExternalEvent({ type: "message_end", message: msg2 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		let entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(2);

		// 3. Rewind to msg1 (by navigating to the assistant message msg1)
		// This sets the leaf exactly to msg1.
		const msg1EntryId = entries[0].id;
		const navResult = await session.navigateTree(msg1EntryId, { summarize: false });
		expect(navResult.cancelled).toBe(false);

		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// Confirm rewind occurred (only msg1 remains)
		entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(1);
		expect(entries[0].message.role).toBe("assistant");

		// 4. Send msg2 AGAIN
		// If cache wasn't invalidated on rewind, it remembers msg2 and wrongly skips it.
		session.agent.emitExternalEvent({ type: "message_end", message: msg2 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// Cache must be invalidated, so the re-persist succeeds.
		entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(2);
		expect(entries[1].message.role).toBe("user");
	});

	it("flushes multiple same-tick message_end turn events under a single OS publish-lock pass", async () => {
		// Materialize the session file first so subsequent turn flushes take the hot writer path.
		const seed: AssistantMessage = createAssistantMessage("Seed reply");
		session.agent.emitExternalEvent({ type: "message_end", message: seed });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		const lockSpy = spyOn(NativeFileLock, "tryAcquire");
		try {
			const turnMessages: AgentMessage[] = [
				{ ...createAssistantMessage("Tool turn"), timestamp: 3001 },
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "r1" }],
					isError: false,
					timestamp: 3002,
				},
				{
					role: "toolResult",
					toolCallId: "call-2",
					toolName: "bash",
					content: [{ type: "text", text: "r2" }],
					isError: false,
					timestamp: 3003,
				},
				{
					role: "toolResult",
					toolCallId: "call-3",
					toolName: "bash",
					content: [{ type: "text", text: "r3" }],
					isError: false,
					timestamp: 3004,
				},
			];
			for (const message of turnMessages) {
				session.agent.emitExternalEvent({ type: "message_end", message });
			}
			await sessionManager.flush();
			for (let i = 0; i < 5; i++) await Promise.resolve();

			const gateAcquires = lockSpy.mock.calls.filter(call => String(call[0]).endsWith(".lock.os")).length;
			expect(gateAcquires).toBe(1);
		} finally {
			lockSpy.mockRestore();
		}

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const reopened = await SessionManager.open(sessionFile, tempDir);
		const branchMessages = reopened.getBranch().filter(e => e.type === "message");
		expect(branchMessages.map(e => e.message.role)).toEqual([
			"assistant",
			"assistant",
			"toolResult",
			"toolResult",
			"toolResult",
		]);
		await reopened.close();
	});

	it("clears pending message_end persistence and rejects waiters when withAppendBatch throws", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled model claude-sonnet-4-5 not found");

		const raceWithTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
			const timeout = Promise.withResolvers<never>();
			const timer = setTimeout(() => timeout.reject(new Error(`Timed out waiting for ${label}`)), 1500);
			try {
				return await Promise.race([promise, timeout.promise]);
			} finally {
				clearTimeout(timer);
			}
		};

		const errorAgent = new Agent({
			getApiKey: () => "fake-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				throw new Error("stream setup failed");
			},
		});

		const errorSessionManager = SessionManager.create(tempDir, tempDir);
		const errorSession = new AgentSession({
			agent: errorAgent,
			sessionManager: errorSessionManager,
			settings: Settings.isolated({
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
		});

		let inFlightSettle: Promise<void> | undefined;
		errorSession.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				// Captured synchronously while the assistant's deferred is still registered in
				// #pendingMessageEndPersistence before the microtask batch drain runs.
				inFlightSettle = errorSession.settleInFlightMessagePersistence();
			}
		});

		const originalWithAppendBatch = errorSessionManager.withAppendBatch.bind(errorSessionManager);
		let threwOnAssistantError = false;
		const warnSpy = spyOn(logger, "warn");
		const batchSpy = spyOn(errorSessionManager, "withAppendBatch").mockImplementation(<T>(fn: () => T): T => {
			if (!threwOnAssistantError && errorAgent.state.messages.some(m => m.role === "assistant")) {
				threwOnAssistantError = true;
				fn();
				throw new Error("batch drain failed");
			}
			return originalWithAppendBatch(fn);
		});

		try {
			// Terminal empty error turn triggers #persistTerminalEmptyErrorTurn -> #waitForSessionMessagePersistence.
			// Regression failure mode: unsettled deferred + retained #pendingMessageEndPersistence entry hung
			// prompt(), settleInFlightMessagePersistence(), and dispose() indefinitely.
			await raceWithTimeout(errorSession.prompt("trigger error turn"), "errorSession.prompt");
			expect(threwOnAssistantError).toBe(true);
			expect(inFlightSettle).toBeDefined();
			await raceWithTimeout(inFlightSettle!, "in-flight settleInFlightMessagePersistence");
			await raceWithTimeout(
				errorSession.settleInFlightMessagePersistence(),
				"post-failure settleInFlightMessagePersistence",
			);

			const rejectedListenerCalls = warnSpy.mock.calls.filter(
				callArgs =>
					callArgs[0] === "Agent listener rejected" &&
					typeof callArgs[1] === "object" &&
					callArgs[1] !== null &&
					"error" in callArgs[1] &&
					callArgs[1].error === "batch drain failed",
			);
			expect(rejectedListenerCalls.length).toBe(1);
		} finally {
			batchSpy.mockRestore();
			warnSpy.mockRestore();
		}

		const recoveryMsg: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "post-failure message" }],
			timestamp: 4099,
		};
		errorSession.agent.emitExternalEvent({ type: "message_end", message: recoveryMsg });
		await raceWithTimeout(errorSession.settleInFlightMessagePersistence(), "recovery settle");
		await errorSessionManager.flush();
		expect(errorSessionManager.getBranch().some(e => e.type === "message" && e.message.timestamp === 4099)).toBe(
			true,
		);
		await raceWithTimeout(errorSession.dispose(), "errorSession.dispose");
	});
});
