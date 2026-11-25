import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeAllVmContexts,
	executeInVmContext,
	setJsEvalWorkerFactoriesForTests,
} from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import {
	decodeStdioLine,
	encodeStdioFrame,
	MAX_STDIO_FRAME_BYTES,
	readStdioLines,
} from "@oh-my-pi/pi-coding-agent/eval/js/stdio-transport";
import {
	disposeAllKernelSessions,
	executePython,
	executePythonWithKernel,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { checkPythonKernelAvailability, PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { runEvalShell } from "@oh-my-pi/pi-coding-agent/eval/shell-bridge";
import { sessionSandboxWritableRoots } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { execCommand } from "@oh-my-pi/pi-coding-agent/exec/exec";
import { spawnManagedChild } from "@oh-my-pi/pi-coding-agent/daemon/children";
import { buildServerSpec } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { containedStdioArgv, StdioUpstream } from "@oh-my-pi/pi-coding-agent/mcp/host/stdio-upstream";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
	SandboxRuntime,
	type SandboxSpawnRequest,
	SandboxUnavailableError,
} from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { sandboxSupport } from "@oh-my-pi/pi-natives";
import { LineTooLongError, MIN_BUN_VERSION, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { CONTAINED_SOURCE_RUNS, SANDBOX_SUPPORTED, SANDBOX_UNAVAILABLE } from "../helpers/sandbox-test-state";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";

const backend = sandboxSupport();
const pythonAvailable = (await checkPythonKernelAvailability(os.tmpdir(), undefined, { forceProbe: true })).ok;
/** The CLI (and so the production JS selector and the bash sandbox host) refuses an older Bun. */
const cliRuns = Bun.semver.order(Bun.version, MIN_BUN_VERSION) >= 0;
/** What a sandbox filesystem denial looks like across backends and runtimes. */
const DENIAL = /Operation not permitted|Permission denied|Read-only file system|EPERM|EACCES|EROFS/;
/** Pooled bash session the eval `sh()` bridge uses for a tool session without an id. */
const EVAL_SHELL_SESSION_KEY = "eval:";
/** Tests that drive `/bin/sh` (a contained command or a `#!/bin/sh` shim); Windows has neither. */
const posixShell = process.platform !== "win32";

let state: SettingsTestState | undefined;
let settings: Settings;
let workspace: TempDir;
/** Outside both the workspace and tmpdir (which the sandbox leaves writable). */
let outside: string;

beforeEach(async () => {
	state = beginSettingsTest();
	workspace = await TempDir.create("@omp-sandbox-spawn-sites-");
	setProjectDir(workspace.path());
	settings = await Settings.init({ inMemory: true, cwd: workspace.path() });
	outside = fs.mkdtempSync(path.join(os.homedir(), ".omp-sandbox-spawn-sites-test-"));
	SandboxRuntime.resetForTest();
	cfgSandboxEnabled.set(settings, true);
	// Nothing here needs the network unless a test says so; `deny` keeps the egress proxy down.
	cfgSandboxNetworkMode.set(settings, "deny");
});

afterEach(async () => {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await (await SandboxRuntime.for(workspace.path())).dispose();
	SandboxRuntime.resetForTest();
	restoreSettingsTestState(state);
	state = undefined;
	fs.rmSync(outside, { recursive: true, force: true });
	await workspace.remove();
});

/** Enabled sandbox, no backend, `fallback: block`: anything that consults the sandbox fails. */
function blockWithoutBackend(): void {
	SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
	cfgSandboxFallback.set(settings, "block");
}

function toolSession(cwd: string, tools: AgentTool[] = []): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: (name: string) => tools.find(tool => tool.name === name),
	};
}

// ── exec ─────────────────────────────────────────────────────────────────────

