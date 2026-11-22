import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEditMode } from "@oh-my-pi/pi-coding-agent/edit/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { cfgReadLineNumbers } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map(c => c.text)
		.join("\n");
}

function rawSuffixHelp(description: string): string {
	const line = description.split("\n").find(entry => entry.trimStart().startsWith("- :raw "));
	if (!line) throw new Error(`Missing :raw suffix line in description:\n${description}`);
	return line;
}

function makeSession(
	cwd: string,
	options: {
		editMode?: "hashline" | "replace" | "patch";
		readLineNumbers?: boolean;
		hasEditTool?: boolean;
	} = {},
): ToolSession {
	const settings = Settings.isolated({
		"edit.mode": options.editMode ?? "hashline",
		readLineNumbers: options.readLineNumbers ?? false,
		"read.summarize.enabled": false,
	});
	return {
		cwd,
		hasUI: false,
		hasEditTool: options.hasEditTool,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

describe("ReadTool.description matches active line-prefix mode", () => {
	let testDir: string;
	let filePath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-description-"));
		filePath = path.join(testDir, "example.py");
		await Bun.write(filePath, "alpha = 1\nbeta = 2\n");
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("describes anchors and prefixes only in hashline mode", async () => {
		const tool = new ReadTool(makeSession(testDir, { editMode: "hashline", hasEditTool: true }));
		const rawHelp = rawSuffixHelp(tool.description);
		expect(rawHelp).toContain("anchors");
		expect(rawHelp).toContain("prefixes");

		const body = textOutput(await tool.execute("read-hl", { path: filePath }));
		expect(body).toMatch(/^\[\S+#[0-9A-Z]+\]\n1:alpha = 1\n2:beta = 2$/);
	});

	it.each([
		{ label: "read-only session", hasEditTool: false, editMode: "hashline" as const },
		{ label: "replace edit mode", hasEditTool: true, editMode: "replace" as const },
	])(
		"describes line prefixes without anchors when only readLineNumbers is enabled ($label)",
		async ({ hasEditTool, editMode }) => {
			const tool = new ReadTool(makeSession(testDir, { editMode, hasEditTool, readLineNumbers: true }));
			const rawHelp = rawSuffixHelp(tool.description);
			expect(rawHelp).toContain("prefixes");
			expect(rawHelp).not.toContain("anchors");

			const body = textOutput(await tool.execute("read-ln", { path: filePath }));
			expect(body).toBe("1|alpha = 1\n2|beta = 2");
		},
	);

	it.each([
		{ label: "read-only session", hasEditTool: false, editMode: "hashline" as const },
		{ label: "replace edit mode", hasEditTool: true, editMode: "replace" as const },
	])(
		"omits anchors and prefixes wording when neither hashlines nor line numbers are active ($label)",
		async ({ hasEditTool, editMode }) => {
			const tool = new ReadTool(makeSession(testDir, { editMode, hasEditTool, readLineNumbers: false }));
			const rawHelp = rawSuffixHelp(tool.description);
			expect(rawHelp).not.toContain("anchors");
			expect(rawHelp).not.toContain("prefixes");

			const body = textOutput(await tool.execute("read-plain", { path: filePath }));
			expect(body).toBe("alpha = 1\nbeta = 2");
		},
	);

	it("updates description dynamically when display settings change", () => {
		const session = makeSession(testDir, { editMode: "replace", readLineNumbers: false });
		const tool = new ReadTool(session);

		expect(rawSuffixHelp(tool.description)).not.toContain("anchors");
		expect(rawSuffixHelp(tool.description)).not.toContain("prefixes");

		cfgReadLineNumbers.override(session.settings, true);
		expect(rawSuffixHelp(tool.description)).toContain("prefixes");
		expect(rawSuffixHelp(tool.description)).not.toContain("anchors");

		cfgEditMode.override(session.settings, "hashline");
		expect(rawSuffixHelp(tool.description)).toContain("anchors");
		expect(rawSuffixHelp(tool.description)).toContain("prefixes");
	});
});
