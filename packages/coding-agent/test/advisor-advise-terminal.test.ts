/**
 * Contract: a review turn whose only tool calls are `advise` is finished. The
 * advisor must not be re-invoked over the whole prefix just to say "done". A
 * turn that advises AND keeps investigating is untouched — the loop continues
 * normally.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const ADVISE_CALL = {
	type: "toolCall",
	name: "advise",
	arguments: { note: "Check the null path before the retry.", severity: "concern" },
} as const;

describe("advisor advise-only turn terminates the review", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-advise-terminal-");
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

	function createAdvisor(advisorResponses: MockResponse[]) {
		const primaryMock = createMockModel({ provider: "anthropic", responses: [{ content: ["primary complete"] }] });
		const advisorMock = createMockModel({ provider: "anthropic", responses: advisorResponses });
		let readCalls = 0;
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock read tool",
			parameters: type({ "path?": "string" }),
			execute: async () => {
				readCalls++;
				return { content: [{ type: "text", text: "file contents" }], details: {} };
			},
		};
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			advisorTools: [readTool],
			advisorStreamFn: advisorMock.stream,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		return { session, advisor, advisorMock, readCalls: () => readCalls };
	}

	function advisorCards(live: AgentSession): string[] {
		const cards: string[] = [];
		for (const message of live.agent.state.messages) {
			if (message.role !== "custom" || message.customType !== "advisor") continue;
			if (typeof message.content === "string") cards.push(message.content);
		}
		return cards;
	}

	it("stops after a turn whose only tool call is advise, keeping the delivered note", async () => {
		const { session: live, advisor, advisorMock } = createAdvisor([{ content: [ADVISE_CALL] }]);

		await live.prompt("review the current update");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);

		// One request: the ack turn that used to follow every advise is gone.
		expect(advisorMock.calls).toHaveLength(1);
		expect(advisor.state.error).toBeUndefined();
		// The stop is graceful: the advise tool result is persisted in the
		// advisor's own transcript, so the next review resumes from a paired tail.
		const tail = advisor.state.messages.at(-1);
		expect(tail?.role).toBe("toolResult");
		expect(tail && "toolName" in tail ? tail.toolName : undefined).toBe("advise");
		expect(advisorCards(live).join("\n")).toContain("Check the null path before the retry.");
	});

	it("keeps investigating when advise shares the turn with another tool call", async () => {
		const {
			session: live,
			advisor,
			advisorMock,
			readCalls,
		} = createAdvisor([
			{
				content: [ADVISE_CALL, { type: "toolCall", name: "read", arguments: { path: "src/retry.ts" } }],
			},
			{ content: ["Confirmed after reading."], stopReason: "stop" },
		]);

		await live.prompt("review the current update");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);

		expect(readCalls()).toBe(1);
		expect(advisorMock.calls).toHaveLength(2);
		expect(advisor.state.error).toBeUndefined();
		expect(advisorCards(live).join("\n")).toContain("Check the null path before the retry.");
	});

	it("delivers every note when one turn emits several advise calls before stopping", async () => {
		const {
			session: live,
			advisor,
			advisorMock,
		} = createAdvisor([
			{
				content: [
					ADVISE_CALL,
					{
						type: "toolCall",
						name: "advise",
						arguments: { note: "The retry budget is never decremented.", severity: "concern" },
					},
				],
			},
		]);

		await live.prompt("review the current update");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);

		expect(advisorMock.calls).toHaveLength(1);
		expect(advisor.state.error).toBeUndefined();
		// Neither advise call may be turned into a skipped placeholder by the
		// stop: both tool results are real and both notes reach the primary.
		const adviseResults = advisor.state.messages.filter(
			message => message.role === "toolResult" && message.toolName === "advise",
		);
		expect(adviseResults).toHaveLength(2);
		expect(adviseResults.every(result => result.role === "toolResult" && !result.isError)).toBe(true);
		const cards = advisorCards(live).join("\n");
		expect(cards).toContain("Check the null path before the retry.");
		expect(cards).toContain("The retry budget is never decremented.");
	});
});
