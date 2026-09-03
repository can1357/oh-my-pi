import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeFileHash, formatHashlineHeader, InMemorySnapshotStore } from "@oh-my-pi/hashline";
import { dropIncompleteLastEdit, EDIT_MODE_STRATEGIES } from "@oh-my-pi/pi-coding-agent/edit";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("dropIncompleteLastEdit", () => {
	test("keeps all entries when partialJson is undefined", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		expect(dropIncompleteLastEdit(edits, undefined, "edits")).toEqual(edits);
	});

	test("keeps all entries when the trailing object is closed", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		const partial = '{"edits":[{"path":"a"},{"path":"b"}]}';
		expect(dropIncompleteLastEdit(edits, partial, "edits")).toEqual(edits);
	});

	test("drops the last entry when its closing } has not arrived", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		const partial = '{"edits":[{"path":"a"},{"path":"b"';
		expect(dropIncompleteLastEdit(edits, partial, "edits")).toEqual([{ path: "a" }]);
	});

	test("drops the last entry when a new {} has opened after the last close", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		const partial = '{"edits":[{"path":"a"},{"pat';
		expect(dropIncompleteLastEdit(edits, partial, "edits")).toEqual([{ path: "a" }]);
	});

	test("leaves empty edits alone", () => {
		expect(dropIncompleteLastEdit([], '{"edits":[', "edits")).toEqual([]);
	});
});

describe("hashline streaming preview (multi-section)", () => {
	const strategy = EDIT_MODE_STRATEGIES.hashline;
	const textA = "const a = 1;\nconst b = 2;\n";
	const textB = "export const c = 3;\n";
	let tmpDir: string;
	let fileA: string;
	let fileB: string;
	let snapshots: InMemorySnapshotStore;
	let headerA: string;
	let headerB: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-stream-"));
		fileA = path.join(tmpDir, "a.ts");
		fileB = path.join(tmpDir, "b.ts");
		await Bun.write(fileA, textA);
		await Bun.write(fileB, textB);
		// Snapshot tags are mandatory on every section (preview path mirrors
		// the apply path). Record each file's content under the absolute path
		// the section resolves to, then build tagged headers.
		snapshots = new InMemorySnapshotStore();
		headerA = formatHashlineHeader("a.ts", snapshots.record(fileA, textA));
		headerB = formatHashlineHeader("b.ts", snapshots.record(fileB, textB));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal, snapshots });

	test("keeps section A's preview when section B's header just arrived", async () => {
		const input = [headerA, "PUT <1:", "+// new", headerB].join("\n");
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir) as never);
		expect(previews).not.toBeNull();
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.path).toBe("a.ts");
		expect(previews?.[0]?.diff).toBeTruthy();
		expect(previews?.[0]?.error).toBeUndefined();
	});

	test("ignores parse errors from the trailing in-progress section", async () => {
		// `7:bad` has invalid payload — the trailing section is still being typed.
		const input = [headerA, "PUT <1:", "+// new", headerB, "7:bad"].join("\n");
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir) as never);
		expect(previews).not.toBeNull();
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.path).toBe("a.ts");
		expect(previews?.[0]?.diff).toBeTruthy();
	});

	test("renders both sections once each has at least one valid op", async () => {
		const input = [headerA, "PUT <1:", "+// new a", headerB, "PUT <1:", "+// new b"].join("\n");
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir) as never);
		expect(previews).toHaveLength(2);
		expect(previews?.map(p => p.path).sort()).toEqual(["a.ts", "b.ts"]);
		for (const p of previews ?? []) {
			expect(p.diff).toBeTruthy();
			expect(p.error).toBeUndefined();
		}
	});
});

