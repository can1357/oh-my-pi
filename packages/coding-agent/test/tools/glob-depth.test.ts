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
