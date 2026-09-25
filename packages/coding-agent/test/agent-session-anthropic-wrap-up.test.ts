import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { anthropicSlowModeLanes } from "@oh-my-pi/pi-coding-agent/session/anthropic-slow-mode";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const LANE = "cred:wrap-up-session-test";
const WRAP_UP_MARKER = "wrap-up allowance";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession Anthropic wrap-up hint", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-wrap-up-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		anthropicSlowModeLanes.lane(LANE).reset();
		authStorage.close();
		tempDir.removeSync();
	});

	/** Two tool turns then a stop, on a Claude account already running on the wrap-up allowance. */
	async function run(slowMode: "off" | "auto"): Promise<string[]> {
		const model = createMockModel({ provider: "anthropic", id: "claude-test" }).model;
		const tool: AgentTool = {
			name: "step",
			label: "Step",
			description: "One unit of work",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "STEP_DONE" }] }),
		};
		const contexts: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				const call = contexts.push(JSON.stringify(context.messages));
				const toolTurn = call <= 2;
				const message: AssistantMessage = {
					role: "assistant",
					content: toolTurn
						? [{ type: "toolCall", id: `tc-${call}`, name: "step", arguments: {} }]
						: [{ type: "text", text: "Done." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: toolTurn ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"providers.anthropic.slowMode": slowMode,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([[tool.name, tool]]),
		});
		const nowSec = Math.floor(Date.now() / 1000);
		anthropicSlowModeLanes.hooks({}).observe(
			{
				graceUtilization: { fiveHour: 0.3, sevenDay: 0 },
				fiveHourResetAtSec: nowSec + 3_600,
				weeklyResetAtSec: nowSec + 400_000,
				unifiedLimitClaim: false,
				overageInUse: false,
			},
			LANE,
		);
		session.noteAnthropicSlowModeLane(LANE);
		await session.prompt("go");
		await session.waitForIdle();
		return contexts;
	}

	const wrapUpCount = (messages: string | undefined) => (messages ?? "").split(WRAP_UP_MARKER).length - 1;

	it("tells the model to wrap up once, mid-run, when nothing continues past the allowance", async () => {
		const contexts = await run("off");
		expect(contexts).toHaveLength(3);
		expect(wrapUpCount(contexts[0])).toBe(0);
		expect(wrapUpCount(contexts[1])).toBe(1);
		expect(wrapUpCount(contexts[2])).toBe(1);
		expect(session?.getAnthropicSlowModeLabel()).toStartWith("limit reached · wrapping up");
	});

	it("keeps working without the hint when /slow on lets low priority pick up", async () => {
		const contexts = await run("auto");
		expect(contexts).toHaveLength(3);
		for (const context of contexts) expect(wrapUpCount(context)).toBe(0);
	});
});