describe("hashline streaming preview (single-op trailing payload)", () => {
	const strategy = EDIT_MODE_STRATEGIES.hashline;
	const text = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
	let tmpDir: string;
	let file: string;
	let snapshots: InMemorySnapshotStore;
	let header: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-stream-single-"));
		file = path.join(tmpDir, "a.ts");
		await Bun.write(file, text);
		snapshots = new InMemorySnapshotStore();
		header = formatHashlineHeader("a.ts", snapshots.record(file, text));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	const ctx = (cwd: string, isStreaming = true) => ({
		cwd,
		signal: new AbortController().signal,
		snapshots,
		isStreaming,
	});

	test("renders a live diff while the sole payload line is still being typed", async () => {
		// The `+` payload has no trailing newline — the common single-op case
		// the trailing-line trim used to erase, collapsing the preview to a
		// "No changes" error that rendered as a blank box for the whole stream.
		const input = `${header}\nPUT 2-2:\n+const b = 22`;
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir) as never);
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.error).toBeUndefined();
		expect(previews?.[0]?.diff).toContain("const b = 22");
	});

	test("does not surface stale hash errors while streaming", async () => {
		const input = "[a.ts#FFFF]\nPUT 2-2:\n+const b = 22";
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir) as never);
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.error).toBeUndefined();
		expect(previews?.[0]?.diff).toContain("const b = 22");
	});

	test("final preview accepts a live content hash even when the snapshot store has no history", async () => {
		const liveHeader = formatHashlineHeader("a.ts", computeFileHash(text));
		const input = `${liveHeader}\nPUT 2-2:\n+const b = 22\n`;
		const previews = await strategy.computeDiffPreview(
			{ input } as never,
			{
				cwd: tmpDir,
				signal: new AbortController().signal,
				snapshots: new InMemorySnapshotStore(),
				isStreaming: false,
			} as never,
		);
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.error).toBeUndefined();
		expect(previews?.[0]?.diff).toContain("const b = 22");
	});

	test("final preview recovers a stale tag from snapshot history", async () => {
		await Bun.write(file, `// external\n${text}`);
		const input = `${header}\nPUT 2-2:\n+const b = 22\n`;
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir, false) as never);
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.error).toBeUndefined();
		expect(previews?.[0]?.diff).toContain("const b = 22");
	});

	test("surfaces stale hash errors once streaming is complete", async () => {
		const input = "[a.ts#FFFF]\nPUT 2-2:\n+const b = 22\n";
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir, false) as never);
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.error).toContain("not from this session");
	});

	test("yields no preview (not an error) before the first payload byte arrives", async () => {
		// Op header typed, payload still empty: applyPartialTo drops the
		// payload-less op so nothing changes yet. The preview must report null
		// (preserving any prior frame), never a 'No changes' error that wipes it.
		const input = `${header}\nPUT 2-2:\n`;
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir) as never);
		expect(previews).toBeNull();
	});
});

describe("hashline streaming preview (monotonic growth)", () => {
	const strategy = EDIT_MODE_STRATEGIES.hashline;
	// A 20-line body whose rows repeat the same `}` / `old(n)` tokens the
	// payload also contains. A whole-file Myers re-diff greedily matches those
	// shared rows, scattering the in-flight `+` lines through the removed block
	// and making the renderer's pinned tail window stutter as additions jump
	// between hunks. The natural-order streaming builder must instead keep the
	// removed block fixed and only append `+` rows as the payload grows.
	const body = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? "\t}" : `\told(${i})`)).join("\n");
	const text = `head\n${body}\ntail\n`;
	const payload = ["func f() {", "\tx := 1", "\t}", "\treturn x", "}"];
	let tmpDir: string;
	let file: string;
	let snapshots: InMemorySnapshotStore;
	let header: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-stream-mono-"));
		file = path.join(tmpDir, "a.go");
		await Bun.write(file, text);
		snapshots = new InMemorySnapshotStore();
		header = formatHashlineHeader("a.go", snapshots.record(file, text));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal, snapshots, isStreaming: true });
	// Replace the 20-line body (lines 2..21) with the first `n` payload rows.
	const buildInput = (n: number) =>
		`${header}\nPUT 2-21:\n${payload
			.slice(0, n)
			.map(l => `+${l}`)
			.join("\n")}`;

	test("each streamed chunk extends the prior diff instead of reshuffling it", async () => {
		let prev = "";
		for (let n = 1; n <= payload.length; n++) {
			const previews = await strategy.computeDiffPreview({ input: buildInput(n) } as never, ctx(tmpDir) as never);
			const diff = previews?.[0]?.diff ?? "";
			// The `+` rows are exactly the payload typed so far, in order — never
			// buried inside the removed block.
			const added = diff
				.split("\n")
				.filter(l => l.startsWith("+"))
				.map(l => l.replace(/^\+\d+\|/, ""));
			expect(added).toEqual(payload.slice(0, n));
			// The whole removed range is shown as a stable leading `-` block.
			const removed = diff.split("\n").filter(l => l.startsWith("-"));
			expect(removed).toHaveLength(20);
			// Monotonic: every prior frame is a byte-for-byte prefix of this one,
			// so the renderer's bottom-pinned window only ever grows downward.
			if (prev) expect(diff.startsWith(prev)).toBe(true);
			prev = diff;
		}
	});
});

