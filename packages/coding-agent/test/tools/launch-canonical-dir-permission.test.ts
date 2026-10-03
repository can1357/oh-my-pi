import { afterEach, describe, expect, it, vi } from "bun:test";
import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalProjectDir } from "../../src/launch/paths";

describe("canonicalProjectDir permission fallback", () => {
	const originalRealpath = fs.realpath.bind(fs);

	afterEach(() => vi.restoreAllMocks());

	function throwErrno(code: string, errno: number): never {
		const err = new Error(`${code}: permission denied`) as NodeJS.ErrnoException;
		err.code = code;
		err.errno = errno;
		err.syscall = "realpath";
		throw err;
	}

	for (const [code, errno] of [
		["EPERM", -1],
		["EACCES", -13],
	] as const) {
		it(`resolves the normalized absolute path when realpath throws ${code}`, async () => {
			const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-${code.toLowerCase()}-fallback-`));
			const resolvedProjectDir = path.resolve(projectDir);

			vi.spyOn(fs, "realpath").mockImplementation((async (p: PathLike) => {
				if (path.resolve(String(p)) === resolvedProjectDir) {
					throwErrno(code, errno);
				}
				return originalRealpath(p);
			}) as typeof fs.realpath);

			try {
				await expect(canonicalProjectDir(projectDir)).resolves.toBe(resolvedProjectDir);
			} finally {
				await fs.rm(projectDir, { recursive: true, force: true });
			}
		});
	}

	it("still resolves symlinks to their real target when realpath succeeds", async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-canonical-target-"));
		const linkDir = path.join(os.tmpdir(), `omp-canonical-link-${Date.now()}-${process.pid}`);
		await fs.symlink(targetDir, linkDir, "dir");

		try {
			await expect(canonicalProjectDir(linkDir)).resolves.toBe(await fs.realpath(targetDir));
		} finally {
			await fs.rm(linkDir, { force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("rethrows realpath errors that are not missing-path or permission errors", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-eloop-rethrow-"));
		const resolvedProjectDir = path.resolve(projectDir);

		vi.spyOn(fs, "realpath").mockImplementation((async (p: PathLike) => {
			if (path.resolve(String(p)) === resolvedProjectDir) {
				throwErrno("ELOOP", -62);
			}
			return originalRealpath(p);
		}) as typeof fs.realpath);

		try {
			await expect(canonicalProjectDir(projectDir)).rejects.toMatchObject({ code: "ELOOP" });
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	});
});
