/**
 * Contract: non-interactive shutdown MUST await `session.dispose()` before the
 * process exits. This releases owned resources and lets an interrupted agent
 * finalize its partial assistant message into the session journal.
 *
 * Contract (issue #11498): `runPrintMode` no longer terminates the process; it
 * disposes, reports terminal and persistence failures, and RETURNS the exit
 * code the caller passes to `postmortem.quit`.
 */
import * as path from "node:path";
import { describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { runPrintMode } from "../../src/modes/print-mode";
import type { AgentSession } from "../../src/session/agent-session";
import * as telemetryExport from "../../src/telemetry-export";

describe("print mode disposes the session before terminating", () => {
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
			sessionManager: {
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				// Print mode subscribes to store failures (issue #11493).
				onPersistenceError: () => () => {},
			},
			state: { messages: [errorMsg] },
			getLastAssistantMessage: () => errorMsg,
			getDisabledCredentialNotices: async () => [],
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

	it("disposes an active print session before SIGTERM exits", async () => {
		using tempDir = TempDir.createSync("@omp-print-signal-");
		const marker = tempDir.join("disposed");
		const fixture = path.join(import.meta.dir, "..", "fixtures", "print-mode-signal.js");
		const child = Bun.spawn([process.execPath, fixture, marker], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await child.exited;
		const stderr = await new Response(child.stderr).text();
		const markerFile = Bun.file(marker);

		if (!(await markerFile.exists())) {
			throw new Error(`Print session was not disposed before signal exit ${exitCode}: ${stderr}`);
		}
		expect(await markerFile.text()).toBe("sigterm");
	});

	it("defers to signal shutdown instead of reporting an ordinary failure when a signal aborts the turn", async () => {
		const abortedMsg: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "cursor-agent",
			provider: "cursor",
			model: "cursor-grok-4.6",
			usage: {} as AssistantMessage["usage"],
			stopReason: "aborted",
			errorMessage: "Request aborted",
			timestamp: 1,
		};

		let signalCallback: ((reason: postmortem.Reason) => void | Promise<void>) | undefined;
		let disposeReason: postmortem.Reason | "dispose" | undefined;
		const session = {
			extensionRunner: undefined,
			subscribe: () => {},
			settings: { get: () => false },
			sessionManager: {
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				onPersistenceError: () => () => {},
			},
			getLastAssistantMessage: () => abortedMsg,
			getDisabledCredentialNotices: async () => [],
			prepareForHeadlessAdvisorDrain: () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			// Mimic a real mid-turn signal: the postmortem teardown fires (which
			// disposes and aborts the agent), and only then does the awaited turn
			// settle with an aborted assistant message.
			prompt: async () => {
				await signalCallback?.(postmortem.Reason.SIGTERM);
			},
			dispose: async (options: { reason?: postmortem.Reason } = {}) => {
				disposeReason ??= options.reason ?? "dispose";
			},
		} as unknown as AgentSession;

		const registerSpy = spyOn(postmortem, "register").mockImplementation(
			(_id: string, cb: (reason: postmortem.Reason) => void | Promise<void>) => {
				signalCallback = cb;
				return () => {};
			},
		);
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);

		try {
			expect(await runPrintMode(session, { mode: "text", initialMessage: "go" })).toBe(0);
		} finally {
			registerSpy.mockRestore();
			stderrSpy.mockRestore();
		}

		expect(disposeReason).toBe(postmortem.Reason.SIGTERM);
	});
});
