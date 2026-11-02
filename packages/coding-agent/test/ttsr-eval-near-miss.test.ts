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
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage: AuthStorage = createInMemoryAuthStorage();
for (const provider of ["anthropic", "mock"]) authStorage.keys.setRuntime(provider, "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => authStorage.close());
afterEach(async () => {
	await jsContextManager.disposeAllVmContexts();
	await disposeAllKernelSessions();
});

describe("TTSR eval near-miss controls", () => {
	it.each(["regex", "ast"] as const)("allows %s near-miss source through eval", async kind => {
		using tempDir = TempDir.createSync(`@pi-ttsr-${kind}-near-miss-`);
		const files = [
			{ path: `${tempDir.path()}/string.ts`, content: `const marker = "console.log(";\n` },
			{ path: `${tempDir.path()}/comment.ts`, content: "// console.log(\nexport const ok = true;\n" },
			{ path: `${tempDir.path()}/README.md`, content: "console.log(\n" },
			{ path: `${tempDir.path()}/real.ts`, content: 'console.log("bad");\n' },
		];
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
								code: files.map(file => `await tool.write(${JSON.stringify(file)})`).join(";\n"),
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
			getEvalSessionId: () => `ttsr-${kind}-near-miss`,
			getEvalKernelOwnerId: () => `ttsr-${kind}-near-miss`,
			getEvalBridgeToolNames: () => sessionRef.current?.getEvalBridgeToolNames() ?? [],
			getToolForEvalBridge: name => sessionRef.current?.getToolForEvalBridge(name),
			getToolContext: () => ({ settings, autoApprove: true }) as never,
		};
		const writeTool = new WriteTool(toolSession);
		const evalTool = new EvalTool(toolSession);
		const wrappedWrite = new ExtensionToolWrapper(writeTool as unknown as AgentTool, extensionRunner) as AgentTool;
		const wrappedEval = new ExtensionToolWrapper(evalTool as unknown as AgentTool, extensionRunner) as AgentTool;
		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "keep",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule({
			name: `near-miss-${kind}`,
			path: `near-miss-${kind}.md`,
			content: "Do not write the real call.",
			...(kind === "regex" ? { condition: ["^console\\.log\\("] } : { astCondition: ["console.log($$$)"] }),
			scope: ["tool:write(*.ts)"],
			_source: { provider: "test", providerName: "test", path: `near-miss-${kind}.md`, level: "project" },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [wrappedEval, wrappedWrite] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			extensionRunner: extensionRunner,
			toolRegistry: new Map([
				["eval", wrappedEval],
				["write", wrappedWrite],
			]),
			ttsrManager,
			autoApprove: true,
		});
		sessionRef.current = session;

		await session.prompt("Use eval to write near misses and a real call.");
		await session.waitForIdle();

		for (const file of files.slice(0, 3)) {
			expect(await Bun.file(file.path).exists()).toBe(true);
		}
		expect(await Bun.file(files[3].path).exists()).toBe(false);
		expect(JSON.stringify(agent.state.messages)).toContain(`near-miss-${kind}`);
		await session.dispose();
	});
});
