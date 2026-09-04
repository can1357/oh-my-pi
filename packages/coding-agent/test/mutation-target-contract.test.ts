/**
 * The mutation-target contract a policy gate consumes: `plannedMutationPaths`
 * on a tool_call event and `changedPaths` on a tool_result's details. Each test
 * observes the contract through the surface the gate reads, never through an
 * internal helper.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { normalizeToolEventInputForTool } from "@oh-my-pi/pi-coding-agent/extensibility/tool-event-input";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import { applyWorkspaceEdit } from "@oh-my-pi/pi-coding-agent/lsp/edits";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/** A resolve dispatch's result nests the applied tool's own details. */
const resolveResult = type({
	details: { "sourceResultDetails?": { "applied?": "boolean", "changedPaths?": "string[]" } },
});

function makeSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		settings: Settings.isolated(),
		...overrides,
	};
}

let tempDir: string;

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mutation-contract-"));
});

afterEach(async () => {
	await removeWithRetries(tempDir);
});

describe("tool_call plannedMutationPaths", () => {
	it("reports both sides of an apply-patch move", () => {
		const tool = new EditTool(makeSession(tempDir), "apply_patch");
		const input = [
			"*** Begin Patch",
			"*** Update File: src/old.ts",
			"*** Move to: src/new.ts",
			"@@",
			"-const a = 1;",
			"+const a = 2;",
			"*** End Patch",
			"",
		].join("\n");

		const event = normalizeToolEventInputForTool(tool, { input }, tempDir);

		expect(event.plannedMutationPaths).toEqual([path.join(tempDir, "src/old.ts"), path.join(tempDir, "src/new.ts")]);
	});

	it("normalizes a bracketed hashline header to an absolute target", () => {
		const tool = new EditTool(makeSession(tempDir), "hashline");
		const input = "[packages/app/src/thing.ts#A1B2]\nPUT 3.=3:\n+const x = 2;\n";

		const event = normalizeToolEventInputForTool(tool, { input }, tempDir);

		expect(event.plannedMutationPaths).toEqual([path.join(tempDir, "packages/app/src/thing.ts")]);
	});

	it("omits the projection for a device write, which names no file", () => {
		const event = normalizeToolEventInputForTool(
			new WriteTool(makeSession(tempDir)),
			{ path: "xd://resolve", content: "apply the staged proposal" },
			tempDir,
		);

		// An empty list would claim the call writes nothing and stand down the
		// gate's own bookkeeping for the staged proposal this write applies.
		expect(event.plannedMutationPaths).toBeUndefined();
	});

	it("reports both sides of an lsp rename_file before it runs", () => {
		const event = normalizeToolEventInputForTool(
			new LspTool(makeSession(tempDir)),
			{ action: "rename_file", file: "src/old.ts", new_name: "src/new.ts" },
			tempDir,
		);

		expect(event.plannedMutationPaths).toEqual([path.join(tempDir, "src/old.ts"), path.join(tempDir, "src/new.ts")]);
	});

	it("omits the projection for a read-only lsp action", () => {
		const event = normalizeToolEventInputForTool(
			new LspTool(makeSession(tempDir)),
			{ action: "diagnostics", file: "packages/app/test/thing.test.ts" },
			tempDir,
		);

		// Naming a target here would make a gate treat reading diagnostics on a
		// test file as a mutation of it.
		expect(event.plannedMutationPaths).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")("projects the drive-letter target the write then creates", async () => {
		const input = { path: "C:/tmp/x.ts", content: "drive\n" };
		const tool = new WriteTool(makeSession(tempDir));

		const event = normalizeToolEventInputForTool(tool, input, tempDir);
		const result = await tool.execute("drive", input);

		// A `path.win32` branch taken off Windows projected `C:/tmp/x.ts`
		// verbatim: not absolute, and not the file the write goes on to create,
		// so a gate matching absolute rules sees neither.
		const written = path.join(tempDir, "C:", "tmp", "x.ts");
		expect(event.plannedMutationPaths).toEqual([written]);
		expect(result.details?.changedPaths).toEqual([written]);
	});
});