describe.skipIf(!backend.supported || !posixShell)("contained execCommand", () => {
	it("cannot write outside the workspace but can inside it", async () => {
		const target = path.join(outside, "exec.txt");
		const blocked = await execCommand("/bin/sh", ["-c", `echo attempt; touch '${target}'`], workspace.path());
		expect(blocked.code).not.toBe(0);
		expect(blocked.killed).toBe(false);
		expect(blocked.stdout).toBe("attempt\n");
		expect(blocked.stderr).toMatch(DENIAL);
		expect(fs.existsSync(target)).toBe(false);

		const inside = path.join(workspace.path(), "exec.txt");
		const allowed = await execCommand("/bin/sh", ["-c", `touch '${inside}'`], workspace.path());
		expect(allowed).toEqual({ stdout: "", stderr: "", code: 0, killed: false });
		expect(fs.existsSync(inside)).toBe(true);
	});

	it("keeps the whole workspace writable from a subdirectory cwd", async () => {
		// A workspace outside tmpdir: tmpdir is writable anyway, which would hide a too-narrow root.
		const root = path.join(outside, "project");
		const sub = path.join(root, "sub");
		fs.mkdirSync(sub, { recursive: true });
		const sibling = path.join(root, "sibling.txt");
		try {
			const result = await execCommand("/bin/sh", ["-c", `touch '${sibling}'`], sub, undefined, root);
			expect(result.code).toBe(0);
			expect(fs.existsSync(sibling)).toBe(true);
		} finally {
			await (await SandboxRuntime.for(root)).dispose();
		}
	});

	it("does not make a cwd outside the workspace writable", async () => {
		const target = path.join(outside, "cwd.txt");
		const result = await execCommand("/bin/sh", ["-c", "touch cwd.txt"], outside, undefined, workspace.path());
		expect(result.code).not.toBe(0);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("returns the same exit code, stdout and stderr shape as the uncontained path", async () => {
		const script = "printf out; printf err >&2; exit 3";
		const contained = await execCommand("/bin/sh", ["-c", script], workspace.path());
		cfgSandboxEnabled.set(settings, false);
		const uncontained = await execCommand("/bin/sh", ["-c", script], workspace.path());
		expect(contained).toEqual(uncontained);
		expect(contained).toEqual({ stdout: "out", stderr: "err", code: 3, killed: false });
	});

	it("reports a timeout the same way as the uncontained path", async () => {
		const contained = await execCommand("/bin/sh", ["-c", "sleep 30"], workspace.path(), { timeout: 200 });
		cfgSandboxEnabled.set(settings, false);
		const uncontained = await execCommand("/bin/sh", ["-c", "sleep 30"], workspace.path(), { timeout: 200 });
		expect(contained).toEqual(uncontained);
		expect(contained).toMatchObject({ code: -1, killed: true });
	});

	it("kills the running contained process on abort", async () => {
		const marker = path.join(workspace.path(), "started");
		const started = Promise.withResolvers<void>();
		const watcher = fs.watch(workspace.path(), () => {
			if (fs.existsSync(marker)) started.resolve();
		});
		try {
			const controller = new AbortController();
			const run = execCommand("/bin/sh", ["-c", `touch '${marker}'; sleep 30`], workspace.path(), {
				signal: controller.signal,
			});
			await started.promise;
			controller.abort();
			expect(await run).toMatchObject({ code: -1, killed: true });
		} finally {
			watcher.close();
		}
	});
});

// ── Python ───────────────────────────────────────────────────────────────────

describe.skipIf(!pythonAvailable)("Python kernel sandbox policy", () => {
	it("does not reuse a retained uncontained kernel once the sandbox applies", async () => {
		const options = { cwd: workspace.path(), sessionId: `spawn-sites-py-${crypto.randomUUID()}` };
		cfgSandboxEnabled.set(settings, false);
		expect((await executePython("kept = 7", options)).exitCode).toBe(0);
		cfgSandboxEnabled.set(settings, true);
		blockWithoutBackend();
		await expect(executePython("print(kept)", options)).rejects.toThrow(SandboxUnavailableError);
	}, 60_000);
});

describe.skipIf(!backend.supported)("workspace Python interpreter under the sandbox", () => {
	it("never executes a workspace .venv interpreter on the host", async () => {
		// A contained command could plant this: it records every run by writing outside the
		// workspace, which only an uncontained (host) execution can do.
		const marker = path.join(outside, "interpreter-ran");
		const python = path.join(workspace.path(), ".venv", "bin", "python");
		fs.mkdirSync(path.dirname(python), { recursive: true });
		fs.writeFileSync(python, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
		fs.chmodSync(python, 0o755);

		await checkPythonKernelAvailability(workspace.path(), undefined, { forceProbe: true });
		await executePython("print(1)", {
			cwd: workspace.path(),
			sessionId: `spawn-sites-py-${crypto.randomUUID()}`,
		}).catch(() => undefined);
		expect(fs.existsSync(marker)).toBe(false);
	}, 60_000);
});

describe.skipIf(!pythonAvailable || !backend.supported)("contained Python kernel", () => {
	// The Windows container blocks loopback under `deny` and `allowlist`, and Python's asyncio
	// needs it (`socket.socketpair()`): the kernel only starts with network `allow` there.
	beforeEach(() => {
		if (process.platform === "win32") cfgSandboxNetworkMode.set(settings, "allow");
	});

	it("executes cells and raises on a write outside the workspace", async () => {
		const kernel = await PythonKernel.start({ cwd: workspace.path() });
		try {
			const ok = await executePythonWithKernel(kernel, "import os\nprint(1 + 1, os.environ.get('OMP_SANDBOX'))");
			expect(ok.exitCode).toBe(0);
			expect(ok.output).toContain("2 1");

			const target = path.join(outside, "py.txt");
			const blocked = await executePythonWithKernel(kernel, `open(${JSON.stringify(target)}, "w").write("x")`);
			expect(blocked.exitCode).not.toBe(0);
			expect(blocked.output).toMatch(DENIAL);
			expect(fs.existsSync(target)).toBe(false);

			const inside = path.join(workspace.path(), "py.txt");
			const allowed = await executePythonWithKernel(kernel, `open(${JSON.stringify(inside)}, "w").write("x")`);
			expect(allowed.exitCode).toBe(0);
			expect(fs.readFileSync(inside, "utf8")).toBe("x");
		} finally {
			await kernel.shutdown();
		}
	});

	// The interrupt frame makes the runner raise SIGINT in itself on every POSIX backend; the
	// contained launch sends no direct signal. Windows ignores frames mid-cell and restarts the kernel.
	it.skipIf(process.platform === "win32")("interrupts a running cell and keeps the kernel's state", async () => {
		const kernel = await PythonKernel.start({ cwd: workspace.path() });
		try {
			await executePythonWithKernel(kernel, "seed = 41");
			const controller = new AbortController();
			const result = await executePythonWithKernel(
				kernel,
				"import time\nprint('sleeping', flush=True)\ntime.sleep(30)",
				{
					signal: controller.signal,
					onChunk: chunk => {
						if (chunk.includes("sleeping")) controller.abort(new DOMException("user cancelled", "AbortError"));
					},
				},
			);
			expect(result.cancelled).toBe(true);
			expect(kernel.isAlive()).toBe(true);
			const next = await executePythonWithKernel(kernel, "print(seed + 1)");
			expect(next.output).toContain("42");
		} finally {
			await kernel.shutdown();
		}
	});

	it("retires a retained uncontained kernel once the sandbox applies", async () => {
		const options = { cwd: workspace.path(), sessionId: `spawn-sites-py-${crypto.randomUUID()}` };
		cfgSandboxEnabled.set(settings, false);
		expect((await executePython("kept = 7", options)).exitCode).toBe(0);
		cfgSandboxEnabled.set(settings, true);
		const result = await executePython(
			"import os\nprint(os.environ.get('OMP_SANDBOX'), 'kept' in globals())",
			options,
		);
		expect(result.output).toContain("1 False");
	}, 60_000);

	it.skipIf(process.platform === "win32")(
		"reaches the tool bridge from a contained kernel under the allowlist",
		async () => {
			cfgSandboxNetworkMode.set(settings, "allowlist");
			const echo: AgentTool = {
				name: "echo",
				label: "Echo",
				description: "Echoes its text",
				parameters: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
				execute: async (_id, args) => ({
					content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }],
					details: {},
				}),
			};
			const result = await executePython('print(await tool.echo(text="bridged"))', {
				cwd: workspace.path(),
				sessionId: `spawn-sites-py-${crypto.randomUUID()}`,
				toolSession: toolSession(workspace.path(), [echo]),
			});
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('echo:{"text":"bridged"}');
		},
		60_000,
	);
});

// ── JS ───────────────────────────────────────────────────────────────────────

/** Run `code` in the session's retained JS context; resolves with its printed output. */
async function runJs(
	code: string,
	options: { session?: ToolSession; localRoots?: Record<string, string> } = {},
): Promise<string> {
	const sessionKey = `spawn-sites:${workspace.path()}`;
	let output = "";
	await executeInVmContext({
		sessionKey,
		sessionId: sessionKey,
		cwd: workspace.path(),
		session: options.session ?? toolSession(workspace.path()),
		localRoots: options.localRoots,
		code,
		filename: "spawn-sites.js",
		timeoutMs: 60_000,
		runState: { onText: chunk => (output += chunk) },
	});
	return output;
}

async function expectContainedJsEval(): Promise<void> {
	const values = await runJs("console.log(JSON.stringify({ sum: 1 + 1, sandbox: process.env.OMP_SANDBOX }))");
	expect(JSON.parse(values)).toEqual({ sum: 2, sandbox: "1" });

	const target = path.join(outside, "js.txt");
	await expect(
		runJs(`const fs = await import("node:fs");\nfs.writeFileSync(${JSON.stringify(target)}, "x");`),
	).rejects.toThrow(DENIAL);
	expect(fs.existsSync(target)).toBe(false);

	const inside = path.join(workspace.path(), "js.txt");
	await runJs(`const fs = await import("node:fs");\nfs.writeFileSync(${JSON.stringify(inside)}, "x");`);
	expect(fs.readFileSync(inside, "utf8")).toBe("x");
}

const SRC = path.resolve(import.meta.dir, "../../src");
/**
 * What the `__omp_worker_js_eval_stdio` CLI selector runs, as a standalone entry: the CLI refuses
 * to start under a Bun older than the repo's minimum, which a test runner may be.
 */
const JS_EVAL_STDIO_ENTRY = `
import { interceptUnhandledRejections } from ${JSON.stringify(Bun.resolveSync("@oh-my-pi/pi-utils/postmortem", import.meta.dir))};
import { startJsEvalProcess } from ${JSON.stringify(path.join(SRC, "eval/js/process-entry.ts"))};
import { runStdioSubprocessWorker } from ${JSON.stringify(path.join(SRC, "eval/js/stdio-transport.ts"))};
await runStdioSubprocessWorker(transport => startJsEvalProcess(transport, interceptUnhandledRejections));
`;

describe.skipIf(!backend.supported || !CONTAINED_SOURCE_RUNS)("contained JS eval (stdio transport entry)", () => {
	let containedArgv: string[];
	let restoreEntry: (() => void) | undefined;
	beforeEach(async () => {
		const entry = path.join(workspace.path(), "js-eval-stdio-entry.ts");
		await Bun.write(entry, JS_EVAL_STDIO_ENTRY);
		containedArgv = [process.execPath, entry];
		restoreEntry = setJsEvalWorkerFactoriesForTests({ containedArgv });
	});
	afterEach(() => restoreEntry?.());

	it("prints values from a contained subprocess and cannot write outside the workspace", async () => {
		await expectContainedJsEval();
	}, 120_000);

	it("retires a retained uncontained context once the sandbox applies", async () => {
		cfgSandboxEnabled.set(settings, false);
		expect(await runJs("globalThis.kept = 7; console.log(process.env.OMP_SANDBOX ?? 'none')")).toBe("none\n");
		cfgSandboxEnabled.set(settings, true);
		const output = await runJs("console.log(process.env.OMP_SANDBOX, typeof globalThis.kept)");
		expect(output).toContain("1 undefined");
	}, 120_000);

	it("does not hand a worker that began uncontained to a cell arriving once the sandbox applies", async () => {
		cfgSandboxEnabled.set(settings, false);
		const started = Promise.withResolvers<void>();
		// A failed subprocess start falls back to the (uncontained) Bun Worker; the throw marks the
		// moment that start is underway.
		const restoreFactories = setJsEvalWorkerFactoriesForTests({
			containedArgv,
			spawnProcess: () => {
				started.resolve();
				throw new Error("test: start the Worker instead");
			},
		});
		try {
			// Its cell may fail when the restart retires its worker; only the second cell matters.
			const first = runJs("console.log(process.env.OMP_SANDBOX ?? 'none')").catch(() => undefined);
			await started.promise;
			cfgSandboxEnabled.set(settings, true);
			const second = await runJs("console.log(process.env.OMP_SANDBOX ?? 'none')");
			expect(second).toContain("1\n");
			expect(second).not.toContain("none");
			await first;
		} finally {
			restoreFactories();
		}
	}, 120_000);

	it("keeps serving cells after a cell's child read the inherited stdin", async () => {
		const reader = "const text = await Bun.stdin.text(); console.log(`read ${text.length} bytes`);";
		// Before the fix the child hangs on a stdin that never ends, until the cell's 60 s timeout.
		const first = await runJs(
			[
				`const child = Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(reader)}], { stdin: "inherit" });`,
				"console.log(child.stdout.toString().trim());",
			].join("\n"),
		);
		expect(first.trim()).toBe("read 0 bytes");
		expect(await runJs('console.log("still serving")')).toBe("still serving\n");
	}, 120_000);

	it("writes the session's local:// root, but not beside it", async () => {
		const artifacts = path.join(outside, "artifacts");
		const local = path.join(artifacts, "local");
		const session = { ...toolSession(workspace.path()), getArtifactsDir: () => artifacts };
		await runJs('await write("local://note.txt", "kept")', { session, localRoots: { local } });
		expect(fs.readFileSync(path.join(local, "note.txt"), "utf8")).toBe("kept");

		const beside = path.join(artifacts, "other.txt");
		await expect(
			runJs(`const fs = await import("node:fs");\nfs.writeFileSync(${JSON.stringify(beside)}, "x");`, {
				session,
				localRoots: { local },
			}),
		).rejects.toThrow(DENIAL);
		expect(fs.existsSync(beside)).toBe(false);
	}, 120_000);
});

describe.skipIf(!backend.supported)("contained JS eval startup failure", () => {
	it("fails the cell instead of falling back to an uncontained Worker", async () => {
		let workerSpawns = 0;
		const restoreFactories = setJsEvalWorkerFactoriesForTests({
			containedArgv: [process.execPath, "-e", "process.exit(0)"],
			spawnWorker: () => {
				workerSpawns++;
				throw new Error("test: the uncontained Worker must not start");
			},
		});
		try {
			await expect(runJs("console.log('ran')")).rejects.toThrow("Failed to initialize isolated JS eval worker");
			expect(workerSpawns).toBe(0);
		} finally {
			restoreFactories();
		}
	}, 60_000);
});

describe("contained JS eval environment", () => {
	const HOST_PROXY = { no_proxy: "*", ALL_PROXY: "http://corp.example:3128" };
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		saved = Object.fromEntries(Object.keys(HOST_PROXY).map(key => [key, Bun.env[key]]));
		for (const [key, value] of Object.entries(HOST_PROXY)) restoreEnvValue(key, value);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const [key, value] of Object.entries(saved)) restoreEnvValue(key, value);
	});

	/** The evaluator's contained spawn request under network `mode`; the spawn itself is refused. */
	async function evaluatorRequest(mode: "allowlist" | "deny"): Promise<SandboxSpawnRequest> {
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		cfgSandboxNetworkMode.set(settings, mode);
		const requests: SandboxSpawnRequest[] = [];
		vi.spyOn(SandboxRuntime.prototype, "spawn").mockImplementation(async request => {
			requests.push(request);
			throw new Error("test: spawn captured");
		});
		await expect(runJs("console.log('ran')")).rejects.toThrow();
		expect(requests).toHaveLength(1);
		return requests[0];
	}

	it("drops the host's proxy variables in allowlist mode and points TMPDIR at the sandbox's temp dir", async () => {
		const request = await evaluatorRequest("allowlist");
		expect(request.env.no_proxy).toBeUndefined();
		expect(request.env.ALL_PROXY).toBeUndefined();
		expect(request.env.TMPDIR).toBe((await SandboxRuntime.for(workspace.path())).tempDir());
	});

	it("passes the host's proxy variables through when the network mode is not allowlist", async () => {
		const request = await evaluatorRequest("deny");
		expect(request.env.no_proxy).toBe(HOST_PROXY.no_proxy);
		expect(request.env.ALL_PROXY).toBe(HOST_PROXY.ALL_PROXY);
	});
});

