import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageBudget from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import type { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

const CODEWORD = "The codeword is PLUM-7731.";
const sessions: AgentSession[] = [];

function blocks(message: Message): { type: string; text?: string }[] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

/**
 * A real parent session spawns a flagged task child; the child's first provider request is
 * captured after the whole `createTransformProviderContext` chain, so the executor's injected
 * turn, the transform wiring, and its order against inline snapcompact are all exercised.
 */
async function firstChildRequest(directory: TempDir, systemPrompt: "none" | "all"): Promise<Context> {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
	const authStorage = await AuthStorage.create(directory.join("auth.db"));
	authStorage.keys.setRuntime("openai", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, directory.join("models.yml"));
	const model = modelRegistry.find("openai", "gpt-5.4");
	if (!model?.input.includes("image")) throw new Error("Fixture needs an image-capable openai/gpt-5.4");
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [
			{
				name: "task",
				description: "Work",
				// Token-dense enough to clear snapcompact's savings gate, so `systemPrompt: "all"` draws system frames.
				systemPrompt: Array.from(
					{ length: 400 },
					(_, i) => `Pinned build ${(i * 2_654_435_761).toString(16)}${(i * 40_503).toString(16)} stays exact.`,
				).join("\n"),
				source: "bundled",
			},
		],
		projectAgentsDir: null,
	});
	const chatMock = createMockModel({ handler: { content: [{ type: "text", text: "Noted." }] } });
	const taskMock = createMockModel({
		handler: { content: [{ type: "toolCall", name: "yield", arguments: { data: { done: true } } }] },
	});
	let inTask = false;
	const childRequests: Context[] = [];
	const realSettingsStream = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slowMode) =>
		realSettingsStream(
			settings,
			async (streamModel, context, options) => {
				if (inTask) childRequests.push(context);
				return (inTask ? taskMock : chatMock).stream(streamModel, context, options);
			},
			slowMode,
		),
	);
	const realCreateSession = sdk.createAgentSession;
	vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
		const created = await realCreateSession(options);
		sessions.push(created.session);
		return created;
	});
	const { session: parent } = await sdk.createAgentSession({
		cwd: directory.path(),
		agentDir: directory.path(),
		authStorage,
		modelRegistry,
		model,
		sessionManager: SessionManager.create(directory.path(), directory.join("parent")),
		settings: Settings.isolated({
			"async.enabled": false,
			"task.structured": true,
			"task.inheritContext": true,
			"snapcompact.systemPrompt": systemPrompt,
			"marketplace.autoUpdate": "off",
			"compaction.enabled": false,
		}),
		toolNames: ["task"],
		spawns: "*",
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
	});
	await parent.prompt(CODEWORD);
	const tool = parent.getToolByName("task") as TaskTool;
	inTask = true;
	try {
		const result = await tool.execute("tc-inherit", {
			context: "Shared background.",
			tasks: [
				{
					agent: "task",
					name: "Worker",
					task: "Report the codeword.",
					solutionSpace: "one fix: report given",
					inheritContext: true,
				},
			],
		} as TaskParams);
		expect(result.details?.results[0]?.exitCode, JSON.stringify(result)).toBe(0);
	} finally {
		inTask = false;
	}
	expect(childRequests.length).toBeGreaterThan(0);
	return childRequests[0]!;
}

describe("inherited context through a real child session", () => {
	afterEach(async () => {
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it.each(["none", "all"] as const)(
		"reaches a vision child as frames in an agent-attributed user turn (snapcompact.systemPrompt=%s)",
		async systemPrompt => {
			using directory = TempDir.createSync("@omp-task-inherit-");
			const context = await firstChildRequest(directory, systemPrompt);
			const turn = context.messages.find(message => message.role === "user" && message.inheritedContext === true);
			expect(turn).toMatchObject({ role: "user", attribution: "agent" });
			const content = blocks(turn!);
			expect(content.some(block => block.type === "image")).toBe(true);
			// The tail travels as frames: its text is not sent, only the identifier sidecar.
			expect(content.some(block => block.type === "text" && block.text?.includes(CODEWORD))).toBe(false);
			expect(content.some(block => block.type === "text" && block.text?.includes("`7731`"))).toBe(true);
		},
		60_000,
	);

	it("falls back to the text tail when the inline-image byte clamp drops its frames", async () => {
		using directory = TempDir.createSync("@omp-task-inherit-");
		// What a host whose byte budget holds no frame does: the oldest-first clamp leaves the turn's text only.
		const clamp = vi.spyOn(imageBudget, "clampProviderContextImageBytes").mockImplementation(context => ({
			...context,
			messages: context.messages.map(message =>
				message.role === "user" && message.inheritedContext === true && Array.isArray(message.content)
					? { ...message, content: message.content.filter(block => block.type !== "image") }
					: message,
			),
		}));
		const context = await firstChildRequest(directory, "none");
		// The text restored over the evicted frames is measured against the byte budget again before the send.
		const restoredPass = clamp.mock.calls.find(([measured]) =>
			measured.messages.some(
				message =>
					message.role === "user" &&
					message.inheritedContext === true &&
					blocks(message).some(block => block.type === "text" && block.text?.includes(CODEWORD)),
			),
		);
		expect(restoredPass).toBeDefined();
		const turn = context.messages.find(message => message.role === "user" && message.inheritedContext === true);
		const content = blocks(turn!);
		expect(content.every(block => block.type === "text")).toBe(true);
		expect(content.some(block => block.text?.includes(CODEWORD))).toBe(true);
	}, 60_000);
});
