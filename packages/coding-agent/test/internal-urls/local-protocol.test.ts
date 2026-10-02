import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	InternalUrlRouter,
	LocalProtocolHandler,
	resolveLocalRoot,
	resolveLocalUrlToPath,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

describe("LocalProtocolHandler", () => {
	beforeEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	it("lists files at local://", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
			await Bun.write(path.join(artifactsDir, "local", "handoff.json"), '{"ok":true}');

			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-a",
			});
			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("local://");

			expect(resource.contentType).toBe("text/markdown");
			expect(resource.content).toContain("handoff.json");
		});
	});

	it("reads a local file from session local root", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const localFile = path.join(artifactsDir, "local", "subtasks", "trace.txt");
			await fs.mkdir(path.dirname(localFile), { recursive: true });
			await Bun.write(localFile, "trace");

			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-b",
			});
			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("local://subtasks/trace.txt");

			expect(resource.content).toBe("trace");
			expect(resource.contentType).toBe("text/plain");
		});
	});

	it("locates files and the root directory, and nothing for missing entries", async () => {
		await withTempDir(async tempDir => {
			const localFile = path.join(tempDir, "local", "report.json");
			await Bun.write(localFile, '{"report":true}');
			const context = { localProtocolOptions: { getArtifactsDir: () => tempDir } };
			const router = InternalUrlRouter.instance();
			expect(await router.locate("local://report.json", context)).toBe(await fs.realpath(localFile));
			expect(await router.locate("local://", context)).toBe(await fs.realpath(path.dirname(localFile)));
			expect(await router.locate("local://missing.json", context)).toBeNull();
		});
	});

	it("blocks path traversal attempts", async () => {
		await withTempDir(async tempDir => {
			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => path.join(tempDir, "artifacts"),
				getSessionId: () => "session-c",
			});
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("local://../secret.txt")).rejects.toThrow(
				"Path traversal (..) is not allowed in local:// URLs",
			);
			await expect(router.resolve("local://%2E%2E/secret.txt")).rejects.toThrow(
				"Path traversal (..) is not allowed in local:// URLs",
			);
		});
	});

	it("uses session id fallback root when artifacts dir is unavailable", async () => {
		const root = resolveLocalRoot({ getSessionId: () => "session-fallback", getArtifactsDir: () => null });
		expect(root).toContain(path.join("omp-local", "session-fallback"));
		expect(resolveLocalUrlToPath("local://memo.txt", { getSessionId: () => "session-fallback" })).toBe(
			path.join(root, "memo.txt"),
		);
	});

	it("uses a stable short temp root for long Windows artifact paths", async () => {
		const longArtifactsDir = path.join(os.tmpdir(), "a".repeat(220), "artifacts");
		const expectedRoot = path.join(os.tmpdir(), "omp-local", "session_long");
		const options = {
			getArtifactsDir: () => longArtifactsDir,
			getSessionId: () => "session:long",
		};
		const root = resolveLocalRoot(options, "win32");
		const resolved = resolveLocalUrlToPath("local://memo.txt", options, "win32");

		expect(root).toBe(expectedRoot);
		expect(resolved).toBe(path.join(expectedRoot, "memo.txt"));

		// The short root must survive moves of the artifact directory so
		// `local://PLAN.md` and handoff files written pre-move stay reachable
		// after `SessionManager.moveTo()` updates `getArtifactsDir()`.
		const movedOptions = {
			getArtifactsDir: () => path.join(os.tmpdir(), "b".repeat(220), "artifacts"),
			getSessionId: () => "session:long",
		};
		expect(resolveLocalRoot(movedOptions, "win32")).toBe(expectedRoot);
	});

	it("blocks symlink escapes outside local root", async () => {
		if (process.platform === "win32") return;

		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const localRoot = path.join(artifactsDir, "local");
			const outsideDir = path.join(tempDir, "outside");
			await fs.mkdir(localRoot, { recursive: true });
			await fs.mkdir(outsideDir, { recursive: true });
			await Bun.write(path.join(outsideDir, "secret.txt"), "secret");
			await fs.symlink(outsideDir, path.join(localRoot, "linked"));

			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-d",
			});
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("local://linked/secret.txt")).rejects.toThrow("local:// URL escapes local root");
		});
	});

	it("refuses write targets reaching outside the local root through missing dirs or dangling symlinks", async () => {
		if (process.platform === "win32") return;

		await withTempDir(async tempDir => {
			const localRoot = path.join(tempDir, "local");
			const outsideDir = path.join(tempDir, "outside");
			await fs.mkdir(localRoot, { recursive: true });
			await fs.mkdir(outsideDir, { recursive: true });
			await fs.symlink(outsideDir, path.join(localRoot, "link"));
			await fs.symlink(path.join(outsideDir, "victim.txt"), path.join(localRoot, "dangling"));
			const context = { localProtocolOptions: { getArtifactsDir: () => tempDir } };
			const router = InternalUrlRouter.instance();

			await expect(router.locate("local://link/newdir/f", context, { create: true })).rejects.toThrow(
				"local:// URL escapes local root",
			);
			await expect(router.locate("local://dangling", context, { create: true })).rejects.toThrow(
				"local:// URL goes through a dangling symlink",
			);
			expect(await router.locate("local://fresh/dir/f", context, { create: true })).toBe(
				path.join(localRoot, "fresh", "dir", "f"),
			);
		});
	});

	it("names the URL, never the host path, when a write target cannot be created", async () => {
		if (process.platform === "win32") return;

		await withTempDir(async tempDir => {
			const localRoot = path.join(tempDir, "local");
			await fs.mkdir(localRoot, { recursive: true });
			await fs.symlink(path.join(localRoot, "loopB"), path.join(localRoot, "loopA"));
			await fs.symlink(path.join(localRoot, "loopA"), path.join(localRoot, "loopB"));
			await Bun.write(path.join(localRoot, "file.txt"), "x");
			const context = { localProtocolOptions: { getArtifactsDir: () => tempDir } };
			const router = InternalUrlRouter.instance();
			const failure = async (url: string) => {
				const error = await router.locate(url, context, { create: true }).then(
					() => undefined,
					(caught: unknown) => caught,
				);
				expect(error).toBeInstanceOf(Error);
				return error instanceof Error ? error.message : "";
			};

			const loop = await failure("local://loopA/x.md");
			expect(loop).toBe("local:// URL goes through a symlink loop: local://loopA/x.md");
			const notDir = await failure("local://file.txt/x.md");
			expect(notDir).toBe("local:// URL goes through a file, not a directory: local://file.txt/x.md");
		});
	});

	it("refuses write targets under a local root that is a dangling symlink", async () => {
		if (process.platform === "win32") return;

		await withTempDir(async tempDir => {
			await fs.symlink(path.join(tempDir, "gone"), path.join(tempDir, "local"));
			const context = { localProtocolOptions: { getArtifactsDir: () => tempDir } };
			const router = InternalUrlRouter.instance();

			await expect(router.locate("local://x.md", context, { create: true })).rejects.toThrow(
				"local:// URL goes through a dangling symlink: local://x.md",
			);
			expect(await router.locate("local://x.md", context)).toBeNull();
			// A merely missing root is created by the write.
			const missing = { localProtocolOptions: { getArtifactsDir: () => path.join(tempDir, "fresh") } };
			expect(await router.locate("local://x.md", missing, { create: true })).toBe(
				path.join(tempDir, "fresh", "local", "x.md"),
			);
		});
	});

	it("prefers caller-supplied context.localProtocolOptions over the installed override", async () => {
		await withTempDir(async tempDir => {
			const overrideArtifactsDir = path.join(tempDir, "override-artifacts");
			const callerArtifactsDir = path.join(tempDir, "caller-artifacts");
			await fs.mkdir(path.join(overrideArtifactsDir, "local"), { recursive: true });
			await fs.mkdir(path.join(callerArtifactsDir, "local"), { recursive: true });
			await Bun.write(path.join(overrideArtifactsDir, "local", "PLAN.md"), "# wrong session");
			await Bun.write(path.join(callerArtifactsDir, "local", "PLAN.md"), "# caller session");

			// Process-global override points at the WRONG session (simulates a
			// stale override leaked from a prior subagent, or the multi-`main`
			// AgentRegistry case in cmux/ACP where "first one wins" lookup
			// picks a sibling session's artifacts dir — issue #1608).
			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => overrideArtifactsDir,
				getSessionId: () => "stale-session",
			});

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("local://PLAN.md", {
				localProtocolOptions: {
					getArtifactsDir: () => callerArtifactsDir,
					getSessionId: () => "caller-session",
				},
			});

			const expectedSourcePath = await fs.realpath(path.join(callerArtifactsDir, "local", "PLAN.md"));

			expect(resource.content).toBe("# caller session");
			// `sourcePath` is canonicalized by the handler after symlink escape checks.
			// On macOS this may turn `/var/...` into `/private/var/...`.
			expect(resource.sourcePath).toBe(expectedSourcePath);
		});
	});

	it("surfaces ENOENT against the caller's local root when the file is missing in that session", async () => {
		await withTempDir(async tempDir => {
			const overrideArtifactsDir = path.join(tempDir, "override-artifacts");
			const callerArtifactsDir = path.join(tempDir, "caller-artifacts");
			await fs.mkdir(path.join(overrideArtifactsDir, "local"), { recursive: true });
			await fs.mkdir(path.join(callerArtifactsDir, "local"), { recursive: true });
			// PLAN.md exists only in the override-pointed session.
			await Bun.write(path.join(overrideArtifactsDir, "local", "PLAN.md"), "# wrong session");

			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => overrideArtifactsDir,
				getSessionId: () => "stale-session",
			});

			const router = InternalUrlRouter.instance();
			await expect(
				router.resolve("local://PLAN.md", {
					localProtocolOptions: {
						getArtifactsDir: () => callerArtifactsDir,
						getSessionId: () => "caller-session",
					},
				}),
			).rejects.toThrow("Local file not found: local://PLAN.md");
		});
	});
});
