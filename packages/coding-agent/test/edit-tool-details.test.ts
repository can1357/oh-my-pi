import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, getEditStore } from "@oh-my-pi/pi-coding-agent/edit";
import { type EditToolDetails } from "@oh-my-pi/pi-tui/tools/edit";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

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
	test("apply_patch keeps numeric prefixes in exact old and new lines", async () => {
		const target = path.join(tempDir, "states.txt");
		await Bun.write(target, "69 named states\n");
		const result = await new EditTool(makeSession(tempDir), "apply_patch").execute("numeric-prefix", {
			input: "*** Begin Patch\n*** Update File: states.txt\n@@\n-69 named states\n+79 named states\n*** End Patch",
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(target).text()).toBe("79 named states\n");
	});

	test("apply_patch moves a file before recreating its old path", async () => {
		await Bun.write(path.join(tempDir, "a.txt"), "old\n");
		const result = await new EditTool(makeSession(tempDir), "apply_patch").execute("move-add", {
			input: "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-old\n+moved\n*** Add File: a.txt\n+replacement\n*** End Patch",
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(path.join(tempDir, "a.txt")).text()).toBe("replacement\n");
		expect(await Bun.file(path.join(tempDir, "b.txt")).text()).toBe("moved\n");
	});

	test("apply_patch moves a file without hunks and preserves its bytes and mode", async () => {
		const source = path.join(tempDir, "source.sh");
		const destination = path.join(tempDir, "moved.sh");
		const before = "\uFEFF#!/bin/sh\r\nprintf 'alpha\\n'\r\n";
		await Bun.write(source, before);
		if (process.platform !== "win32") await fs.chmod(source, 0o750);
		const result = await new EditTool(makeSession(tempDir), "apply_patch").execute("move-only", {
			input: "*** Begin Patch\n*** Update File: source.sh\n*** Move to: moved.sh\n*** End Patch",
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(source).exists()).toBe(false);
		expect(await fs.readFile(destination)).toEqual(Buffer.from(before));
		if (process.platform !== "win32") expect((await fs.stat(destination)).mode & 0o777).toBe(0o750);
	});

	test("apply_patch deletes an import line including its newline", async () => {
		const target = path.join(tempDir, "imports.py");
		await Bun.write(target, "from x import (\n    A,\n    B,\n)\n");
		const result = await new EditTool(makeSession(tempDir), "apply_patch").execute("delete-line", {
			input: "*** Begin Patch\n*** Update File: imports.py\n@@\n-    A,\n*** End Patch",
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(target).text()).toBe("from x import (\n    B,\n)\n");
	});

	test("apply_patch rejects wrong old lines without changing any file", async () => {
		const before = '{\n    "sha": "0123456789abcdef0123456789abcdef01234567",\n    "ref": "refs/heads/main"\n}\n';
		await Bun.write(path.join(tempDir, "fixture.py"), before);
		await Bun.write(path.join(tempDir, "first.txt"), "before\n");
		const input = [
			"*** Begin Patch",
			"*** Update File: first.txt",
			"@@",
			"-before",
			"+after",
			"*** Update File: fixture.py",
			"@@",
			'-    sha="0123456789abcdef0123456789abcdef01234567",',
			'-    ref="refs/heads/main"',
			'+    sha="changed",',
			'+    ref="refs/heads/next"',
			"*** End Patch",
		].join("\n");
		const session = makeSession(tempDir, { "edit.fuzzyThreshold": 0.8 });
		const result = await new EditTool(session, "apply_patch").execute("wrong-context", { input });
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ diff: "", errorKind: "apply" });
		expect(await Bun.file(path.join(tempDir, "fixture.py")).text()).toBe(before);
		expect(await Bun.file(path.join(tempDir, "first.txt")).text()).toBe("before\n");
	});

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

	test("a refused edit carries the engine's error kind beside the message", async () => {
		const session = makeSession(tempDir);
		const absolute = path.join(tempDir, "a.ts");
		await Bun.write(absolute, "a\n");
		const tag = getEditStore(session).recordSnapshot(absolute, "a\n");
		await Bun.write(absolute, "changed\n");

		const result = await new EditTool(session, "hashline").execute("hashline-stale", {
			input: `[a.ts#${tag}]\nPUT 1-1:\n+A`,
		});
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ diff: "", errorKind: "stale_tag" });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("file changed between read and edit") });
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

