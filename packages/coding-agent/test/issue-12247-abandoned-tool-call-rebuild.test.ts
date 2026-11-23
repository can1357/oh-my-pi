import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Regression for issue #12247: a transcript rebuild while the viewed session
 * streams (switching between a subagent and main mid-turn) kept every tool call
 * without a result. An abandoned call from an earlier turn came back as an
 * active card, pinned transcript retirement, and pushed the whole history into
 * the one-row-per-block pressure layout. Only the running turn's calls may stay.
 */
describe("issue #12247 mid-turn transcript rebuild", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-issue-12247-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	function transcriptToolCallIds(live: AgentSession, keepInFlightToolCalls: boolean): string[] {
		const ids: string[] = [];
		for (const message of live.buildTranscriptSessionContext({ keepInFlightToolCalls }).messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall") ids.push(block.id);
			}
		}
		return ids;
	}

	function createSession() {
		const mock = createMockModel({
			provider: "anthropic",
			responses: [
				{ content: [{ type: "toolCall", id: "live", name: "probe", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const history: Message[] = [
			{ role: "user", content: [{ type: "text", text: "wait for the job" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "abandoned", name: "probe", arguments: {} }],
				api: mock.api,
				provider: mock.provider,
				model: mock.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
		];
		const sessionManager = SessionManager.inMemory(tempDir.path());
		for (const message of history) sessionManager.appendMessage(message);

		const duringRequest: string[][] = [];
		const duringTool: string[][] = [];
		const probe: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Rebuilds the transcript while its own call is executing",
			parameters: type({}),
			execute: async () => {
				if (!session) throw new Error("Expected a live session");
				duringTool.push(transcriptToolCallIds(session, true), transcriptToolCallIds(session, false));
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const live = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock, systemPrompt: [], tools: [probe], messages: history },
				streamFn: (model, context, options) => {
					if (session) duringRequest.push(transcriptToolCallIds(session, true));
					return mock.stream(model, context, options);
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			toolRegistry: new Map([[probe.name, probe]]),
		});
		session = live;
		return { live, duringRequest, duringTool };
	}

	it("keeps the in-flight call and strips an abandoned call from an earlier turn", async () => {
		const { live, duringRequest, duringTool } = createSession();

		await live.prompt("continue");

		expect(duringRequest[0]).toEqual([]);
		expect(duringTool).toEqual([["live"], []]);
	});

	it("strips the abandoned call while a turn started by a custom message awaits its first reply", async () => {
		const { live, duringRequest } = createSession();

		await live.promptCustomMessage({ customType: "issue-12247", content: "continue", display: true });

		expect(duringRequest[0]).toEqual([]);
	});

	it("keeps a resumed tail call live while it executes without a new assistant message", async () => {
		const { live, duringTool } = createSession();

		// Continuing from an assistant tail (as retry does after stripping a failed
		// tool batch) executes that turn's call without emitting a new message_end.
		await live.agent.continue();

		expect(duringTool[0]).toEqual(["abandoned"]);
	});
});
