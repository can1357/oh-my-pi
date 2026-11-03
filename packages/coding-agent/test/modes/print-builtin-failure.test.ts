/**
 * Contract: print mode is automation surface — a dispatched `/mcp reauth`
 * that consumes an input but fails (unknown server, usage error, refused
 * operation) must not exit 0, or `omp -p '/mcp reauth foo'` scripts treat a
 * failed reauthorization as success. Conversely a consumed reauth that
 * succeeded exits 0 without prompting the model or reprinting the persisted
 * previous turn, and the merged stdin/@file message is never dispatched as a
 * command: a pipe controls it end to end.
 */
import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function printSession(cwd: string, prompts: string[]): AgentSession {
	return {
		extensionRunner: undefined,
		subscribe: () => () => {},
		settings: Settings.isolated(),
		sessionManager: {
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
			getCwd: () => cwd,
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForIdle: async () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		prompt: async (text: string) => {
			prompts.push(text);
		},
		getLastAssistantMessage: () => undefined,
		dispose: async () => {},
	} as unknown as AgentSession;
}

describe("print mode builtin exit codes", () => {
	test("exits 1 when the dispatched reauth fails, 0 for other slash input", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-builtin-"));
		const stderrLines: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderrLines.push(String(chunk));
			return true;
		}) as never);
		const prompts: string[] = [];
		const session = printSession(cwd, prompts);

		try {
			// A failed reauth (unknown server) consumes the input and reports
			const failure = await runPrintMode(session, {
				mode: "text",
				messages: ["/mcp reauth no-such-server-9f3a"],
			});
			expect(failure).toBe(1);
			expect(stderrLines.join("")).toContain("not found");
			expect(prompts).toEqual([]);

			stderrLines.length = 0;
			prompts.length = 0;
			// Slash input outside the reauth allow-list keeps the historic
			// behavior: it prompts the model with the literal text instead of
			// running locally.
			const success = await runPrintMode(session, { mode: "text", messages: ["/mcp help"] });
			expect(success).toBe(0);
			expect(prompts).toEqual(["/mcp help"]);
			expect(stderrLines.join("")).not.toContain("/mcp list");
		} finally {
			stderrSpy.mockRestore();
			vi.restoreAllMocks();
			await removeWithRetries(cwd);
		}
	});

	test("never dispatches the merged stdin/@file message as a command", async () => {
		// Security: `curl … | omp "summarize"` merges the pipe into
		// `initialMessage`; a slash-shaped payload there (e.g. a persisted
		// `/mcp add`) must reach the model as text, never run as a command.
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-stdin-"));
		const stderrLines: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderrLines.push(String(chunk));
			return true;
		}) as never);
		const prompts: string[] = [];
		const session = printSession(cwd, prompts);
		// Allow-listed *and* reauth-shaped: the trust boundary must hold even
		// for the one command print mode dispatches — a pipe controls this
		// text end to end, so it must reach the model verbatim.
		const injected = "/mcp reauth evil";

		try {
			const exit = await runPrintMode(session, { mode: "text", initialMessage: injected });
			// The payload prompted the model verbatim; nothing ran locally.
			expect(prompts).toEqual([injected]);
			expect(exit).toBe(0);
			expect(stderrLines.join("")).not.toContain("not found");
		} finally {
			stderrSpy.mockRestore();
			vi.restoreAllMocks();
			await removeWithRetries(cwd);
		}
	});

	test("counts a builtin-started turn (/retry) as admitted and prints its answer", async () => {
		// `/retry` consumes the input but schedules a real agent turn
		// (`agentInvoked`); that turn's answer belongs to this run, so it is
		// printed — not suppressed as a stale persisted turn — and its stop
		// reason decides the exit status.
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-retry-"));
		const stdoutLines: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: unknown,
			callback?: (err?: Error | null) => void,
		) => {
			stdoutLines.push(String(chunk));
			callback?.(null);
			return true;
		}) as never);
		const retriedAnswer = {
			role: "assistant",
			content: [{ type: "text", text: "retried answer" }],
			stopReason: "stop",
			timestamp: Date.now(),
		} as never;
		const prompts: string[] = [];
		const session = {
			extensionRunner: undefined,
			subscribe: () => () => {},
			settings: Settings.isolated(),
			sessionManager: {
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getCwd: () => cwd,
				onPersistenceError: () => () => {},
				onPersistenceNotice: () => () => {},
			},
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForIdle: async () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			prompt: async (text: string) => {
				prompts.push(text);
			},
			retry: async () => true,
			getLastAssistantMessage: () => retriedAnswer,
			dispose: async () => {},
		} as unknown as AgentSession;

		try {
			const exit = await runPrintMode(session, { mode: "text", messages: ["/retry"] });
			expect(exit).toBe(0);
			// The input was consumed locally (no new prompt)…
			expect(prompts).toEqual([]);
			// …and the retried turn's answer was printed as this run's answer.
			expect(stdoutLines.join("")).toContain("retried answer");
		} finally {
			stdoutSpy.mockRestore();
			vi.restoreAllMocks();
			await removeWithRetries(cwd);
		}
	});
});