describe("tool_result changedPaths", () => {
	it("reports every file a multi-file edit wrote", async () => {
		await Bun.write(path.join(tempDir, "one.txt"), "one\n");
		await Bun.write(path.join(tempDir, "two.txt"), "two\n");
		const input = [
			"*** Begin Patch",
			"*** Update File: one.txt",
			"@@",
			"-one",
			"+uno",
			"*** Update File: two.txt",
			"@@",
			"-two",
			"+dos",
			"*** End Patch",
			"",
		].join("\n");

		const result = await new EditTool(makeSession(tempDir), "apply_patch").execute("multi", { input });

		expect(result.isError).not.toBe(true);
		expect(result.details?.changedPaths).toEqual([path.join(tempDir, "one.txt"), path.join(tempDir, "two.txt")]);
	});

	it("reports the source and destination of an apply-patch move", async () => {
		await Bun.write(path.join(tempDir, "move.txt"), "move me\n");
		const input = [
			"*** Begin Patch",
			"*** Update File: move.txt",
			"*** Move to: moved.txt",
			"@@",
			"-move me",
			"+moved",
			"*** End Patch",
			"",
		].join("\n");

		const result = await new EditTool(makeSession(tempDir), "apply_patch").execute("move", { input });

		expect(result.isError).not.toBe(true);
		expect(result.details?.changedPaths).toEqual([path.join(tempDir, "move.txt"), path.join(tempDir, "moved.txt")]);
	});

	it("reports the path of a write whose content is unchanged", async () => {
		const target = path.join(tempDir, "same.txt");
		const content = "identical\n";
		await Bun.write(target, content);

		const result = await new WriteTool(makeSession(tempDir)).execute("same", { path: target, content });

		expect(result.details?.changedPaths).toEqual([target]);
	});

	it.skipIf(process.platform === "win32")(
		"reports the single file a backslash-bearing relative path writes",
		async () => {
			// POSIX has no separator here: `a\b.txt` is one filename. Reporting
			// `<cwd>/a/b.txt` names a file the write never touched and leaves the
			// one it did touch unnamed.
			const result = await new WriteTool(makeSession(tempDir)).execute("backslash", {
				path: "a\\b.txt",
				content: "backslash\n",
			});

			expect(result.details?.changedPaths).toEqual([path.join(tempDir, "a\\b.txt")]);
			expect(await Bun.file(path.join(tempDir, "a\\b.txt")).exists()).toBe(true);
			expect(await Bun.file(path.join(tempDir, "a", "b.txt")).exists()).toBe(false);
		},
	);

	it("separates ast_edit candidates from the files its apply pass wrote", async () => {
		const target = path.join(tempDir, "legacy.ts");
		await Bun.write(target, "legacyWrap(x, value)\n");
		await Bun.write(path.join(tempDir, "other.ts"), "const y = 1;\n");
		const queue = new ToolChoiceQueue();
		const session = makeSession(tempDir, {
			getToolChoiceQueue: () => queue,
			buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
			steer: () => {},
		});

		const staged = await new AstEditTool(session).execute("stage", {
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: [tempDir],
		});

		// Staging writes nothing: the candidates are planned, not changed.
		expect(staged.details?.applied).toBe(false);
		expect(staged.details?.changedPaths).toBeUndefined();
		expect(staged.details?.plannedMutationPaths).toEqual([target]);

		const applied = await queue.peekPendingInvoker()!({ action: "apply", reason: "apply the staged rewrite" });
		const report = resolveResult.assert(applied).details.sourceResultDetails;

		expect(report?.applied).toBe(true);
		expect(report?.changedPaths).toEqual([target]);
	});

	it("reports both sides of an lsp rename_file", async () => {
		const source = path.join(tempDir, "notes.txt");
		const dest = path.join(tempDir, "renamed.txt");
		await Bun.write(source, "notes\n");

		const result = await new LspTool(makeSession(tempDir)).execute("rename", {
			action: "rename_file",
			file: source,
			new_name: dest,
		});

		expect(result.details?.success).toBe(true);
		expect(result.details?.changedPaths).toEqual([source, dest]);
	});

	it("reports import-rewritten files alongside a renamed file", async () => {
		const source = path.join(tempDir, "moved.ts");
		const dest = path.join(tempDir, "renamed.ts");
		const reference = path.join(tempDir, "ref.ts");
		await Bun.write(source, "export const x = 1;\n");
		await Bun.write(reference, 'import { x } from "./moved";\n');

		const result = await applyWorkspaceEdit(
			{
				documentChanges: [
					{
						textDocument: { uri: fileToUri(reference), version: null },
						edits: [
							{
								range: { start: { line: 0, character: 19 }, end: { line: 0, character: 26 } },
								newText: "./renamed",
							},
						],
					},
					{ kind: "rename", oldUri: fileToUri(source), newUri: fileToUri(dest) },
				],
			},
			tempDir,
		);

		// Membership, not order: the planner runs resource ops before trailing
		// text edits, and a gate only cares which files the edit touched.
		expect([...result.changedPaths].sort()).toEqual([dest, reference, source].sort());
		expect(await Bun.file(reference).text()).toBe('import { x } from "./renamed";\n');
	});
});
