import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readImageFromClipboard, readMacFileUrlsFromClipboard } from "@pk-nerdsaver-ai/pi-coding-agent/utils/clipboard";
import * as native from "@pk-nerdsaver-ai/pi-natives";
import type { Subprocess } from "bun";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type SpawnCall = { cmd: string[]; options: SpawnOptions };

function streamOf(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) throw new Error("Failed to create response stream.");
	return body;
}

function fakeProcess(stdout: string, exitCode = 0): Subprocess {
	return {
		pid: 1,
		stdout: streamOf(stdout),
		stderr: streamOf(""),
		exitCode,
		exited: Promise.resolve(exitCode),
		kill: () => true,
	} as unknown as Subprocess;
}

function spyPowershell(calls: SpawnCall[], stdout: string, exitCode = 0) {
	function mockSpawn(opts: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], opts?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		const cmd = Array.isArray(first) ? first : first.cmd;
		const options = Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : (first as SpawnOptions);
		calls.push({ cmd, options });
		return fakeProcess(stdout, exitCode);
	}
	return vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

const ENV_KEYS = ["WSL_DISTRO_NAME", "WSL_INTEROP", "DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

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

// 1x1 red PNG; round-tripped through PowerShell as base64 in the real flow.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("readImageFromClipboard on WSL", () => {
	it("decodes the PowerShell base64 payload without touching the native bridge", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu-24.04";
		process.env.WAYLAND_DISPLAY = "wayland-0";

		const calls: SpawnCall[] = [];
		spyPowershell(calls, RED_1X1_PNG_BASE64);
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		const image = await readImageFromClipboard();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd[0]).toBe("powershell.exe");
		expect(calls[0]?.cmd).toContain("-NoProfile");
		expect(image).not.toBeNull();
		expect(image?.mimeType).toBe("image/png");
		// PNG magic bytes — proves we actually base64-decoded the payload.
		expect(Array.from(image!.data.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(nativeSpy).not.toHaveBeenCalled();
	});

	it("falls back to the native bridge when PowerShell returns no payload and a display is present", async () => {
		setPlatform("linux");
		process.env.WSL_INTEROP = "/run/WSL/1_interop";
		process.env.WAYLAND_DISPLAY = "wayland-0";

		spyPowershell([], "");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		const image = await readImageFromClipboard();

		expect(image).toBeNull();
		expect(nativeSpy).toHaveBeenCalledTimes(1);
	});

	it("falls back to the native bridge when PowerShell exits non-zero (with display)", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		process.env.DISPLAY = ":0";

		spyPowershell([], "noise", 1);
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		await readImageFromClipboard();
		expect(nativeSpy).toHaveBeenCalledTimes(1);
	});

	it("returns null without invoking arboard on headless WSL when PowerShell yields nothing", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		// No DISPLAY / WAYLAND_DISPLAY — arboard would reject, so we must short-circuit.

		spyPowershell([], "");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		expect(await readImageFromClipboard()).toBeNull();
		expect(nativeSpy).not.toHaveBeenCalled();
	});
});

describe("readImageFromClipboard dispatch", () => {
	it("returns null on linux without a display server and never spawns PowerShell", async () => {
		setPlatform("linux");
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		expect(await readImageFromClipboard()).toBeNull();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(nativeSpy).not.toHaveBeenCalled();
	});

	it("uses the PowerShell bridge on native Windows when arboard has no image payload", async () => {
		setPlatform("win32");
		const calls: SpawnCall[] = [];
		spyPowershell(calls, RED_1X1_PNG_BASE64);
		vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		const image = await readImageFromClipboard();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd[0]).toBe("powershell.exe");
		expect(image?.mimeType).toBe("image/png");
		expect(Array.from(image!.data.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(calls[0]?.cmd).toContain("-Sta");
	});

	it("delegates straight to the native bridge on non-WSL linux with a display", async () => {
		setPlatform("linux");
		process.env.DISPLAY = ":0";
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		await readImageFromClipboard();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(nativeSpy).toHaveBeenCalledTimes(1);
	});

	it("returns null on Termux without spawning anything", async () => {
		setPlatform("linux");
		process.env.TERMUX_VERSION = "0.118";
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		expect(await readImageFromClipboard()).toBeNull();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(nativeSpy).not.toHaveBeenCalled();
	});
});

describe("readMacFileUrlsFromClipboard", () => {
	it("returns an empty list on non-darwin platforms without spawning osascript", async () => {
		setPlatform("linux");
		const cp = await import("node:child_process");
		const execSpy = vi.spyOn(cp, "execSync");

		expect(await readMacFileUrlsFromClipboard()).toEqual([]);
		expect(execSpy).not.toHaveBeenCalled();
	});

	it("splits osascript output into one path per non-empty line on darwin", async () => {
		setPlatform("darwin");
		const cp = await import("node:child_process");
		const execSpy = vi
			.spyOn(cp, "execSync")
			.mockReturnValue("/Users/me/Pictures/photo.png\n/Users/me/Pictures/clip.jpg\n\n");

		const paths = await readMacFileUrlsFromClipboard();

		expect(paths).toEqual(["/Users/me/Pictures/photo.png", "/Users/me/Pictures/clip.jpg"]);
		expect(execSpy).toHaveBeenCalledTimes(1);
		const [cmd, options] = execSpy.mock.calls[0] ?? [];
		expect(cmd).toBe("osascript -");
		expect((options as { input?: string } | undefined)?.input).toContain("«class furl»");
	});

	it("returns an empty list when osascript throws (e.g. binary missing)", async () => {
		setPlatform("darwin");
		const cp = await import("node:child_process");
		vi.spyOn(cp, "execSync").mockImplementation(() => {
			throw new Error("osascript: command not found");
		});

		expect(await readMacFileUrlsFromClipboard()).toEqual([]);
	});
});
