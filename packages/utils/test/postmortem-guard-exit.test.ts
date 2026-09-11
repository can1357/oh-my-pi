import { describe, expect, it } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";

// Regression for #11789: host-owned hard exits (composer double-Ctrl-C,
// input-controller stuck-teardown) can fire while an extension-load
// `withHostGuard` window has swapped process.exit/process.reallyExit for stubs
// that throw ExtensionExitError. `postmortem.exitProcess` must terminate the
// process through the native primitive even when the exit chain is poisoned by
// nested guard stubs, instead of re-entering the guard and looping the
// unhandled-rejection storm.

const NATIVE = postmortem.NATIVE_PROCESS_EXIT;
const directFlag = "--guard-exit-direct-child";
const fatalFlag = "--guard-exit-fatal-child";

/**
 * Install a two-level poisoned exit chain: each global becomes
 * `outerStub -> innerStub -> native`. A single unwrap lands on `innerStub`
 * (still a throwing stub); only a full chain walk reaches native.
 */
function poisonExitChain(): void {
	const stub = (message: string) =>
		((_code?: number) => {
			const err = new Error(message);
			err.name = "ExtensionExitError";
			throw err;
		}) as (code?: number) => never;

	if (typeof process.reallyExit === "function") {
		const inner = stub("inner reallyExit stub");
		Reflect.set(inner, NATIVE, process.reallyExit);
		const outer = stub("outer reallyExit stub");
		Reflect.set(outer, NATIVE, inner);
		process.reallyExit = outer as typeof process.reallyExit;
	}
	const innerExit = stub("inner exit stub");
	Reflect.set(innerExit, NATIVE, process.exit);
	const outerExit = stub("outer exit stub");
	Reflect.set(outerExit, NATIVE, innerExit);
	process.exit = outerExit as typeof process.exit;
}

if (process.argv.includes(directFlag)) {
	// Host callsite behavior: a hard exit issued while the guard chain is poisoned.
	poisonExitChain();
	postmortem.exitProcess(130);
	process.stderr.write("REACHED-END\n");
} else if (process.argv.includes(fatalFlag)) {
	// Raw guard throw reaching the global fatal handler, whose exitProcess(1) must
	// terminate cleanly rather than re-throwing into an unhandled-rejection loop.
	poisonExitChain();
	const err = new Error("Module called process.exit(130) during guarded extension/hook loading");
	err.name = "ExtensionExitError";
	void Promise.reject(err);
	await new Promise<never>(() => {});
}

if (!process.argv.includes(directFlag) && !process.argv.includes(fatalFlag)) {
	describe("postmortem guard-window exit (#11789)", () => {
		it("exports a hard-exit primitive host callsites can route through", () => {
			expect(typeof postmortem.exitProcess).toBe("function");
		});

		it("exits with the requested code through a poisoned guard chain", async () => {
			const child = Bun.spawn([process.execPath, "run", import.meta.path, directFlag], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode).toBe(130);
			expect(stdout).toBe("");
			expect(stderr).not.toContain("REACHED-END");
			expect(stderr).not.toContain("ExtensionExitError");
		});

		it("bounds the fatal path to a single rejection instead of an ExtensionExitError storm", async () => {
			// The fix guarantees a bounded exit; an unfixed exitProcess re-throws and
			// loops, in which case the child never exits and bun's per-test timeout
			// surfaces the regression. No wall-clock watchdog is needed here.
			const child = Bun.spawn([process.execPath, "run", import.meta.path, fatalFlag], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
				const rejections = stderr.split("[Unhandled Rejection]").length - 1;
				expect(exitCode).toBe(1);
				expect(rejections).toBe(1);
				expect(stderr).toContain("ExtensionExitError");
			} finally {
				child.kill();
				await child.exited;
			}
		});
	});
}
