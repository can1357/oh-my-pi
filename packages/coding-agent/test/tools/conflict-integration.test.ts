import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ConflictHistory } from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	} as unknown as ToolSession;
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

async function getTool(session: ToolSession, name: "read" | "write") {
	// Request only the tool under test: createTools(session) with no toolNames
	// builds every builtin factory (LSP, MCP discovery, browser, eval preflight,
	// …) on each call, which is pure overhead here. The conflict contract lives
	// entirely in the read/write tools + session.conflictHistory.
	const tools = await createTools(session, [name]);
	const tool = tools.find(entry => entry.name === name);
	if (!tool) throw new Error(`Missing ${name} tool`);
	return tool;
}

const TWO_WAY = ["line 1", "<<<<<<< HEAD", "oldApi(x)", "=======", "newApi(x)", ">>>>>>> feature/x", "line N", ""].join(
	"\n",
);

const THREE_WAY = [
	"head",
	"<<<<<<< HEAD",
	"ours body",
	"||||||| common ancestor",
	"base body",
	"=======",
	"theirs body",
	">>>>>>> feat",
	"tail",
	"",
].join("\n");

const TWO_BLOCKS = [
	"<<<<<<< A",
	"a-ours",
	"=======",
	"a-theirs",
	">>>>>>> A",
	"middle",
	"<<<<<<< B",
	"b-ours",
	"=======",
	"b-theirs",
	">>>>>>> B",
	"tail",
	"",
].join("\n");

