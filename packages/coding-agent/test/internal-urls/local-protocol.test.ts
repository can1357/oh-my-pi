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

	it("resolves path-only files and directories without returning their contents", async () => {
		await withTempDir(async tempDir => {
			const localFile = path.join(tempDir, "local", "report.json");
			await Bun.write(localFile, '{"report":true}');
			const context = {
				localProtocolOptions: { getArtifactsDir: () => tempDir },
				pathOnly: true,
			};
			const router = InternalUrlRouter.instance();
			const file = await router.resolve("local://report.json", context);
			expect(file.sourcePath).toBe(await fs.realpath(localFile));
			expect(file.content).toBe("");
			expect(file.isDirectory).toBe(false);
			const directory = await router.resolve("local://", context);
			expect(directory.sourcePath).toBe(await fs.realpath(path.dirname(localFile)));
			expect(directory.content).toBe("");
			expect(directory.isDirectory).toBe(true);
			await expect(router.resolve("local://missing.json", context)).rejects.toThrow("Local file not found");
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
