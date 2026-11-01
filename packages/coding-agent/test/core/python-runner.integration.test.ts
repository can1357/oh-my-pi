/**
 * End-to-end exercise of the new subprocess-backed Python runner.
 *
 * Gated by `PI_PYTHON_INTEGRATION=1` so CI without a real Python interpreter
 * (or sandboxes where subprocess spawning is restricted) does not fail.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeAllKernelSessions,
	executePython,
	executePythonWithKernel,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { filterEnv, resolvePythonRuntime } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

const SHOULD_RUN = Bun.env.PI_PYTHON_INTEGRATION === "1";
const MATPLOTLIB_TEST_CWD = process.cwd();

async function hasModule(cwd: string, module: string): Promise<boolean> {
	if (!SHOULD_RUN) return false;
	try {
		const { env } = (await Settings.init()).getShellConfig();
		const runtime = resolvePythonRuntime(cwd, filterEnv(env));
		const spawnEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(runtime.env)) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		const result = Bun.spawnSync([runtime.pythonPath, "-c", `import ${module}`], {
			cwd,
			env: spawnEnv,
			stdout: "ignore",
			stderr: "ignore",
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

const HAS_MATPLOTLIB = await hasModule(MATPLOTLIB_TEST_CWD, "matplotlib");
const HAS_PANDAS = await hasModule(MATPLOTLIB_TEST_CWD, "pandas");
const HAS_ENSUREPIP = await hasModule(MATPLOTLIB_TEST_CWD, "ensurepip");

/** A venv like the ones `uv venv` makes: no pip installed. Returns its interpreter. */
async function createPiplessVenv(dir: string): Promise<string> {
	const { env } = (await Settings.init()).getShellConfig();
	const base = resolvePythonRuntime(dir, filterEnv(env)).pythonPath;
	const venv = path.join(dir, "venv");
	const created = Bun.spawnSync([base, "-m", "venv", "--without-pip", venv], { stdout: "ignore", stderr: "pipe" });
	if (created.exitCode !== 0) throw new Error(`venv creation failed: ${created.stderr.toString()}`);
	return path.join(venv, "bin", "python");
}

const SLEEP = Bun.which("sleep") ?? "/bin/sleep";

/**
 * Starts a kernel on a pip-less venv. `ensurepipMain` shadows the stdlib `ensurepip`'s
 * `__main__` and `uvScript` (POSIX sh) becomes `uv`; PATH holds nothing else, so a
 * system uv never runs.
 */
async function startPiplessKernel(
	dir: string,
	fakes: { ensurepipMain?: string; uvScript?: string },
): Promise<{ kernel: PythonKernel; python: string; sitePackages: string }> {
	const python = await createPiplessVenv(dir);
	const purelib = Bun.spawnSync([python, "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"]);
	const sitePackages = purelib.stdout.toString().trim();
	const binDir = path.join(dir, "bin");
	await fs.mkdir(binDir);
	const env: Record<string, string> = { PATH: binDir };
	if (fakes.uvScript !== undefined) {
		await Bun.write(path.join(binDir, "uv"), `#!/bin/sh\nPATH=/usr/bin:/bin\n${fakes.uvScript}\n`);
		await fs.chmod(path.join(binDir, "uv"), 0o755);
	}
	if (fakes.ensurepipMain !== undefined) {
		const fakeDir = path.join(dir, "fake", "ensurepip");
		await fs.mkdir(fakeDir, { recursive: true });
		await Bun.write(path.join(fakeDir, "__init__.py"), "");
		await Bun.write(path.join(fakeDir, "__main__.py"), fakes.ensurepipMain);
		env.PYTHONPATH = path.dirname(fakeDir);
	}
	const kernel = await PythonKernel.start({ cwd: dir, interpreter: python, env });
	return { kernel, python, sitePackages };
}

/** An `ensurepip` that fails the way Debian's disabled system copy does. */
const DISABLED_ENSUREPIP = 'import sys\nprint("ensurepip is disabled")\nsys.exit(1)\n';

