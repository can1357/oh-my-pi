import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";

const uncaughtIpcChildFlag = "--uncaught-ipc-epipe-child";
const stdoutDisconnectChildFlag = "--stdout-disconnect-child";
const attributionChildFlag = "--attribution-write-epipe-child";
const unrelatedUncaughtChildFlag = "--unrelated-uncaught-child";
const socketClosedChildFlag = "--socket-closed-child";

const CHILD_FLAGS = [
	uncaughtIpcChildFlag,
	stdoutDisconnectChildFlag,
	attributionChildFlag,
	unrelatedUncaughtChildFlag,
	socketClosedChildFlag,
];
if (process.argv.includes(unrelatedUncaughtChildFlag)) {
	// A synchronous throw with no stdio identity must stay fatal.
	setImmediate(() => {
		throw "unrelated fatal exception";
	});
	await Promise.withResolvers<void>().promise;
} else if (process.argv.includes(uncaughtIpcChildFlag)) {
	const marker = process.argv[process.argv.indexOf(uncaughtIpcChildFlag) + 1];
	if (!marker) throw new Error("Missing survival marker path");
	// A worker IPC `send()` EPIPE surfaced as an uncaught exception is contained
	// (log-and-continue); the process survives and records the marker.
	setImmediate(() => {
		throw Object.assign(new Error("broken pipe"), { code: "EPIPE", syscall: "send" });
	});
	setImmediate(async () => {
		await Bun.write(marker, "survived uncaught worker IPC EPIPE");
		process.exit(0);
	});
	await Promise.withResolvers<void>().promise;
} else if (process.argv.includes(stdoutDisconnectChildFlag)) {
	const marker = process.argv[process.argv.indexOf(stdoutDisconnectChildFlag) + 1];
	if (!marker) throw new Error("Missing cleanup marker path");
	postmortem.registerStdioDisconnectHandling();
	postmortem.register("stdio-disconnect-test", async () => {
		await Bun.write(marker, "cleanup complete");
	});
	// A real write to a stdout whose consumer already closed the pipe surfaces on
	// process.stdout's own `error` event, driving graceful runQuit(0) + cleanup.
	for (let i = 0; i < 64; i++) process.stdout.write(`${"x".repeat(64 * 1024)}\n`);
	await Promise.withResolvers<void>().promise;
} else if (process.argv.includes(attributionChildFlag)) {
	postmortem.registerStdioDisconnectHandling();
	// A write EPIPE that did NOT come from stdout (a closed subprocess stdin or
	// socket) must stay fatal even while stdout-disconnect handling is active, so
	// an unrelated failure is never masked as a clean exit.
	setImmediate(() => {
		throw Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE", syscall: "write", errno: -32 });
	});
	await Promise.withResolvers<void>().promise;
} else if (process.argv.includes(socketClosedChildFlag)) {
	const err = Object.assign(new Error("Socket is closed"), { code: "ERR_SOCKET_CLOSED" });
	err.stack = "Error: Socket is closed\n    at unknown\n    at close (node:net:686:67)";
	process.emit("uncaughtException", err);
	process.stdout.write("survived\n");
}

