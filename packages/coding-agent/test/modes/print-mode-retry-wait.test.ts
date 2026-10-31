/**
 * Text-mode print reports a failed turn on stderr. The server's retry wait is
 * rendered there from `AssistantMessage.errorRetryAfterMs`, and only from it: a
 * message persisted before the wait was structured keeps its old
 * ` retry-after-ms=N` text and gets no rendered wait.
 */
import { describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import { runPrintMode } from "../../src/modes/print-mode";
import type { AgentSession } from "../../src/session/agent-session";
import * as telemetryExport from "../../src/telemetry-export";

function failedTurn(errorMessage: string, errorRetryAfterMs?: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {} as AssistantMessage["usage"],
		stopReason: "error",
		errorMessage,
		errorRetryAfterMs,
		timestamp: 1,
	};
}

/** The stderr text-mode print writes for a run whose last turn is `message`. */
async function printStderr(message: AssistantMessage): Promise<string> {
	const session = {
		extensionRunner: undefined,
		subscribe: () => {},
		settings: Settings.isolated(),
		sessionManager: {
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		prompt: async () => {},
		state: { messages: [message] },
		getLastAssistantMessage: () => message,
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForIdle: async () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
	} as unknown as AgentSession;
	const flushSpy = spyOn(telemetryExport, "flushTelemetryExport").mockImplementation(async () => {});
	const stderr: string[] = [];
	const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
		stderr.push(String(chunk));
		return true;
	}) as never);
	try {
		expect(await runPrintMode(session, { mode: "text", messages: ["continue"] })).toBe(1);
	} finally {
		stderrSpy.mockRestore();
		flushSpy.mockRestore();
	}
	return stderr.join("");
}

describe("print mode renders a failed turn's retry wait on stderr", () => {
	it("renders the wait from errorRetryAfterMs", async () => {
		expect(await printStderr(failedTurn("503 overloaded", 9000))).toContain("503 overloaded (retry after 9.0s)\n");
	});

	it("renders no wait without the field, leaving an old message's text unchanged", async () => {
		const stderr = await printStderr(failedTurn("503 overloaded retry-after-ms=9000"));
		expect(stderr).toContain("503 overloaded retry-after-ms=9000\n");
		expect(stderr).not.toContain("(retry after");
	});
});
