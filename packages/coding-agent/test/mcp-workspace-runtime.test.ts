import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";

const peer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const toolName = "mcp__scoped_regression_announce";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("revoking workspace trust and reloading unmounts real tools and reaps the owned peer without disposing the session", async () => {
	const previous = beginSettingsTest();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-runtime-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp/agent");
	const workspace = path.join(root, "workspace");
	const cwd = path.join(workspace, "repo/src");
	const audit = path.join(root, "peer.jsonl");
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let ownedPid: number | undefined;
	try {
		// All ambient providers see an empty home; profile and agent roots are fixture-owned.
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.XDG_CONFIG_HOME = path.join(home, ".config");
		process.env.PI_CONFIG_DIR = ".omp";
		delete process.env.CLAUDE_CONFIG_DIR;
		delete process.env.COPILOT_HOME;
		delete process.env.OMP_PROFILE;
		delete process.env.PI_PROFILE;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(agentDir);
		await fs.mkdir(path.join(workspace, "repo/.git"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		setProjectDir(cwd);
		await Bun.write(audit, "");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			`mcp:\n  workspaceRoots: ${JSON.stringify([workspace])}\n  startupTimeoutMs: 0\n`,
		);
		await Bun.write(
			path.join(workspace, ".omp/mcp.json"),
			JSON.stringify({
				mcpServers: { scoped: { command: process.execPath, args: [peer, audit] } },
			}),
		);
		clearCache();
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		authStorage = await AuthStorage.create(":memory:");
		const created = await createAgentSession({
			cwd,
			agentDir,
			settings,
			bindProcessState: false,
			modelRegistry: new ModelRegistry(authStorage),
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.inMemory(cwd),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
		});
		session = created.session;
		const manager = created.mcpManager;
		if (!manager) throw new Error("Expected owning MCP manager");
		const tool = session.getToolByName(toolName);
		if (!tool) throw new Error("Inherited MCP tool was not mounted");
		const result = await tool.execute("workspace-call", {});
		expect(result.content).toContainEqual({ type: "text", text: "rpc-mcp-invoked" });
		const entries = Bun.JSONL.parse(await Bun.file(audit).text()) as Array<{
			event?: string;
			pid?: number;
			method?: string;
		}>;
		ownedPid = entries.find(entry => entry.event === "spawn")?.pid;
		if (ownedPid === undefined) throw new Error("Peer did not record its PID");
		expect(isAlive(ownedPid)).toBe(true);
		expect(entries.some(entry => entry.method === "tools/call")).toBe(true);

		await Bun.write(path.join(agentDir, "config.yml"), "mcp:\n  workspaceRoots: []\n  startupTimeoutMs: 0\n");
		await settings.reloadFromDisk();
		initTheme();
		const controller = new MCPCommandController(
			createInteractiveModeContext({ settings, session, mcpManager: manager }),
		);
		await withActiveSettings(settings, () => controller.reloadServers());

		expect(manager.getConnectedServers()).toEqual([]);
		expect(manager.getTools().map(tool => tool.name)).not.toContain(toolName);
		expect(session.getToolByName(toolName)).toBeUndefined();
		expect(isAlive(ownedPid), "reload returned with its owned stdio peer still alive").toBe(false);
		// The same session can still execute its builtin read tool after MCP teardown.
		const marker = path.join(root, "session-alive.txt");
		await Bun.write(marker, "workspace-reload-session-alive");
		const read = session.getToolByName("read");
		if (!read) throw new Error("Session lost its builtin read tool");
		const after = await read.execute("after-reload", { path: marker });
		expect(
			after.content.some(part => part.type === "text" && part.text.includes("workspace-reload-session-alive")),
		).toBe(true);
	} finally {
		await session?.dispose();
		// Only this fixture's audited peer may be cleaned up on a failing assertion.
		if (ownedPid !== undefined && isAlive(ownedPid)) process.kill(ownedPid, "SIGKILL");
		authStorage?.close();
		closeModelCache();
		clearCache();
		restoreSettingsTestState(previous);
		AgentStorage.close();
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	}
}, 30_000);
