import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("declarative subcommand completion", () => {
	it("gives the selected dropdown item the same ghost text as the closed-dropdown hint", async () => {
		const changelog = BUILTIN_SLASH_COMMANDS.find(command => command.name === "changelog");
		const items = await changelog?.getArgumentCompletions?.("la");
		const inlineHint = changelog?.getInlineHint?.("la") ?? undefined;

		expect(inlineHint).toBeTruthy();
		expect(items?.map(item => item.hint)).toEqual([inlineHint]);
	});
});
