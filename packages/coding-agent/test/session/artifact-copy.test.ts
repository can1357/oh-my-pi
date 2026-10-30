import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ArtifactCopyTally, copySessionArtifacts } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A session journal and the artifacts directory that sits beside it. */
const SOURCE = "2026-01-01T00-00-00-000Z_source";
const DESTINATION = "2026-01-01T00-00-01-000Z_destination";

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

		const tally = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		expect(tally).toEqual({
			entries: 4,
			bytes: 5700,
			largest: [
				{ name: subagent, bytes: 5400 },
				{ name: "local", bytes: 200 },
				{ name: "1.bash.log", bytes: 100 },
			],
		});
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

	it("keeps an entry the destination already has, and does not charge the copy for it", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.mkdirSync(destinationArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.shake.log"), "s".repeat(1000));
		fs.writeFileSync(path.join(sourceArtifacts, "2.bash.log"), "s".repeat(1000));
		fs.writeFileSync(path.join(sourceArtifacts, "3.bash.log"), "s".repeat(40));
		fs.writeFileSync(path.join(destinationArtifacts, "1.shake.log"), "already here");
		fs.writeFileSync(path.join(destinationArtifacts, "2.bash.log"), "already here");

		const tally = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		expect(fs.readFileSync(path.join(destinationArtifacts, "1.shake.log"), "utf8")).toBe("already here");
		expect(fs.readFileSync(path.join(destinationArtifacts, "2.bash.log"), "utf8")).toBe("already here");
		// Only 3.bash.log was reproduced, so only its 40 bytes were spent: the
		// tally reports what the copy cost, not what the source holds.
		expect(tally).toEqual({ entries: 1, bytes: 40, largest: [{ name: "3.bash.log", bytes: 40 }] });
	});

	it("does not write a source directory through a destination symlink", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(path.join(sourceArtifacts, "local"), { recursive: true });
		fs.mkdirSync(destinationArtifacts, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "local", "PLAN.md"), "the plan");
		// A destination entry that is a symlink to a directory: `mkdir -p`
		// accepts it, so a copy that only creates the destination would write
		// the subtree outside the artifacts directory entirely.
		fs.symlinkSync(outside, path.join(destinationArtifacts, "local"));

		const tally = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		expect(fs.readdirSync(outside)).toEqual([]);
		expect(fs.readlinkSync(path.join(destinationArtifacts, "local"))).toBe(outside);
		expect(tally).toEqual({ entries: 0, bytes: 0, largest: [] });
	});

	it("does not copy into a destination artifacts directory that is a symlink", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "payload.log"), "outside-write");
		// The destination root itself, not an entry inside it: `mkdir -p`
		// accepts a symlink here too, and the whole copy would land elsewhere.
		fs.symlinkSync(outside, destinationArtifacts);

		const tally = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		expect(fs.readdirSync(outside)).toEqual([]);
		expect(tally).toEqual({ entries: 0, bytes: 0, largest: [] });
	});

	it("takes the copy back when a destination directory becomes a symlink mid-walk", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(path.join(sourceArtifacts, "nested"), { recursive: true });
		fs.mkdirSync(path.join(destinationArtifacts, "nested"), { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "nested", "payload.log"), "raced-write");
		// Swapped in after the destination was checked and before it is written
		// into: the check alone cannot see this, only where the bytes landed can.
		const lstat = fs.promises.lstat;
		let swapped = false;
		// `lstat` is overloaded on its `bigint` option; this stands in for the
		// one call shape the copy uses.
		const swapOnLstat = (async (target: fs.PathLike) => {
			const result = await lstat(target);
			if (!swapped && target === path.join(destinationArtifacts, "nested")) {
				swapped = true;
				fs.rmdirSync(path.join(destinationArtifacts, "nested"));
				fs.symlinkSync(outside, path.join(destinationArtifacts, "nested"));
			}
			return result;
		}) as typeof fs.promises.lstat;
		const spy = spyOn(fs.promises, "lstat").mockImplementation(swapOnLstat);
		let tally: ArtifactCopyTally;
		try {
			tally = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);
		} finally {
			spy.mockRestore();
		}

		expect(swapped).toBe(true);
		expect(fs.readdirSync(outside)).toEqual([]);
		expect(tally).toEqual({ entries: 0, bytes: 0, largest: [] });
	});

	it("takes the copy back when the source stops being the session it was copied for", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(path.join(sourceArtifacts, "local"), { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.bash.log"), "not this session's after all");
		fs.writeFileSync(path.join(sourceArtifacts, "local", "PLAN.md"), "nor this");

		const tally = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => false,
		});

		expect(tally).toEqual({ entries: 0, bytes: 0, largest: [] });
		expect(fs.existsSync(path.join(destinationArtifacts, "1.bash.log"))).toBe(false);
		expect(fs.existsSync(path.join(destinationArtifacts, "local", "PLAN.md"))).toBe(false);
	});
});
