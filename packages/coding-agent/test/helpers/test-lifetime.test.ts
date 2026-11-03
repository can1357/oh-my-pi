import { describe, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { trackTestLifetime } from "./test-lifetime";

const { test } = trackTestLifetime();

const HELPER = path.join(import.meta.dir, "test-lifetime.ts");

/** Per-test outcomes from a real `bun test` run of fixture files written for it. */
interface FixtureRun {
	exitCode: number;
	output: string;
	outcome(name: string): "pass" | "fail" | "skip" | undefined;
}

/**
 * Write `files` (name → source; `HELPER` in a source stands for this helper's path) into a fresh
 * directory and run them in one `bun test` process, as a test suite runs them. Outcomes come from
 * the run's JUnit report.
 */
async function runFixtures(files: Record<string, string>): Promise<FixtureRun> {
	using dir = TempDir.createSync("@pi-test-lifetime-");
	for (const [name, source] of Object.entries(files)) {
		await Bun.write(path.join(dir.path(), name), source.replaceAll("HELPER", JSON.stringify(HELPER)));
	}
	const names = Object.keys(files)
		.filter(name => name.endsWith(".test.ts"))
		.sort();
	const result = await $`${process.execPath} test --reporter=junit --reporter-outfile=report.xml ${names}`
		.cwd(dir.path())
		.nothrow()
		.quiet();
	const output = result.stdout.toString() + result.stderr.toString();
	const report = await fs.readFile(path.join(dir.path(), "report.xml"), "utf8").catch(() => "");
	const cleaned = await fs.readFile(path.join(dir.path(), "cleaned.txt"), "utf8").catch(() => "");
	const outcomes = new Map<string, "pass" | "fail" | "skip">();
	for (const [, name, , body = ""] of report.matchAll(
		/<testcase\b[^>]*?\bname="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g,
	)) {
		outcomes.set(name!, body.includes("<failure") ? "fail" : body.includes("<skipped") ? "skip" : "pass");
	}
	return {
		exitCode: result.exitCode,
		output: `${output}\ncleaned: ${cleaned}`,
		outcome: name => outcomes.get(name),
	};
}

const refusal = (name: string) => `"${name}" timed out and may still be running`;

/** A tracked body or callback (`setup`) that times out and then writes, and a next test that passes only on that write. */
function lateWriteAfter(setup: string): string {
	return `
		import { expect } from "bun:test";
		import * as vm from "node:vm";
		import { trackTestLifetime, noteTimeout } from HELPER;
		const { test, onTestFinished } = trackTestLifetime();
		const shared = { key: "initial" };
		${setup}
		test("passes only on the late write", async () => {
			await Bun.sleep(900);
			expect(shared.key).toBe("stale");
		});
	`;
}

describe("trackTestLifetime", () => {
	test("refuses every later result after a body times out, including one that would pass on its late write", async () => {
		const run = await runFixtures({
			"body.test.ts": `
				import { expect } from "bun:test";
				import * as fs from "node:fs";
				import { trackTestLifetime } from HELPER;
				const { test, afterEach } = trackTestLifetime();
				const shared = { key: "initial" };
				afterEach(() => fs.appendFileSync("cleaned.txt", "x"));
				test("holds past its timeout", async () => {
					await Bun.sleep(600);
					shared.key = "stale";
				}, 100);
				test("passes only on the late write", async () => {
					await Bun.sleep(900);
					expect(shared.key).toBe("stale");
				});
				test("runs after it", () => {});
			`,
		});

		expect(run.outcome("holds past its timeout")).toBe("fail");
		expect(run.outcome("passes only on the late write")).toBe("fail");
		expect(run.outcome("runs after it")).toBe("fail");
		expect(run.output.split(refusal("holds past its timeout")).length - 1).toBeGreaterThanOrEqual(2);
		// Every test's afterEach ran, the timed-out one's included, so its cleanup released what it held.
		expect(run.output).toContain("cleaned: xxx");
		expect(run.exitCode).not.toBe(0);
	}, 60_000);

	test("refuses later results after a body that timed out and finished during its own teardown", async () => {
		const run = await runFixtures({
			"teardown.test.ts": `
				import { expect } from "bun:test";
				import { trackTestLifetime } from HELPER;
				const { test, afterEach } = trackTestLifetime();
				const shared = { key: "initial" };
				// A slow cleanup: the body resumes and finishes while it runs, before the next test starts.
				afterEach(() => Bun.sleep(500));
				test("finishes during its teardown", async () => {
					await Bun.sleep(250);
					shared.key = "stale";
				}, 100);
				test("passes only on the late write", () => {
					expect(shared.key).toBe("stale");
				});
			`,
		});

		expect(run.outcome("passes only on the late write")).toBe("fail");
		expect(run.output).toContain(refusal("finishes during its teardown"));
	}, 60_000);

	test("names a timed-out hook of each kind and refuses the next test", async () => {
		const hooks = ["beforeEach", "afterEach", "beforeAll", "afterAll"] as const;
		const runs = await Promise.all(
			hooks.map(hook =>
				runFixtures({
					[`${hook}.test.ts`]: `
						import { describe } from "bun:test";
						import { trackTestLifetime } from HELPER;
						const { test, ${hook} } = trackTestLifetime();
						describe("first", () => {
							${hook}(() => Bun.sleep(600), 100);
							test("in the first suite", () => {});
						});
						describe("second", () => {
							test("in the second suite", () => {});
						});
					`,
				}),
			),
		);

		for (const [index, hook] of hooks.entries()) {
			const run = runs[index]!;
			const article = hook.startsWith("a") ? "an" : "a";
			expect({ hook, second: run.outcome("in the second suite") }).toEqual({ hook, second: "fail" });
			expect(run.output).toContain(refusal(`${article} ${hook} hook`));
		}
	}, 60_000);

	test("refuses a later file's tests after a test of an earlier file timed out", async () => {
		const run = await runFixtures({
			"1-first.test.ts": `
				import { trackTestLifetime } from HELPER;
				const { test } = trackTestLifetime();
				test("times out in the first file", () => Bun.sleep(600), 100);
			`,
			"2-second.test.ts": `
				import { trackTestLifetime } from HELPER;
				const { test } = trackTestLifetime();
				test("in the second file", () => {});
			`,
		});

		expect(run.outcome("in the second file")).toBe("fail");
		expect(run.output).toContain(refusal("times out in the first file"));
	}, 60_000);

	test("lets every test run when nothing times out", async () => {
		const run = await runFixtures({
			"settled.test.ts": `
				import { trackTestLifetime } from HELPER;
				const { test, it, beforeEach, afterEach, beforeAll, afterAll } = trackTestLifetime();
				beforeAll(() => Bun.sleep(1));
				beforeEach(() => Bun.sleep(1));
				afterEach(() => Bun.sleep(1));
				afterAll(() => Bun.sleep(1));
				test("an async test", () => Bun.sleep(1));
				it.each([1, 2])("row %d", async () => {});
				test.skip("a skipped test", () => {});
				test("a synchronous test", () => {});
			`,
		});

		expect(run.outcome("an async test")).toBe("pass");
		expect(run.outcome("row 1")).toBe("pass");
		expect(run.outcome("row 2")).toBe("pass");
		expect(run.outcome("a synchronous test")).toBe("pass");
		expect(run.outcome("a skipped test")).toBe("skip");
		expect(run.exitCode).toBe(0);
	}, 60_000);

	test("refuses later results after a body whose promise comes from another realm times out", async () => {
		const run = await runFixtures({
			"realm.test.ts": lateWriteAfter(`
				test("returns a promise from node:vm", () =>
					vm.runInNewContext("new Promise(resolve => setTimeout(resolve, 400))", { setTimeout }).then(() => {
						shared.key = "stale";
					}), 100);
			`),
		});

		expect(run.outcome("passes only on the late write")).toBe("fail");
		expect(run.output).toContain(refusal("returns a promise from node:vm"));
	}, 60_000);

	test("refuses later results after an onTestFinished callback times out", async () => {
		const run = await runFixtures({
			"finished.test.ts": lateWriteAfter(`
				test("registers a slow callback", () => {
					onTestFinished(async () => {
						await Bun.sleep(400);
						shared.key = "stale";
					}, { timeout: 100 });
				});
			`),
		});

		expect(run.outcome("passes only on the late write")).toBe("fail");
		expect(run.output).toContain(refusal("an onTestFinished callback"));
	}, 60_000);

	test("notes a body that times out and finishes during a hook a helper registered before the file's own", async () => {
		const run = await runFixtures({
			// A helper module like fake-clock: imported first, its hook runs before the file's teardown hooks.
			"slow-hook.ts": `
				import { afterEach } from "bun:test";
				import { noteTimeout } from HELPER;
				afterEach(async () => {
					noteTimeout();
					await Bun.sleep(400);
				});
			`,
			"helper-hook.test.ts": lateWriteAfter(`
				test("finishes during the helper's hook", async () => {
					await Bun.sleep(200);
					shared.key = "stale";
				}, 100);
			`).replace('import { expect } from "bun:test";', 'import { expect } from "bun:test";\nimport "./slow-hook";'),
		});

		expect(run.outcome("passes only on the late write")).toBe("fail");
		expect(run.output).toContain(refusal("finishes during the helper's hook"));
	}, 60_000);

	test("refuses a test or hook written in done-callback style instead of letting it pass before it is done", async () => {
		const runs = await Promise.all(
			['test("calls done", done => setTimeout(done, 50));', "beforeEach(done => setTimeout(done, 50));"].map(
				declaration =>
					runFixtures({
						"callback.test.ts": `
							import { trackTestLifetime } from HELPER;
							const { test, beforeEach } = trackTestLifetime();
							${declaration}
							test("declared after it", () => {});
						`,
					}),
			),
		);

		for (const run of runs) {
			expect(run.output).toContain("takes no `done` callback; return a promise instead");
			expect(run.outcome("declared after it")).not.toBe("pass");
			expect(run.exitCode).not.toBe(0);
		}
	}, 60_000);
});
