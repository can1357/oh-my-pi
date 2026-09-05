import { afterEach, describe, expect, it, vi } from "bun:test";
import { Buffer } from "node:buffer";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as natives from "@oh-my-pi/pi-natives/clipboard";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: string): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Minimal stand-in for the `pbcopy` child: empty stdout, given exit code. */
function fakeProcess(exitCode: number): Bun.Subprocess {
	return {
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		}),
		exited: Promise.resolve(exitCode),
		exitCode,
		kill: () => {},
	} as unknown as Bun.Subprocess;
}

type SpawnCall = { cmd: string[]; stdin: string; env: Record<string, string | undefined> | undefined };

/**
 * On macOS the in-process AppKit write logs
 * `-[NSPasteboard _setData:forType:index:usesPboardTypes:] returns false` to
 * stderr whenever it loses pasteboard ownership — at process teardown, or to
 * another app writing at the same moment. The copy is best-effort and the
 * failure is swallowed, but that line still lands in the user's terminal. So on
 * darwin the write goes through `pbcopy`, mirroring the read path's `pbpaste`.
 *
 * The platform and the child are both faked: the darwin branch has to be
 * exercised on the Linux test runner, and a real `pbcopy` would overwrite
 * whatever the developer has on the pasteboard.
 */
describe("copyToClipboard local backend order", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	});

	function captureSpawns(calls: SpawnCall[], onPbcopy: () => Bun.Subprocess) {
		return vi.spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
			const first = args[0];
			const cmd = Array.isArray(first) ? (first as string[]) : ((first as { cmd?: string[] }).cmd ?? []);
			const options = (Array.isArray(first) ? args[1] : first) as
				| { stdin?: unknown; env?: Record<string, string | undefined> }
				| undefined;
			const stdin = options?.stdin;
			calls.push({
				cmd,
				stdin: stdin instanceof Uint8Array ? Buffer.from(stdin).toString() : "",
				env: options?.env,
			});
			if (cmd[0] === "pbcopy") return onPbcopy();
			throw new Error(`unexpected spawn: ${cmd.join(" ")}`);
		});
	}

	it("writes through pbcopy, never the AppKit path", async () => {
		setPlatform("darwin");
		const nativeCopy = vi.spyOn(natives, "copyToClipboard").mockImplementation(() => {});
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => fakeProcess(0));

		await copyToClipboard("omp-clipboard-order-probe");

		expect(calls.map(call => call.cmd[0])).toEqual(["pbcopy"]);
		expect(calls[0]?.stdin).toBe("omp-clipboard-order-probe");
		expect(nativeCopy).not.toHaveBeenCalled();
	});

	it("hands pbcopy a UTF-8 locale so non-ASCII text survives LANG=C", async () => {
		setPlatform("darwin");
		vi.spyOn(natives, "copyToClipboard").mockImplementation(() => {});
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => fakeProcess(0));

		await copyToClipboard("привет — non-ASCII");

		expect(calls[0]?.stdin).toBe("привет — non-ASCII");
		expect(calls[0]?.env?.LANG).toBe("en_US.UTF-8");
		expect(calls[0]?.env?.LC_ALL).toBe("en_US.UTF-8");
	});

	it("keeps PDF-header text off pbcopy, which would type it as a document", async () => {
		setPlatform("darwin");
		const nativeCopy = vi.spyOn(natives, "copyToClipboard").mockImplementation(() => {});
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => fakeProcess(0));

		await copyToClipboard("%PDF-1.7\nnot really a pdf");

		expect(calls).toEqual([]);
		expect(nativeCopy).toHaveBeenCalledWith("%PDF-1.7\nnot really a pdf");
	});

	it("still reaches the native write when pbcopy is unavailable", async () => {
		setPlatform("darwin");
		const nativeCopy = vi.spyOn(natives, "copyToClipboard").mockImplementation(() => {});
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => {
			throw new Error("spawn pbcopy ENOENT");
		});

		await copyToClipboard("fallback probe");

		expect(calls.map(call => call.cmd[0])).toEqual(["pbcopy"]);
		expect(nativeCopy).toHaveBeenCalledWith("fallback probe");
	});

	it("falls back when pbcopy exits non-zero", async () => {
		setPlatform("darwin");
		const nativeCopy = vi.spyOn(natives, "copyToClipboard").mockImplementation(() => {});
		const calls: SpawnCall[] = [];
		captureSpawns(calls, () => fakeProcess(1));

		await copyToClipboard("nonzero probe");

		expect(calls.map(call => call.cmd[0])).toEqual(["pbcopy"]);
		expect(nativeCopy).toHaveBeenCalledWith("nonzero probe");
	});
});
