import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectTestsUnder,
	namedTestFilesUnder,
	testFilesWithoutBucket,
	workspacePackageDirs,
} from "./test-file-discovery";

// CI runs the files `collectTestsUnder` returns and nothing else, and its guard reports a test file
// no bucket runs. A name `bun test` discovers that the collector misses is a test CI never runs.
// Bun matches names in any letter case. It runs only one of two files whose names differ only in
// case (`a.test.ts`, `a.test.TS`), so the mixed-case names use stems of their own.
const lowerStems = ["a.test", "b_test", "c.spec", "d_spec", "etest", "f-test", "g.tests", "test", "h.test.d", "spec"];
const lowerExtensions = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "json", "txt", "d.ts"];
const names = [
	...lowerStems.flatMap(stem => lowerExtensions.map(extension => `${stem}.${extension}`)),
	...["i.Test", "j_SPEC", "k.TESTS"].flatMap(stem => lowerExtensions.map(extension => `${stem}.${extension}`)),
	...["l.test", "m_Spec", "n-test"].flatMap(stem =>
		["TS", "Mjs", "CTS", "JSX", "Json"].map(extension => `${stem}.${extension}`),
	),
];
const directories = ["", "sub/deeper", ".hidden", "node_modules/pkg"];

let base: string;
let root: string;

beforeAll(async () => {
	base = await fs.mkdtemp(path.join(os.tmpdir(), "test-file-discovery-"));
	root = path.join(base, "root");
	const source = (name: string) =>
		/\.c[jt]s$/i.test(name)
			? 'const { test } = require("bun:test");\ntest("t", () => {});\n'
			: 'import { test } from "bun:test";\ntest("t", () => {});\n';
	for (const directory of directories) {
		await fs.mkdir(path.join(root, directory), { recursive: true });
		for (const name of names) await Bun.write(path.join(root, directory, name), source(name));
	}
	// `bun test` follows links to files and directories and runs each real file once. A test reached
	// only through a link, here one outside the tree, must be collected; a cycle and a dangling link
	// must not hang or fail the collector.
	await Bun.write(path.join(base, "outside", "o.test.ts"), source("o.test.ts"));
	await Bun.write(path.join(base, "outside-dir", "p.spec.mts"), source("p.spec.mts"));
	await fs.symlink(path.join(base, "outside", "o.test.ts"), path.join(root, "linked.test.ts"));
	await fs.symlink(path.join(base, "outside-dir"), path.join(root, "linked-dir"));
	await fs.symlink(path.join(root, "a.test.ts"), path.join(root, "sub", "again.test.ts"));
	await fs.symlink("..", path.join(root, "sub", "deeper", "loop"));
	await fs.symlink(path.join(root, "missing.test.ts"), path.join(root, "dangling.test.ts"));
	// `bun test` reads the `[test] pathIgnorePatterns` of the bunfig.toml where it runs and skips a
	// matching file, as the repository root's does for `**/dist/**`.
	await Bun.write(path.join(root, "bunfig.toml"), '[test]\npathIgnorePatterns = ["**/dist/**", "skip/**"]\n');
	for (const file of ["dist/x.test.ts", "sub/dist/y.test.ts", "skip/z.test.ts", "skipnot/w.test.ts"])
		await Bun.write(path.join(root, file), source(file));
});

afterAll(async () => {
	await fs.rm(base, { recursive: true, force: true });
});

const testSource = 'import { test } from "bun:test";\ntest("t", () => {});\n';

async function writeTests(dir: string, files: string[]): Promise<void> {
	for (const file of files) await Bun.write(path.join(dir, file), testSource);
}

