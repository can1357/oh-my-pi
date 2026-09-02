import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalProtocolHandler, writeLocalUrlAtomically } from "@oh-my-pi/pi-coding-agent/internal-urls";
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
	it("refuses permissive POSIX local roots and target parents", async () => {
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
			await expect(writeLocalUrlAtomically("local://unsafe.txt", "content", options)).rejects.toMatchObject({
				name: "AtomicLocalWriteError",
				code: "UNSAFE_PATH",
				commitState: "NOT_COMMITTED",
			});

			await fs.rm(localRoot, { recursive: true, force: true });
			await writeLocalUrlAtomically("local://seed.txt", "seed", options);
			const permissiveParent = path.join(localRoot, "permissive");
			await fs.mkdir(permissiveParent, { mode: 0o755 });
			await fs.chmod(permissiveParent, 0o755);
			await expect(
				writeLocalUrlAtomically("local://permissive/unsafe.txt", "content", options),
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
