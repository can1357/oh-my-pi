import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DiffSide, DiffStream } from "@oh-my-pi/pi-natives";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import {
	buildDiffDocument,
	buildLineSelectionPatch,
	type DiffBuildOptions,
	DiffPane,
} from "../src/cli/git-tui/diff-pane";
import { GitModel } from "../src/cli/git-tui/state";
import { initTheme } from "../src/modes/theme/theme";

const RED_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);
const LFS_POINTER_VERSION = "version https://git-lfs.github.com/spec/v1";
beforeAll(async () => {
	await initTheme(false);
});

async function withReviewRepo(run: (repo: string) => Promise<void>): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-tui-stream-"));
	try {
		await $`git init --initial-branch=main`.cwd(repo).quiet();
		await $`git config user.name "Test User"`.cwd(repo).quiet();
		await $`git config user.email "test@example.com"`.cwd(repo).quiet();
		await Bun.write(path.join(repo, "seed.txt"), "seed\n");
		await $`git add seed.txt`.cwd(repo).quiet();
		await $`git commit -m base`.cwd(repo).quiet();
		await run(repo);
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
}

async function loadStagedContents(repo: string, filePath: string) {
	const model = new GitModel(repo);
	await model.refresh();
	const file = model.staged.find(candidate => candidate.path === filePath);
	if (!file) throw new Error(`staged file was not discovered: ${filePath}`);
	return { contents: await model.streamContents(file, () => {}), file };
}

async function streamedDocument(oldText: string, newText: string, options: DiffBuildOptions = {}) {
	const stream = new DiffStream();
	stream.push(DiffSide.Old, oldText.slice(0, Math.floor(oldText.length / 2)));
	stream.push(DiffSide.Old, oldText.slice(Math.floor(oldText.length / 2)));
	stream.push(DiffSide.New, newText.slice(0, Math.floor(newText.length / 2)));
	stream.push(DiffSide.New, newText.slice(Math.floor(newText.length / 2)));
	stream.finishSide(DiffSide.Old);
	stream.finishSide(DiffSide.New);
	const streamResult = await stream.finish(3);
	return buildDiffDocument(stream.text(DiffSide.Old), stream.text(DiffSide.New), "fixture.ts", {
		...options,
		streamResult,
	});
}

