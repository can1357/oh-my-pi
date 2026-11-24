import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyEditsThenRename,
	applyWorkspaceEdit,
	type WorkspaceFileChange,
} from "@oh-my-pi/pi-coding-agent/lsp/edits";
import type { TextEdit, WorkspaceEdit } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/uri";

// Rewrite `./moved` → `./renamed` on line 0 of the reference file below.
const importEdit: TextEdit[] = [
	{ range: { start: { line: 0, character: 19 }, end: { line: 0, character: 26 } }, newText: "./renamed" },
];

describe("applyEditsThenRename", () => {
	let dir: string;
	let source: string;
	let ref: string;
	const refBefore = 'import { x } from "./moved";\n';

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "edits-rename-"));
		source = path.join(dir, "moved.ts");
		ref = path.join(dir, "ref.ts");
		await Bun.write(source, "export const x = 1;\n");
		await Bun.write(ref, refBefore);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("applies reference edits and moves the source when the move succeeds", async () => {
		const dest = path.join(dir, "nested", "renamed.ts");
		const recorded: WorkspaceFileChange[] = [];
		await applyEditsThenRename(
			[{ filePath: ref, edits: importEdit }],
			source,
			dest,
			[{ from: source, to: dest }],
			change => recorded.push(change),
		);

		expect(await Bun.file(dest).text()).toBe("export const x = 1;\n");
		expect(await Bun.file(source).exists()).toBe(false);
		expect(await Bun.file(ref).text()).toBe('import { x } from "./renamed";\n');
		const real = await fs.realpath(dir);
		expect(recorded).toEqual([
			{
				path: path.join(real, "ref.ts"),
				before: refBefore,
				after: 'import { x } from "./renamed";\n',
			},
			{ path: path.join(real, "moved.ts"), before: "export const x = 1;\n", after: null },
			{ path: path.join(real, "nested", "renamed.ts"), before: null, after: "export const x = 1;\n" },
		]);
	});

	it("rolls back reference edits when the move fails", async () => {
		// A regular file stands where a dest-parent directory must be, so the
		// recursive mkdir throws ENOTDIR before the rename runs.
		const blocker = path.join(dir, "blocker");
		await Bun.write(blocker, "not a dir");
		const dest = path.join(blocker, "sub", "renamed.ts");
		await Bun.write(ref, `\uFEFF${refBefore}`);
		const recorded: WorkspaceFileChange[] = [];

		await expect(
			applyEditsThenRename(
				[{ filePath: ref, edits: importEdit }],
				source,
				dest,
				[{ from: source, to: dest }],
				change => recorded.push(change),
			),
		).rejects.toThrow();

		// Failed move must leave source, destination, and reference files untouched.
		expect(await fs.readFile(ref, "utf8")).toBe(`\uFEFF${refBefore}`);
		expect(await Bun.file(source).exists()).toBe(true);
		expect(await Bun.file(dest).exists()).toBe(false);
		expect(recorded).toEqual([]);
	});
});

