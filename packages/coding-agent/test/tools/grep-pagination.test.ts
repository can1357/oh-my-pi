import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe("grep file pagination", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-pagination-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("pages files 20 at a time and caps an overflowing file's matches", async () => {
		const names = Array.from({ length: 25 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
		for (const name of names) await Bun.write(path.join(cwd, name), "needle\n");
		await Bun.write(path.join(cwd, "hot.txt"), Array.from({ length: 30 }, (_, index) => `needle ${index}`).join("\n"));
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tool = new GrepTool(session);

		const first = await tool.execute("page-1", { pattern: "needle", path: "." });
		expect(first.details?.files).toEqual(names.slice(0, 20));
		expect(textOf(first)).toContain("Showing files 1-20 of 26+. Use skip=20 for the next page");

		const second = await tool.execute("page-2", { pattern: "needle", path: ".", skip: 20 });
		expect(second.details?.files).toEqual([...names.slice(20), "hot.txt"]);
		const text = textOf(second);
		// The hot file keeps its first 20 matches.
		expect(text).toContain("needle 19");
		expect(text).not.toContain("needle 20");
		expect(text).not.toContain("skip=");
	});
});
