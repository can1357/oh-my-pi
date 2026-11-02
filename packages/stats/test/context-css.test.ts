import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const CLIENT = path.join(import.meta.dir, "..", "src", "client");

async function read(file: string): Promise<string> {
	return fs.readFile(path.join(CLIENT, file), "utf8");
}

function definedTokens(css: string): Set<string> {
	const names = new Set<string>();
	for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) names.add(match[1]!);
	return names;
}

describe("context styles", () => {
	test("every var() without a fallback is defined by the theme or context sheet", async () => {
		const [context, styles] = await Promise.all([read("routes/context/context.css"), read("styles.css")]);
		const defined = new Set([...definedTokens(styles), ...definedTokens(context)]);
		const undeclared = [...context.matchAll(/var\((--[a-z0-9-]+)\)/gi)]
			.map(match => match[1]!)
			.filter(name => !defined.has(name));
		expect(undeclared).toEqual([]);
	});
});
