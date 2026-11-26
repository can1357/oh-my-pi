import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { type CustomTool, createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// `--no-tools` must give the model exactly the `--tools` names. It used to clear
// only the built-in list, so auto-learn, memory, Auto-QA, MCP, extension and
// custom tools still reached the model and `-p --no-tools` runs wrote managed
// skills and long-term memories into the real profile.

function fixtureTool(name: string, extra: Partial<CustomTool> = {}): CustomTool {
	return {
		name,
		label: name,
		description: `Fixture tool ${name}.`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
		...extra,
	};
}

const extensionTool: ExtensionFactory = pi => {
	pi.registerTool({
		name: "ext_tool",
		label: "ext_tool",
		description: "Extension fixture tool.",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "ext_tool" }] };
		},
	});
};

describe("--no-tools", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		tempDir = await TempDir.create("@cli-no-tools-");
		authStorage = createInMemoryAuthStorage();
	});

	afterAll(async () => {
		await Promise.all(sessions.map(session => session.dispose()));
		authStorage.close();
		await tempDir.remove();
	});

	it("enables only the named built-ins despite auto-learn, memory, Auto-QA, MCP, extension and custom tools", async () => {
		// Auto-learn plus mnemopi is the profile that widened the list with
		// manage_skill, learn, recall, retain, reflect and memory_edit.
		const settings = Settings.isolated({
			"autolearn.enabled": true,
			"memory.backend": "mnemopi",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"dev.autoqa": true,
		});
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const options = await buildSessionOptions(
			parseArgs(["--no-tools", "--tools", "read"]),
			[],
			sessionManager,
			modelRegistry,
			settings,
		);
		const { session } = await createAgentSession({
			...options,
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			skipPythonPreflight: true,
			extensions: [extensionTool],
			customTools: [fixtureTool("sdk_tool")],
			mcpTools: [fixtureTool("mcp__fixture_ping", { mcpServerName: "fixture", mcpToolName: "ping" })],
		});
		sessions.push(session);

		expect(session.getEnabledToolNames()).toEqual(["read"]);
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).not.toContain("manage_skill");
		expect(prompt).not.toContain("long-term memory");
		expect(prompt).not.toContain("report_issue");
	});

	it("rejects explicit extensions, which a --no-tools session would not load", () => {
		expect(() => parseArgs(["--no-tools", "-e", "./ext.ts"])).toThrow(CliUsageError);
		expect(() => parseArgs(["--no-tools", "--hook", "./hook.ts"])).toThrow(CliUsageError);
	});
});
