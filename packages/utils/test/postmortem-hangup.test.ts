import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem, withTimeout } from "@oh-my-pi/pi-utils";

const keepAliveChildFlag = "--hangup-keep-alive-child";
const unregisteredChildFlag = "--hangup-unregistered-child";
const failingChildFlag = "--hangup-failing-child";

const CHILD_FLAGS = [keepAliveChildFlag, unregisteredChildFlag, failingChildFlag];

function childArgs(flag: string, paths: string[]): string[] {
	return [process.execPath, "run", import.meta.path, flag, ...paths];
}

if (CHILD_FLAGS.some(flag => process.argv.includes(flag))) postmortem.installProcessHandlers();

function childPaths(flag: string): string[] {
	const index = process.argv.indexOf(flag);
	return process.argv.slice(index + 1, index + 3);
}

if (process.argv.includes(keepAliveChildFlag)) {
	const [detachedMarker, cleanupMarker] = childPaths(keepAliveChildFlag);
	if (!detachedMarker || !cleanupMarker) throw new Error("Missing hangup markers");
	postmortem.register("hangup-cleanup", () => writeFileSync(cleanupMarker, "cleanup ran"));
	postmortem.registerHangupHandler(() => {
		writeFileSync(detachedMarker, "detached");
		console.log("detached");
	});
	process.kill(process.pid, "SIGHUP");
	// The pending top-level await keeps the process alive; the parent kills it
	// after observing the detached line.
	await Promise.withResolvers<void>().promise;
} else if (process.argv.includes(unregisteredChildFlag)) {
	const [cleanupMarker] = childPaths(unregisteredChildFlag);
	if (!cleanupMarker) throw new Error("Missing cleanup marker");
	const unregister = postmortem.registerHangupHandler(() => {
		writeFileSync(cleanupMarker, "detach handler ran");
	});
	unregister();
	postmortem.register("hangup-cleanup", () => writeFileSync(cleanupMarker, "cleanup ran"));
	process.kill(process.pid, "SIGHUP");
	await Promise.withResolvers<void>().promise;
} else if (process.argv.includes(failingChildFlag)) {
	const [attemptMarker, cleanupMarker] = childPaths(failingChildFlag);
	if (!attemptMarker || !cleanupMarker) throw new Error("Missing hangup markers");
	postmortem.registerHangupHandler(() => {
		writeFileSync(attemptMarker, "detach attempted");
		throw new Error("detach failed");
	});
	postmortem.register("hangup-cleanup", () => writeFileSync(cleanupMarker, "cleanup ran"));
	process.kill(process.pid, "SIGHUP");
	await Promise.withResolvers<void>().promise;
}

if (!CHILD_FLAGS.some(flag => process.argv.includes(flag))) {
	// SIGHUP is unavailable as a catchable signal on Windows; the daemon-socket
	// detach path is POSIX-only.
	describe.skipIf(process.platform === "win32")("postmortem hangup ownership", () => {
		it("keeps the process alive and skips exit cleanup while a hangup handler claims SIGHUP", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-postmortem-keep-alive-"));
			const detachedMarker = path.join(dir, "detached");
			const cleanupMarker = path.join(dir, "cleanup");
			const child = Bun.spawn(childArgs(keepAliveChildFlag, [detachedMarker, cleanupMarker]), {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const reader = child.stdout.getReader();
				const first = await withTimeout(reader.read(), 5000, "hangup handler never ran");
				reader.releaseLock();
				expect(new TextDecoder().decode(first.value)).toContain("detached");
				expect(child.exitCode).toBeNull();
				expect(await Bun.file(detachedMarker).text()).toBe("detached");
				expect(await Bun.file(cleanupMarker).exists()).toBe(false);
			} finally {
				child.kill("SIGKILL");
				await child.exited;
				await fs.rm(dir, { recursive: true, force: true });
			}
		});

		it("runs exit cleanup with status 129 once every hangup handler is unregistered", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-postmortem-unregistered-"));
			const cleanupMarker = path.join(dir, "cleanup");
			const child = Bun.spawn(childArgs(unregisteredChildFlag, [cleanupMarker]), {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			try {
				expect(exitCode, stderr).toBe(129);
				expect(await Bun.file(cleanupMarker).text()).toBe("cleanup ran");
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		});

		it("falls back to exit cleanup with status 129 when a hangup handler rejects", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-postmortem-failing-"));
			const attemptMarker = path.join(dir, "detached");
			const cleanupMarker = path.join(dir, "cleanup");
			const child = Bun.spawn(childArgs(failingChildFlag, [attemptMarker, cleanupMarker]), {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			try {
				expect(exitCode, stderr).toBe(129);
				expect(await Bun.file(attemptMarker).text()).toBe("detach attempted");
				expect(await Bun.file(cleanupMarker).text()).toBe("cleanup ran");
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		});
	});
}
