/**
 * Binary Ninja's interpreter probe under the OS sandbox: while the sandbox is active the probe runs
 * inside it (never a workspace-controlled interpreter on the host), `fallback: block` refuses it
 * without a backend, a licence refusal is still told from other failures, and the contained worker
 * can read the install and user folder. The container is a stub (`SandboxRuntime.prototype.spawn`
 * is spied), so no backend is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { binjaPythonDir } from "@oh-my-pi/pi-coding-agent/binja/install";
import { BINJA_PROBE, buildBinjaEnv, resolveBinjaRuntime } from "@oh-my-pi/pi-coding-agent/binja/runtime";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DISASM_BACKENDS } from "@oh-my-pi/pi-coding-agent/disasm/backend";
import { containedWorkerSpawnRequest } from "@oh-my-pi/pi-coding-agent/disasm/contained";
import { SandboxRuntime, SandboxUnavailableError } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxFallback } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import type { SandboxChild } from "@oh-my-pi/pi-coding-agent/sandbox/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	beginContainedSandboxTest,
	type ContainedSandboxTest,
	endContainedSandboxTest,
	failure,
	SANDBOX_SUPPORTED,
	SANDBOX_UNAVAILABLE,
} from "../helpers/sandbox-test-state";
import { restoreEnvValue } from "../helpers/settings-test-state";

const posix = process.platform !== "win32";

let contained: ContainedSandboxTest;
let workspace: string;
let install: string;
let userDir: string;
/** Written by the workspace interpreter whenever it runs on the host. */
let marker: string;
let python: string;
let previousUserDir: string | undefined;

/** A probe child: `stdout` and `stderr` default to closed, empty streams. */
function fakeChild(
	exitCode: number,
	stderr: string | ReadableStream<Uint8Array> = "",
	stdout: ReadableStream<Uint8Array> = textStream(""),
): SandboxChild {
	return {
		pid: 1,
		stdin: { write: () => undefined, flush: () => undefined, end: () => undefined },
		stdout,
		stderr: typeof stderr === "string" ? textStream(stderr) : stderr,
		exited: Promise.resolve(exitCode),
		exitCode,
		kill: () => undefined,
	};
}

/** A stream of `text` that closes after it, or stays open forever with `open`. */
function textStream(text: string, open = false): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (text) controller.enqueue(new TextEncoder().encode(text));
			if (!open) controller.close();
		},
	});
}

function session(): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "binja.installDir": install, "binja.python": python }),
	};
}

beforeEach(async () => {
	contained = await beginContainedSandboxTest("contained-binja");
	workspace = contained.workspace;
	install = path.join(workspace, "install");
	userDir = path.join(path.dirname(workspace), "bn-user");
	fs.mkdirSync(userDir);
	marker = path.join(workspace, "host-ran");
	for (const lib of ["libbinaryninjacore.so.1", "libbinaryninjacore.dylib"]) {
		fs.mkdirSync(install, { recursive: true });
		fs.writeFileSync(path.join(install, lib), "");
	}
	fs.mkdirSync(binjaPythonDir(install), { recursive: true });
	python = path.join(workspace, ".venv", "bin", "python");
	fs.mkdirSync(path.dirname(python), { recursive: true });
	fs.writeFileSync(path.join(workspace, ".venv", "pyvenv.cfg"), "");
	fs.writeFileSync(python, `#!/bin/sh\necho ran > '${marker}'\nexit 0\n`, { mode: 0o755 });
	previousUserDir = Bun.env.BN_USER_DIRECTORY;
	Bun.env.BN_USER_DIRECTORY = userDir;
});

afterEach(async () => {
	restoreEnvValue("BN_USER_DIRECTORY", previousUserDir);
	await endContainedSandboxTest(contained);
});

