import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createTestSession(cwd = "/tmp/test", overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "astGrep.enabled": true, "tools.xdev": false }),
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
});
