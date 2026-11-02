import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectTestsUnder } from "./test-file-discovery";

// CI runs the files `collectTestsUnder` returns and nothing else, and its guard reports a test file
// no bucket runs. A name `bun test` discovers that the collector misses is a test CI never runs.
const stems = ["a.test", "b_test", "c.spec", "d_spec", "etest", "f-test", "g.tests", "test", "h.test.d", "spec"];
const extensions = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "json", "txt", "d.ts"];
const directories = ["", "sub/deeper", ".hidden", "node_modules/pkg"];

let root: string;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "test-file-discovery-"));
	for (const directory of directories) {
		await fs.mkdir(path.join(root, directory), { recursive: true });
		for (const stem of stems) {
			for (const extension of extensions) {
				const source =
					extension === "cjs" || extension === "cts"
						? 'const { test } = require("bun:test");\ntest("t", () => {});\n'
						: 'import { test } from "bun:test";\ntest("t", () => {});\n';
				await Bun.write(path.join(root, directory, `${stem}.${extension}`), source);
			}
		}
	}
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("collectTestsUnder", () => {
	it("collects exactly the files `bun test` discovers", async () => {
		const report = path.join(root, "report.xml");
		const run = Bun.spawn([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}`], {
			cwd: root,
			stdout: "ignore",
			stderr: "pipe",
			env: { ...Bun.env, CI: "" },
		});
		const stderr = await new Response(run.stderr).text();
		if ((await run.exited) !== 0) throw new Error(`bun test failed in the fixture tree:\n${stderr}`);
		const xml = await Bun.file(report).text();
		const discovered = [
			...new Set([...xml.matchAll(/<testsuite name="[^"]*" file="([^"]+)"/g)].map(match => match[1]!)),
		]
			.map(file => file.split(path.sep).join("/"))
			.sort();

		expect(discovered.length).toBeGreaterThan(0);
		expect((await collectTestsUnder(root, root)).sort()).toEqual(discovered);
	});
});
