import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { getExtraHelpText } from "../src/cli/help-extra";

const docsPath = path.resolve(import.meta.dir, "../../../docs/environment-variables.md");

/** Names of the variables the root help lists, as written in its "NAME - description" lines. */
function advertisedEnvVars(): string[] {
	const help = getExtraHelpText();
	const names = [...help.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)\s+-\s/gm)].map(match => match[1]);
	return [...new Set(names)];
}

describe("root CLI help environment variables", () => {
	test("advertises only variables that the environment variable reference documents", async () => {
		const docs = await Bun.file(docsPath).text();
		const undocumented = advertisedEnvVars().filter(name => !docs.includes(`\`${name}\``));
		expect(undocumented).toEqual([]);
	});
});
