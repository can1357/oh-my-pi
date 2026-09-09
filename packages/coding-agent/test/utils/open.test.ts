import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;
type SpawnCall = { cmd: string[]; options: SpawnOptions };

type SpawnSyncOptions = Bun.SpawnOptions.SpawnSyncOptions<"ignore", "pipe", "ignore">;

const existingLinuxPath = "/mnt/c/Users/example/Downloads/session.html";
const windowsPath = "C:\\Users\\example\\Downloads\\session.html";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const ENV_KEYS = ["WSL_DISTRO_NAME", "WSL_INTEROP"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

function fakeProcess(): Subprocess {
	return {
		pid: 1,
		exited: Promise.resolve(0),
		kill: () => true,
	} as unknown as Subprocess;
}

function spySpawn(calls: SpawnCall[]) {
	function mockSpawn(opts: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], opts?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		const cmd = Array.isArray(first) ? first : first.cmd;
		const options = Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : (first as SpawnOptions);
		calls.push({ cmd, options });
		return fakeProcess();
	}
	return vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
}

function spyWslPath(calls: string[][], output: string, exitCode = 0) {
	const result = {
		stdout: Buffer.from(output),
		stderr: null,
		exitCode,
		success: exitCode === 0,
		resourceUsage: {},
		pid: 1,
	} as unknown as Bun.SyncSubprocess<"pipe", "ignore">;

	function mockSpawnSync(opts: SpawnSyncOptions & { cmd: string[] }): Bun.SyncSubprocess<"pipe", "ignore">;
	function mockSpawnSync(cmd: string[], opts?: SpawnSyncOptions): Bun.SyncSubprocess<"pipe", "ignore">;
	function mockSpawnSync(
		first: string[] | (SpawnSyncOptions & { cmd: string[] }),
	): Bun.SyncSubprocess<"pipe", "ignore"> {
		calls.push(Array.isArray(first) ? first : first.cmd);
		return result;
	}
	return vi.spyOn(Bun, "spawnSync").mockImplementation(mockSpawnSync);
}

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = savedEnv[key];
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
	restorePlatform();
	vi.restoreAllMocks();
});

