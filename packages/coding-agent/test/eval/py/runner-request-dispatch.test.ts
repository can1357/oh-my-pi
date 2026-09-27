import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

interface RunnerFrame {
	type?: string;
	id?: string;
	data?: string;
	status?: string;
	revision?: number;
	digest?: string;
	admissionRejected?: boolean;
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

// Eval sessions are shared across concurrent agents (subagents inherit the
// parent's eval session id, per executor-base.ts), so multiple requests can be
// in flight on one kernel at once. The runner must keep dispatching sibling
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

	it("settles every request and exits cleanly", async () => {
		const runner = spawnRunner();
		try {
			runner.send({ id: "a", code: "print(1 + 1)" });
			runner.send({ id: "b", code: "print('two')" });
			const dones = await collectDoneOrder(runner, new Set(["a", "b"]));
			expect(dones.map(frame => frame.status).sort()).toEqual(["ok", "ok"]);
		} finally {
			await runner.dispose();
		}
	});

	it("preserves cell locals and resets call-site occurrences", async () => {
		const runner = spawnRunner();
		const cell = ['path = "cell.txt"', 'tool.read({"path": locals()["path"]})'].join("\n");
		try {
			runner.send({
				id: "setup",
				code: [
					"identities = []",
					"occurrences = {}",
					"def __omp_reset_call_occurrences__():",
					"    occurrences.clear()",
					"def __omp_with_call_site__(site_id, action, args):",
					"    occurrence = occurrences.get(site_id, 0)",
					"    occurrences[site_id] = occurrence + 1",
					"    identities.append((site_id, occurrence, args))",
					"    return action(args)",
					"class Tool:",
					"    def read(self, args):",
					"        return args['path']",
					"tool = Tool()",
				].join("\n"),
			});
			await collectDoneOrder(runner, new Set(["setup"]));

			runner.send({ id: "first", code: cell });
			const [first] = await collectDoneOrder(runner, new Set(["first"]));
			expect(first.status).toBe("ok");
			runner.send({ id: "second", code: cell });
			const [second] = await collectDoneOrder(runner, new Set(["second"]));
			expect(second.status).toBe("ok");

			runner.send({
				id: "assert",
				code: 'assert [identity[1:] for identity in identities] == [(0, {"path": "cell.txt"}), (0, {"path": "cell.txt"})]',
			});
			const [assertion] = await collectDoneOrder(runner, new Set(["assert"]));
			expect(assertion.status).toBe("ok");
		} finally {
			await runner.dispose();
		}
	});

	it("restores the reserved call-site helper polluted by a retained cell", async () => {
		const runner = spawnRunner();
		try {
			runner.send({
				id: "setup",
				code: [
					"identities = []",
					"occurrences = {}",
					"def __omp_reset_call_occurrences__():",
					"    occurrences.clear()",
					"def __omp_with_call_site__(site_id, action, args):",
					"    occurrence = occurrences.get(site_id, 0)",
					"    occurrences[site_id] = occurrence + 1",
					"    identities.append((site_id, occurrence, args))",
					"    return action(args)",
					"class Tool:",
					"    def read(self, args):",
					"        return args['path']",
					"tool = Tool()",
				].join("\n"),
			});
			await collectDoneOrder(runner, new Set(["setup"]));

			// A retained cell shadows the reserved helper; the cell itself stays
			// green because instrumentation skips cells that bind the name.
			runner.send({ id: "pollute", code: "__omp_with_call_site__ = None" });
			const [polluted] = await collectDoneOrder(runner, new Set(["pollute"]));
			expect(polluted.status).toBe("ok");

			// The next ordinary read must still resolve the genuine helper
			// instead of calling the user-controlled None.
			runner.send({ id: "read", code: 'tool.read({"path": "note.txt"})' });
			const [read] = await collectDoneOrder(runner, new Set(["read"]));
			expect(read.status).toBe("ok");

			// Deleting the helper must not break later reads either.
			runner.send({ id: "delete", code: "del __omp_with_call_site__" });
			const [deleted] = await collectDoneOrder(runner, new Set(["delete"]));
			expect(deleted.status).toBe("ok");
			runner.send({ id: "reread", code: 'tool.read({"path": "note.txt"})' });
			const [reread] = await collectDoneOrder(runner, new Set(["reread"]));
			expect(reread.status).toBe("ok");

			runner.send({
				id: "assert",
				code: 'assert [identity[2] for identity in identities] == [{"path": "note.txt"}, {"path": "note.txt"}]',
			});
			const [assertion] = await collectDoneOrder(runner, new Set(["assert"]));
			expect(assertion.status).toBe("ok");
		} finally {
			await runner.dispose();
		}
	});

