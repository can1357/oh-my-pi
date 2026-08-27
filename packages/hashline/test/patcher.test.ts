import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeFileHash,
	formatHashlineHeader,
	HEADTAIL_DRIFT_WARNING,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
	NodeFilesystem,
	Patch,
	Patcher,
	type WriteResult,
} from "@oh-my-pi/hashline";

const PATH = "a.ts";

describe("Patcher snapshot tag integrity", () => {
	it("requires a snapshot store at construction", () => {
		const fs = new InMemoryFilesystem();
		const options = { fs } as unknown as { fs: InMemoryFilesystem; snapshots: InMemorySnapshotStore };

		expect(() => new Patcher(options)).toThrow(/requires a SnapshotStore/);
	});

	it("applies when the section tag is the live file's content hash", async () => {
		const fs = new InMemoryFilesystem([[PATH, "before\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, "before\n");
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 1-1:\n+after`));

		expect(result.sections[0]?.op).toBe("update");
		expect(result.sections[0]?.fileHash).toMatch(/^[0-9A-F]{4}$/);
		expect(result.sections[0]?.fileHash).not.toBe(tag);
		expect(fs.get(PATH)).toBe("after\n");
	});

	it("restores a UTF-8 BOM hidden by Bun text decoding", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-bom-"));
		try {
			const filePath = path.join(tempDir, "Program.cs");
			const source = "using A;\n";
			await Bun.write(filePath, new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(source)]));
			const snapshots = new InMemorySnapshotStore();
			const tag = snapshots.record(filePath, source);
			const patch = Patch.parse([formatHashlineHeader(filePath, tag), "PUT 1-1:", "+using B;"].join("\n"));

			await new Patcher({ fs: new NodeFilesystem(), snapshots }).apply(patch);

			const bytes = await fs.readFile(filePath);
			expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
			expect(new TextDecoder().decode(bytes.subarray(3))).toBe("using B;\n");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("validates any anchor purely from the content hash, even with no recorded snapshot", async () => {
		// The core fix: the tag fingerprints the WHOLE file. An edit anchored at
		// a line the model never saw recorded applies whenever the live file
		// still hashes to the tag — no stored snapshot is consulted.
		const content = "l1\nl2\nl3\nl4\nl5\n";
		const fs = new InMemoryFilesystem([[PATH, content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = computeFileHash(content);
		// Store is intentionally empty: byHash(tag) === null.
		expect(snapshots.byHash(PATH, tag)).toBeNull();
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 3-3:\n+L3`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("l1\nl2\nL3\nl4\nl5\n");
	});

	it("normalizes lowercase section tags while parsing", () => {
		const section = Patch.parseSingle(`[${PATH}#1a2b]\nPUT 1-1:\n+after`);

		expect(section.fileHash).toBe("1A2B");
	});

	it("refuses with mismatch when the recorded version no longer matches live content", async () => {
		const fs = new InMemoryFilesystem([[PATH, "drifted\n"]]);
		const snapshots = new InMemorySnapshotStore();
		// Tag was minted from "before\n" but the live file is "drifted\n".
		const tag = snapshots.record(PATH, "before\n");
		const patcher = new Patcher({ fs, snapshots });

		try {
			await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 1-1:\n+after`));
			throw new Error("expected MismatchError");
		} catch (error) {
			expect(error).toBeInstanceOf(MismatchError);
			const message = (error as MismatchError).displayMessage;
			// Hash WAS observed for this path, so we land on the "file changed" branch.
			expect(message).toMatch(/file changed between read and edit/);
			expect(message).toMatch(/Section is bound to #/);
		}
		// Disk untouched — refusal must never leave a partial write.
		expect(fs.get(PATH)).toBe("drifted\n");
	});

	it("refuses with a 'not from this session' diagnostic when the tag was never recorded for this path", async () => {
		const fs = new InMemoryFilesystem([[PATH, "current\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });
		// A 4-hex tag that is neither the live content hash nor a recorded
		// version — equivalent to the model fabricating it or carrying it over
		// from a prior session.
		const live = computeFileHash("current\n");
		const bogus = live === "FFFF" ? "0000" : "FFFF";

		try {
			await patcher.apply(Patch.parse(`[${PATH}#${bogus}]\nPUT 1-1:\n+after`));
			throw new Error("expected MismatchError");
		} catch (error) {
			expect(error).toBeInstanceOf(MismatchError);
			const message = (error as MismatchError).displayMessage;
			expect(message).toMatch(new RegExp(`hash #${bogus} is not from this session`));
			expect(message).toMatch(/never invent the tag/);
			// Still surfaces the current hash so the model can pivot to a re-read.
			expect(message).toMatch(/current file hashes to #[0-9A-F]{4}/);
		}
		expect(fs.get(PATH)).toBe("current\n");
	});

	// A 16-bit snapshot tag can collide across two different file states. Tag
	// equality with the live content is trusted as-is: the model did nothing
	// wrong, and a forced re-read would mint the very same tag. Line anchors
	// therefore index the live text, colliding retained snapshots notwithstanding.
	it("applies onto live content when the tag matches, even against a retained colliding snapshot", async () => {
		// These two texts both hash to `1D84`.
		const SNAPSHOT_TEXT = "line one 263\nline two 4471\n";
		const LIVE_TEXT = "line one 410\nline two 6970\n";
		expect(computeFileHash(SNAPSHOT_TEXT)).toBe(computeFileHash(LIVE_TEXT));

		const fs = new InMemoryFilesystem([[PATH, LIVE_TEXT]]);
		const snapshots = new InMemorySnapshotStore();
		// Tag was minted from SNAPSHOT_TEXT; live is the colliding LIVE_TEXT.
		const tag = snapshots.record(PATH, SNAPSHOT_TEXT, [1, 2]);

		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2-2:\n+edited live`));
		expect(fs.get(PATH)).toBe("line one 410\nedited live\n");
	});
});

// A write-time transform outside the patcher's control (e.g. an ACP-connected
// editor's format-on-save rewriting indentation on every save) must never
// poison the next section's snapshot tag with content that no longer exists
// on disk. `DriftingFilesystem` stands in for that editor: every write is
// persisted verbatim to the backing store (so `fs.get` sees ground truth,
// like the file the reporter grepped with `cat`/`grep` right after the tool
// call returned), but `writeText` echoes back a *reformatted* copy — spaces
// turned into tabs, exactly the corruption reported against the ACP bridge.
class DriftingFilesystem extends InMemoryFilesystem {
	override async writeText(path: string, content: string): Promise<WriteResult> {
		const drifted = content.replace(/^ {4}/gm, "\t");
		await super.writeText(path, drifted);
		return { text: drifted };
	}
}

describe("Patcher snapshot tag stays honest across a write-time content transform", () => {
	it("keys the returned snapshot tag on what the Filesystem actually persisted, not the pre-write content", async () => {
		const original = "function f() {\n    return 1;\n}\n";
		const fs = new DriftingFilesystem([[PATH, original]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, original);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2-2:\n+    return 2;`));
		const section = result.sections[0];
		if (!section) throw new Error("expected one section result");

		// Ground truth: the Filesystem drifted the untouched line's indentation
		// to tabs on write, exactly like a hostile format-on-save would.
		const onDisk = fs.get(PATH);
		expect(onDisk).toBe("function f() {\n\treturn 2;\n}\n");

		// The returned tag MUST hash the drifted (real) content, not the
		// pre-write text the patcher computed — otherwise the very next edit's
		// tag validation is checked against content the file no longer has.
		expect(section.fileHash).toBe(computeFileHash(onDisk ?? ""));
		expect(section.header).toBe(formatHashlineHeader(PATH, computeFileHash(onDisk ?? "")));

		// The drift is surfaced, not swallowed: silent divergence is exactly
		// what turned a one-line edit into unexplained whole-file corruption.
		expect(section.warnings.some(w => w.includes(PATH) && /reformatted it on save/.test(w))).toBe(true);

		// A follow-up edit anchored on the returned tag must succeed against
		// the real (drifted) file instead of failing a stale-tag mismatch.
		await patcher.apply(Patch.parse(`[${PATH}#${section.fileHash}]\nPUT 1-1:\n+function g() {`));
		expect(fs.get(PATH)).toBe("function g() {\n\treturn 2;\n}\n");
	});
});

describe("Patcher mandatory snapshot tag policy", () => {
	it("rejects a hashless head/tail insert — the tag is required on every section", async () => {
		const fs = new InMemoryFilesystem([[PATH, "a\nb\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}]\nPUT >$:\n+c`))).rejects.toThrow(
			/Missing hashline snapshot tag.*use the write tool/s,
		);
		expect(fs.get(PATH)).toBe("a\nb\n");
	});

	it("still hard-rejects an anchored edit that omits the snapshot tag", async () => {
		const fs = new InMemoryFilesystem([[PATH, "a\nb\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}]\nPUT 1-1:\n+X`))).rejects.toThrow(
			/Missing hashline snapshot tag/,
		);
	});

	it("rejects a tagged edit whose target file does not exist (create with write instead)", async () => {
		const fs = new InMemoryFilesystem();
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[ghost.ts#1A2B]\nPUT >$:\n+c`))).rejects.toThrow(
			/File not found.*use the write tool/is,
		);
	});

	it("applies a head/tail insert with a stale tag and warns instead of hard-failing", async () => {
		const content = "a\nb\n";
		const fs = new InMemoryFilesystem([[PATH, content]]);
		const snapshots = new InMemorySnapshotStore();
		const live = computeFileHash(content);
		const stale = live === "0000" ? "FFFF" : "0000";
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${stale}]\nPUT >$:\n+c`));

		const section = result.sections[0];
		expect(section?.op).toBe("update");
		expect(fs.get(PATH)).toBe("a\nb\nc\n");
		expect(section?.warnings).toContain(HEADTAIL_DRIFT_WARNING);
	});

	it("does not warn when a head/tail insert carries the live tag", async () => {
		const content = "a\nb\n";
		const fs = new InMemoryFilesystem([[PATH, content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, content);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT >$:\n+c`));

		const section = result.sections[0];
		expect(section?.op).toBe("update");
		expect(section?.warnings ?? []).not.toContain(HEADTAIL_DRIFT_WARNING);
	});
});

describe("Patcher seen-line provenance", () => {
	const CONTENT = "l1\nl2\nl3\nl4\nl5\n";

	it("rejects an edit anchored on a line the read never displayed", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		// A partial read displayed only lines 1-2 under this tag.
		const tag = snapshots.record(PATH, CONTENT, [1, 2]);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 4-4:\n+L4`))).rejects.toThrow(
			/never displayed \(it showed/,
		);
		expect(fs.get(PATH)).toBe(CONTENT);
	});

	it("applies an edit anchored on a displayed line", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT, [1, 2]);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2-2:\n+L2`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("l1\nL2\nl3\nl4\nl5\n");
	});

	it("widens coverage when more of the same content is re-read (read fusion)", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT, [1, 2]);
		// Second read of identical content displays lines 4-5: union into the tag.
		snapshots.record(PATH, CONTENT, [4, 5]);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 4-4:\n+L4`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("l1\nl2\nl3\nL4\nl5\n");
	});

	it("reveals the actual line content in the rejection and unblocks a same-tag retry", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		// Read only surfaced lines 1-2; anchor line 4 is unseen.
		const tag = snapshots.record(PATH, CONTENT, [1, 2]);
		const patcher = new Patcher({ fs, snapshots });

		let message: string | undefined;
		try {
			await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 4-4:\n+L4`));
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toMatch(/never displayed \(it showed/);
		expect(message).toContain("Actual file content at those lines:");
		expect(message).toContain("4:l4");
		expect(fs.get(PATH)).toBe(CONTENT);

		// The revealed line joins the snapshot's seen set, so a straight retry
		// with the same [path#tag] header applies — no extra read required.
		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 4-4:\n+L4`));
		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("l1\nl2\nl3\nL4\nl5\n");
	});

	it("truncates the reveal at the cap and directs the tail back to a range re-read", async () => {
		const bigContent = `${Array.from({ length: 200 }, (_, i) => `l${i + 1}`).join("\n")}\n`;
		const fs = new InMemoryFilesystem([[PATH, bigContent]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, bigContent, [1]);
		const patcher = new Patcher({ fs, snapshots });

		// Anchor 60 unseen lines — over the 40-line inline reveal cap.
		const dels = Array.from({ length: 60 }, (_, i) => `CUT ${100 + i}`).join("\n");
		let message: string | undefined;
		try {
			await patcher.apply(Patch.parse(`[${PATH}#${tag}]\n${dels}`));
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("Preview of the actual file content at the first 40 unseen line(s)");
		expect(message).toContain("100:l100");
		expect(message).toContain("139:l139");
		expect(message).not.toContain("140:l140");
		expect(message).toMatch(new RegExp(`${PATH}:100-159`));
		expect(fs.get(PATH)).toBe(bigContent);

		// A straight retry of the same over-cap patch STILL rejects: the
		// truncated reveal must not merge its prefix into seenLines, or the
		// model could split a blind over-cap edit into <=cap-line retries and
		// slip past the range-re-read gate. The reveal window stays anchored
		// at the head (100..139), never advancing to the tail across retries.
		let retryMessage: string | undefined;
		try {
			await patcher.apply(Patch.parse(`[${PATH}#${tag}]\n${dels}`));
		} catch (err) {
			retryMessage = (err as Error).message;
		}
		expect(retryMessage).toContain("Preview of the actual file content at the first 40 unseen line(s)");
		expect(retryMessage).toContain("100:l100");
		expect(retryMessage).toContain("139:l139");
		expect(retryMessage).not.toContain("140:l140");
		expect(fs.get(PATH)).toBe(bigContent);
	});

	it("column-clips wide revealed lines, keeps the merge gate closed, and stays anchored across retries", async () => {
		// Minified-bundle-style single wide line at anchor 2. Anchor 3 is a
		// short line so we can see the width truncation applied only where
		// needed. The 4KB cap is comfortably over SEEN_LINE_REVEAL_MAX_COLUMNS.
		const wide = "a".repeat(4096);
		const wideContent = `l1\n${wide}\nl3\nl4\n`;
		const fs = new InMemoryFilesystem([[PATH, wideContent]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, wideContent, [1]);
		const patcher = new Patcher({ fs, snapshots });

		let message: string | undefined;
		try {
			await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2-3:\n+X\n+Y`));
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("Preview of the actual file content at the first 2 unseen line(s)");
		// Line 2 is clipped at 512 chars + ellipsis; the full 4KB never leaks
		// into the error preview.
		expect(message).toMatch(/2:a{512}…/);
		expect(message).not.toContain("a".repeat(513));
		// Short line surfaces verbatim.
		expect(message).toContain("3:l3");
		// Guidance routes to a range re-read.
		expect(message).toMatch(new RegExp(`${PATH}:2-3`));
		expect(fs.get(PATH)).toBe(wideContent);

		// A straight retry STILL rejects: column-truncated reveals must not
		// merge into seenLines, otherwise the model would land the edit
		// having only seen the first 512 chars of a >4KB line.
		let retryMessage: string | undefined;
		try {
			await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2-3:\n+X\n+Y`));
		} catch (err) {
			retryMessage = (err as Error).message;
		}
		expect(retryMessage).toContain("Preview of the actual file content at the first 2 unseen line(s)");
		expect(retryMessage).toMatch(/2:a{512}…/);
		expect(retryMessage).not.toContain("a".repeat(513));
		expect(fs.get(PATH)).toBe(wideContent);
	});

	it("skips the check when no seen lines were recorded (absent → allow)", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 4-4:\n+L4`));

		expect(result.sections[0]?.op).toBe("update");
	});
});

describe("Patcher tag-based path recovery", () => {
	const NESTED = "pkg/test/file.ts";
	const CONTENT = "one\ntwo\nthree\n";

	it("redirects a bare filename to the full path of the file its tag names", async () => {
		const fs = new InMemoryFilesystem([[NESTED, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(NESTED, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		// The header carries only the basename — the model dropped the directory.
		const result = await patcher.apply(Patch.parse(`[file.ts#${tag}]\nPUT 2-2:\n+TWO`));

		const section = result.sections[0];
		expect(section?.op).toBe("update");
		// The edit landed on the real nested file; the result reports its full path.
		expect(section?.path).toBe(NESTED);
		expect(fs.get(NESTED)).toBe("one\nTWO\nthree\n");
		expect(section?.warnings.some(warning => warning.includes("does not exist") && warning.includes(NESTED))).toBe(
			true,
		);
	});

	it("declines recovery when the filename does not match the recorded file", async () => {
		const fs = new InMemoryFilesystem([[NESTED, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(NESTED, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[other.ts#${tag}]\nPUT 2-2:\n+TWO`))).rejects.toThrow(/File not found/);
		expect(fs.get(NESTED)).toBe(CONTENT);
	});

	it("declines recovery when the tag matches no retained snapshot", async () => {
		const fs = new InMemoryFilesystem([[NESTED, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(NESTED, CONTENT);
		const bogus = tag === "FFFF" ? "0000" : "FFFF";
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[file.ts#${bogus}]\nPUT 2-2:\n+TWO`))).rejects.toThrow(/File not found/);
	});

	it("declines recovery when two retained files share the filename and tag", async () => {
		const fs = new InMemoryFilesystem([
			["a/file.ts", CONTENT],
			["b/file.ts", CONTENT],
		]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a/file.ts", CONTENT);
		snapshots.record("b/file.ts", CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[file.ts#${tag}]\nPUT 2-2:\n+TWO`))).rejects.toThrow(/File not found/);
		expect(fs.get("a/file.ts")).toBe(CONTENT);
		expect(fs.get("b/file.ts")).toBe(CONTENT);
	});

	it("respects a filesystem that refuses path recovery", async () => {
		class NoRecoveryFs extends InMemoryFilesystem {
			override allowTagPathRecovery(): boolean {
				return false;
			}
		}
		const fs = new NoRecoveryFs([[NESTED, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(NESTED, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[file.ts#${tag}]\nPUT 2-2:\n+TWO`))).rejects.toThrow(/File not found/);
		expect(fs.get(NESTED)).toBe(CONTENT);
	});

	it("runs the write gate on the recovered path, not the authored bare path", async () => {
		// A gate that refuses the bare authored path but allows the recovered full
		// path. Mirrors plan mode rejecting a bare cwd path before tag recovery
		// rebinds it to its real (writable) location; recovery must precede the gate.
		class GatedFs extends InMemoryFilesystem {
			override async preflightWrite(p: string): Promise<void> {
				if (p === "file.ts") throw new Error("write gate: read-only");
			}
		}
		const fs = new GatedFs([[NESTED, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(NESTED, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[file.ts#${tag}]\nPUT 2-2:\n+TWO`));
		expect(result.sections[0]?.path).toBe(NESTED);
		expect(fs.get(NESTED)).toBe("one\nTWO\nthree\n");
	});

	it("runs the write gate on an unrecoverable authored path (gate wins over not-found)", async () => {
		// No snapshot for the bare name → no recovery; the gate still runs on the
		// authored path and its rejection wins over the file-not-found error.
		class GatedFs extends InMemoryFilesystem {
			override async preflightWrite(): Promise<void> {
				throw new Error("write gate: read-only");
			}
		}
		const fs = new GatedFs([[NESTED, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[file.ts#ABCD]\nPUT 1-1:\n+X`))).rejects.toThrow(/write gate/);
	});
});

describe("Patcher replacement boundary echoes", () => {
	const CONTENT = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n") + "\n";

	async function applyPatch(input: string, blockResolver?: ConstructorParameters<typeof Patcher>[0]["blockResolver"]) {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots, ...(blockResolver ? { blockResolver } : {}) });
		return { result: await patcher.apply(Patch.parse(input.replace("#TAG", `#${tag}`))), fs };
	}

	it("echoes the original first/last line of each concrete replacement range", async () => {
		const { result } = await applyPatch(`[${PATH}#TAG]\nPUT 2-4:\n+X\n+Y\nPUT 7-8:\n+Z`);

		expect(result.sections[0]?.replacementEchoes).toEqual([
			{ start: 2, end: 4, first: "l2", last: "l4" },
			{ start: 7, end: 8, first: "l7", last: "l8" },
		]);
	});

	it("echoes a single-line replacement once with the same first/last content", async () => {
		const { result } = await applyPatch(`[${PATH}#TAG]\nPUT 3-3:\n+L3`);

		expect(result.sections[0]?.replacementEchoes).toEqual([{ start: 3, end: 3, first: "l3", last: "l3" }]);
	});

	it("emits no echo for a CUT-only edit", async () => {
		const { result } = await applyPatch(`[${PATH}#TAG]\nCUT 5-6`);

		expect(result.sections[0]?.replacementEchoes).toBeUndefined();
	});

	it("emits no echo for a pure insertion", async () => {
		const { result } = await applyPatch(`[${PATH}#TAG]\nPUT >2:\n+inserted`);

		expect(result.sections[0]?.replacementEchoes).toBeUndefined();
	});

	it("emits no echo for block ops (block resolutions cover them)", async () => {
		const stub = () => ({ start: 2, end: 4 });
		const { result } = await applyPatch(`[${PATH}#TAG]\nPUT 2*:\n+B1\n+B2`, stub);

		expect(result.sections[0]?.replacementEchoes).toBeUndefined();
		expect(result.sections[0]?.blockResolutions?.[0]).toMatchObject({ start: 2, end: 4 });
	});
	it("echoes a register span paste over a concrete range", async () => {
		const { result } = await applyPatch(`[${PATH}#TAG]\nCUT 8-9 @reg\nPUT 2-3 @reg`);

		// The span paste replaces lines 2-3 with the captured register content;
		// the echo names what the target range covered.
		expect(result.sections[0]?.replacementEchoes).toEqual([{ start: 2, end: 3, first: "l2", last: "l3" }]);
	});

	it("drops the echo of a coalesced duplicate range hunk", async () => {
		const { result, fs } = await applyPatch(`[${PATH}#TAG]\nPUT 2-2:\n+first\nPUT 2-2:\n+second`);

		expect(result.sections[0]?.replacementEchoes).toEqual([{ start: 2, end: 2, first: "l2", last: "l2" }]);
		expect(fs.get(PATH)).toBe(["l1", "second", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n") + "\n");
	});
});
