import { afterEach, expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import { runPrintMode } from "../../src/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import * as messagingHost from "../../src/session/messaging-host";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

afterEach(() => vi.restoreAllMocks());

test("enabled print closes inbound admission before draining and prints its own answer, not a later message turn", async () => {
	const ordering: string[] = [];
	const output: string[] = [];
	const ownAnswer = assistant("CLI answer");
	const laterAnswer = assistant("answer to another session");
	let lastAssistant = ownAnswer;
	let subscriber: ((event: AgentSessionEvent) => void) | undefined;
	vi.spyOn(messagingHost, "bindSessionMessaging").mockImplementation(async (_session, opts) => {
		expect(opts.directPrint).toBe(false);
		expect(opts.claimNames).toBe(false);
		ordering.push("bind");
		return {
			ready: () => ordering.push("ready"),
			dispose: async () => {
				ordering.push("cutoff");
			},
		};
	});
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, callback?: (error?: Error) => void) => {
		output.push(String(chunk));
		callback?.();
		return true;
	}) as never);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const session = {
		settings: Settings.isolated(),
		extensionRunner: undefined,
		messaging: {},
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		agent: { hasQueuedMessages: () => false },
		hasPendingAsyncWork: () => false,
		sessionManager: {
			getHeader: () => undefined,
			setSessionName: async () => {
				ordering.push("name");
			},
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			ordering.push("subscribe");
			subscriber = listener;
			return () => {};
		},
		prompt: async (_text: string, opts: { onPromptAdmitted?: () => void }) => {
			ordering.push("prompt");
			opts.onPromptAdmitted?.();
			subscriber?.({ type: "agent_start" });
			subscriber?.({ type: "agent_end", messages: [ownAnswer], yielded: true });
			return true;
		},
		waitForIdle: async () => {
			ordering.push("drain");
			lastAssistant = laterAnswer;
			subscriber?.({ type: "agent_start" });
			subscriber?.({ type: "agent_end", messages: [laterAnswer], yielded: true });
		},
		getLastAssistantMessage: () => lastAssistant,
		setTextOutputCommitted: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {
			ordering.push("session-dispose");
		},
	} as unknown as AgentSession;
	const exitCode = await runPrintMode(session, { mode: "text", name: "release", initialMessage: "answer me" });
	expect(exitCode).toBe(0);
	expect(output.join("")).toBe("CLI answer\n");
	expect(ordering.indexOf("subscribe")).toBeLessThan(ordering.indexOf("ready"));
	expect(ordering.indexOf("ready")).toBeLessThan(ordering.indexOf("prompt"));
	expect(ordering.indexOf("cutoff")).toBeLessThan(ordering.indexOf("drain"));
	expect(ordering.indexOf("cutoff")).toBeLessThan(ordering.indexOf("session-dispose"));
});
