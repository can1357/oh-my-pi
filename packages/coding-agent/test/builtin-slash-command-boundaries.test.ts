import { expect, test } from "bun:test";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";

const PK_SPEAK_COMMAND_NAMES = ["remote", "phone", "voice", "speak", "mono", "sess"] as const;

test("pk-speak extension command names are not reserved by builtins", () => {
	for (const name of PK_SPEAK_COMMAND_NAMES) {
		expect(
			BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(name),
			`Built-in slash command collides with pk-speak /${name}`,
		).toBe(false);
	}
});