describe.skipIf(!backend.supported || !cliRuns || !CONTAINED_SOURCE_RUNS)("contained JS eval (CLI selector)", () => {
	// `sh()` runs in the pooled bash session the bridge keys `eval:<session id>` (the test session
	// has no id); release it so its sandbox host does not outlive the test.
	afterEach(() => releaseShellSessions(EVAL_SHELL_SESSION_KEY));

	it("cannot escape through the sh() bridge", async () => {
		const inside = path.join(workspace.path(), "sh.txt");
		await runJs(`await sh(${JSON.stringify(`touch '${inside}'`)})`);
		expect(fs.existsSync(inside)).toBe(true);

		const target = path.join(outside, "sh.txt");
		await expect(runJs(`await sh(${JSON.stringify(`touch '${target}'`)})`)).rejects.toThrow();
		expect(fs.existsSync(target)).toBe(false);
	}, 120_000);
});

describe("eval sh() bridge sandbox", () => {
	afterEach(() => releaseShellSessions(EVAL_SHELL_SESSION_KEY));

	it("routes the shell through the sandbox (fails closed when it is required but unavailable)", async () => {
		blockWithoutBackend();
		await expect(runEvalShell({ command: "true" }, { session: toolSession(workspace.path()) })).rejects.toThrow(
			SandboxUnavailableError,
		);
	});
});

