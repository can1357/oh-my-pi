import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as sessionAdvisors from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: string;
let authStorage: AuthStorage;

beforeEach(() => {
	tempDir = path.join(os.tmpdir(), `pi-advisor-tool-availability-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	authStorage = createInMemoryAuthStorage();
});

afterEach(() => {
	authStorage.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function requireTool(tools: readonly AgentTool[], name: string): AgentTool {
	const tool = tools.find(entry => entry.name === name);
	if (!tool) throw new Error(`expected ${name} in [${tools.map(entry => entry.name).join(", ")}]`);
	return tool;
}

function schemaText(tool: AgentTool): string {
	const parameters = tool.parameters as { toJsonSchema(): unknown };
	return JSON.stringify(parameters.toJsonSchema());
}

async function outcomeText(tool: AgentTool): Promise<string> {
	try {
		const result = await tool.execute("advisor-service", {
			command: "true",
			name: "advisor-web",
			cwd: "proc://",
		} as never);
		return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

// An advisor granted bash must be able to launch services when the primary does
// not have bash, and must not advertise tools only the primary has.
test("advisor tool availability follows that advisor's grant, not the primary", async () => {
	const RealSessionAdvisors = sessionAdvisors.SessionAdvisors;
	let factory: sessionAdvisors.AdvisorToolFactory | undefined;
	const advisorsSpy = spyOn(sessionAdvisors, "SessionAdvisors").mockImplementation(function (
		host: sessionAdvisors.SessionAdvisorsHost,
		options: sessionAdvisors.SessionAdvisorsOptions,
	) {
		factory = options.tools;
		return new RealSessionAdvisors(host, options);
	} as never);
	let session: AgentSession;
	try {
		({ session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings: Settings.isolated({
				"launch.enabled": true,
				"async.enabled": true,
				"find.enabled": "on",
				"bashInterceptor.enabled": false,
			}),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read", "bash", "wait", "find"],
		}));
	} finally {
		advisorsSpy.mockRestore();
	}
	try {
		await session.setActiveToolsByName(["read"]);
		const primaryActive = session.getActiveToolNames();
		expect(primaryActive).toContain("read");
		expect(primaryActive).not.toContain("bash");
		expect(primaryActive).not.toContain("wait");
		expect(primaryActive).not.toContain("find");
		const primaryBash = session.getToolByName("bash");
		expect(primaryBash).toBeDefined();
		expect(schemaText(primaryBash!)).not.toContain('"ready"');
		expect(primaryBash!.description).not.toContain("Long-lived services");

		const rich = factory!.create(new Set(["bash", "task", "wait", "grep", "find", "lsp"]));
		const narrow = factory!.create(new Set(["bash", "task", "grep"]));
		expect(rich.tools.map(tool => tool.name)).not.toContain("lsp");
		const richBash = requireTool(rich.tools, "bash");
		const richTask = requireTool(rich.tools, "task");
		const richGrep = requireTool(rich.tools, "grep");
		const narrowBash = requireTool(narrow.tools, "bash");
		const narrowTask = requireTool(narrow.tools, "task");
		const narrowGrep = requireTool(narrow.tools, "grep");

		expect(schemaText(richBash)).toContain('"ready"');
		expect(richBash.description).toContain("Long-lived services");
		expect(richTask.description).toContain("Call `wait`");
		expect(richGrep.description).toContain("Behavior/unknown symbol → `find`");
		expect(schemaText(narrowBash)).toContain('"ready"');
		expect(narrowBash.description).toContain("Long-lived services");
		expect(narrowTask.description).not.toContain("Call `wait`");
		expect(narrowGrep.description).not.toContain("`find`");

		const launch = await outcomeText(richBash);
		expect(launch).toContain("exists only in the embedded shell");
		expect(launch).not.toContain("Service launch is disabled");

		const bridgeGrep = narrow.createGrepTool?.({});
		const richBridgeGrep = rich.createGrepTool?.({});
		expect(bridgeGrep).toBeDefined();
		expect(richBridgeGrep).toBeDefined();
		expect(bridgeGrep!.description).not.toContain("`find`");
		expect(richBridgeGrep!.description).toContain("Behavior/unknown symbol → `find`");

		await session.setActiveToolsByName(["read", "wait", "find"]);
		expect(session.getActiveToolNames()).toContain("wait");
		expect(session.getActiveToolNames()).toContain("find");
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(narrowTask.description).not.toContain("Call `wait`");
		expect(narrowGrep.description).not.toContain("`find`");
		expect(narrowBash.description).toContain("Long-lived services");
		expect(richTask.description).toContain("Call `wait`");
		expect(schemaText(richBash)).toContain('"ready"');

		await session.setActiveToolsByName(["read"]);
		expect(richTask.description).toContain("Call `wait`");
		expect(richGrep.description).toContain("Behavior/unknown symbol → `find`");
		expect(schemaText(primaryBash!)).not.toContain('"ready"');
	} finally {
		await session!.dispose();
	}
}, 60_000);
