/**
 * Contract: the print-mode assistant-error/aborted path MUST run the awaited
 * `session.dispose()` (which contains the bounded browser reaper
 * `releaseTabsForOwner`) before the process terminates. It previously called
 * `process.exit(1)` ahead of the `dispose()` at the end of `runPrintMode`, so
 * an OMP-owned Chromium survived the exit (issue #5643).
 *
 * Contract (issue #11498): `runPrintMode` no longer terminates the process; it
 * disposes, reports the failure on stderr, and RETURNS the exit code the caller
 * passes to `postmortem.quit`. The dispose-before-terminate ordering from #5643
 * is preserved because the caller can only terminate after the awaited return.
 */
import { describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { runPrintMode } from "../../src/modes/print-mode";
import type { AgentSession } from "../../src/session/agent-session";
import * as telemetryExport from "../../src/telemetry-export";

describe("print-mode error exit disposes the session before terminating", () => {
	it("disposes on the assistant-error path before returning exit code 1", async () => {
		const order: string[] = [];
		const errorMsg: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: {} as AssistantMessage["usage"],
			stopReason: "error",
			errorMessage: "boom",
			timestamp: 1,
		};
		const session = {
			extensionRunner: undefined,
			subscribe: () => {},
			settings: { get: () => false },
			sessionManager: { buildSessionContext: () => ({ messages: [] }), getEntries: () => [] },
			state: { messages: [errorMsg] },
			getLastAssistantMessage: () => errorMsg,
			prepareForHeadlessAdvisorDrain: () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => {
				order.push("catchup");
				return true;
			},
			dispose: async () => {
				order.push("dispose");
			},
		} as unknown as AgentSession;

		const flushSpy = spyOn(telemetryExport, "flushTelemetryExport").mockImplementation(async () => {
			order.push("flush");
		});
		const stderrLines: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			order.push("stderr");
			stderrLines.push(String(chunk));
			return true;
		}) as never);

		try {
			// No `process.exit` spy: the contract is that runPrintMode never exits
			// the process itself, it returns the code for the caller to use.
			expect(await runPrintMode(session, { mode: "text" })).toBe(1);
		} finally {
			stderrSpy.mockRestore();
			flushSpy.mockRestore();
		}

		expect(order).toEqual(["catchup", "flush", "dispose", "stderr"]);
		expect(stderrLines.join("")).toContain("boom");
	});
});
