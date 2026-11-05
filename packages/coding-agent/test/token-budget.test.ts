import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	attachIrcWakeTurnMonitor,
	buildTokenBudgetNotice,
	buildTokenBudgetWrapUpNotice,
	runSubprocess,
	subagentBudgetFor,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createMockSession, yieldToolEnd } from "./helpers/mock-subagent-session";

/**
 * Contracts under test — `task.tokenBudget` is a context-token budget for one
 * subagent run, next to the request budget:
 *
 * 1. Crossing 50% injects one aside carrying `<total_tokens>N tokens left of M</total_tokens>`;
 *    crossing 90% injects one wrap-up steering notice (mirroring
 *    `task.softRequestBudgetNotice`), each at most once per run.
 * 2. 0 disables the guard.
 * 3. A woke/revived turn runs the same monitor with the same budget, so the
 *    guard is not lost across park → revive (the class of bug upstream fixed
 *    for `task.softRequestBudget` in #17988/#18121).
 */

const baseAgent: AgentDefinition = {
	name: "scout",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function assistantUsage(input: number, text = "working") {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		stopReason: "stop" as const,
		usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input },
	};
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
	} as CreateAgentSessionResult);
}

describe("token budget notices", () => {
	it("renders the aside payload with the remaining tokens and the budget", () => {
		expect(buildTokenBudgetNotice(600, 1000)).toBe("<total_tokens>400 tokens left of 1000</total_tokens>");
		// Over-budget clamps to zero instead of going negative.
		expect(buildTokenBudgetNotice(1200, 1000)).toBe("<total_tokens>0 tokens left of 1000</total_tokens>");
	});

	it("renders a wrap-up notice naming the spent and budgeted tokens", () => {
		const notice = buildTokenBudgetWrapUpNotice(920, 1000);
		expect(notice).toContain("920 tokens");
		expect(notice).toContain("1000");
		expect(notice).toContain("wrap up");
	});

	it("reads task.tokenBudget, defaulting to off and clamping invalid values", () => {
		expect(subagentBudgetFor("scout", Settings.isolated()).tokenBudget).toBe(0);
		expect(subagentBudgetFor("scout", Settings.isolated({ "task.tokenBudget": 5000 })).tokenBudget).toBe(5000);
		expect(subagentBudgetFor("scout", Settings.isolated({ "task.tokenBudget": -10 })).tokenBudget).toBe(0);
	});

	it("travels with the request budget through the shared per-agent helper", () => {
		const budgets = subagentBudgetFor("scout", Settings.isolated({ "task.tokenBudget": 5000 }));
		expect(budgets.tokenBudget).toBe(5000);
		// The request budget keeps resolving exactly as before.
		expect(budgets.softRequestBudget).toBe(100);
	});
});

function registerRunning(id: string, session: AgentSession, sessionFile: string | null = null) {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		session,
		sessionFile,
		status: "running",
	});
}

describe("runSubprocess token budget", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		IrcBus.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-token-budget-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		IrcBus.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	function baseOptions(id: string, settings: Settings) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "inventory the api surface",
			index: 0,
			id,
			settings,
			modelRegistry: { refresh: async () => {} } as never,
			enableLsp: false,
			artifactsDir: tempDir.path(),
		};
	}

	it("injects one <total_tokens> aside at 50% and one wrap-up steer at 90%", async () => {
		const id = "TokenBudgetScout";
		const handle = createMockSession(({ emit, pushMessage }) => {
			const first = assistantUsage(600);
			pushMessage(first);
			emit({ type: "message_end", message: first } as never);
			const second = assistantUsage(300);
			pushMessage(second);
			emit({ type: "message_end", message: second } as never);
			emit(yieldToolEnd("tool-token-budget", { report: "done" }));
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess({
			...baseOptions(id, Settings.isolated({ "task.tokenBudget": 1000 })),
			sessionFile: `${tempDir.path()}/parent.jsonl`,
		});

		expect(result.exitCode).toBe(0);
		expect(handle.sentUserMessages).toHaveLength(2);
		expect(handle.sentUserMessages[0]).toEqual({
			content: "<total_tokens>400 tokens left of 1000</total_tokens>",
			options: { deliverAs: "aside", attribution: "agent" },
		});
		expect(handle.sentUserMessages[1]?.options).toEqual({ deliverAs: "steer", attribution: "agent" });
		expect(String(handle.sentUserMessages[1]?.content)).toBe(buildTokenBudgetWrapUpNotice(900, 1000));
	});

	it("stays silent when task.tokenBudget is off", async () => {
		const id = "NoTokenBudgetScout";
		const handle = createMockSession(({ emit, pushMessage }) => {
			const message = assistantUsage(900);
			pushMessage(message);
			emit({ type: "message_end", message } as never);
			emit(yieldToolEnd("tool-no-token-budget", { report: "done" }));
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		await runSubprocess({
			...baseOptions(id, Settings.isolated()),
			sessionFile: `${tempDir.path()}/parent.jsonl`,
		});

		expect(handle.sentUserMessages).toHaveLength(0);
	});
});

describe("token budget on a revived agent's wake turn", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		IrcBus.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-token-budget-wake-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		IrcBus.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	it("keeps the budget on an undriven wake turn of a kept-alive agent", async () => {
		const id = "RevivedTokenScout";
		const handle = createMockSession(() => {});
		registerRunning(id, handle.session, `${tempDir.path()}/revived.jsonl`);

		attachIrcWakeTurnMonitor(handle.session, { id, agent: baseAgent, tokenBudget: 1000 });
		const observer = handle.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const wake: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "resume the review",
			display: true,
			details: { id: "msg-1", from: "parent", message: "resume the review" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		const finish = observer([wake]);
		const message = assistantUsage(600);
		handle.pushMessage(message);
		handle.emit({ type: "message_end", message } as never);
		handle.emit(yieldToolEnd("tool-revived-token-budget", { report: "resumed" }));
		handle.emit({ type: "agent_end", messages: [message] } as never);
		await finish?.();

		expect(handle.sentUserMessages.map(entry => entry.content)).toContain(
			"<total_tokens>400 tokens left of 1000</total_tokens>",
		);
		expect(handle.sentUserMessages.map(entry => entry.options?.deliverAs)).toContain("aside");
	});
});