if (!CHILD_FLAGS.some(flag => process.argv.includes(flag))) {
	describe("postmortem broken-pipe handling", () => {
		function makeErr(props: { code?: string; syscall?: string; message?: string }): Error {
			const err = new Error(props.message ?? "broken pipe");
			Object.assign(err, { code: props.code, syscall: props.syscall });
			return err;
		}

		it("classifies worker IPC and stdio EPIPE errors", () => {
			expect(postmortem.classifyBrokenPipe(makeErr({ code: "EPIPE", syscall: "send" }))).toBe("ipc-send");
			expect(postmortem.classifyBrokenPipe(makeErr({ code: "EPIPE", syscall: "write" }))).toBe("stdio-write");
			expect(postmortem.isIpcSendEpipe(makeErr({ code: "EPIPE", syscall: "send" }))).toBe(true);
			expect(postmortem.isIpcSendEpipe(makeErr({ code: "EPIPE", syscall: "write" }))).toBe(false);
		});

		it("does not classify unrelated errors as recoverable broken pipes", () => {
			expect(postmortem.classifyBrokenPipe(makeErr({ code: "EPIPE" }))).toBeUndefined();
			expect(postmortem.classifyBrokenPipe(makeErr({ code: "ENOENT", syscall: "send" }))).toBeUndefined();
			expect(postmortem.classifyBrokenPipe(new Error("boom"))).toBeUndefined();
			expect(postmortem.classifyBrokenPipe(makeErr({ code: undefined, syscall: undefined }))).toBeUndefined();
		});

		it("keeps the process alive when Bun surfaces worker IPC EPIPE as an uncaught exception", async () => {
			const marker = path.join(os.tmpdir(), `omp-postmortem-uncaught-ipc-${process.pid}-${Date.now()}`);
			const child = Bun.spawn([process.execPath, "run", import.meta.path, uncaughtIpcChildFlag, marker], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(exitCode, stderr).toBe(0);
				expect(stdout).toBe("");
				expect(stderr).toBe("");
				expect(await Bun.file(marker).text()).toBe("survived uncaught worker IPC EPIPE");
			} finally {
				child.kill();
				await child.exited;
				await fs.rm(marker, { force: true });
			}
		});

		it("keeps unrelated uncaught exceptions fatal", async () => {
			const child = Bun.spawn([process.execPath, "run", import.meta.path, unrelatedUncaughtChildFlag], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("[Uncaught Exception] Error: unrelated fatal exception");
		});

		// The graceful path is attributed to stdout by process.stdout's own `error`
		// event, so a write EPIPE that never touched stdout must stay fatal. This is
		// the guard against masking an unrelated failure (closed subprocess stdin,
		// socket) as a clean exit while stdout-disconnect handling is registered.
		it("keeps a non-stdout write EPIPE fatal while stdio-disconnect handling is registered", async () => {
			const child = Bun.spawn([process.execPath, "run", import.meta.path, attributionChildFlag], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("[Uncaught Exception]");
			expect(stderr).toContain("EPIPE");
		});

		// Exercises a real failed stdout write (not a synthetic thrown error): a
		// registered owner whose stdout consumer closes early runs cleanup and exits
		// 0. `| true` closes the read end immediately; PIPESTATUS[0] is the child's
		// exit code. Unix pipe semantics + bash PIPESTATUS => skip on Windows.
		it.skipIf(process.platform === "win32")(
			"runs cleanup and exits 0 when a registered stdout consumer closes early",
			async () => {
				const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-postmortem-stdout-"));
				const marker = path.join(tmpDir, "cleanup");
				const errPath = path.join(tmpDir, "child.err");
				try {
					const script = `"${process.execPath}" run "${import.meta.path}" "${stdoutDisconnectChildFlag}" "${marker}" 2>"${errPath}" | true; echo "\${PIPESTATUS[0]}"`;
					const proc = Bun.spawn(["bash", "-c", script], {
						stdout: "pipe",
						stderr: "pipe",
						stdin: "ignore",
					});
					const [, pipestatusText] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
					const childExit = Number(pipestatusText.trim());
					const childStderr = await fs.readFile(errPath, "utf8").catch(() => "");

					expect(childStderr).not.toContain("Uncaught Exception");
					expect(childStderr).not.toContain("Unhandled Rejection");
					expect(childExit).toBe(0);
					expect(await fs.readFile(marker, "utf8")).toBe("cleanup complete");
				} finally {
					await fs.rm(tmpDir, { recursive: true, force: true });
				}
			},
		);

		function makeSocketClosedErr(stack: string): Error {
			const err = new Error("Socket is closed");
			Object.assign(err, { code: "ERR_SOCKET_CLOSED" });
			err.stack = stack;
			return err;
		}

		it("classifies Bun's frameless node:net ERR_SOCKET_CLOSED as internal", () => {
			// Verbatim stack from the Bun 1.4 async close-callback crash.
			expect(
				postmortem.isInternalSocketClosedError(
					makeSocketClosedErr("Error: Socket is closed\n    at unknown\n    at close (node:net:686:67)"),
				),
			).toBe(true);
		});

		it("keeps the process alive for Bun's async node:net close error", async () => {
			const child = Bun.spawn([process.execPath, "run", import.meta.path, socketClosedChildFlag], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			expect(exitCode).toBe(0);
			expect(stdout).toBe("survived\n");
		});

		it("keeps ERR_SOCKET_CLOSED fatal when application frames are on the stack", () => {
			expect(
				postmortem.isInternalSocketClosedError(
					makeSocketClosedErr(
						"Error: Socket is closed\n    at send (/app/src/broker.ts:12:3)\n    at close (node:net:686:67)",
					),
				),
			).toBe(false);
			expect(
				postmortem.isInternalSocketClosedError(makeSocketClosedErr("Error: Socket is closed\n    at unknown")),
			).toBe(false);
			expect(
				postmortem.isInternalSocketClosedError(
					makeSocketClosedErr("Error: Socket is closed\n    at tick (node:timers:1:1)"),
				),
			).toBe(false);
			const other = Object.assign(new Error("Socket is closed"), { code: "EPIPE" });
			expect(postmortem.isInternalSocketClosedError(other)).toBe(false);
			expect(postmortem.isInternalSocketClosedError("not an error")).toBe(false);
		});
	});
}
