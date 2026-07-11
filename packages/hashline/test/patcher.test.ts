import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	HEADTAIL_DRIFT_WARNING,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
	Patch,
	Patcher,
} from "@pk-nerdsaver-ai/hashline";

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

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 1.=1:\n+after`));

		expect(result.sections[0]?.op).toBe("update");
		expect(result.sections[0]?.fileHash).toMatch(/^[0-9A-F]{4}$/);
		expect(result.sections[0]?.fileHash).not.toBe(tag);
		expect(fs.get(PATH)).toBe("after\n");
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

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 3.=3:\n+L3`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("l1\nl2\nL3\nl4\nl5\n");
	});

	it("normalizes lowercase section tags while parsing", () => {
		const section = Patch.parseSingle(`[${PATH}#1a2b]\nSWAP 1.=1:\n+after`);

		expect(section.fileHash).toBe("1A2B");
	});

	it("refuses with mismatch when the recorded version no longer matches live content", async () => {
		const fs = new InMemoryFilesystem([[PATH, "drifted\n"]]);
		const snapshots = new InMemorySnapshotStore();
		// Tag was minted from "before\n" but the live file is "drifted\n".
		const tag = snapshots.record(PATH, "before\n");
		const patcher = new Patcher({ fs, snapshots });

		try {
			await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 1.=1:\n+after`));
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
			await patcher.apply(Patch.parse(`[${PATH}#${bogus}]\nSWAP 1.=1:\n+after`));
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
});

describe("Patcher mandatory snapshot tag policy", () => {
	it("rejects a hashless head/tail insert — the tag is required on every section", async () => {
		const fs = new InMemoryFilesystem([[PATH, "a\nb\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}]\nINS.TAIL:\n+c`))).rejects.toThrow(
			/Missing hashline snapshot tag.*use the write tool/s,
		);
		expect(fs.get(PATH)).toBe("a\nb\n");
	});

	it("still hard-rejects an anchored edit that omits the snapshot tag", async () => {
		const fs = new InMemoryFilesystem([[PATH, "a\nb\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}]\nSWAP 1.=1:\n+X`))).rejects.toThrow(
			/Missing hashline snapshot tag/,
		);
	});

	it("rejects a tagged edit whose target file does not exist (create with write instead)", async () => {
		const fs = new InMemoryFilesystem();
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[ghost.ts#1A2B]\nINS.TAIL:\n+c`))).rejects.toThrow(
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

		const result = await patcher.apply(Patch.parse(`[${PATH}#${stale}]\nINS.TAIL:\n+c`));

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

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nINS.TAIL:\n+c`));

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

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 4.=4:\n+L4`))).rejects.toThrow(
			/never displayed \(it showed/,
		);
		expect(fs.get(PATH)).toBe(CONTENT);
	});

	it("applies an edit anchored on a displayed line", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT, [1, 2]);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 2.=2:\n+L2`));

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

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 4.=4:\n+L4`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("l1\nl2\nl3\nL4\nl5\n");
	});

	it("skips the check when no seen lines were recorded (absent → allow)", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 4.=4:\n+L4`));

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
		const result = await patcher.apply(Patch.parse(`[file.ts#${tag}]\nSWAP 2.=2:\n+TWO`));

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

		await expect(patcher.apply(Patch.parse(`[other.ts#${tag}]\nSWAP 2.=2:\n+TWO`))).rejects.toThrow(/File not found/);
		expect(fs.get(NESTED)).toBe(CONTENT);
	});

	it("declines recovery when the tag matches no retained snapshot", async () => {
		const fs = new InMemoryFilesystem([[NESTED, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(NESTED, CONTENT);
		const bogus = tag === "FFFF" ? "0000" : "FFFF";
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[file.ts#${bogus}]\nSWAP 2.=2:\n+TWO`))).rejects.toThrow(
			/File not found/,
		);
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

		await expect(patcher.apply(Patch.parse(`[file.ts#${tag}]\nSWAP 2.=2:\n+TWO`))).rejects.toThrow(/File not found/);
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

		await expect(patcher.apply(Patch.parse(`[file.ts#${tag}]\nSWAP 2.=2:\n+TWO`))).rejects.toThrow(/File not found/);
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

		const result = await patcher.apply(Patch.parse(`[file.ts#${tag}]\nSWAP 2.=2:\n+TWO`));
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

		await expect(patcher.apply(Patch.parse(`[file.ts#ABCD]\nSWAP 1.=1:\n+X`))).rejects.toThrow(/write gate/);
	});
});