describe("git TUI streamed document", () => {
	test("uses an empty base side for a staged added file", async () => {
		await withReviewRepo(async repo => {
			await Bun.write(path.join(repo, "added.ts"), "export const added = true;\n");
			await $`git add added.ts`.cwd(repo).quiet();

			const model = new GitModel(repo);
			await model.refresh();
			const file = model.staged.find(candidate => candidate.path === "added.ts");
			if (!file) throw new Error("staged added file was not discovered");
			let updates = 0;
			const contents = await model.streamContents(file, () => {
				updates++;
			});
			if (contents.kind !== "text") throw new Error("staged text file was not diffable");
			expect(contents.oldText).toBe("");
			expect(contents.newText).toBe("export const added = true;\n");
			expect(contents.streamResult.runs.length).toBeGreaterThan(0);
			expect(updates).toBeGreaterThan(0);
		});
	});

	test.each([
		["replacement", "a\nb\nc\n", "a\nx\nc\n"],
		["insert and delete", "a\nb\nc\nd\n", "a\nnew\nb\nd\n"],
		["EOF newline transition", "a\nb", "a\nb\n"],
	])("matches the exact synchronous builder for %s", async (_name, oldText, newText) => {
		const streamed = await streamedDocument(oldText, newText);
		const synchronous = buildDiffDocument(oldText, newText, "fixture.ts");
		expect(streamed).toEqual(synchronous);
	});

	// #9734: unstaged files on Windows diff the CRLF worktree side against the
	// LF index side. Raw carriage returns in display lines snap the terminal
	// cursor to column 0 mid-row, corrupting the render. Both the built
	// document and every rendered row must be free of C0 control bytes.
	test("strips carriage returns from a CRLF worktree side", async () => {
		const oldText = "line one\nline two\nline three\n"; // index side (LF)
		const newText = "line one\r\nline two changed\r\nline three\r\n"; // worktree side (CRLF)
		const doc = buildDiffDocument(oldText, newText, "fixture.ts");
		expect(doc.newDisplayLines.some(line => line.includes("\r"))).toBe(false);
		expect(doc.newDisplayLines).toContain("line two changed");

		const pane = new DiffPane();
		pane.setDocument(doc, "ready");
		const control = /[\x00-\x08\x0b-\x1f\x7f]/;
		for (const mode of ["split", "inline", "file", "hunk"] as const) {
			pane.setMode(mode);
			for (const row of pane.render(80, 20)) {
				expect(control.test(row.replace(/\x1b\[[0-9;]*m/g, ""))).toBe(false);
			}
		}
	});
});
describe("git TUI asset previews", () => {
	test("renders raster Git objects as media instead of binary placeholders", async () => {
		await withReviewRepo(async repo => {
			await Bun.write(path.join(repo, "image.png"), RED_PNG);
			await $`git add image.png`.cwd(repo).quiet();

			const { contents, file } = await loadStagedContents(repo, "image.png");
			if (contents.kind !== "asset" || contents.new.kind !== "image") {
				throw new Error("PNG was not loaded as a media asset");
			}
			expect(contents.old.kind).toBe("empty");
			expect(contents.new.image.sourceMimeType).toBe("image/png");
			expect([contents.new.image.widthPx, contents.new.image.heightPx]).toEqual([1, 1]);

			const pane = new DiffPane();
			pane.setAsset(file.path, contents.old, contents.new);
			const rendered = sanitizeText(pane.render(80, 12).join("\n"));
			expect(rendered).toContain("After · PNG");
			expect(rendered).not.toContain("Binary object");
		});
	});

	test("rasterizes SVG Git objects for terminal preview", async () => {
		await withReviewRepo(async repo => {
			const svg =
				'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>';
			await Bun.write(path.join(repo, "diagram.svg"), svg);
			await $`git add diagram.svg`.cwd(repo).quiet();

			const { contents, file } = await loadStagedContents(repo, "diagram.svg");
			if (contents.kind !== "asset" || contents.new.kind !== "image") {
				throw new Error("SVG was not rasterized as a media asset");
			}
			expect(contents.new.image.sourceMimeType).toBe("image/svg+xml");
			expect([contents.new.image.widthPx, contents.new.image.heightPx]).toEqual([20, 10]);

			const pane = new DiffPane();
			pane.setAsset(file.path, contents.old, contents.new);
			expect(sanitizeText(pane.render(80, 12).join("\n"))).toContain("After · SVG");
		});
	});

	test("resolves staged Git LFS pointers from local object storage", async () => {
		await withReviewRepo(async repo => {
			const oid = new Bun.CryptoHasher("sha256").update(RED_PNG).digest("hex");
			const objectPath = path.join(repo, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
			await fs.mkdir(path.dirname(objectPath), { recursive: true });
			await Bun.write(objectPath, RED_PNG);
			await Bun.write(
				path.join(repo, "lfs-image.png"),
				`${LFS_POINTER_VERSION}\noid sha256:${oid}\nsize ${RED_PNG.byteLength}\n`,
			);
			await $`git add lfs-image.png`.cwd(repo).quiet();

			const { contents, file } = await loadStagedContents(repo, "lfs-image.png");
			if (contents.kind !== "asset" || contents.new.kind !== "image") {
				throw new Error("local Git LFS object was not loaded as media");
			}
			expect(contents.new.image.lfsOid).toBe(oid);
			expect(contents.new.image.byteLength).toBe(RED_PNG.byteLength);

			const pane = new DiffPane();
			pane.setAsset(file.path, contents.old, contents.new);
			expect(sanitizeText(pane.render(90, 12).join("\n"))).toContain("After · PNG · Git LFS");
		});
	});

	test("shows unavailable Git LFS objects explicitly", async () => {
		await withReviewRepo(async repo => {
			const oid = "0".repeat(64);
			await Bun.write(
				path.join(repo, "missing.png"),
				`${LFS_POINTER_VERSION}\noid sha256:${oid}\nsize ${RED_PNG.byteLength}\n`,
			);
			await $`git add missing.png`.cwd(repo).quiet();

			const { contents, file } = await loadStagedContents(repo, "missing.png");
			if (contents.kind !== "asset" || contents.new.kind !== "lfsMissing") {
				throw new Error("missing Git LFS object did not surface its placeholder");
			}
			const pane = new DiffPane();
			pane.setAsset(file.path, contents.old, contents.new);
			const rendered = sanitizeText(pane.render(90, 12).join("\n"));
			expect(rendered).toContain("Git LFS object unavailable");
			expect(rendered).toContain("sha256:000000000000…");
		});
	});

	test("keeps invalid UTF-8 Git objects out of the text renderer", async () => {
		await withReviewRepo(async repo => {
			await Bun.write(path.join(repo, "object.bin"), new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]));
			await $`git add object.bin`.cwd(repo).quiet();

			const { contents, file } = await loadStagedContents(repo, "object.bin");
			if (contents.kind !== "asset" || contents.new.kind !== "binary") {
				throw new Error("binary Git object was not classified safely");
			}
			const pane = new DiffPane();
			pane.setAsset(file.path, contents.old, contents.new);
			const rendered = sanitizeText(pane.render(80, 12).join("\n"));
			expect(rendered).toContain("Binary object");
			expect(rendered).not.toContain("�");
		});
	});
});

