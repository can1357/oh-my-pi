import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatHashlineHeader } from "@oh-my-pi/hashline";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	canonicalSnapshotKey,
	DEFAULT_FUZZY_THRESHOLD,
	EditTool,
	type EditToolDetails,
	executeHashlineSingle,
	executePatchSingle,
	executeReplace,
	getFileSnapshotStore,
	MAX_EDIT_SNAPSHOT_TEXT_CHARS,
	pruneOversizedEditSnapshots,
} from "@oh-my-pi/pi-coding-agent/edit";
import { writethroughNoop } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

const noopBeginDeferred = (_p: string) => ({
	onDeferredDiagnostics: () => {},
	signal: new AbortController().signal,
	finalize: () => {},
});

// 100 KB of line-broken content. Real code has line breaks, so the generated
// unified diff stays bounded — the bug under test is the unbounded
// `oldText`/`newText` snapshots that survived in `details`, not the diff.
const FILLER = `${"a line of content xxxx yyyy zzzz".repeat(20)}\n`.repeat(2_000);

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-snapshot-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

describe("pruneOversizedEditSnapshots", () => {
	test("returns input unchanged when combined snapshot is under the budget", () => {
		const oldText = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS / 2);
		const newText = "y".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS / 2);
		const details = { diff: "d", path: "/p", oldText, newText };
		expect(pruneOversizedEditSnapshots(details)).toBe(details);
	});

	test("drops oldText and newText when combined size exceeds the budget", () => {
		const oversized = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
		const result = pruneOversizedEditSnapshots({
			diff: "@@",
			path: "/p",
			firstChangedLine: 5,
			oldText: oversized,
			newText: oversized,
		});
		expect(result).toEqual({ diff: "@@", path: "/p", firstChangedLine: 5, snapshotsPruned: true });
		expect("oldText" in result).toBe(false);
		expect("newText" in result).toBe(false);
	});

	test("prunes snapshots inside perFileResults independently of the aggregate", () => {
		const oversized = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
		const small = "tiny";
		const result = pruneOversizedEditSnapshots({
			diff: "d",
			perFileResults: [
				{ path: "/big", diff: "d1", oldText: oversized, newText: oversized },
				{ path: "/small", diff: "d2", oldText: small, newText: small },
			],
		});
		expect(result.perFileResults?.[0]).toEqual({ path: "/big", diff: "d1", snapshotsPruned: true });
		expect(result.perFileResults?.[1]).toEqual({
			path: "/small",
			diff: "d2",
			oldText: small,
			newText: small,
		});
	});

	test("caps cumulative perFileResults snapshots at the shared aggregate budget", () => {
		// Each entry is individually under the per-entry budget but their sum
		// busts it: walking left-to-right, the first two fit, the rest must be
		// stripped so a many-small-files batch can't accumulate unbounded bytes.
		const entrySize = Math.floor(MAX_EDIT_SNAPSHOT_TEXT_CHARS / 4);
		const chunk = "y".repeat(entrySize);
		const entries = Array.from({ length: 5 }, (_, i) => ({
			path: `/f${i}`,
			diff: `d${i}`,
			oldText: chunk,
			newText: chunk,
		}));
		const result = pruneOversizedEditSnapshots({ diff: "agg", perFileResults: entries });

		const kept = result.perFileResults!.filter(e => e.oldText !== undefined);
		const pruned = result.perFileResults!.filter(e => e.snapshotsPruned === true);
		expect(kept.length).toBe(2);
		expect(pruned.length).toBe(3);

		// Total kept snapshot bytes never exceed the shared cap.
		const totalKept = result.perFileResults!.reduce(
			(acc, e) => acc + (e.oldText?.length ?? 0) + (e.newText?.length ?? 0),
			0,
		);
		expect(totalKept).toBeLessThanOrEqual(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
		// Pruned entries keep their diff/path so the renderer still works.
		expect(pruned[0]).toMatchObject({ path: "/f2", diff: "d2", snapshotsPruned: true });
	});
});

