import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("SDK workpool yield schema", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-workpool-yield-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	it("switches the constructed yield tool before a pooled turn starts", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			requireYieldTool: true,
			toolNames: ["yield"],
		});
		sessions.push(session);
		const tool = session.getToolByName("yield");
		if (!tool) throw new Error("Missing yield tool");
		expect(Reflect.get(tool.parameters, "properties")).toHaveProperty("type");
		expect(Reflect.get(tool.parameters, "properties")).not.toHaveProperty("key");

		session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
		expect(Reflect.get(tool.parameters, "required")).toEqual(["key"]);
		const properties = Reflect.get(tool.parameters, "properties");
		expect(properties).toHaveProperty("key");
		expect(properties).not.toHaveProperty("type");
		const activeTool = session.agent.state.tools.find(candidate => candidate.name === "yield");
		if (!activeTool) throw new Error("Missing active yield tool");
		expect(Reflect.get(activeTool.parameters, "required")).toEqual(["key"]);
		const result = await tool.execute("yield-pool-1", { key: 1, data: { answer: 42 } });
		expect(result.details).toMatchObject({ type: ["pool#1"], complete: true });
	});
});
