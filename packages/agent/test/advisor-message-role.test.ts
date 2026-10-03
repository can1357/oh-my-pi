import { describe, expect, test } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { convertMessageToLlm, defaultConvertToLlm } from "../src/compaction/messages";
import type { AgentMessage } from "../src/types";

describe("advisor message role in core conversion", () => {
	test.each(["user", "developer"] as const)(
		"preserves saved %s role in provider and compaction conversion",
		messageRole => {
			const message: AgentMessage = {
				role: "custom",
				customType: "advisor",
				content: "review",
				display: true,
				details: { notes: [], messageRole },
				attribution: "agent",
				timestamp: 1,
			};
			const expected: Message = {
				role: messageRole,
				content: [{ type: "text", text: "review" }],
				attribution: "agent",
				timestamp: 1,
			};
			expect(convertMessageToLlm(message)).toEqual(expected);
			expect(defaultConvertToLlm([message])).toEqual([expected]);
		},
	);

	test("legacy and malformed advisor metadata defaults to developer with agent attribution", () => {
		for (const details of [undefined, null, "user", [], {}, { messageRole: "system" }, { messageRole: 1 }]) {
			const message: AgentMessage = {
				role: "custom",
				customType: "advisor",
				content: "review",
				display: true,
				details,
				timestamp: 1,
			};
			expect(convertMessageToLlm(message)).toMatchObject({ role: "developer", attribution: "agent" });
		}
	});

	test.each(["custom", "hookMessage"] as const)("leaves unrelated %s conversion unchanged", role => {
		expect(
			convertMessageToLlm({
				role,
				customType: "context",
				content: "context",
				display: false,
				details: { messageRole: "user" },
				timestamp: 1,
			}),
		).toMatchObject({ role: "developer", attribution: undefined });
	});
});
