/**
 * Topic session factory: each request gets its own settings, session manager,
 * event bus and agent id, none of the interactive session's, and the model
 * selector applies to fresh sessions only (a resumed session keeps its own).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTelegramSessionFactory } from "@oh-my-pi/pi-coding-agent/telegram/session-factory";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

let dir = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-factory-"));
	setAgentDir(path.join(dir, "agent"));
});

afterEach(() => {
	__resetDirsFromEnvForTests();
	fs.rmSync(dir, { recursive: true, force: true });
});

interface Captured {
	options: CreateAgentSessionOptions;
}

function factory(captured: Captured[], overrides: Partial<Record<string, unknown>> = {}) {
	const interactiveSessionManager = SessionManager.create(path.join(dir, "interactive"));
	const baseEventBus = new EventBus();
	const settings = Settings.isolated({});
	const factoryFn = createTelegramSessionFactory({
		baseOptions: {
			sessionManager: interactiveSessionManager,
			eventBus: baseEventBus,
			preloadedExtensions: { extensions: [], errors: [] } as never,
			extensions: [() => Promise.reject(new Error("never loaded"))],
			settingsApproval: true,
			agentId: "Main",
			hasUI: true,
			...overrides,
		},
		settings,
		authStorage: {} as AuthStorage,
		modelRegistry: {} as ModelRegistry,
		bindProcessState: false,
		createSession: async options => {
			captured.push({ options });
			return {
				session: { sessionId: "fake" },
				setToolUIContext: () => {},
			} as unknown as CreateAgentSessionResult;
		},
	});
	return { factoryFn, baseEventBus, interactiveSessionManager, settings };
}

describe("createTelegramSessionFactory", () => {
	it("mints a fresh session for the topic: own settings, manager, bus and agent id", async () => {
		const captured: Captured[] = [];
		const { factoryFn, baseEventBus, interactiveSessionManager, settings } = factory(captured);
		const cwd = path.join(dir, "project");
		fs.mkdirSync(cwd);
		await factoryFn({ cwd, model: "anthropic/claude-opus-4" });

		const options = captured[0].options;
		expect(options.cwd).toBe(cwd);
		expect(options.sessionManager).toBeInstanceOf(SessionManager);
		expect(options.sessionManager).not.toBe(interactiveSessionManager);
		expect(options.sessionManager?.getRecordedCwd()).toBe(cwd);
		expect(options.settings).not.toBe(settings);
		expect(options.eventBus).toBeInstanceOf(EventBus);
		expect(options.eventBus).not.toBe(baseEventBus);
		expect(options.agentId).toMatch(/^telegram:/u);
		expect(options.hasUI).toBe(false);
		expect(options.interactivePrompts).toBe(true);
		expect(options.bindProcessState).toBe(false);
		expect(options.presenceKind).toBe("telegram");
		expect(options.modelPattern).toBe("anthropic/claude-opus-4");
	});

	it("strips every option that belongs to the interactive session", async () => {
		const captured: Captured[] = [];
		const { factoryFn, baseEventBus, interactiveSessionManager } = factory(captured);
		await factoryFn({ cwd: dir, model: undefined });
		const options = captured[0].options as Record<string, unknown>;
		expect(options.sessionManager).not.toBe(interactiveSessionManager);
		expect(options.eventBus).not.toBe(baseEventBus);
		for (const key of ["subagentEventBus", "preloadedExtensions", "extensions", "settingsApproval"]) {
			expect(options[key]).toBeUndefined();
		}
		expect(options.agentId).toMatch(/^telegram:/u);
		expect(options.hasUI).toBe(false);
	});

	it("opens the recorded file for a resume and ignores the model selector there", async () => {
		const captured: Captured[] = [];
		const { factoryFn } = factory(captured);
		const cwd = path.join(dir, "resumed");
		fs.mkdirSync(cwd);
		const sessionFile = path.join(dir, "abc123.jsonl");
		const manager = SessionManager.create(cwd);
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "recorded" }] } as never);
		await manager.ensureOnDisk();
		if (manager.getSessionFile() === undefined) throw new Error("session file was not created");
		fs.copyFileSync(manager.getSessionFile() as string, sessionFile);

		await factoryFn({ cwd, sessionFile, model: "anthropic/claude-opus-4" });
		const options = captured[0].options;
		expect(options.sessionManager?.getSessionFile()).toBe(sessionFile);
		expect(options.modelPattern).toBeUndefined();
		expect(options.sessionManager?.getSessionId()).toBe(manager.getSessionId());
	});
});
