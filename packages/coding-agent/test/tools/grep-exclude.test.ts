import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

describe("grep `!glob` exclusions", () => {
	let cwd: string;
	let tool: GrepTool;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-exclude-"));
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		tool = new GrepTool(session);
		for (const name of [
			"src/app.ts",
			"src/app.test.ts",
			"src/legacy/old.ts",
			"src/deep/legacy/kept.ts",
			"scripts/release.ts",
			"gen/schema.ts",
			"tools/gen/kept.ts",
			...Array.from({ length: 25 }, (_, index) => `vendor/pkg${index}/index.js`),
		]) {
			await Bun.write(path.join(cwd, name), "needle\n");
		}
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	const files = async (args: { path?: string }) =>
		(await tool.execute("exclude", { pattern: "needle", ...args })).details?.files ?? [];

	it("leaves out files and folders named by `!` entries", async () => {
		expect(await files({ path: "src;!*.test.ts" })).toEqual([
			"src/app.ts",
			"src/deep/legacy/kept.ts",
			"src/legacy/old.ts",
		]);
	});

	it("anchors an exclusion with a `/` to cwd instead of matching it at any depth", async () => {
		expect(await files({ path: "src;!src/legacy" })).toEqual([
			"src/app.test.ts",
			"src/app.ts",
			"src/deep/legacy/kept.ts",
		]);
		expect(await files({ path: "!./gen;!vendor" })).toEqual([
			"scripts/release.ts",
			"src/app.test.ts",
			"src/app.ts",
			"src/deep/legacy/kept.ts",
			"src/legacy/old.ts",
			"tools/gen/kept.ts",
		]);
	});

	it("searches cwd when every entry is an exclusion, without paging through excluded files", async () => {
		const result = await tool.execute("only-exclusions", { pattern: "needle", path: "!vendor;!gen;!*.test.ts" });
		expect(result.details?.files).toEqual([
			"scripts/release.ts",
			"src/app.ts",
			"src/deep/legacy/kept.ts",
			"src/legacy/old.ts",
		]);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).not.toContain("skip=");
	});

	it("still searches a real path whose name starts with `!`", async () => {
		await Bun.write(path.join(cwd, "!notes.txt"), "needle\n");
		expect(await files({ path: "!notes.txt" })).toEqual(["!notes.txt"]);
		await Bun.write(path.join(cwd, "!notes.txt"), "other\nneedle\n");
		const ranged = await tool.execute("ranged", { pattern: "needle", path: "!notes.txt:2-2" });
		expect(ranged.details?.files).toEqual(["!notes.txt"]);
	});

	it("reports a dangling `!` symlink as a path instead of searching cwd", async () => {
		if (process.platform === "win32") return;
		await fs.symlink(path.join(cwd, "missing-target"), path.join(cwd, "!link"));
		await expect(tool.execute("dangling", { pattern: "needle", path: "!link" })).rejects.toThrow("!link");
	});

	it("filters what it walks below a named path, never the named path itself, as `rg -g '!…'` does", async () => {
		expect(await files({ path: "vendor/pkg0;!vendor" })).toEqual(["vendor/pkg0/index.js"]);
		expect(await files({ path: "src/app.test.ts;!*.test.ts" })).toEqual(["src/app.test.ts"]);
		expect(await files({ path: "src;!src/*.test.ts" })).toEqual([
			"src/app.ts",
			"src/deep/legacy/kept.ts",
			"src/legacy/old.ts",
		]);
	});

	it("rebases Windows separators and keeps a child folder whose name starts with `..`", async () => {
		expect(await files({ path: "src;!src\\legacy" })).toEqual([
			"src/app.test.ts",
			"src/app.ts",
			"src/deep/legacy/kept.ts",
		]);
		await Bun.write(path.join(cwd, "..cache/hit.ts"), "needle\n");
		expect(await files({ path: ".;!./..cache;!vendor" })).not.toContain("..cache/hit.ts");
	});

	it("grants approval for searched roots only, keeping a real path whose name starts with `!`", async () => {
		await Bun.write(path.join(cwd, "!notes.txt"), "needle\n");
		const targets = (pathArg?: string) => tool.approvalCacheTargets(pathArg === undefined ? {} : { path: pathArg });
		// Any exclusion keys cwd too, since execution may search it; the named root is keyed as well.
		expect(targets("src;!*.test.ts")).toEqual([...(targets("src") ?? []), ...(targets(undefined) ?? [])]);
		expect(targets(";!vendor")).toEqual(targets(undefined));
		expect(targets("!vendor;!gen")).toEqual(targets(undefined));
		expect(targets("src;!notes.txt")).toEqual([...(targets("src") ?? []), ...(targets("!notes.txt") ?? [])]);
		expect(targets("src;!notes.txt")).not.toContain(targets(undefined)?.[0]);
		expect(targets("!notes.txt")).toHaveLength(1);
	});

	it("keys every path a list really searches, whatever its delimiters or quotes", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-exclude-outside-"));
		try {
			await Bun.write(path.join(outside, "s.txt"), "needle\n");
			const relativeOutside = path.relative(cwd, outside);
			const targets = (pathArg?: string) =>
				tool.approvalCacheTargets(pathArg === undefined ? {} : { path: pathArg });
			// The outside path is keyed; a list starting with an exclusion also keys cwd.
			expect(targets(`!nope,${relativeOutside}`)).toContain(targets(relativeOutside)?.[0]);
			expect(targets(`"!vendor;!gen"`)).toEqual(targets(undefined));
			// Execution keeps the comma inside braces and searches cwd, so cwd is keyed.
			expect(targets("!{vendor,gen}")).toEqual(targets(undefined));
			// Execution keeps `!vendor src` whole (one exclusion, since `!vendor` resolves to nothing) and searches cwd.
			expect(targets("!vendor src")).toContain(targets(undefined)?.[0]);
			// A list starting with an exclusion keys cwd, erring toward a prompt.
			expect(targets("!vendor gen-missing")).toEqual(targets(undefined));
			// Any exclusion keys cwd, beside a public URL too: erring toward a prompt.
			expect(targets("https://example.com/a.txt;!*.map")).toEqual(targets(undefined));
			// A real file whose name holds `;!` is searched whole, so it keys itself.
			await Bun.write(path.join(cwd, "report;!draft"), "needle\n");
			expect(targets("report;!draft")?.some(key => key.includes("report;!draft"))).toBe(true);
		} finally {
			await removeWithRetries(outside);
		}
	});
});
