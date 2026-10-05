import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { parseArgs } from "../../src/cli/args";
import { createPrintPromptResults } from "../../src/modes/print-mode";

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

function session() {
	return {
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		hasPendingAsyncWork: () => false,
		agent: { hasQueuedMessages: () => false },
	};
}

describe("cross-session print admission", () => {
	test("CLI flags keep the requested address separate from the prompt", () => {
		const parsed = parseArgs(["--cross-session", "--name=release notes", "--print", "answer this"]);
		expect(parsed.crossSession).toBe(true);
		expect(parsed.name).toBe("release notes");
		expect(parsed.messages).toEqual(["answer this"]);
		expect(parsed.unrecognizedFlags).toEqual([]);
	});

	test("a message turn during preparation cannot replace the CLI prompt's own answer", () => {
		const results = createPrintPromptResults(session());
		const answers: Array<AssistantMessage | undefined> = [];
		const ticket = results.begin(undefined, message => answers.push(message));
		results.observe({ type: "agent_start" });
		results.observe({ type: "agent_end", messages: [assistant("unrelated before admission")] });
		results.admit(ticket);
		results.observe({ type: "agent_start" });
		const ownAnswer = assistant("CLI answer");
		results.observe({ type: "agent_end", messages: [ownAnswer] });
		results.observe({ type: "agent_start" });
		results.observe({ type: "agent_end", messages: [assistant("unrelated after answer")] });
		results.settle(ticket);
		results.settle(ticket);
		expect(answers).toEqual([ownAnswer]);
	});

	test("answer completion runs synchronously at yield despite passive next-turn reminders", () => {
		const state = session();
		state.isStreaming = true;
		state.queuedMessageCount = 1;
		const results = createPrintPromptResults(state);
		let cutoff = false;
		const answer = assistant("owned queued answer");
		const ticket = results.begin(undefined, message => {
			expect(message).toBe(answer);
			cutoff = true;
		});
		results.settle(ticket);
		results.observe({ type: "agent_end", messages: [answer], yielded: true });
		expect(cutoff).toBe(true);
	});
});
