/**
 * Destructive file tools under the OS sandbox: their writes, deletes, AST rewrites and SQLite row
 * writes run in a contained host, so the container refuses one that omp's path check never saw (a
 * symlink, or a call that skipped the check). The contained cases skip where no backend exists.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import {
	containedFileMutations,
	mutateFile,
	withContainedFileMutations,
} from "@oh-my-pi/pi-coding-agent/sandbox/file-mutations";
import { SandboxRuntime, SandboxUnavailableError } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { sandboxHostPoolSize } from "@oh-my-pi/pi-coding-agent/sandbox/shell-client";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { deleteFileWithFallback, isPermissionDeniedError } from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { CONTAINED_SOURCE_RUNS, SANDBOX_UNAVAILABLE } from "../helpers/sandbox-test-state";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";

const supported =
	typeof natives.sandboxSupport === "function" &&
	typeof natives.SandboxProcess === "function" &&
	natives.sandboxSupport().supported;

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
/** `<scratch>/workspace`, realpath'd. */
let workspace: string;
/** `<scratch>/outside`: neither the workspace nor the (spied) tmpdir, so read-only when contained. */
let outside: string;
/** `<scratch>/artifacts`: the session's artifacts dir, whose `local` child is the `local://` root. */
let artifacts: string;
let sessionKey: string;
let sessionCounter = 0;

function toolSession(sessionId: string | null = sessionKey): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getArtifactsDir: () => artifacts,
		settings: Settings.isolated({ "lsp.enabled": false }),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

/** Runs `fn` as a contained tool call of `session` would, failing if nothing is contained. */
function contained<T>(fn: () => Promise<T>, session = toolSession()): Promise<T> {
	return withContainedFileMutations(session, () => {
		if (!containedFileMutations()) throw new Error("expected the call's mutations to be contained");
		return fn();
	});
}

/**
 * The rejection of `promise`, settled before any `expect`: `rejects` drains only microtasks, never
 * the host's reply I/O.
 */
function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

beforeEach(async () => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	// Not under the OS temp dir: on Linux the sandbox hides the host's /tmp, so `outside` would be
	// invisible to contained processes rather than read-only.
	scratch = TempDir.createSync(path.join(os.homedir(), ".omp-contained-mutations-"));
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	artifacts = path.join(root, "artifacts");
	const tmp = path.join(root, "tmp");
	for (const dir of [workspace, outside, artifacts, tmp]) fs.mkdirSync(dir);
	// The sandbox always grants tmpdir; keep it away from the workspace and `outside`.
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	settings = await Settings.init({ inMemory: true, cwd: workspace });
	cfgSandboxNetworkMode.set(settings, "deny");
	cfgSandboxEnabled.set(settings, true);
	sessionKey = `contained-mutations-test-${++sessionCounter}`;
	SandboxRuntime.resetForTest();
});

afterEach(async () => {
	try {
		releaseShellSessions(sessionKey);
		await (await SandboxRuntime.for(workspace)).dispose();
		SandboxRuntime.resetForTest();
	} finally {
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		scratch.removeSync();
	}
});

describe("destructive file tools without a sandbox backend", () => {
	it("refuses the call under `fallback: block` and runs it in-process under `warn`", async () => {
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
		SandboxRuntime.setWarningSink(() => {});
		cfgSandboxFallback.set(settings, "block");
		const run = vi.fn(async () => containedFileMutations());
		expect(await failure(withContainedFileMutations(toolSession(), run))).toBeInstanceOf(SandboxUnavailableError);
		expect(run).not.toHaveBeenCalled();
		cfgSandboxFallback.set(settings, "warn");
		expect(await withContainedFileMutations(toolSession(), run)).toBeUndefined();
		SandboxRuntime.setWarningSink(undefined);
	});
});

describe.skipIf(!supported || !CONTAINED_SOURCE_RUNS)("destructive file tools in the sandbox", () => {
	it("writes a workspace file through the session's contained host", async () => {
		const result = await new WriteTool(toolSession()).execute("call-inside", {
			path: "inside.txt",
			content: "kept\n",
		});
		expect(result.isError).toBeFalsy();
		expect(fs.readFileSync(path.join(workspace, "inside.txt"), "utf8")).toBe("kept\n");
		expect(sandboxHostPoolSize(`files:${sessionKey}`)).toBe(1);
	});

	it("refuses a write through a workspace symlink that leads outside", async () => {
		// Called on the tool directly, so omp's path check never runs: the container must refuse it.
		fs.symlinkSync(outside, path.join(workspace, "link"));
		const write = new WriteTool(toolSession()).execute("call-escape", { path: "link/escaped.txt", content: "x" });
		const error = await failure(write);
		expect(isPermissionDeniedError(error) || isPermissionDeniedError((error as Error | undefined)?.cause)).toBe(true);
		expect(fs.existsSync(path.join(outside, "escaped.txt"))).toBe(false);
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

	it("contains a session without an id in a host of the call's own", async () => {
		const anonymous = toolSession(null);
		await contained(
			() => mutateFile({ kind: "write", path: path.join(workspace, "anon.txt"), data: "x" }),
			anonymous,
		);
		expect(fs.readFileSync(path.join(workspace, "anon.txt"), "utf8")).toBe("x");
		expect(
			await failure(contained(() => deleteFileWithFallback(path.join(outside, "none")), anonymous)),
		).toBeDefined();
		expect(sandboxHostPoolSize("files:")).toBe(0);
		expect(sandboxHostPoolSize(undefined)).toBe(0);
	});

	it("applies an AST rewrite in the workspace and leaves a file outside unchanged", async () => {
		const inside = path.join(workspace, "a.ts");
		const beyond = path.join(outside, "b.ts");
		fs.writeFileSync(inside, "const value = oldName();\n");
		fs.writeFileSync(beyond, "const value = oldName();\n");
		const rewrite = { rewrites: { "oldName()": "newName()" }, lang: "typescript", dryRun: false };
		const applied = await contained(() => containedFileMutations()!.astEdit({ ...rewrite, path: inside }));
		expect(applied.totalReplacements).toBe(1);
		expect(fs.readFileSync(inside, "utf8")).toBe("const value = newName();\n");
		await failure(contained(() => containedFileMutations()!.astEdit({ ...rewrite, path: beyond })));
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
		expect(await contained(() => containedFileMutations()!.sqliteWrite({ ...row, dbPath: insideDb }))).toBe(
			"Inserted row into notes",
		);
		expect(
			await failure(contained(() => containedFileMutations()!.sqliteWrite({ ...row, dbPath: outsideDb }))),
		).toBeInstanceOf(Error);
		const count = (dbPath: string) => {
			const db = new Database(dbPath, { readonly: true });
			const rows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM notes").get()?.n;
			db.close();
			return rows;
		};
		expect([count(insideDb), count(outsideDb)]).toEqual([1, 0]);
	});
});
