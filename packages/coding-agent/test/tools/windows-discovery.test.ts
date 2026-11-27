import { describe, expect, it, spyOn } from "bun:test";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { discoverWindowsRelay } from "../../src/tools/browser/relay/windows-discovery";
import { ToolAbortError, ToolError } from "../../src/tools/tool-errors";

const instance = "f65d5001-7536-450b-91dd-bb66f22dcc27";
const tuple = `65535 ${instance}`;
const noRelay = "No omp browser relay found on Windows. Open Chrome with the omp extension";
const timedOut = "Windows browser relay discovery timed out after 4 seconds";
// A watchdog inside the real subprocess prevents leaks if discovery fails to kill it.
const hold = "await Bun.sleep(10_000);";
const ignoreTerm = 'process.on("SIGTERM", () => {});';

function helper(output: string, tail = ""): string[] {
	return [process.execPath, "-e", `await Bun.write(Bun.stdout, ${JSON.stringify(output)}); ${tail}`];
}

function startProbe(command: string[], signal?: AbortSignal) {
	// Keep the spy only for the synchronous launch, and use the real Bun process.
	const spawn = spyOn(Bun, "spawn");
	try {
		const pending = discoverWindowsRelay(signal, command);
		const result = spawn.mock.results[0];
		if (result?.type !== "return") {
			void pending.catch(() => {});
			throw new Error("probe did not start the fixture process");
		}
		return { pending, proc: result.value };
	} finally {
		spawn.mockRestore();
	}
}

function holdProcess() {
	const ready = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname === "/finished") finished.resolve();
			else {
				ready.resolve();
				await release.promise;
			}
			return new Response(null);
		},
	});
	return {
		ready: ready.promise,
		release: release.resolve,
		finished: finished.promise,
		stop: () => server.stop(),
		script: `
			const url = ${JSON.stringify(server.url.href)};
			await fetch(url, { signal: AbortSignal.timeout(10_000) });
			await fetch(new URL("/finished", url), { signal: AbortSignal.timeout(2_000) });
		`,
	};
}

describe("discoverWindowsRelay", () => {
	it("accepts a verified tuple and exactly 1024 bytes on stderr", async () => {
		const command = helper(`${tuple}\r\n`, 'await Bun.write(Bun.stderr, "é".repeat(512));');
		const { pending, proc } = startProbe(command);
		const kill = spyOn(proc, "kill");
		try {
			await expect(pending).resolves.toEqual({
				kind: "relay",
				cdpUrl: "http://127.0.0.1:65535",
				windowsInstance: instance,
			});
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
	});

	it.each([
		["an empty response", ""],
		["a port outside the TCP range", `65536 ${instance}\n`],
		["extra output", `${tuple}\nwarning\n`],
	])("rejects %s", async (_description, output) => {
		await expect(discoverWindowsRelay(undefined, helper(output))).rejects.toThrow(noRelay);
	});

	it.each(["stdout", "stderr"] as const)("rejects oversized %s before the blocked helper exits", async stream => {
		const extra = stream === "stdout" ? "!".repeat(1025 - Buffer.byteLength(`${tuple}\n`)) : `${"é".repeat(512)}!`;
		const command = helper(`${tuple}\n`, `await Bun.write(Bun.${stream}, ${JSON.stringify(extra)}); ${hold}`);
		// With no early overflow rejection, this fixture would hit the distinct deadline error.
		await expect(discoverWindowsRelay(undefined, command)).rejects.toThrow(noRelay);
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

	it.skipIf(process.platform === "win32").each(["deadline", "caller"] as const)(
		"handles %s when a descendant still holds the pipes after helper exit",
		async mode => {
			const fixture = holdProcess();
			const tail = `
				Bun.spawn([process.execPath, "-e", ${JSON.stringify(fixture.script)}],
					{ stdin: "ignore", stdout: "inherit", stderr: "inherit" }).unref();
			`;
			const controller = new AbortController();
			const reason = new ToolAbortError("cancelled while waiting for pipes");
			let ready = false;
			try {
				const { proc, pending } = startProbe(helper(`${tuple}\n`, tail), controller.signal);
				const outcome = pending.catch((error: unknown) => error);
				const startup = AbortSignal.timeout(2_000);
				await untilAborted(startup, fixture.ready);
				ready = true;
				expect(await untilAborted(startup, proc.exited)).toBe(0);
				if (mode === "caller") controller.abort(reason);
				const result = await untilAborted(AbortSignal.timeout(mode === "caller" ? 2_000 : 5_000), outcome);
				if (mode === "caller") expect(result).toBe(reason);
				else expect(result).toMatchObject({ name: "ToolError", message: expect.stringContaining(timedOut) });
			} finally {
				controller.abort();
				fixture.release();
				try {
					if (ready) await untilAborted(AbortSignal.timeout(2_000), fixture.finished);
				} finally {
					await fixture.stop();
				}
			}
		},
		7_000,
	);

	it.skipIf(process.platform === "win32")("kills a SIGTERM-ignoring helper on caller cancellation", async () => {
		const fixture = holdProcess();
		const controller = new AbortController();
		const reason = new ToolAbortError("cancelled by caller");
		const command = helper("", `${ignoreTerm} ${fixture.script}`);
		try {
			const { proc, pending } = startProbe(command, controller.signal);
			const outcome = pending.catch((error: unknown) => error);
			try {
				await untilAborted(AbortSignal.timeout(2_000), fixture.ready);
				controller.abort(reason);
				expect(await untilAborted(AbortSignal.timeout(2_000), outcome)).toBe(reason);
				await untilAborted(AbortSignal.timeout(2_000), proc.exited);
				expect(proc.signalCode).toBe("SIGKILL");
				await expect(discoverWindowsRelay(controller.signal, command)).rejects.toBe(reason);
			} finally {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
				await proc.exited;
			}
		} finally {
			fixture.release();
			await fixture.stop();
		}
	});
});
