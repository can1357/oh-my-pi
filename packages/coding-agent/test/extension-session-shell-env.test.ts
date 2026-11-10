/**
 * Environment an extension exports from its session lifecycle handlers must reach
 * the bash tool's commands. The spawn environment is built once and cached; some
 * startup work (the bash tool's own prompt text, another extension registering a
 * bash tool) can build it before extension handlers run, and a session switch
 * happens long after it was built.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAgentIdentity } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { __resetShellConfigCacheForTests, getShellConfig } from "@oh-my-pi/pi-utils/procmgr";

const SUBAGENT: ExtensionAgentIdentity = { kind: "sub", id: "0-Task", name: "task", depth: 1, parentId: "Main" };

const ENV_KEY = "PI_TEST_SESSION_SCOPED_ENV";

// Exports the current session id, the way an extension attributes child
// processes (commit trailers, audit logs) to the session that ran them.
const SESSION_ENV_EXTENSION = `
export default function (pi) {
	const exportSessionId = (_event, ctx) => {
		process.env.${ENV_KEY} = ctx.sessionManager.getSessionId();
	};
	pi.on("session_start", exportSessionId);
	pi.on("session_switch", exportSessionId);
}
`;

describe("session lifecycle environment reaches bash commands", () => {
	let sharedTempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: TempDir;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-session-env-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-session-env-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterEach(() => {
		delete process.env[ENV_KEY];
		// The last session event captured the spawn environment while the variable
		// was set; forget the capture so later test files build from the live env.
		__resetShellConfigCacheForTests();
		resetSettingsForTest();
		tempDir.removeSync();
	});

	async function createRunner(
		sessionManager: SessionManager,
		agent?: ExtensionAgentIdentity,
	): Promise<ExtensionRunner> {
		const extensionPath = tempDir.join("session-env.ts");
		fs.writeFileSync(extensionPath, SESSION_ENV_EXTENSION);
		const loaded = await loadExtensions([extensionPath], tempDir.path());
		expect(loaded.errors).toEqual([]);
		return new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			agent,
		);
	}

	async function run(command: string, sessionKey: string): Promise<string> {
		const result = await executeBash(command, { cwd: tempDir.path(), timeout: 5000, sessionKey });
		expect(result.exitCode).toBe(0);
		return result.output;
	}

	it("a value exported in session_start reaches commands when the spawn environment was built first", async () => {
		// Startup work built and cached the spawn environment before any handler ran.
		expect(getShellConfig().env[ENV_KEY]).toBeUndefined();
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const runner = await createRunner(sessionManager);

		await runner.emit({ type: "session_start" });

		const sessionId = sessionManager.getSessionId();
		expect(await run(`printf '%s' "$${ENV_KEY}"`, sessionId)).toBe(sessionId);
	});

	it("after a session switch, commands see the new session's value, not the previous one", async () => {
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const runner = await createRunner(sessionManager);
		await runner.emit({ type: "session_start" });
		const firstId = sessionManager.getSessionId();
		expect(await run(`printf '%s' "$${ENV_KEY}"`, firstId)).toBe(firstId);

		await sessionManager.newSession();
		await runner.emit({ type: "session_switch", reason: "new", previousSessionFile: undefined });

		const secondId = sessionManager.getSessionId();
		expect(secondId).not.toBe(firstId);
		expect(await run(`printf '%s' "$${ENV_KEY}"`, secondId)).toBe(secondId);
	});

	it("a session event that leaves the environment unchanged keeps the persistent shell and its state", async () => {
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const runner = await createRunner(sessionManager);
		await runner.emit({ type: "session_start" });
		const sessionKey = sessionManager.getSessionId();
		await run("export PI_TEST_PERSISTENT_MARK=kept", sessionKey);

		// Same session, same exported value: the rebuilt environment is identical.
		await runner.emit({ type: "session_start" });

		expect(await run(`printf '%s' "$PI_TEST_PERSISTENT_MARK"`, sessionKey)).toBe("kept");
	});

	it("a subagent's session start leaves the parent's commands with the parent's value", async () => {
		const parentSession = SessionManager.inMemory(tempDir.path());
		const parent = await createRunner(parentSession);
		await parent.emit({ type: "session_start" });
		const parentId = parentSession.getSessionId();

		// An in-process subagent: its own runner and session, the same process.env.
		// Nothing has built the spawn environment since the parent's event, so the
		// subagent's own command is the first to need it.
		const childSession = SessionManager.inMemory(tempDir.path());
		const child = await createRunner(childSession, SUBAGENT);
		await child.emit({ type: "session_start" });
		await run("true", childSession.getSessionId());

		expect(await run(`printf '%s' "$${ENV_KEY}"`, parentId)).toBe(parentId);
	});
});
