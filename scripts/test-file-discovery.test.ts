import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectTestsUnder, testFilesWithoutBucket, workspacePackageDirs } from "./test-file-discovery";

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
});

afterAll(async () => {
	await fs.rm(base, { recursive: true, force: true });
});

describe("collectTestsUnder", () => {
	it("collects exactly the files `bun test` discovers", async () => {
		const report = path.join(base, "report.xml");
		// The outer run's options (a preload relative to the repository, a reporter) do not apply here.
		const env: Record<string, string | undefined> = { ...Bun.env, CI: "" };
		delete env.BUN_OPTIONS;
		const run = Bun.spawn([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}`], {
			cwd: root,
			stdout: "ignore",
			stderr: "pipe",
			env,
		});
		const stderr = await new Response(run.stderr).text();
		if ((await run.exited) !== 0) throw new Error(`bun test failed in the fixture tree:\n${stderr}`);
		const xml = await Bun.file(report).text();
		// Bun reports each real file once, by its real path; compare real paths.
		const real = (file: string) => fs.realpath(path.resolve(root, file));
		const discovered = (
			await Promise.all(
				[...new Set([...xml.matchAll(/<testsuite name="[^"]*" file="([^"]+)"/g)].map(m => m[1]!))].map(real),
			)
		).sort();
		const collected = await collectTestsUnder(root, root);

		expect(discovered).toContain(await fs.realpath(path.join(base, "outside", "o.test.ts")));
		expect((await Promise.all(collected.map(real))).sort()).toEqual(discovered);
	});
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
				files: [".omp/tests/tui.test.ts"],
				dirs: ["packages/run", "scripts"],
			});
			expect(missing.sort()).toEqual([
				".omp/tests/zzz-new.test.ts",
				"packages/new/b.test.ts",
				"packages/new/c-helper.test.ts",
				"packages/new/d-hidden.test.ts",
				"packages/new/e-dep.test.ts",
			]);
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});
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