	it.skipIf(process.platform !== "win32")("handles shadow controls and stale shadow admission", async () => {
		const runner = spawnRunner();
		try {
			runner.send({ id: "seed", code: "window_admission_guard = 1" });
			await collectDoneOrder(runner, new Set(["seed"]));

			runner.send({ id: "snapshot", type: "shadow_snapshot" });
			const snapshot = await runner.nextFrame();
			expect(snapshot).toMatchObject({
				type: "shadow_snapshot",
				id: "snapshot",
				eligible: true,
			});
			if (snapshot.revision === undefined || snapshot.digest === undefined) {
				throw new Error("expected shadow snapshot revision and digest");
			}

			runner.send({ id: "mutate", code: "window_admission_guard = 2" });
			await collectDoneOrder(runner, new Set(["mutate"]));
			runner.send({
				id: "stale",
				code: "window_admission_guard = 3",
				expectedShadowRevision: snapshot.revision,
				expectedShadowDigest: snapshot.digest,
			});
			expect(await runner.nextFrame()).toMatchObject({
				type: "done",
				id: "stale",
				admissionRejected: true,
			});

			runner.send({ id: "plan", type: "shadow_plan", code: "shadow_control_leak = True" });
			expect(await runner.nextFrame()).toMatchObject({
				type: "shadow_plan",
				id: "plan",
				eligible: true,
			});

			runner.send({
				id: "run",
				code: "assert window_admission_guard == 2 and 'shadow_control_leak' not in globals()",
			});
			const [done] = await collectDoneOrder(runner, new Set(["run"]));
			expect(done.status).toBe("ok");
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
	it("plans operations only for awaited tool reads", async () => {
		// Unawaited `tool.read({...})` never reaches the bridge: the kernel
		// tool attribute is async, so a bare call only builds a coroutine.
		// The planner must admit an operation only for the awaited form and
		// fail closed (barrier, zero operations) otherwise -- a phantom
		// physical read is planned under the pre-fix implementation, so the
		// unawaited assertion below fails there.
		const runner = spawnRunner();
		try {
			runner.send({ id: "unawaited", type: "shadow_plan", code: 'result = tool.read({"path": "note.txt"})' });
			await expect(runner.nextFrame()).resolves.toMatchObject({
				type: "shadow_plan",
				id: "unawaited",
				eligible: true,
				operations: [],
				barrier: expect.anything(),
			});

			runner.send({ id: "awaited", type: "shadow_plan", code: 'result = await tool.read({"path": "note.txt"})' });
			await expect(runner.nextFrame()).resolves.toMatchObject({
				type: "shadow_plan",
				id: "awaited",
				eligible: true,
				operations: [expect.anything()],
				barrier: null,
			});
		} finally {
			await runner.dispose();
		}
	});

	it("fails closed when the retained namespace shadows str", async () => {
		// After an earlier cell binds `str`, name resolution in a later cell
		// selects the user-owned retained binding, not the builtin -- while
		// the pre-fix planner only consulted same-cell bindings and still
		// projected the builtin `Python.str` transform, planning a physical
		// read that authoritative Python would reject with a TypeError.
		const runner = spawnRunner();
		try {
			runner.send({
				id: "admitted",
				type: "shadow_plan",
				code: 'result = await tool.read({"path": str("secret.txt")})',
			});
			expect(await runner.nextFrame()).toMatchObject({
				type: "shadow_plan",
				id: "admitted",
				eligible: true,
				operations: [expect.anything()],
				barrier: null,
			});

			runner.send({ id: "shadow", code: "str = None" });
			const [shadowed] = await collectDoneOrder(runner, new Set(["shadow"]));
			expect(shadowed.status).toBe("ok");

			runner.send({
				id: "rejected",
				type: "shadow_plan",
				code: 'result = await tool.read({"path": str("secret.txt")})',
			});
			expect(await runner.nextFrame()).toMatchObject({
				type: "shadow_plan",
				id: "rejected",
				eligible: true,
				operations: [],
				barrier: expect.anything(),
			});
		} finally {
			await runner.dispose();
		}
	});

	it("fails closed when the retained namespace shadows str with a function", async () => {
		// Function values are never JSON-safe, so a retained `str = lambda ...`
		// is omitted from the shadow snapshot exactly like an absent binding.
		// Snapshot absence alone would misread it as the intact builtin and plan
		// a physical read, while authoritative Python invokes the lambda (here
		// raising before any bridge call). The planner instead seeds retained
		// user-namespace bindings and fails closed.
		const runner = spawnRunner();
		try {
			runner.send({ id: "shadow-fn", code: "str = lambda x: 1 / 0" });
			const [shadowed] = await collectDoneOrder(runner, new Set(["shadow-fn"]));
			expect(shadowed.status).toBe("ok");

			runner.send({
				id: "rejected-fn",
				type: "shadow_plan",
				code: 'result = await tool.read({"path": str("secret.txt")})',
			});
			expect(await runner.nextFrame()).toMatchObject({
				type: "shadow_plan",
				id: "rejected-fn",
				eligible: true,
				operations: [],
				barrier: expect.anything(),
			});
		} finally {
			await runner.dispose();
		}
	});

	it("fails closed when the retained namespace shadows the tool bridge", async () => {
		// A retained non-JSON-safe `tool` binding (e.g. `tool = object()`) is
		// omitted from the shadow snapshot exactly like the genuine prelude
		// bridge, so snapshot absence alone cannot tell them apart. The
		// planner must consult the namespace directly and admit speculative
		// reads only for the marker-tagged (`__omp_tool_bridge__`) genuine
		// bridge: authoritative execution against the shadow raises
		// AttributeError before any bridge call, while the pre-fix
		// `"tool" not in snapshot` check plans a phantom physical read.
		// Contract note: fakes standing in for the production bridge must
		// carry the marker to be treated as the genuine bridge (mirroring
		// the `__omp_tool_bridge__` class attribute on the prelude proxy).
		const runner = spawnRunner();
		try {
			runner.send({ id: "shadow", code: "tool = object()" });
			const [shadowed] = await collectDoneOrder(runner, new Set(["shadow"]));
			expect(shadowed.status).toBe("ok");

			runner.send({ id: "rejected", type: "shadow_plan", code: 'result = await tool.read({"path": "note.txt"})' });
			expect(await runner.nextFrame()).toMatchObject({
				type: "shadow_plan",
				id: "rejected",
				eligible: true,
				operations: [],
				barrier: expect.anything(),
			});

			// Tagged-bridge control: the same shape of binding carrying the
			// marker (as the production prelude proxy does) still admits.
			runner.send({
				id: "retag",
				code: ["class TaggedTool:", "    __omp_tool_bridge__ = True", "tool = TaggedTool()"].join("\n"),
			});
			const [retagged] = await collectDoneOrder(runner, new Set(["retag"]));
			expect(retagged.status).toBe("ok");

			runner.send({ id: "control", type: "shadow_plan", code: 'result = await tool.read({"path": "note.txt"})' });
			expect(await runner.nextFrame()).toMatchObject({
				type: "shadow_plan",
				id: "control",
				eligible: true,
				operations: [expect.anything()],
				barrier: null,
			});
		} finally {
			await runner.dispose();
		}
	});

	it("rejects spoofed bridge markers and invalidates digests on rebinding", async () => {
		// The marker alone is reproducible by evaluated code, so trust requires
		// object identity with the first-sighted bridge as well: a later
		// marker-carrying replacement must fail closed. And since such swaps
		// leave no JSON-safe trace, the snapshot digest must cover the binding
		// identity or stale plans would keep verifying.
		const runner = spawnRunner();
		try {
			runner.send({
				id: "setup",
				code: ["class TaggedTool:", "    __omp_tool_bridge__ = True", "tool = TaggedTool()"].join("\n"),
			});
			await collectDoneOrder(runner, new Set(["setup"]));

			runner.send({ id: "plan1", type: "shadow_plan", code: 'result = await tool.read({"path": "note.txt"})' });
			const first = await runner.nextFrame();
			expect(first).toMatchObject({
				type: "shadow_plan",
				id: "plan1",
				eligible: true,
				operations: [expect.anything()],
				barrier: null,
			});

			runner.send({
				id: "spoof",
				code: ["class SpoofBridge:", "    __omp_tool_bridge__ = True", "tool = SpoofBridge()"].join("\n"),
			});
			await collectDoneOrder(runner, new Set(["spoof"]));

			runner.send({ id: "plan2", type: "shadow_plan", code: 'result = await tool.read({"path": "note.txt"})' });
			const second = await runner.nextFrame();
			expect(second).toMatchObject({ type: "shadow_plan", id: "plan2", eligible: true, operations: [] });
			expect(second.digest).not.toBe(first.digest);

			runner.send({ id: "shadow-str", code: "str = lambda x: 1 / 0" });
			await collectDoneOrder(runner, new Set(["shadow-str"]));

			runner.send({ id: "plan3", type: "shadow_plan", code: 'result = await tool.read({"path": "note.txt"})' });
			const third = await runner.nextFrame();
			expect(third.digest).not.toBe(second.digest);
		} finally {
			await runner.dispose();
		}
	});

	it("plans zero operations for cells that fail whole-cell compilation", async () => {
		// `await tool.read({"path": path}); global path` parses with
		// `ast.parse` but `compile()` rejects it (use-before-global), and
		// authoritative `_compile_source()` raises SyntaxError before any
		// bridge call -- while the pre-fix planner admitted the read against
		// the retained `path`. The shadow path applies the same compile gate
		// (same filename/mode/flags, so top-level await stays legal) and
		// fails closed with zero operations plus an invalidating barrier.
		const runner = spawnRunner();
		try {
			runner.send({ id: "seed", code: 'path = "secret.txt"' });
			const [seeded] = await collectDoneOrder(runner, new Set(["seed"]));
			expect(seeded.status).toBe("ok");

			runner.send({ id: "valid", type: "shadow_plan", code: 'result = await tool.read({"path": path})' });
			expect(await runner.nextFrame()).toMatchObject({
				type: "shadow_plan",
				id: "valid",
				eligible: true,
				operations: [expect.anything()],
				barrier: null,
			});

			runner.send({
				id: "invalid",
				type: "shadow_plan",
				code: 'result = await tool.read({"path": path}); global path',
			});
			expect(await runner.nextFrame()).toMatchObject({
				type: "shadow_plan",
				id: "invalid",
				eligible: true,
				operations: [],
				barrier: expect.anything(),
			});
		} finally {
			await runner.dispose();
		}
	});
	it("plans zero operations when the cell binds the reserved call-site helper", async () => {
		// Runtime `_compile_source` skips instrumentation for the whole cell
		// when it binds `__omp_with_call_site__` anywhere, so a speculative
		// read projected from before the binding would never be claimed by
		// the authoritative call (file read twice). The planner mirrors the
		// whole-cell skip and fails closed with zero operations plus an
		// invalidating barrier.
		const runner = spawnRunner();
		try {
			runner.send({ id: "clean", type: "shadow_plan", code: 'result = await tool.read({"path": "a.txt"})' });
			expect(await runner.nextFrame()).toMatchObject({
				type: "shadow_plan",
				id: "clean",
				eligible: true,
				operations: [expect.anything()],
				barrier: null,
			});

			runner.send({
				id: "bound",
				type: "shadow_plan",
				code: 'result = await tool.read({"path": "a.txt"})\ndef __omp_with_call_site__(): pass',
			});
			expect(await runner.nextFrame()).toMatchObject({
				type: "shadow_plan",
				id: "bound",
				eligible: true,
				operations: [],
				barrier: expect.anything(),
			});
		} finally {
			await runner.dispose();
		}
	});
});
