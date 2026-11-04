import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { globArgsForStep } from "../../src/tools/bash-step";
import { GlobTool } from "../../src/tools/glob";

describe("glob depth", () => {
	let dir: string;
	let session: ToolSession;

	beforeEach(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "glob-depth-")));
		session = {
			cwd: dir,
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		for (const rel of ["proofs/a/dune", "proofs/a/b/dune", "proofs/a/b/c/dune", "proofs/a/b/c/d/dune", "top.txt"]) {
			await Bun.write(path.join(dir, rel), "x\n");
		}
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const files = async (params: { path: string; depth?: number }): Promise<string[] | undefined> =>
		(await new GlobTool(session).execute("glob-depth", { ...params, gitignore: false })).details?.files?.toSorted();

	it("stops a recursive pattern at the requested depth below its root, as find -maxdepth does", async () => {
		// `find proofs -maxdepth 3 -name dune` lists the same two files: a/dune is depth 2, a/b/dune depth 3.
		expect(await files({ path: "proofs/**/dune", depth: 3 })).toEqual(["proofs/a/b/dune", "proofs/a/dune"]);
		expect(await files({ path: "proofs/**/dune" })).toHaveLength(4);
	});

	it("lists only a root's direct children at depth 1", async () => {
		expect(await files({ path: ".", depth: 1 })).toEqual(["proofs/", "top.txt"]);
	});

	it("keeps a pattern's own shallower bound", async () => {
		expect(await files({ path: "proofs/*/dune", depth: 5 })).toEqual(["proofs/a/dune"]);
	});

	it.each([0, -1, 1.5])("rejects depth %p", async depth => {
		await expect(new GlobTool(session).execute("glob-depth-invalid", { path: ".", depth })).rejects.toBeInstanceOf(
			ToolError,
		);
	});

	it("bounds a custom backend's results even when the backend ignores maxDepth", async () => {
		let receivedDepth: number | undefined;
		const tool = new GlobTool(session, {
			operations: {
				exists: () => true,
				glob: (_pattern, _cwd, options) => {
					receivedDepth = options.maxDepth;
					return ["a/dune", "a/b/dune", "a/b/c/dune"];
				},
			},
		});
		const result = await tool.execute("glob-depth-custom", { path: "proofs/**/dune", depth: 3 });
		expect(receivedDepth).toBe(3);
		expect(result.details?.files?.toSorted()).toEqual(["proofs/a/b/dune", "proofs/a/dune"]);
	});

	it("treats a depth past the native 32-bit range as unlimited", async () => {
		expect(await files({ path: "proofs/**/dune", depth: 4_294_967_296 })).toHaveLength(4);
	});

	it("pages past the limit with skip, in one order", async () => {
		for (let i = 0; i < 12; i++) await Bun.write(path.join(dir, "many", `f${String(i).padStart(2, "0")}.txt`), "x\n");
		const page = async (skip?: number) =>
			(await new GlobTool(session).execute("glob-skip", { path: "many/*.txt", limit: 5, gitignore: false, skip }))
				.details?.files ?? [];
		const pages = [await page(), await page(5), await page(10)];
		expect(pages.map(p => p.length)).toEqual([5, 5, 2]);
		expect(new Set(pages.flat()).size).toBe(12);
		const past = await new GlobTool(session).execute("glob-skip-past", { path: "many/*.txt", skip: 50 });
		expect(past.content.find(c => c.type === "text")?.text).toContain("past the end");
	});

	it("reports a timeout, not the end of the listing, when a page past a cut-short scan is empty", async () => {
		const tool = new GlobTool(session, {
			timeoutMs: 100,
			operations: {
				exists: () => true,
				glob: pattern => (pattern.includes("**") ? Promise.withResolvers<string[]>().promise : ["kept"]),
			},
		});
		// A custom backend gets one call per listed root: `fast` answers, `slow` never does.
		const params = { path: ["fast/*", "slow/**/*"], skip: 100 } as unknown as Parameters<typeof tool.execute>[1];
		const result = await tool.execute("glob-skip-timeout", params);
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(result.details?.timedOut).toBe(true);
		expect(result.details?.truncated).toBe(true);
		expect(text).not.toContain("past the end");
		expect(text).toContain("timed out");
	});

	it.skipIf(path.sep === "\\").each([false, true])(
		"reports two byte-distinct non-UTF-8 paths as omitted (valid neighbour: %s)",
		async valid => {
			for (const byte of [0xff, 0xfe]) {
				const rawDir = Buffer.concat([Buffer.from(path.join(dir, "raw/dir")), Buffer.from([byte])]);
				await fs.mkdir(rawDir, { recursive: true });
				await fs.writeFile(Buffer.concat([rawDir, Buffer.from("/dune")]), "x\n");
			}
			if (valid) await Bun.write(path.join(dir, "raw/dir\uFFFD/dune"), "valid\n");
			const found = await Bun.$`find raw -name dune -print0`.cwd(dir).quiet();
			expect(found.stdout.includes(Buffer.from([0xff]))).toBe(true);
			expect(found.stdout.includes(Buffer.from([0xfe]))).toBe(true);
			const args = globArgsForStep("find raw -name dune");
			expect(args).toBeDefined();
			const result = await new GlobTool(session).execute("glob-raw-names", args!);
			expect(result.details?.truncated).toBe(true);
			expect(result.details?.files).toEqual(valid ? ["raw/dir\uFFFD/dune"] : []);
			for (const file of result.details?.files ?? []) await fs.stat(path.join(dir, file));
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toMatch(/2.*(?:non-UTF-8|UTF-8)/u);
			expect(text).not.toContain("No files found");
		},
	);

	it.skipIf(path.sep === "\\")("lists a file name holding a backslash as it is on disk", async () => {
		await Bun.write(path.join(dir, "names", "a\\z"), "x\n");
		const listed = await files({ path: "names/*" });
		expect(listed).toEqual(["names/a\\z"]);
		await expect(fs.stat(path.join(dir, listed![0]))).resolves.toBeDefined();
	});

	it.skipIf(path.sep === "\\")(
		"renders names holding a backslash, Unicode spaces or a colon as they are on disk",
		async () => {
			for (const rel of ["r/a\\b.txt", "r/a/b.txt", "r/no\u00a0break.txt", "r/local:/dune"]) {
				await Bun.write(path.join(dir, rel), "x\n");
			}
			const result = await new GlobTool(session).execute("glob-names", { path: "r/**/*", gitignore: false });
			const listed = (result.details?.files ?? []).filter(file => !file.endsWith("/")).toSorted();
			expect(listed).toEqual(["r/a/b.txt", "r/a\\b.txt", "r/local:/dune", "r/no\u00a0break.txt"]);
			for (const file of listed) await expect(fs.stat(path.join(dir, file))).resolves.toBeDefined();
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("a\\b.txt");
			expect(text).toContain("no\u00a0break.txt");
		},
	);

	it.skipIf(path.sep === "\\")("keeps a custom backend's direct child holding a backslash at depth 1", async () => {
		const tool = new GlobTool(session, { operations: { exists: () => true, glob: () => ["a\\z"] } });
		const result = await tool.execute("glob-depth-backslash", { path: "proofs/*", depth: 1 });
		expect(result.details?.files).toEqual(["proofs/a\\z"]);
	});

	it("does not report absence when a backend's limit cut its results before the depth filter", async () => {
		const tool = new GlobTool(session, {
			operations: {
				exists: () => true,
				glob: (_pattern, _cwd, options) => ["a/b/deep", "keep"].slice(0, options.limit),
			},
		});
		const result = await tool.execute("glob-depth-cut", { path: "r/**/*", depth: 1, limit: 1 });
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(result.details?.truncated).toBe(true);
		expect(text).not.toContain("No files found");
		expect(text).toContain("more matches may exist");
	});

	it("does not claim an empty page is past the end when depth filtering cut a backend's capped results", async () => {
		const tool = new GlobTool(session, {
			operations: {
				exists: () => true,
				glob: (_pattern, _cwd, options) => ["a/b/deep", "keep", "later"].slice(0, options.limit),
			},
		});
		const result = await tool.execute("glob-depth-cut-page", { path: "r/**/*", depth: 1, limit: 1, skip: 1 });
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(result.details?.truncated).toBe(true);
		expect(text).not.toContain("past the end");
		expect(text).toContain("more matches may exist");
	});

	it("bounds a custom backend's URL-rooted results by depth", async () => {
		const tool = new GlobTool(session, {
			operations: {
				exists: () => true,
				glob: () => ["local://a/dune", "local://a/b/dune", "a/b/c/dune", "local://a/", "local://a/b/"],
			},
		});
		const result = await tool.execute("glob-depth-url", { path: "local://**/dune", depth: 2 });
		const listed = (result.details?.files ?? []).join("\n");
		expect(listed).toContain("a/dune");
		expect(listed).not.toContain("a/b/dune");
		expect(listed).not.toContain("a/b/c/dune");
	});
});

