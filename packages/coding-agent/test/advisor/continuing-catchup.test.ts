import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, fixedAdvisorTools } from "../helpers/agent-session-setup";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

/** Polls until `predicate` holds; false when `timeoutMs` passes first. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) return false;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	return true;
}

describe("advisor catch-up at continuing tool-loop turns", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-continuing-catchup-");
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

	/**
	 * Starts a run whose first step is a tool call. That tool batch ends a continuing
	 * boundary and schedules one advisor review, which stays open until `released` resolves.
	 */
	function startRunWithHeldReview(syncBacklog: string) {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [
				{ content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }] },
				{ content: ["primary complete"] },
			],
		});
		const advisorMock = createMockModel({ provider: "anthropic" });
		const released = Promise.withResolvers<void>();
		let reviewsStarted = 0;
		const advisorStreamFn: typeof advisorMock.stream = () => {
			reviewsStarted++;
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "looks fine" }],
				api: advisorMock.api,
				provider: advisorMock.provider,
				model: advisorMock.id,
				usage: zeroUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			void released.promise.then(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock read tool",
			parameters: type({ "path?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "file contents" }] }),
		};
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": syncBacklog,
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [readTool] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: fixedAdvisorTools(readTool),
			advisorStreamFn,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(advisorMock);
		return {
			primaryMock,
			released,
			reviewsStarted: () => reviewsStarted,
			prompting: session.prompt("review the change"),
		};
	}

	it("sends the primary's next step while the advisor review of a tool-loop turn is still running", async () => {
		// Failure a user sees: with advisor.syncBacklog set, the primary sits for up
		// to 30 seconds after a tool batch before its next model request, while the
		// review it waits for can only deliver non-blocker notes at the final turn.
		const run = startRunWithHeldReview("1");
		try {
			// The tool batch ends a continuing boundary that schedules a review.
			expect(await waitUntil(() => run.reviewsStarted() === 1, 2_000)).toBe(true);
			// The review stays held until the finally block releases it, so this
			// request going out proves the primary did not wait for it.
			expect(await waitUntil(() => run.primaryMock.calls.length >= 2, 2_000)).toBe(true);
		} finally {
			run.released.resolve();
			await run.prompting;
		}
	});

	it("keeps the primary's next step waiting for the advisor review of a tool-loop turn when advisor.syncBacklog is strict", async () => {
		// strict waits at every boundary, including a tool-loop turn, until its
		// scheduled review finishes: the next request must not go out while it is held.
		const run = startRunWithHeldReview("strict");
		try {
			expect(await waitUntil(() => run.reviewsStarted() === 1, 2_000)).toBe(true);
			expect(await waitUntil(() => run.primaryMock.calls.length >= 2, 2_000)).toBe(false);
			run.released.resolve();
			expect(await waitUntil(() => run.primaryMock.calls.length >= 2, 2_000)).toBe(true);
		} finally {
			run.released.resolve();
			await run.prompting;
		}
	});
});
