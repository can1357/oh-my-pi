import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectTestsUnder } from "./test-file-discovery";

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
