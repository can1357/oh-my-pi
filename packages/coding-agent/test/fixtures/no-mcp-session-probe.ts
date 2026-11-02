/**
 * Starts MCP the in-process way a running omp does, in a process whose home,
 * agent dir and `PI_NO_MCP` the test chose:
 * - `revive <cwd>`: revive a persisted subagent with no shared MCP manager,
 *   under a parent session that has MCP on;
 * - `revive-parent-off <cwd>`: the same under a parent that runs with MCP off
 *   (`enableMCP: false`, as an ACP session or an SDK host may);
 * - `discover <cwd>`: the public SDK's `discoverMCPServers`.
 * Prints one JSON line; the test reads the MCP server's own start audit.
 */
import * as path from "node:path";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { discoverMCPServers } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";

const [mode, cwd] = process.argv.slice(2);
if (!cwd || (mode !== "revive" && mode !== "revive-parent-off" && mode !== "discover")) {
	throw new Error("usage: no-mcp-session-probe.ts <revive|revive-parent-off|discover> <cwd>");
}

async function revive(parentEnableMCP: boolean): Promise<void> {
	const persisted = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = persisted.getSessionFile();
	if (!sessionFile) throw new Error("expected a persisted session file");
	persisted.appendSessionInit({
		systemPrompt: ["persisted prompt"],
		task: "persisted task",
		tools: ["read", "yield"],
		modelRole: "default",
		resolvedModel: "anthropic/claude-sonnet-4-5",
		spawns: "",
	});
	// A transcript is written, and revivable, once it holds an assistant turn.
	persisted.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "persisted" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await persisted.close();

	const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
	const parent = {
		sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
		sessionFile: path.join(cwd, "parent.jsonl"),
		effectiveExtensionRoots: { explicit: [], mode: "explicit-only", configured: [], configuredLevel: "user" },
		preparedExtensions: undefined,
		getSessionAgents: () => [],
	} as unknown as AgentSession;
	const ref = AgentRegistry.global().register({
		id: "Revived",
		displayName: "Revived",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile,
		createdAt: 0,
		lastActivity: 0,
	});
	const reviver = await createPersistedSubagentReviverFactory({
		session: parent,
		authStorage,
		modelRegistry,
		settings: Settings.isolated(),
		enableLsp: false,
		enableMCP: parentEnableMCP,
	})(ref);
	if (!reviver) throw new Error("expected a persisted reviver");
	const child = await reviver(ref);
	try {
		process.stdout.write(`${JSON.stringify({ revived: true })}\n`);
	} finally {
		await child.dispose();
		authStorage.close();
	}
}

async function discover(): Promise<void> {
	const result = await discoverMCPServers(cwd);
	try {
		process.stdout.write(`${JSON.stringify({ connected: result.connectedServers, errors: result.errors })}\n`);
	} finally {
		await result.manager.disconnectAll();
	}
}

await (mode === "discover" ? discover() : revive(mode === "revive"));
process.exit(0);
