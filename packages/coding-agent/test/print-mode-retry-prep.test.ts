/**
 * Regression tests for print-mode dispatched builtins that schedule model
 * turns (`/retry`) and for the `/stats` exclusion:
 *
 * - A `/retry`-started turn must get `promptTurn`'s pre-turn prep — MCP
 *   readiness binding and the strict `OMP_MCP_REQUIRE_READY` gate — BEFORE
 *   `session.retry()` schedules the continuation, or strict automation
 *   passes on a run it should fail and the retried turn streams without the
 *   tools turn one gets.
 * - `/retry` must hold the dispatch open until the retried turn streams
 *   (`keepTurnOpenUntilIdle`), or the next CLI message races the
 *   just-scheduled continuation.
 * - `/stats` stays undispatched: its in-process dashboard server cannot
 *   outlive the one-shot run, so the literal text reaches the model like
 *   every undispatched command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface RetryPrepSpies {
	prompt: ReturnType<typeof vi.fn>;
	retry: ReturnType<typeof vi.fn>;
	refreshMCPTools: ReturnType<typeof vi.fn>;
	waitForIdle: ReturnType<typeof vi.fn>;
	order: string[];
}

function createMockSession(): { session: AgentSession; spies: RetryPrepSpies } {
	const order: string[] = [];
	const spies: RetryPrepSpies = {
		order,
		prompt: vi.fn(async (text: string) => {
			order.push(`prompt:${text}`);
		}),
		retry: vi.fn(async () => {
			order.push("retry");
			return true;
		}),
		refreshMCPTools: vi.fn(async () => {
			order.push("refreshMCPTools");
		}),
		waitForIdle: vi.fn(async () => {
			order.push("waitForIdle");
		}),
	};
	const session = {
		state: { messages: [] },
		getLastAssistantMessage: () => undefined,
		settings: Settings.isolated(),
		sessionManager: {
			getCwd: () => "/tmp",
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		isStreaming: false,
		subscribe: () => () => {},
		prompt: spies.prompt,
		retry: spies.retry,
		refreshMCPTools: spies.refreshMCPTools,
		waitForIdle: spies.waitForIdle,
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
	} as unknown as AgentSession;
	return { session, spies };
}

function failingManager(): MCPManager {
	return {
		waitForStartup: async () => ({ pending: [], failed: [{ name: "srv", error: "boom" }] }),
		getTools: () => [],
	} as unknown as MCPManager;
}

describe("print-mode dispatched builtins", () => {
	let stderrOutput: string[];

	beforeEach(() => {
		stderrOutput = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);
	});

	afterEach(() => {
		delete process.env.OMP_MCP_REQUIRE_READY;
		vi.restoreAllMocks();
	});

	it("refuses a /retry under the strict gate before session.retry() schedules the continuation", async () => {
		process.env.OMP_MCP_REQUIRE_READY = "1";
		const { session, spies } = createMockSession();

		const exitCode = await runPrintMode(session, {
			mode: "text",
			messages: ["/retry"],
			mcpManager: failingManager(),
		});

		// The strict gate refuses the turn /retry would schedule: reported,
		// the command consumed unexecuted, exit non-zero.
		expect(exitCode).toBe(1);
		expect(stderrOutput.join("")).toContain("MCP servers not ready: srv");
		// Readiness ran (waitForStartup + the tool binding), but the
		// continuation was never scheduled.
		expect(spies.refreshMCPTools).toHaveBeenCalledTimes(1);
		expect(spies.retry).not.toHaveBeenCalled();
		expect(spies.prompt).not.toHaveBeenCalled();
	});

	it("binds readiness before /retry and holds the dispatch open until the retried turn streams", async () => {
		const { session, spies } = createMockSession();

		const exitCode = await runPrintMode(session, { mode: "text", messages: ["/retry", "next question"] });

		expect(exitCode).toBe(0);
		expect(spies.retry).toHaveBeenCalledTimes(1);
		// The dispatch of /retry awaited idle before the next CLI message
		// prompted, so the two never race.
		expect(spies.order.indexOf("waitForIdle")).toBeGreaterThan(spies.order.indexOf("retry"));
		expect(spies.order.indexOf("waitForIdle")).toBeLessThan(spies.order.indexOf("prompt:next question"));
	});

	it("leaves /stats undispatched so its literal text reaches the model", async () => {
		const { session, spies } = createMockSession();

		const exitCode = await runPrintMode(session, { mode: "text", messages: ["/stats"] });

		// No dashboard launched in this one-shot process: the historic
		// undispatched behavior prompts the model with the literal text.
		expect(exitCode).toBe(0);
		expect(spies.prompt).toHaveBeenCalledWith("/stats");
		expect(spies.retry).not.toHaveBeenCalled();
	});
});
