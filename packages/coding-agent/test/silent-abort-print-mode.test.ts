/**
 * Regression: print-mode must not write SILENT_ABORT_MARKER to stderr.
 *
 * Codex review flagged that `print-mode.ts` renders `errorMessage` verbatim
 * when stopReason is "aborted", which would surface the sentinel to stderr
 * (and exit with code 1). This test verifies the guard skips silent-abort.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import {
	type AgentSession,
	type AgentSessionDisposeOptions,
	SHUTDOWN_CONSOLIDATE_BUDGET_MS,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

/** Minimal mock of AgentSession for print-mode text output path */
function createMockSession(
	messages: AssistantMessage[],
	dispose: (options?: AgentSessionDisposeOptions) => Promise<void> = async () => {},
): AgentSession {
	return {
		state: { messages },
		getLastAssistantMessage: () => messages.findLast(message => message.role === "assistant"),
		settings: { get: () => false },
		sessionManager: {
			getHeader: () => undefined,
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
		},
		extensionRunner: undefined,
		subscribe: () => () => {},
		prompt: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose,
	} as unknown as AgentSession;
}

describe("Print-mode silent-abort regression", () => {
	let exitSpy: Mock<typeof process.exit>;
	let stderrOutput: string[];
	let stdoutOutput: string[];

	beforeEach(() => {
		stderrOutput = [];
		stdoutOutput = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") stdoutOutput.push(chunk);
			// Invoke callback if present (runPrintMode flushes stdout before returning)
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not write silent-abort marker to stderr or exit non-zero", async () => {
		const silentAbortMsg = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
			content: [],
		});

		const session = createMockSession([silentAbortMsg]);
		await runPrintMode(session, { mode: "text" });

		// The silent-abort marker MUST NOT appear in stderr
		const stderrText = stderrOutput.join("");
		expect(stderrText).not.toContain(SILENT_ABORT_MARKER);
		// process.exit MUST NOT have been called (clean termination)
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("bounds final memory consolidation so print mode can exit", async () => {
		let disposeOptions: AgentSessionDisposeOptions | undefined;
		const session = createMockSession([makeAssistantMessage()], async options => {
			disposeOptions = options;
		});

		await runPrintMode(session, { mode: "text" });

		expect(disposeOptions?.mnemopiConsolidateTimeoutMs).toBe(SHUTDOWN_CONSOLIDATE_BUDGET_MS);
	});

	it("does not write bit-classified silent aborts to stderr or exit non-zero", async () => {
		const silentAbortMsg = makeAssistantMessage({
			stopReason: "aborted",
			errorId: AIError.create(AIError.Flag.SilentAbort),
			errorMessage: undefined,
			content: [],
		});

		const session = createMockSession([silentAbortMsg]);
		await runPrintMode(session, { mode: "text" });

		expect(stderrOutput.join("")).toBe("");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("writes real error messages to stderr and exits non-zero", async () => {
		const errorMsg = makeAssistantMessage({
			stopReason: "error",
			errorMessage: "Rate limit exceeded",
			content: [],
		});

		let disposeOptions: AgentSessionDisposeOptions | undefined;
		const session = createMockSession([errorMsg], async options => {
			disposeOptions = options;
		});
		await runPrintMode(session, { mode: "text" });

		// A real error SHOULD be written to stderr
		const stderrText = stderrOutput.join("");
		expect(stderrText).toContain("Rate limit exceeded");
		// process.exit(1) SHOULD have been called
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(disposeOptions?.mnemopiConsolidateTimeoutMs).toBe(SHUTDOWN_CONSOLIDATE_BUDGET_MS);
	});

	it("prints thinking blocks only when printThoughts is enabled", async () => {
		const message = makeAssistantMessage({
			content: [
				{ type: "thinking", thinking: "inspect hidden branch" },
				{ type: "text", text: "final answer" },
			],
		});

		await runPrintMode(createMockSession([message]), { mode: "text" });
		expect(stdoutOutput.join("")).toBe("final answer\n");

		stdoutOutput = [];
		await runPrintMode(createMockSession([message]), { mode: "text", printThoughts: true });
		expect(stdoutOutput.join("")).toBe("inspect hidden branch\nfinal answer\n");
	});
});
