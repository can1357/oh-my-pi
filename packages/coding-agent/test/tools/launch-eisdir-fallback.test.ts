import { afterEach, describe, expect, it, vi } from "bun:test";
import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerDaemonProjectPresence } from "../../src/launch/presence";

describe("daemon presence canonicalProjectDir EISDIR fallback", () => {
	const originalRealpath = fs.realpath.bind(fs);

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to the resolved path when realpath throws EISDIR", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-eisdir-fallback-"));
		const runtimeDir = path.join(projectDir, "runtime");
		const resolvedProjectDir = path.resolve(projectDir);
		let realpathCalls = 0;

		vi.spyOn(fs, "realpath").mockImplementation((async (p: PathLike) => {
			if (path.resolve(String(p)) === resolvedProjectDir) {
				realpathCalls++;
				const err = new Error("EISDIR: illegal operation on a directory") as NodeJS.ErrnoException;
				err.code = "EISDIR";
				err.errno = -21;
				err.syscall = "lstat";
				err.path = `R:${path.sep}`;
				throw err;
			}
			return originalRealpath(p);
		}) as typeof fs.realpath);

		try {
			const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
			expect(typeof presence.close).toBe("function");
			expect(realpathCalls).toBe(1);

			const clientsDir = path.join(runtimeDir, "clients");
			const entries = await fs.readdir(clientsDir);
			expect(entries).toHaveLength(1);

			await presence.close();
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	});
});
