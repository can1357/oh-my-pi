import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeAllVmContexts,
	executeInVmContext,
	setJsEvalContainedEntryForTests,
	setJsEvalWorkerFactoriesForTests,
} from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { encodeStdioFrame, StdioFrameDecoder } from "@oh-my-pi/pi-coding-agent/eval/js/stdio-transport";
import {
	disposeAllKernelSessions,
	executePython,
	executePythonWithKernel,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { checkPythonKernelAvailability, PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { runEvalShell } from "@oh-my-pi/pi-coding-agent/eval/shell-bridge";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { execCommand } from "@oh-my-pi/pi-coding-agent/exec/exec";
import { containedStdioArgv, createStdioTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { SandboxRuntime, SandboxUnavailableError } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxNetworkMode,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { sandboxSupport } from "@oh-my-pi/pi-natives";
import { MIN_BUN_VERSION, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const backend = sandboxSupport();
const pythonAvailable = (await checkPythonKernelAvailability(os.tmpdir(), undefined, { forceProbe: true })).ok;
/** The CLI (and so the production JS selector and the bash sandbox host) refuses an older Bun. */
const cliRuns = Bun.semver.order(Bun.version, MIN_BUN_VERSION) >= 0;
const UNAVAILABLE = { supported: false, reason: "test: no backend", proxy: false, warnings: [] };
/** What a sandbox filesystem denial looks like across backends and runtimes. */
const DENIAL = /Operation not permitted|Permission denied|Read-only file system|EPERM|EACCES|EROFS/;
/** Pooled bash session the eval `sh()` bridge uses for a tool session without an id. */
const EVAL_SHELL_SESSION_KEY = "eval:";

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
	SandboxRuntime.resetForTest(UNAVAILABLE);
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

describe("execCommand sandbox workspace", () => {
	it("confines to the session workspace, not the per-call cwd", async () => {
		const sub = path.join(workspace.path(), "sub");
		fs.mkdirSync(sub);
		const spy = vi.spyOn(SandboxRuntime, "for");
		cfgSandboxEnabled.set(settings, false);
		await execCommand("/bin/sh", ["-c", "true"], sub, undefined, workspace.path());
		expect(spy.mock.calls.map(([dir]) => dir)).toEqual([workspace.path()]);
	});
});

describe.skipIf(!backend.supported)("contained execCommand", () => {
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

	it("runs contained (OMP_SANDBOX is set inside)", async () => {
		const result = await execCommand("/bin/sh", ["-c", 'printf %s "$OMP_SANDBOX"'], workspace.path());
		expect(result.stdout).toBe("1");
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

	// Seatbelt reports the runner's own pid, so the interrupt is a real SIGINT; other backends
	// degrade to the kernel restart after the interrupt grace window.
	it.skipIf(backend.backend !== "seatbelt")("interrupts a running cell and keeps the kernel's state", async () => {
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

	it("reaches the tool bridge from a contained kernel under the allowlist", async () => {
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
	}, 60_000);
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

describe.skipIf(!backend.supported)("contained JS eval (stdio transport entry)", () => {
	let restoreEntry: (() => void) | undefined;
	beforeEach(async () => {
		const entry = path.join(workspace.path(), "js-eval-stdio-entry.ts");
		await Bun.write(entry, JS_EVAL_STDIO_ENTRY);
		restoreEntry = setJsEvalContainedEntryForTests([process.execPath, entry]);
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
		const restoreEntry = setJsEvalContainedEntryForTests([process.execPath, "-e", "process.exit(0)"]);
		let workerSpawns = 0;
		const restoreFactories = setJsEvalWorkerFactoriesForTests({
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
			restoreEntry();
		}
	}, 60_000);
});

describe.skipIf(!backend.supported || !cliRuns)("contained JS eval (CLI selector)", () => {
	// `sh()` runs in the pooled bash session the bridge keys `eval:<session id>` (the test session
	// has no id); release it so its sandbox host does not outlive the test.
	afterEach(() => releaseShellSessions(EVAL_SHELL_SESSION_KEY));

	it("prints values from a contained subprocess and cannot write outside the workspace", async () => {
		await expectContainedJsEval();
	}, 120_000);

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

describe("StdioFrameDecoder", () => {
	function decode(chunks: Uint8Array[]): { frames: unknown[]; noise: string[] } {
		const frames: unknown[] = [];
		const noise: string[] = [];
		const decoder = new StdioFrameDecoder(
			frame => frames.push(frame),
			text => noise.push(text),
		);
		for (const chunk of chunks) decoder.push(chunk);
		return { frames, noise };
	}
	const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

	it("reassembles a frame split across chunks", () => {
		const frame = bytes(encodeStdioFrame({ type: "text", big: "x".repeat(10_000), n: 2n }));
		const { frames } = decode([frame.subarray(0, 7), frame.subarray(7, 5000), frame.subarray(5000)]);
		expect(frames).toEqual([{ type: "text", big: "x".repeat(10_000), n: 2n }]);
	});

	it("decodes two frames from one chunk", () => {
		const { frames } = decode([bytes(encodeStdioFrame({ a: 1 }) + encodeStdioFrame({ b: 2 }))]);
		expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("skips stray output, including text glued in front of a frame", () => {
		const { frames, noise } = decode([bytes(`hello\nstray${encodeStdioFrame({ c: 3 })}`)]);
		expect(frames).toEqual([{ c: 3 }]);
		expect(noise).toEqual(["hello", "stray"]);
	});

	it("throws on a malformed frame", () => {
		expect(() => decode([bytes("\x1eomp-js-eval:!!!not-a-frame!!!\n")])).toThrow();
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

async function initializeServer(
	sandboxOptions: Pick<MCPStdioServerConfig, "sandbox" | "sandboxNetwork">,
	env: Record<string, string>,
): Promise<ServerReport> {
	const script = path.join(workspace.path(), "mcp-server.cjs");
	await Bun.write(script, MCP_SERVER);
	const transport = await createStdioTransport({
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
	it("spawns uncontained without the opt-in", async () => {
		const target = path.join(outside, "mcp.txt");
		expect(await initializeServer({}, { MCP_TARGET: target })).toEqual({
			write: "ok",
			sandbox: null,
			loopback: null,
		});
		expect(fs.existsSync(target)).toBe(true);
	}, 60_000);

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
		SandboxRuntime.resetForTest(UNAVAILABLE);
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
		expect(() =>
			containedStdioArgv(
				{
					cmd: ["cmd.exe", "/d", "/e:ON", "/v:OFF", "/c", '"npx.cmd -y server"'],
					detached: false,
					windowsVerbatimArguments: true,
				},
				"npx",
			),
		).toThrow('Point "command" at node or bun');
		expect(containedStdioArgv({ cmd: ["node", "server.js"], detached: false }, "node")).toEqual([
			"node",
			"server.js",
		]);
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

	it("reports a missing command by name, and finds it once installed", async () => {
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
		await expect(createStdioTransport(config)).rejects.toThrow("omp-spawn-sites-mcp");
		// A lookup miss must not be cached: installing the command makes the next connect succeed.
		const shim = path.join(bin, "omp-spawn-sites-mcp");
		await Bun.write(shim, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`);
		fs.chmodSync(shim, 0o755);
		const transport = await createStdioTransport(config);
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
	}, 60_000);
});
