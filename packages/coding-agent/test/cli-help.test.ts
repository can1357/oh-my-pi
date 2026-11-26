import { describe, expect, test } from "bun:test";
import { getExtraHelpText } from "../src/cli/help-extra";

/** Names advertised as "NAME - description" lines in root help. */
function advertisedEnvVars(help: string): string[] {
	return [...help.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)\s+-\s/gm)].map(match => match[1]);
}

describe("root CLI help", () => {
	test("omits the unsupported Anthropic search base URL and keeps the search API key", () => {
		const help = getExtraHelpText();
		expect(help).not.toContain("ANTHROPIC_SEARCH_BASE_URL");
		expect(advertisedEnvVars(help)).toContain("ANTHROPIC_SEARCH_API_KEY");
	});
});
