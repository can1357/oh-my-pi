import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression: cross-project `/resume` re-scopes the shared `Settings`
 * instance to the TARGET project's cwd (so `resolvePersona` sees the right
 * `task.disabledAgents`/`task.agentModelOverrides`) BEFORE it's known whether
 * the switch will actually succeed. If `resolvePersona` (or anything else in
 * the try block) throws afterward, `switchSession`'s catch already rolls back
 * the session/model/prompt state, but previously left `Settings` pointed at
 * the target project — every other settings reader (main session, task
 * subagents, the TUI) would silently run with the wrong project's config
 * until something else happened to reload it.
 */
describe("AgentSession.switchSession settings rollback on failure", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-switch-settings-rollback-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	afterEach(async () => {
		while (sessions.length > 0) {
			await sessions.pop()?.dispose();
		}
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {}
		}
	});

	it("restores the previous project's settings scope when the switch fails", async () => {
		const dirA = TempDir.createSync("@pi-switch-settings-rollback-a-");
		const dirB = TempDir.createSync("@pi-switch-settings-rollback-b-");
		tempDirs.push(dirA, dirB);

		// Session A lives in project A; its cwd is what Settings must be
		// restored back to on a failed switch.
		const sessionManager = SessionManager.create(dirA.path(), dirA.path());
		sessionManager.appendMessage({ role: "user", content: "in project A", timestamp: 1 });
		await sessionManager.flush();

		// Session B lives in project B — a real directory different from A, so
		// SessionManager.setSessionFile's headerCwd adoption fires and cwd
		// actually changes mid-switchSession.
		const otherManager = SessionManager.create(dirB.path(), dirB.path());
		otherManager.appendMessage({ role: "user", content: "in project B", timestamp: 2 });
		// A lazy-gated session (user message only, no assistant reply) never
		// writes its header to disk on flush() — force it so switchSession's
		// setSessionFile actually reads a real file with a real header.cwd.
		await otherManager.ensureOnDisk();
		const targetSessionFile = otherManager.getSessionFile();
		expect(targetSessionFile).toBeString();
		await otherManager.close();

		const settings = await Settings.loadIsolated({ cwd: dirA.path(), inMemory: true });
		expect(settings.getCwd()).toBe(path.normalize(dirA.path()));

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const resolvePersona = async (): Promise<null> => {
			throw new Error("simulated persona resolution failure");
		};
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			resolvePersona,
		});
		sessions.push(session);

		await expect(session.switchSession(targetSessionFile!, { onCwdChange: async () => true })).rejects.toThrow(
			"simulated persona resolution failure",
		);

		// The session itself rolled back to project A (sessionManager.restoreState).
		expect(sessionManager.getCwd()).toBe(path.normalize(dirA.path()));
		// Settings — a shared instance every other reader (subagents, TUI) also
		// holds — must be rolled back to the same project, not left on B.
		expect(settings.getCwd()).toBe(path.normalize(dirA.path()));
	});
});