describe.skipIf(!backend.supported || !posixShell || !cliRuns || !CONTAINED_SOURCE_RUNS)(
	"eval sh() bridge under a read-only sandbox",
	() => {
		afterEach(() => releaseShellSessions(EVAL_SHELL_SESSION_KEY));

		it("writes the session's local:// root, but not the workspace", async () => {
			cfgSandboxMode.set(settings, "read-only");
			const session = { ...toolSession(workspace.path()), getArtifactsDir: () => path.join(outside, "artifacts") };
			const [local] = sessionSandboxWritableRoots(session);
			const note = path.join(local, "note.txt");
			await runEvalShell({ command: `echo kept > '${note}'` }, { session });
			expect(fs.readFileSync(note, "utf8")).toBe("kept\n");

			const inside = path.join(workspace.path(), "sh.txt");
			await runEvalShell({ command: `touch '${inside}'` }, { session }).catch(() => undefined);
			expect(fs.existsSync(inside)).toBe(false);
		}, 120_000);
	},
);

describe("stdio frames", () => {
	const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
	function decodeLine(line: string): { frames: unknown[]; noise: string[] } {
		const frames: unknown[] = [];
		const noise: string[] = [];
		decodeStdioLine(
			bytes(line),
			frame => frames.push(frame),
			text => noise.push(text),
		);
		return { frames, noise };
	}

	/** A stream of `count` copies of `chunk`, then `tail`. */
	function chunked(chunk: Uint8Array, count: number, tail: Uint8Array): ReadableStream<Uint8Array> {
		let sent = 0;
		return new ReadableStream({
			pull(controller) {
				if (sent < count) {
					sent++;
					controller.enqueue(chunk);
					return;
				}
				controller.enqueue(tail);
				controller.close();
			},
		});
	}
	const MIB = 1024 * 1024;

	it("passes text glued in front of a frame to the noise sink", () => {
		const { frames, noise } = decodeLine(`stray${encodeStdioFrame({ c: 3 }).trimEnd()}`);
		expect(frames).toEqual([{ c: 3 }]);
		expect(noise).toEqual(["stray"]);
	});

	it("throws on a malformed frame", () => {
		expect(() => decodeLine("\x1eomp-js-eval:!!!not-a-frame!!!")).toThrow();
	});

	it("errors once a line outgrows the frame cap without a newline", async () => {
		const chunks = MAX_STDIO_FRAME_BYTES / MIB + 1;
		await expect(Array.fromAsync(readStdioLines(chunked(new Uint8Array(MIB), chunks, bytes("\n"))))).rejects.toThrow(
			LineTooLongError,
		);
	});
});

