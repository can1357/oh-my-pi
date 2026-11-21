import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { countUserTurns, extractMessages } from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import { stripImagesFromMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

describe("countUserTurns", () => {
	it("recounts a user message after its images are stripped in place", () => {
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			timestamp: 0,
		};
		const entry: SessionMessageEntry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message,
		};
		const session = { getEntries: () => [entry] };

		const before = countUserTurns(session);
		expect(before).toBe(extractMessages(session).filter(m => m.role === "user").length);

		expect(stripImagesFromMessage(message)).toBe(1);

		const userCount = extractMessages(session).filter(m => m.role === "user").length;
		expect(userCount).toBe(1);
		expect(countUserTurns(session)).toBe(userCount);
	});
});
