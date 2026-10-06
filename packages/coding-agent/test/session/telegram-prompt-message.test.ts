/**
 * `telegram-prompt` (a Telegram sender's prompt relayed into an attached TUI
 * session) must reach the model exactly as `collab-prompt` does: the user's own
 * message, steering-enveloped whether it arrives as a follow-up or a steer, and
 * a user turn initiator for the transcript.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import {
	convertToLlm,
	isUserTurnInitiator,
	TELEGRAM_PROMPT_MESSAGE_TYPE,
	wrapSteeringForModel,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";

function userText(message: Message | AgentMessage | undefined): string {
	if (message?.role !== "user") throw new Error("Expected a user message");
	return typeof message.content === "string"
		? message.content
		: message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function telegramPrompt(over: Partial<Extract<AgentMessage, { role: "custom" }>> = {}): AgentMessage {
	return {
		role: "custom",
		customType: TELEGRAM_PROMPT_MESSAGE_TYPE,
		content: "Reply with exactly PONG",
		display: true,
		details: { from: "Alice" },
		attribution: "user",
		timestamp: 1,
		...over,
	};
}

describe("telegram prompt model conversion", () => {
	it("presents a user-attributed telegram prompt as a wrapped user turn on every conversion path", () => {
		const message = telegramPrompt();

		const directlyConverted = convertToLlm([message]);
		const wrapped = wrapSteeringForModel([message]);
		const primaryProviderMessages = convertToLlm(wrapped);

		expect(directlyConverted).toHaveLength(1);
		expect(directlyConverted[0]?.role).toBe("user");
		expect(userText(directlyConverted[0])).toContain("<system-notice>");
		expect(userText(directlyConverted[0])).toContain("Reply with exactly PONG");
		expect(wrapped[0]?.role).toBe("user");
		expect(userText(wrapped[0])).toContain("Reply with exactly PONG");
		expect(primaryProviderMessages).toHaveLength(1);
		expect(primaryProviderMessages[0]?.role).toBe("user");
		// The persisted entry is never rewritten by the conversion.
		expect(message).toMatchObject({ role: "custom", details: { from: "Alice" } });
	});

	it("reaches the model identically to the collab prompt it mirrors", () => {
		const content = [{ type: "text" as const, text: "hello from the peer" }];
		const collab: AgentMessage = {
			role: "custom",
			customType: COLLAB_PROMPT_MESSAGE_TYPE,
			content,
			display: true,
			details: { from: "guest" },
			attribution: "user",
			timestamp: 7,
		};
		const telegram = telegramPrompt({ content, timestamp: 7 });

		expect(convertToLlm([telegram])).toEqual(convertToLlm([collab]));
	});

	it("drops an agent-attributed telegram prompt from the user conversation", () => {
		const converted = convertToLlm([telegramPrompt({ attribution: "agent" })]);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("developer");
	});
});

describe("telegram prompt turn attribution", () => {
	it("counts as a user turn initiator only when attributed to the user", () => {
		const userMessage = telegramPrompt();
		const agentMessage = telegramPrompt({ attribution: "agent" });
		if (userMessage.role !== "custom" || agentMessage.role !== "custom") {
			throw new Error("Expected custom messages");
		}

		expect(isUserTurnInitiator(userMessage)).toBe(true);
		expect(isUserTurnInitiator(agentMessage)).toBe(false);
	});
});
