import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	copyFullscreenSelection,
	copyToClipboard,
	isClipboardTerminalLocal,
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as native from "@oh-my-pi/pi-natives/clipboard";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { Subprocess } from "bun";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type SpawnCall = { cmd: string[]; options: SpawnOptions };
type SpawnOutput = string | Uint8Array;
type SpawnOutputSource = SpawnOutput | SpawnOutput[] | ((cmd: string[]) => SpawnOutput);
function streamOf(body: SpawnOutput): ReadableStream<Uint8Array> {
	const stream = new Response(body).body;
	if (!stream) throw new Error("Failed to create response stream.");
	return stream;
}

function fakeProcess(stdout: SpawnOutput, exitCode = 0, stderr = ""): Subprocess {
	return {
		pid: 1,
		stdout: streamOf(stdout),
		stderr: streamOf(stderr),
		exitCode,
		exited: Promise.resolve(exitCode),
		kill: () => true,
	} as unknown as Subprocess;
}

function spySpawn(calls: SpawnCall[], stdout: SpawnOutputSource, exitCode: number | number[] = 0) {
	function mockSpawn(opts: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], opts?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		const cmd = Array.isArray(first) ? first : first.cmd;
		const options = Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : (first as SpawnOptions);
		calls.push({ cmd, options });
		const output =
			typeof stdout === "function" ? stdout(cmd) : Array.isArray(stdout) ? (stdout[calls.length - 1] ?? "") : stdout;
		const code = Array.isArray(exitCode) ? (exitCode[calls.length - 1] ?? 0) : exitCode;
		return fakeProcess(output, code);
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

const ENV_KEYS = [
	"WSL_DISTRO_NAME",
	"WSL_INTEROP",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"TERMUX_VERSION",
	"SSH_CONNECTION",
	"SSH_CLIENT",
	"SSH_TTY",
] as const;
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
		spySpawn(calls, RED_1X1_PNG_BASE64);
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

		spySpawn([], "");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		const image = await readImageFromClipboard();

		expect(image).toBeNull();
		expect(nativeSpy).toHaveBeenCalledTimes(1);
	});

	it("falls back to the native bridge when PowerShell exits non-zero (with display)", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		process.env.DISPLAY = ":0";

		spySpawn([], "noise", 1);
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		await readImageFromClipboard();
		expect(nativeSpy).toHaveBeenCalledTimes(1);
	});

	it("returns null without invoking arboard on headless WSL when PowerShell yields nothing", async () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		// No DISPLAY / WAYLAND_DISPLAY — arboard would reject, so we must short-circuit.

		spySpawn([], "");
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

	it("trusts the native no-image answer on Windows without spawning PowerShell", async () => {
		// Regression: a text-only clipboard used to wait ~1s on a cold
		// powershell.exe GetImage() before Ctrl+V could paste the text.
		setPlatform("win32");
		const spawnSpy = vi.spyOn(Bun, "spawn");
		vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		expect(await readImageFromClipboard()).toBeNull();
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("falls back to PowerShell when native Windows image conversion fails", async () => {
		setPlatform("win32");
		const calls: SpawnCall[] = [];
		spySpawn(calls, RED_1X1_PNG_BASE64);
		vi.spyOn(native, "readImageFromClipboard").mockRejectedValue(
			new Error("The clipboard image could not be converted to the appropriate format."),
		);

		const image = await readImageFromClipboard();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd[0]).toBe("powershell.exe");
		expect(calls[0]?.cmd).toContain("-Sta");
		expect(image?.mimeType).toBe("image/png");
		expect(Array.from(image!.data.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

	it("treats a throwing native image read as no image on linux with a display", async () => {
		// Regression: an xclip-written text-only selection makes arboard's
		// image read throw ("Unknown error ... incorrect type received from
		// clipboard") instead of reporting no image. readImageFromClipboard
		// must not propagate that — the smart-paste text fallback depends on
		// a null return.
		setPlatform("linux");
		process.env.DISPLAY = ":0";
		vi.spyOn(native, "readImageFromClipboard").mockRejectedValue(
			new Error("Unknown error while interacting with the clipboard: incorrect type received from clipboard"),
		);

		expect(await readImageFromClipboard()).toBeNull();
	});

	it.each(["image/png", "image/jpeg", "image/gif", "image/webp"] as const)(
		"reads %s bytes through wl-paste before the native bridge on Wayland-only Linux",
		async mimeType => {
			setPlatform("linux");
			process.env.WAYLAND_DISPLAY = "wayland-0";
			const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
			const calls: SpawnCall[] = [];
			spySpawn(calls, [`text/plain\n${mimeType}\n`, data]);
			const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

			const image = await readImageFromClipboard();

			expect(calls).toHaveLength(2);
			expect(calls[0]?.cmd).toEqual(["wl-paste", "--list-types"]);
			expect(calls[1]?.cmd).toEqual(["wl-paste", "--type", mimeType]);
			expect(image).toEqual({ data, mimeType });
			expect(nativeSpy).not.toHaveBeenCalled();
		},
	);

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
		const spawnSpy = vi.spyOn(Bun, "spawn");

		expect(await readMacFileUrlsFromClipboard()).toEqual([]);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("splits osascript output into one path per non-empty line on darwin", async () => {
		setPlatform("darwin");
		const calls: SpawnCall[] = [];
		spySpawn(calls, "/Users/me/Pictures/photo.png\n/Users/me/Pictures/clip.jpg\n\n");

		const paths = await readMacFileUrlsFromClipboard();

		expect(paths).toEqual(["/Users/me/Pictures/photo.png", "/Users/me/Pictures/clip.jpg"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toEqual(["osascript", "-"]);
		// AppleScript payload is piped as stdin; the fix uses Bun.spawn with a
		// Buffer so the child receives it without blocking the event loop.
		const stdin = calls[0]?.options.stdin;
		expect(Buffer.isBuffer(stdin)).toBe(true);
		expect((stdin as Buffer).toString("utf8")).toContain("«class furl»");
	});

	it("returns an empty list when osascript exits non-zero (e.g. binary missing)", async () => {
		setPlatform("darwin");
		spySpawn([], "", 127);

		expect(await readMacFileUrlsFromClipboard()).toEqual([]);
	});
});

describe("readTextFromClipboard", () => {
	it("falls back to xsel when xclip is unavailable on X11", async () => {
		setPlatform("linux");
		process.env.DISPLAY = ":0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, ["", "from xsel"], [1, 0]);

		expect(await readTextFromClipboard()).toBe("from xsel");
		expect(calls.map(call => call.cmd)).toEqual([
			["xclip", "-selection", "clipboard", "-o"],
			["xsel", "--clipboard", "--output"],
		]);
	});

	it("uses the xsel fallback when wl-paste fails in a mixed Wayland/X11 session", async () => {
		setPlatform("linux");
		process.env.WAYLAND_DISPLAY = "wayland-0";
		process.env.DISPLAY = ":0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, ["", "", "from xsel"], [1, 1, 0]);

		expect(await readTextFromClipboard()).toBe("from xsel");
		expect(calls.map(call => call.cmd)).toEqual([
			["wl-paste", "--type", "text", "--no-newline"],
			["xclip", "-selection", "clipboard", "-o"],
			["xsel", "--clipboard", "--output"],
		]);
	});

	it("does not warn when wl-paste reports no text and the X11 tools fail too", async () => {
		setPlatform("linux");
		process.env.WAYLAND_DISPLAY = "wayland-0";
		process.env.DISPLAY = ":0";
		const noText = 'Clipboard content is not available as requested type "text"\n';
		vi.spyOn(Bun, "spawn").mockImplementation(() => fakeProcess("", 1, noText));
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		expect(await readTextFromClipboard()).toBe("");
		expect(warn).not.toHaveBeenCalled();
	});

	it("still reads X11 text after wl-paste reports none", async () => {
		setPlatform("linux");
		process.env.WAYLAND_DISPLAY = "wayland-0";
		process.env.DISPLAY = ":0";
		vi.spyOn(Bun, "spawn")
			.mockImplementationOnce(() => fakeProcess("", 1, "Nothing is copied\n"))
			.mockImplementation(() => fakeProcess("from xclip"));

		expect(await readTextFromClipboard()).toBe("from xclip");
	});

	it("requests UTF-8-capable text instead of the first Wayland MIME offer", async () => {
		setPlatform("linux");
		process.env.WAYLAND_DISPLAY = "wayland-0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, cmd => (cmd.includes("text") ? "已提交75个样本" : "<strong>formatted text</strong>"));

		expect(await readTextFromClipboard()).toBe("已提交75个样本");
		expect(calls.map(call => call.cmd)).toEqual([["wl-paste", "--type", "text", "--no-newline"]]);
	});

	it("returns pbpaste stdout on darwin without touching execSync", async () => {
		setPlatform("darwin");
		const calls: SpawnCall[] = [];
		spySpawn(calls, "hello from pbpaste");

		expect(await readTextFromClipboard()).toBe("hello from pbpaste");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toEqual(["pbpaste"]);
	});

	it("returns an empty string when the subprocess exits non-zero", async () => {
		setPlatform("darwin");
		spySpawn([], "", 1);

		expect(await readTextFromClipboard()).toBe("");
	});

	it("keeps the event loop responsive while the clipboard tool runs (#4235)", async () => {
		setPlatform("darwin");

		// Simulate a slow pbpaste: its stdout stream only emits after a real
		// setTimeout, so the event loop must be free during the read. Under the
		// pre-fix execSync path, this would spin the child synchronously and
		// starve every setInterval tick.
		const DELAY_MS = 80;
		const slowProc = {
			pid: 1,
			stdout: new ReadableStream<Uint8Array>({
				async start(controller) {
					await Bun.sleep(DELAY_MS);
					controller.enqueue(new TextEncoder().encode("payload"));
					controller.close();
				},
			}),
			stderr: streamOf(""),
			exitCode: 0,
			exited: (async () => {
				await Bun.sleep(DELAY_MS);
				return 0;
			})(),
			kill: () => true,
		} as unknown as Subprocess;
		vi.spyOn(Bun, "spawn").mockReturnValue(slowProc);

		let ticks = 0;
		const timer = setInterval(() => {
			ticks += 1;
		}, 10);
		try {
			const text = await readTextFromClipboard();
			expect(text).toBe("payload");
		} finally {
			clearInterval(timer);
		}
		// If the read blocked the loop, ticks would stay at 0. A yielding
		// implementation must turn the loop to resolve the 80ms sleep, which
		// fires the expired interval at least once — even under heavy parallel
		// test load, where wall-clock tick counts are unreliable.
		expect(ticks).toBeGreaterThanOrEqual(1);
	});

	it("reads Windows text natively with LF newlines and no PowerShell spawn", async () => {
		setPlatform("win32");
		const spawnSpy = vi.spyOn(Bun, "spawn");
		vi.spyOn(native, "readTextFromClipboard").mockResolvedValue("line one\r\nline two");

		expect(await readTextFromClipboard()).toBe("line one\nline two");
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("returns an empty string when the Windows clipboard holds no text", async () => {
		setPlatform("win32");
		const spawnSpy = vi.spyOn(Bun, "spawn");
		vi.spyOn(native, "readTextFromClipboard").mockResolvedValue(null);

		expect(await readTextFromClipboard()).toBe("");
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("falls back to PowerShell when the native Windows text read fails", async () => {
		setPlatform("win32");
		const calls: SpawnCall[] = [];
		spySpawn(calls, "from powershell\r\n");
		vi.spyOn(native, "readTextFromClipboard").mockRejectedValue(new Error("Failed to access clipboard"));

		expect(await readTextFromClipboard()).toBe("from powershell\n");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd[0]).toBe("powershell.exe");
	});
});

describe("isClipboardTerminalLocal", () => {
	it("never trusts the system clipboard over SSH, even with a forwarded-looking display", () => {
		const ssh = { SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" };
		// A tmux session can keep a stale forward whose port a later SSH session now owns.
		expect(isClipboardTerminalLocal({ ...ssh, DISPLAY: "localhost:10.0" })).toBe(false);
		expect(isClipboardTerminalLocal({ ...ssh, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
		expect(isClipboardTerminalLocal({ DISPLAY: ":0" })).toBe(true);
	});
});

describe("clipboard copy routing", () => {
	type WriteCallback = (error?: Error | null) => void;
	const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

	function osc52(text: string): string {
		return `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
	}

	/** Make stdout a TTY (or not) that records every write and reports it delivered. */
	function fakeStdout(tty: boolean): string[] {
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | WriteCallback,
				callback?: WriteCallback,
			) => {
				output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
				if (typeof encodingOrCallback === "function") encodingOrCallback();
				else callback?.();
				return true;
			},
		);
		return output;
	}

	beforeEach(() => setPlatform("linux"));

	afterEach(() => {
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
	});

	it("reports success when the native clipboard confirms the write", async () => {
		fakeStdout(false);
		const nativeCopy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => {});

		expect(await copyFullscreenSelection("native payload")).toBe("success");
		expect(nativeCopy).toHaveBeenCalledWith("native payload");
	});

	it("reports an OSC 52 write as unconfirmed when the native clipboard fails", async () => {
		const output = fakeStdout(true);
		vi.spyOn(native, "copyToClipboard").mockImplementation(() => {
			throw new Error("clipboard unavailable");
		});

		expect(await copyFullscreenSelection("terminal payload")).toBe("unconfirmed-terminal");
		expect(output).toEqual([osc52("terminal payload")]);
	});

	it("reports failure when neither the terminal nor a native backend took the text", async () => {
		const output = fakeStdout(false);
		vi.spyOn(native, "copyToClipboard").mockImplementation(() => {
			throw new Error("clipboard unavailable");
		});

		expect(await copyFullscreenSelection("lost payload")).toBe("failed");
		expect(output).toEqual([]);
	});

	it("keeps copyToClipboard best-effort for existing callers", async () => {
		fakeStdout(false);
		vi.spyOn(native, "copyToClipboard").mockImplementation(() => {
			throw new Error("clipboard unavailable");
		});

		expect(await copyToClipboard("legacy payload")).toBeUndefined();
	});

	it("still copies to an SSH-forwarded display after sending OSC 52", async () => {
		process.env.SSH_CONNECTION = "192.0.2.10 50000 192.0.2.20 22";
		process.env.DISPLAY = "localhost:10.0";
		const output = fakeStdout(true);
		const nativeCopy = vi.spyOn(native, "copyToClipboard").mockImplementation(text => {
			output.push(`native: ${text}`);
		});

		await copyToClipboard("forwarded payload");

		expect(output).toEqual([osc52("forwarded payload"), "native: forwarded payload"]);
		expect(nativeCopy).toHaveBeenCalledTimes(1);
	});

	it.each([0, 1])("still tries Termux over SSH and falls back only on failure (exit %i)", async exitCode => {
		process.env.SSH_TTY = "/dev/pts/1";
		process.env.TERMUX_VERSION = "fixture";
		const output = fakeStdout(false);
		const calls: SpawnCall[] = [];
		spySpawn(calls, "", exitCode);
		const nativeCopy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => {});

		await copyToClipboard("termux payload");

		expect(calls.map(call => call.cmd)).toEqual([["termux-clipboard-set"]]);
		expect(calls[0]?.options.stdin).toEqual(Buffer.from("termux payload"));
		if (exitCode === 0) expect(nativeCopy).not.toHaveBeenCalled();
		else expect(nativeCopy).toHaveBeenCalledWith("termux payload");
		expect(output).toEqual([]);
	});

	it.each([
		{ platform: "linux", termux: false, tty: true, expected: "unconfirmed-terminal" },
		{ platform: "darwin", termux: false, tty: true, expected: "unconfirmed-terminal" },
		{ platform: "linux", termux: true, tty: true, expected: "unconfirmed-terminal" },
		{ platform: "linux", termux: false, tty: false, expected: "failed" },
	] as const)(
		"never sends a fullscreen selection to a system backend over SSH ($platform, Termux=$termux, TTY=$tty)",
		async ({ platform, termux, tty, expected }) => {
			setPlatform(platform);
			process.env.SSH_CONNECTION = "192.0.2.10 50000 192.0.2.20 22";
			process.env.DISPLAY = "localhost:10.0";
			if (termux) process.env.TERMUX_VERSION = "fixture";
			const output = fakeStdout(tty);
			const nativeCopy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => {});
			const calls: SpawnCall[] = [];
			spySpawn(calls, "");

			expect(await copyFullscreenSelection("ssh payload")).toBe(expected);
			expect(nativeCopy).not.toHaveBeenCalled();
			expect(calls).toEqual([]);
			expect(output).toEqual(tty ? [osc52("ssh payload")] : []);
		},
	);
});