// ── MCP ──────────────────────────────────────────────────────────────────────

/**
 * Minimal MCP stdio server: answers `initialize` with whether it could write `MCP_TARGET` and,
 * when `MCP_LOOPBACK_PORT` is set, whether it could connect to that host-loopback port.
 */
const MCP_SERVER = `
const fs = require("node:fs");
const net = require("node:net");
function loopback() {
	const port = Number(process.env.MCP_LOOPBACK_PORT);
	if (!port) return Promise.resolve(null);
	const { promise, resolve } = Promise.withResolvers();
	const socket = net.connect(port, "127.0.0.1");
	socket.on("connect", () => { socket.destroy(); resolve("connected"); });
	socket.on("error", error => resolve(error.code ?? "error"));
	return promise;
}
let buffer = "";
process.stdin.on("data", async chunk => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf("\\n")) !== -1) {
		const message = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		if (message.method !== "initialize") continue;
		let write = "ok";
		try {
			fs.writeFileSync(process.env.MCP_TARGET, "x");
		} catch (error) {
			write = error.code;
		}
		const result = {
			protocolVersion: message.params.protocolVersion,
			capabilities: {},
			serverInfo: { name: "spawn-sites", version: "1.0.0" },
			instructions: JSON.stringify({ write, sandbox: process.env.OMP_SANDBOX ?? null, loopback: await loopback() }),
		};
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
	}
});
`;

