/**
 * Regression (#19385): `/move` must re-scope everything discovered from the project
 * directory — task agents, project extensions, custom tools, and project MCP servers —
 * so the session sees the destination project's set, and moving back restores the source's.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import {
	getAgentDir,
	getMCPConfigPath,
	getProjectDir,
	removeSyncWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { IsolatedDaemon } from "./fixtures/daemon-harness";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Newline-delimited JSON-RPC MCP server exposing one `<server>_probe` tool. */
const MCP_SERVER_SOURCE = `
const name = process.argv[2];
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id === undefined) continue;
		let result = {};
		if (message.method === "initialize") {
			result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } };
		} else if (message.method === "tools/list") {
			result = { tools: [{ name: name + "_probe", description: "probe", inputSchema: { type: "object", properties: {} } }] };
		}
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
	}
});
`;

/** One project with its own agent, extension tool, custom tool, and MCP server, all named `<label>`. */
function writeProject(root: string, label: string, mcpServerScript: string): void {
	const omp = path.join(root, ".omp");
	fs.mkdirSync(path.join(omp, "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(omp, "agents", `${label}-agent.md`),
		`---\nname: ${label}-agent\ndescription: ${label} project agent\n---\nHandle the assigned task.\n`,
	);
	fs.mkdirSync(path.join(omp, "extensions"), { recursive: true });
	fs.writeFileSync(
		path.join(omp, "extensions", `${label}-ext.ts`),
		[
			"export default function (pi) {",
			"  pi.registerTool({",
			`    name: "${label}_ext_tool",`,
			`    label: "${label} ext",`,
			`    description: "${label} extension tool",`,
			"    parameters: pi.typebox.Type.Object({}),",
			"    async execute() { return { content: [{ type: 'text', text: 'ok' }] }; },",
			"  });",
			"}",
		].join("\n"),
	);
	fs.mkdirSync(path.join(omp, "tools"), { recursive: true });
	fs.writeFileSync(
		path.join(omp, "tools", `${label}-tool.ts`),
		[
			"export default function (api) {",
			"  return {",
			`    name: "${label}_custom_tool",`,
			`    description: "${label} custom tool bound to " + api.cwd,`,
			"    parameters: api.typebox.Type.Object({}),",
			"    async execute() { return { content: [{ type: 'text', text: api.cwd }] }; },",
			"  };",
			"}",
		].join("\n"),
	);
	fs.writeFileSync(
		getMCPConfigPath("project", root),
		JSON.stringify({
			mcpServers: { [label]: { type: "stdio", command: process.execPath, args: [mcpServerScript, label] } },
		}),
	);
}

describe("/move re-scopes project-discovered capabilities", () => {
	const tempDirs: string[] = [];
	const originalProjectDir = getProjectDir();
	const originalAgentDir = getAgentDir();
	let daemon: IsolatedDaemon | undefined;

	// dispose() waits up to 10 s for the daemon to exit; without --timeout, Bun gives a hook only 5 s.
	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await daemon?.dispose();
		} finally {
			daemon = undefined;
			setProjectDir(originalProjectDir);
			setAgentDir(originalAgentDir);
			AgentStorage.close();
			for (const tempDir of tempDirs.splice(0)) removeSyncWithRetries(tempDir);
		}
	}, 15_000);

	it("swaps agents, extensions, custom tools, and MCP servers to the destination and back", async () => {
		const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-move-project-scope-")));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "alpha");
		const cwdB = path.join(tempDir, "beta");
		// MCP discovery also reads the machine's own config under the home directory (the plugins
		// installed in ~/.omp/plugins, among others): a test-local home keeps their servers out.
		// Set it before setAgentDir, which reads the home for omp's other paths (its caches, among others).
		const home = path.join(tempDir, "home");
		fs.mkdirSync(home);
		spyOn(os, "homedir").mockReturnValue(home);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		setAgentDir(agentDir);
		// Shared MCP servers run in an omp daemon: a daemon of the test's own keeps the user's daemon out.
		daemon = await IsolatedDaemon.create();
		const mcpServerScript = path.join(tempDir, "mcp-server.js");
		fs.writeFileSync(mcpServerScript, MCP_SERVER_SOURCE);
		writeProject(cwdA, "alpha", mcpServerScript);
		writeProject(cwdB, "beta", mcpServerScript);
		setProjectDir(cwdA);

		const authStorage = createInMemoryAuthStorage();
		const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
		const sessionManager = SessionManager.create(cwdA, SessionManager.getDefaultSessionDir(cwdA, agentDir));
		let session: AgentSession | undefined;
		let mcpManager: MCPManager | undefined;
		try {
			({ session, mcpManager } = await createAgentSession({
				cwd: cwdA,
				agentDir,
				sessionManager,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				toolNames: ["read", "task"],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
			}));
			const live = session;
			const manager = mcpManager!;
			const tools = () => live.getAllToolNames();
			const hasMcpProbe = (label: string) => tools().some(name => name.endsWith(`${label}_probe`));
			const taskDescription = () => live.getToolByName("task")?.description ?? "";
			// MCP servers connect in the background, after the startup window and after `/move`'s reload,
			// so the test waits for those connects themselves, with no deadline of its own: its verdict is
			// what connected, not whether a loaded machine started a server within some time.
			const reloads = spyOn(live, "reloadMCPServers");
			// The MCP wait comes back in an object (an async function adopts a returned promise): the checks of
			// what `/move` completes itself run as soon as it returns, and only the MCP checks wait.
			const move = async (target: string, from: string) => {
				const before = reloads.mock.results.length;
				const output: string[] = [];
				await executeAcpBuiltinSlashCommand(`/move ${target}`, {
					session: live,
					sessionManager,
					settings,
					cwd: from,
					output: text => {
						output.push(text);
					},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				});
				expect(output.join("\n")).toContain("Moved to ");
				// `/move` starts one MCP reload; its servers may still be connecting when `/move` returns.
				expect(reloads).toHaveBeenCalledTimes(before + 1);
				const reload = reloads.mock.results[before]!.value as Promise<unknown>;
				return { mcpSettled: reload.then(() => manager.waitForStartup(0)) };
			};

			expect(tools()).toEqual(expect.arrayContaining(["alpha_ext_tool", "alpha_custom_tool"]));
			// A server that could not connect fails here with its own error.
			expect((await manager.waitForStartup(0)).failed).toEqual([]);
			expect(hasMcpProbe("alpha")).toBe(true);
			expect(taskDescription()).toContain("alpha-agent");

			const toBeta = await move(cwdB, cwdA);

			expect(sessionManager.getCwd()).toBe(cwdB);
			expect(tools()).toEqual(expect.arrayContaining(["beta_ext_tool", "beta_custom_tool"]));
			expect(tools()).not.toContain("alpha_ext_tool");
			expect(tools()).not.toContain("alpha_custom_tool");
			expect(live.getEnabledToolNames()).toEqual(expect.arrayContaining(["beta_ext_tool", "beta_custom_tool"]));
			// The destination's custom tools bind to the destination cwd.
			const customResult = await live.getToolByName("beta_custom_tool")!.execute("move-probe", {});
			expect(customResult.content).toEqual([{ type: "text", text: cwdB }]);
			expect(taskDescription()).toContain("beta-agent");
			expect(taskDescription()).not.toContain("alpha-agent");
			expect((await toBeta.mcpSettled).failed).toEqual([]);
			expect(hasMcpProbe("beta")).toBe(true);
			expect(hasMcpProbe("alpha")).toBe(false);

			const toAlpha = await move(cwdA, cwdB);

			expect(tools()).toEqual(expect.arrayContaining(["alpha_ext_tool", "alpha_custom_tool"]));
			expect(tools()).not.toContain("beta_ext_tool");
			expect(tools()).not.toContain("beta_custom_tool");
			expect(taskDescription()).toContain("alpha-agent");
			expect((await toAlpha.mcpSettled).failed).toEqual([]);
			expect(hasMcpProbe("alpha")).toBe(true);
			expect(hasMcpProbe("beta")).toBe(false);
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	}, 60_000);
});
