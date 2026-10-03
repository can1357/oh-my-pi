import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe("read tool local globs", () => {
	let tempDir: string;
	let session: ToolSession;
	let tool: ReadTool;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-globs-"));
		session = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "tools.xdev": false }),
		};
		tool = new ReadTool(session);
		await fs.mkdir(path.join(tempDir, "src", "directory.js"), { recursive: true });
		await Bun.write(path.join(tempDir, "src", "b.js"), "export const b = 2;\n");
		await Bun.write(path.join(tempDir, "src", "a.js"), "export const a = 1;\n");
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("expands files in path order with registered snapshot headers, excluding directories", async () => {
		const result = await tool.execute("read-glob", { path: "src/*.js" });
		const text = getText(result);
		expect(text).toContain("Note: expanded src/*.js to 2 files: src/a.js, src/b.js");
		expect(result.details?.displayReadTargets).toEqual(["src/a.js", "src/b.js"]);
		expect(result.details?.displayReadTargetLinks).toEqual([
			path.join(tempDir, "src", "a.js"),
			path.join(tempDir, "src", "b.js"),
		]);
		const headers = [...text.matchAll(/^\[src\/([ab])\.js#([0-9A-F]{4})\]/gm)];
		expect(headers.map(match => match[1])).toEqual(["a", "b"]);
		for (const match of headers) {
			expect(getEditStore(session).byHashText(path.join(tempDir, "src", `${match[1]}.js`), match[2])).toBe(
				`export const ${match[1]} = ${match[1] === "a" ? 1 : 2};\n`,
			);
		}
	});

	it("keeps directory-scoped globs nonrecursive and bare patterns recursive like glob", async () => {
		await Bun.write(path.join(tempDir, "src", "directory.js", "nested.js"), "nested fixture\n");
		const scoped = await tool.execute("read-scoped-glob", { path: "src/*.js" });
		expect(scoped.details?.displayReadTargets).toEqual(["src/a.js", "src/b.js"]);
		const bare = await tool.execute("read-bare-glob", { path: "*.js" });
		expect(bare.details?.displayReadTargets).toEqual(["src/a.js", "src/b.js", "src/directory.js/nested.js"]);
	});

	it("uses the same code folding as reading each file directly", async () => {
		tool = new ReadTool({
			...session,
			settings: Settings.isolated({
				"read.summarize.minTotalLines": 0,
				"read.summarize.unfoldUntil": 0,
				"read.summarize.unfoldLimit": 0,
			}),
		});
		const code = "export function run() {\n\tconst first = 1;\n\tconst second = 2;\n\treturn first + second;\n}\n";
		await Bun.write(path.join(tempDir, "src", "a.js"), code);
		await Bun.write(path.join(tempDir, "src", "b.js"), code.replace("run", "other"));
		const expanded = await tool.execute("read-folded-glob", { path: "src/*.js" });
		const plainA = await tool.execute("read-folded-a", { path: "src/a.js" });
		const plainB = await tool.execute("read-folded-b", { path: "src/b.js" });
		expect(getText(expanded)).toContain(getText(plainA));
		expect(getText(expanded)).toContain(getText(plainB));
		expect(getText(expanded)).toContain("elided");
	});

	it("mixes a plain file with multiple globs in a semicolon list", async () => {
		await Bun.write(path.join(tempDir, "package.json"), '{"name":"fixture"}\n');
		await fs.mkdir(path.join(tempDir, "test"));
		await Bun.write(path.join(tempDir, "test", "a.txt"), "test fixture\n");
		const result = await tool.execute("read-mixed", { path: "package.json;src/*.js;test/*" });
		const text = getText(result);
		expect(text).toContain("Note: interpreted as 3 paths: package.json, src/*.js, test/*");
		expect(text).toContain("Note: expanded src/*.js to 2 files: src/a.js, src/b.js");
		expect(text).toMatch(/^\[package\.json#[0-9A-F]{4}\]/m);
		expect(text).toMatch(/^\[test\/a\.txt#[0-9A-F]{4}\]/m);
		expect(result.details?.displayReadTargets).toEqual(["package.json", "src/a.js", "src/b.js", "test/a.txt"]);
		expect(result.details?.displayReadTargetLinks).toEqual([
			path.join(tempDir, "package.json"),
			path.join(tempDir, "src", "a.js"),
			path.join(tempDir, "src", "b.js"),
			path.join(tempDir, "test", "a.txt"),
		]);
	});

	it("throws a glob-specific ToolError when no files match", async () => {
		try {
			await tool.execute("read-missing-glob", { path: "src/*.missing" });
			throw new Error("Expected a glob error");
		} catch (error) {
			expect(error).toBeInstanceOf(ToolError);
			expect((error as Error).message).toContain("Glob 'src/*.missing' matched no files");
		}
	});

	it("reports zero matches when the search directory is missing or only directories match", async () => {
		await expect(tool.execute("read-missing-base", { path: "missing/*.js" })).rejects.toThrow(
			"Glob 'missing/*.js' matched no files",
		);
		await expect(tool.execute("read-directory-glob", { path: "src/directory*" })).rejects.toThrow(
			"Glob 'src/directory*' matched no files",
		);
	});

	it("keeps readable peers when a glob in a list has no matches", async () => {
		const result = await tool.execute("read-partial-glob", { path: "src/a.js;src/*.missing" });
		expect(getText(result)).toContain("export const a = 1;");
		expect(getText(result)).toContain("Could not read src/*.missing: Glob 'src/*.missing' matched no files");
		expect(result.details?.displayReadTargetLinks).toEqual([path.join(tempDir, "src", "a.js"), null]);
	});

	it("caps each glob at the first 50 sorted files and reports the exact omitted count", async () => {
		await fs.mkdir(path.join(tempDir, "many"));
		const targets = Array.from({ length: 55 }, (_, index) => `many/${String(index).padStart(2, "0")}.txt`);
		await Promise.all(targets.toReversed().map(target => Bun.write(path.join(tempDir, target), `${target}\n`)));
		const result = await tool.execute("read-capped-glob", { path: "many/*.txt" });
		const text = getText(result);
		expect(result.details?.displayReadTargets).toEqual(targets.slice(0, 50));
		expect(text).toContain("Note: expanded many/*.txt to 50 files:");
		expect(text).toContain("5 files omitted");
		expect(text).toMatch(/[Nn]arrow.*glob/);
		expect(text).not.toMatch(/^\[many\/50\.txt#/m);
		expect(result.details?.notes?.join("\n")).toContain("5 files omitted");
	});

	it("respects gitignore and excludes node_modules in a repository", async () => {
		await fs.mkdir(path.join(tempDir, ".git"));
		await Bun.write(path.join(tempDir, ".gitignore"), "ignored/\nnode_modules/\nsrc/b.js\n");
		await fs.mkdir(path.join(tempDir, "ignored"));
		await fs.mkdir(path.join(tempDir, "node_modules"));
		await Bun.write(path.join(tempDir, "ignored", "secret.js"), "ignored secret\n");
		await Bun.write(path.join(tempDir, "node_modules", "dependency.js"), "dependency\n");
		const result = await tool.execute("read-ignored-glob", { path: "**/*.js" });
		expect(result.details?.displayReadTargets).toEqual(["src/a.js"]);
		expect(getText(result)).not.toContain("ignored secret");
		expect(getText(result)).not.toContain("dependency");
	});

	it("includes hidden files like the glob tool defaults", async () => {
		await Bun.write(path.join(tempDir, "src", ".hidden.js"), "hidden fixture\n");
		const result = await tool.execute("read-hidden-glob", { path: "src/*.js" });
		expect(result.details?.displayReadTargets).toEqual(["src/.hidden.js", "src/a.js", "src/b.js"]);
	});

	it("reads literal filenames containing glob characters instead of expanding them", async () => {
		await Bun.write(path.join(tempDir, "src", "[ab].js"), "literal fixture\n");
		const result = await tool.execute("read-literal-glob", { path: "src/[ab].js" });
		expect(getText(result)).toContain("literal fixture");
		expect(getText(result)).not.toContain("Note: expanded");
		expect(result.details?.meta?.source).toEqual({ type: "path", value: path.join(tempDir, "src", "[ab].js") });
	});

	it("preserves literal glob-character filenames when a line selector is supplied", async () => {
		await Bun.write(path.join(tempDir, "src", "[ab].js"), "literal first\nliteral second\n");
		const result = await tool.execute("read-literal-selector", { path: "src/[ab].js:1-1" });
		expect(getText(result)).toContain("literal first");
		expect(getText(result)).not.toContain("Note: expanded");
		expect(getText(result)).not.toContain("export const a = 1;");
	});

	it("keeps archive member handling ahead of filesystem glob expansion", async () => {
		await writeArchive(path.join(tempDir, "fixture.zip"), "zip", [["[ab].txt", "archive literal member\n"]]);
		const result = await tool.execute("read-archive-member", { path: "fixture.zip:[ab].txt" });
		expect(getText(result)).toContain("archive literal member");
		expect(getText(result)).not.toContain("Note: expanded");
		await expect(tool.execute("read-missing-archive-member", { path: "fixture.zip:*.missing" })).rejects.toThrow(
			"not found inside archive",
		);
	});

	it("preserves literal directories containing glob characters", async () => {
		await fs.mkdir(path.join(tempDir, "[src]"));
		await Bun.write(path.join(tempDir, "[src]", "note.txt"), "literal directory\n");
		const result = await tool.execute("read-literal-directory", { path: "[src]" });
		expect(result.details?.isDirectory).toBe(true);
		expect(getText(result)).toContain("note.txt");
		expect(getText(result)).not.toContain("Note: expanded");
	});

	it("applies a line selector to each expanded file using normal range behavior", async () => {
		await Bun.write(path.join(tempDir, "src", "a.js"), "a1\na2\na3\na4\na5\na6\n");
		await Bun.write(path.join(tempDir, "src", "b.js"), "b1\nb2\nb3\nb4\nb5\nb6\n");
		const result = await tool.execute("read-glob-selector", { path: "src/*.js:1-2" });
		const plainA = await tool.execute("read-a-selector", { path: "src/a.js:1-2" });
		const plainB = await tool.execute("read-b-selector", { path: "src/b.js:1-2" });
		expect(getText(result)).toContain(getText(plainA));
		expect(getText(result)).toContain(getText(plainB));
		expect(getText(result)).not.toContain("a6");
		expect(getText(result)).not.toContain("b6");
	});

	it.each(["1,10", "1-2,10-11", "raw:1-2,10-11", "1-2,10-11:raw"])(
		"preserves comma-separated selectors on each glob match: %s",
		async selector => {
			for (const name of ["a", "b"]) {
				await Bun.write(
					path.join(tempDir, "src", `${name}.txt`),
					Array.from({ length: 15 }, (_, index) => `${name} selected line ${index + 1}`).join("\n"),
				);
			}
			const globPath = selector === "1,10" && process.platform === "win32" ? "src\\*.txt" : "src/*.txt";
			const result = await tool.execute("read-multirange-glob", { path: `${globPath}:${selector}` });
			for (const name of ["a", "b"]) {
				const direct = await tool.execute(`read-${name}-multirange`, { path: `src/${name}.txt:${selector}` });
				expect(getText(result)).toContain(getText(direct));
				expect(getText(result)).not.toContain(`${name} selected line 6`);
			}
			expect(getText(result)).not.toContain("Could not read");
			expect(result.details?.displayReadTargets).toEqual([`src/a.txt:${selector}`, `src/b.txt:${selector}`]);
		},
	);

	it("preserves comma selectors in a semicolon list of globs", async () => {
		await fs.mkdir(path.join(tempDir, "other"));
		for (const directory of ["src", "other"]) {
			await Bun.write(
				path.join(tempDir, directory, "fixture.txt"),
				Array.from({ length: 15 }, (_, index) => `${directory} selected line ${index + 1}`).join("\n"),
			);
		}
		const result = await tool.execute("read-mixed-multirange", { path: "src/*.txt:1,10;other/*.txt:2,9" });
		for (const [directory, selector] of [
			["src", "1,10"],
			["other", "2,9"],
		]) {
			const direct = await tool.execute("read-direct-multirange", { path: `${directory}/fixture.txt:${selector}` });
			expect(getText(result)).toContain(getText(direct));
			expect(getText(result)).not.toContain(`${directory} selected line 6`);
		}
		expect(getText(result)).not.toContain("Could not read");
		expect(result.details?.displayReadTargets).toEqual(["src/fixture.txt:1,10", "other/fixture.txt:2,9"]);
	});

	it("reads www-prefixed glob matches as local files with fetch disabled", async () => {
		await Bun.write(path.join(tempDir, "www.fixture.txt"), "local www fixture\n");
		tool = new ReadTool({ ...session, settings: Settings.isolated({ "fetch.enabled": false }) });
		const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Local glob reads must not fetch"));
		try {
			const direct = await tool.execute("read-local-www", { path: "./www.fixture.txt" });
			for (const target of ["*.txt", "*.txt:1-1"]) {
				const result = await tool.execute("read-glob-www", { path: target });
				expect(getText(result)).toContain(getText(direct));
				expect(getText(result)).not.toContain("Could not read");
				expect(getText(result)).not.toContain("URL reads are disabled");
				expect(result.details?.displayReadTargets).toEqual([
					target.includes(":") ? "www.fixture.txt:1-1" : "www.fixture.txt",
				]);
				expect(result.details?.displayReadTargetLinks).toEqual([path.join(tempDir, "www.fixture.txt")]);
			}
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("preserves comma selectors on glob paths containing spaces", async () => {
		await fs.mkdir(path.join(tempDir, "folder with spaces"));
		await Bun.write(path.join(tempDir, "folder with spaces", "fixture.txt"), "first\nsecond\nthird\n");
		const result = await tool.execute("read-spaced-glob", { path: "folder with spaces/*.txt:raw:1,3" });
		expect(getText(result)).toContain("first\n\n…\n\nthird");
		expect(getText(result)).not.toContain("second");
		expect(getText(result)).not.toContain("Could not read");
	});

	it("keeps semicolon and glob-character literal names ahead of comma selectors", async () => {
		await Bun.write(path.join(tempDir, "src", "a;b[1].txt"), "first\nsecond\nthird\n");
		const result = await tool.execute("read-delimited-literal", { path: "src/a;b[1].txt:raw:1,3" });
		expect(getText(result)).toBe("first\n\n…\n\nthird");
		expect(getText(result)).not.toContain("Note: expanded");
		expect(getText(result)).not.toContain("interpreted as");
	});

	it("supports absolute glob paths", async () => {
		const result = await tool.execute("read-absolute-glob", { path: `${tempDir.replace(/\\/g, "/")}/src/*.js` });
		expect(getText(result)).toMatch(/^\[src\/a\.js#[0-9A-F]{4}\]/m);
		expect(result.details?.displayReadTargetLinks).toEqual([
			path.join(tempDir, "src", "a.js"),
			path.join(tempDir, "src", "b.js"),
		]);
	});

	it("lets a missing bracketed route path recover by suffix instead of failing as a glob", async () => {
		const route = path.join(tempDir, "apps", "web", "app", "[slug]", "page.tsx");
		await Bun.write(route, "export default function Page() {}\n");
		for (const requested of ["web/app/[slug]/page.tsx", "app/[slug]/page.tsx"]) {
			const text = getText(await tool.execute("read-route", { path: requested }));
			expect(text).toContain(
				`[Path '${requested}' not found; resolved to 'apps/web/app/[slug]/page.tsx' via suffix match]`,
			);
			expect(text).toContain("export default function Page()");
		}
	});
});
