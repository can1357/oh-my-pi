import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "../src/types";
import {
	type CompactionDetails,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "../src/compaction/compaction";
import type { SessionEntry } from "../src/compaction/entries";
import { createCustomMessage } from "../src/compaction/messages";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	isUrlSchemePath,
	LOADED_SKILLS_LIMIT,
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

describe("loaded skills in compaction summaries", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1, remoteEnabled: false };

	function appendMessages(entries: SessionEntry[], messages: AgentMessage[]): void {
		for (const message of messages) {
			entries.push({
				type: "message",
				id: `entry-${entries.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date(entries.length).toISOString(),
				message,
			});
		}
	}

	function appendReadTurn(entries: SessionEntry[], paths: string[]): void {
		appendMessages(entries, [
			{ role: "user", content: "Load the instructions and inspect the source.", timestamp: entries.length },
			createAssistantMessage(
				paths.map((path, i) => readCall(`read-${entries.length}-${i}`, path)),
				"toolUse",
			),
			...paths.map((_, i) => ({
				role: "toolResult" as const,
				toolCallId: `read-${entries.length}-${i}`,
				toolName: "read",
				content: [{ type: "text" as const, text: "Loaded instructions or source." }],
				isError: false,
				timestamp: entries.length,
			})),
			createAssistantMessage([{ type: "text", text: "Inspection complete." }]),
		]);
	}

	async function summarize(
		entries: SessionEntry[],
		generatedSummary = "Work completed.",
		knownSkills?: readonly string[],
	) {
		const preparation = prepareCompaction(entries, settings, model, undefined, knownSkills);
		if (!preparation) throw new Error("Expected discarded history");
		return compact(preparation, model, "test-key", undefined, undefined, {
			completeImpl: async () => createAssistantMessage([{ type: "text", text: generatedSummary }]),
			oneshotRetry: false,
		});
	}

	function appendTail(entries: SessionEntry[]): void {
		appendMessages(entries, [
			{ role: "user", content: "Continue with the next task.", timestamp: entries.length },
			createAssistantMessage([{ type: "text", text: "Ready for the next task." }]),
		]);
	}

	it("retains discarded skill reads outside <files> and omits the block for sessions without loads", async () => {
		for (const skills of [[], ["skill://review:raw", "skill://build/ref.md:10-20:raw"]]) {
			const entries: SessionEntry[] = [];
			appendReadTurn(entries, [...skills, "src/main.ts:10-20"]);
			appendTail(entries);
			const result = await summarize(entries);
			const details = result.details as CompactionDetails;
			expect(details.readFiles).toEqual(["src/main.ts"]);
			const files = result.summary.match(/<files>[\s\S]*?<\/files>/)?.[0];
			expect(files).toBeDefined();
			expect(files).not.toContain("skill://");
			if (skills.length > 0) {
				expect(details.loadedSkills).toEqual(["build", "review"]);
				expect(result.summary).toContain("<loaded-skills>");
				expect(result.summary).toContain("`read skill://<name>`");
				expect(result.summary).toContain("- build\n- review");
			} else {
				expect(details.loadedSkills).toBeUndefined();
				expect(result.summary).not.toContain("<loaded-skills>");
			}
		}
	});

	it("resolves namespaced skill URLs to the skill the skill protocol loads", async () => {
		const entries: SessionEntry[] = [];
		appendReadTurn(entries, ["skill://plugin/review/SKILL.md:raw", "skill://review/references/x.md"]);
		appendTail(entries);
		const result = await summarize(entries, "Work completed.", ["plugin", "plugin/review", "review"]);
		expect((result.details as CompactionDetails).loadedSkills).toEqual(["review", "plugin/review"]);
		expect(result.summary).toContain("- review\n- plugin/review");
	});

	it("collects skill URLs from every target of a delimited read path", async () => {
		const entries: SessionEntry[] = [];
		appendReadTurn(entries, ["docs/compaction.md; skill://review:raw", "skill://build;src/main.ts:1-5"]);
		appendTail(entries);
		const result = await summarize(entries);
		expect((result.details as CompactionDetails).loadedSkills).toEqual(["build", "review"]);
		expect(result.summary).toContain("- build\n- review");
	});

	it("carries skills across compactions, promotes newer loads, and replaces echoed blocks", async () => {
		const entries: SessionEntry[] = [];
		appendReadTurn(entries, ["skill://review:raw", "skill://build"]);
		appendTail(entries);
		const first = await summarize(entries);
		entries.push({
			type: "compaction",
			id: "compaction-1",
			parentId: entries.at(-1)?.id ?? null,
			timestamp: new Date(entries.length).toISOString(),
			...first,
		});
		appendReadTurn(entries, ["skill://deploy/ref.md:raw", "skill://review:10-20"]);
		appendTail(entries);
		const second = await summarize(entries, first.summary);
		expect((second.details as CompactionDetails).loadedSkills).toEqual(["review", "deploy", "build"]);
		expect(second.summary.match(/<loaded-skills>/g)).toHaveLength(1);
		expect(second.summary).toContain("- review\n- deploy\n- build");
	});

	it("recognizes slash-command and autoload custom entries while accepting older summary details", async () => {
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "old-compaction",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				summary: "Earlier work.",
				firstKeptEntryId: "entry-1",
				tokensBefore: 1000,
				details: { readFiles: [], modifiedFiles: [] },
			},
			{
				type: "custom_message",
				id: "entry-1",
				parentId: "old-compaction",
				timestamp: new Date(1).toISOString(),
				customType: "skill-prompt",
				content: "Expanded slash-command skill instructions.",
				display: true,
				attribution: "user",
				details: { name: "review", path: "/skills/review/SKILL.md", args: "this change" },
			},
		];
		appendMessages(entries, [
			createCustomMessage(
				"skill-prompt",
				"Expanded autoloaded skill instructions.",
				false,
				{ name: "build", path: "/skills/build/SKILL.md" },
				new Date(2).toISOString(),
			),
			createAssistantMessage([{ type: "text", text: "Followed the loaded skills." }]),
		]);
		appendTail(entries);
		const result = await summarize(entries);
		expect((result.details as CompactionDetails).loadedSkills).toEqual(["build", "review"]);
		expect(result.summary).toContain("- build\n- review");
	});

	it("bounds the deduplicated history to the most recently loaded skills", async () => {
		const entries: SessionEntry[] = [];
		const names = Array.from({ length: LOADED_SKILLS_LIMIT + 2 }, (_, i) => `skill-${i}`);
		appendReadTurn(entries, [...names.map(name => `skill://${name}`), "skill://skill-1/ref.md:raw"]);
		appendTail(entries);
		const result = await summarize(entries);
		const expected = ["skill-1", ...names.toReversed().filter(name => name !== "skill-1")].slice(
			0,
			LOADED_SKILLS_LIMIT,
		);
		expect((result.details as CompactionDetails).loadedSkills).toEqual(expected);
		const block = result.summary.match(/<loaded-skills>[\s\S]*?<\/loaded-skills>/)?.[0] ?? "";
		expect(block.split("\n").filter(line => line.startsWith("- "))).toEqual(expected.map(name => `- ${name}`));
	});
});