describe("openPath", () => {
	it("opens existing WSL mount files through wslview with a Windows path", () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		// Keep the mocked linux platform deterministic on a Windows dev host:
		// the real path.resolve would rewrite /mnt/c/… against the drive root.
		const realResolve = path.resolve;
		vi.spyOn(path, "resolve").mockImplementation((...segments: string[]) =>
			segments.length === 1 && segments[0] === existingLinuxPath ? existingLinuxPath : realResolve(...segments),
		);
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "wslview" ? "/usr/bin/wslview" : null));
		vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === existingLinuxPath);

		const spawnSyncCalls: string[][] = [];
		spyWslPath(spawnSyncCalls, windowsPath);
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath(existingLinuxPath);

		expect(spawnSyncCalls).toEqual([["wslpath", "-w", existingLinuxPath]]);
		expect(spawnCalls.map(call => call.cmd)).toEqual([["wslview", windowsPath]]);
	});

	it("keeps WSL URL opening on xdg-open without path conversion", () => {
		setPlatform("linux");
		process.env.WSL_INTEROP = "/run/WSL/1_interop";
		vi.spyOn(piUtils, "$which").mockReturnValue("/usr/bin/wslview");
		const spawnSyncSpy = vi.spyOn(Bun, "spawnSync");
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath("https://example.com");

		expect(spawnSyncSpy).not.toHaveBeenCalled();
		expect(spawnCalls.map(call => call.cmd)).toEqual([["xdg-open", "https://example.com"]]);
	});

	it("falls back to xdg-open when wslview is unavailable", () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		vi.spyOn(piUtils, "$which").mockReturnValue(null);
		const spawnSyncSpy = vi.spyOn(Bun, "spawnSync");
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath(existingLinuxPath);

		expect(spawnSyncSpy).not.toHaveBeenCalled();
		expect(spawnCalls.map(call => call.cmd)).toEqual([["xdg-open", existingLinuxPath]]);
	});

	it("resolves PowerShell through %SystemRoot% so a broken machine PATH cannot silence the opener", () => {
		setPlatform("win32");
		const originalSystemRoot = process.env.SystemRoot;
		process.env.SystemRoot = "D:\\CustomWindows";
		const powershellPath = "D:\\CustomWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === powershellPath);
		try {
			const spawnCalls: SpawnCall[] = [];
			spySpawn(spawnCalls);

			const url = "https://mcp.linear.app/authorize?state=xyz&code_challenge_method=S256";
			openPath(url);

			expect(spawnCalls).toHaveLength(1);
			const [call] = spawnCalls;
			// Absolute PowerShell path — bare executable names were the whole bug
			// on Windows boxes where the machine PATH no longer references
			// System32.
			expect(call?.cmd[0]).toBe(powershellPath);
			expect(call?.cmd.slice(1, -1)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
			expect(call?.options.windowsHide).toBe(true);
			// The target rides inside the UTF-16LE payload: no cmd/PowerShell
			// metacharacter parsing ever sees the `&` in the query string, and the
			// terminating error preference makes Start-Process failures exit 1 so
			// openPath's non-zero-exit telemetry observes them (rundll32 always
			// exited 0).
			const decoded = Buffer.from(String(call?.cmd.at(-1)), "base64").toString("utf16le");
			expect(decoded).toBe(`$ErrorActionPreference='Stop';Start-Process '${url}'`);
		} finally {
			if (originalSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = originalSystemRoot;
		}
	});

	it("doubles embedded single quotes so the target stays one PowerShell literal", () => {
		setPlatform("win32");
		vi.spyOn(fs, "existsSync").mockReturnValue(true);
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath("C:\\Users\\o'brien\\report.html");

		const decoded = Buffer.from(String(spawnCalls[0]?.cmd.at(-1)), "base64").toString("utf16le");
		expect(decoded).toBe("$ErrorActionPreference='Stop';Start-Process 'C:\\Users\\o''brien\\report.html'");
	});

	it("falls back to C:\\Windows for PowerShell when SystemRoot is unset, and to the bare name when absent", () => {
		setPlatform("win32");
		const originalSystemRoot = process.env.SystemRoot;
		const originalSystemRootLower = process.env.SYSTEMROOT;
		delete process.env.SystemRoot;
		delete process.env.SYSTEMROOT;
		try {
			const defaultPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
			const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === defaultPath);
			const spawnCalls: SpawnCall[] = [];
			spySpawn(spawnCalls);

			openPath("https://example.com");
			expect(spawnCalls[0]?.cmd[0]).toBe(defaultPath);

			// Exotic layout: resolved path missing → bare name via PATH.
			existsSpy.mockReturnValue(false);
			openPath("https://example.com");
			expect(spawnCalls[1]?.cmd[0]).toBe("powershell.exe");
		} finally {
			if (originalSystemRoot !== undefined) process.env.SystemRoot = originalSystemRoot;
			if (originalSystemRootLower !== undefined) process.env.SYSTEMROOT = originalSystemRootLower;
		}
	});

	it("logs when the opener exits non-zero so Start-Process failures are diagnosable", async () => {
		setPlatform("win32");
		vi.spyOn(fs, "existsSync").mockReturnValue(true);
		const warnSpy = vi.spyOn(piUtils.logger, "warn").mockImplementation((() => {}) as never);
		const failing = {
			pid: 1,
			exited: Promise.resolve(1),
			kill: () => true,
		} as unknown as Subprocess;
		vi.spyOn(Bun, "spawn").mockImplementation(() => failing);

		openPath("https://example.com");
		await failing.exited;
		await Promise.resolve();

		expect(warnSpy).toHaveBeenCalledWith(
			"External opener exited with non-zero status",
			expect.objectContaining({ exitCode: 1 }),
		);
	});
});
