/** Structural session changes cannot strand a Vibe scope borrowed by plan mode. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession structural transitions while Vibe is suspended for plan mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-vibe-suspended-transition-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const mock = createMockModel({ handler: () => ({ content: ["unused"] }) });
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	async function persistParent(): Promise<{ sessionId: string; sessionFile: string; entryId: string }> {
		session.sessionManager.appendMessage({
			role: "user",
			content: "Keep this parent session.",
			timestamp: Date.now(),
		});
		await session.sessionManager.ensureOnDisk();
		await session.sessionManager.flush();
		const sessionFile = session.sessionFile;
		const entryId = session.sessionManager.getLeafId();
		if (!sessionFile || !entryId) throw new Error("Expected a persisted parent with a seeded user message");
		return { sessionId: session.sessionManager.getSessionId(), sessionFile, entryId };
	}

	function createBtwAssistant(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
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
	}

	it("refuses a new session and keeps the parked worker's parent identity", async () => {
		const { sessionId, sessionFile } = await persistParent();
		session.setVibeModeState({ enabled: false, suspendedForPlan: true });

		await expect(session.newSession()).rejects.toThrow(/suspended for plan mode/);
		expect(session.sessionManager.getSessionId()).toBe(sessionId);
		expect(session.sessionFile).toBe(sessionFile);
	});

	it("refuses a dropping new session and leaves the parked session file on disk", async () => {
		const { sessionId, sessionFile } = await persistParent();
		session.setVibeModeState({ enabled: false, suspendedForPlan: true });

		await expect(session.newSession({ drop: true })).rejects.toThrow(/suspended for plan mode/);
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(session.sessionManager.getSessionId()).toBe(sessionId);
		expect(session.sessionFile).toBe(sessionFile);
	});

	it("refuses a fork and keeps the parked worker's parent identity", async () => {
		const { sessionId, sessionFile } = await persistParent();
		session.setVibeModeState({ enabled: false, suspendedForPlan: true });

		await expect(session.fork()).rejects.toThrow(/suspended for plan mode/);
		expect(session.sessionManager.getSessionId()).toBe(sessionId);
		expect(session.sessionFile).toBe(sessionFile);
	});

	it("refuses a branch and keeps the parked worker's parent identity", async () => {
		const { sessionId, sessionFile, entryId } = await persistParent();
		session.setVibeModeState({ enabled: false, suspendedForPlan: true });

		await expect(session.branch(entryId)).rejects.toThrow(/suspended for plan mode/);
		expect(session.sessionManager.getSessionId()).toBe(sessionId);
		expect(session.sessionFile).toBe(sessionFile);
	});

	it("refuses a /btw branch while the workers stay parked", async () => {
		const { sessionId, sessionFile, entryId } = await persistParent();
		session.setVibeModeState({ enabled: false, suspendedForPlan: true });

		await expect(session.branchFromBtw("why?", createBtwAssistant(), entryId, sessionId)).rejects.toThrow(
			/suspended for plan mode/,
		);
		expect(session.sessionFile).toBe(sessionFile);
	});

	it("refuses a move and keeps the session where its workers are parked", async () => {
		const { sessionFile } = await persistParent();
		const cwd = session.sessionManager.getCwd();
		session.setVibeModeState({ enabled: false, suspendedForPlan: true });

		await expect(session.moveSession(tempDir.join("moved"))).rejects.toThrow(/suspended for plan mode/);
		expect(session.sessionManager.getCwd()).toBe(cwd);
		expect(session.sessionFile).toBe(sessionFile);
	});

	it("still allows switching to a saved session while the workers stay parked", async () => {
		const { sessionId } = await persistParent();
		const target = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		target.appendModeChange("none");
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected a persisted target session");
		await target.close();
		session.setVibeModeState({ enabled: false, suspendedForPlan: true });

		expect(await session.switchSession(targetFile)).toBe(true);

		expect(session.sessionFile).toBe(targetFile);
		expect(session.sessionManager.getSessionId()).not.toBe(sessionId);
	});

	it("refuses handoff before rewriting a suspended parent's history", async () => {
		const { sessionFile } = await persistParent();
		session.setVibeModeState({ enabled: false, suspendedForPlan: true });

		await expect(session.handoff()).rejects.toThrow(/suspended for plan mode/);
		expect(session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
		expect(session.sessionFile).toBe(sessionFile);
	});

	it("permits a new session once plan mode releases the parked mode", async () => {
		const { sessionId, sessionFile } = await persistParent();
		session.setVibeModeState({ enabled: false, suspendedForPlan: true });
		await expect(session.newSession()).rejects.toThrow(/suspended for plan mode/);

		session.setVibeModeState(undefined);

		expect(await session.newSession()).toBe(true);
		expect(session.sessionManager.getSessionId()).not.toBe(sessionId);
		expect(session.sessionFile).not.toBe(sessionFile);
	});

	it("permits a fork once plan mode releases the parked mode", async () => {
		const { sessionId } = await persistParent();
		session.setVibeModeState({ enabled: false, suspendedForPlan: true });
		await expect(session.fork()).rejects.toThrow(/suspended for plan mode/);

		session.setVibeModeState(undefined);

		expect(await session.fork()).toBe(true);
		expect(session.sessionManager.getSessionId()).not.toBe(sessionId);
	});

	it("also blocks handoff while Vibe is active", async () => {
		const { sessionFile } = await persistParent();
		session.setVibeModeState({ enabled: true });
		await expect(session.handoff()).rejects.toThrow(/vibe mode/);
		expect(session.sessionFile).toBe(sessionFile);
	});
});