describe("apply_patch streaming preview (trailing partial line)", () => {
	const strategy = EDIT_MODE_STRATEGIES.apply_patch;
	let tmpDir: string;
	let file: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "applypatch-stream-"));
		file = path.join(tmpDir, "a.ts");
		await Bun.write(file, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	const ctx = (cwd: string, isStreaming: boolean) => ({
		cwd,
		signal: new AbortController().signal,
		isStreaming,
	});

	const buildEnvelope = (body: string) =>
		["*** Begin Patch", "*** Update File: a.ts", "@@", " const a = 1;", body].join("\n");

	test("ignores a half-typed trailing line while streaming", async () => {
		// Trailing line has no `\n` — would render as a flickering partial `+`.
		const partialAdd = buildEnvelope("-const b = 2;\n+const b = 22");
		const streaming = await strategy.computeDiffPreview({ input: partialAdd } as never, ctx(tmpDir, true) as never);
		const final = await strategy.computeDiffPreview({ input: partialAdd } as never, ctx(tmpDir, false) as never);
		const streamingDiff = streaming?.[0]?.diff ?? "";
		const finalDiff = final?.[0]?.diff ?? "";
		expect(streamingDiff).not.toContain("const b = 22");
		expect(finalDiff).toContain("const b = 22");
	});

	test("preserves model's typing order so existing `+added` lines don't reshuffle", async () => {
		// Frame A: model has typed `-b +b22`. Frame B: also typed `-c`. The non-
		// streaming unified diff coalesces removals to the top, which would
		// shift `+const b = 22;` down between frames. The streaming preview
		// must keep it at the same position so the user sees only growth at the
		// bottom.
		const frameA = buildEnvelope("-const b = 2;\n+const b = 22;\n");
		const frameB = buildEnvelope("-const b = 2;\n+const b = 22;\n-const c = 3;\n");
		const a = await strategy.computeDiffPreview({ input: frameA } as never, ctx(tmpDir, true) as never);
		const b = await strategy.computeDiffPreview({ input: frameB } as never, ctx(tmpDir, true) as never);
		const linesA = (a?.[0]?.diff ?? "").split("\n");
		const linesB = (b?.[0]?.diff ?? "").split("\n");
		const posA = linesA.findIndex(l => l.includes("const b = 22;"));
		const posB = linesB.findIndex(l => l.includes("const b = 22;"));
		expect(posA).toBeGreaterThanOrEqual(0);
		expect(posB).toBe(posA);
		// New `-const c = 3;` appears strictly *after* the existing addition.
		const cIdx = linesB.findIndex(l => l.startsWith("-const c"));
		expect(cIdx).toBeGreaterThan(posB);
	});
});

