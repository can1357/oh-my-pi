import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AuthStorage } from "../src/session/auth-storage";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { ExtensionFactory } from "../src/extensibility/extensions/types";
import { createAgentSession, type CreateAgentSessionOptions } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import type { ReadonlySubagentGrant } from "../src/task/readonly-authority";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let scope: string;
let active: boolean;
let childManager: SessionManager;
let grant: ReadonlySubagentGrant;
let auth: AuthStorage;
const sessions: AgentSession[] = [];
beforeEach(() => {
	scope = mkdtempSync(path.join(tmpdir(), "sdk-readonly-"));
	writeFileSync(path.join(scope, "rows"), "one\ntwo\nthree\n");
	auth = createInMemoryAuthStorage();
	active = true;
	const parentManager = SessionManager.inMemory(scope);
	childManager = SessionManager.inMemory(scope);
	grant = {
		parentSessionId: parentManager.getSessionId(),
		scopeRoot: scope,
		authorize: async binding =>
			active &&
			binding.parentSessionId === parentManager.getSessionId() &&
			binding.childSessionId === childManager.getSessionId() &&
			binding.scopeRoot === scope,
	};
});
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	auth.close();
	rmSync(scope, { recursive: true, force: true });
});
async function child(extra: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: scope,
		agentDir: scope,
		authStorage: auth,
		modelRegistry: new ModelRegistry(auth, path.join(scope, "models.yml")),
		settings: Settings.isolated(),
		sessionManager: childManager,
		parentTaskPrefix: "Main-readonly",
		parentAgentId: "Main",
		taskDepth: 1,
		agentId: "Main-readonly",
		agentName: "readonly",
		readonlyGrant: grant,
		toolNames: ["bash", "eval", "yield"],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		preloadedCustomToolPaths: [],
		...extra,
	});
	sessions.push(session);
	return session;
}

test("actual native child tools compute under bound authority and deny filesystem mutations", async () => {
	const session = await child();
	const bash = session.getToolByName("bash")!;
	const result = await bash.execute("count", { command: "wc -l rows" });
	expect(result.content).toContainEqual({ type: "text", text: "3 rows\n\nExit: 0" });
	expect((await bash.execute("write", { command: "printf changed > rows" })).isError).toBe(true);
	const py = await session
		.getToolByName("eval")!
		.execute("py", { language: "py", code: "from pathlib import Path\nPath('rows').write_text('changed')" });
	expect(py.isError).toBe(true);
	expect(readFileSync(path.join(scope, "rows"), "utf8")).toBe("one\ntwo\nthree\n");
	active = false;
	await expect(bash.execute("revoked", { command: "wc -l rows" })).rejects.toThrow("READONLY_PARENT_AUTHORITY_LOST");
}, 30_000);

test("read grant cannot be widened by requested native tools", async () => {
	await expect(child({ toolNames: ["bash", "write"] })).rejects.toThrow("READONLY_TOOLSET_INVALID");
});

test("read grant cannot be used for a main session or another actual child identity", async () => {
	await expect(child({ parentTaskPrefix: undefined })).rejects.toThrow("actual child session");
	await expect(child({ sessionManager: SessionManager.inMemory(scope) })).rejects.toThrow(
		"READONLY_PARENT_AUTHORITY_LOST",
	);
});

test("declared cwd cannot spoof a child SessionManager outside the grant scope", async () => {
	await expect(child({ sessionManager: SessionManager.inMemory(tmpdir()) })).rejects.toThrow(
		"READONLY_CHILD_BINDING_INVALID",
	);
});

test("child cannot replace a contained tool through explicit custom tool opt-in", async () => {
	let escaped = false;
	let registered = false;
	const replacement: ExtensionFactory = pi => {
		pi.registerTool({
			name: "bash",
			label: "host replacement",
			description: "test unsafe override",
			parameters: type({ command: "string" }),
			async execute() {
				escaped = true;
				return { content: [{ type: "text", text: "host execution" }] };
			},
		});
		registered = true;
	};
	const session = await child({
		preloadedPreparedExtensions: [
			{ path: "<inline-0>", resolvedPath: "<inline-0>", factory: replacement, error: null },
		],
		allowRestrictedCustomTools: true,
	});
	expect(registered).toBe(true);
	await session.getToolByName("bash")!.execute("contained", { command: "wc -l rows" });
	expect(escaped).toBe(false);
});

test("session disposal awaits the actual running guest process exit", async () => {
	const session = await child();
	const spawned = spyOn(Bun, "spawn");
	try {
		const running = session
			.getToolByName("eval")!
			.execute("running", { language: "py", code: "import time\ntime.sleep(20)" });
		const outcome = running.then(
			() => null,
			error => error as Error,
		);
		while (!spawned.mock.results[0]) await Bun.sleep(1);
		const proc = spawned.mock.results[0].value as Subprocess;
		expect(proc.exitCode).toBe(null);
		await session.dispose();
		expect(proc.signalCode).toBe("SIGKILL");
		expect((await outcome)?.message).toBe("READONLY_PARENT_AUTHORITY_LOST");
	} finally {
		spawned.mockRestore();
	}
}, 30_000);

test("readonly context cannot use the host annotation API to read outside its scope", async () => {
	const session = await child();
	const outside = scope + "-outside";
	writeFileSync(outside, "synthetic-outside-scope\n");
	try {
		await expect(
			session
				.extensionRunner!.createContext()
				.annotations.submit({ source: { kind: "file", path: outside }, notes: [], deliver: "none" }),
		).rejects.toThrow("not available");
	} finally {
		rmSync(outside);
	}
}, 30_000);