async function withTempDir(prefix: string, use: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		await use(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/**
 * Runs `bun test …args` in `cwd` and reads which files it executed from its JUnit report, as real
 * paths (Bun reports each real file once, by its real path). With no file selected, Bun exits 1
 * and the list is empty.
 */
async function bunTestRuns(
	cwd: string,
	args: string[] = [],
): Promise<{ files: string[]; exitCode: number; stderr: string }> {
	const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "bun-test-report-"));
	try {
		const report = path.join(reportDir, "report.xml");
		// The outer run's options (a preload relative to the repository, a reporter) do not apply here.
		const env: Record<string, string | undefined> = { ...Bun.env, CI: "" };
		delete env.BUN_OPTIONS;
		const run = Bun.spawn([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}`, ...args], {
			cwd,
			stdout: "ignore",
			stderr: "pipe",
			env,
		});
		const stderr = await new Response(run.stderr).text();
		const exitCode = await run.exited;
		const xml = await Bun.file(report)
			.text()
			.catch(() => "");
		const reported = [...new Set([...xml.matchAll(/<testsuite name="[^"]*" file="([^"]+)"/g)].map(m => m[1]!))];
		const files = (await Promise.all(reported.map(file => fs.realpath(path.resolve(cwd, file))))).sort();
		return { files, exitCode, stderr };
	} finally {
		await fs.rm(reportDir, { recursive: true, force: true });
	}
}

async function realPaths(dir: string, files: string[]): Promise<string[]> {
	return (await Promise.all(files.map(file => fs.realpath(path.resolve(dir, file))))).sort();
}

describe("collectTestsUnder", () => {
	it("collects exactly the files `bun test` discovers", async () => {
		const run = await bunTestRuns(root);
		expect(run.exitCode, run.stderr).toBe(0);
		const collected = await collectTestsUnder(root, root);

		expect(run.files).toContain(await fs.realpath(path.join(base, "outside", "o.test.ts")));
		expect(await realPaths(root, collected)).toEqual(run.files);
	});

	it("reaches a test through a link to an ignored directory, by the link's path", () =>
		withTempDir("test-file-link-ignored-", async tree => {
			// `dist` sorts first and holds only ignored paths; the link's paths are not ignored.
			await Bun.write(path.join(tree, "bunfig.toml"), '[test]\npathIgnorePatterns = ["**/dist/**"]\n');
			await writeTests(tree, ["dist/x.test.ts"]);
			await fs.symlink("dist", path.join(tree, "zz-safe-dist"));
			const discovered = await bunTestRuns(tree);
			const collected = await collectTestsUnder(tree, tree);

			expect(discovered.files).toEqual([await fs.realpath(path.join(tree, "dist/x.test.ts"))]);
			expect(collected).toEqual(["zz-safe-dist/x.test.ts"]);
			// The path returned is one `bun test` runs when a command names it.
			expect(
				(
					await bunTestRuns(
						tree,
						collected.map(file => `./${file}`),
					)
				).files,
			).toEqual(discovered.files);
		}));

	it("scans only below `[test] root`, as `bun test` naming no file does", () =>
		withTempDir("test-file-root-", async tree => {
			await Bun.write(path.join(tree, "bunfig.toml"), '[test]\nroot = "review-only"\n');
			await writeTests(tree, ["review-only/inside.test.ts", "outside.test.ts", "other/deep.test.ts"]);
			const discovered = await bunTestRuns(tree);

			expect(discovered.files).toEqual([await fs.realpath(path.join(tree, "review-only/inside.test.ts"))]);
			expect(await collectTestsUnder(tree, tree)).toEqual(["review-only/inside.test.ts"]);
			expect(await collectTestsUnder(path.join(tree, "other"), tree, tree)).toEqual([]);
		}));

	it("applies a single-string pattern and prunes directories a pattern matches, as `bun test` does", () =>
		withTempDir("test-file-patterns-", async tree => {
			const single = path.join(tree, "single");
			await Bun.write(path.join(single, "bunfig.toml"), '[test]\npathIgnorePatterns = "one/**"\n');
			await writeTests(single, ["one/a.test.ts", "two/b.test.ts"]);
			const listed = path.join(tree, "listed");
			await Bun.write(
				path.join(listed, "bunfig.toml"),
				'[test]\npathIgnorePatterns = ["skip/*", "**/pruned", "bare", "slash/"]\n',
			);
			await writeTests(listed, [
				"skip/a.test.ts",
				"skip/sub/b.test.ts",
				"skip/sub/deep/c.test.ts",
				"x/pruned/d.test.ts",
				"bare/e.test.ts",
				"x/bare/f.test.ts",
				"slash/g.test.ts",
				"keep/h.test.ts",
			]);
			// A link around a pruned directory reaches its tests.
			await fs.symlink("skip/sub/deep", path.join(listed, "zz-deep"));

			for (const dir of [single, listed]) {
				const discovered = await bunTestRuns(dir);
				expect(discovered.exitCode, discovered.stderr).toBe(0);
				expect(await realPaths(dir, await collectTestsUnder(dir, dir))).toEqual(discovered.files);
			}
		}));
});

describe("namedTestFilesUnder", () => {
	it("names every test `bun test ./<file>` runs: ignores judge only each file's own path, and root does not apply", () =>
		withTempDir("test-file-named-", async tree => {
			await Bun.write(
				path.join(tree, "bunfig.toml"),
				'[test]\nroot = "inside"\npathIgnorePatterns = ["skip/*", "**/dist/**"]\n',
			);
			await writeTests(tree, ["inside/i.test.ts", "skip/a.test.ts", "skip/sub/b.test.ts", "dist/x.test.ts"]);
			await fs.symlink("dist", path.join(tree, "zz-safe-dist"));
			const named = await namedTestFilesUnder(tree, tree, tree);

			expect(named).toEqual(["inside/i.test.ts", "skip/sub/b.test.ts", "zz-safe-dist/x.test.ts"]);
			const run = await bunTestRuns(
				tree,
				named.map(file => `./${file}`),
			);
			expect(run.files).toEqual(await realPaths(tree, named));
			// The file it leaves out is one `bun test` skips even when a command names it.
			expect((await bunTestRuns(tree, ["./skip/a.test.ts"])).files).toEqual([]);
		}));
});

describe("testFilesWithoutBucket", () => {
	it("reports exactly the tests no bucket command runs, through links in both directions", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "test-file-guard-"));
		try {
			const test = 'import { test } from "bun:test";\ntest("t", () => {});\n';
			await Bun.write(path.join(repo, "packages/run/a.test.ts"), test);
			await Bun.write(path.join(repo, "packages/run/helper.ts"), test);
			await Bun.write(path.join(repo, "packages/run/.hidden/h.test.ts"), test);
			await Bun.write(path.join(repo, "packages/run/node_modules/dep/d.test.ts"), test);
			await Bun.write(path.join(repo, "packages/new/b.test.ts"), test);
			await Bun.write(path.join(repo, "packages/new/reached.test.ts"), test);
			await Bun.write(path.join(repo, "scripts/s.test.ts"), test);
			// The scripts command runs from the repository root, whose bunfig.toml ignores dist.
			await Bun.write(path.join(repo, "scripts/dist/missed.test.ts"), test);
			await Bun.write(path.join(repo, "bunfig.toml"), '[test]\npathIgnorePatterns = ["**/dist/**"]\n');
			await fs.symlink("../../scripts/dist/missed.test.ts", path.join(repo, "packages/new/f-dist.test.ts"));
			await Bun.write(path.join(repo, ".omp/tests/tui.test.ts"), test);
			await Bun.write(path.join(repo, ".omp/tests/zzz-new.test.ts"), test);
			// Links sort before their targets, so the collector reports the link's spelling.
			await fs.symlink("tui.test.ts", path.join(repo, ".omp/tests/aaa-alias.test.ts"));
			await fs.symlink("../../scripts/s.test.ts", path.join(repo, ".omp/tests/aab-script.test.ts"));
			await fs.symlink("../run/a.test.ts", path.join(repo, "packages/new/a-alias.test.ts"));
			// `bun test` in packages/run runs reached.test.ts through this link.
			await fs.symlink("../new/reached.test.ts", path.join(repo, "packages/run/outward.test.ts"));
			// Targets packages/run holds but `bun test` there does not run.
			await fs.symlink("../run/helper.ts", path.join(repo, "packages/new/c-helper.test.ts"));
			await fs.symlink("../run/.hidden/h.test.ts", path.join(repo, "packages/new/d-hidden.test.ts"));
			await fs.symlink("../run/node_modules/dep/d.test.ts", path.join(repo, "packages/new/e-dep.test.ts"));

			const missing = await testFilesWithoutBucket(repo, ["packages/run", "packages/new", ".omp/tests"], {
				files: [{ path: ".omp/tests/tui.test.ts", cwd: "." }],
				dirs: [
					{ path: "packages/run", cwd: "packages/run" },
					{ path: "scripts", cwd: "." },
				],
			});
			expect(missing.sort()).toEqual([
				".omp/tests/zzz-new.test.ts",
				"packages/new/b.test.ts",
				"packages/new/c-helper.test.ts",
				"packages/new/d-hidden.test.ts",
				"packages/new/e-dep.test.ts",
				"packages/new/f-dist.test.ts",
			]);
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});

	it("credits a package command only with the tests below its `[test] root`", () =>
		withTempDir("test-file-guard-root-", async repo => {
			await Bun.write(path.join(repo, "packages/rooted/bunfig.toml"), '[test]\nroot = "review-only"\n');
			await writeTests(repo, ["packages/rooted/review-only/inside.test.ts", "packages/rooted/zz-missed.test.ts"]);

			const missing = await testFilesWithoutBucket(repo, ["packages/rooted"], {
				files: [],
				dirs: [{ path: "packages/rooted", cwd: "packages/rooted" }],
			});
			expect(missing).toEqual(["packages/rooted/zz-missed.test.ts"]);
		}));

	it("reports an unbucketed package's test even when that package's own bunfig.toml ignores it", () =>
		withTempDir("test-file-guard-unbucketed-", async repo => {
			await writeTests(repo, [
				"packages/run/a.test.ts",
				"packages/wire/zz-hidden.test.ts",
				"packages/wire/dist/d.test.ts",
			]);
			// No command runs in packages/wire, so nothing reads this file.
			await Bun.write(
				path.join(repo, "packages/wire/bunfig.toml"),
				'[test]\npathIgnorePatterns = ["zz-*.test.ts", "**/dist/**"]\n',
			);

			const missing = await testFilesWithoutBucket(repo, ["packages/run", "packages/wire"], {
				files: [],
				dirs: [{ path: "packages/run", cwd: "packages/run" }],
			});
			expect(missing.sort()).toEqual(["packages/wire/dist/d.test.ts", "packages/wire/zz-hidden.test.ts"]);
		}));

	it("stops with the file's name when a command's bunfig.toml is not valid TOML", () =>
		withTempDir("test-file-guard-toml-", async repo => {
			const config = path.join(repo, "packages/run/bunfig.toml");
			await Bun.write(config, "[test\npathIgnorePatterns = [\n");
			await writeTests(repo, ["packages/run/a.test.ts"]);
			// `bun test` refuses to start there too.
			expect((await bunTestRuns(path.join(repo, "packages/run"))).exitCode).not.toBe(0);

			const guard = testFilesWithoutBucket(repo, ["packages/run"], {
				files: [],
				dirs: [{ path: "packages/run", cwd: "packages/run" }],
			});
			await expect(guard).rejects.toThrow(`${config} is not valid TOML`);
		}));
});

describe("workspacePackageDirs", () => {
	it("lists a workspace package reached through a link, as bun resolves it", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "test-file-workspaces-"));
		try {
			const repo = path.join(base, "repo");
			await Bun.write(path.join(repo, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*"] } }));
			await Bun.write(path.join(repo, "packages/real/package.json"), "{}");
			await Bun.write(path.join(base, "outside/package.json"), "{}");
			await fs.symlink(path.join(base, "outside"), path.join(repo, "packages/linked"));

			expect(await workspacePackageDirs(repo)).toEqual(["packages/linked", "packages/real"]);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});
});
