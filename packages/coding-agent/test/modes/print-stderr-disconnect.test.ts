/**
 * Contract: stderr is a best-effort diagnostics channel. A headless `omp -p`
 * whose launcher dropped its stderr reader must still report its exit code —
 * the terminal-failure line is the last thing text mode writes, and a stream
 * that never emits `drain` (it is destroyed, not backpressured) must not strand
 * the run before it returns.
 */
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

function failedTurnSession(cwd: string): AgentSession {
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
		prompt: async () => {},
		getLastAssistantMessage: () => ({
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "provider exploded",
			timestamp: 1,
		}),
		dispose: async () => {},
	} as unknown as AgentSession;
}

describe("print mode with a dead stderr", () => {
	test("returns the failure exit code when stderr errors instead of draining", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-stderr-"));
		// A destroyed stderr (EPIPE) reports the failed write false and then emits
		// `error`; it never emits `drain`. The process-level listener stands in for
		// the one `registerStdioDisconnectHandling` installs at CLI entry.
		const onError = (): void => {};
		process.stderr.on("error", onError);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => {
			queueMicrotask(() =>
				process.stderr.emit("error", Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" })),
			);
			return false;
		}) as never);
		try {
			const exitCode = await runPrintMode(failedTurnSession(cwd), { mode: "text", initialMessage: "hello" });
			expect(exitCode).toBe(1);
		} finally {
			stderr.mockRestore();
			process.stderr.off("error", onError);
			await removeWithRetries(cwd);
		}
	}, 5_000);
});