describe.skipIf(!posix)("the Binary Ninja probe with the sandbox active", () => {
	it("runs in the container with the install and user folder readable, and never on the host", async () => {
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		const spawn = vi.spyOn(SandboxRuntime.prototype, "spawn").mockImplementation(async () => fakeChild(0));
		const hostSpawn = vi.spyOn(Bun, "spawn");

		const runtime = await resolveBinjaRuntime(session());

		expect(runtime.pythonPath).toBe(python);
		expect(fs.existsSync(marker)).toBe(false);
		expect(hostSpawn.mock.calls.some(([command]) => Array.isArray(command) && command[0] === python)).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(1);
		const request = spawn.mock.calls[0][0];
		expect(request.argv).toEqual([python, "-c", BINJA_PROBE]);
		expect(request.cwd).toBe(workspace);
		expect(request.network).toBe("deny");
		expect(request.extraRead).toEqual(
			expect.arrayContaining([path.join(workspace, ".venv"), install, binjaPythonDir(install), userDir]),
		);
	});

	it("still reports a refused licence as such, and any other failure as no usable interpreter", async () => {
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		const spawn = vi
			.spyOn(SandboxRuntime.prototype, "spawn")
			.mockImplementation(async () => fakeChild(1, "License is not valid. Please supply a valid license.\n"));

		expect(await failure(resolveBinjaRuntime(session()))).toMatchObject({
			message: expect.stringMatching(/refused its license/),
		});

		spawn.mockImplementation(async () => fakeChild(1, "ModuleNotFoundError: No module named 'binaryninja'\n"));
		expect(await failure(resolveBinjaRuntime(session()))).toMatchObject({
			message: expect.stringMatching(/no Python interpreter can import binaryninja .*tried: .*python/),
		});
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("refuses to probe under fallback block without a backend, and does not run the interpreter", async () => {
		cfgSandboxFallback.set(contained.settings, "block");
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);

		expect(await failure(resolveBinjaRuntime(session()))).toBeInstanceOf(SandboxUnavailableError);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("keeps a contained resolution apart from an uncontained one", async () => {
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		vi.spyOn(SandboxRuntime.prototype, "spawn").mockImplementation(async () => fakeChild(0));
		await resolveBinjaRuntime(session());
		expect(fs.existsSync(marker)).toBe(false);

		// Fallback warn with no backend: the sandbox no longer applies, so the host probes afresh.
		cfgSandboxFallback.set(contained.settings, "warn");
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
		await resolveBinjaRuntime(session());

		expect(fs.existsSync(marker)).toBe(true);
	});

	it("still detects a refused licence when a grandchild keeps stderr open after the exit", async () => {
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		vi.spyOn(SandboxRuntime.prototype, "spawn").mockImplementation(async () =>
			fakeChild(1, textStream("License is not valid. Please supply a valid license.\n", true)),
		);

		expect(await failure(resolveBinjaRuntime(session()))).toMatchObject({
			message: expect.stringMatching(/refused its license/),
		});
	}, 10_000);

	it("cancels a noisy probe's stdout once the bound is read instead of buffering all of it", async () => {
		const total = 256;
		let produced = 0;
		let cancelled = false;
		const finished = Promise.withResolvers<void>();
		const stdout = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (produced === total) {
					controller.close();
					finished.resolve();
					return;
				}
				produced++;
				controller.enqueue(new Uint8Array(16 * 1024));
			},
			cancel() {
				cancelled = true;
				finished.resolve();
			},
		});
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		vi.spyOn(SandboxRuntime.prototype, "spawn").mockImplementation(async () => fakeChild(0, "", stdout));

		await resolveBinjaRuntime(session());
		// The drain runs on after the probe's verdict: wait until it cancelled or read everything.
		await finished.promise;
		expect(cancelled).toBe(true);
		expect(produced).toBeLessThan(total);
	});

	it("reads the user folder of the launch environment, never one the project .env names", async () => {
		const planted = path.join(contained.outside, "planted");
		fs.mkdirSync(planted);
		Bun.env.BN_USER_DIRECTORY = planted;
		fs.writeFileSync(path.join(workspace, ".env"), `BN_USER_DIRECTORY=${planted}\n`);
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		const spawn = vi.spyOn(SandboxRuntime.prototype, "spawn").mockImplementation(async () => fakeChild(0));

		await resolveBinjaRuntime(session());

		const request = spawn.mock.calls[0][0];
		expect(request.extraRead).not.toContain(planted);
		expect(request.env.BN_USER_DIRECTORY).not.toBe(planted);
	});

	it("names the default user folder when none is set, so its licence is readable", async () => {
		const home = path.join(path.dirname(workspace), "home");
		const defaultDir =
			process.platform === "darwin"
				? path.join(home, "Library", "Application Support", "Binary Ninja")
				: path.join(home, ".binaryninja");
		fs.mkdirSync(defaultDir, { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(home);
		delete Bun.env.BN_USER_DIRECTORY;
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		const spawn = vi.spyOn(SandboxRuntime.prototype, "spawn").mockImplementation(async () => fakeChild(0));

		const runtime = await resolveBinjaRuntime(session());

		expect(runtime.env.BN_USER_DIRECTORY).toBe(defaultDir);
		expect(spawn.mock.calls[0][0].extraRead).toContain(defaultDir);
	});
});

describe("the contained Binary Ninja worker's spawn request", () => {
	it("reads the install, its Python API directory and the user folder, never PYTHONPATH or home", async () => {
		const pythonDir = binjaPythonDir(install);
		const extra = path.join(contained.outside, "site");
		fs.mkdirSync(extra);
		const env = {
			...buildBinjaEnv({ PYTHONPATH: [extra, os.homedir()].join(path.delimiter) }, pythonDir, {
				BN_USER_DIRECTORY: userDir,
			}),
			BN_INSTALL_DIR: install,
		};
		const endpoint = path.join(os.tmpdir(), "omp-dsm-x", "worker.sock");

		const request = await containedWorkerSpawnRequest(
			{
				backend: DISASM_BACKENDS.binja,
				loc: {
					id: "b1",
					dir: workspace,
					sourcePath: path.join(workspace, "prog.bndb"),
					stagedPath: path.join(workspace, "prog.bndb"),
					kind: "inplace",
					openPath: path.join(workspace, "prog.bndb"),
					isNew: false,
					lockTarget: path.join(workspace, "prog.bndb"),
				},
				runtime: { pythonPath: python, env },
				script: path.join(os.tmpdir(), "omp-binja-worker-1", "runner.py"),
				args: ["--socket", endpoint],
				endpoint,
				env,
			},
			workspace,
		);

		expect(request.extraRead).toEqual(expect.arrayContaining([install, pythonDir, userDir]));
		expect(request.extraRead).not.toContain(extra);
		expect(request.extraRead).not.toContain(fs.realpathSync(os.homedir()));
	});

	it("refuses a user folder that is the home directory", async () => {
		const env = { ...buildBinjaEnv({}, binjaPythonDir(install), { BN_USER_DIRECTORY: os.homedir() }) };
		const endpoint = path.join(os.tmpdir(), "omp-dsm-x", "worker.sock");
		const loc = {
			id: "b2",
			dir: workspace,
			sourcePath: path.join(workspace, "prog.bndb"),
			stagedPath: path.join(workspace, "prog.bndb"),
			kind: "inplace" as const,
			openPath: path.join(workspace, "prog.bndb"),
			isNew: false,
			lockTarget: path.join(workspace, "prog.bndb"),
		};
		const request = await containedWorkerSpawnRequest(
			{
				backend: DISASM_BACKENDS.binja,
				loc,
				runtime: { pythonPath: python, env },
				script: path.join(os.tmpdir(), "omp-binja-worker-1", "runner.py"),
				args: ["--socket", endpoint],
				endpoint,
				env,
			},
			workspace,
		);

		expect(request.extraRead).not.toContain(fs.realpathSync(os.homedir()));
		expect(request.extraRead).not.toContain(os.homedir());
	});
});
