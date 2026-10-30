import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import {
	awaitEvalArtifactsSettled,
	EVAL_ARTIFACTS_READY_BRIDGE_NAME,
	resolveSettledArtifact,
} from "../../src/eval/artifact-readiness";
import { createHelpers } from "../../src/eval/js/shared/helpers";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
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

	it("holds a helper's artifact read, not the cell that admitted it", async () => {
		using tempDir = TempDir.createSync("@omp-eval-readiness-");
		const source = path.join(tempDir.path(), "2026-01-01T00-00-00-000Z_source");
		const destination = path.join(tempDir.path(), "2026-01-01T00-00-01-000Z_destination");
		fs.mkdirSync(source, { recursive: true });
		fs.mkdirSync(destination, { recursive: true });
		fs.writeFileSync(path.join(source, "0.bash.log"), "INHERITED ZERO");
		fs.writeFileSync(path.join(source, "1.bash.log"), "INHERITED ONE");
		fs.writeFileSync(path.join(destination, "8.read.log"), "THE SESSION'S OWN");
		const session = sessionWithArtifacts(destination);

		// The copy starts after this reader exists — a retained tool, or work a
		// past cell left running, is in exactly this position.
		const helpers = createHelpers({
			cwd: () => tempDir.path(),
			env: new Map(),
			localRoots: () => ({ artifact: destination }),
			emitStatus: () => {},
			resolveArtifact: async id => {
				const value = await callSessionTool(EVAL_ARTIFACTS_READY_BRIDGE_NAME, { id }, { session });
				return typeof value === "string" && value.length > 0 ? value : null;
			},
		});

		const { promise: held, resolve: release } = Promise.withResolvers<void>();
		const copying = copySessionArtifacts(`${source}.jsonl`, `${destination}.jsonl`, {
			stillTheSource: async () => {
				await held;
				return true;
			},
		});
		let answered = false;
		const reading = helpers.read("artifact://1").then(text => {
			answered = true;
			return text;
		});
		await Promise.resolve();
		expect(answered).toBe(false);

		release();
		await copying;
		expect(await reading).toBe("INHERITED ONE");
		await whenArtifactCopiesSettle(destination);
	});

	it("answers with a file only while no copy is running, however late one starts", async () => {
		using tempDir = TempDir.createSync("@omp-eval-readiness-");
		const source = path.join(tempDir.path(), "2026-01-01T00-00-00-000Z_source");
		const destination = path.join(tempDir.path(), "2026-01-01T00-00-01-000Z_destination");
		const second = path.join(tempDir.path(), "2026-01-01T00-00-02-000Z_second");
		fs.mkdirSync(source, { recursive: true });
		fs.mkdirSync(second, { recursive: true });
		fs.mkdirSync(destination, { recursive: true });
		fs.writeFileSync(path.join(source, "0.bash.log"), "INHERITED ZERO");
		fs.writeFileSync(path.join(second, "1.bash.log"), "INHERITED ONE");
		fs.writeFileSync(path.join(destination, "8.read.log"), "THE SESSION'S OWN");

		// The second copy is announced while the first is finishing, which is
		// the window an answer given before a listing cannot cover.
		const { promise: held, resolve: release } = Promise.withResolvers<void>();
		let followUp: Promise<unknown> | undefined;
		const { promise: secondHeld, resolve: releaseSecond } = Promise.withResolvers<void>();
		const first = copySessionArtifacts(`${source}.jsonl`, `${destination}.jsonl`, {
			stillTheSource: async () => {
				await held;
				followUp = copySessionArtifacts(`${second}.jsonl`, `${destination}.jsonl`, {
					stillTheSource: async () => {
						await secondHeld;
						return true;
					},
				});
				return true;
			},
		});

		let answer: string | null | undefined;
		const resolving = resolveSettledArtifact(sessionWithArtifacts(destination), "1").then(value => {
			answer = value;
			return value;
		});
		release();
		await first;
		await Promise.resolve();
		expect(answer).toBeUndefined();

		releaseSecond();
		await followUp;
		// Answered with the file the second copy brought, not with "absent"
		// from a listing taken between the two.
		expect(await resolving).toBe(path.join(destination, "1.bash.log"));
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
