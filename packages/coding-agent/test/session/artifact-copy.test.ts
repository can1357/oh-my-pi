import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { copySessionArtifacts } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
});
