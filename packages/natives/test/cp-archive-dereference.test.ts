import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

const FIXED_MTIME_SEC = 1_000_000_000;

async function runCp(cwd: string, args: string): Promise<{ exitCode: number; output: string }> {
	let output = "";
	const result = await executeShell(
		{
			command: `cp ${args}`,
			cwd,
			env: { PI_DISABLE_UUTILS_DESTRUCTIVE: "" },
		},
		(err, chunk) => {
			if (!err) output += chunk;
		},
	);
	return { exitCode: result.exitCode ?? 1, output };
}

describe("cp builtin composite -a and -d link-mode overrides", () => {
	it("keeps -a recursive and attribute-preserving when -L, -H, -P, or -d follows it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-archive-flags-"));
		try {
			const src = path.join(root, "src");
			await fs.mkdir(path.join(src, "sub"), { recursive: true });
			const f1 = path.join(src, "f1.txt");
			const f2 = path.join(src, "f2.txt");
			const nested = path.join(src, "sub", "nested.txt");
			await Bun.write(f1, "linked");
			await fs.link(f1, f2);
			await Bun.write(nested, "nested");
			const fixedDate = new Date(FIXED_MTIME_SEC * 1000);
			await fs.utimes(f1, fixedDate, fixedDate);
			await fs.utimes(nested, fixedDate, fixedDate);

			for (const flag of ["-aL", "-aH", "-aP", "-ad"]) {
				const destName = `dst_${flag.slice(1)}`;
				const res = await runCp(root, `${flag} src ${destName}`);
				expect(res).toEqual({ exitCode: 0, output: "" });

				const destDir = path.join(root, destName);
				expect(await Bun.file(path.join(destDir, "sub", "nested.txt")).text()).toBe("nested");

				const stat1 = await fs.stat(path.join(destDir, "f1.txt"));
				const stat2 = await fs.stat(path.join(destDir, "f2.txt"));
				expect(Math.trunc(stat1.mtimeMs / 1000)).toBe(FIXED_MTIME_SEC);
				expect(stat1.ino).toBe(stat2.ino);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"orders symlink following across -a, -d, -L, -H, and -P without losing preserved attributes",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-archive-symlinks-"));
			try {
				const src = path.join(root, "src");
				await fs.mkdir(src);
				const f1 = path.join(src, "f1.txt");
				const f2 = path.join(src, "f2.txt");
				await Bun.write(f1, "payload");
				await fs.chmod(f1, 0o751);
				const fixedDate = new Date(FIXED_MTIME_SEC * 1000);
				await fs.utimes(f1, fixedDate, fixedDate);
				await fs.link(f1, f2);
				await fs.symlink("f1.txt", path.join(src, "inner-link"));
				await fs.symlink("src", path.join(root, "root-link"));

				// -aL: follows both command-line and inner symlinks while keeping -R and --preserve=all.
				expect(await runCp(root, "-aL root-link out-aL")).toEqual({ exitCode: 0, output: "" });
				const aLRoot = await fs.lstat(path.join(root, "out-aL"));
				expect(aLRoot.isDirectory()).toBe(true);
				const aLInner = await fs.lstat(path.join(root, "out-aL", "inner-link"));
				expect(aLInner.isSymbolicLink()).toBe(false);
				const aLF1 = await fs.stat(path.join(root, "out-aL", "f1.txt"));
				const aLF2 = await fs.stat(path.join(root, "out-aL", "f2.txt"));
				expect(aLF1.mode & 0o777).toBe(0o751);
				expect(Math.trunc(aLF1.mtimeMs / 1000)).toBe(FIXED_MTIME_SEC);
				expect(aLF1.ino).toBe(aLF2.ino);

				// -aH: follows command-line symlink only, keeps inner symlink and --preserve=all.
				expect(await runCp(root, "-aH root-link out-aH")).toEqual({ exitCode: 0, output: "" });
				expect((await fs.lstat(path.join(root, "out-aH"))).isDirectory()).toBe(true);
				expect((await fs.lstat(path.join(root, "out-aH", "inner-link"))).isSymbolicLink()).toBe(true);
				const aHF1 = await fs.stat(path.join(root, "out-aH", "f1.txt"));
				const aHF2 = await fs.stat(path.join(root, "out-aH", "f2.txt"));
				expect(aHF1.mode & 0o777).toBe(0o751);
				expect(Math.trunc(aHF1.mtimeMs / 1000)).toBe(FIXED_MTIME_SEC);
				expect(aHF1.ino).toBe(aHF2.ino);

				// -La and -Ha: trailing -a overrides earlier -L or -H back to no-dereference.
				for (const flag of ["-La", "-Ha"]) {
					const destName = `out_${flag.slice(1)}`;
					expect(await runCp(root, `${flag} root-link ${destName}`)).toEqual({ exitCode: 0, output: "" });
					expect((await fs.lstat(path.join(root, destName))).isSymbolicLink()).toBe(true);
				}

				// -dRL, -dRH, -dRP: -d keeps --preserve=links when -L, -H, or -P follows it.
				expect(await runCp(root, "-dRL root-link out-dRL")).toEqual({ exitCode: 0, output: "" });
				expect((await fs.lstat(path.join(root, "out-dRL", "inner-link"))).isSymbolicLink()).toBe(false);
				expect((await fs.stat(path.join(root, "out-dRL", "f1.txt"))).ino).toBe(
					(await fs.stat(path.join(root, "out-dRL", "f2.txt"))).ino,
				);

				expect(await runCp(root, "-dRH root-link out-dRH")).toEqual({ exitCode: 0, output: "" });
				expect((await fs.lstat(path.join(root, "out-dRH", "inner-link"))).isSymbolicLink()).toBe(true);
				expect((await fs.stat(path.join(root, "out-dRH", "f1.txt"))).ino).toBe(
					(await fs.stat(path.join(root, "out-dRH", "f2.txt"))).ino,
				);

				expect(await runCp(root, "-dRP src out-dRP")).toEqual({ exitCode: 0, output: "" });
				expect((await fs.lstat(path.join(root, "out-dRP", "inner-link"))).isSymbolicLink()).toBe(true);
				expect((await fs.stat(path.join(root, "out-dRP", "f1.txt"))).ino).toBe(
					(await fs.stat(path.join(root, "out-dRP", "f2.txt"))).ino,
				);

				// -LRd and -HRd: trailing -d overrides earlier -L or -H back to no-dereference.
				for (const flag of ["-LRd", "-HRd"]) {
					const destName = `out_${flag.slice(1)}`;
					expect(await runCp(root, `${flag} root-link ${destName}`)).toEqual({ exitCode: 0, output: "" });
					expect((await fs.lstat(path.join(root, destName))).isSymbolicLink()).toBe(true);
				}
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);
});
