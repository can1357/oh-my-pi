import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ArtifactCopyOutcome, copySessionArtifacts } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A session journal and the artifacts directory that sits beside it. */
const SOURCE = "2026-01-01T00-00-00-000Z_source";
const DESTINATION = "2026-01-01T00-00-01-000Z_destination";

/** Whatever the copy left behind of its own staging directories. */
function stagingLeftovers(dir: string): string[] {
	return fs.readdirSync(dir).filter(name => name.endsWith(".staging"));
}

describe("copying a session's artifacts to another session", () => {
	it("reports what the copy cost and which entries dominated it", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const subagent = "2026-01-01T00-00-00-000Z_sub";
		fs.mkdirSync(path.join(sourceArtifacts, "local"), { recursive: true });
		fs.mkdirSync(path.join(sourceArtifacts, subagent), { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.bash.log"), "b".repeat(100));
		fs.writeFileSync(path.join(sourceArtifacts, "local", "PLAN.md"), "p".repeat(200));
		// A subagent's own directory, which is what a long session's artifacts
		// are mostly made of: the tally has to charge a directory its subtree,
		// or the entry that costs the most is the one it never names.
		fs.writeFileSync(path.join(sourceArtifacts, subagent, "Sub.jsonl"), "j".repeat(5000));
		fs.writeFileSync(path.join(sourceArtifacts, subagent, "2.bash.log"), "n".repeat(400));

		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		expect(outcome.discarded).toBe(false);
		expect(outcome.tally).toEqual({
			entries: 4,
			bytes: 5700,
			largest: [
				{ name: subagent, bytes: 5400 },
				{ name: "local", bytes: 200 },
				{ name: "1.bash.log", bytes: 100 },
			],
		});
		// The highest identifier the source held, which a fork that loses this
		// copy still has to reserve.
		expect(outcome.reservedThroughId).toBe(1);
		expect(stagingLeftovers(tempDir.path())).toEqual([]);
	});

	it("leaves the destination's copy alone when the source session writes on", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(path.join(sourceArtifacts, "local"), { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.bash.log"), "streamed command output");
		fs.writeFileSync(path.join(sourceArtifacts, "local", "PLAN.md"), "the plan");

		await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		// The owner goes on writing its own artifacts, and none of it reaches
		// this session's history.
		fs.writeFileSync(path.join(sourceArtifacts, "1.bash.log"), "output of the owner's next command");
		fs.writeFileSync(path.join(sourceArtifacts, "local", "PLAN.md"), "the owner's new plan");
		expect(fs.readFileSync(path.join(destinationArtifacts, "1.bash.log"), "utf8")).toBe("streamed command output");
		expect(fs.readFileSync(path.join(destinationArtifacts, "local", "PLAN.md"), "utf8")).toBe("the plan");
	});

	it("keeps every name the destination already has, and does not charge the copy for it", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(path.join(sourceArtifacts, "nested"), { recursive: true });
		fs.mkdirSync(path.join(destinationArtifacts, "nested"), { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.shake.log"), "s".repeat(1000));
		fs.writeFileSync(path.join(sourceArtifacts, "3.bash.log"), "s".repeat(40));
		fs.writeFileSync(path.join(sourceArtifacts, "nested", "deep.log"), "s".repeat(500));
		fs.writeFileSync(path.join(destinationArtifacts, "1.shake.log"), "already here");

		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		expect(fs.readFileSync(path.join(destinationArtifacts, "1.shake.log"), "utf8")).toBe("already here");
		// A directory the destination already has is its own, whatever is in it.
		expect(fs.readdirSync(path.join(destinationArtifacts, "nested"))).toEqual([]);
		// Only 3.bash.log was published, so only its 40 bytes were spent: the
		// tally reports what the copy delivered, not what the source holds.
		expect(outcome.discarded).toBe(false);
		expect(outcome.tally).toEqual({ entries: 1, bytes: 40, largest: [{ name: "3.bash.log", bytes: 40 }] });
		expect(stagingLeftovers(tempDir.path())).toEqual([]);
	});

	it("publishes nothing into a destination artifacts directory that is a symlink", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "payload.log"), "outside-write");
		// A symlink, a mount point, anything that is not this session's own
		// directory: the handover is a rename, and a rename refuses them.
		fs.symlinkSync(outside, destinationArtifacts);

		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		expect(fs.readdirSync(outside)).toEqual([]);
		expect(outcome.discarded).toBe(true);
		expect(outcome.tally).toEqual({ entries: 0, bytes: 0, largest: [] });
		expect(stagingLeftovers(tempDir.path())).toEqual([]);
	});

	it("publishes nothing when the destination is replaced while the copy runs", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.mkdirSync(destinationArtifacts, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "payload.log"), "raced-write");
		fs.writeFileSync(path.join(outside, "unrelated.log"), "only copy of unrelated data");
		// The destination becomes a symlink to somewhere else while the copy is
		// still being built. The copy is being built somewhere private, so the
		// swap can only make the handover fail — it cannot redirect a write.
		const open = fs.promises.open;
		let swapped = false;
		const swapOnOpen = (async (target: fs.PathLike, flags?: string | number) => {
			if (!swapped && String(target).startsWith(destinationArtifacts)) {
				swapped = true;
				fs.rmSync(destinationArtifacts, { recursive: true, force: true });
				fs.symlinkSync(outside, destinationArtifacts);
			}
			return open(target, flags as string);
		}) as typeof fs.promises.open;
		const spy = spyOn(fs.promises, "open").mockImplementation(swapOnOpen);
		let outcome: ArtifactCopyOutcome;
		try {
			outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);
		} finally {
			spy.mockRestore();
		}

		expect(swapped).toBe(true);
		expect(fs.readdirSync(outside)).toEqual(["unrelated.log"]);
		expect(outcome.discarded).toBe(true);
		expect(stagingLeftovers(tempDir.path())).toEqual([]);
	});

	it("publishes nothing, and deletes nothing, when the source stops being the session it was copied for", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(path.join(sourceArtifacts, "local"), { recursive: true });
		fs.mkdirSync(destinationArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "2.bash.log"), "not this session's after all");
		fs.writeFileSync(path.join(sourceArtifacts, "local", "PLAN.md"), "nor this");
		// Whatever the destination session already wrote for itself is nothing
		// to do with the copy, before or after it is abandoned.
		fs.writeFileSync(path.join(destinationArtifacts, "0.read.log"), "the destination session's own");

		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => false,
		});

		expect(outcome.discarded).toBe(true);
		expect(outcome.tally).toEqual({ entries: 0, bytes: 0, largest: [] });
		// Not a single byte of the discarded copy is readable at the destination
		// — the whole point of building it somewhere else first.
		expect(fs.readdirSync(destinationArtifacts)).toEqual(["0.read.log"]);
		expect(fs.readFileSync(path.join(destinationArtifacts, "0.read.log"), "utf8")).toBe(
			"the destination session's own",
		);
		// And the identifiers the discarded artifacts carried are reported, so
		// the session that lost them can refuse to hand them out again.
		expect(outcome.reservedThroughId).toBe(2);
		expect(stagingLeftovers(tempDir.path())).toEqual([]);
	});

	it("deletes nothing at the destination when the copy itself fails", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.mkdirSync(destinationArtifacts, { recursive: true });
		fs.writeFileSync(path.join(destinationArtifacts, "0.read.log"), "the destination session's own");
		fs.writeFileSync(path.join(sourceArtifacts, "1.bash.log"), "readable");
		// Unreadable, so the walk fails partway: the half-built copy is thrown
		// away, and a failure is not a licence to remove anything published.
		const unreadable = path.join(sourceArtifacts, "2.bash.log");
		fs.writeFileSync(unreadable, "unreadable");
		fs.chmodSync(unreadable, 0o000);

		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		expect(outcome.discarded).toBe(true);
		expect(fs.readdirSync(destinationArtifacts)).toEqual(["0.read.log"]);
		expect(fs.readFileSync(path.join(destinationArtifacts, "0.read.log"), "utf8")).toBe(
			"the destination session's own",
		);
		expect(stagingLeftovers(tempDir.path())).toEqual([]);
	});

	it("keeps a discarded copy unreadable even when something links into it mid-copy", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.bash.log"), "FOREIGN");
		// A hard link changes the file's change time without changing a byte of
		// it: an undo that went by metadata would leave the file behind. This
		// one never published it, so there is nothing at the destination to
		// leave behind.
		const linked = path.join(tempDir.path(), "linked.log");
		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				const staging = stagingLeftovers(tempDir.path())[0];
				if (staging) fs.linkSync(path.join(tempDir.path(), staging, "1.bash.log"), linked);
				return false;
			},
		});

		expect(outcome.discarded).toBe(true);
		expect(fs.existsSync(destinationArtifacts)).toBe(false);
		expect(stagingLeftovers(tempDir.path())).toEqual([]);
	});
});