describe("read surfaces conflicts as a warning footer", () => {
	let tempDir: string;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-int-"));
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("returns file content and appends a conflict warning with id 1", async () => {
		const filePath = path.join(tempDir, "foo.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-foo", { path: "foo.ts" });
		const text = getText(result);
		// Content is still returned.
		expect(text).toContain("<<<<<<< HEAD");
		expect(text).toContain("oldApi(x)");
		expect(text).toContain(">>>>>>> feature/x");
		// Warning footer is appended.
		expect(text).toContain("⚠");
		expect(text).toContain("⚠ 1 unresolved conflict detected");
		expect(text).toContain("- ours = HEAD");
		expect(text).toContain("- theirs = feature/x");
		expect(text).toContain("──── #1  L2-6 ────");
		expect(text).toContain("<<< ours");
		expect(text).toContain(">>> theirs");
		expect(text).toContain("NOTICE: Inspect a block by reading `conflict://<N>`");
		expect(text).toContain('`write({ path: "conflict://<N>", content })`');
		expect(text).toContain('`write({ path: "conflict://*", content })`');
		expect(text).toContain("@ours");
		// Registered on session.
		const history = session.conflictHistory;
		expect(history).toBeInstanceOf(ConflictHistory);
		expect(history?.get(1)?.absolutePath).toBe(filePath);
	});

	it("registers diff3 conflicts with base section", async () => {
		const filePath = path.join(tempDir, "three.ts");
		await Bun.write(filePath, THREE_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-three", { path: "three.ts" });
		const text = getText(result);
		expect(text).toContain("- base = common ancestor");
		expect(text).toContain("=== base");
		expect(session.conflictHistory?.get(1)?.baseLines).toEqual(["base body"]);
	});

	it("registers each block with its own id when several appear in one window", async () => {
		const filePath = path.join(tempDir, "two-blocks.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-two", { path: "two-blocks.ts" });
		const text = getText(result);
		expect(text).toContain("──── #1  L1-5 ────");
		expect(text).toContain("──── #2  L7-11 ────");
		expect(session.conflictHistory?.get(1)?.oursLines).toEqual(["a-ours"]);
		expect(session.conflictHistory?.get(2)?.oursLines).toEqual(["b-ours"]);
	});

	it("emits no warning on clean files and does not touch the history", async () => {
		const filePath = path.join(tempDir, "clean.ts");
		await Bun.write(filePath, "const a = 1;\nconst b = 2;\n");
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-clean", { path: "clean.ts" });
		const text = getText(result);
		expect(text).toContain("const a = 1;");
		expect(text).not.toContain("conflict://");
		expect(text).not.toContain("⚠");
		expect(session.conflictHistory?.get(1)).toBeUndefined();
	});

	it("re-reading the same file reuses the existing id rather than inflating", async () => {
		const filePath = path.join(tempDir, "stable.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		await read.execute("read-stable-1", { path: "stable.ts" });
		await read.execute("read-stable-2", { path: "stable.ts" });
		expect(session.conflictHistory?.get(1)).toBeDefined();
		expect(session.conflictHistory?.get(2)).toBeUndefined();
	});

	it("renders the full conflict block via reads of `conflict://<N>`", async () => {
		const filePath = path.join(tempDir, "full.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		await read.execute("read-full-init", { path: "full.ts" });
		const result = await read.execute("read-full", { path: "conflict://1" });
		const text = getText(result);
		expect(text).toContain("<<<<<<< HEAD");
		expect(text).toContain("oldApi(x)");
		expect(text).toContain("=======");
		expect(text).toContain("newApi(x)");
		expect(text).toContain(">>>>>>> feature/x");
		// No conflict warning footer when expanding a single block by id.
		expect(text).not.toContain("⚠");
	});

	it("renders only the theirs body via reads of `conflict://<N>/theirs`", async () => {
		const filePath = path.join(tempDir, "theirs.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		await read.execute("read-theirs-init", { path: "theirs.ts" });
		const result = await read.execute("read-theirs", { path: "conflict://1/theirs" });
		const text = getText(result);
		expect(text).toContain("newApi(x)");
		expect(text).not.toContain("<<<<<<<");
		expect(text).not.toContain("=======");
		expect(text).not.toContain(">>>>>>>");
		expect(text).not.toContain("oldApi(x)");
	});

	it("renders the base body for a diff3 conflict via `/base`", async () => {
		const filePath = path.join(tempDir, "base.ts");
		await Bun.write(filePath, THREE_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		await read.execute("read-base-init", { path: "base.ts" });
		const result = await read.execute("read-base", { path: "conflict://1/base" });
		const text = getText(result);
		expect(text).toContain("base body");
		expect(text).not.toContain("ours body");
		expect(text).not.toContain("theirs body");
	});

	it("rejects `/base` on a 2-way conflict with a clear error", async () => {
		const filePath = path.join(tempDir, "no-base.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		await read.execute("read-no-base-init", { path: "no-base.ts" });
		const promise = read.execute("read-no-base", { path: "conflict://1/base" });
		await expect(promise).rejects.toThrow(/no base section/);
	});

	it("errors clearly when the conflict id is unknown", async () => {
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const promise = read.execute("read-missing", { path: "conflict://99" });
		await expect(promise).rejects.toThrow(/Conflict #99 not found/);
	});

	it("rejects reads of `conflict://*` (wildcard is write-only)", async () => {
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const promise = read.execute("read-wildcard", { path: "conflict://*" });
		await expect(promise).rejects.toThrow(/wildcards are write-only/);
	});

	it("the `<path>:conflicts` read selector lists every conflict in the file with stable ids", async () => {
		const filePath = path.join(tempDir, "many.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-conflicts", { path: "many.ts:conflicts" });
		const text = getText(result);
		expect(text).toContain("2 unresolved conflicts in many.ts");
		expect(text).toMatch(/#1\s+L1-5/);
		expect(text).toMatch(/#2\s+L7-11/);
		// No file body in summary mode.
		expect(text).not.toContain("a-ours");
		// Conflicts are registered for follow-up read/write.
		expect(session.conflictHistory?.get(1)).toBeDefined();
		expect(session.conflictHistory?.get(2)).toBeDefined();
	});

	it("`:conflicts` marks 3-way blocks distinctly", async () => {
		const filePath = path.join(tempDir, "diff3.ts");
		await Bun.write(filePath, THREE_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-diff3", { path: "diff3.ts:conflicts" });
		const text = getText(result);
		expect(text).toMatch(/#1\s+L2-8.*3-way/);
	});

	it("`:conflicts` on a clean file says so explicitly", async () => {
		const filePath = path.join(tempDir, "clean-conflicts.ts");
		await Bun.write(filePath, "const a = 1;\nconst b = 2;\n");
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-clean-conflicts", { path: "clean-conflicts.ts:conflicts" });
		const text = getText(result);
		expect(text).toContain("No unresolved git merge conflicts");
	});

	it("window-mode warning shows visible-of-total when window misses some conflicts", async () => {
		const filePath = path.join(tempDir, "wide.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		// Read only the first block window.
		const result = await read.execute("read-window", { path: "wide.ts:1-5" });
		const text = getText(result);
		expect(text).toContain("1 of 2 unresolved");
		expect(text).toContain("read `wide.ts:conflicts`");
	});
});

describe("write resolves conflicts via conflict://N", () => {
	let tempDir: string;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-int-write-"));
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("splices the registered region with the supplied content", async () => {
		const filePath = path.join(tempDir, "foo.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-foo", { path: "foo.ts" });
		const result = await write.execute("write-foo", {
			path: "conflict://1",
			content: "newApi(x);\n",
		});

		expect(getText(result)).toContain("Resolved conflict #1");
		const after = await Bun.file(filePath).text();
		expect(after).toBe("line 1\nnewApi(x);\nline N\n");
		// History is invalidated after resolve so the id no longer works.
		expect(session.conflictHistory?.get(1)).toBeUndefined();
	});

	it("drops trailing lines that echo the context below the region and notes the repair", async () => {
		const filePath = path.join(tempDir, "echo.ts");
		const content = [
			"function f() {",
			"<<<<<<< HEAD",
			"\tours();",
			"=======",
			"\ttheirs();",
			">>>>>>> feature/x",
			"\tdone();",
			"}",
			"",
		].join("\n");
		await Bun.write(filePath, content);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-echo", { path: "echo.ts" });
		// The classic failure: the model pastes the whole resolved function,
		// including the two lines that live below the marker block.
		const result = await write.execute("write-echo", {
			path: "conflict://1",
			content: "\tours();\n\ttheirs();\n\tdone();\n}\n",
		});

		const text = getText(result);
		expect(text).toContain("Resolved conflict #1");
		expect(text).toContain("dropped 2 content line(s)");
		expect(await Bun.file(filePath).text()).toBe(
			["function f() {", "\tours();", "\ttheirs();", "\tdone();", "}", ""].join("\n"),
		);
	});

	it("auto-recovers a `<file>:conflict://N` path and resolves the conflict", async () => {
		const filePath = path.join(tempDir, "prefix.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-prefix", { path: "prefix.ts" });
		const result = await write.execute("write-prefix", {
			// Malformed path mixing the `:conflicts` read selector with the
			// `conflict://` scheme — the write tool MUST recover and resolve.
			path: "prefix.ts:conflict://1",
			content: "@theirs",
		});

		const text = getText(result);
		expect(text).toContain("Resolved conflict #1");
		expect(text).toContain("stripped erroneous 'prefix.ts:' prefix");
		expect(await Bun.file(filePath).text()).toBe("line 1\nnewApi(x)\nline N\n");
	});

	it("auto-recovers a `<file>:conflict://*` path and bulk-resolves", async () => {
		const filePath = path.join(tempDir, "bulk-prefix.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-bulk-prefix", { path: "bulk-prefix.ts" });
		const result = await write.execute("write-bulk-prefix", {
			path: "bulk-prefix.ts:conflict://*",
			content: "@ours",
		});

		const text = getText(result);
		expect(text).toContain("Resolved 1 conflict");
		expect(text).toContain("stripped erroneous 'bulk-prefix.ts:' prefix");
		expect(await Bun.file(filePath).text()).toBe("line 1\noldApi(x)\nline N\n");
	});

	it("resolves per-id bulk directives in one call, leaving unlisted ids registered", async () => {
		const filePath = path.join(tempDir, "directives.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-directives", { path: "directives.ts" });
		const result = await write.execute("write-directives", {
			path: "conflict://*",
			content: "1: @ours\n2: @theirs\n",
		});

		const text = getText(result);
		expect(text).toContain("Resolved 2 conflicts");
		expect(await Bun.file(filePath).text()).toBe("a-ours\nmiddle\nb-theirs\ntail\n");
		expect(session.conflictHistory?.get(1)).toBeUndefined();
		expect(session.conflictHistory?.get(2)).toBeUndefined();
	});

	it("directive mode resolves a subset and reports the ids left registered", async () => {
		const filePath = path.join(tempDir, "directives-subset.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-directives-subset", { path: "directives-subset.ts" });
		const result = await write.execute("write-directives-subset", {
			path: "conflict://*",
			content: "2: @ours",
		});

		const text = getText(result);
		expect(text).toContain("Resolved 1 conflict");
		expect(text).toContain("still registered (#1)");
		expect(await Bun.file(filePath).text()).toBe(
			["<<<<<<< A", "a-ours", "=======", "a-theirs", ">>>>>>> A", "middle", "b-ours", "tail", ""].join("\n"),
		);
		expect(session.conflictHistory?.get(1)).toBeDefined();
	});

	it("rejects directives referencing unknown ids", async () => {
		const filePath = path.join(tempDir, "directives-bad.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-directives-bad", { path: "directives-bad.ts" });
		const promise = write.execute("write-directives-bad", {
			path: "conflict://*",
			content: "1: @ours\n7: @theirs",
		});
		await expect(promise).rejects.toThrow(/unknown conflict id\(s\) #7/);
	});

	it("rejects a per-id block that mixes directives with literal content instead of leaking it", async () => {
		const filePath = path.join(tempDir, "directives-mixed.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const original = await Bun.file(filePath).text();
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-directives-mixed", { path: "directives-mixed.ts" });
		// #1 picks a side, but #2 carries multi-line literal content. Previously this
		// fell through to uniform bulk mode and pasted the raw directive text into
		// every block while reporting success. It must now hard-fail.
		const promise = write.execute("write-directives-mixed", {
			path: "conflict://*",
			content: "1: @ours\n2: combined line A\ncombined line B\n",
		});
		await expect(promise).rejects.toThrow(/Malformed `conflict:\/\/\*` per-id block/);
		// File untouched — the markers are still present, nothing leaked.
		expect(await Bun.file(filePath).text()).toBe(original);
		// Ids stay registered for a corrected retry.
		expect(session.conflictHistory?.get(1)).toBeDefined();
		expect(session.conflictHistory?.get(2)).toBeDefined();
	});

	it("rejects a per-id line whose value is not a recognized @side token", async () => {
		const filePath = path.join(tempDir, "directives-badtoken.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-directives-badtoken", { path: "directives-badtoken.ts" });
		const promise = write.execute("write-directives-badtoken", {
			path: "conflict://*",
			content: "1: @ours\n2: @mine",
		});
		await expect(promise).rejects.toThrow(/only accepts the tokens @ours\/@theirs\/@base\/@both/);
		expect(await Bun.file(filePath).text()).toBe(TWO_BLOCKS);
	});

	it("still treats pure-literal content as a uniform bulk write (no false directive rejection)", async () => {
		const filePath = path.join(tempDir, "directives-literal.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-directives-literal", { path: "directives-literal.ts" });
		// No line is `<id>: @side`, so this is a uniform replacement, not a per-id block.
		const result = await write.execute("write-directives-literal", {
			path: "conflict://*",
			content: "resolvedApi(x)\n",
		});
		expect(getText(result)).toContain("Resolved 1 conflict");
		expect(await Bun.file(filePath).text()).toBe("line 1\nresolvedApi(x)\nline N\n");
	});

	it("can resolve two blocks in the same file by id, in either order", async () => {
		const filePath = path.join(tempDir, "two.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-two", { path: "two.ts" });

		// Resolve #2 (block B) first to confirm out-of-order works.
		await write.execute("write-two-2", {
			path: "conflict://2",
			content: "B-resolved\n",
		});
		// #1 is still registered and points at unchanged lines (block B sits
		// below block A so the splice does not move A). No re-read needed.
		await write.execute("write-two-1", {
			path: "conflict://1",
			content: "A-resolved\n",
		});

		const after = await Bun.file(filePath).text();
		expect(after).toBe("A-resolved\nmiddle\nB-resolved\ntail\n");
	});

	it("accepts `@ours`/`@theirs`/`@both` content tokens as shorthand", async () => {
		const filePath = path.join(tempDir, "tokens.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-tokens", { path: "tokens.ts" });
		await write.execute("write-tokens", { path: "conflict://1", content: "@theirs" });

		const after = await Bun.file(filePath).text();
		expect(after).toBe("line 1\nnewApi(x)\nline N\n");
	});

	it("expands `@both` to ours then theirs without re-typing either side", async () => {
		const filePath = path.join(tempDir, "both.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-both", { path: "both.ts" });
		await write.execute("write-both", { path: "conflict://1", content: "@both" });

		const after = await Bun.file(filePath).text();
		expect(after).toBe("line 1\noldApi(x)\nnewApi(x)\nline N\n");
	});

	it("rejects `@base` for a 2-way conflict with a clear error", async () => {
		const filePath = path.join(tempDir, "nobase.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-nobase", { path: "nobase.ts" });
		const promise = write.execute("write-nobase", { path: "conflict://1", content: "@base" });
		await expect(promise).rejects.toThrow(/no base section/);
		// File untouched.
		expect(await Bun.file(filePath).text()).toBe(TWO_WAY);
	});

	it("errors clearly when the id is unknown", async () => {
		const filePath = path.join(tempDir, "nope.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const write = await getTool(session, "write");

		const promise = write.execute("write-nope", {
			path: "conflict://99",
			content: "x\n",
		});
		await expect(promise).rejects.toThrow(/Conflict #99 not found/);
		// File untouched.
		expect(await Bun.file(filePath).text()).toBe(TWO_WAY);
	});

	it("errors clearly when the URI itself is malformed", async () => {
		const session = createTestSession(tempDir);
		const write = await getTool(session, "write");

		await expect(write.execute("write-bad-zero", { path: "conflict://0", content: "x" })).rejects.toThrow(
			/Invalid conflict URI/,
		);
		await expect(write.execute("write-bad-neg", { path: "conflict://-1", content: "x" })).rejects.toThrow(
			/Invalid conflict URI/,
		);
		await expect(write.execute("write-bad-frac", { path: "conflict://1.5", content: "x" })).rejects.toThrow(
			/Invalid conflict URI/,
		);
	});

	it("rejects scoped conflict URIs on write (read-only)", async () => {
		const filePath = path.join(tempDir, "scoped.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-scoped", { path: "scoped.ts" });
		await expect(write.execute("write-scoped", { path: "conflict://1/theirs", content: "x" })).rejects.toThrow(
			/read-only/,
		);
		// File untouched.
		expect(await Bun.file(filePath).text()).toBe(TWO_WAY);
	});

	it("rejects stale resolutions when the file changed out of band", async () => {
		const filePath = path.join(tempDir, "stale.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-stale", { path: "stale.ts" });
		// User resolves the conflict by hand outside the agent.
		await Bun.write(filePath, "line 1\nresolved by hand\nline N\n");

		const promise = write.execute("write-stale", {
			path: "conflict://1",
			content: "agent-pick\n",
		});
		await expect(promise).rejects.toThrow(/stale|outside the current file|no longer/i);
		// File untouched by the failed write.
		expect(await Bun.file(filePath).text()).toBe("line 1\nresolved by hand\nline N\n");
	});

	it("strips hashline display prefixes from replacement content when hashline mode is active", async () => {
		const filePath = path.join(tempDir, "hashed.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-hashed", { path: "hashed.ts" });
		const result = await write.execute("write-hashed", {
			path: "conflict://1",
			content: "[hashed.ts#1a2b]\n42:cleanline\n",
		});
		expect(getText(result)).toContain("auto-stripped hashline display prefixes");
		const after = await Bun.file(filePath).text();
		expect(after).toBe("line 1\ncleanline\nline N\n");
	});

	it("`write conflict://*` bulk-resolves every registered conflict, per-entry token expansion", async () => {
		const fileA = path.join(tempDir, "bulkA.ts");
		const fileB = path.join(tempDir, "bulkB.ts");
		await Bun.write(fileA, TWO_BLOCKS);
		await Bun.write(fileB, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-bulk-A", { path: "bulkA.ts:conflicts" });
		await read.execute("read-bulk-B", { path: "bulkB.ts:conflicts" });
		// All 3 conflicts registered.
		expect(session.conflictHistory?.entries()).toHaveLength(3);

		const result = await write.execute("write-bulk", {
			path: "conflict://*",
			content: "@theirs",
		});
		const text = getText(result);
		expect(text).toContain("Resolved 3 conflicts across 2 files");
		expect(text).toContain("bulkA.ts: 2 conflicts");
		expect(text).toContain("bulkB.ts: 1 conflict");

		// Per-entry expansion: each block keeps its own theirs side.
		expect(await Bun.file(fileA).text()).toBe("a-theirs\nmiddle\nb-theirs\ntail\n");
		expect(await Bun.file(fileB).text()).toBe("line 1\nnewApi(x)\nline N\n");
		// History cleared after bulk resolve.
		expect(session.conflictHistory?.entries()).toHaveLength(0);
	});

	it("`write conflict://*` errors when no conflicts are registered", async () => {
		const session = createTestSession(tempDir);
		const write = await getTool(session, "write");
		await expect(write.execute("write-bulk-empty", { path: "conflict://*", content: "@ours" })).rejects.toThrow(
			/nothing to resolve/,
		);
	});

	it("splice relocates when line numbers shift out of band", async () => {
		const filePath = path.join(tempDir, "shift.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-shift", { path: "shift.ts" });
		// Out-of-band edit before the conflict block: shifts line numbers.
		const shifted = await Bun.file(filePath).text();
		await Bun.write(filePath, `// extra line\n// another extra\n${shifted}`);

		const result = await write.execute("write-shift", {
			path: "conflict://1",
			content: "@theirs",
		});
		expect(getText(result)).toContain("Resolved conflict #1");
		const after = await Bun.file(filePath).text();
		expect(after).toBe("// extra line\n// another extra\nline 1\nnewApi(x)\nline N\n");
	});
});
