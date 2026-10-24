import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import helpGuide from "../help.md" with { type: "text" };

const PROMPTS_DIR = path.join(import.meta.dir, "..", "..", "..", "prompts");

describe("capability guide", () => {
	it("lists every prompt template the / picker offers", () => {
		const templates = fs
			.readdirSync(PROMPTS_DIR)
			.filter(name => name.endsWith(".md"))
			.map(name => name.slice(0, -3))
			.sort();
		expect(templates.length).toBeGreaterThan(0);
		const missing = templates.filter(name => !helpGuide.includes(`/${name}`));
		expect(missing).toEqual([]);
	});

	it("routes the three entry points a researcher arrives with", () => {
		const whereToStart = helpGuide.slice(
			helpGuide.indexOf("Where to start"),
			helpGuide.indexOf("Everything you can type"),
		);
		expect(whereToStart).toContain("/scope");
		expect(whereToStart).toContain("/import");
		expect(whereToStart).toContain("/litreview");
	});

	it("tells the reader plain sentences work too", () => {
		expect(helpGuide).toContain("You can also just type sentences");
	});
});
