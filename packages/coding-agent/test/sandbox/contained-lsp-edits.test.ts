/**
 * Language-server edits under the OS sandbox: a workspace edit's writes, creates, moves and deletes
 * run in a contained host, so the container refuses one that omp's path check never saw (a
 * symlink inside the workspace leading outside), while an edit inside the workspace applies. The
 * contained cases skip where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { applyEditsThenRename, applyWorkspaceEdit } from "@oh-my-pi/pi-coding-agent/lsp/edits";
import type { TextEdit, WorkspaceEdit } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { containedFileAccess, withContainedFileAccess } from "@oh-my-pi/pi-coding-agent/sandbox/file-access";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxEnabled, cfgSandboxNetworkMode } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isPermissionDeniedError } from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { CONTAINED_SOURCE_RUNS } from "../helpers/sandbox-test-state";
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
let sessionKey: string;
let sessionCounter = 0;

function toolSession(): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => sessionKey,
		getArtifactsDir: () => path.join(workspace, ".artifacts"),
		settings: Settings.isolated({ "lsp.enabled": false }),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

/** Runs `fn` as a contained lsp tool call would, failing if nothing is contained. */
function contained<T>(fn: () => Promise<T>): Promise<T> {
	return withContainedFileAccess(toolSession(), () => {
		if (!containedFileAccess()) throw new Error("expected the call's file access to be contained");
		return fn();
	});
}

/** The rejection of `promise`, settled before any `expect`. */
function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

function replaceFirstWord(newText: string): TextEdit[] {
	return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText }];
}

