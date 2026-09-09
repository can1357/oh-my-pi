import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, type EditToolDetails, getEditStore } from "@oh-my-pi/pi-coding-agent/edit";
import type { EditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeSession(cwd: string, settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		settings: Settings.isolated(settings),
	} as unknown as ToolSession;
}

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-tool-details-"));
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

describe("EditTool details", () => {
	test("apply_patch reports complete per-file update, move, and create details", async () => {
		await Bun.write(path.join(tempDir, "update.txt"), "old\n");
		await Bun.write(path.join(tempDir, "move.txt"), "move me\n");
		const input = [
			"*** Begin Patch",
			"*** Update File: update.txt",
			"@@",
			"-old",
			"+new",
			"*** Update File: move.txt",
			"*** Move to: moved.txt",
			"@@",
			"-move me",
			"+moved",
			"*** Add File: created.txt",
			"+created",
			"*** End Patch",
			"",
		].join("\n");

		const result = await new EditTool(makeSession(tempDir), "apply_patch").execute("apply-details", { input });
		expect(result.isError).not.toBe(true);
		const details = result.details as EditToolDetails;
		expect(details.perFileResults).toHaveLength(3);
		expect(details.perFileResults?.[0]).toMatchObject({
			path: path.join(tempDir, "update.txt"),
			firstChangedLine: 1,
			op: "update",
			oldText: "old\n",
			newText: "new\n",
		});
		expect(details.perFileResults?.[0]?.diff).toContain("+1|new");
		expect(details.perFileResults?.[1]).toMatchObject({
			path: path.join(tempDir, "moved.txt"),
			firstChangedLine: 1,
			op: "update",
			move: path.join(tempDir, "moved.txt"),
			oldText: "move me\n",
			newText: "moved\n",
		});
		expect(details.perFileResults?.[1]?.diff).toContain("+1|moved");
		expect(details.perFileResults?.[2]).toMatchObject({
			path: path.join(tempDir, "created.txt"),
			firstChangedLine: 1,
			op: "create",
			newText: "created\n",
		});
		expect(details.perFileResults?.[2]?.oldText).toBeUndefined();
	});

	test("hashline reports one structured result per edited file", async () => {
		const session = makeSession(tempDir);
		const sections: string[] = [];
		for (const [name, before, after] of [
			["a.ts", "a\n", "A"],
			["b.ts", "b\n", "B"],
		] as const) {
			const absolute = path.join(tempDir, name);
			await Bun.write(absolute, before);
			const tag = getEditStore(session).recordSnapshot(absolute, before);
			sections.push(`[${name}#${tag}]`, "PUT 1-1:", `+${after}`);
		}

		const result = await new EditTool(session, "hashline").execute("hashline-details", {
			input: sections.join("\n"),
		});
		expect(result.isError).not.toBe(true);
		const details = result.details as EditToolDetails;
		expect(details.perFileResults).toHaveLength(2);
		expect(details.perFileResults?.[0]).toMatchObject({
			path: path.join(tempDir, "a.ts"),
			firstChangedLine: 1,
			op: "update",
			oldText: "a\n",
			newText: "A\n",
		});
		expect(details.perFileResults?.[0]?.diff).toContain("+1|A");
		expect(details.perFileResults?.[1]).toMatchObject({
			path: path.join(tempDir, "b.ts"),
			firstChangedLine: 1,
			op: "update",
			oldText: "b\n",
			newText: "B\n",
		});
		expect(details.perFileResults?.[1]?.diff).toContain("+1|B");
	});

	test("preserves diff metadata while native snapshot pruning removes oversized texts", async () => {
		const before = `${"line\n".repeat(9_000)}old\n`;
		await Bun.write(path.join(tempDir, "large.txt"), before);

		const result = await new EditTool(makeSession(tempDir), "patch").execute("pruned-details", {
			path: "large.txt",
			edits: [{ op: "update", diff: "@@\n-old\n+new" }],
		});
		expect(result.isError).not.toBe(true);
		const details = result.details as EditToolDetails;
		expect(details.path).toBe(path.join(tempDir, "large.txt"));
		expect(details.diff).toContain("+9001|new");
		expect(details.firstChangedLine).toBe(9_001);
		expect(details.snapshotsPruned).toBe(true);
		expect(details.oldText).toBeUndefined();
		expect(details.newText).toBeUndefined();
	});

	test("promotes patch matching warnings into diagnostics metadata", async () => {
		await Bun.write(path.join(tempDir, "warning.ts"), "function greet() {\n  return 'hello';\n}\n");
		const session = makeSession(tempDir, { "edit.fuzzyMatch": true });
		const result = await new EditTool(session, "patch").execute("warning-details", {
			path: "warning.ts",
			edits: [
				{
					op: "update",
					diff: "@@\n function greet() {\n-  return 'hell0';\n+  return 'bye';\n }",
				},
			],
		});
		expect(result.isError).not.toBe(true);
		const details = result.details as EditToolDetails;
		expect(details.diagnostics).toMatchObject({ server: "patch", summary: "Patch warnings: 1", errored: false });
		expect(details.diagnostics?.messages).toHaveLength(1);
		expect(details.diagnostics?.messages[0]).toMatch(/^patch: Inexact match in warning\.ts near line 1:/);
		expect(details.meta).toBeDefined();
	});
});

const inspectionCases: Array<{
	mode: EditMode;
	args: unknown;
	path: string;
	digest: string;
}> = [
	{
		mode: "replace",
		args: { path: "replace.ts", old_string: "old", new_string: "replacement" },
		path: "replace.ts",
		digest: "replacement",
	},
	{
		mode: "patch",
		args: { path: "patch.ts", edits: [{ op: "update", diff: "@@\n-old\n+patched" }] },
		path: "patch.ts",
		digest: "patched",
	},
	{
		mode: "apply_patch",
		args: {
			input: "*** Begin Patch\n*** Update File: apply.ts\n@@\n-old\n+applied\n*** End Patch\n",
		},
		path: "apply.ts",
		digest: "applied",
	},
	{
		mode: "hashline",
		args: { input: "[hash.ts#ABCD]\nPUT 1-1:\n+hashed\n" },
		path: "hash.ts",
		digest: "hashed",
	},
	{
		mode: "sloppy",
		args: {
			input: [
				'<SM:EDIT path="sloppy.ts">',
				"<SM:FIND>",
				"old",
				"</SM:FIND>",
				"<SM:PUT>",
				"sloppy",
				"</SM:PUT>",
				"</SM:EDIT>",
			].join("\n"),
		},
		path: "sloppy.ts",
		digest: "«\nold\n»\nsloppy",
	},
];

describe("EditTool native inspection proxy", () => {
	test.each(inspectionCases)(
		"$mode exposes matcher digest, paths, and entries",
		({ mode, args, path: target, digest }) => {
			const tool = new EditTool(makeSession(tempDir), mode);
			expect(tool.matcherDigest(args)).toBe(digest);
			expect(tool.matcherPaths(args)).toEqual([target]);
			expect(tool.matcherEntries(args)).toEqual([{ path: target, digest }]);
		},
	);
});
