import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
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
// session. It now tracks the effort the primary turn is running at.
describe("advisor auto thinking level", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		model = bundled;
	});

	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	function newSession(streamFn?: Agent["streamFn"]): AgentSession {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			...(streamFn ? { streamFn } : {}),
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("advisor", `${model.provider}/${model.id}:${AUTO_THINKING}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
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

	it("keeps the medium fallback when the primary session is not on auto", () => {
		const s = newSession();
		s.setThinkingLevel(Effort.Low);
		expect(s.isAutoThinking).toBe(false);

		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("retunes the live advisor at the turn boundary without rebuilding or resetting it", async () => {
		const mock = createMockModel({ responses: [{ content: ["primary complete"] }] });
		const s = newSession(mock.stream);
		// Build the advisor while the session is NOT on auto: it starts on the
		// medium fallback, so a later move off medium can only come from the
		// turn-boundary retune.
		s.setThinkingLevel(Effort.Low);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisorBefore = s.getAdvisorAgent();
		if (!advisorBefore) throw new Error("Expected advisor Agent to be live");
		expect(advisorBefore.state.thinkingLevel).toBe(Effort.Medium);

		// Switching the primary to auto must not, by itself, move the advisor:
		// only a review boundary retunes it.
		s.setThinkingLevel(AUTO_THINKING);
		const primaryAuto = toReasoningEffort(s.thinkingLevel);
		expect(primaryAuto).not.toBe(Effort.Medium);
		expect(advisorBefore.state.thinkingLevel).toBe(Effort.Medium);

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
});
