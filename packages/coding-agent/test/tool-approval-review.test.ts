import { beforeAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	EditTool,
	getEditStore,
	type ApplyPatchParams,
	type HashlineParams,
	type PatchParams,
	type ReplaceParams,
	type SloppyParams,
} from "@oh-my-pi/pi-coding-agent/edit";
import { formatHashlineHeader } from "@oh-my-pi/pi-coding-agent/tools/hashline-format";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { EditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const SOURCE = "export function value(): number {\n\treturn 1;\n}\n";
const AFTER = "export function value(): number {\n\treturn 2;\n}\n";
const HUMAN = "export function value(): number {\n\treturn 42; // human revision\n}\n";
const HEADER_TAG = /\[([^\]]+)#([0-9A-F]{4})\]/;

type ModeParams = ReplaceParams | PatchParams | HashlineParams | ApplyPatchParams | SloppyParams;

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		enableLsp: false,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

describe("tool approval content review", () => {
	let tmpDir: string;
	let session: ToolSession;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-approval-review-"));
		session = createSession(tmpDir);
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	async function fixture(name: string, content = SOURCE): Promise<string> {
		const absolute = path.join(tmpDir, name);
		await Bun.write(absolute, content);
		return absolute;
	}

	describe("edit exposes mode-independent before/after in every edit mode", () => {
		const cases: Array<{ mode: EditMode; file: string; make: () => Promise<ModeParams> }> = [
			{
				mode: "replace",
				file: "replace.ts",
				make: async () => ({ path: "replace.ts", old_string: "\treturn 1;", new_string: "\treturn 2;" }),
			},
			{
				mode: "patch",
				file: "patch.ts",
				make: async () =>
					({ path: "patch.ts", edits: [{ op: "update", diff: "@@\n-\treturn 1;\n+\treturn 2;" }] }) as PatchParams,
			},
			{
				mode: "apply_patch",
				file: "apply-patch.ts",
				make: async () => ({
					input: [
						"*** Begin Patch",
						"*** Update File: apply-patch.ts",
						"@@",
						"-\treturn 1;",
						"+\treturn 2;",
						"*** End Patch",
						"",
					].join("\n"),
				}),
			},
			{
				mode: "hashline",
				file: "hashline.ts",
				make: async () => {
					const tag = getEditStore(session).recordSnapshot(path.join(tmpDir, "hashline.ts"), SOURCE, undefined);
					return { input: `${formatHashlineHeader("hashline.ts", tag)}\nPUT 2-2:\n+\treturn 2;` };
				},
			},
			{
				mode: "sloppy",
				file: "sloppy.ts",
				make: async () => ({
					input: '<SM:EDIT path="sloppy.ts">\n<SM:FIND>\n\treturn 1;\n</SM:FIND>\n<SM:PUT>\n\treturn 2;\n</SM:PUT>',
				}),
			},
		];

		for (const { mode, file, make } of cases) {
			test(`proposes and substitutes human content in ${mode} mode`, async () => {
				const absolute = await fixture(file);
				const tool = new EditTool(session, mode);
				const params = await make();

				const review = await tool.prepareApproval(`call-${mode}`, params);
				expect(review.files).toEqual([{ path: file, before: SOURCE, after: AFTER }]);

				review.apply([{ path: file, content: HUMAN }]);
				const result = await tool.execute(`call-${mode}`, params);
				expect(result.isError).not.toBe(true);
				expect(await Bun.file(absolute).text()).toBe(HUMAN);
			});
		}

		test("rejects a revision naming a file that was never proposed", async () => {
			await fixture("replace.ts");
			const tool = new EditTool(session, "replace");
			const params = { path: "replace.ts", old_string: "\treturn 1;", new_string: "\treturn 2;" };
			const review = await tool.prepareApproval("reject", params);
			expect(() => review.apply([{ path: "other.ts", content: "x" }])).toThrow();
		});
	});

	test("mixed hashline request: only the content edit is proposed; delete and rename still execute", async () => {
		const aAbs = await fixture("mix-a.ts");
		const bAbs = await fixture("mix-b.ts");
		const cAbs = await fixture("mix-c.ts");
		const store = getEditStore(session);
		const tagA = store.recordSnapshot(aAbs, SOURCE, undefined);
		const tagB = store.recordSnapshot(bAbs, SOURCE, undefined);
		const tagC = store.recordSnapshot(cAbs, SOURCE, undefined);
		const input = [
			formatHashlineHeader("mix-a.ts", tagA),
			"PUT 2-2:",
			"+\treturn 2;",
			formatHashlineHeader("mix-b.ts", tagB),
			"REM",
			formatHashlineHeader("mix-c.ts", tagC),
			"PUT 2-2:",
			"+\treturn 3;",
			"MV mix-c-renamed.ts",
		].join("\n");
		const tool = new EditTool(session, "hashline");

		const review = await tool.prepareApproval("mixed", { input });
		expect(review.files.map(file => file.path)).toEqual(["mix-a.ts"]);

		review.apply([{ path: "mix-a.ts", content: HUMAN }]);
		const result = await tool.execute("mixed", { input });
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(aAbs).text()).toBe(HUMAN);
		expect(await fs.exists(bAbs)).toBe(false);
		expect(await Bun.file(path.join(tmpDir, "mix-c-renamed.ts")).text()).toBe(
			"export function value(): number {\n\treturn 3;\n}\n",
		);
		expect(await fs.exists(cAbs)).toBe(false);
	});

	test("revised edit result carries a fresh snapshot tag for the human content", async () => {
		const aAbs = await fixture("tag.ts");
		const tag = getEditStore(session).recordSnapshot(aAbs, SOURCE, undefined);
		const input = `${formatHashlineHeader("tag.ts", tag)}\nPUT 2-2:\n+\treturn 2;`;
		const tool = new EditTool(session, "hashline");

		const review = await tool.prepareApproval("fresh-tag", { input });
		review.apply([{ path: "tag.ts", content: HUMAN }]);
		const result = await tool.execute("fresh-tag", { input });
		expect(result.isError).not.toBe(true);

		const store = getEditStore(session);
		const headTag = store.headHash(aAbs);
		expect(headTag).toBeTruthy();
		expect(store.byHashText(aAbs, headTag!)).toBe(HUMAN);
		expect(resultText(result)).toContain(`[tag.ts#${headTag}]`);
	});

	describe("write tool review", () => {
		test("proposes a created file, substitutes human content, and forces a fresh tag header", async () => {
			session.settings.set("edit.mode", "replace");
			const target = path.join(tmpDir, "created.ts");
			const tool = new WriteTool(session);
			const params = { path: "created.ts", content: "proposed content\n" };

			const review = await tool.prepareApproval("write-create", params);
			if (!review) throw new Error("expected a review for a filesystem write");
			expect(review.files).toEqual([{ path: "created.ts", before: null, after: "proposed content\n" }]);

			review.apply([{ path: "created.ts", content: "human content\n" }]);
			const result = await tool.execute("write-create", params);
			expect(result.isError).not.toBe(true);
			expect(await Bun.file(target).text()).toBe("human content\n");
			expect(resultText(result)).toMatch(HEADER_TAG);
			const store = getEditStore(session);
			const headTag = store.headHash(target);
			expect(headTag).toBeTruthy();
			expect(store.byHashText(target, headTag!)).toBe("human content\n");
		});

		test("proposes no tab when the write would not change the file", async () => {
			await fixture("same.txt", "identical\n");
			const tool = new WriteTool(session);
			const review = await tool.prepareApproval("write-noop", { path: "same.txt", content: "identical\n" });
			if (!review) throw new Error("expected a review for a filesystem write");
			expect(review.files).toEqual([]);
			review.apply([]);
		});

		test("refuses to execute when the target drifted during approval", async () => {
			await fixture("drift.txt", "before\n");
			const tool = new WriteTool(session);
			const review = await tool.prepareApproval("write-drift", { path: "drift.txt", content: "after\n" });
			if (!review) throw new Error("expected a review for a filesystem write");
			review.apply([{ path: "drift.txt", content: "human\n" }]);
			await Bun.write(path.join(tmpDir, "drift.txt"), "external change\n");
			await expect(tool.execute("write-drift", { path: "drift.txt", content: "after\n" })).rejects.toThrow(
				/changed during approval/,
			);
		});
	});
});
