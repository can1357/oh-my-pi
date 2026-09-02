import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { formatResultOutputFallback } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

/**
 * Contract: runaway-subagent guards.
 *
 * 1. The executor counts assistant requests (message_end events) and surfaces
 *    the count on `SingleResult.requests`.
 * 2. Crossing the soft request budget injects exactly ONE steering notice
 *    (on by default) into the child session asking it to wrap up; crossing
 *    1.5x the budget force-stops the free-running turn and drives a forced
 *    final yield. A child that still yields nothing is reported as a budget
 *    abort with the precise reason.
 * 3. A cancelled/aborted child that produced no completed output salvages its
 *    last assistant text into a `[cancelled after N req, …]` summary instead
 *    of the parent seeing "(no output)" and redoing the work.
 */

interface SteerCall {
	content: string;
	options?: { deliverAs?: "steer" | "followUp" };
}

interface FakeSessionConfig {
	/** Events pushed to the executor's subscriber on the next microtask. */
	events?: AgentSessionEvent[];
	/** When true, prompt/waitForIdle hang until abort() is called. */
	hang?: boolean;
	/** Returned from getLastAssistantMessage (salvage source). */
	lastAssistantMessage?: unknown;
}

interface FakeSessionHandle {
	session: AgentSession;
	steerCalls: SteerCall[];
	abortCalls: () => number;
}

function assistantMessageEnd(text: string, usage?: Record<string, number>): AgentSessionEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: text ? [{ type: "text", text }] : [],
			usage: usage ?? { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
		},
	} as unknown as AgentSessionEvent;
}

function yieldToolEnd(): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: "tool-yield",
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: { ok: true } },
		},
		isError: false,
	} as AgentSessionEvent;
}

function createFakeSession(config: FakeSessionConfig = {}): FakeSessionHandle {
	let abortCount = 0;
	const steerCalls: SteerCall[] = [];
	const { promise: hang, resolve: releaseHang } = Promise.withResolvers<void>();
	if (!config.hang) releaseHang();

	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_names: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			if (config.events?.length) {
				const events = config.events;
				queueMicrotask(() => {
					for (const event of events) listener(event);
				});
			}
			return () => {};
		},
		prompt: async () => {
			await hang;
			return true;
		},
		waitForIdle: async () => {
			await hang;
		},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		sendUserMessage: async (content, options) => {
			steerCalls.push({ content: String(content), options });
		},
		getLastAssistantMessage: () => (config.lastAssistantMessage ?? undefined) as never,
		abort: async () => {
			abortCount += 1;
			releaseHang();
		},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	};
	return {
		session: session as AgentSession,
		steerCalls,
		abortCalls: () => abortCount,
	};
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} satisfies CreateAgentSessionResult);
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-guards",
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

