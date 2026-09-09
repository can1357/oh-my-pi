import { describe, expect, it } from "bun:test";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	isUrlSchemePath,
	stripReadSelector,
} from "../src/compaction/utils";
import { createAssistantMessage } from "./helpers";

function readCall(id: string, path: string) {
	return { type: "toolCall" as const, id, name: "read", arguments: { path } };
}

function writeCall(id: string, path: string) {
	return { type: "toolCall" as const, id, name: "write", arguments: { path } };
}

describe("stripReadSelector", () => {
	it("strips line-range and raw selectors in every supported shape", () => {
		expect(stripReadSelector("src/foo.ts:50")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:50-")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:50-200")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:50+150")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:5-16,960-973")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:2724..2727")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:raw")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:conflicts")).toBe("src/foo.ts");
		// Compound raw+range, either order.
		expect(stripReadSelector("src/foo.ts:100-170:raw")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:raw:2-4")).toBe("src/foo.ts");
	});

	it("keeps archive member paths, stripping only the trailing selector", () => {
		expect(stripReadSelector("archive.zip:dir/file.ts:50-60")).toBe("archive.zip:dir/file.ts");
		expect(stripReadSelector("archive.zip:dir/file.ts")).toBe("archive.zip:dir/file.ts");
	});

	it("leaves non-selector colons untouched", () => {
		expect(stripReadSelector("db.sqlite:users")).toBe("db.sqlite:users");
		expect(stripReadSelector("local://ctx.md")).toBe("local://ctx.md");
		expect(stripReadSelector("https://example.com/page")).toBe("https://example.com/page");
		expect(stripReadSelector("src/foo.ts")).toBe("src/foo.ts");
	});
});

describe("extractFileOpsFromMessage", () => {
	it("dedupes the same file read through different selectors to one entry", () => {
		const fileOps = createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "docs/compaction.md:100-170:raw"),
			readCall("r2", "docs/compaction.md:8-16,128-139,384-388"),
			readCall("r3", "docs/compaction.md:raw"),
			readCall("r4", "docs/compaction.md"),
		]);
		extractFileOpsFromMessage(message, fileOps);
		expect([...fileOps.read]).toEqual(["docs/compaction.md"]);
	});

	it("matches selector-suffixed reads against modified paths", () => {
		const fileOps = createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/login.ts:30-80"),
			{ type: "toolCall" as const, id: "w1", name: "write", arguments: { path: "src/login.ts" } },
		]);
		extractFileOpsFromMessage(message, fileOps);
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		expect(readFiles).toEqual([]);
		expect(modifiedFiles).toEqual(["src/login.ts"]);
	});

	it("skips internal URLs and web URLs so they never enter <files>", () => {
		const fileOps = createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/keep.ts"),
			readCall("r2", "artifact://7"),
			readCall("r3", "local://ctx.md"),
			readCall("r4", "https://example.com/page"),
			writeCall("w1", "conflict://1"),
			writeCall("w2", "conflict://*"),
			// Tolerated `<file>:conflict://N` prefix typo form the write tool accepts.
			writeCall("w3", "src/login.ts:conflict://3"),
			{ type: "toolCall" as const, id: "e1", name: "edit", arguments: { path: "agent://abc" } },
		]);
		extractFileOpsFromMessage(message, fileOps);
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		expect(readFiles).toEqual(["src/keep.ts"]);
		expect(modifiedFiles).toEqual([]);
	});
});

describe("computeFileLists", () => {
	it("drops scheme:// URLs rehydrated from legacy compaction details", () => {
		const fileOps = createFileOps();
		// Simulate a pre-fix summary's details.readFiles/modifiedFiles fed straight
		// into fileOps without going through extractFileOpsFromMessage.
		fileOps.read.add("src/read-only.ts");
		fileOps.read.add("artifact://7");
		fileOps.edited.add("src/edited.ts");
		fileOps.edited.add("conflict://1");
		fileOps.written.add("local://ctx.md");
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		expect(readFiles).toEqual(["src/read-only.ts"]);
		expect(modifiedFiles).toEqual(["src/edited.ts"]);
	});
});

describe("formatFileOperations", () => {
	it("renders one grouped <files> tree with Read/Write/RW markers", () => {
		const rendered = formatFileOperations(
			["src/a.ts", "src/b.ts"],
			["src/c.ts", "src/d.ts"],
			new Set(["src/a.ts", "src/b.ts", "src/c.ts"]),
		);
		expect(rendered).toBe(
			["<files>", "# src/", "a.ts (Read)", "b.ts (Read)", "c.ts (RW)", "d.ts (Write)", "</files>"].join("\n"),
		);
	});

	it("marks modified files Write when no read set is provided", () => {
		const rendered = formatFileOperations([], ["c.ts"]);
		expect(rendered).toBe(["<files>", "c.ts (Write)", "</files>"].join("\n"));
	});
});

describe("isUrlSchemePath", () => {
	it("flags internal URIs and web URLs", () => {
		expect(isUrlSchemePath("conflict://1")).toBe(true);
		expect(isUrlSchemePath("conflict://*")).toBe(true);
		expect(isUrlSchemePath("artifact://7")).toBe(true);
		expect(isUrlSchemePath("local://ctx.md")).toBe(true);
		expect(isUrlSchemePath("history://AuthLoader")).toBe(true);
		expect(isUrlSchemePath("https://example.com/page")).toBe(true);
		// Prefixed conflict typo form — scheme appears after a colon, not at start.
		expect(isUrlSchemePath("src/login.ts:conflict://3")).toBe(true);
	});

	it("leaves real filesystem paths untouched", () => {
		expect(isUrlSchemePath("src/foo.ts")).toBe(false);
		expect(isUrlSchemePath("C:/Users/me/file.ts")).toBe(false);
		expect(isUrlSchemePath("db.sqlite:users")).toBe(false);
		expect(isUrlSchemePath("archive.zip:dir/file.ts")).toBe(false);
		expect(isUrlSchemePath("docs/compaction.md:100-170:raw")).toBe(false);
	});
});
