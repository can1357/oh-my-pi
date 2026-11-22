/**
 * Language-server edits under the OS sandbox: a workspace edit's writes, creates, moves and deletes
 * run in a contained host, so the container refuses one that omp's path check never saw (a
 * symlink inside the workspace leading outside), while an edit inside the workspace applies. The
 * contained cases skip where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import { applyWorkspaceEdit } from "@oh-my-pi/pi-coding-agent/lsp/edits";
import type { LspClient, ServerConfig, TextEdit, WorkspaceEdit } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/uri";
import { containedFileAccess, withContainedFileAccess } from "@oh-my-pi/pi-coding-agent/sandbox/file-access";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	beginContainedSandboxTest,
	CONTAINED_SOURCE_RUNS,
	type ContainedSandboxTest,
	containedToolSession,
	endContainedSandboxTest,
	failure,
	SANDBOX_BACKEND_PRESENT,
} from "../helpers/sandbox-test-state";

let fixture: ContainedSandboxTest;
let workspace: string;
/** Neither the workspace nor the (spied) tmpdir, so read-only when contained. */
let outside: string;

function toolSession(): ToolSession {
	return containedToolSession(fixture);
}

/** Runs `fn` as a contained lsp tool call would, failing if nothing is contained. */
function contained<T>(fn: () => Promise<T>): Promise<T> {
	return withContainedFileAccess(toolSession(), () => {
		if (!containedFileAccess()) throw new Error("expected the call's file access to be contained");
		return fn();
	});
}

function replaceFirstWord(newText: string): TextEdit[] {
	return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText }];
}

beforeEach(async () => {
	fixture = await beginContainedSandboxTest("contained-lsp");
	({ workspace, outside } = fixture);
});

afterEach(() => endContainedSandboxTest(fixture));

describe.skipIf(!SANDBOX_BACKEND_PRESENT || !CONTAINED_SOURCE_RUNS)("workspace edits in the sandbox", () => {
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

	it("refuses editing, creating, moving and deleting through a symlink that leads outside", async () => {
		const victim = path.join(outside, "victim.txt");
		fs.writeFileSync(victim, "keep\n");
		const mine = path.join(workspace, "mine.txt");
		fs.writeFileSync(mine, "mine\n");
		fs.symlinkSync(outside, path.join(workspace, "link"));
		const through = (name: string) => fileToUri(path.join(workspace, "link", name));
		const attempts: WorkspaceEdit[] = [
			{ changes: { [through("victim.txt")]: replaceFirstWord("new") } },
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

	describe("rename_file reference edits", () => {
		/** A fake server whose `willRenameFiles` rewrites `inside` (writable) and then `outside`. */
		function serveRenameEdits(cwd: string, edited: string[]): void {
			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd,
				config: server,
				proc: { stdin: { write() {}, flush: async () => {} } } as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				publishedDiagnostics: new Map(),
				pulledDiagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue();
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method) => {
				if (method !== "workspace/willRenameFiles") return null;
				const edit = {
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
					newText: "new",
				};
				return { changes: Object.fromEntries(edited.map(file => [fileToUri(file), [edit]])) };
			});
		}

		async function renameWithOutsideReference(session: ToolSession): Promise<{
			error: unknown;
			inside: string;
			reference: string;
			source: string;
		}> {
			const inside = path.join(workspace, "inside.ts");
			const reference = path.join(outside, "reference.ts");
			const source = path.join(workspace, "old.ts");
			fs.writeFileSync(inside, "old text\n");
			fs.writeFileSync(reference, "old text\n");
			fs.writeFileSync(source, "export {};\n");
			// Accepted per URI in this order: the writable file first, the refused one after it.
			serveRenameEdits(workspace, [inside, reference]);
			const error = await failure(
				new LspTool(session).execute("rename-outside-reference", {
					action: "rename_file",
					file: source,
					new_name: path.join(workspace, "new.ts"),
					timeout: 5,
				}),
			);
			return { error, inside, reference, source };
		}

		it.each([
			{ name: "is not registered", active: false },
			{ name: "is registered", active: true },
		])(
			"refuses a reference file outside the writable roots before rewriting any file when sandbox_request $name",
			async ({ active }) => {
				const session = active
					? ({ ...toolSession(), isToolActive: (name: string) => name === "sandbox_request" } as ToolSession)
					: toolSession();
				const { error, inside, reference, source } = await renameWithOutsideReference(session);
				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				expect(message).toContain("writable roots");
				// An unregistered `sandbox_request` leaves the refusal telling the user instead.
				if (active) expect(message).toContain("sandbox_request");
				else {
					expect(message).not.toContain("sandbox_request");
					expect(message).toContain("tell the user");
				}
				expect(fs.readFileSync(inside, "utf8")).toBe("old text\n");
				expect(fs.readFileSync(reference, "utf8")).toBe("old text\n");
				expect(fs.existsSync(source)).toBe(true);
				expect(fs.existsSync(path.join(workspace, "new.ts"))).toBe(false);
			},
		);
	});
});
