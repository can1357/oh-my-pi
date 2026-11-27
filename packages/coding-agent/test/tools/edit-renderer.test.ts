import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { editDiffString } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { createCheckoutNotice } from "../../src/edit/checkout-notice";
import { initWorktreeFixture } from "../helpers/git-worktree";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, getEditStore } from "@oh-my-pi/pi-coding-agent/edit";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { TempDir } from "@oh-my-pi/pi-utils";
import { editToolPresenter } from "../../src/ui/tools/edit";
import { printRows } from "../../src/ui/print-rows";
import { ToolBlock, ToolCall, type ToolCallResult } from "../../src/ui/transcript/tool-block";
import { toolCall } from "../helpers/tool-text";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

interface CardOptions {
	readonly editMode?: string;
	readonly expanded?: boolean;
	readonly width?: number;
	/** Extra render context the host threads (edit previews). */
	readonly context?: Readonly<Record<string, unknown>>;
	/** Wire tool name (default `edit`). */
	readonly name?: string;
}

/** The card's non-blank rows (escapes kept) for `call`. */
function rows(call: ToolCall, options: CardOptions): string[] {
	return printRows(() => ToolBlock({ call }), options.width ?? 160).filter(row => Bun.stripANSI(row).trim() !== "");
}

function plain(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}

/** An edit call whose args are still streaming. */
function streamingCall(args: unknown, options: CardOptions = {}): ToolCall {
	const call = new ToolCall({ id: "call-1", name: options.name ?? "edit", args });
	call.setRenderContext({ ...(options.editMode ? { editMode: options.editMode } : {}), ...options.context });
	if (options.expanded) call.setExpanded(true);
	return call;
}

/** The streaming call card's plain text. */
function callText(args: unknown, options: CardOptions = {}): string {
	return plain(rows(streamingCall(args, options), options)).join("\n");
}

/** The settled result card's non-blank rows (escapes kept). */
function resultRows(result: ToolCallResult, args: unknown, options: CardOptions = {}): string[] {
	const call = toolCall({
		name: options.name ?? "edit",
		args,
		result,
		expanded: options.expanded,
		renderContext: { ...(options.editMode ? { editMode: options.editMode } : {}), ...options.context },
	});
	return rows(call, options);
}

function makeEditSession(cwd: string) {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		settings: Settings.isolated({ "edit.enforceSeenLines": false }),
	};
}

function makeEditTool(cwd: string, mode: "replace" | "hashline" = "replace"): EditTool {
	return new EditTool(makeEditSession(cwd), mode);
}

