import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { convertToLlm, normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { CustomMessageEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("bare custom_message recovery", () => {
	it("drops poisoned custom messages before LLM conversion", () => {
		const messages: AgentMessage[] = JSON.parse(
			`[{"role":"custom","timestamp":1,"customType":"hook-warning","display":false}]`,
		);

		expect(convertToLlm(messages)).toEqual([]);
	});

	it("skips legacy bare custom_message entries while rebuilding context", () => {
		const entries: SessionEntry[] = JSON.parse(
			`[{"type":"custom_message","id":"1","parentId":null,"timestamp":"2026-07-02T00:00:00.000Z","attribution":"agent"}]`,
		);

		const context = buildSessionContext(entries);

		expect(context.messages).toEqual([]);
	});

	it("normalizes nullish custom message fields before persistence", () => {
		const session = SessionManager.inMemory();
		const malformed = JSON.parse("{}");

		const id = session.appendCustomMessageEntry(
			malformed.customType,
			malformed.content,
			malformed.display,
			undefined,
			malformed.attribution,
		);
		const entry = session.getBranch().find(entry => entry.id === id);

		expect(entry).toMatchObject({
			type: "custom_message",
			customType: "custom-message",
			content: "",
			display: false,
			attribution: "agent",
		} satisfies Partial<CustomMessageEntry>);
	});

	it("treats a bare string payload as visible custom message content", () => {
		expect(normalizeCustomMessagePayload("some warning")).toEqual({
			customType: "custom-message",
			content: "some warning",
			display: true,
			attribution: "agent",
		});
	});
});