describe("workspace edit recorder", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "edits-journal-")));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it.each(["changes", "documentChanges"] as const)(
		"reports each file's disk before/after text once to the recorder for %s",
		async format => {
			const first = path.join(dir, "first.ts");
			const second = path.join(dir, "second.ts");
			await Bun.write(first, "const oldName = oldName;\n");
			await Bun.write(second, "oldName();\n");
			const before = await Promise.all([Bun.file(first).text(), Bun.file(second).text()]);
			const replace = (start: number): TextEdit => ({
				range: { start: { line: 0, character: start }, end: { line: 0, character: start + 7 } },
				newText: "newName",
			});
			const changes = {
				[fileToUri(first)]: [replace(6), replace(16)],
				[fileToUri(second)]: [replace(0)],
			};
			const edit: WorkspaceEdit =
				format === "changes"
					? { changes }
					: {
							documentChanges: Object.entries(changes).map(([uri, edits]) => ({
								textDocument: { uri, version: null },
								edits,
							})),
						};
			const recorded: WorkspaceFileChange[] = [];

			await applyWorkspaceEdit(edit, dir, undefined, change => recorded.push(change));

			expect(await Bun.file(first).text()).toBe("const newName = newName;\n");
			expect(await Bun.file(second).text()).toBe("newName();\n");
			expect(recorded).toEqual([
				{ path: first, before: before[0], after: await Bun.file(first).text() },
				{ path: second, before: before[1], after: await Bun.file(second).text() },
			]);
		},
	);

	it.each(["changes", "documentChanges"] as const)(
		"attributes symlink text edits to the written target outside cwd for %s",
		async format => {
			const workspace = path.join(dir, "workspace");
			const target = path.join(dir, "target.ts");
			const link = path.join(workspace, "link.ts");
			const before = "const oldName = 1;\n";
			await Bun.write(target, before);
			await fs.mkdir(workspace);
			await fs.symlink("../target.ts", link);
			const edits: TextEdit[] = [
				{
					range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
					newText: "newName",
				},
			];
			const uri = fileToUri(link);
			const edit: WorkspaceEdit =
				format === "changes"
					? { changes: { [uri]: edits } }
					: { documentChanges: [{ textDocument: { uri, version: null }, edits }] };
			const recorded: WorkspaceFileChange[] = [];

			await applyWorkspaceEdit(edit, workspace, undefined, change => recorded.push(change));

			expect(await fs.readFile(target, "utf8")).toBe("const newName = 1;\n");
			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			expect(path.resolve(workspace, await fs.readlink(link))).toBe(target);
			expect(recorded).toEqual([{ path: target, before, after: "const newName = 1;\n" }]);
		},
	);

	it.each(["changes", "documentChanges"] as const)(
		"records the on-disk BOM before text edits and the BOM-free bytes written for %s",
		async format => {
			const file = path.join(dir, "bom.ts");
			const before = "\uFEFFconst oldName = 1;\n";
			await Bun.write(file, before);
			const edits: TextEdit[] = [
				{
					range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
					newText: "newName",
				},
			];
			const uri = fileToUri(file);
			const edit: WorkspaceEdit =
				format === "changes"
					? { changes: { [uri]: edits } }
					: { documentChanges: [{ textDocument: { uri, version: null }, edits }] };
			const recorded: WorkspaceFileChange[] = [];

			await applyWorkspaceEdit(edit, dir, undefined, change => recorded.push(change));

			expect(await fs.readFile(file, "utf8")).toBe("const newName = 1;\n");
			expect(recorded).toEqual([{ path: file, before, after: await fs.readFile(file, "utf8") }]);
		},
	);

	it("leaves creates, overwrites, folder moves and recursive deletes unjournaled", async () => {
		const created = path.join(dir, "created.ts");
		const overwritten = path.join(dir, "overwritten.ts");
		const source = path.join(dir, "source", "child.ts");
		const destination = path.join(dir, "destination", "child.ts");
		const displaced = path.join(dir, "destination", "displaced.ts");
		const deleted = path.join(dir, "deleted", "nested", "child.ts");
		await Bun.write(overwritten, "overwrite me\n");
		await Bun.write(source, "move me\n");
		await Bun.write(destination, "old destination\n");
		await Bun.write(displaced, "remove me\n");
		await Bun.write(deleted, "delete me\n");
		const recorded: WorkspaceFileChange[] = [];

		await applyWorkspaceEdit(
			{
				documentChanges: [
					{ kind: "create", uri: fileToUri(created) },
					{ kind: "create", uri: fileToUri(overwritten), options: { overwrite: true } },
					{
						kind: "rename",
						oldUri: fileToUri(path.dirname(source)),
						newUri: fileToUri(path.dirname(destination)),
						options: { overwrite: true },
					},
					{ kind: "delete", uri: fileToUri(path.join(dir, "deleted")), options: { recursive: true } },
				],
			},
			dir,
			undefined,
			change => recorded.push(change),
		);

		expect(await Bun.file(created).text()).toBe("");
		expect(await Bun.file(overwritten).text()).toBe("");
		expect(await Bun.file(source).exists()).toBe(false);
		expect(await Bun.file(destination).text()).toBe("move me\n");
		expect(await Bun.file(displaced).exists()).toBe(false);
		expect(await Bun.file(deleted).exists()).toBe(false);
		expect(recorded).toEqual([]);
	});

	it("keeps the executed prefix in the recorder but omits skipped and failed operations", async () => {
		const edited = path.join(dir, "nonempty", "source.ts");
		const target = path.join(dir, "target.ts");
		const child = path.join(dir, "nonempty", "child.ts");
		await Bun.write(edited, "oldName\n");
		await Bun.write(target, "keep target\n");
		await Bun.write(child, "keep child\n");
		const recorded: WorkspaceFileChange[] = [];

		await expect(
			applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "create", uri: fileToUri(edited), options: { ignoreIfExists: true } },
						{
							kind: "rename",
							oldUri: fileToUri(edited),
							newUri: fileToUri(target),
							options: { ignoreIfExists: true },
						},
						{
							kind: "delete",
							uri: fileToUri(path.join(dir, "missing.ts")),
							options: { ignoreIfNotExists: true },
						},
						{
							textDocument: { uri: fileToUri(edited), version: null },
							edits: [
								{
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
									newText: "newName",
								},
							],
						},
						{ kind: "delete", uri: fileToUri(path.dirname(child)) },
					],
				},
				dir,
				undefined,
				change => recorded.push(change),
			),
		).rejects.toThrow();

		expect(await Bun.file(edited).text()).toBe("newName\n");
		expect(await Bun.file(target).text()).toBe("keep target\n");
		expect(await Bun.file(child).text()).toBe("keep child\n");
		expect(recorded).toEqual([{ path: edited, before: "oldName\n", after: "newName\n" }]);
	});
});