beforeEach(async () => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	// Not under the OS temp dir: on Linux the sandbox hides the host's /tmp, so `outside` would be
	// invisible to contained processes rather than read-only.
	scratch = TempDir.createSync(path.join(os.homedir(), ".omp-contained-lsp-"));
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	const tmp = path.join(root, "tmp");
	for (const dir of [workspace, outside, tmp]) fs.mkdirSync(dir);
	// The sandbox always grants tmpdir; keep it away from the workspace and `outside`.
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	settings = await Settings.init({ inMemory: true, cwd: workspace });
	cfgSandboxNetworkMode.set(settings, "deny");
	sessionKey = `contained-lsp-test-${++sessionCounter}`;
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

describe("workspace edits without the sandbox", () => {
	it("apply in-process when nothing is contained", async () => {
		const target = path.join(workspace, "plain.txt");
		fs.writeFileSync(target, "old text\n");
		expect(containedFileAccess()).toBeUndefined();
		const edit: WorkspaceEdit = { changes: { [fileToUri(target)]: replaceFirstWord("new") } };
		await applyWorkspaceEdit(edit, workspace);
		expect(fs.readFileSync(target, "utf8")).toBe("new text\n");
	});
});

describe.skipIf(!supported || !CONTAINED_SOURCE_RUNS)("workspace edits in the sandbox", () => {
	beforeEach(() => {
		cfgSandboxEnabled.set(settings, true);
	});

	it("applies edits, creates, renames and deletes inside the workspace", async () => {
		const edited = path.join(workspace, "edited.txt");
		const renamedFrom = path.join(workspace, "from.txt");
		const renamedTo = path.join(workspace, "sub", "to.txt");
		const created = path.join(workspace, "made", "new.txt");
		const doomed = path.join(workspace, "doomed.txt");
		const displaced = path.join(workspace, "overwritten.txt");
		fs.writeFileSync(edited, "old text\n");
		fs.writeFileSync(renamedFrom, "moved\n");
		fs.writeFileSync(doomed, "gone\n");
		fs.writeFileSync(displaced, "replaced\n");
		const edit: WorkspaceEdit = {
			documentChanges: [
				{ textDocument: { uri: fileToUri(edited), version: null }, edits: replaceFirstWord("new") },
				{ kind: "create", uri: fileToUri(created) },
				{ kind: "rename", oldUri: fileToUri(renamedFrom), newUri: fileToUri(renamedTo) },
				{
					kind: "rename",
					oldUri: fileToUri(renamedTo),
					newUri: fileToUri(displaced),
					options: { overwrite: true },
				},
				{ kind: "delete", uri: fileToUri(doomed) },
			],
		};
		const result = await contained(() => applyWorkspaceEdit(edit, workspace));
		expect(result.executed.map(change => change.kind).sort()).toEqual([
			"create",
			"delete",
			"edit",
			"rename",
			"rename",
		]);
		expect(fs.readFileSync(edited, "utf8")).toBe("new text\n");
		expect(fs.readFileSync(created, "utf8")).toBe("");
		expect(fs.readFileSync(displaced, "utf8")).toBe("moved\n");
		expect([fs.existsSync(renamedFrom), fs.existsSync(renamedTo), fs.existsSync(doomed)]).toEqual([
			false,
			false,
			false,
		]);
		// No displaced-destination directory is left behind.
		expect(fs.readdirSync(workspace).filter(name => name.startsWith(".omp-displaced-"))).toEqual([]);
	});

	it("refuses an edit to a file reached through a workspace symlink that leads outside", async () => {
		const victim = path.join(outside, "victim.txt");
		fs.writeFileSync(victim, "old text\n");
		fs.symlinkSync(outside, path.join(workspace, "link"));
		const edit: WorkspaceEdit = {
			changes: { [fileToUri(path.join(workspace, "link", "victim.txt"))]: replaceFirstWord("new") },
		};
		// Called on the edit applier directly, so omp's path check never runs: the container must refuse it.
		expect(isPermissionDeniedError(await failure(contained(() => applyWorkspaceEdit(edit, workspace))))).toBe(true);
		expect(fs.readFileSync(victim, "utf8")).toBe("old text\n");
	});

	it("refuses creating, moving and deleting through a symlink that leads outside", async () => {
		const victim = path.join(outside, "victim.txt");
		fs.writeFileSync(victim, "keep\n");
		const mine = path.join(workspace, "mine.txt");
		fs.writeFileSync(mine, "mine\n");
		fs.symlinkSync(outside, path.join(workspace, "link"));
		const through = (name: string) => fileToUri(path.join(workspace, "link", name));
		const attempts: WorkspaceEdit[] = [
			{ documentChanges: [{ kind: "create", uri: through("created.txt") }] },
			{ documentChanges: [{ kind: "rename", oldUri: fileToUri(mine), newUri: through("moved.txt") }] },
			{
				documentChanges: [
					{ kind: "rename", oldUri: through("victim.txt"), newUri: fileToUri(path.join(workspace, "taken.txt")) },
				],
			},
			{ documentChanges: [{ kind: "delete", uri: through("victim.txt") }] },
		];
		// The refusal's errno varies by backend (EACCES/EPERM, EROFS on a read-only mount, EXDEV for a
		// move across one); what matters is that it fails and `outside` stays as it was.
		for (const attempt of attempts) {
			expect(await failure(contained(() => applyWorkspaceEdit(attempt, workspace)))).toBeInstanceOf(Error);
		}
		expect(fs.readdirSync(outside)).toEqual(["victim.txt"]);
		expect(fs.readFileSync(victim, "utf8")).toBe("keep\n");
		expect(fs.readFileSync(mine, "utf8")).toBe("mine\n");
		expect(fs.existsSync(path.join(workspace, "taken.txt"))).toBe(false);
	});

	it("rolls a rename's reference edits back when the move is refused", async () => {
		const reference = path.join(workspace, "reference.txt");
		const source = path.join(workspace, "source.txt");
		fs.writeFileSync(reference, "old text\n");
		fs.writeFileSync(source, "source\n");
		fs.symlinkSync(outside, path.join(workspace, "link"));
		const dest = path.join(workspace, "link", "dest.txt");
		const error = await failure(
			contained(() => applyEditsThenRename([{ filePath: reference, edits: replaceFirstWord("new") }], source, dest)),
		);
		expect(error).toBeInstanceOf(Error);
		expect(fs.readFileSync(reference, "utf8")).toBe("old text\n");
		expect(fs.readFileSync(source, "utf8")).toBe("source\n");
		expect(fs.readdirSync(outside)).toEqual([]);
	});
});
