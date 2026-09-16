import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyEditsThenRename } from "@oh-my-pi/pi-coding-agent/lsp/edits";
import type { TextEdit } from "@oh-my-pi/pi-coding-agent/lsp/types";

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
		await applyEditsThenRename([{ filePath: ref, edits: importEdit }], source, dest);

		expect(await Bun.file(dest).text()).toBe("export const x = 1;\n");
		expect(await Bun.file(source).exists()).toBe(false);
		expect(await Bun.file(ref).text()).toBe('import { x } from "./renamed";\n');
	});

	it("rolls back reference edits when the move fails", async () => {
		// A regular file stands where a dest-parent directory must be, so the
		// recursive mkdir throws ENOTDIR before the rename runs.
		const blocker = path.join(dir, "blocker");
		await Bun.write(blocker, "not a dir");
		const dest = path.join(blocker, "sub", "renamed.ts");

		await expect(applyEditsThenRename([{ filePath: ref, edits: importEdit }], source, dest)).rejects.toThrow();

		// Failed move must leave source, destination, and reference files untouched.
		expect(await Bun.file(ref).text()).toBe(refBefore);
		expect(await Bun.file(source).exists()).toBe(true);
		expect(await Bun.file(dest).exists()).toBe(false);
	});

	it("does not rewrite earlier references when a later reference cannot be read", async () => {
		const dest = path.join(dir, "renamed.ts");
		await expect(
			applyEditsThenRename(
				[
					{ filePath: ref, edits: importEdit },
					{ filePath: path.join(dir, "missing.ts"), edits: importEdit },
				],
				source,
				dest,
			),
		).rejects.toThrow();

		expect(await Bun.file(ref).text()).toBe(refBefore);
		expect(await Bun.file(source).text()).toBe("export const x = 1;\n");
		expect(await Bun.file(dest).exists()).toBe(false);
	});

	it("validates later edits before rewriting earlier references", async () => {
		const second = path.join(dir, "second.ts");
		await Bun.write(second, refBefore);
		await expect(
			applyEditsThenRename(
				[
					{ filePath: ref, edits: importEdit },
					{ filePath: second, edits: [...importEdit, { ...importEdit[0], newText: "./conflict" }] },
				],
				source,
				path.join(dir, "renamed.ts"),
			),
		).rejects.toThrow("overlapping LSP edits");

		expect(await Bun.file(ref).text()).toBe(refBefore);
		expect(await Bun.file(second).text()).toBe(refBefore);
	});

	it("restores earlier and partially written references when a later write fails", async () => {
		const second = path.join(dir, "second.ts");
		const dest = path.join(dir, "renamed.ts");
		await Bun.write(second, refBefore);
		const failure = new Error("disk full during reference write");
		const realWrite = Bun.write.bind(Bun);
		let failed = false;
		const writeSpy = spyOn(Bun, "write").mockImplementation(async (target, content) => {
			if (typeof content !== "string") throw new TypeError("Expected a text write");
			if (target === second && !failed) {
				failed = true;
				await realWrite(second, "partial");
				throw failure;
			}
			return realWrite(target, content);
		});
		try {
			await expect(
				applyEditsThenRename(
					[
						{ filePath: ref, edits: importEdit },
						{ filePath: second, edits: importEdit },
					],
					source,
					dest,
				),
			).rejects.toBe(failure);

			expect(await Bun.file(ref).text()).toBe(refBefore);
			expect(await Bun.file(second).text()).toBe(refBefore);
			expect(await Bun.file(source).text()).toBe("export const x = 1;\n");
			expect(await Bun.file(dest).exists()).toBe(false);
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("continues rollback after a restoration fails and retains both errors", async () => {
		const second = path.join(dir, "second.ts");
		await Bun.write(second, refBefore);
		const failure = new Error("reference write failed");
		const rollbackFailure = new Error("reference restoration failed");
		const realWrite = Bun.write.bind(Bun);
		let failed = false;
		const writeSpy = spyOn(Bun, "write").mockImplementation(async (target, content) => {
			if (typeof content !== "string") throw new TypeError("Expected a text write");
			if (target === second) {
				if (failed) throw rollbackFailure;
				failed = true;
				await realWrite(second, "partial");
				throw failure;
			}
			return realWrite(target, content);
		});
		try {
			const error: unknown = await applyEditsThenRename(
				[
					{ filePath: ref, edits: importEdit },
					{ filePath: second, edits: importEdit },
				],
				source,
				path.join(dir, "renamed.ts"),
			).catch(error => error);

			expect(error).toBeInstanceOf(AggregateError);
			if (!(error instanceof AggregateError)) throw new Error("Expected rollback failure details");
			expect(error.cause).toBe(failure);
			expect(error.errors[0]).toBe(failure);
			expect(error.errors[1].cause).toBe(rollbackFailure);
			expect(error.errors[1].message).toContain(second);
			expect(await Bun.file(ref).text()).toBe(refBefore);
			expect(await Bun.file(second).text()).toBe("partial");
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("combines duplicate reference paths against the original contents", async () => {
		const dest = path.join(dir, "renamed.ts");
		await applyEditsThenRename(
			[
				{ filePath: ref, edits: importEdit },
				{ filePath: ref, edits: importEdit },
			],
			source,
			dest,
		);

		expect(await Bun.file(ref).text()).toBe('import { x } from "./renamed";\n');
		expect(await Bun.file(dest).text()).toBe("export const x = 1;\n");
	});

	it("restores the original snapshot for duplicate paths when rename fails", async () => {
		const dest = path.join(dir, "occupied");
		await fs.mkdir(dest);
		await Bun.write(path.join(dest, "keep.txt"), "keep");
		await expect(
			applyEditsThenRename(
				[
					{ filePath: ref, edits: importEdit },
					{ filePath: ref, edits: importEdit },
				],
				source,
				dest,
			),
		).rejects.toThrow();

		expect(await Bun.file(ref).text()).toBe(refBefore);
		expect(await Bun.file(source).text()).toBe("export const x = 1;\n");
		expect(await Bun.file(path.join(dest, "keep.txt")).text()).toBe("keep");
	});
});
