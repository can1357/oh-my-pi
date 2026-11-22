/**
 * Contracts: /delete asks before unlinking the session (issue-driven regression).
 *
 * 1. Submitting /delete on a session that exists on disk shows the standard
 *    confirm dialog BEFORE any session-switch teardown, and a decline leaves
 *    the session file on disk and live state (prepareSessionSwitch never runs).
 * 2. Confirming performs the real delete: the old session file is unlinked,
 *    exactly that one session is destroyed, and the terminal moves to a fresh
 *    successor.
 * 3. Nothing on disk — in-memory or a lazy session never saved — is never
 *    prompted: the handler falls through to today's ungated paths.
 * 4. If the session swaps while the dialog is open, Yes does not delete the
 *    session the prompt never named.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

describe("/delete session confirmation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;
	let idleStream: StreamFn;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-delete-confirm-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		// A never-consuming idle stream: /delete's teardown may abort an active
		// turn; no provider call is part of these contracts.
		idleStream = () => new AssistantMessageEventStream();
		const registryTools = [stubTool("read")];
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: (...args) => idleStream(...args),
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(registryTools.map(tool => [tool.name, tool])),
			builtInToolNames: registryTools.map(tool => tool.name),
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, new EventBus());
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("declining the confirm leaves the session file and live state untouched", async () => {
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");

		const confirm = vi.spyOn(mode, "showHookConfirm").mockResolvedValue(false);
		const teardown = vi.spyOn(mode, "prepareSessionSwitch");

		await mode.handleDeleteCommand();

		expect(confirm).toHaveBeenCalledTimes(1);
		// The ordering contract: refusal happens BEFORE teardown, so a live
		// /btw or pending plan review survives the decline.
		expect(teardown).not.toHaveBeenCalled();
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(session.sessionFile).toBe(sessionFile);
	});

	it("confirming unlinks the old session file and moves to a fresh successor", async () => {
		session.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const previousSessionId = session.sessionId;
		const survivor = SessionManager.create(tempDir.path(), tempDir.path());
		survivor.appendMessage({ role: "user", content: "survivor", timestamp: Date.now() });
		await survivor.ensureOnDisk();
		const survivorFile = survivor.getSessionFile();
		if (!survivorFile) throw new Error("Expected survivor session file");

		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);

		await mode.handleDeleteCommand();

		expect(await Bun.file(sessionFile).exists()).toBe(false);
		expect(session.sessionId).not.toBe(previousSessionId);
		expect(session.sessionFile).not.toBe(sessionFile);
		// exactly one destroyed: the other session on disk is untouched
		expect(await Bun.file(survivorFile).exists()).toBe(true);
		await survivor.close();
	});

	it("never prompts for an in-memory session with no file to delete", async () => {
		vi.spyOn(session.sessionManager, "getSessionFile").mockReturnValue(undefined);
		const confirm = vi.spyOn(mode, "showHookConfirm");
		const showError = vi.spyOn(mode, "showError").mockImplementation(() => {});

		await mode.handleDeleteCommand();

		expect(confirm).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledTimes(1);
	});

	it("never prompts for a lazy session that never reached disk", async () => {
		// Fresh launch: getSessionFile() is a path, but no file exists yet.
		// /delete must not warn about "cannot be undone" for nothing on disk.
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected lazy session file path");
		expect(await Bun.file(sessionFile).exists()).toBe(false);

		const confirm = vi.spyOn(mode, "showHookConfirm");

		await mode.handleDeleteCommand();

		expect(confirm).not.toHaveBeenCalled();
	});

	it("cancels the delete when the session changed while the dialog was open", async () => {
		session.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");

		const showStatus = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		vi.spyOn(mode, "showHookConfirm").mockImplementation(async () => {
			// A running turn swapped the session while the user was answering.
			await session.sessionManager.newSession();
			return true;
		});

		await mode.handleDeleteCommand();

		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(showStatus).toHaveBeenCalledTimes(1);
	});
});
