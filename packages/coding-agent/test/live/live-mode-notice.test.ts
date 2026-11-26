import { describe, expect, test } from "bun:test";
import { convertToLlm, LIVE_DELEGATION_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";

describe("live voice context for the coding agent", () => {
	test("the model receives a spoken request inside a voice notice; the stored message keeps the bare request", () => {
		const request = "read the names out loud";
		const stored = {
			role: "custom" as const,
			customType: LIVE_DELEGATION_MESSAGE_TYPE,
			content: request,
			display: true,
			attribution: "agent" as const,
			timestamp: 1,
		};
		const [delegated] = convertToLlm([stored]);
		const content = delegated?.content;
		const text =
			typeof content === "string"
				? content
				: (content ?? []).map(part => ("text" in part ? part.text : "")).join("");

		expect(text).toMatch(/^<system-notice>\n[\s\S]+\n<\/system-notice>\nread the names out loud$/);
		expect(stored.content).toBe(request);
	});
});