interface ServerReport {
	write: string;
	sandbox: string | null;
	loopback: string | null;
}

/** Start `config`'s server as the MCP host does: the opt-in contains it while the sandbox is active. */
async function connectStdioServer(config: MCPStdioServerConfig): Promise<StdioUpstream> {
	const spec = buildServerSpec(config);
	if (spec.transport !== "stdio") throw new Error("expected a stdio server");
	const upstream = new StdioUpstream(spec);
	await upstream.connect(spawnManagedChild);
	return upstream;
}

async function initializeServer(
	sandboxOptions: Pick<MCPStdioServerConfig, "sandbox" | "sandboxNetwork">,
	env: Record<string, string>,
): Promise<ServerReport> {
	const script = path.join(workspace.path(), "mcp-server.cjs");
	await Bun.write(script, MCP_SERVER);
	const transport = await connectStdioServer({
		command: process.execPath,
		args: [script],
		cwd: workspace.path(),
		env,
		...sandboxOptions,
	});
	try {
		const result = await transport.request<{ instructions: string }>("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "spawn-sites-test", version: "1.0.0" },
		});
		return JSON.parse(result.instructions);
	} finally {
		await transport.close();
	}
}

describe("MCP stdio server sandbox opt-in", () => {
	it("spawns normally with sandbox: true while the sandbox is disabled", async () => {
		cfgSandboxEnabled.set(settings, false);
		const target = path.join(outside, "mcp.txt");
		expect(await initializeServer({ sandbox: true }, { MCP_TARGET: target })).toMatchObject({
			write: "ok",
			sandbox: null,
		});
		expect(fs.existsSync(target)).toBe(true);
	}, 60_000);

	it("fails the connect when the sandbox is required but unavailable", async () => {
		blockWithoutBackend();
		const target = path.join(outside, "mcp.txt");
		await expect(initializeServer({ sandbox: true }, { MCP_TARGET: target })).rejects.toThrow("Sandbox unavailable");
		expect(fs.existsSync(target)).toBe(false);
	}, 60_000);

	it("connects uncontained under fallback: warn when no backend is available", async () => {
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
		const warnings: string[] = [];
		SandboxRuntime.setWarningSink(message => warnings.push(message));
		try {
			const target = path.join(outside, "mcp.txt");
			expect(await initializeServer({ sandbox: true }, { MCP_TARGET: target })).toMatchObject({
				write: "ok",
				sandbox: null,
			});
			expect(warnings).toHaveLength(1);
		} finally {
			SandboxRuntime.setWarningSink(undefined);
		}
	}, 60_000);

	it("never consults the sandbox for a server without the opt-in", async () => {
		blockWithoutBackend();
		const target = path.join(outside, "mcp.txt");
		expect(await initializeServer({}, { MCP_TARGET: target })).toMatchObject({ write: "ok", sandbox: null });
	}, 60_000);

	it("refuses to contain a Windows batch shim instead of corrupting its command line", () => {
		expect(() => containedStdioArgv(["C:\\npm\\npx.cmd", "-y", "server"], "npx")).toThrow(
			'Point "command" at node or bun',
		);
		expect(containedStdioArgv(["node", "server.js"], "node")).toEqual(["node", "server.js"]);
	});
});

