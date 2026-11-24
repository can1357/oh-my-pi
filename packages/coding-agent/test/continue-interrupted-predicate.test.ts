import { describe, expect, it } from "bun:test";
import { createSyntheticToolResultMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import {
	findResumableAbortedAssistant,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	USER_INTERRUPT_LABEL,
} from "@oh-my-pi/pi-coding-agent/session/messages";

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	model: Model,
	content: AssistantMessage["content"],
	additions?: Partial<AssistantMessage>,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "aborted",
		timestamp: Date.now(),
		...additions,
	};
}

const model = {
	api: "mock",
	provider: "mock",
	id: "mock-model",
} as unknown as Model;

const interruptedThinking = {
	role: "custom",
	customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
	content: "continuity quote",
	display: false,
	timestamp: Date.now(),
} as const;

describe("findResumableAbortedAssistant", () => {
	it("returns the literal aborted user-interrupt assistant tail", () => {
		const messages = [
			userMessage("hello"),
			assistant(model, [{ type: "text", text: "partial" }], { errorMessage: USER_INTERRUPT_LABEL }),
		];
		expect(findResumableAbortedAssistant(messages)?.stopReason).toBe("aborted");
	});

	it("walks past a trailing interrupted-thinking continuity note", () => {
		const aborted = assistant(model, [{ type: "text", text: "partial" }], {
			errorMessage: USER_INTERRUPT_LABEL,
		});
		const messages = [userMessage("hello"), aborted, interruptedThinking];
		const found = findResumableAbortedAssistant(messages);
		expect(found).toBe(aborted);
	});

	it("walks past trailing synthetic tool_result placeholders", () => {
		const toolCall = { type: "toolCall" as const, id: "tool-1", name: "alpha", arguments: {} };
		const aborted = assistant(model, [toolCall], { errorMessage: USER_INTERRUPT_LABEL });
		const synthetic = createSyntheticToolResultMessage(toolCall, "aborted", USER_INTERRUPT_LABEL);
		const messages = [userMessage("hello"), aborted, interruptedThinking, synthetic];
		const found = findResumableAbortedAssistant(messages);
		expect(found).toBe(aborted);
	});

	it("rejects a settled assistant (non-aborted) tail", () => {
		const messages = [
			userMessage("hello"),
			assistant(model, [{ type: "text", text: "complete" }], { stopReason: "stop" }),
		];
		expect(findResumableAbortedAssistant(messages)).toBeUndefined();
	});

	it("rejects a silent abort (not a user interrupt)", () => {
		const messages = [
			userMessage("hello"),
			assistant(model, [{ type: "text", text: "partial" }], {
				errorMessage: "__omp.silent_abort__",
			}),
		];
		expect(findResumableAbortedAssistant(messages)).toBeUndefined();
	});

	it("rejects a bare lifecycle abort with no user-interrupt marker", () => {
		const messages = [
			userMessage("hello"),
			assistant(model, [{ type: "text", text: "partial" }], {
				errorMessage: "Request was aborted",
				stopReason: "aborted",
			}),
		];
		expect(findResumableAbortedAssistant(messages)).toBeUndefined();
	});

	it("returns undefined when the tail is not an assistant", () => {
		const messages = [userMessage("hello")];
		expect(findResumableAbortedAssistant(messages)).toBeUndefined();
	});
});
