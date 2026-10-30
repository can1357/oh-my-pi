import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

class FailingRewriteStorage extends MemorySessionStorage {
	failNextRewrite = false;

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.failNextRewrite) {
			this.failNextRewrite = false;
			throw new Error("ENOSPC: synthetic session rewrite failure");
		}
		await super.writeTextAtomic(path, content, options);
	}
}

class FailingAppendStorage extends MemorySessionStorage {
	failNextAppend = false;

	override appendSync(path: string, chunk: string): void {
		if (this.failNextAppend) {
			this.failNextAppend = false;
			throw new Error("ENOSPC: synthetic session append failure");
		}
		super.appendSync(path, chunk);
	}
}

beforeAll(async () => {
	await initTheme(false);
});

function clearCommandRuntime(session: AgentSession): { ctx: InteractiveModeContext } {
	const ctx = {
		session,
		sessionManager: session.sessionManager,
		editor: { setText: () => {} },
		statusLine: { invalidate: () => {} },
		clearTransientSessionUi: () => {},
		resetTranscript: () => {},
		updateEditorBorderColor: () => {},
		present: () => {},
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;
	const controller = new CommandController(ctx);
	ctx.handleResetContextCommand = () => controller.handleResetContextCommand();
	return { ctx };
}

describe("AgentSession persistence failure context", () => {
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		session = undefined;
	});

	it("does not deliver a queued persistence warning after atomic recovery restores durability", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["acknowledged"] }] });
		const storage = new FailingRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		await sessionManager.ensureOnDisk();
		authStorage = await AuthStorage.create(":memory:");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		await sessionManager.appendEntriesAtomically(() => sessionManager.appendCustomEntry("durable-before-rewrite"));
		storage.failNextRewrite = true;
		await expect(
			sessionManager.appendEntriesAtomically(() => sessionManager.appendCustomEntry("rejected-rewrite")),
		).rejects.toThrow("synthetic session rewrite failure");
		expect(sessionManager.getPersistenceFailure()).toBeUndefined();

		await session.prompt("continue the task");

		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && message.customType === "session-persistence-error",
			),
		).toBe(false);
		expect(JSON.stringify(mock.calls[0]?.context.messages)).not.toContain("session-persistence-error");
	});

	it("does not deliver a queued persistence warning after a later append in the turn recovers", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["acknowledged"] }] });
		const storage = new FailingAppendStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		await sessionManager.ensureOnDisk();
		authStorage = await AuthStorage.create(":memory:");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		storage.failNextAppend = true;
		sessionManager.appendCustomEntry("failed-entry");
		expect(sessionManager.getPersistenceFailure()).toBeDefined();
		sessionManager.appendCustomEntry("recovered-entry");
		expect(sessionManager.getPersistenceFailure()).toBeUndefined();

		await session.prompt("continue the task");

		expect(mock.calls).toHaveLength(1);
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && message.customType === "session-persistence-error",
			),
		).toBe(false);
		expect(JSON.stringify(mock.calls[0]?.context.messages)).not.toContain("session-persistence-error");
	});

	it("delivers the persistence warning after a real /clear while the failure remains latched", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["acknowledged"] }] });
		const storage = new FailingRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		await sessionManager.ensureOnDisk();
		authStorage = await AuthStorage.create(":memory:");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const durableEntryId = sessionManager.appendCustomEntry("durable-before-rewrite");
		const durableEntry = sessionManager.getEntry(durableEntryId);
		if (!durableEntry || durableEntry.type !== "custom") throw new Error("Expected durable custom entry");
		durableEntry.data = { rewritten: true };
		storage.failNextRewrite = true;
		await expect(sessionManager.rewriteEntries()).rejects.toThrow("synthetic session rewrite failure");
		expect(sessionManager.getPersistenceFailure()).toBeDefined();

		expect(await executeBuiltinSlashCommand("/clear", clearCommandRuntime(session))).toBe(true);
		await session.prompt("continue the task");

		const warning = session.agent.state.messages.find(
			message => message.role === "custom" && message.customType === "session-persistence-error",
		);
		expect(warning).toMatchObject({ display: false, attribution: "agent" });
		if (warning?.role !== "custom" || typeof warning.content !== "string") {
			throw new Error("Expected the persistence warning to be a hidden custom message");
		}
		const providerContext = JSON.stringify(mock.calls[0]?.context.messages);
		expect(providerContext.split(warning.content).length - 1).toBe(1);
		await sessionManager.recoverPersistenceFromCurrentState();
	});

	it("delivers one warning after /clear when its reset boundary is the first persistence failure", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["acknowledged"] }] });
		const storage = new FailingAppendStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		await sessionManager.ensureOnDisk();
		authStorage = await AuthStorage.create(":memory:");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessionManager.appendCustomEntry("durable-before-clear");

		storage.failNextAppend = true;
		expect(await executeBuiltinSlashCommand("/clear", clearCommandRuntime(session))).toBe(true);
		expect(sessionManager.getPersistenceFailure()).toBeDefined();
		await session.prompt("continue the task");

		const warnings = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "session-persistence-error",
		);
		expect(warnings).toHaveLength(1);
		const warning = warnings[0];
		if (warning?.role !== "custom" || typeof warning.content !== "string") {
			throw new Error("Expected the persistence warning to be a hidden custom message");
		}
		const providerContext = JSON.stringify(mock.calls[0]?.context.messages);
		expect(providerContext.split(warning.content).length - 1).toBe(1);
	});

	it("does not warn after /clear when its reset boundary republishes the session", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: [{ content: ["acknowledged"] }] });
		const storage = new FailingAppendStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		await sessionManager.ensureOnDisk();
		authStorage = await AuthStorage.create(":memory:");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		storage.failNextAppend = true;
		sessionManager.appendCustomEntry("lost-append");
		expect(sessionManager.getPersistenceFailure()).toBeDefined();

		// The reset boundary's full rewrite succeeds and republishes the lost append.
		expect(await executeBuiltinSlashCommand("/clear", clearCommandRuntime(session))).toBe(true);
		expect(sessionManager.getPersistenceFailure()).toBeUndefined();
		await session.prompt("continue the task");

		expect(mock.calls).toHaveLength(1);
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && message.customType === "session-persistence-error",
			),
		).toBe(false);
	});
});
