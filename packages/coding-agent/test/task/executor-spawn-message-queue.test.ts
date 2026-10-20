import { afterEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];
const tempDirs: TempDir[] = [];
const createAgentSession = sdkModule.createAgentSession;

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const auth of authStorages.splice(0)) await auth.close();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	for (const dir of tempDirs.splice(0)) dir.removeSync();
});

function writer(cwd: string): WriteTool {
	return new WriteTool({
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		agentRegistry: AgentRegistry.global(),
	} satisfies ToolSession);
}

function text(message: AgentMessage): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap(part => (part.type === "text" && "text" in part ? [part.text] : [])).join("\n");
}

it("agent:// write at 0 ms after child creation queues behind the real task brief", async () => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	const dir = TempDir.createSync("@pi-spawn-message-queue-");
	tempDirs.push(dir);
	const auth = createInMemoryAuthStorage();
	authStorages.push(auth);
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing fixture model");
	const modelRegistry = new ModelRegistry(auth, dir.join("models.yml"));
	vi.spyOn(modelRegistry, "refresh").mockResolvedValue(undefined);
	const observed: string[][] = [];
	const tool = writer(dir.path());
	AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session: null });
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		const created = await createAgentSession({
			...options,
			agentDir: dir.path(),
			model,
			authStorage: auth,
			modelRegistry,
			disableExtensionDiscovery: true,
		});
		sessions.push(created.session);
		const releaseWake = Promise.withResolvers<void>();
		const prompt = created.session.prompt.bind(created.session);
		vi.spyOn(created.session, "prompt").mockImplementation(async (...args) => {
			try {
				return await prompt(...args);
			} finally {
				releaseWake.resolve();
			}
		});
		created.session.agent.streamFn = (_model, context) => {
			observed.push(context.messages.map(text));
			const response = createAssistantMessage("brief completed");
			if (observed.length > 1) {
				response.content = [
					{ type: "toolCall", id: `yield-${observed.length}`, name: "yield", arguments: { data: { done: true } } },
				];
				response.stopReason = "toolUse";
			}
			const stream = new AssistantMessageEventStream();
			// A wake on the old head stays busy until the executor's brief
			// dispatch settles. The fixed brief needs no artificial delay.
			const ready = context.messages.some(message => text(message).includes("Spawn original brief"))
				? Promise.resolve()
				: releaseWake.promise;
			void ready.then(() => {
				stream.push({ type: "start", partial: response });
				stream.push({
					type: "done",
					reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
					message: response,
				});
			});
			return stream;
		};
		const receipt = await tool.execute("immediate-message", {
			path: "agent://SpawnChild",
			content: "Spawn later message",
		});
		expect(receipt.isError).not.toBe(true);
		return created;
	});
	const result = await runSubprocess({
		cwd: dir.path(),
		agent: {
			name: "task",
			description: "Spawn",
			systemPrompt: "Follow the brief and yield.",
			source: "bundled",
			tools: ["yield"],
		},
		task: "Spawn original brief",
		id: "SpawnChild",
		parentAgentId: "Main",
		index: 0,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry,
		enableLsp: false,
		enableMCP: false,
		artifactsDir: path.join(dir.path(), "artifacts"),
		keepAlive: false,
	});
	expect(result.exitCode, result.stderr).toBe(0);
	expect(observed[0]?.join("\n")).toContain("Spawn original brief");
	expect(observed[0]?.join("\n")).not.toContain("Spawn later message");
	expect(observed.slice(1).some(turn => turn.join("\n").includes("Spawn later message"))).toBe(true);
}, 20_000);

it("negative control: unknown agent:// still returns an error", async () => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const result = await writer("/tmp").execute("unknown", { path: "agent://SpawnUnknown", content: "must not queue" });
	expect(result.isError).toBe(true);
	expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Unknown agent") }]);
});