describe("glob reproduces the find steps the bash interceptor refuses", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "glob-find-")));
		for (const rel of [
			"r/.git/HEAD",
			"r/.git/objects/dune",
			"r/.gitignore",
			"r/.hidden/dune",
			"r/dune",
			"r/a/dune",
			"r/a/b/dune",
			"r/node_modules/pkg/dune",
			"r/ignored/dune",
		]) {
			await Bun.write(path.join(dir, rel), "x\n");
		}
		await Bun.write(path.join(dir, "r/.gitignore"), "ignored/\n");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it.each([
		"find r -name dune",
		"find r -maxdepth 2 -name dune",
		"find r -maxdepth 1 -name '.*'",
		"find r -name 'd*'",
		"find r -name .git -prune -o -name dune -print",
		"find r \\( -name dune -o -name HEAD \\)",
	])("lists what %s lists", async command => {
		const session: ToolSession = {
			cwd: dir,
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const args = globArgsForStep(command);
		expect(args).toBeDefined();
		const shell = await Bun.$`bash -c ${command}`.cwd(dir).quiet().text();
		const expected = shell
			.split("\n")
			.filter(Boolean)
			.map(line => line.replace(/^\.\//u, ""))
			.toSorted();
		const result = await new GlobTool(session).execute("glob-find", { ...args!, limit: 200 });
		const listed = (result.details?.files ?? []).map(file => file.replace(/\/$/u, "")).toSorted();
		expect(listed).toEqual(expected);
	});
});
