import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

interface RunnerFrame {
	type?: string;
	id?: string;
	data?: string;
	status?: string;
	cancelled?: boolean;
	ename?: string;
	evalue?: string;
}

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");
const runnerPath = path.resolve(import.meta.dir, "../../../src/eval/py/runner.py");
const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const encoder = new TextEncoder();
// The Windows native-import regression below needs a real native extension to
// trigger the loader-lock deadlock (#7985, numpy#24290); a pure-`print` cell
// settles under the broken implementation too. Probe once so the test skips on
// machines without numpy instead of failing the suite.
const numpyAvailable = (() => {
	try {
		const probe = Bun.spawnSync([pythonPath, "-c", "import numpy"], { stdio: ["ignore", "ignore", "ignore"] });
		return probe.exitCode === 0;
	} catch {
		return false;
	}
})();

interface Runner {
	send(req: Record<string, unknown>): void;
	nextFrame(): Promise<RunnerFrame>;
	dispose(): Promise<void>;
}

function spawnRunner(): Runner {
	const proc = Bun.spawn([pythonPath, "-u", runnerPath], {
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
	});
	const stderr = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";

	return {
		send(req) {
			proc.stdin.write(encoder.encode(`${JSON.stringify(req)}\n`));
			proc.stdin.flush();
		},
		async nextFrame() {
			while (true) {
				const newline = pending.indexOf("\n");
				if (newline >= 0) {
					const line = pending.slice(0, newline);
					pending = pending.slice(newline + 1);
					return JSON.parse(line) as RunnerFrame;
				}
				const { value, done } = await reader.read();
				if (done) throw new Error(`Python runner exited before frame: ${await stderr}`);
				pending += decoder.decode(value, { stream: true });
			}
		},
		async dispose() {
			try {
				proc.stdin.write(encoder.encode(`${JSON.stringify({ type: "exit" })}\n`));
				proc.stdin.end();
			} catch {
				// stdin may already be closed.
			}
			try {
				reader.releaseLock();
			} catch {
				// Reader may already be released.
			}
			try {
				proc.kill("SIGKILL");
			} catch {
				// Process already exited.
			}
		},
	};
}

async function collectDoneOrder(runner: Runner, ids: Set<string>): Promise<RunnerFrame[]> {
	const dones: RunnerFrame[] = [];
	const seen = new Set<string>();
	while (seen.size < ids.size) {
		const frame = await runner.nextFrame();
		if (frame.type === "done" && frame.id && ids.has(frame.id) && !seen.has(frame.id)) {
			seen.add(frame.id);
			dones.push(frame);
		}
	}
	return dones;
}

