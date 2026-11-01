import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ArtifactCopyOutcome,
	copySessionArtifacts,
	whenArtifactCopiesSettle,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ARTIFACT_STAGING_SUFFIX as STAGING_SUFFIX } from "@oh-my-pi/pi-coding-agent/session/artifact-staging";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A session journal and the artifacts directory that sits beside it. */
const SOURCE = "2026-01-01T00-00-00-000Z_source";
const DESTINATION = "2026-01-01T00-00-01-000Z_destination";

/** Whatever the copy left behind of its own staging directories. */
function stagingLeftovers(dir: string): string[] {
	return fs.readdirSync(dir).filter(name => name.endsWith(".staging"));
}

/** A staging directory with the marker a copy writes to prove the tree is its own. */
function markedStaging(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const identity = fs.lstatSync(dir, { bigint: true });
	fs.writeFileSync(
		path.join(dir, ".omp-staging"),
		JSON.stringify({ device: String(identity.dev), inode: String(identity.ino) }),
	);
	return dir;
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

	it("keeps every name a destination already holds, and brings the rest across", async () => {
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

		// The session wrote artifacts of its own while the copy ran — and a
		// session that lost its inherited ones records that beside them, which
		// is the same case. Every name the destination has is its own; the
		// rest is moved across through descriptors held on both directories,
		// so nothing is overwritten and nothing has to be undone.
		expect(fs.readFileSync(path.join(destinationArtifacts, "1.shake.log"), "utf8")).toBe("already here");
		expect(fs.readFileSync(path.join(destinationArtifacts, "3.bash.log"), "utf8")).toBe("s".repeat(40));
		// A directory the destination already has is added to, not replaced.
		expect(fs.readdirSync(path.join(destinationArtifacts, "nested"))).toEqual(["deep.log"]);
		expect(outcome.discarded).toBe(false);
		expect(outcome.tally).toEqual({
			entries: 2,
			bytes: 540,
			largest: [
				{ name: "nested", bytes: 500 },
				{ name: "3.bash.log", bytes: 40 },
			],
		});
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
		// And why, so the session that lost them can say something true about it.
		expect(outcome.reason).toBe("source-changed");
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
		expect(outcome.reason).toBe("copy-failed");
		expect(fs.readdirSync(destinationArtifacts)).toEqual(["0.read.log"]);
		expect(fs.readFileSync(path.join(destinationArtifacts, "0.read.log"), "utf8")).toBe(
			"the destination session's own",
		);
		expect(stagingLeftovers(tempDir.path())).toEqual([]);
	});

	it("leaves a directory that took its staging's name alone, and reports why it gave up", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.bash.log"), "the copy's");

		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				// Any process of this user can take a pathname. The staging
				// directory is moved aside and an unrelated one put at its name:
				// removing "the staging path" would destroy a stranger's file.
				const staging = stagingLeftovers(tempDir.path())[0] as string;
				fs.renameSync(path.join(tempDir.path(), staging), path.join(tempDir.path(), "parked"));
				fs.mkdirSync(path.join(tempDir.path(), staging));
				fs.writeFileSync(path.join(tempDir.path(), staging, "someone-elses.log"), "only copy");
				return false;
			},
		});

		expect(outcome.discarded).toBe(true);
		expect(outcome.reason).toBe("source-changed");
		const survivor = stagingLeftovers(tempDir.path())[0] as string;
		expect(fs.readFileSync(path.join(tempDir.path(), survivor, "someone-elses.log"), "utf8")).toBe("only copy");
	});

	it("sweeps the staging of a copier that is gone, and leaves a live one alone", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.bash.log"), "fresh");
		// One left by a copier that was killed with nothing in it but its
		// marker: nothing holds its lease, and there is nothing to lose by
		// taking it away.
		const abandoned = markedStaging(`${destinationArtifacts}.abandoned${STAGING_SUFFIX}`);
		// And one left by a copier that was killed with a file in it. The
		// marker says the *tree* was a copy's; it says nothing about an object
		// this process never placed, and this process has no record of what
		// that copy created. So the tree stays, whole.
		const abandonedWithFile = markedStaging(`${destinationArtifacts}.unfinished${STAGING_SUFFIX}`);
		fs.writeFileSync(path.join(abandonedWithFile, "0.bash.log"), "never published");
		// A directory of somebody else's that merely wears the name: no marker,
		// so nothing here may remove it.
		const impostor = `${destinationArtifacts}.user-owned${STAGING_SUFFIX}`;
		fs.mkdirSync(impostor, { recursive: true });
		fs.writeFileSync(path.join(impostor, "notes.md"), "only copy");
		// And one carrying a marker that names some other directory: a marker
		// is evidence about the directory it is in, not a permission slip.
		const forged = `${destinationArtifacts}.forged${STAGING_SUFFIX}`;
		fs.mkdirSync(forged, { recursive: true });
		fs.writeFileSync(path.join(forged, ".omp-staging"), JSON.stringify({ device: "0", inode: "0" }));
		fs.writeFileSync(path.join(forged, "notes.md"), "also only copy");
		// One a copier is still building in, which holds its lease.
		const live = markedStaging(`${destinationArtifacts}.live${STAGING_SUFFIX}`);
		const lease = tryAcquireSessionLease(`artifact-staging:${path.basename(live)}`);
		expect(lease).not.toBeNull();

		try {
			await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);
		} finally {
			lease?.release();
		}

		expect(fs.existsSync(abandoned)).toBe(false);
		expect(fs.readFileSync(path.join(abandonedWithFile, "0.bash.log"), "utf8")).toBe("never published");
		expect(fs.existsSync(live)).toBe(true);
		expect(fs.readFileSync(path.join(impostor, "notes.md"), "utf8")).toBe("only copy");
		expect(fs.readFileSync(path.join(forged, "notes.md"), "utf8")).toBe("also only copy");
		expect(fs.readFileSync(path.join(destinationArtifacts, "1.bash.log"), "utf8")).toBe("fresh");
	});

	it("publishes nothing for a source artifact that vanished while it was being read", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		const vanishing = path.join(sourceArtifacts, "1.bash.log");
		fs.writeFileSync(vanishing, "about to be reaped");
		// Gone between the look and the read. An empty file published under its
		// name would read as a tool that produced nothing, not as one whose
		// output is missing.
		const open = fs.promises.open;
		const reapOnOpen = (async (target: fs.PathLike, flags?: string | number) => {
			if (String(target).includes(STAGING_SUFFIX)) fs.rmSync(vanishing, { force: true });
			return open(target, flags as string);
		}) as typeof fs.promises.open;
		const spy = spyOn(fs.promises, "open").mockImplementation(reapOnOpen);
		let outcome: ArtifactCopyOutcome;
		try {
			outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);
		} finally {
			spy.mockRestore();
		}

		expect(outcome.discarded).toBe(true);
		expect(outcome.reason).toBe("copy-failed");
		expect(fs.existsSync(path.join(destinationArtifacts, "1.bash.log"))).toBe(false);
		expect(stagingLeftovers(tempDir.path())).toEqual([]);
	});

	it("publishes nothing when the staged tree is substituted just before the handover", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "0.bash.log"), "the copy's");

		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				// The tree that was built is moved aside and another put at its
				// name. What is handed over has to be the tree that was built,
				// not whatever answers to its path by then.
				const staging = path.join(tempDir.path(), stagingLeftovers(tempDir.path())[0] as string);
				fs.renameSync(staging, path.join(tempDir.path(), "parked"));
				fs.mkdirSync(staging);
				fs.writeFileSync(path.join(staging, "0.bash.log"), "FOREIGN");
				return true;
			},
		});

		expect(outcome.discarded).toBe(true);
		expect(fs.existsSync(path.join(destinationArtifacts, "0.bash.log"))).toBe(false);
	});

	it("gives up its staging tree when the source check cannot answer", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "0.bash.log"), "the copy's");

		// A check that throws is not an answer, and must not leave the tree and
		// its lease behind for the rest of the process's life.
		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				throw new Error("identity I/O failed");
			},
		});

		expect(outcome).toEqual({ tally: { entries: 0, bytes: 0, largest: [] }, discarded: true, reason: "copy-failed" });
		expect(stagingLeftovers(tempDir.path())).toEqual([]);
		expect(fs.existsSync(destinationArtifacts)).toBe(false);
	});

	it("runs one copy into a directory at a time", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const first = path.join(tempDir.path(), "2026-01-01T00-00-00-000Z_first");
		const second = path.join(tempDir.path(), "2026-01-01T00-00-02-000Z_second");
		fs.mkdirSync(first, { recursive: true });
		fs.mkdirSync(second, { recursive: true });
		fs.writeFileSync(path.join(first, "0.bash.log"), "first");
		fs.writeFileSync(path.join(second, "0.read.log"), "second");

		// Two copies aimed at one directory must not build in it at once: a
		// reader that waits for "the copy" would otherwise see one finish while
		// the other is still merging its own namespace in.
		let running = 0;
		let most = 0;
		const watch = async (): Promise<boolean> => {
			running += 1;
			most = Math.max(most, running);
			await Promise.resolve();
			running -= 1;
			return true;
		};
		await Promise.all([
			copySessionArtifacts(`${first}.jsonl`, `${destinationArtifacts}.jsonl`, { stillTheSource: watch }),
			copySessionArtifacts(`${second}.jsonl`, `${destinationArtifacts}.jsonl`, { stillTheSource: watch }),
		]);

		expect(most).toBe(1);
	});

	it("does not follow a symlink that took a staged directory's name while giving the tree back", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(path.join(sourceArtifacts, "nested"), { recursive: true });
		fs.mkdirSync(path.join(outside, "deep"), { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "nested", "staged.log"), "the copy's");
		fs.writeFileSync(path.join(outside, "only-copy"), "somebody else's");
		fs.writeFileSync(path.join(outside, "deep", "precious"), "and this");

		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				// The staged directory is moved aside and a link to somebody
				// else's tree put at its name. Walking that name would delete
				// an arbitrarily deep tree that this copy never wrote.
				const staging = path.join(tempDir.path(), stagingLeftovers(tempDir.path())[0] as string);
				fs.renameSync(path.join(staging, "nested"), path.join(tempDir.path(), "parked"));
				fs.symlinkSync(outside, path.join(staging, "nested"));
				return false;
			},
		});

		expect(outcome.discarded).toBe(true);
		expect(fs.readdirSync(outside).sort()).toEqual(["deep", "only-copy"]);
		expect(fs.readFileSync(path.join(outside, "deep", "precious"), "utf8")).toBe("and this");
	});

	it("keeps a foreign file a copy spared, through the next copy's sweep", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "0.bash.log"), "COPIED");
		let foreign = "";

		await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				// Somebody else's file, in the staging tree. The copy that owns
				// the tree has a record of what it created, recognises this as
				// not its own, and leaves it — which also leaves the tree.
				const staging = path.join(tempDir.path(), stagingLeftovers(tempDir.path())[0] as string);
				foreign = path.join(staging, "somebody-elses");
				fs.writeFileSync(foreign, "THEIR ONLY COPY");
				return false;
			},
		});
		expect(fs.readFileSync(foreign, "utf8")).toBe("THEIR ONLY COPY");

		// The next copy sweeps abandoned staging trees before it starts, and
		// this one is marked and unleased. It has no record of what that copy
		// created, so it may take the tree only if there is nothing in it but
		// the marker — and there is this.
		const second = path.join(tempDir.path(), "2026-01-01T00-00-02-000Z_second");
		await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${second}.jsonl`);

		expect(fs.readFileSync(foreign, "utf8")).toBe("THEIR ONLY COPY");
		expect(fs.existsSync(path.dirname(foreign))).toBe(true);
		// And the sweep refusing costs the second copy nothing.
		expect(fs.readFileSync(path.join(second, "0.bash.log"), "utf8")).toBe("COPIED");
	});

	it("leaves an empty directory that took the staging name, and removes its own tree", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "0.bash.log"), "the copy's");
		let impostor = "";
		let moved = "";

		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				// An empty directory is what any process of this user can make,
				// and a removal that resolves the staging name takes whatever
				// the name reaches. This one is not the directory that was
				// created, and is not this copy's to remove.
				const staging = path.join(tempDir.path(), stagingLeftovers(tempDir.path())[0] as string);
				moved = `${staging}.moved`;
				fs.renameSync(staging, moved);
				fs.mkdirSync(staging);
				impostor = staging;
				return false;
			},
		});

		expect(outcome.discarded).toBe(true);
		expect(fs.existsSync(impostor)).toBe(true);
		expect(fs.readdirSync(impostor)).toEqual([]);
		// What the copy made is still the copy's, under the name it was moved
		// to, and the sweep that collects staging trees finds it by its marker.
		expect(fs.existsSync(moved)).toBe(true);
	});

	it("does not take the marker out through a destination name that stopped being the tree", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		const outside = path.join(tempDir.path(), "outside");
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "0.bash.log"), "COPIED");
		// Somebody else's file, under the name the marker has.
		fs.writeFileSync(path.join(outside, ".omp-staging"), "THEIR ONLY COPY");

		const rename = fs.promises.rename;
		let swapped = false;
		const hook = spyOn(fs.promises, "rename").mockImplementation(async (...args: unknown[]) => {
			const result = await rename(...(args as Parameters<typeof rename>));
			// Between the handover and the marker's removal: the destination
			// name now points somewhere else entirely.
			if (!swapped && String(args[1]).endsWith(DESTINATION)) {
				swapped = true;
				fs.renameSync(destinationArtifacts, `${destinationArtifacts}.real`);
				fs.symlinkSync(outside, destinationArtifacts);
			}
			return result;
		});

		try {
			const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);
			expect(swapped).toBe(true);
			expect(outcome.discarded).toBe(false);
			expect(fs.readFileSync(path.join(outside, ".omp-staging"), "utf8")).toBe("THEIR ONLY COPY");
		} finally {
			hook.mockRestore();
		}
	});

	it("leaves a staged file that is no longer the one it wrote", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "0.bash.log"), "the copy's");
		let replaced = "";

		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				const staging = path.join(tempDir.path(), stagingLeftovers(tempDir.path())[0] as string);
				replaced = path.join(staging, "0.bash.log");
				fs.unlinkSync(replaced);
				fs.writeFileSync(replaced, "ONLY COPY OF SOMEBODY ELSE'S DATA");
				return false;
			},
		});

		expect(outcome.discarded).toBe(true);
		expect(fs.readFileSync(replaced, "utf8")).toBe("ONLY COPY OF SOMEBODY ELSE'S DATA");
	});

	it("publishes nothing when the staged bytes changed before the handover", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "0.bash.log"), "ORIGINAL");
		// Rewritten in place: same inode, different bytes. The check happens
		// before the tree can be reached, because a check afterwards cannot
		// withhold what a reader may already have opened.
		const outcome = await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				const staging = path.join(tempDir.path(), stagingLeftovers(tempDir.path())[0] as string);
				fs.writeFileSync(path.join(staging, "0.bash.log"), "FOREIGN!");
				return true;
			},
		});

		expect(outcome.discarded).toBe(true);
		expect(fs.existsSync(destinationArtifacts)).toBe(false);
	});

	it("does not sweep a live copier's tree that was moved to another staging name", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "0.bash.log"), "fresh");
		// A tree whose copier still holds the lease of the name it was made
		// under. Moving it does not make it abandoned, and the name it wears
		// now says nothing about whether anyone is still building in it.
		const original = `${destinationArtifacts}.original${STAGING_SUFFIX}`;
		const moved = `${destinationArtifacts}.moved${STAGING_SUFFIX}`;
		fs.mkdirSync(original, { recursive: true });
		const identity = fs.lstatSync(original, { bigint: true });
		fs.writeFileSync(
			path.join(original, ".omp-staging"),
			JSON.stringify({
				device: String(identity.dev),
				inode: String(identity.ino),
				lease: `artifact-staging:${path.basename(original)}`,
			}),
		);
		fs.writeFileSync(path.join(original, "building.log"), "still being written");
		fs.renameSync(original, moved);
		const lease = tryAcquireSessionLease(`artifact-staging:${path.basename(original)}`);
		expect(lease).not.toBeNull();

		try {
			await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);
		} finally {
			lease?.release();
		}

		expect(fs.readFileSync(path.join(moved, "building.log"), "utf8")).toBe("still being written");
	});

	it("holds this process's readers until a merge into an occupied destination has finished", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.mkdirSync(destinationArtifacts, { recursive: true });
		fs.writeFileSync(path.join(destinationArtifacts, "9.read.log"), "the session's own");
		fs.writeFileSync(path.join(sourceArtifacts, "0.bash.log"), "INHERITED 0");
		fs.writeFileSync(path.join(sourceArtifacts, "1.bash.log"), "INHERITED 1");

		// The destination already has an artifact, so the copy is merged in
		// entry by entry rather than handed over whole — and a merge is not
		// atomic. Every consumer in this process waits for the copy instead of
		// reading a half-arrived inheritance.
		const { promise: held, resolve: release } = Promise.withResolvers<void>();
		const copying = copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`, {
			stillTheSource: async () => {
				await held;
				return true;
			},
		});
		const reader = whenArtifactCopiesSettle(destinationArtifacts).then(() =>
			fs.readdirSync(destinationArtifacts).sort(),
		);
		let settled: string[] | undefined;
		void reader.then(names => {
			settled = names;
		});
		await Promise.resolve();
		expect(settled).toBeUndefined();

		release();
		await copying;
		expect(await reader).toEqual(["0.bash.log", "1.bash.log", "9.read.log"]);
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
