import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { copySessionArtifacts } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A session journal and the artifacts directory that sits beside it. */
const SOURCE = "2026-01-01T00-00-00-000Z_source";
const DESTINATION = "2026-01-01T00-00-01-000Z_destination";

describe("copying a session's artifacts to another session", () => {
	it("shares write-once artifacts and duplicates everything a session can rewrite", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(path.join(sourceArtifacts, "local"), { recursive: true });
		fs.mkdirSync(path.join(sourceArtifacts, "2026-01-01T00-00-00-000Z_sub"), { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.shake.log"), "shake recovery");
		fs.writeFileSync(path.join(sourceArtifacts, "2.async.log"), "async job output");
		fs.writeFileSync(path.join(sourceArtifacts, "3.bash.log"), "streamed command output");
		fs.writeFileSync(path.join(sourceArtifacts, "4.read.log"), "fetched page");
		fs.writeFileSync(path.join(sourceArtifacts, "Sub.jsonl"), '{"type":"session"}\n');
		fs.writeFileSync(path.join(sourceArtifacts, "local", "PLAN.md"), "the plan");
		fs.writeFileSync(path.join(sourceArtifacts, "2026-01-01T00-00-00-000Z_sub", "5.shake.log"), "nested");

		await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		const shared = ["1.shake.log", "2.async.log"];
		const duplicated = [
			"3.bash.log",
			"4.read.log",
			"Sub.jsonl",
			path.join("local", "PLAN.md"),
			path.join("2026-01-01T00-00-00-000Z_sub", "5.shake.log"),
		];
		for (const name of [...shared, ...duplicated]) {
			const from = path.join(sourceArtifacts, name);
			const to = path.join(destinationArtifacts, name);
			expect(fs.readFileSync(to, "utf8")).toBe(fs.readFileSync(from, "utf8"));
			const sameFile = fs.statSync(to).ino === fs.statSync(from).ino;
			expect({ name, sameFile }).toEqual({ name, sameFile: shared.includes(name) });
		}

		// What the duplication is for: the owner goes on writing its own copy of
		// a rewritable artifact, and none of it reaches this session's history.
		fs.writeFileSync(path.join(sourceArtifacts, "3.bash.log"), "output of the owner's next command");
		fs.writeFileSync(path.join(sourceArtifacts, "local", "PLAN.md"), "the owner's new plan");
		expect(fs.readFileSync(path.join(destinationArtifacts, "3.bash.log"), "utf8")).toBe("streamed command output");
		expect(fs.readFileSync(path.join(destinationArtifacts, "local", "PLAN.md"), "utf8")).toBe("the plan");
	});

	it("keeps an entry the destination already has, linkable or not", async () => {
		using tempDir = TempDir.createSync("@omp-artifact-copy-");
		const sourceArtifacts = path.join(tempDir.path(), SOURCE);
		const destinationArtifacts = path.join(tempDir.path(), DESTINATION);
		fs.mkdirSync(sourceArtifacts, { recursive: true });
		fs.mkdirSync(destinationArtifacts, { recursive: true });
		fs.writeFileSync(path.join(sourceArtifacts, "1.shake.log"), "the source's");
		fs.writeFileSync(path.join(sourceArtifacts, "2.bash.log"), "the source's");
		fs.writeFileSync(path.join(destinationArtifacts, "1.shake.log"), "already here");
		fs.writeFileSync(path.join(destinationArtifacts, "2.bash.log"), "already here");

		await copySessionArtifacts(`${sourceArtifacts}.jsonl`, `${destinationArtifacts}.jsonl`);

		expect(fs.readFileSync(path.join(destinationArtifacts, "1.shake.log"), "utf8")).toBe("already here");
		expect(fs.readFileSync(path.join(destinationArtifacts, "2.bash.log"), "utf8")).toBe("already here");
	});
});
