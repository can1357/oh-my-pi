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
 * directory and run them in one `bun test` process with `flags`, as a test suite runs them.
 * Outcomes come from the run's JUnit report.
 */
async function runFixtures(files: Record<string, string>, flags: string[] = []): Promise<FixtureRun> {
	using dir = TempDir.createSync("@pi-test-lifetime-");
	for (const [name, source] of Object.entries(files)) {
		await Bun.write(path.join(dir.path(), name), source.replaceAll("HELPER", JSON.stringify(HELPER)));
	}
	const names = Object.keys(files)
		.filter(name => name.endsWith(".test.ts"))
		.sort();
	const result = await $`${process.execPath} test ${flags} --reporter=junit --reporter-outfile=report.xml ${names}`
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
		import { trackTestLifetime } from HELPER;
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

	test("refuses a later file's test after an earlier file's afterAll timed out and settled during that file's setup", async () => {
		const run = await runFixtures({
			"1-first.test.ts": `
				import { trackTestLifetime } from HELPER;
				const { test, afterAll } = trackTestLifetime();
				const shared = globalThis as { lateHook?: string };
				shared.lateHook = "initial";
				afterAll(async () => {
					await Bun.sleep(400);
					shared.lateHook = "stale";
				}, 100);
				test("first body", () => {});
			`,
			// Module setup outlasts the timed-out hook, so no tracked test or hook starts while it is pending.
			"2-second.test.ts": `
				import { expect } from "bun:test";
				import { trackTestLifetime } from HELPER;
				await Bun.sleep(800);
				const { test } = trackTestLifetime();
				test("passes only on the late afterAll write", () => {
					expect((globalThis as { lateHook?: string }).lateHook).toBe("stale");
				});
			`,
		});

		expect(run.outcome("passes only on the late afterAll write")).toBe("fail");
		expect(run.output).toContain(refusal("an afterAll hook"));
	}, 60_000);

	test("refuses a later file's test after a hook timed out and settled while the next file blocked this thread", async () => {
		const run = await runFixtures({
			"1-first.test.ts": `
				import { trackTestLifetime } from HELPER;
				const { test, afterAll } = trackTestLifetime();
				const shared = globalThis as { blocked?: string };
				shared.blocked = "initial";
				afterAll(async () => {
					await Bun.sleep(250);
					shared.blocked = "stale";
				}, 100);
				test("first body", () => {});
			`,
			// This file holds the thread past the hook's deadline, so the hook's timer, and any wake
			// armed for its deadline, are released together once the block ends.
			"2-second.test.ts": `
				import { expect } from "bun:test";
				import { trackTestLifetime } from HELPER;
				const until = Bun.nanoseconds() + 600e6;
				while (Bun.nanoseconds() < until) {}
				await Bun.sleep(100);
				const { test } = trackTestLifetime();
				test("passes only on the write of the blocked-out hook", () => {
					expect((globalThis as { blocked?: string }).blocked).toBe("stale");
				});
			`,
		});

		expect(run.outcome("passes only on the write of the blocked-out hook")).toBe("fail");
		expect(run.output).toContain(refusal("an afterAll hook"));
	}, 60_000);

	test("reads the run's default timeout without /proc, as a platform that has none", async () => {
		const run = await runFixtures(
			{
				// Loaded before the helper: every later read of /proc/self/cmdline fails, as on macOS.
				"no-proc.ts": `
					import fs from "node:fs";
					const real = fs.readFileSync;
					fs.readFileSync = ((p: string, ...rest: unknown[]) => {
						if (String(p) === "/proc/self/cmdline") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
						return (real as (...args: unknown[]) => unknown)(p, ...rest);
					}) as typeof fs.readFileSync;
				`,
				"1-first.test.ts": `
					import { trackTestLifetime } from HELPER;
					const { test, afterAll } = trackTestLifetime();
					const shared = globalThis as { lateHook?: string };
					shared.lateHook = "initial";
					afterAll(async () => {
						await Bun.sleep(400);
						shared.lateHook = "stale";
					});
					test("first body", () => {});
				`,
				"2-second.test.ts": `
					import { expect } from "bun:test";
					import { trackTestLifetime } from HELPER;
					await Bun.sleep(800);
					const { test } = trackTestLifetime();
					test("passes only on the late afterAll write", () => {
						expect((globalThis as { lateHook?: string }).lateHook).toBe("stale");
					});
				`,
			},
			["--preload", "./no-proc.ts", "--timeout", "100"],
		);

		expect(run.outcome("passes only on the late afterAll write")).toBe("fail");
		expect(run.output).toContain(refusal("an afterAll hook"));
	}, 60_000);

	test("takes the deadline Bun takes: the last --timeout, and never bunfig's, which Bun does not apply", async () => {
		const [lastFlag, bunfigIgnored] = await Promise.all([
			runFixtures(
				{
					"slow.test.ts": `
						import { trackTestLifetime } from HELPER;
						const { test } = trackTestLifetime();
						// Past Bun's built-in 5000 ms, inside the run's effective --timeout.
						test("runs for six seconds", () => Bun.sleep(6000));
						test("healthy after it", () => {});
					`,
				},
				// Bun applies the last of repeated flags; so must the deadline.
				["--timeout", "100", "--timeout=20000"],
			),
			runFixtures({
				// Bun 1.4.4 does not apply bunfig's test timeout, so neither may the deadline.
				"bunfig.toml": "[test]\ntimeout = 100\n",
				"ignored.test.ts": `
					import { trackTestLifetime } from HELPER;
					const { test } = trackTestLifetime();
					test("runs for four hundred ms", () => Bun.sleep(400));
					test("healthy after it", () => {});
				`,
			}),
		]);

		for (const run of [lastFlag, bunfigIgnored]) {
			expect(run.outcome("healthy after it")).toBe("pass");
			expect(run.exitCode).toBe(0);
		}
		expect(lastFlag.outcome("runs for six seconds")).toBe("pass");
		expect(bunfigIgnored.outcome("runs for four hundred ms")).toBe("pass");
	}, 60_000);

	test("times bodies by the file's setDefaultTimeout from the point Bun applies it, both ways", async () => {
		const [raised, lowered] = await Promise.all([
			runFixtures({
				"raised.test.ts": `
					import { trackTestLifetime } from HELPER;
					const { test, setDefaultTimeout } = trackTestLifetime();
					setDefaultTimeout(20_000);
					test("runs for six seconds", () => Bun.sleep(6000));
					test("healthy after it", () => {});
				`,
			}),
			runFixtures(
				{
					"1-first.test.ts": `
						import { trackTestLifetime } from HELPER;
						const { test, afterAll, setDefaultTimeout } = trackTestLifetime();
						const shared = globalThis as { lateHook?: string };
						shared.lateHook = "initial";
						setDefaultTimeout(100);
						afterAll(async () => {
							await Bun.sleep(400);
							shared.lateHook = "stale";
						});
						test("first body", () => {});
					`,
					"2-second.test.ts": `
						import { expect } from "bun:test";
						import { trackTestLifetime } from HELPER;
						await Bun.sleep(800);
						const { test } = trackTestLifetime();
						test("passes only on the late afterAll write", () => {
							expect((globalThis as { lateHook?: string }).lateHook).toBe("stale");
						});
					`,
				},
				["--timeout", "60000"],
			),
		]);

		expect(raised.outcome("runs for six seconds")).toBe("pass");
		expect(raised.outcome("healthy after it")).toBe("pass");
		expect(lowered.outcome("passes only on the late afterAll write")).toBe("fail");
		expect(lowered.output).toContain(refusal("an afterAll hook"));
	}, 60_000);

	test("keeps deadlines on real time when a healthy test drives fake timers past them", async () => {
		const [yielding, direct] = await Promise.all([
			runFixtures({
				"fake-clock.test.ts": `
					import { vi } from "bun:test";
					import { trackTestLifetime } from HELPER;
					const { test } = trackTestLifetime();
					test("advances fake time past its own timeout", async () => {
						vi.useFakeTimers();
						await Promise.resolve();
						vi.advanceTimersByTime(20_001);
						await Promise.resolve();
						vi.useRealTimers();
					}, 20_000);
					test("healthy after it", () => {});
				`,
			}),
			runFixtures({
				// Ordinary use: a timer the test awaits, driven by advancing fake time.
				"fake-sleep.test.ts": `
					import { vi } from "bun:test";
					import { trackTestLifetime } from HELPER;
					const { test } = trackTestLifetime();
					test("awaits a sleep it advances fake time past", async () => {
						vi.useFakeTimers();
						const sleeping = Bun.sleep(1000);
						vi.advanceTimersByTime(10_000);
						await sleeping;
						vi.useRealTimers();
					});
					test("healthy after it", () => {});
				`,
			}),
		]);

		expect(yielding.outcome("advances fake time past its own timeout")).toBe("pass");
		expect(direct.outcome("awaits a sleep it advances fake time past")).toBe("pass");
		for (const run of [yielding, direct]) {
			expect(run.outcome("healthy after it")).toBe("pass");
			expect(run.exitCode).toBe(0);
		}
	}, 60_000);

	test("counts a body's synchronous work before its first await toward its deadline", async () => {
		const run = await runFixtures({
			"1-first.test.ts": `
				import { trackTestLifetime } from HELPER;
				const { test, afterAll } = trackTestLifetime();
				const shared = globalThis as { lateHook?: string };
				shared.lateHook = "initial";
				afterAll(async () => {
					const end = Bun.nanoseconds() + 400e6;
					while (Bun.nanoseconds() < end) {}
					await Bun.sleep(300);
					shared.lateHook = "stale";
				}, 500);
				test("first body", () => {});
			`,
			"2-second.test.ts": `
				import { expect } from "bun:test";
				import { trackTestLifetime } from HELPER;
				await Bun.sleep(1500);
				const { test } = trackTestLifetime();
				test("passes only on the late afterAll write", () => {
					expect((globalThis as { lateHook?: string }).lateHook).toBe("stale");
				});
			`,
		});

		expect(run.outcome("passes only on the late afterAll write")).toBe("fail");
		expect(run.output).toContain(refusal("an afterAll hook"));
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
				test.skip("a bodyless skipped test");
				test.todo("a bodyless todo");
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
				import { noteTeardown } from HELPER;
				afterEach(async () => {
					noteTeardown();
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
			[
				'test("calls done", done => setTimeout(done, 50));',
				"beforeEach(done => setTimeout(done, 50));",
				'test.each([[1], [2]])("row %d calls done", (_row, done) => setTimeout(done, 50));',
			].map(declaration =>
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

	test("refuses later results after a .each row times out", async () => {
		const run = await runFixtures({
			"each.test.ts": lateWriteAfter(`
				test.each([[400]])("row holding %dms", async ms => {
					await Bun.sleep(ms);
					shared.key = "stale";
				}, 100);
			`),
		});

		expect(run.outcome("passes only on the late write")).toBe("fail");
		expect(run.output).toContain(refusal("row holding %dms"));
	}, 60_000);

	test("refuses concurrent tests plainly instead of reporting a timeout", async () => {
		const run = await runFixtures({
			"concurrent.test.ts": `
				import { describe } from "bun:test";
				import { trackTestLifetime } from HELPER;
				const { test } = trackTestLifetime();
				describe.concurrent("run together", () => {
					test("a", () => Bun.sleep(150));
					test("b", () => Bun.sleep(150));
				});
			`,
		});

		// The thrown error, not Bun's excerpt of the helper's source around it.
		expect(run.output).toContain("error: trackTestLifetime: tracked files run their tests one at a time");
		expect(run.outcome("b")).toBe("fail");
		expect(run.output).not.toMatch(/error: "[^"]+" timed out/);
	}, 60_000);

	test("reads a body's settlement from the promise itself, whatever properties it or Promise.prototype carries", async () => {
		const [ownThen, replacedPrototype, healthy] = await Promise.all([
			runFixtures({
				// A pending promise whose own then reports settlement at once.
				"pending.test.ts": lateWriteAfter(`
					test("returns a promise with its own then", () => {
						const pending = Bun.sleep(400).then(() => {
							shared.key = "stale";
						});
						Object.defineProperty(pending, "then", { value: (onSettled: () => void) => onSettled() });
						return pending;
					}, 100);
				`),
			}),
			runFixtures({
				// Promise.prototype.then replaced while the body is pending.
				"prototype.test.ts": lateWriteAfter(`
					test("runs while Promise.prototype.then is replaced", () => {
						const pending = Bun.sleep(400).then(() => {
							shared.key = "stale";
						});
						const original = Promise.prototype.then;
						Promise.prototype.then = function (onSettled) {
							Promise.prototype.then = original;
							onSettled?.(undefined);
							return this;
						};
						return pending;
					}, 100);
				`),
			}),
			runFixtures({
				// Healthy settled promises whose then, constructor or species a subscription would trip on.
				"healthy.test.ts": `
					import { trackTestLifetime } from HELPER;
					const { test } = trackTestLifetime();
					test("silent then", () => Object.defineProperty(Promise.resolve(), "then", { value: () => undefined }));
					test("null constructor", () => Object.defineProperty(Promise.resolve(), "constructor", { value: null }));
					test("throwing species", () => {
						class Odd extends Promise<void> {
							static get [Symbol.species](): never {
								throw new Error("species read");
							}
						}
						return Odd.resolve();
					});
					test("healthy after them", () => {});
				`,
			}),
		]);

		expect(ownThen.outcome("passes only on the late write")).toBe("fail");
		expect(ownThen.output).toContain(refusal("returns a promise with its own then"));
		expect(replacedPrototype.outcome("passes only on the late write")).toBe("fail");
		expect(replacedPrototype.output).toContain(refusal("runs while Promise.prototype.then is replaced"));
		for (const name of ["silent then", "null constructor", "throwing species", "healthy after them"]) {
			expect({ name, outcome: healthy.outcome(name) }).toEqual({ name, outcome: "pass" });
		}
		expect(healthy.exitCode).toBe(0);
	}, 60_000);
});
