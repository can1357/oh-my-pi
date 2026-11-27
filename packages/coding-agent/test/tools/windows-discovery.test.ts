import { describe, expect, it } from "bun:test";
import { discoverWindowsRelay } from "../../src/tools/browser/relay/windows-discovery";
import { ToolAbortError, ToolError } from "../../src/tools/tool-errors";

const instance = "f65d5001-7536-450b-91dd-bb66f22dcc27";
const tuple = `65535 ${instance}`;
const blockForever = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)";

function helper(output: string, tail = ""): string[] {
	return [process.execPath, "-e", `await Bun.write(Bun.stdout, ${JSON.stringify(output)}); ${tail}`];
}

describe("discoverWindowsRelay", () => {
	it("returns only the verified instance and fixed loopback URL", async () => {
		await expect(discoverWindowsRelay(undefined, helper(`${tuple}\r\n`))).resolves.toEqual({
			kind: "relay",
			cdpUrl: "http://127.0.0.1:65535",
			windowsInstance: instance,
		});
	});

	it.each([
		["an empty response", ""],
		["a port outside the TCP range", `65536 ${instance}\n`],
		["extra output", `${tuple}\nwarning\n`],
	])("rejects %s", async (_description, output) => {
		await expect(discoverWindowsRelay(undefined, helper(output))).rejects.toBeInstanceOf(ToolError);
	});

	it("rejects a valid tuple if helper output exceeds the capture limit", async () => {
		const command = helper(`${tuple}\n`, 'await Bun.write(Bun.stderr, "x".repeat(2048));');
		await expect(discoverWindowsRelay(undefined, command)).rejects.toBeInstanceOf(ToolError);
	});

	it("rejects a verified-looking tuple when the helper exits unsuccessfully", async () => {
		await expect(
			discoverWindowsRelay(undefined, helper(`${tuple}\n`, "process.exitCode = 1")),
		).rejects.toBeInstanceOf(ToolError);
	});

	it("reports unavailable interop as a tool error", async () => {
		await expect(
			discoverWindowsRelay(undefined, [`${process.execPath}-missing-windows-helper`]),
		).rejects.toBeInstanceOf(ToolError);
	});

	it("does not recover a tuple from a helper that times out", async () => {
		// Block the subprocess to exercise the real interop deadline without a guessed sleep.
		await expect(discoverWindowsRelay(undefined, helper(`${tuple}\n`, blockForever))).rejects.toBeInstanceOf(
			ToolError,
		);
	}, 7000);

	it("preserves caller cancellation before launch and while the helper is running", async () => {
		const controller = new AbortController();
		const reason = new ToolAbortError("cancelled by caller");
		const command = helper("", blockForever);
		const pending = discoverWindowsRelay(controller.signal, command);
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		await expect(discoverWindowsRelay(controller.signal, command)).rejects.toBe(reason);
	});
});
