import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// A classifier refusal judges the advisor's context, not the model's health.
// The advisor must stay on its fallback instead of returning to the refusing
// model after every cooldown, and may retry it once a compaction has replaced
// the history that triggered the refusal.
describe("advisor classifier-refusal fallback", () => {
	const PAST_COOLDOWN_MS = 10 * 60_000;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let advisorPrimary: Model;
	let advisorFallback: Model;
	let secondFallback: Model;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-refusal-pin-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("google", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("google", "gemini-2.5-flash");
		const second = getBundledModel("openai", "gpt-4o");
		if (!primary || !fallback || !second) throw new Error("Expected bundled advisor models to exist");
		advisorPrimary = primary;
		advisorFallback = fallback;
		secondFallback = second;
	});

	afterAll(() => {
		tempDir.removeSync();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		modelRegistry.clearSuppressedSelectors();
	});

	async function startSession(primaryFailure: "refusal" | "overloaded", scenario: { fallbackRefuses?: boolean } = {}) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", async event => ({
					compaction: {
						summary: "compacted",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"compaction-short-circuit",
		);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const primary = createMockModel({ handler: { content: ["primary complete"] } });
		const advisorMock = createMockModel();
		const advisorRequests: string[] = [];
		let providerFailed = false;
		const controls = { primaryRefuses: true };
		const agent = new Agent({
			initialState: { model: advisorPrimary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: primary.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.methodOrder": ["soft"],
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"advisor.syncBacklog": "1",
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				advisor: [
					`${advisorFallback.provider}/${advisorFallback.id}`,
					`${secondFallback.provider}/${secondFallback.id}`,
				],
			},
		});
		settings.setModelRole("advisor", `${advisorPrimary.provider}/${advisorPrimary.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
			advisorTools: [],
			advisorStreamFn: (model, context, options) => {
				advisorRequests.push(model.id);
				const refuses =
					(model.id === advisorPrimary.id && primaryFailure === "refusal" && controls.primaryRefuses) ||
					(model.id === advisorFallback.id && scenario.fallbackRefuses === true);
				const overloads = model.id === advisorPrimary.id && primaryFailure === "overloaded" && !providerFailed;
				if (refuses) {
					advisorMock.push({
						content: [],
						stopReason: "error",
						stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
						errorMessage: "Refusal (cyber): Declined.",
					});
				} else if (overloads) {
					providerFailed = true;
					advisorMock.push({ throw: "overloaded_error: provider returned error 503" });
				} else {
					advisorMock.push({ content: ["advisor ok"] });
				}
				return advisorMock.stream(model, context, options);
			},
		});
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		const s = session;
		const fellBack = Promise.withResolvers<void>();
		s.subscribe(event => {
			if (event.type === "retry_fallback_succeeded") fellBack.resolve();
		});
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const review = async (prompt: string) => {
			await s.prompt(prompt);
			await s.waitForIdle();
			expect(await s.waitForAdvisorCatchup(5000)).toBe(true);
		};
		await s.prompt("first turn triggers the fallback");
		await s.waitForIdle();
		await fellBack.promise;
		return { s, advisorRequests, review, controls };
	}

	it("keeps a refusal fallback past the cooldown a provider failure would observe", async () => {
		const { s, advisorRequests, review } = await startSession("refusal");
		const refusals = advisorRequests.filter(id => id === advisorPrimary.id).length;
		expect(refusals).toBeGreaterThan(0);
		expect(advisorRequests.at(-1)).toBe(advisorFallback.id);

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + PAST_COOLDOWN_MS);
		await review("second turn after the cooldown window");
		await review("third turn after the cooldown window");

		expect(advisorRequests.filter(id => id === advisorPrimary.id)).toHaveLength(refusals);
		expect(s.getAdvisorAgent()?.state.model.id).toBe(advisorFallback.id);
	});

	it("still returns a provider-failure fallback to its primary after the cooldown", async () => {
		const { s, advisorRequests, review } = await startSession("overloaded");
		const failures = advisorRequests.filter(id => id === advisorPrimary.id).length;

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + PAST_COOLDOWN_MS);
		await review("turn after the cooldown window");

		expect(advisorRequests.filter(id => id === advisorPrimary.id).length).toBeGreaterThan(failures);
		expect(s.getAdvisorAgent()?.state.model.id).toBe(advisorPrimary.id);
	});

	it("retries the refusing primary after the session compacts", async () => {
		const { s, advisorRequests, review, controls } = await startSession("refusal");
		const refusals = advisorRequests.filter(id => id === advisorPrimary.id).length;

		await review("turn before compaction stays on the fallback");
		expect(advisorRequests.filter(id => id === advisorPrimary.id)).toHaveLength(refusals);

		await s.compact();
		controls.primaryRefuses = false;
		await review("turn after compaction");

		expect(advisorRequests.filter(id => id === advisorPrimary.id)).toHaveLength(refusals + 1);
		expect(s.getAdvisorAgent()?.state.model.id).toBe(advisorPrimary.id);
	});

	it("returns to a primary that only overloaded when a later fallback refuses", async () => {
		const { s, advisorRequests, review } = await startSession("overloaded", { fallbackRefuses: true });
		expect(advisorRequests).toContain(advisorFallback.id);
		expect(s.getAdvisorAgent()?.state.model.id).toBe(secondFallback.id);

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + PAST_COOLDOWN_MS);
		await review("turn after the cooldown window");

		expect(advisorRequests.at(-1)).toBe(advisorPrimary.id);
		expect(s.getAdvisorAgent()?.state.model.id).toBe(advisorPrimary.id);
	});

	it("stays pinned when the primary refuses and a fallback refuses too", async () => {
		const { s, advisorRequests, review } = await startSession("refusal", { fallbackRefuses: true });
		const primaryRequests = advisorRequests.filter(id => id === advisorPrimary.id).length;
		expect(s.getAdvisorAgent()?.state.model.id).toBe(secondFallback.id);

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + PAST_COOLDOWN_MS);
		await review("turn after the cooldown window");

		expect(advisorRequests.filter(id => id === advisorPrimary.id)).toHaveLength(primaryRequests);
		expect(s.getAdvisorAgent()?.state.model.id).toBe(secondFallback.id);
	});
});