describe("executePatchSingle on oversized files", () => {
	test("prunes oldText / newText while keeping diff and path", async () => {
		await Bun.write(path.join(tempDir, "big.txt"), `${FILLER}anchor\n${FILLER}`);

		const result = await executePatchSingle({
			session: makeSession(tempDir),
			path: "big.txt",
			params: { op: "update", diff: "@@\n-anchor\n+ANCHOR" },
			allowFuzzy: true,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const details = result.details!;
		expect(details.path).toBe(path.join(tempDir, "big.txt"));
		expect(details.diff).toMatch(/-\d+\|anchor/);
		expect(details.diff).toMatch(/\+\d+\|ANCHOR/);
		expect(details.oldText).toBeUndefined();
		expect(details.newText).toBeUndefined();

		// The serialized result stays well under the source file. Before the fix
		// it was ~2x the file size (full oldText + full newText in details).
		expect(JSON.stringify(result).length).toBeLessThan(FILLER.length / 10);
	});
});

describe("executeReplace on oversized files", () => {
	test("prunes oldText / newText while keeping diff", async () => {
		await Bun.write(path.join(tempDir, "big.txt"), `${FILLER}LINE A\n${FILLER}`);

		const result = await executeReplace({
			session: makeSession(tempDir),
			path: "big.txt",
			params: { old_string: "LINE A", new_string: "LINE B" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const details = result.details!;
		expect(details.path).toBe(path.join(tempDir, "big.txt"));
		expect(details.oldText).toBeUndefined();
		expect(details.newText).toBeUndefined();
	});
});

describe("EditTool single-path aggregation across mixed-size entries", () => {
	test("pruned first-entry snapshots suppress aggregate snapshots from a later kept entry", async () => {
		// Reviewer scenario from #3787: a multi-entry single-path edit where the
		// first entry shrinks a large file (oldText pruned, file becomes tiny)
		// and a later entry trivially edits the now-tiny file (snapshots kept).
		// Without the marker, the aggregator would record the second entry's
		// small oldText as the whole-file pre-image and ACP clients would
		// render a misleading partial diff.
		await Bun.write(path.join(tempDir, "shrink.txt"), `${FILLER}TAIL\n`);

		// Patch mode is the remaining multi-entry single-path producer (replace
		// takes exactly one edit per call): entry 1 shrinks the file, entry 2
		// tweaks the result.
		const tool = new EditTool(makeSession(tempDir));
		const shrinkDiff = [
			"@@",
			...FILLER.trimEnd()
				.split("\n")
				.map(line => `-${line}`),
			"+tiny",
		].join("\n");

		const result = await tool.execute("call-shrink", {
			path: "shrink.txt",
			edits: [
				// Entry 1: collapse the entire large prefix into one tiny token —
				// oldText is the ~1.3 MB pre-image → combined > 32 KB → pruned.
				{ op: "update", diff: shrinkDiff },
				// Entry 2: trivial rename on the now-tiny file —
				// oldText/newText combined well under 32 KB → kept by the inner.
				{ op: "update", diff: "@@\n-TAIL\n+DONE" },
			],
		});

		const details = result.details as EditToolDetails;
		expect(details.snapshotsPruned).toBe(true);
		expect(details.oldText).toBeUndefined();
		expect(details.newText).toBeUndefined();
		// Aggregate diff still reflects both transitions.
		expect(details.diff.length).toBeGreaterThan(0);
	});
});

describe("executeHashlineSingle multi-section aggregate cap", () => {
	test("strips per-file snapshots once the shared budget is spent", async () => {
		// Five files, each ~10 KB combined oldText+newText after a one-line
		// swap. Each entry fits the per-entry 32 KB budget individually but the
		// 50 KB cumulative bytes bust the shared aggregate budget — without
		// the wrapping fix from #3787 review every per-file snapshot would
		// survive to the session JSONL.
		const fileCount = 5;
		const session = {
			cwd: tempDir,
			settings: Settings.isolated(),
		} as unknown as ToolSession;

		const tags: string[] = [];
		const filler = "filler line of content xxxx yyyy zzzz\n".repeat(120); // ~5 KB
		for (let i = 0; i < fileCount; i++) {
			const filePath = path.join(tempDir, `f${i}.ts`);
			const source = `header${i}\n${filler}`;
			await Bun.write(filePath, source);
			const tag = getFileSnapshotStore(session).record(canonicalSnapshotKey(filePath), source);
			tags.push(tag);
		}

		const sections = tags.map((tag, i) =>
			[formatHashlineHeader(`f${i}.ts`, tag), "PUT 1-1:", `+HEADER${i}`].join("\n"),
		);
		const input = sections.join("\n");

		const result = await executeHashlineSingle({
			session,
			input,
			writethrough: async (targetPath, content) => {
				await Bun.write(targetPath, content);
				return undefined;
			},
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const details = result.details as EditToolDetails;
		expect(details.perFileResults).toBeDefined();
		expect(details.perFileResults!.length).toBe(fileCount);

		const kept = details.perFileResults!.filter(e => e.oldText !== undefined);
		const pruned = details.perFileResults!.filter(e => e.snapshotsPruned === true);
		expect(kept.length).toBeGreaterThan(0);
		expect(pruned.length).toBeGreaterThan(0);
		expect(kept.length + pruned.length).toBe(fileCount);

		const totalKept = details.perFileResults!.reduce(
			(acc, e) => acc + (e.oldText?.length ?? 0) + (e.newText?.length ?? 0),
			0,
		);
		expect(totalKept).toBeLessThanOrEqual(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
	});
});
