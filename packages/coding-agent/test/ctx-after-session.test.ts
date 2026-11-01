/**
 * The contract `docs/extensions.md` states for a `ctx` call that meets the end
 * of its session: omp observes only the promise it hands back, so dropping that
 * one ends nothing but the call, while every promise the extension derives from
 * it — `then`, `finally`, `Promise.all`, an async function awaiting it — is the
 * extension's to observe, and a dropped rejection ends the process. A call made
 * after the end refuses by throwing, before any promise exists for a `.catch()`
 * to attach to.
 *
 * Only a separate process shows that: an unhandled rejection is fatal through
 * the postmortem handler, which no in-process assertion can observe. Each shape
 * runs in its own child (`fixtures/ctx-after-session-probe.ts`).
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const PROBE_PATH = path.join(import.meta.dir, "fixtures", "ctx-after-session-probe.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

interface ProbeRun {
	readonly exitCode: number;
	readonly observations: Array<{ what: string; detail?: unknown; hostCalls: number }>;
}

async function runShape(shape: string): Promise<ProbeRun> {
	const proc = Bun.spawn([process.execPath, PROBE_PATH, shape], {
		cwd: REPO_ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, observations: Bun.JSONL.parse(stdout) as ProbeRun["observations"] };
}

describe("a ctx call that meets the end of its session", () => {
	test("ends the process only for a promise the extension derived and dropped", async () => {
		const shapes = [
			"dropped-original",
			"derived-then",
			"derived-then-handler",
			"derived-finally",
			"derived-all",
			"derived-async",
			"derived-async-try",
		] as const;
		const runs = await Promise.all(shapes.map(shape => runShape(shape)));
		const exits = Object.fromEntries(shapes.map((shape, index) => [shape, runs[index]?.exitCode]));
		const handled = Object.fromEntries(
			shapes.map((shape, index) => [shape, runs[index]?.observations.map(entry => entry.what)]),
		);

		expect({ exits, handled }).toEqual({
			exits: {
				// omp observes the promise it handed back: dropping it ends only that call.
				"dropped-original": 0,
				// Derived and unobserved: the rejection ends the process.
				"derived-then": 1,
				"derived-finally": 1,
				"derived-all": 1,
				"derived-async": 1,
				// Derived and observed.
				"derived-then-handler": 0,
				"derived-async-try": 0,
			},
			handled: {
				"dropped-original": ["survived"],
				// The fatal shapes die before the probe's last line; `finally` still runs.
				"derived-then": [],
				"derived-finally": ["finally"],
				"derived-all": [],
				"derived-async": [],
				"derived-then-handler": ["caught", "survived"],
				"derived-async-try": ["caught", "survived"],
			},
		});
	}, 180_000);

	test("refuses a call made after the end by throwing, which only a try around the call catches", async () => {
		const [awaited, caught] = await Promise.all([runShape("after-end-await-try"), runShape("after-end-catch")]);

		expect({
			// The member throws: no promise is returned, and the host is never called.
			awaited: {
				exit: awaited.exitCode,
				observations: awaited.observations.map(entry => ({
					what: entry.what,
					detail: entry.detail,
					hostCalls: entry.hostCalls,
				})),
			},
			// `.catch()` has nothing to attach to, so the exception reaches the process.
			caught: { exit: caught.exitCode, observations: caught.observations.map(entry => entry.what) },
		}).toEqual({
			awaited: {
				exit: 0,
				observations: [
					{
						what: "caught",
						detail: { returned: false, error: expect.stringContaining("retired") },
						hostCalls: 0,
					},
					{ what: "survived", detail: undefined, hostCalls: 0 },
				],
			},
			caught: { exit: 1, observations: [] },
		});
	}, 180_000);
});