describe.skipIf(!backend.supported)("contained MCP stdio server", () => {
	let loopbackPort = 0;
	let stopListener = (): void => {};
	beforeEach(() => {
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data() {},
				open(socket) {
					socket.end();
				},
			},
		});
		loopbackPort = listener.port;
		stopListener = () => listener.stop(true);
	});
	afterEach(() => stopListener());

	it("completes initialize with sandbox: true and cannot write outside the workspace", async () => {
		const target = path.join(outside, "mcp.txt");
		const report = await initializeServer({ sandbox: true }, { MCP_TARGET: target });
		expect(report.sandbox).toBe("1");
		expect(report.write).toMatch(DENIAL);
		expect(fs.existsSync(target)).toBe(false);
	}, 60_000);

	// bubblewrap never reaches host loopback, whatever the network mode.
	it.skipIf(backend.backend === "bubblewrap")(
		"reaches host loopback with the default allow network",
		async () => {
			const report = await initializeServer(
				{ sandbox: true },
				{ MCP_TARGET: path.join(workspace.path(), "mcp.txt"), MCP_LOOPBACK_PORT: String(loopbackPort) },
			);
			expect(report).toMatchObject({ sandbox: "1", loopback: "connected" });
		},
		60_000,
	);

	it("cannot reach host loopback with sandboxNetwork: deny", async () => {
		const report = await initializeServer(
			{ sandbox: true, sandboxNetwork: "deny" },
			{ MCP_TARGET: path.join(workspace.path(), "mcp.txt"), MCP_LOOPBACK_PORT: String(loopbackPort) },
		);
		expect(report.sandbox).toBe("1");
		expect(report.loopback).not.toBe("connected");
	}, 60_000);

	it.skipIf(!posixShell)(
		"reports a missing command by name, and finds it once installed",
		async () => {
			const bin = path.join(workspace.path(), "bin");
			fs.mkdirSync(bin);
			const script = path.join(workspace.path(), "mcp-server.cjs");
			await Bun.write(script, MCP_SERVER);
			const config: MCPStdioServerConfig = {
				command: "omp-spawn-sites-mcp",
				cwd: workspace.path(),
				env: { PATH: bin, MCP_TARGET: path.join(workspace.path(), "mcp.txt") },
				sandbox: true,
			};
			await expect(connectStdioServer(config)).rejects.toThrow("omp-spawn-sites-mcp");
			// A lookup miss must not be cached: installing the command makes the next connect succeed.
			const shim = path.join(bin, "omp-spawn-sites-mcp");
			await Bun.write(shim, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`);
			fs.chmodSync(shim, 0o755);
			const transport = await connectStdioServer(config);
			try {
				const result = await transport.request<{ instructions: string }>("initialize", {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "spawn-sites-test", version: "1.0.0" },
				});
				expect(JSON.parse(result.instructions)).toMatchObject({ sandbox: "1" });
			} finally {
				await transport.close();
			}
		},
		60_000,
	);
});
