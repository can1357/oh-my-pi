import { describe, expect, it } from "bun:test";
import {
	BUILTIN_SLASH_COMMANDS,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";

describe("/clear slash command", () => {
	it("resolves /clear to the context reset command and removed /clear alias from /new", async () => {
		const provider = new CombinedAutocompleteProvider(
			[...BUILTIN_SLASH_COMMANDS, { name: "autoresearch", description: "Clear stale research results" }],
			process.cwd(),
		);

		const suggestions = await provider.getSuggestions(["/clear"], 0, 6);

		expect(suggestions?.items[0]).toMatchObject({
			value: "clear",
			description: "Clear the conversation context in place, keeping the session",
		});
		expect(lookupBuiltinSlashCommand("clear")?.name).toBe("clear");
		expect(lookupBuiltinSlashCommand("new")?.aliases).toBeUndefined();
		expect(lookupBuiltinSlashCommand("reset")).toBeUndefined();
	});
});
