import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	copyLocalArtifacts,
	LocalProtocolHandler,
	writeLocalUrlAtomically,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-protocol-atomic-write-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

afterEach(() => {
	LocalProtocolHandler.resetOverrideForTests();
});

describe("writeLocalUrlAtomically", () => {
	it("uses the invoking session root despite a stale process-global override", async () => {
		await withTempDir(async tempDir => {
			const staleArtifactsDir = path.join(tempDir, "stale-artifacts");
			const callerArtifactsDir = path.join(tempDir, "caller-artifacts");
			const content = "π\n";
			const expectedPath = path.join(callerArtifactsDir, "local", "nested", "trace.md");

			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => staleArtifactsDir,
				getSessionId: () => "stale-session",
			});

			const outcome = await writeLocalUrlAtomically("local://nested/trace.md", content, {
				getArtifactsDir: () => callerArtifactsDir,
				getSessionId: () => "caller-session",
			});

			expect(outcome).toEqual({
				absolutePath: expectedPath,
				bytesWritten: Buffer.byteLength(content, "utf-8"),
				madeExecutable: false,
				commitState: "COMMITTED",
			});
			expect(await Bun.file(expectedPath).text()).toBe(content);
			expect(await Bun.file(path.join(staleArtifactsDir, "local", "nested", "trace.md")).exists()).toBe(false);
		});
	});
	it("canonicalizes trusted POSIX symlink ancestors without following a linked local root", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async tempDir => {
			const realParent = path.join(tempDir, "real-parent");
			const linkedParent = path.join(tempDir, "linked-parent");
			await fs.mkdir(realParent, { mode: 0o700 });
			await fs.symlink(realParent, linkedParent, "dir");

			await writeLocalUrlAtomically("local://nested/trace.md", "safe", {
				getArtifactsDir: () => path.join(linkedParent, "artifacts"),
				getSessionId: () => "canonical-ancestor",
			});

			expect(await fs.readFile(path.join(realParent, "artifacts", "local", "nested", "trace.md"), "utf8")).toBe(
				"safe",
			);
		});
	});
	it("keeps copied POSIX session roots writable through the native boundary", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async tempDir => {
			const sourceRoot = path.join(tempDir, "source", "local");
			const destinationArtifacts = path.join(tempDir, "destination");
			const destinationRoot = path.join(destinationArtifacts, "local");
			await fs.mkdir(path.join(sourceRoot, "nested"), { recursive: true, mode: 0o755 });
			await fs.writeFile(path.join(sourceRoot, "nested", "plan.md"), "plan");

			await copyLocalArtifacts(sourceRoot, destinationRoot);
			await writeLocalUrlAtomically("local://nested/result.md", "result", {
				getArtifactsDir: () => destinationArtifacts,
				getSessionId: () => "copied-root",
			});

			expect(await fs.readFile(path.join(destinationRoot, "nested", "plan.md"), "utf8")).toBe("plan");
			expect(await fs.readFile(path.join(destinationRoot, "nested", "result.md"), "utf8")).toBe("result");
			expect((await fs.stat(destinationRoot)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(destinationRoot, "nested"))).mode & 0o777).toBe(0o700);
		});
	});
	it("replaces a hard-link directory entry without modifying the linked outside file", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const options = {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "hard-link-replacement",
			};
			const localRoot = path.join(artifactsDir, "local");
			const outsideFile = path.join(tempDir, "outside-sensitive.txt");
			await writeLocalUrlAtomically("local://seed.txt", "seed", options);
			await fs.writeFile(outsideFile, "sensitive");
			await fs.link(outsideFile, path.join(localRoot, "linked.txt"));

			await writeLocalUrlAtomically("local://linked.txt", "replacement", options);

			expect(await fs.readFile(outsideFile, "utf8")).toBe("sensitive");
			expect(await fs.readFile(path.join(localRoot, "linked.txt"), "utf8")).toBe("replacement");
		});
	});

	it("refuses symlink or reparse components below and at the local root", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const options = {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "link-refusal",
			};
			const localRoot = path.join(artifactsDir, "local");
			const outside = path.join(tempDir, "outside");
			await fs.mkdir(outside, { recursive: true });
			await writeLocalUrlAtomically("local://seed.txt", "seed", options);
			await fs.symlink(outside, path.join(localRoot, "escape"), process.platform === "win32" ? "junction" : "dir");

			await expect(writeLocalUrlAtomically("local://escape/outside.txt", "unsafe", options)).rejects.toMatchObject({
				name: "AtomicLocalWriteError",
				code: "UNSAFE_PATH",
				commitState: "NOT_COMMITTED",
			});
			expect(await Bun.file(path.join(outside, "outside.txt")).exists()).toBe(false);

			const linkedArtifacts = path.join(tempDir, "linked-artifacts");
			await fs.mkdir(linkedArtifacts, { recursive: true });
			await fs.symlink(
				outside,
				path.join(linkedArtifacts, "local"),
				process.platform === "win32" ? "junction" : "dir",
			);
			await expect(
				writeLocalUrlAtomically("local://outside.txt", "unsafe", {
					getArtifactsDir: () => linkedArtifacts,
					getSessionId: () => "root-link-refusal",
				}),
			).rejects.toMatchObject({
				name: "AtomicLocalWriteError",
				code: "UNSAFE_PATH",
				commitState: "NOT_COMMITTED",
			});
		});
	});
	it("migrates owner-owned POSIX directories to 0700 and rejects writable shared parents", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const options = {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "private-directory-enforcement",
			};
			const localRoot = path.join(artifactsDir, "local");
			await fs.mkdir(localRoot, { recursive: true, mode: 0o755 });
			await fs.chmod(localRoot, 0o755);
			await writeLocalUrlAtomically("local://migrated.txt", "content", options);
			expect((await fs.stat(localRoot)).mode & 0o777).toBe(0o700);

			const readableParent = path.join(localRoot, "readable");
			await fs.mkdir(readableParent, { mode: 0o750 });
			await writeLocalUrlAtomically("local://readable/migrated.txt", "content", options);
			expect((await fs.stat(readableParent)).mode & 0o777).toBe(0o700);

			const writableParent = path.join(localRoot, "writable");
			await fs.mkdir(writableParent, { mode: 0o770 });
			await fs.chmod(writableParent, 0o770);
			await expect(writeLocalUrlAtomically("local://writable/unsafe.txt", "content", options)).rejects.toMatchObject(
				{
					name: "AtomicLocalWriteError",
					code: "UNSAFE_PATH",
					commitState: "NOT_COMMITTED",
				},
			);

			const otherWritableParent = path.join(localRoot, "other-writable");
			await fs.mkdir(otherWritableParent, { mode: 0o700 });
			await fs.chmod(otherWritableParent, 0o702);
			await expect(
				writeLocalUrlAtomically("local://other-writable/unsafe.txt", "content", options),
			).rejects.toMatchObject({
				name: "AtomicLocalWriteError",
				code: "UNSAFE_PATH",
				commitState: "NOT_COMMITTED",
			});
		});
	});

	it("concurrent writers leave one complete payload and no staged files", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const options = {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "concurrent-writers",
			};
			const contentA = `A:${"a".repeat(256 * 1024)}`;
			const contentB = `B:${"b".repeat(256 * 1024)}`;

			await Promise.all([
				writeLocalUrlAtomically("local://race.txt", contentA, options),
				writeLocalUrlAtomically("local://race.txt", contentB, options),
			]);

			const localRoot = path.join(artifactsDir, "local");
			const finalContent = await fs.readFile(path.join(localRoot, "race.txt"), "utf8");
			expect([contentA, contentB]).toContain(finalContent);
			expect((await fs.readdir(localRoot)).some(name => name.startsWith(".omp-atomic-"))).toBe(false);
		});
	});

	it("concurrent readers observe only the complete old or new payload", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const options = {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "concurrent-readers",
			};
			const oldContent = `old:${"o".repeat(512 * 1024)}`;
			const newContent = `new:${"n".repeat(512 * 1024)}`;
			const targetPath = path.join(artifactsDir, "local", "visible.txt");
			await writeLocalUrlAtomically("local://visible.txt", oldContent, options);

			let finished = false;
			let replacementError: unknown;
			const replacement = writeLocalUrlAtomically("local://visible.txt", newContent, options)
				.catch(error => {
					replacementError = error;
				})
				.finally(() => {
					finished = true;
				});
			const observed = new Set<string>();
			while (!finished && observed.size < 3) {
				observed.add(await fs.readFile(targetPath, "utf8"));
			}
			await replacement;
			observed.add(await fs.readFile(targetPath, "utf8"));

			if (replacementError !== undefined) {
				expect(process.platform).toBe("win32");
				expect(replacementError).toMatchObject({
					name: "AtomicLocalWriteError",
					code: "BUSY",
					commitState: "NOT_COMMITTED",
				});
				expect(await fs.readFile(targetPath, "utf8")).toBe(oldContent);
				await writeLocalUrlAtomically("local://visible.txt", newContent, options);
				observed.add(await fs.readFile(targetPath, "utf8"));
			}

			for (const content of observed) expect([oldContent, newContent]).toContain(content);
			expect(observed.has(newContent)).toBe(true);
		});
	});

	it("rejects malformed target components before native code can create the local root", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const options = {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "component-grammar",
			};

			for (const input of [
				"local://",
				"local://./trace.md",
				"local://nested/../trace.md",
				"local://nested//trace.md",
				"local://nested/%00trace.md",
				"local://nested%5Ctrace.md",
				"local://%2525252e%2525252e/outside.md",
			]) {
				await expect(writeLocalUrlAtomically(input, "content", options)).rejects.toMatchObject({
					name: "AtomicLocalWriteError",
					code: "INVALID_INPUT",
					commitState: "NOT_COMMITTED",
				});
			}

			await expect(fs.lstat(path.join(artifactsDir, "local"))).rejects.toThrow();
		});
	});

	it("rejects unpaired UTF-16 surrogates instead of replacing them during UTF-8 encoding", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const options = {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "strict-utf8",
			};

			await expect(writeLocalUrlAtomically("local://trace.md", "before\ud800after", options)).rejects.toMatchObject({
				name: "AtomicLocalWriteError",
				code: "INVALID_INPUT",
				commitState: "NOT_COMMITTED",
			});
			await expect(fs.lstat(path.join(artifactsDir, "local"))).rejects.toThrow();
		});
	});

	it("retains structured native cancellation truth and the old target", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const options = {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "aborted-session",
			};
			await writeLocalUrlAtomically("local://abort.md", "old", options);
			const controller = new AbortController();
			controller.abort();

			await expect(
				writeLocalUrlAtomically("local://abort.md", "replacement", options, controller.signal),
			).rejects.toMatchObject({
				name: "AtomicLocalWriteError",
				code: "ABORTED",
				commitState: "NOT_COMMITTED",
			});
			expect(await fs.readFile(path.join(artifactsDir, "local", "abort.md"), "utf8")).toBe("old");
		});
	});
});
