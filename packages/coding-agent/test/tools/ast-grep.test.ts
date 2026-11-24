import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { astGrepToolRenderer } from "@oh-my-pi/pi-tui/tools/ast-grep";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createTestSession(cwd = "/tmp/test", overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "astGrep.enabled": true, "tools.commands": false }),
		...overrides,
	};
}

describe("ast_grep parse errors", () => {
	it("reports parse errors for the searched file", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-parse-"));
		try {
			const filePath = path.join(tempDir, "broken.ts");
			await Bun.write(filePath, "export function broken( { return 1; }");

			const tools = await createTools(createTestSession(tempDir), ["ast_grep"]);
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-parse", {
				pat: "someUnlikelyCall($A)",
				path: filePath,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as { parseErrors?: string[]; matchCount?: number } | undefined;

			expect(details?.matchCount).toBe(0);
			expect(text).toContain("No matches found");
			expect(text).toContain("Parse issues mean the query may be mis-scoped");
			expect(details?.parseErrors).toHaveLength(1);
			expect(details?.parseErrors?.[0]).toContain("broken.ts: parse error (syntax tree contains error nodes)");
			expect(details?.parseErrors?.[0]).not.toContain("someUnlikelyCall($A):");
			expect(text.match(/parse error \(syntax tree contains error nodes\)/g)?.length ?? 0).toBe(1);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
	it("caps parseErrors at PARSE_ERRORS_LIMIT and records the original total", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-parse-cap-"));
		try {
			const fileCount = 21;
			for (let i = 0; i < fileCount; i++) {
				await Bun.write(path.join(tempDir, `broken-${i}.ts`), "export function broken( { return 1; }");
			}

			const tools = await createTools(createTestSession(tempDir), ["ast_grep"]);
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-parse-cap", {
				pat: "someUnlikelyCall($A)",
				path: tempDir,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as
				| { parseErrors?: string[]; parseErrorsTotal?: number; matchCount?: number }
				| undefined;

			expect(details?.matchCount).toBe(0);
			expect(details?.parseErrors?.length).toBe(20);
			expect(details?.parseErrorsTotal).toBe(fileCount);
			expect(text).toContain(`Parse issues (20 / ${fileCount}):`);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
	it("combines globbing from path and glob parameters", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-glob-"));
		try {
			const packagesDir = path.join(tempDir, "packages");
			const sourceDir = path.join(packagesDir, "pkg-123", "src");
			const nestedDir = path.join(sourceDir, "nested");
			await fs.mkdir(nestedDir, { recursive: true });
			await Bun.write(path.join(sourceDir, "root.ts"), "const providerOptions = {};\n");
			await Bun.write(path.join(nestedDir, "child.ts"), "const providerOptions = { nested: true };\n");
			await Bun.write(path.join(sourceDir, "ignore.js"), "const providerOptions = {};\n");
			await Bun.write(path.join(tempDir, "outside.ts"), "const providerOptions = {};\n");

			const tools = await createTools(createTestSession(tempDir), ["ast_grep"]);
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-glob", {
				pat: "providerOptions",
				path: `${packagesDir}/pkg-*/src/**/*.ts`,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as { matchCount?: number; fileCount?: number } | undefined;

			// Multi-level tree output: `# packages/pkg-…/src/`, `## root.ts#<hash>`, then a
			// nested `## nested/` directory with `### child.ts#<hash>` under it.
			expect(text).toMatch(/^## root\.ts#[0-9A-F]{4}/m);
			expect(text).toMatch(/^### child\.ts#[0-9A-F]{4}/m);
			expect(text).not.toContain("ignore.js");
			expect(text).not.toContain("outside.ts");
			expect(details?.matchCount).toBe(2);
			expect(details?.fileCount).toBe(2);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("keeps multi-target results globally ordered and skip does not truncate match totals", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-multi-skip-"));
		try {
			const earlyDir = path.join(tempDir, "a");
			const lateDir = path.join(tempDir, "z");
			await fs.mkdir(earlyDir, { recursive: true });
			await fs.mkdir(lateDir, { recursive: true });
			await Bun.write(
				path.join(earlyDir, "a.ts"),
				Array.from({ length: 8 }, () => "const sharedSymbol = 1;").join("\n"),
			);
			await Bun.write(
				path.join(lateDir, "z.ts"),
				Array.from({ length: 8 }, () => "const sharedSymbol = 1;").join("\n"),
			);

			const tools = await createTools(createTestSession(tempDir), ["ast_grep"]);
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			// skip spans the globally merged ordering (a/* before z/*), so skipping
			// past a.ts's 8 matches must surface only z.ts — while matchCount still
			// reports the untruncated total across both targets.
			const result = await tool!.execute("ast-grep-multi-skip", {
				pat: "sharedSymbol",
				path: `${earlyDir};${lateDir}`,
				skip: 8,
			});
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as { matchCount?: number; limitReached?: boolean } | undefined;

			expect(details?.matchCount).toBe(16);
			expect(details?.limitReached).toBe(false);
			expect(text).toContain("z.ts");
			expect(text).not.toContain("a.ts");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("gives the model and TUI the next page offset after normalizing skip", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-page-"));
		try {
			const filePath = path.join(tempDir, "page.ts");
			await Bun.write(filePath, Array.from({ length: 106 }, () => 'console.log("page");').join("\n"));
			const tool = (await createTools(createTestSession(tempDir), ["ast_grep"])).find(
				entry => entry.name === "ast_grep",
			);
			if (!tool) throw new Error("ast_grep unavailable");

			const result = await tool.execute("ast-grep-page", {
				pat: 'console.log("page")',
				path: filePath,
				skip: 50.9,
			});
			const details = result.details as { nextSkip?: number; limitReached?: boolean } | undefined;
			const modelText = result.content.find(content => content.type === "text")?.text ?? "";
			expect(details?.limitReached).toBe(true);
			expect(details?.nextSkip).toBe(100);
			expect(modelText).toContain("skip=100");

			await initTheme(false);
			const theme = await getThemeByName("dark");
			if (!theme) throw new Error("dark theme unavailable");
			const tuiText = astGrepToolRenderer
				.renderResult(result, { expanded: true, isPartial: false }, theme, {
					pat: 'console.log("page")',
					skip: 50.9,
				})
				.render(240)
				.join("\n");
			expect(tuiText).toContain("skip=100");
			const native = astGrepToolRenderer.describeResult(
				result,
				{ expanded: true, isPartial: false },
				{ pat: 'console.log("page")', skip: 50.9 },
			);
			expect(JSON.stringify(native)).toContain("skip=100");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("parses PlusCal content through the tlaplus language aliases", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-pluscal-"));
		try {
			const filePath = path.join(tempDir, "algo.tla");
			await Bun.write(
				filePath,
				"---- MODULE Algo ----\n(*--algorithm Demo\nvariables x = 0;\nbegin\n  x := x + 1;\nend algorithm;*)\n====\n",
			);
			const tools = await createTools(createTestSession(tempDir), ["ast_grep"]);
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-pluscal", {
				pat: "x",
				path: filePath,
				lang: "pluscal",
			});
			const details = result.details as { matchCount?: number } | undefined;
			expect(details?.matchCount).toBeGreaterThan(0);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("skips unknown and extensionless files unless a language is explicitly selected", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-file-filter-"));
		try {
			for (const name of ["source.ts", "notes.unsupported", "extensionless"]) {
				await Bun.write(path.join(tempDir, name), "console.log(1);\n");
			}
			const tools = await createTools(createTestSession(tempDir), ["ast_grep"]);
			const tool = tools.find(entry => entry.name === "ast_grep")!;

			const inferred = await tool.execute("ast-grep-inferred", {
				pat: "console.log($X)",
				path: tempDir,
			});
			expect(inferred.details).toMatchObject({ matchCount: 1, files: ["source.ts"] });

			const explicit = await tool.execute("ast-grep-explicit", {
				pat: "console.log($X)",
				path: tempDir,
				lang: "ts",
			});
			expect(explicit.details).toMatchObject({ matchCount: 3 });
			const details = explicit.details as { files: string[] };
			expect([...details.files].sort()).toEqual(["extensionless", "notes.unsupported", "source.ts"]);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("honors an explicit C++ language for ambiguous headers", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-cpp-header-"));
		try {
			const filePath = path.join(tempDir, "buffer.h");
			await Bun.write(filePath, "class Buffer { public: int size() const { return 1; } };\n");
			const tools = await createTools(createTestSession(tempDir), ["ast_grep"]);
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-explicit-cpp", {
				pat: "class Buffer",
				path: filePath,
				lang: "cpp",
			});
			const details = result.details as { matchCount?: number } | undefined;
			expect(details?.matchCount).toBe(1);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("forwards an explicit language to every multi-target branch", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-multi-lang-"));
		try {
			// `.h` infers as C, so only the explicit `cpp` override can match the
			// class pattern — and only if `runMultiTargetAstGrep` forwards `lang`
			// to each per-target `astGrep` call behind the `;` scope.
			const firstDir = path.join(tempDir, "a");
			const secondDir = path.join(tempDir, "b");
			await fs.mkdir(firstDir, { recursive: true });
			await fs.mkdir(secondDir, { recursive: true });
			for (const dir of [firstDir, secondDir]) {
				await Bun.write(path.join(dir, "buffer.h"), "class Buffer { public: int size() const { return 1; } };\n");
			}
			const tools = await createTools(createTestSession(tempDir), ["ast_grep"]);
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-multi-lang", {
				pat: "class Buffer",
				path: `${firstDir};${secondDir}`,
				lang: "cpp",
			});
			const details = result.details as { matchCount?: number } | undefined;
			expect(details?.matchCount).toBe(2);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("names explicit host and local:// file targets alongside directory targets", async () => {
		const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-files-")));
		try {
			const artifactsDir = path.join(tempDir, "artifacts");
			const localOpts = { getArtifactsDir: () => artifactsDir, getSessionId: () => "ast-grep-files" };
			const examplePath = path.join(tempDir, "a", "example.ts");
			const otherPath = path.join(tempDir, "b", "other.ts");
			const childPath = path.join(tempDir, "c", "nested", "child.ts");
			const localNoteUrl = "local://scratch/note.ts";
			const localDirChildUrl = "local://dir/nested.ts";
			await Bun.write(examplePath, "legacyWrap(value, other)\n");
			await Bun.write(otherPath, "legacyWrap(value, other)\n");
			await Bun.write(childPath, "legacyWrap(nested, other)\n");
			await Bun.write(resolveLocalUrlToPath(localNoteUrl, localOpts), "legacyWrap(note, other)\n");
			await Bun.write(resolveLocalUrlToPath(localDirChildUrl, localOpts), "legacyWrap(dirChild, other)\n");
			const tools = await createTools(
				createTestSession(tempDir, {
					getArtifactsDir: () => artifactsDir,
					getSessionId: () => "ast-grep-files",
				}),
				["ast_grep"],
			);
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-sibling-files", {
				pat: "legacyWrap($A, $B)",
				path: [examplePath, otherPath, localNoteUrl, path.join(tempDir, "c"), "local://dir"].join(";"),
			});
			const details = result.details as
				| { matchCount?: number; files?: string[]; fileMatches?: Array<{ path: string; count: number }> }
				| undefined;
			const expected = ["a/example.ts", "b/other.ts", "c/nested/child.ts", localDirChildUrl, localNoteUrl];
			expect(details?.matchCount).toBe(5);
			expect([...(details?.files ?? [])].sort()).toEqual([...expected].sort());
			expect([...(details?.fileMatches ?? [])].sort((left, right) => left.path.localeCompare(right.path))).toEqual(
				[...expected].sort().map(filePath => ({ path: filePath, count: 1 })),
			);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("ast_grep display output", () => {
	it("keeps a multi-line capture on one display row while the model reads it as written", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-capture-"));
		try {
			const filePath = path.join(tempDir, "calls.ts");
			await Bun.write(filePath, "foo({\n  a: 1,\n\n  b: 2,\n});\nfoo(x);\n");

			const result = await new AstGrepTool(createTestSession(tempDir)).execute("ast-grep-capture", {
				pat: "foo($A)",
				path: filePath,
			});

			// One row per code-frame line or capture block: a capture's own newlines (and its blank
			// line) would read as stray rows, or split the match from its file, in the rendered card.
			const display = (result.details?.displayContent ?? "").split("\n");
			expect(display.filter(line => line.startsWith("  meta: "))).toEqual([
				"  meta: A={   a: 1,   b: 2, }",
				"  meta: A=x",
			]);
			expect(display.every(line => /^[* ]\d+│/.test(line) || line.startsWith("  meta: "))).toBe(true);

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			expect(text).toContain("  meta: A={\n  a: 1,\n\n  b: 2,\n}");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
