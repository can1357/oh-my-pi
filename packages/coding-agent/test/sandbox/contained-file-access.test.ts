/**
 * File tools under the OS sandbox: their writes, deletes, AST rewrites and SQLite row writes run in
 * a contained host, and a single-file read is opened there first, so the container refuses one that
 * omp's path check never saw (a symlink, or a call that skipped the check). The contained cases
 * skip where no backend exists.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import {
	containedAstEdit,
	containedFileAccess,
	mutateFile,
	openReadableCopy,
	withContainedFileAccess,
} from "@oh-my-pi/pi-coding-agent/sandbox/file-access";
import { SandboxRuntime, SandboxUnavailableError } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxDenyRead, cfgSandboxFallback, cfgSandboxMode } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { sandboxHostPoolSize } from "@oh-my-pi/pi-coding-agent/sandbox/shell-client";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { deleteFileWithFallback, isPermissionDeniedError } from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { createTtsTool } from "@oh-my-pi/pi-coding-agent/tools/tts";
import { ttsClient } from "@oh-my-pi/pi-coding-agent/tts/tts-client";
import { readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";
import {
	beginContainedSandboxTest,
	CONTAINED_SOURCE_RUNS,
	type ContainedSandboxTest,
	containedToolSession,
	endContainedSandboxTest,
	failure,
	SANDBOX_BACKEND_PRESENT,
	SANDBOX_UNAVAILABLE,
} from "../helpers/sandbox-test-state";

let fixture: ContainedSandboxTest;
let settings: Settings;
let workspace: string;
/** Neither the workspace nor the (spied) tmpdir, so read-only when contained. */
let outside: string;
/** The session's artifacts dir, whose `local` child is the `local://` root. */
let artifacts: string;
let sessionKey: string;

function toolSession(sessionId: string | null = sessionKey): ToolSession {
	return containedToolSession(fixture, sessionId);
}

/** Runs `fn` as a contained tool call of `session` would, failing if nothing is contained. */
function contained<T>(fn: () => Promise<T>, session = toolSession()): Promise<T> {
	return withContainedFileAccess(session, () => {
		if (!containedFileAccess()) throw new Error("expected the call's mutations to be contained");
		return fn();
	});
}

beforeEach(async () => {
	fixture = await beginContainedSandboxTest("contained-mutations");
	({ settings, workspace, outside, artifacts, sessionKey } = fixture);
});

afterEach(() => endContainedSandboxTest(fixture));

describe("destructive file tools without a sandbox backend", () => {
	it("refuses the call under `fallback: block` and runs it in-process under `warn`", async () => {
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
		SandboxRuntime.setWarningSink(() => {});
		cfgSandboxFallback.set(settings, "block");
		const run = vi.fn(async () => containedFileAccess());
		expect(await failure(withContainedFileAccess(toolSession(), run))).toBeInstanceOf(SandboxUnavailableError);
		expect(run).not.toHaveBeenCalled();
		cfgSandboxFallback.set(settings, "warn");
		expect(await withContainedFileAccess(toolSession(), run)).toBeUndefined();
		SandboxRuntime.setWarningSink(undefined);
	});
});