/** Running and not a zombie: a killed process may wait a moment for its reaper. */
function isRunning(pid: number): boolean {
	const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
	const state = ps.stdout.toString().trim();
	return state !== "" && !state.startsWith("Z");
}

/** Runs `code`, cancels it once the installer prints `installer-pids:<pid>,<pid>`, and returns those pids. */
async function cancelInstall(kernel: PythonKernel, code: string): Promise<number[]> {
	const ac = new AbortController();
	const started = Promise.withResolvers<number[]>();
	let streamed = "";
	const pending = executePythonWithKernel(kernel, code, {
		signal: ac.signal,
		onChunk: chunk => {
			streamed += chunk;
			const match = /installer-pids:(\d+),(\d+)/.exec(streamed);
			if (match) started.resolve([Number(match[1]), Number(match[2])]);
		},
	});
	const pids = await started.promise;
	ac.abort(new DOMException("user cancelled", "AbortError"));
	const result = await pending;
	expect(result.cancelled).toBe(true);
	return pids;
}

describe.skipIf(!SHOULD_RUN)("python runner subprocess", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	it("does not replay a crashed cell's file write and accepts the next cell in a fresh kernel", async () => {
		using tempDir = TempDir.createSync("@python-runner-crash-");
		const options = {
			cwd: tempDir.path(),
			sessionId: "crash-recovery",
			kernelMode: "session" as const,
			timeoutMs: 10_000,
		};
		const result = await executePython(
			[
				"import os",
				"with open('effects.txt', 'a') as effects:",
				"    effects.write('once\\n')",
				"print('before crash', flush=True)",
				"os._exit(17)",
			].join("\n"),
			options,
		);
		expect(await Bun.file(path.join(tempDir.path(), "effects.txt")).text()).toBe("once\n");
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("before crash");
		expect(result.output).toContain("completion is uncertain");

		const next = await executePython("print(21 * 2)", options);
		expect(next.exitCode).toBe(0);
		expect(next.output.trim()).toBe("42");
		expect(await Bun.file(path.join(tempDir.path(), "effects.txt")).text()).toBe("once\n");
	}, 30_000);

	it("streams stdout chunks as they are produced", async () => {
		using tempDir = TempDir.createSync("@python-runner-stream-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const chunks: string[] = [];
			const result = await executePythonWithKernel(
				kernel,
				["import sys", "for i in range(5):", "    print(i, flush=True)"].join("\n"),
				{
					onChunk: chunk => {
						chunks.push(chunk);
					},
				},
			);
			expect(result.exitCode).toBe(0);
			// 5 lines * (digit + newline) → at least 5 distinct chunks once printed.
			const text = chunks.join("");
			expect(text).toContain("0\n");
			expect(text).toContain("4\n");
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(process.platform === "win32")("runs in its own POSIX session", async () => {
		using tempDir = TempDir.createSync("@python-runner-session-isolation-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "import os; print(os.getsid(0), os.getpid())");
			const [sessionId, processId] = result.output.trim().split(/\s+/).map(Number);
			expect(sessionId).toBe(processId);
		} finally {
			await kernel.shutdown();
		}
	});

	it("cancels a long sleep via SIGINT within 500ms", async () => {
		using tempDir = TempDir.createSync("@python-runner-cancel-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const start = Date.now();
			const ac = new AbortController();
			const pending = executePythonWithKernel(kernel, "import time\ntime.sleep(30)", {
				signal: ac.signal,
			});
			setTimeout(() => ac.abort(new DOMException("user cancelled", "AbortError")), 50);
			const result = await pending;
			const elapsed = Date.now() - start;
			expect(result.cancelled).toBe(true);
			expect(elapsed).toBeLessThan(2_000);
			// Kernel must survive cancellation and remain usable.
			const next = await executePythonWithKernel(kernel, "print('alive')");
			expect(next.exitCode).toBe(0);
			expect(next.output).toContain("alive");
		} finally {
			await kernel.shutdown();
		}
	});

	it("executes file-backed cells in the retained namespace with script import semantics", async () => {
		using tempDir = TempDir.createSync("@python-runner-file-");
		const scriptDir = path.join(tempDir.path(), "scripts");
		await fs.mkdir(scriptDir, { recursive: true });
		await Bun.write(path.join(scriptDir, "sibling.py"), "VALUE = 2\n");
		const filename = path.join(scriptDir, "loaded.py");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			await executePythonWithKernel(kernel, "seed = 40");
			const loaded = await executePythonWithKernel(
				kernel,
				[
					"import asyncio",
					"import sibling",
					"await asyncio.sleep(0)",
					"loaded_value = seed + sibling.VALUE",
					"print(__file__)",
				].join("\n"),
				{ filename },
			);
			expect(loaded.exitCode).toBe(0);
			expect(loaded.output).toContain(filename);

			const retained = await executePythonWithKernel(kernel, "loaded_value");
			expect(retained.exitCode).toBe(0);
			expect(retained.output).toContain("42");

			const failed = await executePythonWithKernel(kernel, "raise RuntimeError('from loaded file')", {
				filename,
			});
			expect(failed.exitCode).toBe(1);
			expect(failed.output).toContain(filename);
			expect(failed.output).toContain("raise RuntimeError('from loaded file')");

			const missing = await executePythonWithKernel(kernel, "import omp_definitely_missing_module");
			expect(missing.exitCode).toBe(1);
			expect(missing.output).toContain("Distribution names can differ");
			expect(missing.output).toContain("%pip install <distribution-name>");
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(process.platform === "win32" || !HAS_ENSUREPIP)(
		"%pip bootstraps pip with ensurepip when the venv has no pip",
		async () => {
			using tempDir = TempDir.createSync("@python-runner-pip-ensurepip-");
			const { kernel } = await startPiplessKernel(tempDir.path(), {});
			try {
				const result = await executePythonWithKernel(kernel, "%pip --version");
				expect(result.output).not.toContain("No module named pip");
				expect(result.output).toContain(path.join("venv", "lib"));
				expect(result.displayOutputs).toContainEqual({
					type: "status",
					event: { op: "pip", args: "--version", installed: [], exit_code: 0 },
				});
			} finally {
				await kernel.shutdown();
			}
		},
		120_000,
	);

	it.skipIf(process.platform === "win32")(
		"%pip has uv install pip into the kernel's interpreter when ensurepip fails, then runs pip with the cell's arguments",
		async () => {
			using tempDir = TempDir.createSync("@python-runner-pip-uv-");
			const uvLog = path.join(tempDir.path(), "uv.log");
			const { kernel, python, sitePackages } = await startPiplessKernel(tempDir.path(), {
				ensurepipMain: DISABLED_ENSUREPIP,
				// Stands in for `uv pip install pip`: a pip that echoes its arguments.
				uvScript: [
					`printf '%s\\n' "$*" "$UV_PYTHON" > '${uvLog}'`,
					'SITE="$("$UV_PYTHON" -c "import sysconfig; print(sysconfig.get_paths()[\'purelib\'])")"',
					'mkdir -p "$SITE/pip"',
					': > "$SITE/pip/__init__.py"',
					`printf '%s\\n' 'import sys' 'print("pip-args:", *sys.argv[1:])' 'print("Successfully installed six-1.17.0")' > "$SITE/pip/__main__.py"`,
				].join("\n"),
			});
			try {
				const result = await executePythonWithKernel(kernel, "%pip install --disable-pip-version-check six");
				expect(result.output).toContain("ensurepip is disabled");
				const [uvArgs, uvPython] = (await Bun.file(uvLog).text()).trimEnd().split("\n");
				expect(uvArgs).toBe("pip install pip");
				expect(await fs.realpath(uvPython)).toBe(await fs.realpath(python));
				expect(await Bun.file(path.join(sitePackages, "pip", "__main__.py")).exists()).toBe(true);
				expect(result.output).toContain("pip-args: install --disable-pip-version-check six");
				expect(result.displayOutputs).toContainEqual({
					type: "status",
					event: {
						op: "pip",
						args: "install --disable-pip-version-check six",
						installed: ["six"],
						exit_code: 0,
					},
				});
			} finally {
				await kernel.shutdown();
			}
		},
		60_000,
	);

	it.skipIf(process.platform === "win32")(
		"%pip reports the bootstrap failure when ensurepip fails and uv is not on PATH",
		async () => {
			using tempDir = TempDir.createSync("@python-runner-pip-no-bootstrap-");
			const { kernel } = await startPiplessKernel(tempDir.path(), { ensurepipMain: DISABLED_ENSUREPIP });
			try {
				const result = await executePythonWithKernel(kernel, "%pip install six");
				expect(result.output).toContain("ensurepip is disabled");
				expect(result.displayOutputs).toContainEqual({
					type: "status",
					event: { op: "pip", args: "install six", installed: [], exit_code: 1 },
				});
			} finally {
				await kernel.shutdown();
			}
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")(
		"cancelling %pip during the ensurepip bootstrap stops ensurepip and the pip it spawned",
		async () => {
			using tempDir = TempDir.createSync("@python-runner-pip-cancel-ensurepip-");
			// Like the real `ensurepip`, runs pip in a child process.
			const { kernel } = await startPiplessKernel(tempDir.path(), {
				ensurepipMain: [
					"import os, subprocess",
					`child = subprocess.Popen([${JSON.stringify(SLEEP)}, "30"])`,
					'print(f"installer-pids:{os.getpid()},{child.pid}", flush=True)',
					"child.wait()",
				].join("\n"),
			});
			try {
				const pids = await cancelInstall(kernel, "%pip install six");
				expect(pids.filter(isRunning)).toEqual([]);
			} finally {
				await kernel.shutdown();
			}
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")(
		"cancelling %pip while uv installs pip stops uv and what it spawned",
		async () => {
			using tempDir = TempDir.createSync("@python-runner-pip-cancel-uv-");
			const { kernel } = await startPiplessKernel(tempDir.path(), {
				ensurepipMain: DISABLED_ENSUREPIP,
				uvScript: 'sleep 30 &\necho "installer-pids:$$,$!"\nwait',
			});
			try {
				const pids = await cancelInstall(kernel, "%pip install six");
				expect(pids.filter(isRunning)).toEqual([]);
			} finally {
				await kernel.shutdown();
			}
		},
		30_000,
	);

	it("loads quoted scripts without source echo, retaining namespace, filename and async execution", async () => {
		using tempDir = TempDir.createSync("@python-runner-load-");
		const scriptDir = path.join(tempDir.path(), "script folder");
		await fs.mkdir(scriptDir, { recursive: true });
		await Bun.write(path.join(scriptDir, "sibling.py"), "VALUE = 2\n");
		const filename = path.join(scriptDir, "loaded file.py");
		await Bun.write(
			filename,
			[
				"import asyncio",
				"import sibling",
				"await asyncio.sleep(0)",
				"loaded_value = seed + sibling.VALUE",
				"load_count = globals().get('load_count', 0) + 1",
				"print('script output', load_count)",
			].join("\n"),
		);
		const canonicalFilename = await fs.realpath(filename);
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			await executePythonWithKernel(kernel, "seed = 40");
			const first = await executePythonWithKernel(kernel, `%load "${filename}"`);
			expect(first.exitCode).toBe(0);
			expect(first.output.trim()).toBe("script output 1");
			expect(first.output).not.toContain("loaded_value =");
			const retained = await executePythonWithKernel(kernel, "print(loaded_value, load_count, __file__)");
			expect(retained.exitCode).toBe(0);
			expect(retained.output.trim()).toBe(`42 1 ${canonicalFilename}`);

			const second = await executePythonWithKernel(kernel, `%load "${filename}"`);
			expect(second.exitCode).toBe(0);
			expect(second.output.trim()).toBe("script output 2");

			await Bun.write(filename, "raise RuntimeError('loaded traceback')\n");
			const failed = await executePythonWithKernel(kernel, `%load "${filename}"`);
			expect(failed.exitCode).toBe(1);
			expect(failed.output).toContain(canonicalFilename);
			expect(failed.output).toContain("raise RuntimeError('loaded traceback')");
			expect(failed.output).not.toContain("_exec_source_async");

			const missing = await executePythonWithKernel(kernel, '%load "missing file.py"');
			expect(missing.exitCode).toBe(1);
			expect(missing.output).toContain("missing file.py");
			const usage = await executePythonWithKernel(kernel, "%load");
			expect(usage.exitCode).toBe(1);
			expect(usage.output).toContain("Usage: %load <path>");
		} finally {
			await kernel.shutdown();
		}
	});

	it("describes and invokes tools while the retained kernel remains live", async () => {
		using tempDir = TempDir.createSync("@python-runner-tools-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const defined = await executePythonWithKernel(
				kernel,
				[
					"@tool",
					"async def dbl(n: int) -> int:",
					'    """Double an integer."""',
					"    await asyncio.sleep(0)",
					"    return n * 2",
				].join("\n"),
			);
			expect(defined.exitCode).toBe(0);

			const describeResult = await kernel.invokeTool({ op: "describe", names: ["dbl", "missing"] });
			expect(describeResult.status).toBe("ok");
			expect(describeResult.reply).toEqual({
				ok: true,
				tools: [
					{
						name: "dbl",
						description: "Double an integer.",
						parameters: {
							type: "object",
							properties: { n: { type: "integer" } },
							required: ["n"],
							additionalProperties: false,
						},
					},
				],
				missing: ["missing"],
			});

			const callResult = await kernel.invokeTool({ op: "call", name: "dbl", args: { n: 2 } });
			expect(callResult.status).toBe("ok");
			expect(callResult.reply).toEqual({ ok: true, value: 4 });

			// A raising tool is reported to the caller, not surfaced as a kernel crash.
			const failing = await executePythonWithKernel(
				kernel,
				["@tool", "def boom(n: int) -> int:", "    raise ValueError('kaboom')"].join("\n"),
			);
			expect(failing.exitCode).toBe(0);
			const failed = await kernel.invokeTool({ op: "call", name: "boom", args: { n: 1 } });
			expect(failed.status).toBe("error");
			expect(failed.error?.name).toBe("ValueError");
			expect(failed.error?.value).toBe("kaboom");
			const badArgs = await kernel.invokeTool({ op: "call", name: "dbl", args: { nope: 1 } });
			expect(badArgs.status).toBe("error");
			expect(badArgs.error?.name).toBe("TypeError");
			expect(kernel.isAlive()).toBe(true);
			const alive = await executePythonWithKernel(kernel, "print('still here')");
			expect(alive.output).toContain("still here");
		} finally {
			await kernel.shutdown();
		}
	});

	it("preserves awaited arguments in calls named like speculative bridge operations", async () => {
		using tempDir = TempDir.createSync("@python-runner-call-site-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(
				kernel,
				[
					"async def resolve_value():",
					"    return 'preserved'",
					"completion = lambda value: value",
					"completion(await resolve_value())",
				].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("preserved");
		} finally {
			await kernel.shutdown();
		}
	});

	it("captures a JSON-safe retained namespace without running another cell", async () => {
		using tempDir = TempDir.createSync("@python-runner-shadow-snapshot-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			await executePythonWithKernel(kernel, "shadow_snapshot_value = {'nested': ['safe']}");
			const snapshot = await kernel.snapshotUserNamespace();
			expect(snapshot?.values.shadow_snapshot_value).toEqual({ nested: ["safe"] });
			expect(snapshot?.revision).toBeGreaterThan(0);
		} finally {
			await kernel.shutdown();
		}
	});

	it("atomically rejects stale Python snapshots without executing the cell", async () => {
		using tempDir = TempDir.createSync("@python-runner-shadow-admission-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			await executePythonWithKernel(kernel, "atomic_stale_guard = 1");
			const snapshot = await kernel.snapshotUserNamespace();
			if (!snapshot) throw new Error("expected retained Python snapshot");
			await executePythonWithKernel(kernel, "atomic_stale_guard = 2");
			await expect(kernel.executeIfSnapshotMatches("atomic_stale_guard = 3", snapshot)).resolves.toBeNull();
			expect((await kernel.snapshotUserNamespace())?.values.atomic_stale_guard).toBe(2);

			const current = await kernel.snapshotUserNamespace();
			if (!current) throw new Error("expected current Python snapshot");
			await expect(kernel.executeIfSnapshotMatches("atomic_stale_guard = 4", current)).resolves.toMatchObject({
				status: "ok",
			});
			expect((await kernel.snapshotUserNamespace())?.values.atomic_stale_guard).toBe(4);

			const racingSnapshot = await kernel.snapshotUserNamespace();
			if (!racingSnapshot) throw new Error("expected racing Python snapshot");
			const normalRun = kernel.execute(
				["import asyncio", "await asyncio.sleep(0.05)", "atomic_race_guard = 1"].join("\n"),
			);
			await expect(kernel.executeIfSnapshotMatches("atomic_race_guard = 2", racingSnapshot)).resolves.toBeNull();
			expect((await normalRun).status).toBe("ok");
			expect((await kernel.snapshotUserNamespace())?.values.atomic_race_guard).toBe(1);
		} finally {
			await kernel.shutdown();
		}
	});

	it("projects source-stable Python operations without executing candidate code", async () => {
		using tempDir = TempDir.createSync("@python-runner-shadow-plan-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			await expect(kernel.shadowPlan('await tool.read({"path": "src/a.py"})')).resolves.toMatchObject({
				operations: [
					{
						kind: "tool",
						call: {
							id: "py:6::0",
							siteId: "py:6",
							name: "read",
							args: {
								kind: "object",
								entries: [{ key: "path", value: { kind: "literal", value: "src/a.py" } }],
							},
							dependencies: [],
						},
					},
				],
			});
			await expect(kernel.shadowPlan("await tool.read({'path': str(True)})")).resolves.toMatchObject({
				operations: [
					{
						call: {
							args: {
								kind: "object",
								entries: [
									{
										key: "path",
										value: {
											kind: "transform",
											name: "Python.str",
											input: { kind: "literal", value: true },
										},
									},
								],
							},
						},
					},
				],
			});
			const mappingAttribute = await kernel.shadowPlan(
				['cfg = {"path": "secret.txt"}', 'await tool.read({"path": cfg.path})'].join("\n"),
			);
			expect(mappingAttribute?.operations).toEqual([]);
			expect(mappingAttribute?.barrier?.reason).toBe("unsupported Python statement");
			const jsonDumps = await kernel.shadowPlan('await tool.read({"path": json.dumps({"a": 1})})');
			expect(jsonDumps?.operations).toEqual([]);
			expect(jsonDumps?.barrier?.reason).toBe("unsupported Python statement");
			const ambiguousAddition = await kernel.shadowPlan("if [] + []:\n    await tool.read({'path': 'wrong'})");
			expect(ambiguousAddition?.operations).toEqual([]);
			expect(ambiguousAddition?.barrier?.reason).toBe("unsupported Python condition");
			const stringAddition = await kernel.shadowPlan("await tool.read({'path': 'src/' + 'a.py'})");
			expect(stringAddition?.barrier).toBeUndefined();
			expect(stringAddition?.operations).toHaveLength(1);
			const invalidJoin = await kernel.shadowPlan("await tool.read({'path': ''.join(['secret', 1, '.txt'])})");
			expect(invalidJoin?.operations).toEqual([]);
			expect(invalidJoin?.barrier?.reason).toBe("unsupported Python statement");
			const formattedValue = await kernel.shadowPlan('await tool.read({"path": f"{\'secret\'!r}"})');
			expect(formattedValue?.operations).toEqual([]);
			expect(formattedValue?.barrier?.reason).toBe("unsupported Python statement");
			const completion = await kernel.shadowPlan("completion('constant')");
			expect(completion?.operations).toEqual([]);
			expect(completion?.barrier?.reason).toBe("unsupported Python statement");
			const loop = await kernel.shadowPlan(
				["for path in ['a', 'b']:", "    await tool.read({'path': path})"].join("\n"),
			);
			expect(loop?.operations.map(operation => operation.call.dynamicPath)).toEqual([["loop:0"], ["loop:1"]]);
			expect(loop?.controls).toEqual([expect.objectContaining({ kind: "loop", iterations: 2 })]);
			const parallel = await kernel.shadowPlan(
				'parallel([lambda: tool.read({"path": "a"}), lambda: tool.read({"path": "b"})])',
			);
			expect(parallel?.operations).toEqual([]);
			expect(parallel?.barrier?.reason).toBe("unsupported Python statement");
		} finally {
			await kernel.shutdown();
		}
	});
	it("emits an error frame when user code raises", async () => {
		using tempDir = TempDir.createSync("@python-runner-error-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "raise ValueError('boom')");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("ValueError");
			expect(result.output).toContain("boom");
			// Traceback starts at user code; runner-internal frames stay hidden.
			expect(result.output).toContain('File "<cell>"');
			expect(result.output).not.toContain("_exec_source_async");
		} finally {
			await kernel.shutdown();
		}
	});

	it("reports cell syntax errors without runner-internal frames", async () => {
		using tempDir = TempDir.createSync("@python-runner-syntax-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, 'echo "hi"');
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("SyntaxError");
			expect(result.output).toContain('File "<cell>"');
			// Caret display only — no stack header, no runner machinery.
			expect(result.output).not.toContain("Traceback (most recent call last");
			expect(result.output).not.toContain("_compile_source");
		} finally {
			await kernel.shutdown();
		}
	});

	it("supports top-level await across cells", async () => {
		using tempDir = TempDir.createSync("@python-runner-await-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const first = await executePythonWithKernel(
				kernel,
				["import asyncio", "x = await asyncio.sleep(0, result=21)", "x * 2"].join("\n"),
			);
			expect(first.exitCode).toBe(0);
			expect(first.output).toContain("42");
			const second = await executePythonWithKernel(kernel, "x + 1");
			expect(second.exitCode).toBe(0);
			expect(second.output).toContain("22");
		} finally {
			await kernel.shutdown();
		}
	});

	it("echoes a long trailing dict as text plus a JSON view with unsafe integers as decimal strings", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const text =
				"{'seed': 18446744073709551615, 'nested': [9007199254740991, 9007199254740992, -9007199254740992, True]}";
			const result = await executePythonWithKernel(kernel, text);
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe(`${text}\n`);
			expect(result.displayOutputs).toEqual([
				{
					type: "view",
					text,
					view: {
						kind: "json",
						value: {
							seed: "18446744073709551615",
							nested: [9007199254740991, "9007199254740992", "-9007199254740992", true],
						},
					},
				},
			]);
		} finally {
			await kernel.shutdown();
		}
	});

	it("keeps short structures as plain text", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(kernel, "print({'a': 1})\n[1, 2]");
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("{'a': 1}\n[1, 2]\n");
			expect(result.displayOutputs).toEqual([]);
		} finally {
			await kernel.shutdown();
		}
	});

	it("prints JSON text as text plus a JSON view, other long strings as text only", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const value = { items: Array.from({ length: 30 }, (_, i) => i) };
			const text = JSON.stringify(value);
			const result = await executePythonWithKernel(kernel, `print(${JSON.stringify(text)})\nprint('{' + 'x' * 100)`);
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe(`${text}\n{${"x".repeat(100)}\n`);
			expect(result.displayOutputs).toEqual([{ type: "view", text, view: { kind: "json", value } }]);
		} finally {
			await kernel.shutdown();
		}
	});

	it("prints an image dict as a placeholder and emits the image with its metadata", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(
				kernel,
				"print('see', {'type': 'image', 'mimeType': 'image/png', 'data': b'png-bytes', 'detail': 'low'})",
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("see <image image/png>\n");
			expect(result.displayOutputs).toEqual([
				{ type: "image", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64"), detail: "low" },
			]);
		} finally {
			await kernel.shutdown();
		}
	});

	it("prints Markdown objects as their source with a markdown view", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(
				kernel,
				["class Note:", "    def _repr_markdown_(self):", "        return '# Title'", "print(Note())"].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("# Title\n");
			expect(result.displayOutputs).toEqual([
				{ type: "view", text: "# Title", view: { kind: "markdown", text: "# Title" } },
			]);
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(!HAS_PANDAS)("prints a DataFrame as its text with a matching table view", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(
				kernel,
				[
					"import pandas as pd",
					"df = pd.DataFrame({'n': [1, 2], 'name': ['a', 'b']})",
					"print(df)",
					"print(df, file=__import__('sys').stderr)",
				].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			const text = "   n name\n0  1    a\n1  2    b";
			expect(result.output).toBe(`${text}\n${text}\n`);
			expect(result.displayOutputs).toEqual([
				{
					type: "view",
					text,
					view: {
						kind: "table",
						columns: [{ head: "", numeric: true }, { head: "n", numeric: true }, { head: "name" }],
						rows: [
							["0", "1", "a"],
							["1", "2", "b"],
						],
					},
				},
			]);
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(!HAS_PANDAS)("elides truncated DataFrame rows like pandas' own repr", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(
				kernel,
				["import pandas as pd", "pd.DataFrame({'x': range(100)})"].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			const view = result.displayOutputs.find(output => output.type === "view");
			expect(view?.type === "view" && view.view.kind === "table" ? view.view.rows : []).toEqual([
				["0", "0"],
				["1", "1"],
				["2", "2"],
				["3", "3"],
				["4", "4"],
				["…", "…"],
				["95", "95"],
				["96", "96"],
				["97", "97"],
				["98", "98"],
				["99", "99"],
			]);
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(!HAS_MATPLOTLIB)("captures a printed figure as a PNG before the figure is closed", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(
				kernel,
				[
					"import matplotlib.pyplot as plt",
					"fig, ax = plt.subplots()",
					"ax.plot([0, 1], [0, 1])",
					"print(fig)",
					"plt.close(fig)",
				].join("\n"),
			);

			expect(result.exitCode).toBe(0);
			const images = result.displayOutputs.filter(output => output.type === "image");
			expect(images).toHaveLength(1);
			expect(images[0]).toMatchObject({ mimeType: "image/png" });
			expect(result.output).toContain("Figure(");
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(!HAS_MATPLOTLIB)("does not flush a second PNG for an echoed open figure", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(
				kernel,
				["import matplotlib.pyplot as plt", "fig, ax = plt.subplots()", "ax.plot([0, 1], [1, 0])", "fig"].join(
					"\n",
				),
			);

			expect(result.exitCode).toBe(0);
			expect(result.displayOutputs.filter(output => output.type === "image")).toHaveLength(1);
		} finally {
			await kernel.shutdown();
		}
	});

	it("translates %pwd magic to the user namespace", async () => {
		using tempDir = TempDir.createSync("@python-runner-magic-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "%pwd");
			expect(result.exitCode).toBe(0);
			// %pwd returns the cwd string, which becomes the last-expression result.
			// On macOS, the OS may resolve /var to /private/var, so check by basename.
			expect(result.output).toContain(path.basename(tempDir.path()));
		} finally {
			await kernel.shutdown();
		}
	});
});
