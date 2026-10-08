import { afterAll, describe, expect, it } from "bun:test";
import {
	Agent,
	type AgentTool,
	type AgentToolContext,
	TOOL_RESULT_ADDITIONAL_CONTEXT,
	type ToolResultWithAdditionalContext,
} from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage: AuthStorage = createInMemoryAuthStorage();
for (const provider of ["anthropic", "mock"]) authStorage.keys.setRuntime(provider, "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
});

const RULE: Rule = {
	name: "no-forbidden-token",
	path: "bridged-passive.md",
	content: "Do not write FORBIDDEN_TOKEN.",
	interruptMode: "never",
	description: "bridged passive-context regression rule",
	condition: ["FORBIDDEN_TOKEN"],
	scope: ["tool:write(*.ts)"],
	_source: { provider: "test", providerName: "test", path: "bridged-passive.md", level: "project" },
};

/**
 * A real session whose TTSR coordinator is wired into the extension runner's
 * bridged-call preflight, with a real `write` tool behind the real wrapper.
 * Only the model is stubbed; nothing here calls a provider.
 */
async function createBridgedHarness(dir: string) {
	const manager = SessionManager.inMemory(dir);
	const settings = Settings.isolated({ "compaction.enabled": false, "tools.approvalMode": "yolo" });
	const extensionRunner = new ExtensionRunner(
		[],
		new ExtensionRuntime(),
		dir,
		manager,
		modelRegistry,
		undefined,
		settings,
	);
	const mock = createMockModel({ responses: [] });
	const toolSession: ToolSession = {
		cwd: dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => manager.getSessionId(),
		getSessionSpawns: () => "*",
		sessionManager: manager,
		settings,
		getActiveModel: () => mock.model,
	};
	const wrappedWrite = new ExtensionToolWrapper(
		new WriteTool(toolSession) as unknown as AgentTool,
		extensionRunner,
	) as AgentTool;
	const ttsrManager = new TtsrManager({
		enabled: true,
		contextMode: "keep",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
	});
	expect(ttsrManager.addRule(RULE)).toBe(true);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [wrappedWrite] },
		streamFn: mock.stream,
		convertToLlm,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry,
		extensionRunner,
		toolRegistry: new Map([[wrappedWrite.name, wrappedWrite]]),
		ttsrManager,
		autoApprove: true,
	});
	const injectedRules = () =>
		manager
			.getEntries()
			.filter(entry => entry.type === "ttsr_injection")
			.flatMap(entry => entry.injectedRules);
	return { session, settings, wrappedWrite, injectedRules };
}

const texts = (content: ReadonlyArray<{ type: string; text?: string }>): string[] =>
	content.flatMap(block => (block.type === "text" && block.text !== undefined ? [block.text] : []));

describe("TTSR reminders on bridged tool calls", () => {
	it("delivers through the call's passive-context sink and leaves the result unmodified", async () => {
		using dir = TempDir.createSync("@pi-ttsr-bridged-sink-");
		const { session, settings, wrappedWrite, injectedRules } = await createBridgedHarness(dir.path());
		const sink: string[] = [];
		const context = {
			settings,
			autoApprove: true,
			addAdditionalContext: (value: string) => sink.push(value),
		} as unknown as AgentToolContext;
		const target = `${dir.path()}/probe.ts`;

		const result = await wrappedWrite.execute(
			"bridged-sink",
			{ path: target, content: "FORBIDDEN_TOKEN\n" },
			undefined,
			undefined,
			context,
		);

		expect(await Bun.file(target).exists()).toBe(true);
		expect(texts(result.content).join("\n")).not.toContain("system-reminder");
		expect(texts(result.content).join("\n")).not.toContain(RULE.content);
		expect(sink).toHaveLength(1);
		expect(sink[0]).toContain(`<system-reminder reason="rule_violation" rule="${RULE.name}"`);
		expect(sink[0]).toContain(RULE.content);
		expect(injectedRules()).toEqual([RULE.name]);
		await session.dispose();
	});

	it("folds the reminder into the result as a leading block when the call has no sink", async () => {
		using dir = TempDir.createSync("@pi-ttsr-bridged-fold-");
		const { session, settings, wrappedWrite, injectedRules } = await createBridgedHarness(dir.path());
		const context = { settings, autoApprove: true } as unknown as AgentToolContext;
		const control = await wrappedWrite.execute(
			"bridged-control",
			{ path: `${dir.path()}/control.ts`, content: "fine\n" },
			undefined,
			undefined,
			context,
		);

		const result = await wrappedWrite.execute(
			"bridged-fold",
			{ path: `${dir.path()}/probe.ts`, content: "FORBIDDEN_TOKEN\n" },
			undefined,
			undefined,
			context,
		);

		const [leading, ...rest] = texts(result.content);
		expect(leading).toContain(`<system-reminder reason="rule_violation" rule="${RULE.name}"`);
		expect(leading).toContain(RULE.content);
		expect(rest).toHaveLength(control.content.length);
		expect(rest.join("\n")).not.toContain("system-reminder");
		expect(injectedRules()).toEqual([RULE.name]);
		await session.dispose();
	});

	it("reaches a Cursor exec write as passive context, not tool output", async () => {
		using dir = TempDir.createSync("@pi-ttsr-bridged-cursor-");
		const { session, settings, wrappedWrite, injectedRules } = await createBridgedHarness(dir.path());
		const handlers = new CursorExecHandlers({
			cwd: dir.path(),
			tools: new Map<string, Tool>([["write", wrappedWrite as unknown as Tool]]),
			getToolContext: () => ({ settings, autoApprove: true }) as unknown as AgentToolContext,
		});
		const target = `${dir.path()}/probe.ts`;

		const message = (await handlers.piWrite({
			toolCallId: "cursor-write",
			args: { path: target, content: "FORBIDDEN_TOKEN\n" },
		} as never)) as ToolResultWithAdditionalContext;

		expect(message.isError).toBe(false);
		expect(await Bun.file(target).exists()).toBe(true);
		expect(JSON.stringify(message.content)).not.toContain("system-reminder");
		const carried = message[TOOL_RESULT_ADDITIONAL_CONTEXT];
		expect(carried).toContain(`<system-reminder reason="rule_violation" rule="${RULE.name}"`);
		expect(carried).toContain(RULE.content);
		expect(injectedRules()).toEqual([RULE.name]);
		await session.dispose();
	});
});
