import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import * as jsContextManager from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage: AuthStorage = createInMemoryAuthStorage();
for (const provider of ["anthropic", "mock"]) authStorage.keys.setRuntime(provider, "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
});

afterEach(async () => {
	await jsContextManager.disposeAllVmContexts();
	await disposeAllKernelSessions();
});

function ruleFor(kind: "regex" | "ast", interruptMode: "always" | "never"): Rule {
	return {
		name: kind === "regex" ? "no-forbidden-token" : "no-console-log",
		path: `${kind}-bridge.md`,
		content: kind === "regex" ? "Do not write FORBIDDEN_TOKEN." : "Do not add console.log calls.",
		interruptMode,
		description: "eval bridge regression rule",
		...(kind === "regex" ? { condition: ["FORBIDDEN_TOKEN"] } : { astCondition: ["console.log($$$)"] }),
		scope: ["tool:write(*.ts)"],
		_source: { provider: "test", providerName: "test", path: `${kind}-bridge.md`, level: "project" },
	};
}

describe("TTSR eval bridge enforcement", () => {
	it.each([
		["regex", "always", true],
		["ast", "always", true],
		["regex", "never", false],
		["ast", "never", false],
	] as const)("%s %s rule on a write issued inside eval", async (kind, interruptMode, blocks) => {
		using tempDir = TempDir.createSync(`@pi-ttsr-${kind}-bridge-`);
		const target = `${tempDir.path()}/probe.ts`;
		const content = kind === "regex" ? "FORBIDDEN_TOKEN\n" : 'console.log("FORBIDDEN_TOKEN");\n';
		const manager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"eval.autoBackground.enabled": false,
			"tools.approvalMode": "yolo",
		});
		const extensionRunner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			manager,
			modelRegistry,
			undefined,
			settings,
		);
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "eval",
							arguments: {
								language: "js",
								code: `await tool.write(${JSON.stringify({ path: target, content })})`,
							},
						},
					],
				},
				{ content: ["Done"] },
			],
		});

		const sessionRef: { current?: AgentSession } = {};
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			settings,
			getActiveModel: () => mock.model,
			getEvalSessionId: () => `ttsr-${kind}-bridge`,
			getEvalKernelOwnerId: () => `ttsr-${kind}-bridge`,
			getEvalBridgeToolNames: () => sessionRef.current?.getEvalBridgeToolNames() ?? [],
			getToolForEvalBridge: name => sessionRef.current?.getToolForEvalBridge(name),
			getToolContext: () => ({ settings, autoApprove: true }) as never,
		};
		const writeTool = new WriteTool(toolSession);
		const evalTool = new EvalTool(toolSession);
		const wrappedWrite = new ExtensionToolWrapper(writeTool as unknown as AgentTool, extensionRunner) as AgentTool;
		const wrappedEval = new ExtensionToolWrapper(evalTool as unknown as AgentTool, extensionRunner) as AgentTool;
		const tools = [wrappedEval, wrappedWrite];
		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "keep",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		const rule = ruleFor(kind, interruptMode);
		expect(ttsrManager.addRule(rule)).toBe(true);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools },
			streamFn: mock.stream,
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			extensionRunner,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			ttsrManager,
			autoApprove: true,
		});
		sessionRef.current = session;

		await session.prompt("Use eval to write the source file.");
		await session.waitForIdle();

		expect(await Bun.file(target).exists()).toBe(!blocks);
		const transcript = JSON.stringify(agent.state.messages);
		expect(transcript).toContain(rule.name);
		expect(transcript).toContain(rule.content);
		const injectedRules = manager
			.getEntries()
			.filter(entry => entry.type === "ttsr_injection")
			.flatMap(entry => entry.injectedRules);
		expect(injectedRules).toEqual([rule.name]);
		await session.dispose();
	});
});