describe("runSubprocess request guards", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("counts assistant requests into SingleResult.requests", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
		const handle = createFakeSession({
			events: [
				assistantMessageEnd("step one"),
				assistantMessageEnd("step two"),
				assistantMessageEnd("step three"),
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-requests", settings });

		expect(result.aborted).toBe(false);
		expect(result.requests).toBe(3);
		// Well under any budget: no steer injected.
		expect(handle.steerCalls.length).toBe(0);
	});

	it("injects exactly one steering notice when the soft budget is crossed", async () => {
		// Budget 4: steer fires at request 4 and must not repeat at request 5
		// (still below the 1.5x hard stop of 6).
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.softRequestBudget": 4,
			"task.softRequestBudgetNotice": true,
		});
		const handle = createFakeSession({
			events: [
				assistantMessageEnd("1"),
				assistantMessageEnd("2"),
				assistantMessageEnd("3"),
				assistantMessageEnd("4"),
				assistantMessageEnd("5"),
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-steer", settings });

		expect(result.requests).toBe(5);
		expect(result.aborted).toBe(false);
		expect(handle.steerCalls.length).toBe(1);
		expect(handle.steerCalls[0].content).toContain("[budget notice]");
		expect(handle.steerCalls[0].content).toContain("4 requests");
		expect(handle.steerCalls[0].options?.deliverAs).toBe("steer");
	});

	it("injects the steering notice by default when the soft request budget is crossed", async () => {
		// Budget 4 is crossed at request 4; the notice defaults ON, so exactly
		// one steer lands without task.softRequestBudgetNotice being set.
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.softRequestBudget": 4,
		});
		const handle = createFakeSession({
			events: [
				assistantMessageEnd("1"),
				assistantMessageEnd("2"),
				assistantMessageEnd("3"),
				assistantMessageEnd("4"),
				assistantMessageEnd("5"),
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-steer-default", settings });

		expect(result.requests).toBe(5);
		expect(result.aborted).toBe(false);
		expect(handle.steerCalls.length).toBe(1);
		expect(handle.steerCalls[0].content).toContain("[budget notice]");
	});

	it("still force-stops at 1.5x the soft budget when budget notices are disabled", async () => {
		// Budget 2: notice would normally fire at 2, but the force-stop at 3 must
		// remain active even with the notice disabled.
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.softRequestBudget": 2,
			"task.softRequestBudgetNotice": false,
		});
		const handle = createFakeSession({
			hang: true,
			events: [
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-hard-stop-notice-disabled", settings });

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("request budget exceeded");
		expect(handle.abortCalls()).toBeGreaterThanOrEqual(1);
		expect(handle.steerCalls).toEqual([]);
	});

	it("aborts the run gracefully at 1.5x the soft budget with notices enabled", async () => {
		// Budget 2: with notices enabled, steer at 2 and hard stop at 3. The
		// session hangs so only the budget abort can release it.
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.softRequestBudget": 2,
			"task.softRequestBudgetNotice": true,
		});
		const handle = createFakeSession({
			hang: true,
			events: [
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
				assistantMessageEnd("", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-hard-stop", settings });

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("request budget exceeded");
		expect(handle.abortCalls()).toBeGreaterThanOrEqual(1);
		expect(handle.steerCalls.length).toBe(1);
	});

	it("salvages the last assistant text for an aborted child with no completed output", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 50 });
		const handle = createFakeSession({
			hang: true,
			events: [
				// One completed assistant turn with usage but no text content:
				// counts a request and tokens without producing output chunks.
				assistantMessageEnd("", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }),
			],
			lastAssistantMessage: {
				role: "assistant",
				stopReason: "aborted",
				content: [{ type: "text", text: "Reading   the\n\tconfig loader before patching" }],
			},
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-salvage", settings });

		expect(result.aborted).toBe(true);
		expect(result.requests).toBe(1);
		expect(result.output).toContain("cancelled after 1 req");
		expect(result.output).toContain("150 tok");
		expect(result.output).toContain("last activity:");
		// Whitespace is flattened so the snippet stays a single line.
		expect(result.output).toContain("Reading the config loader before patching");
		expect(result.output).not.toContain("\n");
	});

	it("clips oversized salvage snippets", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 50 });
		const longText = `start-marker ${"x".repeat(700)}`;
		const handle = createFakeSession({
			hang: true,
			lastAssistantMessage: {
				role: "assistant",
				stopReason: "aborted",
				content: [{ type: "text", text: longText }],
			},
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-salvage-clip", settings });

		expect(result.aborted).toBe(true);
		expect(result.output).toContain("start-marker");
		expect(result.output).toContain("…");
		expect(result.output).not.toContain(longText);
		expect(result.output.length).toBeLessThan(700);
	});

	it("formats the (no output) fallback with the request count", () => {
		expect(formatResultOutputFallback({ output: "", stderr: "", requests: 7 })).toBe("(no output) after 7 req");
		expect(formatResultOutputFallback({ output: "  ", stderr: "", requests: 0 })).toBe("(no output)");
		expect(formatResultOutputFallback({ output: "real output", stderr: "", requests: 7 })).toBe("real output");
		expect(formatResultOutputFallback({ output: "", stderr: "boom", requests: 7 })).toBe("boom");
	});
});