describe.skipIf(process.platform === "win32")("EditTool move permissions", () => {
	test.each(["hashline", "patch", "apply_patch"] as const)(
		"%s keeps an edited script executable after moving it",
		async mode => {
			const source = path.join(tempDir, "run.sh");
			const destination = path.join(tempDir, "scripts", "renamed.sh");
			await Bun.write(source, "#!/bin/sh\nprintf 'before\\n'\n");
			await fs.chmod(source, 0o750);
			const session = makeSession(tempDir);
			const read = await new ReadTool(session).execute("read-script", { path: "run.sh" });
			const header = read.content.find(c => c.type === "text")?.text.split("\n")[0];
			const params =
				mode === "patch"
					? {
							path: "run.sh",
							edits: [
								{
									op: "update" as const,
									rename: "scripts/renamed.sh",
									diff: "@@\n-printf 'before\\n'\n+printf 'after\\n'",
								},
							],
						}
					: {
							input:
								mode === "hashline"
									? `${header}\nPUT 2.=2:\n+printf 'after\\n'\nMV scripts/renamed.sh`
									: "*** Begin Patch\n*** Update File: run.sh\n*** Move to: scripts/renamed.sh\n@@\n-printf 'before\\n'\n+printf 'after\\n'\n*** End Patch",
						};

			const result = await new EditTool(session, mode).execute("move-script", params);
			expect(result.isError).not.toBe(true);
			expect(await Bun.file(source).exists()).toBe(false);
			expect(await Bun.file(destination).text()).toBe("#!/bin/sh\nprintf 'after\\n'\n");
			expect((await fs.stat(destination)).mode & 0o777).toBe(0o750);
			expect(await $`${destination}`.quiet().text()).toBe("after\n");
		},
	);

	test("hashline MV uses the source permissions when overwriting a destination", async () => {
		const source = path.join(tempDir, "run.sh");
		const destination = path.join(tempDir, "renamed.sh");
		await Bun.write(source, "#!/bin/sh\nprintf 'moved\\n'\n");
		await fs.chmod(source, 0o700);
		await Bun.write(destination, "replaced\n");
		await fs.chmod(destination, 0o644);
		const session = makeSession(tempDir);
		const read = await new ReadTool(session).execute("read-script", { path: "run.sh" });
		const header = read.content.find(c => c.type === "text")?.text.split("\n")[0];

		const result = await new EditTool(session, "hashline").execute("move-script", {
			input: `${header}\nMV renamed.sh`,
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(source).exists()).toBe(false);
		expect((await fs.stat(destination)).mode & 0o777).toBe(0o700);
		expect(await $`${destination}`.quiet().text()).toBe("moved\n");
	});

	test("hashline MV keeps the setuid bit of the source", async () => {
		const source = path.join(tempDir, "run.sh");
		const destination = path.join(tempDir, "renamed.sh");
		await Bun.write(source, "#!/bin/sh\nprintf 'moved\\n'\n");
		await fs.chmod(source, 0o4750);
		const session = makeSession(tempDir);
		const read = await new ReadTool(session).execute("read-script", { path: "run.sh" });
		const header = read.content.find(c => c.type === "text")?.text.split("\n")[0];

		const result = await new EditTool(session, "hashline").execute("move-script", {
			input: `${header}\nMV renamed.sh`,
		});
		expect(result.isError).not.toBe(true);
		expect((await fs.stat(destination)).mode & 0o7777).toBe(0o4750);
	});

	test("hashline MV completes when the destination denies mode changes", async () => {
		const source = path.join(tempDir, "run.sh");
		const destination = path.join(tempDir, "renamed.sh");
		await Bun.write(source, "#!/bin/sh\nprintf 'moved\\n'\n");
		await fs.chmod(source, 0o750);
		const session = makeSession(tempDir);
		const read = await new ReadTool(session).execute("read-script", { path: "run.sh" });
		const header = read.content.find(c => c.type === "text")?.text.split("\n")[0];
		const chmod = vi
			.spyOn(fs, "chmod")
			.mockRejectedValueOnce(Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" }));

		try {
			const result = await new EditTool(session, "hashline").execute("move-script", {
				input: `${header}\nMV renamed.sh`,
			});
			expect(result.isError).not.toBe(true);
			expect(chmod).toHaveBeenCalledTimes(1);
			expect(await Bun.file(source).exists()).toBe(false);
			expect(await Bun.file(destination).text()).toBe("#!/bin/sh\nprintf 'moved\\n'\n");
		} finally {
			chmod.mockRestore();
		}
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
			input: "*** Edit File: sloppy.ts\n*** Find\nold\n*** Replace\nsloppy",
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
