import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// `auto` is a session-level selector: the per-turn difficulty classifier runs
// for the primary turn only, and `concreteThinkingLevel` erases `auto` when the
// advisor descriptor is built. An advisor configured with `:auto` therefore used
// to collapse to the hardcoded `medium` fallback and stay there for the whole
// session. It now tracks the effort the primary turn is running at, whether the
// primary is on `auto` or pinned.
describe("advisor auto thinking level", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("google", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		model = bundled;
	});

	let session: AgentSession | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	function newSession(
		streamFn?: Agent["streamFn"],
		settingsOverrides: Parameters<typeof Settings.isolated>[0] = {},
		advisorStreamFn?: Agent["streamFn"],
	): AgentSession {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			...(streamFn ? { streamFn } : {}),
		});
		const settings = Settings.isolated({ "compaction.enabled": false, ...settingsOverrides });
		settings.setModelRole("advisor", `${model.provider}/${model.id}:${AUTO_THINKING}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn,
		});
		return session;
	}

	it("follows the primary session's auto level instead of the medium fallback", () => {
		const s = newSession();
		s.setThinkingLevel(AUTO_THINKING);
		expect(s.isAutoThinking).toBe(true);
		const primaryLevel = s.thinkingLevel;
		// The provisional auto level is deliberately above the advisor's medium
		// fallback, so a passing assertion cannot be the old behavior.
		expect(primaryLevel).not.toBe(Effort.Medium);

		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.thinkingLevel).toBe(toReasoningEffort(primaryLevel));
	});

	it("drops to the build-time default at the next review boundary when the primary turns thinking off", async () => {
		const mock = createMockModel({ handler: { content: ["primary complete"] } });
		const s = newSession(mock.stream);
		s.setThinkingLevel(Effort.High);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.thinkingLevel).toBe(Effort.High);

		s.setThinkingLevel(ThinkingLevel.Off);
		await s.agent.prompt("do work");
		await s.waitForAdvisorCatchup(2000);
		expect(s.getAdvisorAgent()).toBe(advisor);
		expect(advisor.state.thinkingLevel).toBe(Effort.Medium);

		// The live retune and a fresh build agree on the level.
		s.setAdvisorEnabled(false);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		expect(s.getAdvisorAgent()?.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("retunes the live advisor at the turn boundary without rebuilding or resetting it", async () => {
		const mock = createMockModel({ responses: [{ content: ["primary complete"] }] });
		const s = newSession(mock.stream);
		// Build the advisor while the primary is pinned low: a later move off low
		// can only come from the turn-boundary retune.
		s.setThinkingLevel(Effort.Low);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisorBefore = s.getAdvisorAgent();
		if (!advisorBefore) throw new Error("Expected advisor Agent to be live");
		expect(advisorBefore.state.thinkingLevel).toBe(Effort.Low);

		// Switching the primary to auto must not, by itself, move the advisor:
		// only a review boundary retunes it.
		s.setThinkingLevel(AUTO_THINKING);
		const primaryAuto = toReasoningEffort(s.thinkingLevel);
		expect(primaryAuto).not.toBe(Effort.Low);
		expect(advisorBefore.state.thinkingLevel).toBe(Effort.Low);

		// The retune must move the effort only: switching models or invalidating
		// the append-only prefix would throw away the advisor's cached context.
		const setModel = vi.spyOn(advisorBefore, "setModel");
		const invalidate = advisorBefore.appendOnlyContext
			? vi.spyOn(advisorBefore.appendOnlyContext, "invalidateForModelChange")
			: undefined;
		const messagesBefore = advisorBefore.state.messages.length;

		await s.agent.prompt("do work");
		await s.waitForAdvisorCatchup(2000);

		expect(s.getAdvisorAgent()).toBe(advisorBefore);
		expect(advisorBefore.state.thinkingLevel).toBe(primaryAuto);
		expect(setModel).not.toHaveBeenCalled();
		expect(invalidate?.mock.calls.length ?? 0).toBe(0);
		expect(advisorBefore.state.messages.length).toBeGreaterThanOrEqual(messagesBefore);
		// `/dump advisor` is the one UI surface that shows the advisor's own
		// effort (the status-line tail is the primary's level), so the retune
		// must be visible there too.
		expect(s.formatAdvisorHistoryAsText()).toContain(`Thinking Level: ${primaryAuto}`);
	});

	it("follows the primary off auto onto a pinned level at the next review boundary", async () => {
		const mock = createMockModel({ responses: [{ content: ["primary complete"] }] });
		const s = newSession(mock.stream);
		s.setThinkingLevel(AUTO_THINKING);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisorBefore = s.getAdvisorAgent();
		if (!advisorBefore) throw new Error("Expected advisor Agent to be live");
		const primaryAuto = toReasoningEffort(s.thinkingLevel);
		expect(advisorBefore.state.thinkingLevel).toBe(primaryAuto);
		// The pinned level must differ from the one the advisor inherited, so a
		// passing assertion cannot be the advisor staying where it was.
		expect(primaryAuto).not.toBe(Effort.Low);

		s.setThinkingLevel(Effort.Low);
		expect(s.isAutoThinking).toBe(false);
		await s.agent.prompt("do work");
		await s.waitForAdvisorCatchup(2000);

		expect(s.getAdvisorAgent()).toBe(advisorBefore);
		expect(advisorBefore.state.thinkingLevel).toBe(Effort.Low);
	});

	it("an auto advisor on a retry-fallback model is not retuned when the primary's level changes; it follows again once back on its main model", async () => {
		const primary = createMockModel({ handler: { content: ["primary complete"] } });
		const advisorMock = createMockModel();
		const wire: string[] = [];
		let quotaFailed = false;
		const s = newSession(
			primary.stream,
			{
				"advisor.syncBacklog": "1",
				"retry.baseDelayMs": 5,
				"retry.fallbackChains": { advisor: ["google/gemini-2.5-flash:minimal"] },
			},
			(m, context, options) => {
				wire.push(`${m.id}:${options?.reasoning}`);
				if (m.id === model.id && !quotaFailed) {
					quotaFailed = true;
					advisorMock.push({
						throw: "Devin stream error failed_precondition: Your daily usage quota has been exhausted. Your quota will reset after 60s.",
					});
				} else {
					advisorMock.push({ content: ["advisor ok"] });
				}
				return advisorMock.stream(m, context, options);
			},
		);
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		s.setThinkingLevel(Effort.Low);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		// The failed review falls back asynchronously, after catch-up reports.
		const fellBack = Promise.withResolvers<void>();
		s.subscribe(event => {
			if (event.type === "retry_fallback_succeeded") fellBack.resolve();
		});
		const review = async (prompt: string) => {
			await s.agent.prompt(prompt);
			expect(await s.waitForAdvisorCatchup(5000)).toBe(true);
			return wire.at(-1);
		};

		await s.agent.prompt("quota fails over to the fallback");
		await fellBack.promise;
		expect(wire).toEqual([`${model.id}:${Effort.Low}`, "gemini-2.5-flash:minimal"]);
		s.setThinkingLevel(Effort.High);
		expect(await review("primary now high")).toBe("gemini-2.5-flash:minimal");

		// Cooldown over: the very review that restores the main model already
		// runs at the primary's current level, not the pre-fallback `low`.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
		expect(await review("cooldown expired")).toBe(`${model.id}:${Effort.High}`);
		expect(s.getAdvisorAgent()).toBe(advisor);
	});
});
