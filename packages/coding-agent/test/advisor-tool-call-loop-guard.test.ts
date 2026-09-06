import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, type AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AdvisorLoopGuard } from "../src/advisor/loop-guard";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

/** Advisor-visible tool that fails the same way on every call. */
const failingReadTool: AgentTool = {
	name: "read",
	label: "Read",
	description: "Mock read tool",
	parameters: type({ "path?": "string" }),
	execute: async () => ({
		content: [{ type: "text" as const, text: "ENOENT: no such file or directory" }],
		isError: true,
	}),
};

describe("advisor tool-call loop guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-tool-call-loop-guard-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	/**
	 * Live advisor agent built through the real `SessionAdvisors` path, driven by
	 * a stream that repeats one identical failing tool call forever.
	 */
	function createAdvisor(
		guardSettings: Record<string, unknown>,
		maxRepeatedTurns = 8,
	): { advisor: Agent; contexts: Context[] } {
		const primaryMock = createMockModel({ provider: "anthropic", responses: [{ content: ["primary complete"] }] });
		const advisorMock = createMockModel({ provider: "anthropic" });
		const contexts: Context[] = [];
		let turn = 0;
		const advisorStreamFn: typeof advisorMock.stream = (_model, context) => {
			contexts.push(context);
			// Deliberately ignore the corrective. The enabled guard must hard-stop
			// this stream; the finite ceiling keeps the disabled control bounded.
			const repeating = turn < maxRepeatedTurns;
			turn++;
			const message: AssistantMessage = repeating
				? {
						role: "assistant",
						content: [{ type: "toolCall", id: `tc-${turn}`, name: "read", arguments: { path: "missing.ts" } }],
						api: advisorMock.api,
						provider: advisorMock.provider,
						model: advisorMock.id,
						usage: zeroUsage,
						stopReason: "toolUse",
						timestamp: Date.now(),
					}
				: {
						role: "assistant",
						content: [{ type: "text", text: "Stopped repeating." }],
						api: advisorMock.api,
						provider: advisorMock.provider,
						model: advisorMock.id,
						usage: zeroUsage,
						stopReason: "stop",
						timestamp: Date.now(),
					};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: repeating ? "toolUse" : "stop", message });
			});
			return stream;
		};
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"todo.enabled": false,
			...guardSettings,
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: [failingReadTool],
			advisorStreamFn,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(advisorMock);
		return { advisor, contexts };
	}

	it("redirects the advisor's own repeated tool call and reaches its next request", async () => {
		const { advisor, contexts } = createAdvisor(
			{
				"model.toolCallLoopGuard.enabled": true,
				"model.toolCallLoopGuard.threshold": 3,
			},
			20,
		);

		if (!session) throw new Error("Expected live session");
		await session.prompt("review the current update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

		// First threshold injects one corrective; ignoring it re-arms the
		// detector, and the second threshold aborts. The agent loop observes the
		// abort after one already-scheduled request, bounding twenty repeats at 7.
		expect(contexts).toHaveLength(7);
		const delivered = JSON.stringify(contexts[3]!.messages);
		expect(delivered).toContain("You called `read` 3 consecutive times");
		expect(delivered).toContain("ENOENT: no such file or directory");
		const redirects = advisor.state.messages.filter(
			message => message.role === "user" && JSON.stringify(message.content).includes("tool_call_loop_detected"),
		);
		expect(redirects).toHaveLength(1);
		expect(advisor.state.messages.filter(message => message.role === "custom")).toHaveLength(0);
		expect(advisor.state.error).toBeUndefined();
	});

	it("starts repetition counting fresh after an advisor context reset", () => {
		const settings = Settings.isolated({
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 3,
		});
		const messages: AgentMessage[] = [];
		const guard = new AdvisorLoopGuard({
			settings,
			name: "test",
			liveMessages: () => messages,
			appendMessage: message => messages.push(message),
			abort: () => {},
		});
		const turn = (id: string): AgentTurnEndContext => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: { path: "missing.ts" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: "ENOENT" }],
				isError: true,
				timestamp: Date.now(),
			};
			return { message, toolResults: [result], willContinue: true };
		};

		guard.recordTurn(messages, turn("before-1"));
		guard.recordTurn(messages, turn("before-2"));
		guard.reset();
		guard.recordTurn(messages, turn("after-1"));
		guard.recordTurn(messages, turn("after-2"));
		expect(messages).toHaveLength(0);
		guard.recordTurn(messages, turn("after-3"));
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
	});

	it("leaves the advisor unbounded when the shared loop guard is disabled", async () => {
		const { advisor, contexts } = createAdvisor({ "model.toolCallLoopGuard.enabled": false });

		await advisor.prompt("review the current update");

		expect(contexts.some(context => JSON.stringify(context.messages).includes("tool_call_loop_detected"))).toBe(
			false,
		);
		// Nine requests: eight repeated tool-call turns plus the final stop.
		expect(contexts).toHaveLength(9);
	});
});
