import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
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
import { removeSyncWithRetries, Snowflake, prompt } from "@oh-my-pi/pi-utils";
import subagentSystemPromptTemplate from "../src/prompts/system/subagent-system-prompt.md" with { type: "text" };

async function expectProviderYieldContract(
	session: AgentSession,
	dialect: "native" | "gemini",
	pooled: boolean,
): Promise<void> {
	const providerContext = await session.agent.buildSideRequestContext([]);
	if (dialect === "native") {
		const providerTool = providerContext.tools?.find(candidate => candidate.name === "yield");
		if (!providerTool) throw new Error("Missing provider yield tool");
		const properties = Reflect.get(providerTool.parameters, "properties");
		if (pooled) {
			expect(Reflect.get(providerTool.parameters, "required")).toEqual(["key"]);
			expect(properties).toHaveProperty("key");
			expect(properties).not.toHaveProperty("type");
		} else {
			expect(properties).toHaveProperty("type");
			expect(properties).not.toHaveProperty("key");
		}
		return;
	}

	const providerSystemPrompt = providerContext.systemPrompt;
	if (!providerSystemPrompt) throw new Error("Missing provider system prompt");
	const providerPrompt = providerSystemPrompt.join("\n");
	expect(providerPrompt.match(/type yield =/g)).toHaveLength(1);
	const yieldStart = providerPrompt.indexOf("type yield =");
	const nextType = providerPrompt.indexOf("\ntype ", yieldStart + 1);
	const namespaceEnd = providerPrompt.indexOf("\n\n} // namespace functions", yieldStart + 1);
	let yieldEnd = nextType;
	if (yieldEnd < 0 || (namespaceEnd >= 0 && namespaceEnd < yieldEnd)) yieldEnd = namespaceEnd;
	if (yieldEnd < 0) throw new Error("Missing provider yield declaration boundary");
	const yieldDeclaration = providerPrompt.slice(yieldStart, yieldEnd);
	if (pooled) {
		expect(yieldDeclaration).toContain("key: 1,");
		expect(yieldDeclaration).not.toContain("type?:");
	} else {
		expect(yieldDeclaration).toContain("type?:");
		expect(yieldDeclaration).not.toContain("key:");
	}
}

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

	for (const [dialect, toolSettings] of [
		["native", {}],
		["gemini", { "tools.format": "gemini" }],
	] as const) {
		it("keeps the provider yield contract synchronized through a pooled turn (" + dialect + ")", async () => {
			const { session } = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ ...toolSettings, inlineToolDescriptors: "on" }),
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
				outputSchema: {
					type: "object",
					properties: { "pool#1": {} },
					required: ["pool#1"],
					additionalProperties: false,
				},
				parentTaskPrefix: "workpool-worker",
				agentId: "workpool-worker",
				agentName: "scout",
				agentDisplayName: "scout",
				taskDepth: 1,
			});
			sessions.push(session);
			const tool = session.getToolByName("yield");
			if (!tool) throw new Error("Missing yield tool");
			expect(Reflect.get(tool.parameters, "properties")).toHaveProperty("type");
			expect(Reflect.get(tool.parameters, "properties")).not.toHaveProperty("key");
			await expectProviderYieldContract(session, dialect, false);

			await session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			expect(Reflect.get(tool.parameters, "required")).toEqual(["key"]);
			const properties = Reflect.get(tool.parameters, "properties");
			expect(properties).toHaveProperty("key");
			expect(properties).not.toHaveProperty("type");
			const activeTool = session.agent.state.tools.find(candidate => candidate.name === "yield");
			if (!activeTool) throw new Error("Missing active yield tool");
			expect(Reflect.get(activeTool.parameters, "required")).toEqual(["key"]);
			await expectProviderYieldContract(session, dialect, true);
			const result = await tool.execute("yield-pool-1", { key: 1, data: { answer: 42 } });
			expect(result.details).toMatchObject({ type: ["pool#1"], complete: true });

			await session.setWorkPoolYieldItems([]);
			const clearedProperties = Reflect.get(tool.parameters, "properties");
			expect(clearedProperties).toHaveProperty("type");
			expect(clearedProperties).not.toHaveProperty("key");
			await expectProviderYieldContract(session, dialect, false);
		});
		it("serializes concurrent yield contract transitions in call order (" + dialect + ")", async () => {
			const { session } = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ ...toolSettings, inlineToolDescriptors: "on" }),
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
				outputSchema: {
					type: "object",
					properties: { "pool#1": {} },
					required: ["pool#1"],
					additionalProperties: false,
				},
				parentTaskPrefix: "workpool-chain",
				agentId: "workpool-chain",
				agentName: "scout",
				agentDisplayName: "scout",
				taskDepth: 1,
			});
			sessions.push(session);
			// A pooled install racing a clear must settle in call order: the clear
			// runs after the install even though neither was awaited, so the wake
			// gate joined here observes the cleared ordinary contract.
			const install = session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			const clear = session.setWorkPoolYieldItems([]);
			await Promise.all([install, clear, session.whenWorkPoolYieldSettled()]);
			expect(session.getWorkPoolYieldItems()).toEqual([]);
			await expectProviderYieldContract(session, dialect, false);
		});
		it("rolls back the runtime contract when the prompt refresh fails (" + dialect + ")", async () => {
			const { session } = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ ...toolSettings, inlineToolDescriptors: "on" }),
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
				outputSchema: {
					type: "object",
					properties: { "pool#1": {} },
					required: ["pool#1"],
					additionalProperties: false,
				},
				parentTaskPrefix: "workpool-rollback",
				agentId: "workpool-rollback",
				agentName: "scout",
				agentDisplayName: "scout",
				taskDepth: 1,
			});
			sessions.push(session);
			// The runtime flips before the rebuild runs; a rebuild failure must
			// restore the last published set so gated readers never observe a
			// half-applied pair, while the failure still surfaces to the caller
			// and the serialization tail still settles.
			const refresh = vi.spyOn(session, "refreshBaseSystemPrompt");
			refresh.mockRejectedValueOnce(new Error("rebuild boom"));
			await expect(session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }])).rejects.toThrow("rebuild boom");
			expect(session.getWorkPoolYieldItems()).toEqual([]);
			await session.whenWorkPoolYieldSettled();
			await expectProviderYieldContract(session, dialect, false);
			await session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			await expectProviderYieldContract(session, dialect, true);
		});
		it("restores the last published contract when overlapping transitions both fail (" + dialect + ")", async () => {
			const { session } = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ ...toolSettings, inlineToolDescriptors: "on" }),
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
				outputSchema: {
					type: "object",
					properties: { "pool#1": {} },
					required: ["pool#1"],
					additionalProperties: false,
				},
				parentTaskPrefix: "workpool-double-fail",
				agentId: "workpool-double-fail",
				agentName: "scout",
				agentDisplayName: "scout",
				taskDepth: 1,
			});
			sessions.push(session);
			// Both rebuilds reject: the clear's rollback must restore the last
			// published (ordinary) contract, not the install's requested set
			// whose caller already saw a rejection. A rejected pooled contract
			// must never become active again.
			const refresh = vi.spyOn(session, "refreshBaseSystemPrompt");
			refresh.mockRejectedValueOnce(new Error("first boom"));
			refresh.mockRejectedValueOnce(new Error("second boom"));
			const install = session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			const clear = session.setWorkPoolYieldItems([]);
			await expect(install).rejects.toThrow("first boom");
			await expect(clear).rejects.toThrow("second boom");
			await session.whenWorkPoolYieldSettled();
			expect(session.getWorkPoolYieldItems()).toEqual([]);
			await expectProviderYieldContract(session, dialect, false);
		});
		it("converges an overlapping install and failing clear to the cleared contract (" + dialect + ")", async () => {
			const { session } = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ ...toolSettings, inlineToolDescriptors: "on" }),
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
				outputSchema: {
					type: "object",
					properties: { "pool#1": {} },
					required: ["pool#1"],
					additionalProperties: false,
				},
				parentTaskPrefix: "workpool-republish",
				agentId: "workpool-republish",
				agentName: "scout",
				agentDisplayName: "scout",
				taskDepth: 1,
			});
			sessions.push(session);
			// Overlapping install then clear: the successful refresh publishes
			// the newer (cleared) live set, so when the clear's refresh rejects,
			// rolling back to the last published contract keeps runtime and
			// provider on ordinary instead of resurrecting the rejected install.
			const refresh = vi.spyOn(session, "refreshBaseSystemPrompt");
			refresh.mockResolvedValueOnce(undefined);
			refresh.mockRejectedValueOnce(new Error("rebuild boom"));
			const install = session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			const clear = session.setWorkPoolYieldItems([]);
			await install;
			await expect(clear).rejects.toThrow("rebuild boom");
			await session.whenWorkPoolYieldSettled();
			expect(session.getWorkPoolYieldItems()).toEqual([]);
			await expectProviderYieldContract(session, dialect, false);
			await session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			await expectProviderYieldContract(session, dialect, true);
		});
		it("re-renders the pooled instructions from the live yield contract (" + dialect + ")", async () => {
			// The base-prompt rebuild must re-render the real subagent completion
			// block against the live item set on every transition: install shows the
			// keyed workpool protocol, clearing restores the ordinary one. Markers
			// below are the template's own contract branches, also covered by the
			// static render test in task/workpool.test.ts.
			// oxlint-disable-next-line prefer-const -- captured by the prompt closure before assignment
			let live: AgentSession | undefined;
			const { session } = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ ...toolSettings, inlineToolDescriptors: "on" }),
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
				outputSchema: {
					type: "object",
					properties: { "pool#1": {} },
					required: ["pool#1"],
					additionalProperties: false,
				},
				systemPrompt: base => [
					...base,
					prompt.render(subagentSystemPromptTemplate, {
						agent: "Worker",
						context: "",
						planReference: "",
						planReferencePath: "",
						worktree: "",
						outputSchema: undefined,
						outputSchemaOverridesAgent: false,
						workPoolYieldItems: live?.getWorkPoolYieldItems() ?? [],
						ircPeers: [],
						ircParkedCount: 0,
						ircOmittedCount: 0,
						ircSelfId: "",
					}),
				],
				parentTaskPrefix: "workpool-prompt-sync",
				agentId: "workpool-prompt-sync",
				agentName: "scout",
				agentDisplayName: "scout",
				taskDepth: 1,
			});
			sessions.push(session);
			live = session;
			const promptText = () => session.agent.state.systemPrompt.join("\n");
			await session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			expect(promptText()).toContain("{ key: <1-based number>, data: <outcome> }");
			expect(promptText()).not.toContain("Yield protocol:");
			await session.setWorkPoolYieldItems([]);
			expect(promptText()).toContain("Yield protocol:");
			expect(promptText()).not.toContain("{ key: <1-based number>, data: <outcome> }");
		});
	}
});
