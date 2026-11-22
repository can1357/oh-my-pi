import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { ContentSearch } from "../../src/tools/jfind/content-search";

describe("grep with no matches outside .gitignore", () => {
	let cwd: string;
	let tool: ContentSearch;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-gitignore-"));
		await fs.mkdir(path.join(cwd, ".git"));
		await Bun.write(path.join(cwd, ".gitignore"), "plans/\n");
		await Bun.write(path.join(cwd, "docs/index.md"), "nothing here\n");
		await Bun.write(path.join(cwd, "docs/plans/fs-4006.md"), "FS-4006 persistence decision\n");
		tool = new ContentSearch({
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		});
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	const text = async (args: { pattern: string; gitignore?: boolean }) => {
		const result = await tool.execute("gitignore", { path: "docs", ...args });
		return result.content[0]?.type === "text" ? result.content[0].text : "";
	};

	it("says when gitignored files would have matched", async () => {
		expect(await text({ pattern: "FS-4006" })).toBe(
			"No matches found\nGitignored files match (e.g. docs/plans/fs-4006.md); pass `gitignore: false` to search them.",
		);
		expect(await text({ pattern: "FS-4006", gitignore: false })).toContain("FS-4006 persistence decision");
	});

	it("stays a plain no-match when ignored files do not match either", async () => {
		expect(await text({ pattern: "absent-everywhere" })).toBe("No matches found");
	});
});