// Auto-backgrounded cells, user Python shortcuts, and kernel-defined tool calls
// from subagents can all be in flight on one kernel at once. The runner must keep dispatching sibling
// requests while a cell is parked on a top-level await instead of blocking the
// control channel until it finishes -- the regression that a naive fix for the
// Windows numpy import hang (#7985) would introduce.
describe("Python runner request dispatch", () => {
	it("interleaves a fast request past a slow one parked on a top-level await", async () => {
		if (process.platform === "win32") return; // Windows dispatches serially by design; see _serve_windows.
		const runner = spawnRunner();
		try {
			runner.send({ id: "slow", code: "import asyncio\nawait asyncio.sleep(0.5)\nprint('slow-done')" });
			runner.send({ id: "fast", code: "print('fast-done')" });
			const dones = await collectDoneOrder(runner, new Set(["slow", "fast"]));
			expect(dones.map(frame => frame.id)).toEqual(["fast", "slow"]);
			expect(dones.every(frame => frame.status === "ok")).toBe(true);
		} finally {
			await runner.dispose();
		}
	});

	it("drops a stray await on a sync prelude helper only while its name binds the helper", async () => {
		const runner = spawnRunner();
		const run = async (id: string, code: string): Promise<RunnerFrame> => {
			runner.send({ id, code });
			const [done] = await collectDoneOrder(runner, new Set([id]));
			return done;
		};
		try {
			expect(
				(await run("setup", "def sh(command):\n    return command.upper()\n__omp_register_sync_helpers(sh)"))
					.status,
			).toBe("ok");
			// JS-style `await sh(...)` used to raise "'str' object can't be awaited".
			expect((await run("awaited", 'assert await sh("ok") == "OK"')).status).toBe("ok");
			// Rebinding in the same cell keeps the `await`: the run-time binding is async.
			expect(
				(await run("same-cell", 'async def sh(command):\n    return command\nassert await sh("ok") == "ok"'))
					.status,
			).toBe("ok");
			// The retained async rebinding is no longer the registered helper.
			expect((await run("later-cell", 'assert await sh("ok") == "ok"')).status).toBe("ok");
		} finally {
			await runner.dispose();
		}
	});

	it.skipIf(process.platform !== "win32")(
		"settles requests serially on Windows",
		async () => {
			// _serve_windows handles one request at a time: the serial control
			// read is what keeps no thread parked in a blocking stdin read
			// while a cell runs (the numpy#24290 deadlock). Siblings must queue
			// behind a running cell rather than overtake it -- the observable
			// distinction from the concurrent POSIX path, pinned by the
			// interleave test above. Under the pre-fix reader the fast cell
			// settles first, so this also fails on a reintroduced bug.
			const runner = spawnRunner();
			try {
				runner.send({ id: "slow", code: "import asyncio\nawait asyncio.sleep(0.4)\nprint('slow-done')" });
				runner.send({ id: "fast", code: "print('fast-done')" });
				const dones = await collectDoneOrder(runner, new Set(["slow", "fast"]));
				expect(dones.map(frame => frame.id)).toEqual(["slow", "fast"]);
				expect(dones.every(frame => frame.status === "ok")).toBe(true);
			} finally {
				await runner.dispose();
			}
		},
		15_000,
	);

	it.skipIf(process.platform !== "win32" || !numpyAvailable)(
		"completes a native-extension import instead of deadlocking",
		async () => {
			// Regression for #7985: the pre-fix runner kept a background thread
			// parked in a blocking stdin read while cells ran, which deadlocked
			// native DLL loading. A pure-`print` cell settles under both
			// implementations, so this test must actually import a native
			// extension and assert the request completes -- a reintroduced hang
			// resurfaces here as a hard timeout instead of a pass.
			// A hung subprocess cannot be driven by fake timers; the real
			// deadline below is what turns the deadlock into a failure.
			const runner = spawnRunner();
			try {
				runner.send({ id: "np", code: "import numpy as np\nprint(np.__version__)" });
				const [done] = await Promise.race([
					collectDoneOrder(runner, new Set(["np"])),
					Bun.sleep(25_000).then(() => {
						throw new Error("native import hung: runner blocked on a concurrent stdin read");
					}),
				]);
				expect(done.type).toBe("done");
			} finally {
				await runner.dispose();
			}
		},
		30_000,
	);
	it("interrupts a cell whose interrupt request arrives before its task starts", async () => {
		if (process.platform === "win32") return; // Windows dispatches serially by design; see _serve_windows.
		const runner = spawnRunner();
		try {
			runner.send({
				id: "setup",
				code: [
					"import threading",
					"from types import SimpleNamespace",
					"seed = 41",
					"gate = threading.Event()",
					"__omp_tools__ = {'release': SimpleNamespace(fn=lambda: gate.set())}",
				].join("\n"),
			});
			const [setup] = await collectDoneOrder(runner, new Set(["setup"]));
			expect(setup.status).toBe("ok");

			runner.send({ id: "hold", code: "print('holding', flush=True)\ngate.wait()" });
			while (true) {
				const frame = await runner.nextFrame();
				if (frame.type === "stdout" && frame.id === "hold" && frame.data?.includes("holding")) break;
			}

			// A late interrupt for an already-settled cell (`setup`) must be
			// ignored instead of sticking in `_STATE.interrupt_ids`.
			runner.send({ id: "setup", type: "interrupt" });

			// While `hold` occupies the main thread, `aborted` and `setup-err`
			// stay queued in `queue` without a running task when the reader
			// thread processes their `interrupt` requests and then `release`.
			runner.send({ id: "aborted", code: "seed = 0" });
			runner.send({ id: "aborted", type: "interrupt" });
			// A NUL byte makes `os.chdir` raise ValueError: a setup error (a missing cwd only warns).
			runner.send({ id: "setup-err", code: "seed = 0", cwd: "/tmp/omp\u0000setup-err" });
			runner.send({ id: "setup-err", type: "interrupt" });
			runner.send({ id: "release", type: "tool", op: "call", name: "release", args: {} });

			const errors: RunnerFrame[] = [];
			const dones = new Map<string, RunnerFrame>();
			while (dones.size < 4) {
				const frame = await runner.nextFrame();
				if (frame.type === "error" && frame.id === "aborted") {
					errors.push(frame);
				}
				if (
					frame.type === "done" &&
					frame.id &&
					(frame.id === "hold" || frame.id === "aborted" || frame.id === "setup-err" || frame.id === "release")
				) {
					dones.set(frame.id, frame);
				}
			}

			expect(dones.get("hold")).toMatchObject({ type: "done", id: "hold", status: "ok", cancelled: false });
			expect(errors).toEqual([
				expect.objectContaining({
					type: "error",
					id: "aborted",
					ename: "KeyboardInterrupt",
					evalue: "Execution interrupted",
				}),
			]);
			expect(dones.get("aborted")).toMatchObject({
				type: "done",
				id: "aborted",
				status: "error",
				cancelled: true,
			});
			expect(dones.get("setup-err")).toMatchObject({
				type: "done",
				id: "setup-err",
				status: "error",
				cancelled: false,
			});

			// Neither the late interrupt for `setup` nor the early-return
			// setup-error cell may leave its id in `_STATE.interrupt_ids`.
			runner.send({ id: "setup", code: "seed += 1" });
			const [reusedSetup] = await collectDoneOrder(runner, new Set(["setup"]));
			expect(reusedSetup).toMatchObject({ type: "done", id: "setup", status: "ok", cancelled: false });

			runner.send({ id: "setup-err", code: "seed += 2" });
			const [reusedSetupErr] = await collectDoneOrder(runner, new Set(["setup-err"]));
			expect(reusedSetupErr).toMatchObject({ type: "done", id: "setup-err", status: "ok", cancelled: false });
			runner.send({ id: "verify", code: "assert seed == 44" });
			const [verify] = await collectDoneOrder(runner, new Set(["verify"]));
			expect(verify.status).toBe("ok");
		} finally {
			await runner.dispose();
		}
	});

	it("runs a cell whose session cwd no longer exists, with a warning", async () => {
		const runner = spawnRunner();
		try {
			runner.send({ id: "gone", code: "print('ran')", cwd: "/nonexistent/omp-missing-cwd" });
			const frames: RunnerFrame[] = [];
			while (true) {
				const frame = await runner.nextFrame();
				if (frame.id !== "gone") continue;
				frames.push(frame);
				if (frame.type === "done") break;
			}
			expect(frames.find(frame => frame.type === "stderr")?.data).toContain(
				"session cwd /nonexistent/omp-missing-cwd is unavailable",
			);
			expect(frames.find(frame => frame.type === "stdout")?.data).toContain("ran");
			expect(frames.at(-1)).toMatchObject({ type: "done", status: "ok" });
		} finally {
			await runner.dispose();
		}
	});

	it("preserves source code in linecache for inspect.getsource across consecutive cells", async () => {
		const runner = spawnRunner();
		try {
			runner.send({
				id: "def-cell",
				code: "def sample_worker(val):\n    # Return scaled\n    return val * 42\n",
			});
			const defFrames: RunnerFrame[] = [];
			while (true) {
				const frame = await runner.nextFrame();
				if (frame.id === "def-cell") {
					defFrames.push(frame);
					if (frame.type === "done") break;
				}
			}
			const defDone = defFrames.find(f => f.type === "done");
			expect(defDone?.status).toBe("ok");

			runner.send({
				id: "inspect-cell",
				code: "import inspect\nsource = inspect.getsource(sample_worker)\nprint('INSPECT_OUTPUT:', repr(source))",
			});
			const inspectFrames: RunnerFrame[] = [];
			while (true) {
				const frame = await runner.nextFrame();
				if (frame.id === "inspect-cell") {
					inspectFrames.push(frame);
					if (frame.type === "done") break;
				}
			}
			const inspectDone = inspectFrames.find(f => f.type === "done");
			const stdout = inspectFrames
				.filter(f => f.type === "stdout")
				.map(f => f.data ?? "")
				.join("");

			expect(inspectDone?.status).toBe("ok");
			expect(stdout).toContain("INSPECT_OUTPUT:");
			expect(stdout).toContain("def sample_worker(val):");
			expect(stdout).toContain("return val * 42");
		} finally {
			await runner.dispose();
		}
	});
});