describe("openReadableCopy", () => {
	/** Records the directories `TempDir.create` makes. */
	function trackTempDirs(): string[] {
		const made: string[] = [];
		const mkdtemp = fsp.mkdtemp;
		vi.spyOn(fsp, "mkdtemp").mockImplementation((async (prefix: string) => {
			const dir = await mkdtemp(prefix);
			made.push(dir);
			return dir;
		}) as typeof fsp.mkdtemp);
		return made;
	}

	it("copies the file into a private directory that disposing removes, and removes its directory when the copy fails", async () => {
		const made = trackTempDirs();
		const source = path.join(workspace, "clip.bin");
		fs.writeFileSync(source, "bytes");
		const copy = await openReadableCopy(source, "clip.mp4");
		expect(path.basename(copy.path)).toBe("clip.mp4");
		expect(made).toEqual([path.dirname(copy.path)]);
		expect(fs.readFileSync(copy.path, "utf8")).toBe("bytes");
		await copy[Symbol.asyncDispose]();
		expect(fs.existsSync(made[0])).toBe(false);

		const error = await failure(openReadableCopy(path.join(workspace, "missing.bin"), "clip.mp4"));
		expect((error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
		expect(made).toHaveLength(2);
		expect(fs.existsSync(made[1])).toBe(false);
	});
});

describe.skipIf(!SANDBOX_BACKEND_PRESENT || !CONTAINED_SOURCE_RUNS)("contained file access", () => {
	it("refuses a write through a workspace symlink that leads outside", async () => {
		// Called on the tool directly, so omp's path check never runs: the container must refuse it.
		fs.symlinkSync(outside, path.join(workspace, "link"));
		const write = new WriteTool(toolSession()).execute("call-escape", { path: "link/escaped.txt", content: "x" });
		const error = await failure(write);
		expect(isPermissionDeniedError(error) || isPermissionDeniedError((error as Error | undefined)?.cause)).toBe(true);
		expect(fs.existsSync(path.join(outside, "escaped.txt"))).toBe(false);
	});

	it("refuses an edit through a workspace symlink that leads outside", async () => {
		// The edit's writes reach omp through a native callback; they must still run in the host.
		fs.symlinkSync(outside, path.join(workspace, "link"));
		const input = "*** Begin Patch\n*** Add File: link/escaped.txt\n+x\n*** End Patch\n";
		const edit = new EditTool(toolSession(), "apply_patch").execute("call-edit-escape", { input } as never);
		const outcome = await edit.then(
			result => ({ result, error: undefined }),
			(error: unknown) => ({ result: undefined, error }),
		);
		if (outcome.result) {
			expect(outcome.result.isError).toBe(true);
			const text = outcome.result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			expect(text).toMatch(/EACCES|EPERM|EROFS|permission denied|read-only file system/i);
		} else {
			const { error } = outcome;
			const cause = error instanceof Error ? error.cause : undefined;
			expect(isPermissionDeniedError(error) || isPermissionDeniedError(cause)).toBe(true);
		}
		expect(fs.existsSync(path.join(outside, "escaped.txt"))).toBe(false);
	});

	it("refuses tts audio saved through a workspace symlink that leads outside", async () => {
		vi.spyOn(ttsClient, "synthesize").mockResolvedValue({ pcm: new Float32Array([0, 0.25]), sampleRate: 24_000 });
		fs.symlinkSync(outside, path.join(workspace, "link"));
		const auth = await AuthStorage.create(":memory:");
		try {
			const ttsSettings = Settings.isolated();
			const context: CustomToolContext = {
				sessionManager: SessionManager.inMemory(workspace),
				modelRegistry: new ModelRegistry(auth, path.join(workspace, "models.yml"), { settings: ttsSettings }),
				model: undefined,
				isIdle: () => true,
				hasQueuedMessages: () => false,
				abort() {},
				settings: ttsSettings,
			};
			const tts = createTtsTool(toolSession());
			const error = await failure(
				tts.execute("call-tts-escape", { text: "hi", output_path: "link/out.wav" }, undefined, context),
			);
			const cause = error instanceof Error ? error.cause : undefined;
			expect(isPermissionDeniedError(error) || isPermissionDeniedError(cause)).toBe(true);
			expect(fs.existsSync(path.join(outside, "out.wav"))).toBe(false);
		} finally {
			auth.close();
		}
	});

	it("refuses to delete a file outside the writable roots", async () => {
		const victim = path.join(outside, "keep.txt");
		fs.writeFileSync(victim, "keep\n");
		expect(isPermissionDeniedError(await failure(contained(() => deleteFileWithFallback(victim))))).toBe(true);
		expect(fs.readFileSync(victim, "utf8")).toBe("keep\n");
	});

	it("writes local:// in read-only mode, where the workspace is not writable", async () => {
		cfgSandboxMode.set(settings, "read-only");
		const session = toolSession();
		const tool = new WriteTool(session);
		const result = await tool.execute("call-local", { path: "local://notes/plan.md", content: "plan\n" });
		expect(result.isError).toBeFalsy();
		const root = resolveLocalRoot({ getArtifactsDir: () => artifacts, getSessionId: () => sessionKey });
		expect(fs.readFileSync(path.join(root, "notes", "plan.md"), "utf8")).toBe("plan\n");
		expect(await failure(tool.execute("call-ws", { path: "blocked.txt", content: "x" }))).toBeDefined();
		expect(fs.existsSync(path.join(workspace, "blocked.txt"))).toBe(false);
	});

	it("writes a payload larger than one protocol line in chunks", async () => {
		const target = path.join(workspace, "big.bin");
		const bytes = Buffer.alloc(40 * 1024 * 1024);
		for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) % 251;
		await contained(() => mutateFile({ kind: "write", path: target, data: bytes }));
		expect(fs.readFileSync(target).equals(bytes)).toBe(true);
		// The host survived the large write.
		expect(sandboxHostPoolSize(`files:${sessionKey}`)).toBe(1);
	});

	it("keeps writing after the session's host is retired mid-call", async () => {
		await contained(async () => {
			await mutateFile({ kind: "write", path: path.join(workspace, "a.txt"), data: "a" });
			releaseShellSessions(sessionKey);
			await mutateFile({ kind: "write", path: path.join(workspace, "b.txt"), data: "b" });
		});
		expect([
			fs.readFileSync(path.join(workspace, "a.txt"), "utf8"),
			fs.readFileSync(path.join(workspace, "b.txt"), "utf8"),
		]).toEqual(["a", "b"]);
	});

	it("applies an AST rewrite in the workspace and leaves a file outside unchanged", async () => {
		const inside = path.join(workspace, "a.ts");
		const beyond = path.join(outside, "b.ts");
		fs.writeFileSync(inside, "const value = oldName();\n");
		fs.writeFileSync(beyond, "const value = oldName();\n");
		const rewrite = { rewrites: { "oldName()": "newName()" }, lang: "typescript", dryRun: false };
		const applied = await contained(() => containedAstEdit({ ...rewrite, path: inside }));
		expect(applied.totalReplacements).toBe(1);
		expect(fs.readFileSync(inside, "utf8")).toBe("const value = newName();\n");
		await failure(contained(() => containedAstEdit({ ...rewrite, path: beyond })));
		expect(fs.readFileSync(beyond, "utf8")).toBe("const value = oldName();\n");
	});

	it("runs a SQLite row write in the workspace and refuses one outside", async () => {
		const create = (dbPath: string) => {
			const db = new Database(dbPath);
			db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
			db.close();
		};
		const insideDb = path.join(workspace, "notes.db");
		const outsideDb = path.join(outside, "notes.db");
		create(insideDb);
		create(outsideDb);
		const row = { table: "notes", key: undefined, content: '{ body: "hi" }' };
		const write = (dbPath: string) =>
			contained(() => containedFileAccess()!.request({ op: "sqlite.write", write: { ...row, dbPath } }));
		expect(await write(insideDb)).toBe("Inserted row into notes");
		expect(await failure(write(outsideDb))).toBeInstanceOf(Error);
		const count = (dbPath: string) => {
			const db = new Database(dbPath, { readonly: true });
			const rows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM notes").get()?.n;
			db.close();
			return rows;
		};
		expect([count(insideDb), count(outsideDb)]).toEqual([1, 0]);
	});

	it("rewrites an existing archive in the workspace through the verified handle", async () => {
		const archive = path.join(workspace, "bundle.tar");
		await writeArchive(archive, "tar", [["keep.txt", "keep\n"]]);
		const result = await new WriteTool(toolSession()).execute("call-archive", {
			path: "bundle.tar:added.txt",
			content: "added\n",
		});
		expect(result.isError).toBeFalsy();
		const entries = await readArchiveEntries({ path: archive, format: "tar" });
		expect([...entries.keys()].sort()).toEqual(["added.txt", "keep.txt"]);
		expect(new TextDecoder().decode(entries.get("keep.txt"))).toBe("keep\n");
		expect(fs.readdirSync(workspace).filter(name => name.startsWith("bundle.tar.tmp-"))).toEqual([]);
	});

	it("refuses an archive write once a denied archive is swapped in after omp resolved it", async () => {
		const archive = path.join(workspace, "bundle.tar");
		const secret = path.join(outside, "secret.tar");
		await writeArchive(archive, "tar", [["keep.txt", "keep\n"]]);
		await writeArchive(secret, "tar", [["secret.txt", "secret\n"]]);
		cfgSandboxDenyRead.set(settings, [outside]);
		// A contained shell swaps the archive for a link to the denied one right after omp resolved it.
		const realpath = fsp.realpath;
		vi.spyOn(fsp, "realpath").mockImplementation((async (target: string) => {
			if (target !== archive) return realpath(target);
			if (!fs.lstatSync(archive).isSymbolicLink()) {
				fs.rmSync(archive);
				fs.symlinkSync(secret, archive);
			}
			return archive;
		}) as typeof fsp.realpath);
		const error = await failure(
			new WriteTool(toolSession()).execute("call-archive-swap", {
				path: "bundle.tar:added.txt",
				content: "added\n",
			}),
		);
		// The container refused to open the archive, naming it (seatbelt refuses with EPERM).
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/\b(ENOENT|EACCES|EPERM)\b/);
		expect((error as Error).message).toContain("bundle.tar");
		// The link was never replaced by a rewrite carrying the denied members.
		expect(fs.lstatSync(archive).isSymbolicLink()).toBe(true);
	});

	it("keeps a session call's late file work contained after the call returned", async () => {
		const gate = Promise.withResolvers<void>();
		const late = await contained(async () => ({
			escape: gate.promise.then(() =>
				mutateFile({ kind: "write", path: path.join(outside, "late.txt"), data: "late" }),
			),
			inside: gate.promise.then(() =>
				mutateFile({ kind: "write", path: path.join(workspace, "late.txt"), data: "late" }),
			),
		}));
		gate.resolve();
		expect(isPermissionDeniedError(await failure(late.escape))).toBe(true);
		expect(await failure(late.inside)).toBeUndefined();
		expect(fs.existsSync(path.join(outside, "late.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(workspace, "late.txt"), "utf8")).toBe("late");
	});

	it("refuses the late file work of a call with a host of its own once the call returned", async () => {
		const anonymous = toolSession(null);
		const gate = Promise.withResolvers<void>();
		const late = await contained(async () => {
			// One call whose host started before it returned, one whose host never did.
			await mutateFile({ kind: "write", path: path.join(workspace, "early.txt"), data: "early" });
			// Wrapped: a returned promise would be awaited by the call itself.
			return {
				work: gate.promise.then(() =>
					mutateFile({ kind: "write", path: path.join(workspace, "started.txt"), data: "late" }),
				),
			};
		}, anonymous);
		const unstarted = await contained(
			async () => ({
				work: gate.promise.then(() =>
					mutateFile({ kind: "write", path: path.join(workspace, "unstarted.txt"), data: "late" }),
				),
			}),
			anonymous,
		);
		gate.resolve();
		expect(await failure(late.work)).toBeInstanceOf(Error);
		expect(await failure(unstarted.work)).toBeInstanceOf(Error);
		expect(fs.readFileSync(path.join(workspace, "early.txt"), "utf8")).toBe("early");
		expect(fs.existsSync(path.join(workspace, "started.txt"))).toBe(false);
		expect(fs.existsSync(path.join(workspace, "unstarted.txt"))).toBe(false);
	});
});
