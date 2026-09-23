import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const ADVISOR_HISTORY = "ADVISOR_REVIEW_HISTORY_SENTINEL";

describe("advisor.reviewOn through a live session", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-review-cadence-session-");
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

	function createSession() {
		const primary = createMockModel({ provider: "anthropic" });
		const advisor = createMockModel({ provider: "anthropic", handler: { content: [ADVISOR_HISTORY] } });
		const requests: Context[] = [];
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read a fixture",
			parameters: type({ path: "string" }),
			execute: async () => ({ content: [{ type: "text", text: "fixture contents" }], details: {} }),
		};
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		// Mutable settings must live in the layer Settings.set updates, not the
		// higher-priority overrides supplied to Settings.isolated.
		settings.set("advisor.reviewOn", "turn");
		const live = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primary, systemPrompt: [], tools: [readTool] },
				streamFn: primary.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			advisorTools: [],
			advisorStreamFn: (model, context, options) => {
				requests.push({ systemPrompt: context.systemPrompt?.slice(), messages: structuredClone(context.messages) });
				return advisor.stream(model, context, options);
			},
		});
		session = live;
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(live.setAdvisorEnabled(true)).toBe(true);

		async function runTurn(marker: string, midTurnReviews = 0): Promise<void> {
			const before = requests.length;
			let requestsAtContinuation: number | undefined;
			primary.push({
				content: [`STEP_${marker}`, { type: "toolCall", name: "read", arguments: { path: `${marker}.ts` } }],
			});
			primary.push(() => {
				// The real Agent loop has crossed the tool-step review boundary.
				requestsAtContinuation = requests.length - before;
				return { content: [`COMPLETE_${marker}`] };
			});
			await live.agent.prompt(`Work on ${marker}`);
			expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);
			expect(requestsAtContinuation).toBe(midTurnReviews);
			expect(requests).toHaveLength(before + midTurnReviews + 1);
			// Whatever was skipped mid-turn still reaches the terminal review.
			const transcript = JSON.stringify(requests[requests.length - 1].messages);
			expect(transcript).toContain(`STEP_${marker}`);
			expect(transcript).toContain(`COMPLETE_${marker}`);
		}

		return { live, settings, requests, runTurn };
	}

	it("applies reviewOn dynamically without discarding the advisor conversation", async () => {
		const { live, settings, requests, runTurn } = createSession();
		await runTurn("turn_cadence");

		settings.set("advisor.reviewOn", "step");
		await runTurn("step_cadence", 1);
		expect(JSON.stringify(requests[1].messages)).toContain(ADVISOR_HISTORY);

		// An explicit refresh must not treat a cadence-only edit as a rebuild
		// trigger and erase the advisor conversation it has already built.
		expect(live.setAdvisorEnabled(true)).toBe(true);
		await runTurn("step_after_refresh", 1);
		expect(JSON.stringify(requests[3].messages)).toContain(ADVISOR_HISTORY);
	});

	it("skips a read-only mid-turn step under mutation but still reviews the turn end", async () => {
		const { settings, runTurn } = createSession();
		settings.set("advisor.reviewOn", "mutation");
		await runTurn("mutation_cadence");
	});
});
