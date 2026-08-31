import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ConflictHistory, inspectConflictAuthority } from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

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

const JJ_DIFF = [
	"before",
	"<<<<<<< conflict 1 of 1",
	"%%%%%%% diff from: merge base",
	`${"\\".repeat(7)}        to: left change`,
	" value = 1",
	"-name = old",
	"+name = left",
	"+++++++ right change",
	"value = 1",
	"name = right",
	">>>>>>> conflict 1 of 1 ends",
	"after",
	"",
].join("\n");

async function createGitConflict(root: string, fileName: string, markerSize?: number): Promise<string> {
	await $`git init -q -b main`.cwd(root).quiet();
	await $`git config user.name "Conflict Test"`.cwd(root).quiet();
	await $`git config user.email conflict-test@example.test`.cwd(root).quiet();
	const filePath = path.join(root, fileName);
	await Bun.write(filePath, "base\n");
	if (markerSize !== undefined) {
		await Bun.write(path.join(root, ".gitattributes"), `${fileName} conflict-marker-size=${markerSize}\n`);
	}
	await $`git add --all`.cwd(root).quiet();
	await $`git commit -qm base`.cwd(root).quiet();
	await $`git checkout -qb left`.cwd(root).quiet();
	await Bun.write(filePath, "left\n");
	await $`git commit -qam left`.cwd(root).quiet();
	await $`git checkout -q main`.cwd(root).quiet();
	await Bun.write(filePath, "right\n");
	await $`git commit -qam right`.cwd(root).quiet();
	const merge = await $`git merge left`.cwd(root).quiet().nothrow();
	if (merge.exitCode === 0) throw new Error("Expected Git merge conflict");
	return filePath;
}

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
		expect(text).toContain("<<< ours  HEAD");
		expect(text).toContain(">>> theirs  feature/x");
		expect(text).toContain("──── #1  L2-6  git ────");
		expect(text).toContain("NOTICE: Git terms");
		expect(text).toContain('`write({ path: "conflict://<N>", content })`');
		expect(text).toContain("@ours");
		// Registered on session.
		const history = session.conflictHistory;
		expect(history).toBeInstanceOf(ConflictHistory);
		expect(history?.get(1)?.absolutePath).toBe(filePath);
	});

	it("recognizes Jujutsu diff-style markers and reconstructs both sides", async () => {
		const filePath = path.join(tempDir, "jj.txt");
		await Bun.write(filePath, JJ_DIFF);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-jj", { path: "jj.txt" });
		const text = getText(result);
		expect(text).toContain("jj-diff");
		expect(text).toContain("+++ side/1  left change");
		expect(text).toContain("name = left");
		expect(text).toContain("+++ side/2  right change");
		expect(text).toContain("--- base/1  merge base");
	});

	it("registers diff3 conflicts with base section", async () => {
		const filePath = path.join(tempDir, "three.ts");
		await Bun.write(filePath, THREE_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-three", { path: "three.ts" });
		const text = getText(result);
		expect(text).toContain("=== base  common ancestor");
		expect(session.conflictHistory?.get(1)?.baseLines).toEqual(["base body"]);
	});

	it("registers each block with its own id when several appear in one window", async () => {
		const filePath = path.join(tempDir, "two-blocks.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-two", { path: "two-blocks.ts" });
		const text = getText(result);
		expect(text).toContain("──── #1  L1-5  git ────");
		expect(text).toContain("──── #2  L7-11  git ────");
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

	it("does not treat marker examples in a clean repository as conflicts", async () => {
		await $`git init -q`.cwd(tempDir).quiet();
		const filePath = path.join(tempDir, "example.md");
		await Bun.write(filePath, `Example:\n\n${THREE_WAY}`);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-marker-example", { path: "example.md" });
		const text = getText(result);
		expect(text).toContain("<<<<<<< HEAD");
		expect(text).not.toContain("conflict://");
		expect(session.conflictHistory).toBeUndefined();
	});

	it("keeps Git parsing when ours starts with a Jujutsu-looking marker", async () => {
		const filePath = await createGitConflict(tempDir, "git-marker-content.txt");
		await Bun.write(
			filePath,
			[
				"<<<<<<< HEAD",
				"+++++++ patch",
				"left",
				"=======",
				"right",
				">>>>>>> left",
				"<<<<<<< conflict example",
				"+++++++ side one",
				"example left",
				"+++++++ side two",
				"example right",
				">>>>>>> conflict example ends",
				"",
			].join("\n"),
		);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		await read.execute("read-git-marker-content", { path: "git-marker-content.txt:conflicts" });
		const entry = session.conflictHistory?.get(1);
		expect(entry?.authority).toBe("git");
		expect(entry?.style).toBe("git");
		expect(entry?.sides?.map(section => section.lines)).toEqual([["+++++++ patch", "left"], ["right"]]);
		expect(session.conflictHistory?.get(2)).toBeUndefined();
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

	it("renders the Git theirs side via `conflict://<N>/theirs`", async () => {
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

	it("renders the Git base via `/base`", async () => {
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

	it("rejects an unavailable Git base", async () => {
		const filePath = path.join(tempDir, "no-base.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		await read.execute("read-no-base-init", { path: "no-base.ts" });
		const promise = read.execute("read-no-base", { path: "conflict://1/base" });
		await expect(promise).rejects.toThrow(/0 bases/);
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

	it("`:conflicts` refuses binary marker content", async () => {
		const filePath = path.join(tempDir, "binary-conflict.bin");
		await Bun.write(filePath, "<<<<<<<\nours\u0000bytes\n=======\ntheirs\n>>>>>>>\n");
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-binary-conflicts", { path: "binary-conflict.bin:conflicts" });
		expect(getText(result)).toContain("binary file");
		expect(session.conflictHistory).toBeUndefined();
	});

	it("`:conflicts` reports side/base arity", async () => {
		const filePath = path.join(tempDir, "diff3.ts");
		await Bun.write(filePath, THREE_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-diff3", { path: "diff3.ts:conflicts" });
		const text = getText(result);
		expect(text).toMatch(/#1\s+L2-8.*2 sides, 1 base, git/);
	});

	it("`:conflicts` on a clean file says so explicitly", async () => {
		const filePath = path.join(tempDir, "clean-conflicts.ts");
		await Bun.write(filePath, "const a = 1;\nconst b = 2;\n");
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-clean-conflicts", { path: "clean-conflicts.ts:conflicts" });
		const text = getText(result);
		expect(text).toContain("No unresolved conflict markers");
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

		expect(getText(result)).toContain("Resolved materialized conflict hunk #1");
		const after = await Bun.file(filePath).text();
		expect(after).toBe("line 1\nnewApi(x);\nline N\n");
		// History is invalidated after resolve so the id no longer works.
		expect(session.conflictHistory?.get(1)).toBeUndefined();
	});

	it("revalidates Git conflict authority immediately before writing", async () => {
		const filePath = await createGitConflict(tempDir, "stale.txt");
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-stale-git", { path: "stale.txt" });
		expect(session.conflictHistory?.get(1)?.authority).toBe("git");
		await $`git add stale.txt`.cwd(tempDir).quiet();

		await expect(write.execute("write-stale-git", { path: "conflict://1", content: "@ours" })).rejects.toThrow(
			/no longer recorded/,
		);
		expect(await Bun.file(filePath).text()).toContain("<<<<<<<");
	});

	it.skipIf(process.platform === "win32")(
		"preserves a conflicted tracked symlink path during authority lookup",
		async () => {
			await $`git init -q -b main`.cwd(tempDir).quiet();
			await $`git config user.name "Conflict Test"`.cwd(tempDir).quiet();
			await $`git config user.email conflict-test@example.test`.cwd(tempDir).quiet();
			await Promise.all(["base", "left", "right"].map(name => Bun.write(path.join(tempDir, name), `${name}\n`)));
			const linkPath = path.join(tempDir, "link");
			await fs.symlink("base", linkPath);
			await $`git add --all`.cwd(tempDir).quiet();
			await $`git commit -qm base`.cwd(tempDir).quiet();
			await $`git checkout -qb left`.cwd(tempDir).quiet();
			await fs.unlink(linkPath);
			await fs.symlink("left", linkPath);
			await $`git commit -qam left`.cwd(tempDir).quiet();
			await $`git checkout -q main`.cwd(tempDir).quiet();
			await fs.unlink(linkPath);
			await fs.symlink("right", linkPath);
			await $`git commit -qam right`.cwd(tempDir).quiet();
			expect((await $`git merge left`.cwd(tempDir).quiet().nothrow()).exitCode).not.toBe(0);

			expect(await inspectConflictAuthority(linkPath)).toEqual({
				state: "recorded",
				backend: "git",
				kind: "other",
			});
		},
	);

	it("reports the Git staging requirement after authoritative bulk resolution", async () => {
		const filePath = await createGitConflict(tempDir, "bulk-git.txt");
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-bulk-git", { path: "bulk-git.txt" });
		const result = await write.execute("write-bulk-git", { path: "conflict://*", content: "@ours" });

		expect(getText(result)).toContain("Git index entries remain unmerged");
		expect(await Bun.file(filePath).text()).not.toContain("<<<<<<<");
	});

	it("uses the materialized Git marker size after attributes change", async () => {
		const filePath = await createGitConflict(tempDir, "short-markers.txt", 3);
		await Bun.write(path.join(tempDir, ".gitattributes"), "short-markers.txt conflict-marker-size=9\n");
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		const readResult = await read.execute("read-short-git", { path: "short-markers.txt" });
		expect(getText(readResult)).toContain("conflict://<N>");
		expect(session.conflictHistory?.get(1)?.markerLength).toBe(3);
		await write.execute("write-short-git", { path: "conflict://1", content: "@ours" });
		expect(await Bun.file(filePath).text()).toBe("right\n");
	});

	it("ignores shorter marker-shaped content when Git uses the default marker length", async () => {
		const filePath = await createGitConflict(tempDir, "marker-lookalike.txt");
		const shortBlock = ["<<< example", "keep left", "===", "keep right", ">>> example"].join("\n");
		await Bun.write(filePath, `${shortBlock}\n${await Bun.file(filePath).text()}`);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-marker-lookalike", { path: "marker-lookalike.txt:conflicts" });
		expect(session.conflictHistory?.entries()).toHaveLength(1);
		await write.execute("write-marker-lookalike", { path: "conflict://*", content: "@ours" });
		expect(await Bun.file(filePath).text()).toBe(`${shortBlock}\nright\n`);
	});

	it("resolves a Jujutsu diff-style hunk by indexed side", async () => {
		const filePath = path.join(tempDir, "jj.txt");
		await Bun.write(filePath, JJ_DIFF);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-jj-write", { path: "jj.txt" });
		await write.execute("write-jj-side", { path: "conflict://1", content: "@side/1" });
		expect(await Bun.file(filePath).text()).toBe(["before", "value = 1", "name = left", "after", ""].join("\n"));
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
			content: "@side/2",
		});

		const text = getText(result);
		expect(text).toContain("Resolved materialized conflict hunk #1");
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
			content: "@side/1",
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
			content: "1: @side/1\n2: combined line A\ncombined line B\n",
		});
		await expect(promise).rejects.toThrow(/Malformed `conflict:\/\/\*` per-id block/);
		// File untouched — the markers are still present, nothing leaked.
		expect(await Bun.file(filePath).text()).toBe(original);
		// Ids stay registered for a corrected retry.
		expect(session.conflictHistory?.get(1)).toBeDefined();
		expect(session.conflictHistory?.get(2)).toBeDefined();
	});

	it("rejects a per-id line whose value is not a recognized term token", async () => {
		const filePath = path.join(tempDir, "directives-badtoken.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-directives-badtoken", { path: "directives-badtoken.ts" });
		const promise = write.execute("write-directives-badtoken", {
			path: "conflict://*",
			content: "1: @side/1\n2: @mine",
		});
		await expect(promise).rejects.toThrow(/Per-id bulk only accepts Git/);
		expect(await Bun.file(filePath).text()).toBe(TWO_BLOCKS);
	});

	it("rejects literal uniform bulk replacement", async () => {
		const filePath = path.join(tempDir, "directives-literal.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-directives-literal", { path: "directives-literal.ts" });
		const promise = write.execute("write-directives-literal", {
			path: "conflict://*",
			content: "resolvedApi(x)\n",
		});
		await expect(promise).rejects.toThrow(/only accepts a shared Git/);
		expect(await Bun.file(filePath).text()).toBe(TWO_WAY);
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

	it("accepts Git named tokens as shorthand", async () => {
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

	it("rejects an unavailable Git base token", async () => {
		const filePath = path.join(tempDir, "nobase.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-nobase", { path: "nobase.ts" });
		const promise = write.execute("write-nobase", { path: "conflict://1", content: "@base" });
		await expect(promise).rejects.toThrow(/0 bases/);
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

	it("normalizes surrounding whitespace on a shared bulk term", async () => {
		const filePath = path.join(tempDir, "bulk-whitespace.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-bulk-whitespace", { path: "bulk-whitespace.ts:conflicts" });
		await write.execute("write-bulk-whitespace", {
			path: "conflict://*",
			content: " \n@ours\t ",
		});

		expect(await Bun.file(filePath).text()).toBe("line 1\noldApi(x)\nline N\n");
	});

	it("`write conflict://*` errors when no conflicts are registered", async () => {
		const session = createTestSession(tempDir);
		const write = await getTool(session, "write");
		await expect(write.execute("write-bulk-empty", { path: "conflict://*", content: "@side/1" })).rejects.toThrow(
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
		expect(getText(result)).toContain("Resolved materialized conflict hunk #1");
		const after = await Bun.file(filePath).text();
		expect(after).toBe("// extra line\n// another extra\nline 1\nnewApi(x)\nline N\n");
	});
});
