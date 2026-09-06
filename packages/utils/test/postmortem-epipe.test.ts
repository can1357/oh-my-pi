import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { postmortem } from "@oh-my-pi/pi-utils";

const childFlag = "--stdio-epipe-child";
const raceChildFlag = "--stdio-epipe-race-child";
const uncaughtIpcChildFlag = "--uncaught-ipc-epipe-child";
const unrelatedUncaughtChildFlag = "--unrelated-uncaught-child";
const unrelatedUncaughtChildFlagIndex = process.argv.indexOf(unrelatedUncaughtChildFlag);
const uncaughtIpcChildFlagIndex = process.argv.indexOf(uncaughtIpcChildFlag);
const socketClosedChildFlag = "--socket-closed-child";
const childFlagIndex = process.argv.indexOf(childFlag);
if (unrelatedUncaughtChildFlagIndex >= 0) {
	setImmediate(() => {
		throw "unrelated fatal exception";
	});
	await Bun.sleep(200);
	process.exit(0);
} else if (uncaughtIpcChildFlagIndex >= 0) {
	const marker = process.argv[uncaughtIpcChildFlagIndex + 1];
	if (!marker) throw new Error("Missing survival marker path");
	setImmediate(() => {
		throw Object.assign(new Error("broken pipe"), { code: "EPIPE", syscall: "send" });
	});
	await Bun.sleep(100);
	await Bun.write(marker, "survived uncaught worker IPC EPIPE");
	process.exit(0);
} else if (childFlagIndex >= 0) {
	const marker = process.argv[childFlagIndex + 1];
	if (!marker) throw new Error("Missing cleanup marker path");
	postmortem.registerStdioDisconnectHandling();
	postmortem.register("stdio-epipe-test", async () => {
		process.stderr.write("cleanup started\n");
		await new Response(Bun.stdin.stream()).text();
		await Bun.write(marker, "cleanup complete");
	});
	const err = Object.assign(new Error("broken pipe"), { code: "EPIPE", syscall: "write" });
	void Promise.reject(err);
	const keepAlive = Promise.withResolvers<void>();
	await keepAlive.promise;
} else if (process.argv.includes(raceChildFlag)) {
	const marker = process.argv[process.argv.indexOf(raceChildFlag) + 1];
	if (!marker) throw new Error("Missing cleanup marker path");
	fs.writeFileSync(marker, "before cleanup");
	postmortem.registerStdioDisconnectHandling();
	postmortem.register("stdio-epipe-race-test", async () => {
		process.stderr.write("cleanup started\n");
		void Promise.reject(Object.assign(new Error("broken pipe"), { code: "EPIPE", syscall: "write" }));
		await new Response(Bun.stdin.stream()).text();
		fs.writeFileSync(marker, "after cleanup");
	});
	let rejectionCount = 0;
	process.on("unhandledRejection", () => {
		if (++rejectionCount === 2) process.stderr.write("second rejection observed\n");
	});
	void Promise.reject(Object.assign(new Error("broken pipe"), { code: "EPIPE", syscall: "write" }));
	await new Promise<void>(() => {});
} else if (process.argv.includes(socketClosedChildFlag)) {
	const err = Object.assign(new Error("Socket is closed"), { code: "ERR_SOCKET_CLOSED" });
	err.stack = "Error: Socket is closed\n    at unknown\n    at close (node:net:686:67)";
	process.emit("uncaughtException", err);
	process.stdout.write("survived\n");
}

if (!process.argv.includes(socketClosedChildFlag)) {
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
			const marker = `/tmp/omp-postmortem-uncaught-ipc-${process.pid}-${Date.now()}`;
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
				await Bun.file(marker)
					.delete()
					.catch(() => {});
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

		it("awaits cleanup and exits successfully when a registered stdio peer disconnects", async () => {
			const marker = `/tmp/omp-postmortem-stdio-${process.pid}-${Date.now()}`;
			const child = Bun.spawn([process.execPath, "run", import.meta.path, childFlag, marker], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const stderrReader = child.stderr.getReader();
				const started = await stderrReader.read();
				stderrReader.releaseLock();
				expect(new TextDecoder().decode(started.value)).toBe("cleanup started\n");
				child.stdin.end();
				const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
				expect(stdout).toBe("");
				expect(exitCode).toBe(0);
				expect(await Bun.file(marker).text()).toBe("cleanup complete");
			} finally {
				try {
					child.stdin.end();
				} catch {
					// Already closed after the cleanup gate was released.
				}
				await child.exited;
				await Bun.file(marker)
					.delete()
					.catch(() => {});
			}
		});

		it("keeps waiting for active cleanup when another stdio EPIPE arrives", async () => {
			const marker = `/tmp/omp-postmortem-stdio-race-${process.pid}-${Date.now()}`;
			const child = Bun.spawn([process.execPath, "run", import.meta.path, raceChildFlag, marker], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const decoder = new TextDecoder();
				const stderrReader = child.stderr.getReader();
				let stderr = "";
				while (!stderr.includes("second rejection observed\n")) {
					const chunk = await stderrReader.read();
					if (chunk.done) throw new Error("Child exited before observing the second rejection");
					stderr += decoder.decode(chunk.value);
				}
				stderrReader.releaseLock();
				expect(stderr).toContain("cleanup started\n");
				child.stdin.end();
				const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
				expect(stdout).toBe("");
				expect(exitCode).toBe(0);
				expect(await Bun.file(marker).text()).toBe("after cleanup");
			} finally {
				try {
					child.stdin.end();
				} catch {
					// Already closed after completing teardown.
				}
				await child.exited;
				await Bun.file(marker)
					.delete()
					.catch(() => {});
			}
		});

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
