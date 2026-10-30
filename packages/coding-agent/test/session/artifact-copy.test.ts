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

	it("never writes into a destination directory it did not create, whatever that is", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(path.join(sourceArtifacts, "nested"), { recursive: true });
		fs.mkdirSync(path.join(sourceArtifacts, "plain"), { recursive: true });
		fs.mkdirSync(path.join(destinationArtifacts, "plain"), { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "nested", "payload.log"), "must-not-escape");
		fs.writeFileSync(path.join(sourceArtifacts, "plain", "payload.log"), "destination wins");
		// A symlink stands in for everything a name can hold that resolving
		// does not tell apart from a directory — a bind mount is the same case
		// and cannot be distinguished at all, so neither is written into.
		fs.symlinkSync(outside, path.join(destinationArtifacts, "nested"));

		const tally = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		expect(fs.readdirSync(outside)).toEqual([]);
		expect(fs.readdirSync(path.join(destinationArtifacts, "plain"))).toEqual([]);
		expect(tally).toEqual({ entries: 0, bytes: 0, largest: [] });
	});

	it("takes its own copy back when the destination root is replaced mid-walk, and nothing else", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.mkdirSync(destinationArtifacts, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "payload.log"), "raced-write");
		fs.writeFileSync(path.join(outside, "unrelated.log"), "only copy of unrelated data");
		// The root passes its check and is then replaced by a symlink, so the
		// writes land outside: only the identity of the directory the copy
		// created answers that, and only what the copy created comes back.
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
		let tally: ArtifactCopyTally;
		try {
			tally = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);
		} finally {
			spy.mockRestore();
		}

		expect(swapped).toBe(true);
		expect(fs.readdirSync(outside)).toEqual(["unrelated.log"]);
		expect(tally).toEqual({ entries: 0, bytes: 0, largest: [] });
	});

	it("leaves a newer destination file published over one of its own alone", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.bash.log"), "the copy's");
		const target = path.join(destinationArtifacts, "1.bash.log");

		// The destination session replaces the copied file with one of its own
		// before the copy is taken back. A take-back that went by name would
		// delete that file; this one goes by the object it created, and a name
		// whose file was replaced — even onto the same recycled inode — is no
		// longer that object.
		const tally = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				fs.unlinkSync(target);
				fs.writeFileSync(target, "the destination session's own, newer");
				return false;
			},
		});

		expect(tally).toEqual({ entries: 0, bytes: 0, largest: [] });
		expect(fs.readFileSync(target, "utf8")).toBe("the destination session's own, newer");
	});

	it("leaves an unrelated file alone when a directory it wrote is redirected before the take-back", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(path.join(sourceArtifacts, "nested"), { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "nested", "payload.log"), "the copy's");
		fs.writeFileSync(path.join(outside, "payload.log"), "only copy of unrelated data");

		const tally = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				// The copy's own directory is moved aside and its name given to
				// a symlink holding somebody else's file of the same name.
				fs.renameSync(path.join(destinationArtifacts, "nested"), path.join(destinationArtifacts, "parked"));
				fs.symlinkSync(outside, path.join(destinationArtifacts, "nested"));
				return false;
			},
		});

		expect(tally).toEqual({ entries: 0, bytes: 0, largest: [] });
		expect(fs.readFileSync(path.join(outside, "payload.log"), "utf8")).toBe("only copy of unrelated data");
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