describe("formatting-ignore whitespace mode", () => {
	const FMT: DiffBuildOptions = { whitespace: "formatting" };
	const SPLIT_OLD = "const x = foo(a, b);\nkeep\n";
	const SPLIT_NEW = "const x = foo(\n\ta,\n\tb\n);\nkeep\n";

	test("demotes line splits that only move whitespace", () => {
		const doc = buildDiffDocument(SPLIT_OLD, SPLIT_NEW, "fixture.ts", FMT);
		expect(doc.additions).toBe(0);
		expect(doc.deletions).toBe(0);
		expect(doc.hunks).toHaveLength(0);
		expect(doc.rows.every(row => row.kind === "context")).toBe(true);
		// One-sided demoted rows keep their new-file line numbers for the gutter.
		expect(doc.rows.map(row => row.newNum)).toEqual([1, 2, 3, 4, 5]);
	});

	test("keeps blocks that change more than whitespace", () => {
		const doc = buildDiffDocument(SPLIT_OLD, "const x = foo(\n\ta,\n\tc\n);\nkeep\n", "fixture.ts", FMT);
		expect(doc.deletions).toBe(1);
		expect(doc.additions).toBe(4);
		expect(doc.hunks.length).toBeGreaterThan(0);
	});

	test("demotes import-only additions in ts", () => {
		const oldText = 'import { a } from "./a";\nconst v = 1;\n';
		const newText = 'import { a } from "./a";\nimport { b } from "./b";\nconst v = 1;\n';
		const doc = buildDiffDocument(oldText, newText, "fixture.ts", FMT);
		expect(doc.additions).toBe(0);
		expect(doc.hunks).toHaveLength(0);
	});

	test("demotes rust use reordering across separate blocks", () => {
		const oldText = "use b::B;\nuse a::A;\nfn main() {}\n";
		const newText = "use a::A;\nuse b::B;\nfn main() {}\n";
		const doc = buildDiffDocument(oldText, newText, "lib.rs", FMT);
		expect(doc.additions).toBe(0);
		expect(doc.deletions).toBe(0);
		expect(doc.hunks).toHaveLength(0);
	});

	test("import demotion is language-gated", () => {
		const oldText = 'import { a } from "./a";\nconst v = 1;\n';
		const newText = 'import { a } from "./a";\nimport { b } from "./b";\nconst v = 1;\n';
		const doc = buildDiffDocument(oldText, newText, "fixture.py", FMT);
		expect(doc.additions).toBe(1);
	});

	test("keeps import lines mixed with a real change in one block", () => {
		const oldText = 'import { a } from "./a";\nconst v = 1;\n';
		const newText = 'import { b } from "./b";\nconst v = 2;\n';
		const doc = buildDiffDocument(oldText, newText, "fixture.ts", FMT);
		expect(doc.deletions).toBe(2);
		expect(doc.additions).toBe(2);
	});
	test("demotes an import add fused with a whitespace reflow in one block", () => {
		const oldText = 'import { a } from "./a";\nconst x = foo(a, b);\nexport const k = 1;\n';
		const newText =
			'import { a } from "./a";\nimport { b } from "./b";\nconst x = foo(\n\ta,\n\tb\n);\nexport const k = 1;\n';
		const doc = buildDiffDocument(oldText, newText, "fixture.ts", FMT);
		expect(doc.additions).toBe(0);
		expect(doc.deletions).toBe(0);
		expect(doc.hunks).toHaveLength(0);
	});

	test("keeps hunk patches, unlike whitespace mode", () => {
		const oldText = "value = 1\n";
		const newText = "value = 2\n";
		expect(buildDiffDocument(oldText, newText, "fixture.ts", { whitespace: "whitespace" }).canPatch).toBe(false);
		const doc = buildDiffDocument(oldText, newText, "fixture.ts", FMT);
		expect(doc.canPatch).toBe(true);
		expect(doc.hunks[0]?.patch).toContain("+value = 2");
	});

	test("selection patches reconstruct the base across demoted one-sided rows", () => {
		const oldText = "foo(a, b)\nmid\nvalue = 1\n";
		const newText = "foo(\na,\nb\n)\nmid\nvalue = 2\n";
		const doc = buildDiffDocument(oldText, newText, "fixture.ts", FMT);
		const index = doc.rows.findIndex(row => row.kind === "change");
		expect(index).toBeGreaterThanOrEqual(0);
		const patch = buildLineSelectionPatch(doc, index, index, "apply");
		expect(patch).not.toBeNull();
		// Demoted context must mirror the old side, not leak empty lines.
		expect(patch).toContain(" foo(a, b)");
		expect(patch).toContain("+value = 2");
	});

	test("streamed formatting document matches the synchronous builder", async () => {
		const streamed = await streamedDocument(SPLIT_OLD, SPLIT_NEW, FMT);
		expect(streamed).toEqual(buildDiffDocument(SPLIT_OLD, SPLIT_NEW, "fixture.ts", FMT));
	});
});
