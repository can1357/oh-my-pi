import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { awaitEvalArtifactsSettled } from "../../src/eval/backend";
import { copySessionArtifacts, whenArtifactCopiesSettle } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";

/**
 * A cell's helpers answer `artifact://<n>` by listing the session's artifacts
 * directory, from a worker (JavaScript) or a subprocess kernel (Python) that
 * cannot see this process's readiness table. The directory alone cannot tell
 * them whether it is the session's yet: during a merge it holds part of an
 * inheritance, and before a copy creates its staging tree it holds none of it
 * while the copy is already under way. So the cell waits here, before it runs.
 */
function sessionWithArtifacts(dir: string): ToolSession {
	return { getArtifactsDir: () => dir } as unknown as ToolSession;
}

describe("eval artifact readiness", () => {
	it("holds a cell for a copy that has announced itself but not staged anything", async () => {
		using tempDir = TempDir.createSync("@omp-eval-readiness-");
		const source = path.join(tempDir.path(), "2026-01-01T00-00-00-000Z_source");
		const destination = path.join(tempDir.path(), "2026-01-01T00-00-01-000Z_destination");
		fs.mkdirSync(source, { recursive: true });
		fs.mkdirSync(destination, { recursive: true });
		fs.writeFileSync(path.join(source, "0.bash.log"), "INHERITED ZERO");
		fs.writeFileSync(path.join(source, "1.bash.log"), "INHERITED ONE");
		fs.writeFileSync(path.join(destination, "8.read.log"), "THE SESSION'S OWN");

		const { promise: held, resolve: release } = Promise.withResolvers<void>();
		const copying = copySessionArtifacts(`${source}.jsonl`, `${destination}.jsonl`, {
			stillTheSource: async () => {
				await held;
				return true;
			},
		});

		let started = false;
		const cell = awaitEvalArtifactsSettled(sessionWithArtifacts(destination)).then(() => {
			started = true;
			return fs.readdirSync(destination).sort();
		});
		await Promise.resolve();
		expect(started).toBe(false);

		release();
		await copying;
		// The whole inheritance, not the part of it that had arrived.
		expect(await cell).toEqual(["0.bash.log", "1.bash.log", "8.read.log"]);
		await whenArtifactCopiesSettle(destination);
	});

	it("does not hold a cell for a staging tree that no copy is using", async () => {
		using tempDir = TempDir.createSync("@omp-eval-readiness-");
		const destination = path.join(tempDir.path(), "2026-01-01T00-00-01-000Z_destination");
		fs.mkdirSync(destination, { recursive: true });
		fs.writeFileSync(path.join(destination, "0.bash.log"), "THE SESSION'S OWN");
		// Left by a copy that was killed, and retained because this process has
		// no record of what that copy created. It is not a copy in flight.
		const retained = `${destination}.retained.staging`;
		fs.mkdirSync(retained);
		fs.writeFileSync(path.join(retained, "left-behind"), "not this process's to remove");

		const outcome = await Promise.race([
			awaitEvalArtifactsSettled(sessionWithArtifacts(destination)).then(() => "settled"),
			new Promise(resolve => setTimeout(() => resolve("waited"), 100)),
		]);
		expect(outcome).toBe("settled");
	});
});
