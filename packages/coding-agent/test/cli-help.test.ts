import { describe, expect, test } from "bun:test";
import { getExtraHelpText } from "../src/cli/help-extra";

/** Names advertised as "NAME - description" lines in root help. */
function advertisedEnvVars(help: string): string[] {
	return [...help.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)\s+-\s/gm)].map(match => match[1]);
}

/** Unreleased notes this help fix must not claim. */
const UNRELATED_RELEASE_NOTES = [
	"Images reach each request as the receiving model needs them",
	"Edit cards in hashline, sloppy and magic modes",
	"Extensions importing `@oh-my-pi/omptype` resolve to the host's copy",
	"`--no-extensions` no longer imports custom tool modules",
	"Fixed `/fast off` and bare `/fast` claiming",
];

describe("root CLI help", () => {
	test("omits the unsupported Anthropic search base URL and keeps the search API key", async () => {
		const help = getExtraHelpText();
		expect(help).not.toContain("ANTHROPIC_SEARCH_BASE_URL");
		expect(advertisedEnvVars(help)).toContain("ANTHROPIC_SEARCH_API_KEY");

		const changelog = await Bun.file(new URL("../CHANGELOG.md", import.meta.url)).text();
		const unreleasedStart = changelog.indexOf("## [Unreleased]");
		const unreleasedEnd = changelog.indexOf("\n## [", unreleasedStart + 1);
		const unreleased = changelog.slice(unreleasedStart, unreleasedEnd === -1 ? undefined : unreleasedEnd);
		expect(UNRELATED_RELEASE_NOTES.filter(note => unreleased.includes(note))).toEqual([]);
	});
});
