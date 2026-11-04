/**
 * A transcript the manager no longer holds is collectable while the manager
 * itself stays reachable. Each row runs in its own process with concurrent
 * JIT compilation off: in a process that has warmed the session code, an
 * optimizing-JIT plan on a background thread can keep an object reachable for
 * seconds, so a collection there says little about what the manager holds.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const probePath = path.join(import.meta.dir, "../fixtures/session-transcript-release-probe.ts");

describe("a transcript the manager no longer holds", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-transcript-release-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	async function probe(transcript: string, reference: "dropped" | "held"): Promise<boolean> {
		const child = Bun.spawn([process.execPath, probePath, transcript, reference, tempDir.path()], {
			cwd: path.join(import.meta.dir, "../../../.."),
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: path.join(tempDir.path(), "agent"),
				BUN_JSC_useConcurrentJIT: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const result: unknown = JSON.parse(stdout);
		if (typeof result !== "object" || result === null || !("collected" in result)) {
			throw new Error(`Unexpected probe output: ${stdout}`);
		}
		expect(typeof result.collected).toBe("boolean");
		return result.collected === true;
	}

	it.each([
		{ when: "after releaseRetainedEntries()", transcript: "release-retained-entries" },
		{ when: "after newSession() while every full rewrite fails", transcript: "new-session-while-rewrites-fail" },
		{
			when: "for an off-branch entry after createBranchedSession() while every full rewrite fails",
			transcript: "branched-session-while-rewrites-fail",
		},
		{
			when: "after setSessionFile() follows a newSession() that refused to abandon a turn",
			transcript: "set-session-file-after-refused-switch",
		},
	])(
		"is collectable $when",
		async ({ transcript }) => {
			expect(await probe(transcript, "dropped")).toBe(true);
		},
		30_000,
	);

	it("stays uncollected while something else still holds the entry (control)", async () => {
		expect(await probe("set-session-file-after-refused-switch", "held")).toBe(false);
	}, 30_000);
});
