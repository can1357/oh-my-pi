import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMANDS } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@pk-nerdsaver-ai/pi-tui";

/**
 * Behavioral regression coverage for the `/fusion ` argument menu: a direct
 * `token-savings` choice must lead the menu (visible without scrolling) ahead
 * of the declarative subcommand list, and accepting it must insert the valid
 * `mode token-savings` command (pi-tui replaces the argument prefix with the
 * item's value, so a multi-word value is what makes the insertion work).
 */
describe("/fusion argument completion", () => {
	const fusion = BUILTIN_SLASH_COMMANDS.find(c => c.name === "fusion");
	const getCompletions = (prefix: string) => fusion?.getArgumentCompletions?.(prefix) ?? null;

	it("is wired to the /fusion command", () => {
		expect(typeof fusion?.getArgumentCompletions).toBe("function");
	});

	it("offers a direct token-savings choice first on `/fusion ` with a clear description", async () => {
		const items = await getCompletions("");
		const direct = items?.find(item => item.label === "token-savings");
		expect(direct).toBeDefined();
		expect(direct?.value).toBe("mode token-savings ");
		expect(direct?.description).toBe("Use token-saving model routing");
	});

	it("lists the direct choice first, preserving the existing options' relative order", async () => {
		const items = await getCompletions("");
		expect(items?.map(item => item.label)).toEqual([
			"token-savings",
			"autonomous",
			"on",
			"off",
			"status",
			"mode",
			"routing",
			"sidekick",
			"strong",
			"compact",
			"pool",
		]);
	});

	it("keeps nested mode subcommand completion intact", async () => {
		const items = await getCompletions("m");
		expect(items?.map(item => item.label)).toEqual(["mode"]);
	});

	it("filters the direct choice by typed prefix", async () => {
		const byPrefix = await getCompletions("to");
		expect(byPrefix?.map(item => item.label)).toEqual(["token-savings"]);
		expect(await getCompletions("zzz")).toBeNull();
	});

	it("stays null past the subcommand token (nested argument level unchanged)", async () => {
		expect(await getCompletions("mode ")).toBeNull();
	});

	it("inserts the valid mode token-savings command through the real provider", async () => {
		const provider = new CombinedAutocompleteProvider([fusion!]);
		const lines = ["/fusion "];
		const cursorCol = "/fusion ".length;
		const suggestions = await provider.getSuggestions(lines, 0, cursorCol);
		expect(suggestions).not.toBeNull();
		const direct = suggestions!.items.find(item => item.value === "mode token-savings ");
		expect(direct).toBeDefined();
		const applied = provider.applyCompletion(lines, 0, cursorCol, direct!, suggestions!.prefix);
		expect(applied.lines[0]).toBe("/fusion mode token-savings ");
		expect(applied.cursorCol).toBe("/fusion mode token-savings ".length);
	});
});