describe("edit tool card", () => {
	it("names the edited Git worktree when it differs from the session checkout", async () => {
		using temp = TempDir.createSync("@omp-edit-checkout-");
		const { cwd, paths } = await initWorktreeFixture(temp, [{ name: "linked", branch: "preview" }]);
		const tool = makeEditTool(cwd, "replace");
		const target = path.join(paths.linked, "lesson.txt");
		const args = { path: target, old_string: "before", new_string: "after" };
		const result = await tool.execute("cross-worktree", args);
		const rendered = plain(resultRows(result, args, { editMode: "replace" })).join("\n");
		expect(rendered).toContain("Edited worktree: preview (session: main)");
		expect(await Bun.file(target).text()).toBe("after\n");
		expect(await Bun.file(path.join(cwd, "lesson.txt")).text()).toBe("before\n");

		const local = { ...args, path: "lesson.txt" };
		const localResult = await tool.execute("session-checkout", local);
		const localRendered = plain(resultRows(localResult, local, { editMode: "replace" })).join("\n");
		expect(localRendered).not.toContain("Edited worktree:");
		expect(await Bun.file(path.join(cwd, "lesson.txt")).text()).toBe("after\n");
	});

	it("detects cross-worktree edits through symlinked session cwd and file symlinks, but not symlink deletes", async () => {
		using temp = TempDir.createSync("@omp-edit-symlink-");
		const { cwd, paths } = await initWorktreeFixture(temp, [{ name: "linked", branch: "preview" }]);
		const aliasCwd = temp.join("alias");
		await fs.symlink(cwd, aliasCwd);

		// 1. Symlinked session cwd editing a sibling worktree
		const aliasTool = makeEditTool(aliasCwd, "replace");
		const target = path.join(paths.linked, "lesson.txt");
		const res1 = await aliasTool.execute("alias-edit", {
			path: target,
			old_string: "before",
			new_string: "via-alias",
		});
		expect(res1.details?.checkoutNotice).toBe("Edited worktree: preview (session: main)");

		// 2. Write through a file symlink in session checkout pointing into sibling worktree
		const linkPath = path.join(cwd, "link.txt");
		await fs.symlink(target, linkPath);
		const tool = makeEditTool(cwd, "replace");
		const res2 = await tool.execute("symlink-write", {
			path: "link.txt",
			old_string: "via-alias",
			new_string: "via-link",
		});
		expect(res2.details?.checkoutNotice).toBe("Edited worktree: preview (session: main)");
		expect(await Bun.file(target).text()).toBe("via-link\n");

		// 3. Deleting the symlink acts on the session checkout entry, not the sibling worktree
		const hashlineSession = makeEditSession(cwd);
		const hashlineTool = new EditTool(hashlineSession, "hashline");
		const linkTag = getEditStore(hashlineSession).recordSnapshot(linkPath, "via-link\n");
		const delRes = await hashlineTool.execute("symlink-delete", { input: `[link.txt#${linkTag}]\nREM\n` });
		expect(delRes.isError).toBeUndefined();
		expect(delRes.details?.checkoutNotice).toBeUndefined();
		expect(await fs.lstat(linkPath).catch(() => null)).toBeNull();
		expect(await Bun.file(target).exists()).toBe(true);
	});

	it("attributes both source and destination checkouts on cross-worktree moves", async () => {
		using temp = TempDir.createSync("@omp-edit-move-");
		const { cwd, paths } = await initWorktreeFixture(temp, [
			{ name: "preview", branch: "preview" },
			{ name: "release", branch: "release" },
		]);
		const session = makeEditSession(cwd);
		const tool = new EditTool(session, "hashline");

		// 1. Sibling B -> Sibling C
		const srcB = path.join(paths.preview, "lesson.txt");
		const dstC = path.join(paths.release, "moved-from-preview.txt");
		const tagB = getEditStore(session).recordSnapshot(srcB, "before\n");
		const resBC = await tool.execute("move-b-to-c", { input: `[${srcB}#${tagB}]\nMV ${dstC}\n` });
		expect(resBC.isError).toBeUndefined();
		expect(resBC.details?.checkoutNotice).toBe("Edited worktree: moved preview → release (session: main)");

		// 2. Sibling C -> Session A
		const dstA = path.join(cwd, "returned.txt");
		const tagC = getEditStore(session).recordSnapshot(dstC, "before\n");
		const resCA = await tool.execute("move-c-to-a", { input: `[${dstC}#${tagC}]\nMV ${dstA}\n` });
		expect(resCA.isError).toBeUndefined();
		expect(resCA.details?.checkoutNotice).toBe("Edited worktree: moved from release (session: main)");

		// 3. Session A -> Sibling B
		const tagA = getEditStore(session).recordSnapshot(dstA, "before\n");
		const resAB = await tool.execute("move-a-to-b", { input: `[${dstA}#${tagA}]\nMV ${srcB}\n` });
		expect(resAB.isError).toBeUndefined();
		expect(resAB.details?.checkoutNotice).toBe("Edited worktree: moved to preview (session: main)");
	});

	it("does not report a worktree edit on a hashline no-op", async () => {
		using temp = TempDir.createSync("@omp-edit-noop-");
		const { cwd, paths } = await initWorktreeFixture(temp, [{ name: "linked", branch: "preview" }]);
		const session = makeEditSession(cwd);
		const tool = new EditTool(session, "hashline");
		const target = path.join(paths.linked, "lesson.txt");
		const tag = getEditStore(session).recordSnapshot(target, "before\n");
		// Replacing line 1 with identical content succeeds as FileOp::Noop without writing.
		const res = await tool.execute("noop-edit", { input: `[${target}#${tag}]\nPUT 1.=1:\n+before\n` });
		expect(res.isError).toBeUndefined();
		expect(res.details?.checkoutNotice).toBeUndefined();
		const text = res.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).not.toContain("Edited worktree:");
	});

	it("preserves cross-worktree notice for a batched symlink MV even when a later REM deletes the referent", async () => {
		using temp = TempDir.createSync("@omp-edit-batch-symlink-mv-");
		const { cwd, paths } = await initWorktreeFixture(temp, [{ name: "linked", branch: "preview" }]);
		const session = makeEditSession(cwd);
		const tool = new EditTool(session, "hashline");

		const src = path.join(cwd, "lesson.txt");
		const siblingTarget = path.join(paths.linked, "lesson.txt");
		const dstLink = path.join(cwd, "dest-link.txt");
		await fs.symlink(siblingTarget, dstLink);

		const store = getEditStore(session);
		const srcTag = store.recordSnapshot(src, "before\n");
		const targetTag = store.recordSnapshot(siblingTarget, "before\n");

		const res = await tool.execute("batch-symlink-mv-rem", {
			input: `[lesson.txt#${srcTag}]\nMV dest-link.txt\n[${siblingTarget}#${targetTag}]\nREM\n`,
		});
		expect(res.isError).toBeUndefined();
		expect(res.details?.perFileResults).toHaveLength(2);
		expect(res.details?.perFileResults?.[0]?.checkoutNotice).toBe(
			"Edited worktree: moved to preview (session: main)",
		);
		expect(res.details?.perFileResults?.[1]?.checkoutNotice).toBe("Edited worktree: preview (session: main)");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not fail a completed edit when session HEAD is unreadable during checkout attribution", async () => {
		using temp = TempDir.createSync("@omp-edit-unreadable-head-");
		const { cwd, paths } = await initWorktreeFixture(temp, [{ name: "linked", branch: "preview" }]);
		const target = path.join(paths.linked, "lesson.txt");

		// 1. Real GitRepo::headSync() failure when HEAD disappears after discovery.
		const notice = createCheckoutNotice(cwd);
		expect(notice).toBeDefined();
		await fs.rm(path.join(cwd, ".git", "HEAD"));
		expect(notice?.({ path: target })).toBeUndefined();

		// Restore HEAD and verify EditTool.execute still succeeds if headSync() throws after write.
		await Bun.write(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
		const originalGit = vcs.git;
		vi.spyOn(vcs, "git").mockImplementation(dir => {
			const repo = originalGit(dir);
			if (!repo || dir !== cwd) return repo;
			return Object.assign(Object.create(Object.getPrototypeOf(repo)), repo, {
				info: () => repo.info(),
				headSync: () => {
					throw new Error("HEAD unreadable");
				},
			});
		});

		const tool = makeEditTool(cwd, "replace");
		const res = await tool.execute("unreadable-head", {
			path: target,
			old_string: "before",
			new_string: "after",
		});
		expect(res.isError).toBeUndefined();
		expect(res.details?.checkoutNotice).toBeUndefined();
		expect(await Bun.file(target).text()).toBe("after\n");
	});

	it("shows the target path from partial JSON while edit args stream", () => {
		const rendered = callText(
			{ __partialJson: '{"path":"packages/coding-agent/src/edit/renderer.ts","old_string":"before' },
			{ editMode: "replace" },
		);
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
	});

	it("does not report a leading blank line as hidden content", () => {
		const rendered = callText(
			{ file_path: "/tmp/leading-blank.ts", previewDiff: "\n+1|first-added\n+2|second-added" },
			{ editMode: "replace", width: 200 },
		);
		expect(rendered).toContain("first-added");
		expect(rendered).toContain("second-added");
		expect(rendered).not.toContain("content above");
	});

	it("keeps the newest lines of a huge streaming preview without counting the discarded prefix", () => {
		const diff = [
			"@@ -1,10000 +1,12 @@",
			...Array.from({ length: 10_000 }, (_, index) => `-hidden-line-${index + 1}`),
			...Array.from({ length: 12 }, (_, index) => `+visible-tail-${index + 1}`),
			"",
			"",
		].join("\n");
		const rendered = callText(
			{ file_path: "/tmp/large-preview.ts", previewDiff: diff },
			{ editMode: "replace", width: 200 },
		);
		expect(rendered).toContain("visible-tail-12");
		expect(rendered).not.toContain("hidden-line-10000");
		expect(rendered).not.toContain("more hunks");
	});

	it("uses hashline input headers for streaming call path without apply_patch errors", () => {
		const rendered = callText(
			{ input: "[packages/coding-agent/src/edit/renderer.ts]\nPUT >$:\n+// preview" },
			{ editMode: "hashline" },
		);
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(rendered).not.toContain("The first line of the patch must be");
	});

	it("counts extra sloppy sections in the streaming call header", () => {
		const input = "*** Edit File: a.ts\n*** Find\nfoo\n*** Edit File: b.ts\n*** Find\nbar";
		const rendered = callText({ input }, { editMode: "sloppy" });
		expect(rendered).toContain("a.ts");
		expect(rendered).toContain("(+1 more)");
	});

	it("never serves lagged streamed header facts to final args or to another call", () => {
		const state = {
			expanded: false,
			isPartial: true,
			argsComplete: false,
			executionStarted: false,
			renderContext: { editMode: "hashline" },
		};
		const activity = editToolPresenter.activity!;
		const first = "[a.ts]\nPUT >$:\n+one\n";
		const grown = `${first}[b.ts]\nPUT >$:\n+two\n`;
		// The reveal hands over a fresh args object per frame; header facts may
		// lag behind the stream while it grows.
		expect(activity({ input: first, __partialJson: first } as never, state).detail).toContain("a.ts");
		activity({ input: grown, __partialJson: grown } as never, state);
		// Final args (no raw stream prefix) always derive exact facts.
		expect(activity({ input: grown } as never, { ...state, isPartial: false, argsComplete: true }).detail).toContain(
			"(+1 more)",
		);

		const other = "[c.ts]\nPUT >$:\n+three\n";
		activity({ input: first, __partialJson: first } as never, state);
		// A payload that does not extend the cached one is another call: exact facts.
		const summary = activity({ input: other, __partialJson: other } as never, state);
		expect(summary.detail).toContain("c.ts");
		expect(summary.detail).not.toContain("a.ts");
	});

	it("shows hashline envelope target path while preview diff is not computable yet", () => {
		const rendered = callText(
			{
				input: [
					"*** Begin Patch",
					"[crates/natives/src/shell.rs]",
					"PUT >$:",
					"+pub fn streaming_preview() {",
				].join("\n"),
			},
			{ editMode: "hashline" },
		);
		expect(rendered).toContain("crates/natives/src/shell.rs");
		expect(rendered).not.toContain("PUT >$:");
		expect(rendered).not.toContain("*** Begin Patch");
	});

	it("recognizes compact and quoted hashline input headers", () => {
		const compact = callText(
			{ input: "[foo bar.ts]\nPUT <1:\n+// preview" },
			{ editMode: "hashline", expanded: true },
		);
		const quoted = callText({ input: "['baz qux.ts']\nPUT <1:\n+// preview" }, { editMode: "hashline" });
		expect(compact).toContain("foo bar.ts");
		expect(quoted).toContain("baz qux.ts");
	});

	it("strips bracket delimiters from hashline input headers", () => {
		// Canonical `[PATH]` form — the parser strips the delimiters.
		const canonical = callText(
			{ input: "[packages/coding-agent/src/slash-commands/builtin-registry.ts]\nPUT <1:\n+// preview" },
			{ editMode: "hashline", expanded: true },
		);
		// While streaming, the closing bracket may not have arrived yet.
		const partial = callText({ input: "[a/b/c.ts\nPUT <1:\n+// preview" }, { editMode: "hashline", expanded: true });

		expect(canonical).toContain("packages/coding-agent/src/slash-commands/builtin-registry.ts");
		expect(canonical).not.toMatch(/\[packages\/coding-agent/);
		expect(partial).toContain("a/b/c.ts");
		expect(partial).not.toMatch(/\[a\/b\/c\.ts/);
	});

	it("uses hashline input headers for completed single-file result path", () => {
		const rendered = plain(
			resultRows(
				{
					content: [{ type: "text", text: "Updated packages/coding-agent/src/edit/renderer.ts" }],
					details: { diff: "+1|// preview", op: "update" },
				},
				{ input: "[packages/coding-agent/src/edit/renderer.ts]\nPUT >$:\n+// preview" },
				{ editMode: "hashline" },
			),
		).join("\n");
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
	});

	it("omits changed-line suffixes from completed edit headers and middle-elides long paths", () => {
		const result: ToolCallResult = {
			content: [{ type: "text", text: "Updated transcript-container.test.ts" }],
			details: {
				diff: "+1│const value = 2;",
				firstChangedLine: 251,
				op: "update",
				path: "/tmp/project/packages/coding-agent/test/modes/components/transcript-container.test.ts",
			},
		};
		const args = { file_path: "packages/coding-agent/test/modes/components/transcript-container.test.ts" };

		const wideHeader = plain(resultRows(result, args, { editMode: "hashline", width: 160 }))[0]!;
		expect(wideHeader).toContain("packages/coding-agent/test/modes/components/transcript-container.test.ts");
		expect(wideHeader).not.toContain(":251");

		const narrowHeader = plain(resultRows(result, args, { editMode: "hashline", width: 72 }))[0]!;
		expect(narrowHeader).toContain("…");
		expect(narrowHeader).toContain("container.test.ts");
		expect(narrowHeader).not.toContain(":251");
	});

	it("draws a hashline edit's streamed preview diff once it finishes streaming", () => {
		const content = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
		const updated = content.replace("export const b = 2;", "export const b = 22;");
		const preview = editDiffString(content, updated, "/tmp/memory.ts");
		const call = streamingCall(
			{ input: "[memory.ts#ABCD]\nPUT 2-2:\n+export const b = 22;" },
			{ editMode: "hashline" },
		);
		call.updateStreamPreview({
			generation: 1,
			streaming: false,
			files: [{ path: "/tmp/memory.ts", diff: preview.diff, firstChangedLine: preview.firstChangedLine }],
		});
		const rendered = plain(rows(call, {})).join("\n");
		expect(rendered).toContain("export const b = 22;");
		expect(rendered).not.toContain("No changes would be made");
	});

	it("draws a streamed preview for raw hashline input carried only in partialJson", () => {
		const content = "export const a = 1;\nexport const b = 2;\n";
		const updated = content.replace("export const b = 2;", "export const b = 22;");
		const preview = editDiffString(content, updated, "/tmp/memory.ts");
		const call = streamingCall(
			{ __partialJson: "[memory.ts#ABCD]\nPUT 2-2:\n+export const b = 22;\n" },
			{ editMode: "hashline" },
		);
		call.updateStreamPreview({
			generation: 1,
			streaming: true,
			files: [{ path: "/tmp/memory.ts", diff: preview.diff, firstChangedLine: preview.firstChangedLine }],
		});
		expect(plain(rows(call, {})).join("\n")).toContain("export const b = 22;");
	});

	it("renders native apply_patch preview batches", () => {
		const preview = editDiffString("const value = 1;\n", "const value = 2;\n", "src/demo.ts");
		const call = streamingCall({ input: "*** Begin Patch" }, { editMode: "apply_patch" });
		call.updateStreamPreview({
			generation: 1,
			streaming: true,
			files: [{ path: "src/demo.ts", diff: preview.diff, firstChangedLine: preview.firstChangedLine }],
		});
		expect(plain(rows(call, {})).join("\n")).toContain("const value = 2;");
	});

	it("uses raw replacement text only as the replace-mode streaming fallback", () => {
		expect(callText({ file_path: "a.ts", new_string: "plain streamed text" }, { editMode: "replace" })).toContain(
			"plain streamed text",
		);
		expect(callText({ input: "plain streamed text" }, { editMode: "hashline" })).not.toContain("plain streamed text");
	});

	it("sanitizes the replace-mode streaming text", () => {
		const call = streamingCall(
			{ file_path: "a.ts", new_string: "l1\r\nl2\x07\nl3\x1b[2J\n" },
			{ editMode: "replace" },
		);
		const raw = rows(call, {}).join("\n");
		expect(raw).not.toContain("\x07");
		expect(raw).not.toContain("\x1b[2J");
		expect(raw).not.toContain("\r");
		expect(Bun.stripANSI(raw)).toContain("l2");
	});

	it("renders change stats inline on the result header with no separate metadata or stats row", () => {
		const diff = [" 115│ ctx", "-116│ old", "+117│ new one", "+118│ new two"].join("\n");
		const lines = plain(
			resultRows(
				{ content: [{ type: "text", text: "Updated demo.go" }], details: { diff, op: "update" } },
				{ file_path: "demo.go" },
				{ editMode: "hashline" },
			),
		);
		// Stats ride on the header line next to the path…
		expect(lines[0]).toContain("demo.go");
		expect(lines[0]).toContain("+2");
		expect(lines[0]).toContain("-1");
		// …only there (no standalone stats row), and the diff starts right below the header.
		expect(lines[1]).toContain("115│ ctx");
		expect(lines.filter(line => line.includes("+2") && line.includes("-1"))).toHaveLength(1);
	});

	it("bounds a completed diff that contains one oversized change hunk", () => {
		const diff = Array.from({ length: 1_000 }, (_, i) => `+${i + 1}│line ${i}`).join("\n");
		const rendered = plain(
			resultRows(
				{ content: [{ type: "text", text: "Updated demo.ts" }], details: { diff, op: "update" } },
				{ file_path: "demo.ts" },
				{ editMode: "hashline" },
			),
		).join("\n");
		expect(rendered).not.toContain("line 999");
		expect(rendered).toContain("more lines");
	});

	it("keeps completed edit rows at the card width", () => {
		const lines = plain(
			resultRows(
				{
					content: [{ type: "text", text: "Updated demo.ts" }],
					details: {
						diff: "+1│const renamedIdentifier = computeValueFromSomeVeryLongInputName();",
						op: "update",
					},
				},
				{ file_path: "demo.ts" },
				{ editMode: "hashline", width: 48 },
			),
		);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.every(line => visibleWidth(line) <= 48)).toBe(true);
	});

	it("does not leak the first file's no-change preview into a multi-file delete result", () => {
		const paths = ["scripts/a.ts", "scripts/a.user.md", "scripts/a.system.md"];
		const rendered = plain(
			resultRows(
				{
					content: [{ type: "text", text: paths.map(p => `Deleted ${p}`).join("\n") }],
					details: {
						diff: "",
						perFileResults: paths.map(path => ({ path, diff: "", op: "delete" as const, oldText: "x\n" })),
					},
				},
				{},
				{
					editMode: "hashline",
					// The streaming preview only ever holds the first file's result; a
					// delete card must not fall back to it.
					context: { editDiffPreview: { error: "No changes would be made to scripts/a.ts." } },
				},
			),
		).join("\n");
		expect(rendered).toContain("Delete");
		expect(rendered).not.toContain("No changes would be made");
		for (const path of paths) expect(rendered).toContain(path);
	});

	it("renders a move-only result as source → destination with no diff body", () => {
		const lines = plain(
			resultRows(
				{
					content: [{ type: "text", text: "Moved a.ts to b.ts" }],
					details: { diff: "", op: "update", path: "b.ts", move: "b.ts", sourcePath: "a.ts" },
				},
				{ input: "[a.ts#1a2b]\nMV b.ts" },
				{ editMode: "hashline", context: { editDiffPreview: { error: "No changes would be made to other.ts." } } },
			),
		);
		// The head shows the move as source → destination, not dest → dest.
		expect(lines[0]).toContain("a.ts");
		expect(lines[0]).toContain("b.ts");
		expect(lines[0]).toContain("→");
		expect(lines.join("\n")).not.toContain("No changes");
	});

	it("uses the result's own path for a genuine no-op, not the shared preview", () => {
		const rendered = plain(
			resultRows(
				{
					content: [{ type: "text", text: "no change" }],
					details: { diff: "", op: "update", path: "scripts/real.ts" },
				},
				{ file_path: "scripts/real.ts" },
				{
					editMode: "hashline",
					context: { editDiffPreview: { error: "No changes would be made to scripts/WRONG.ts." } },
				},
			),
		).join("\n");
		expect(rendered).toContain("No changes were made");
		expect(rendered).toContain("scripts/real.ts");
		expect(rendered).not.toContain("WRONG");
	});
});

describe("edit tool card diff line wrapping", () => {
	/** A completed single-line replacement (`-N|old` + `+N|new`), expanded. */
	function singleLineReplacement(oldLine: string, newLine: string, width: number): string[] {
		return resultRows(
			{
				content: [{ type: "text", text: "Updated demo.ts" }],
				details: { diff: `-42|${oldLine}\n+42|${newLine}`, op: "update", path: "demo.ts" },
			},
			{ file_path: "demo.ts" },
			{ expanded: true, width },
		);
	}

	/** Net SGR inverse state after scanning a row; 38/48 extended-color args must not be misread as attribute 7. */
	function inverseActiveAtRowEnd(row: string): boolean {
		let inverse = false;
		for (const match of row.matchAll(/\x1b\[([0-9;]*)m/g)) {
			const params = match[1]!.split(";");
			for (let i = 0; i < params.length; i++) {
				const param = params[i];
				if (param === "38" || param === "48") {
					i += params[i + 1] === "2" ? 4 : params[i + 1] === "5" ? 2 : 0;
				} else if (param === "" || param === "0") inverse = false;
				else if (param === "7") inverse = true;
				else if (param === "27") inverse = false;
			}
		}
		return inverse;
	}

	it("keeps both sides of a wrapped single-line replacement in the diff", () => {
		const rows = plain(
			singleLineReplacement(
				"    the previous synopsis paragraph rambled across quarterly reconciliation notes enumerating every provisional ledger amendment the archival committee had deferred pending review by the regional custodians during the extended winter recess of the auditing season",
				"    the revised synopsis paragraph now catalogues seasonal festival logistics enumerating lantern shipments drum rehearsals and ribbon inventories that the parade stewards confirmed before dawn, closing with the zephyrQuota tally and the marbledFinale banner",
				100,
			),
		);
		const text = rows.join("\n");
		expect(text).toContain("auditing");
		expect(text).toContain("marbledFinale");
		expect(rows.every(row => visibleWidth(row) <= 100)).toBe(true);
	});

	it("renders ill-formed UTF-16 replacements natively", () => {
		const rows = plain(singleLineReplacement("alpha \ud800 beta", "alpha \ud801 beta", 100));
		expect(rows.some(row => row.includes("42"))).toBe(true);
		expect(rows.some(row => row.includes("+"))).toBe(true);
	});

	it("closes inverse video at every wrapped row end so frame padding stays uninverted", () => {
		const rows = singleLineReplacement(
			"    stanza recounts venerable chronicle passages spanning bygone dynasties whose archivists engraved ledgers onto vellum scrolls",
			"    stanza celebrates luminous festival processions winding through lantern boulevards while drummers herald jubilant choruses beneath cascading ribbons and fireworks",
			100,
		);
		for (const row of rows) expect(inverseActiveAtRowEnd(row)).toBe(false);
	});

	/** An expanded failed edit's rows. */
	function errorRows(errorText: string): string[] {
		return plain(
			resultRows(
				{
					content: [{ type: "text", text: errorText }],
					details: { diff: "", op: "update", path: "demo.ts" },
					isError: true,
				},
				{ file_path: "demo.ts" },
				{ expanded: true, width: 100 },
			),
		);
	}

	it.each([
		"| pipe-leading diagnostic output that is quite long and should certainly wrap at the render width because it keeps going on and on with more words than fit in one row of the frame",
		"   | indented bare-pipe diagnostic output that is quite long and should certainly wrap at the render width because it keeps going on and on with more words than fit in one row of the frame",
		"123| numbered pipe-leading diagnostic output that is quite long and should certainly wrap at the render width because it keeps going on and on with more words than fit in one row of the frame",
	])("wraps pipe-ish error text generically instead of minting a diff gutter: %s", errorText => {
		const rows = errorRows(errorText);
		const body = rows.filter(row => /[a-z]/.test(row) && !row.includes("Edit"));
		// Precondition: the text actually wrapped.
		expect(body.length).toBeGreaterThanOrEqual(2);
		for (const row of body.slice(1)) expect(row).not.toMatch(/^[│\s]*\|/);
	});
});