describe("matcherDigest", () => {
	test("hashline: digests stripped `+` body rows only, never headers or op lines", () => {
		const input = ["[a.ts#AB12]", "PUT 1-2:", "+const x = 1;", "+const y = 2;", "CUT 5", ""].join("\n");
		expect(EDIT_MODE_STRATEGIES.hashline.matcherDigest({ input })).toBe("const x = 1;\nconst y = 2;");
	});

	test("hashline: grammar-only payload digests to empty, missing input to undefined", () => {
		expect(EDIT_MODE_STRATEGIES.hashline.matcherDigest({ input: "[a.ts#AB12]\nCUT 3\n" })).toBe("");
		expect(EDIT_MODE_STRATEGIES.hashline.matcherDigest({})).toBeUndefined();
	});

	test("apply_patch: digests added lines, never envelope markers or context", () => {
		const input = [
			"*** Begin Patch",
			"*** Update File: a.ts",
			"@@",
			" const a = 1;",
			"-const old = 1;",
			"+const fresh = 2;",
			"*** End Patch",
			"",
		].join("\n");
		expect(EDIT_MODE_STRATEGIES.apply_patch.matcherDigest({ input })).toBe("const fresh = 2;");
	});

	test("patch: digests added lines from diffs and passes create content through whole", () => {
		expect(
			EDIT_MODE_STRATEGIES.patch.matcherDigest({
				edits: [{ diff: " ctx\n-removed line\n+added line\n" }],
			}),
		).toBe("added line");
		expect(
			EDIT_MODE_STRATEGIES.patch.matcherDigest({
				edits: [{ op: "delete", diff: " ctx\n-removed line\n" }],
			}),
		).toBe("");
		const createContent = "full file content\nwith no diff markers\n";
		expect(
			EDIT_MODE_STRATEGIES.patch.matcherDigest({
				edits: [{ op: "create", diff: createContent }],
			}),
		).toBe(createContent);
	});

	test("replace: digests new_string", () => {
		expect(
			EDIT_MODE_STRATEGIES.replace.matcherDigest({
				path: "foo.ts",
				old_string: "a",
				new_string: "const b = 1;",
			}),
		).toBe("const b = 1;");
		expect(EDIT_MODE_STRATEGIES.replace.matcherDigest({})).toBeUndefined();
	});
});

describe("hashline streaming preview (tag-based path recovery)", () => {
	const strategy = EDIT_MODE_STRATEGIES.hashline;
	const text = "const a = 1;\nconst b = 2;\n";
	let tmpDir: string;
	let nestedFile: string;
	let snapshots: InMemorySnapshotStore;
	let header: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-recover-"));
		// The file lives in a nested dir; the model authored a bare `[mod.ts#tag]`
		// header (basename only), and the snapshot was recorded under the real
		// nested path when the file was read. cwd has no top-level mod.ts.
		nestedFile = path.join(tmpDir, "pkg", "src", "mod.ts");
		await Bun.write(nestedFile, text);
		snapshots = new InMemorySnapshotStore();
		header = formatHashlineHeader("mod.ts", snapshots.record(nestedFile, text));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	const ctx = (cwd: string, isStreaming: boolean) => ({
		cwd,
		signal: new AbortController().signal,
		snapshots,
		isStreaming,
	});

	test("streaming: recovers the bare header onto its nested file instead of blanking", async () => {
		const input = `${header}\nPUT 1-1:\n+const a = 99;`;
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir, true) as never);
		expect(previews).not.toBeNull();
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.error).toBeUndefined();
		expect(previews?.[0]?.diff).toContain("const a = 99;");
	});

	test("args-complete: recovers the bare header for the final Myers diff too", async () => {
		const input = `${header}\nPUT 1-1:\n+const a = 99;`;
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir, false) as never);
		expect(previews).not.toBeNull();
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.error).toBeUndefined();
		expect(previews?.[0]?.diff).toContain("const a = 99;");
	});

	test("no unique basename+tag match: surfaces the read error instead of recovering", async () => {
		// A header whose basename matches no retained snapshot path cannot recover;
		// the preview must report the failure rather than silently pick a file.
		const orphan = formatHashlineHeader("absent.ts", snapshots.record(nestedFile, text));
		const input = `${orphan}\nPUT 1-1:\n+const a = 99;`;
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir, false) as never);
		expect(previews).not.toBeNull();
		expect(previews?.[0]?.error).toBeTruthy();
	});
});
