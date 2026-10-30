/**
 * Contract: an advisor re-sends its own investigation output on every later
 * request. Before each review, maintenance evicts oversized `read`/`grep`/
 * `glob` results from reviews older than the latest one, while the deltas it
 * reviewed stay verbatim. `advisor.evictStaleResults: false` turns it off.
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

const FILE_CONTENTS = "export const retryBudget = 3; // advisor investigation payload\n".repeat(32);
const READ_CALL = { type: "toolCall", name: "read", arguments: { path: "src/retry.ts" } } as const;

describe("advisor stale tool-result eviction", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-tool-result-eviction-");
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

	function createAdvisor(advisorResponses: MockResponse[], primaryTurns: number, evictStaleResults = true) {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: Array.from({ length: primaryTurns }, () => ({ content: ["primary complete"] })),
		});
		const advisorMock = createMockModel({ provider: "anthropic", responses: advisorResponses });
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock read tool",
			parameters: type({ "path?": "string" }),
			execute: async () => ({ content: [{ type: "text", text: FILE_CONTENTS }], details: {} }),
		};
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"advisor.evictStaleResults": evictStaleResults,
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
		return { session, advisor, advisorMock };
	}

	function toolResultTexts(messages: readonly { role: string; content?: unknown }[]): string[] {
		const texts: string[] = [];
		for (const message of messages) {
			if (message.role !== "toolResult") continue;
			const content = message.content;
			if (typeof content === "string") texts.push(content);
			else if (Array.isArray(content)) {
				for (const block of content) {
					if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
						texts.push((block as { text: string }).text);
					}
				}
			}
		}
		return texts;
	}

	async function runThreeReviews(evictStaleResults: boolean) {
		const {
			session: live,
			advisor,
			advisorMock,
		} = createAdvisor(
			[
				{ content: [READ_CALL] },
				{ content: ["Reviewed the retry path."] },
				{ content: ["Nothing new."] },
				{ content: ["Still nothing."] },
			],
			3,
			evictStaleResults,
		);

		await live.prompt("first update: change the retry budget");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);
		await live.prompt("second update: adjust the backoff");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);
		await live.prompt("third update: log the retry");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);

		expect(advisorMock.calls).toHaveLength(4);
		expect(advisor.state.error).toBeUndefined();
		return advisorMock.calls;
	}

	it("keeps the latest review's file contents and stubs them one review later", async () => {
		const calls = await runThreeReviews(true);

		// Review 2 follows the review that read the file, so it keeps the contents.
		expect(toolResultTexts(calls[2].context.messages)).toContain(FILE_CONTENTS);
		// Review 3 no longer pays for review 1's read.
		const thirdReview = calls[3].context.messages;
		const results = toolResultTexts(thirdReview);
		expect(results.some(text => text.startsWith("[Stale result elided - "))).toBe(true);
		expect(results).not.toContain(FILE_CONTENTS);
		// The work under review is never touched, only the advisor's own output.
		expect(JSON.stringify(thirdReview)).toContain("first update: change the retry budget");
	});

	it("leaves every result in place when advisor.evictStaleResults is off", async () => {
		const calls = await runThreeReviews(false);

		expect(toolResultTexts(calls[3].context.messages)).toContain(FILE_CONTENTS);
	});
});
