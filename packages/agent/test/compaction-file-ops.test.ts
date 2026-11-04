import { describe, expect, it } from "bun:test";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { extractFileOpsFromMessage, stripReadSelector } from "../src/compaction/utils";
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
		const fileOps = snapcompact.createFileOps();
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
		const fileOps = snapcompact.createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/login.ts:30-80"),
			{ type: "toolCall" as const, id: "w1", name: "write", arguments: { path: "src/login.ts" } },
		]);
		extractFileOpsFromMessage(message, fileOps);
		const { readFiles, modifiedFiles } = snapcompact.computeFileLists(fileOps);
		expect(readFiles).toEqual([]);
		expect(modifiedFiles).toEqual(["src/login.ts"]);
	});

	it("skips internal URLs and web URLs so they never enter <files>", () => {
		const fileOps = snapcompact.createFileOps();
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
		const { readFiles, modifiedFiles } = snapcompact.computeFileLists(fileOps);
		expect(readFiles).toEqual(["src/keep.ts"]);
		expect(modifiedFiles).toEqual([]);
	});
});
