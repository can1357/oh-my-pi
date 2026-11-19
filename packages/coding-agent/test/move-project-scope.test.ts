/**
 * Regression (#19385): `/move` must re-scope everything discovered from the project
 * directory — task agents, project extensions, custom tools, and project MCP servers —
 * so the session sees the destination project's set, and moving back restores the source's.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

/**
 * `/move` reconnects MCP servers in the background (turns wait for them, bounded) and exposes no
 * completion signal, so the test polls the live registry while real stdio servers handshake.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

describe("/move re-scopes project-discovered capabilities", () => {
	const tempDirs: string[] = [];
	const originalProjectDir = getProjectDir();
	const originalAgentDir = getAgentDir();

	afterEach(() => {
		setProjectDir(originalProjectDir);
		setAgentDir(originalAgentDir);
		AgentStorage.close();
		for (const tempDir of tempDirs.splice(0)) removeSyncWithRetries(tempDir);
	});

	it("swaps agents, extensions, custom tools, and MCP servers to the destination and back", async () => {
		const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-move-project-scope-")));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "alpha");
		const cwdB = path.join(tempDir, "beta");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		setAgentDir(agentDir);
		const mcpServerScript = path.join(tempDir, "mcp-server.js");
		fs.writeFileSync(mcpServerScript, MCP_SERVER_SOURCE);
		writeProject(cwdA, "alpha", mcpServerScript);
		writeProject(cwdB, "beta", mcpServerScript);
		setProjectDir(cwdA);

		const authStorage = createInMemoryAuthStorage();
		const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
		const sessionManager = SessionManager.create(cwdA, SessionManager.getDefaultSessionDir(cwdA, agentDir));
		let session: AgentSession | undefined;
		try {
			({ session } = await createAgentSession({
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
			const tools = () => live.getAllToolNames();
			const hasMcpProbe = (label: string) => tools().some(name => name.endsWith(`${label}_probe`));
			const taskDescription = () => live.getToolByName("task")?.description ?? "";
			const move = async (target: string, from: string) => {
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
			};

			expect(tools()).toEqual(expect.arrayContaining(["alpha_ext_tool", "alpha_custom_tool"]));
			expect(hasMcpProbe("alpha")).toBe(true);
			expect(taskDescription()).toContain("alpha-agent");

			await move(cwdB, cwdA);

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
			await until(() => hasMcpProbe("beta") && !hasMcpProbe("alpha"), "beta MCP tools to replace alpha's");

			await move(cwdA, cwdB);

			expect(tools()).toEqual(expect.arrayContaining(["alpha_ext_tool", "alpha_custom_tool"]));
			expect(tools()).not.toContain("beta_ext_tool");
			expect(tools()).not.toContain("beta_custom_tool");
			expect(taskDescription()).toContain("alpha-agent");
			await until(() => hasMcpProbe("alpha") && !hasMcpProbe("beta"), "alpha MCP tools to return");
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	}, 60_000);
});
