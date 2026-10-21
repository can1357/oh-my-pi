import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeText, sanitizeTextDeep } from "@oh-my-pi/pi-utils";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { astEditToolRenderer, type AstEditToolDetails } from "../src/tools/ast-edit";
import { getThemeByName, initTheme, type Theme } from "../src/theme";

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme missing");
	uiTheme = theme;
});

afterEach(() => applyHyperlinkSetting("auto"));

function render(rawDetails: AstEditToolDetails, displayContent: string, useRawDetails = true): string {
	const details = { ...(sanitizeTextDeep(rawDetails) as AstEditToolDetails), displayContent };
	return astEditToolRenderer
		.renderResult(
			{ content: [], details },
			{
				expanded: true,
				isPartial: false,
				...(useRawDetails ? { renderContext: { rawDetails } } : {}),
			},
			uiTheme,
		)
		.render(160)
		.join("\n");
}

function linkUris(output: string): string[] {
	return [...output.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

describe("AST edit file hyperlinks", () => {
	it("retains original control-byte paths for existing directory and file links while keeping labels sanitized", () => {
		applyHyperlinkSetting("always");
		const cwd = "/tmp/project-\x01";
		const rawContent = [
			"# source-\x1b[31mroot\x02/",
			"## file-\x1b[32mname\x7f.ts (1 replacement)",
			"-1│before",
			"+1│after",
			"",
			"## nested-\x03/",
			"### deep.ts (1 replacement)",
			"-2│old",
			"+2│new",
		].join("\n");
		const details: AstEditToolDetails = {
			totalReplacements: 2,
			filesTouched: 2,
			filesSearched: 2,
			applied: false,
			limitReached: false,
			cwd,
			searchPath: cwd,
			displayContent: rawContent,
		};
		const output = render(details, sanitizeText(rawContent));
		const directory = path.join(cwd, "source-\x1b[31mroot\x02");
		expect(linkUris(output)).toEqual([
			pathToFileURL(directory).href,
			pathToFileURL(path.join(directory, "file-\x1b[32mname\x7f.ts")).href,
			pathToFileURL(path.join(directory, "nested-\x03")).href,
			pathToFileURL(path.join(directory, "nested-\x03", "deep.ts")).href,
		]);
		const labels = output.replace(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\/g, "");
		expect(labels).not.toMatch(/[\x01-\x03\x7f]/);
		expect(labels).not.toContain("\x1b[31m");
		expect(labels).not.toContain("\x1b[32m");
		expect(Bun.stripANSI(output)).toContain("file-name.ts");
	});

	it("keeps sanitized targets when original grouped output no longer aligns", () => {
		applyHyperlinkSetting("always");
		const rawDetails: AstEditToolDetails = {
			totalReplacements: 1,
			filesTouched: 1,
			filesSearched: 1,
			applied: false,
			limitReached: false,
			cwd: "/tmp",
			displayContent: "# unrelated-\x01.ts (1 replacement)\n-1│old\n+1│new",
		};
		const output = render(rawDetails, "# actual.ts (1 replacement)\n-1│old\n+1│new");
		expect(linkUris(output)).toEqual([pathToFileURL("/tmp/actual.ts").href]);
		expect(linkUris(render(rawDetails, sanitizeText(rawDetails.displayContent!), false))).toEqual([
			pathToFileURL("/tmp/unrelated-.ts").href,
		]);
	});
});
