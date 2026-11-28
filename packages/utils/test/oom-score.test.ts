import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { setToolOomScore, toolShellScript } from "../src/oom-score";

// Failure mode: a tool process whose OOM adjustment the write cannot change fails to start, where it should run with
// the value it has. The writes go to files of a temporary directory in place of `/proc/self/oom_score_adj`.
describe.skipIf(process.platform !== "linux")("setToolOomScore", () => {
	// Root writes a read-only file all the same.
	it.skipIf(process.getuid?.() === 0)("leaves the value and goes on where the file is read-only", () => {
		using dir = TempDir.createSync("@omp-oom-score-");
		const score = dir.join("oom_score_adj");
		fs.writeFileSync(score, "0\n");
		fs.chmodSync(score, 0o444);
		expect(() => setToolOomScore(score)).not.toThrow();
		expect(fs.readFileSync(score, "utf8")).toBe("0\n");
	});

	it("leaves the value and goes on where the path is no file it can write", () => {
		using dir = TempDir.createSync("@omp-oom-score-");
		const directory = dir.join("oom_score_adj");
		fs.mkdirSync(directory);
		expect(() => setToolOomScore(directory)).not.toThrow();
		expect(fs.statSync(directory).isDirectory()).toBe(true);
		const missing = dir.join("missing", "oom_score_adj");
		expect(() => setToolOomScore(missing)).not.toThrow();
		expect(fs.existsSync(missing)).toBe(false);
	});
});

/** Run `script` through `shell` as a tool process whose score file no user can write: a path under a missing directory. */
function runWhereScoreIsUnwritable(shell: string, syntax: "posix" | "fish", script: string) {
	using dir = TempDir.createSync("@omp-oom-score-");
	const score = dir.join("missing", "oom_score_adj");
	const result = Bun.spawnSync([shell, "-c", toolShellScript(script, syntax, score)], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

// Failure mode: where the shell cannot write its OOM adjustment, the user's script starts with status 1: in fish a
// script that starts with `and` is skipped, and `$status` reads 1. The fish case runs where fish is installed.
describe.skipIf(process.platform !== "linux")("toolShellScript where the score file cannot be written", () => {
	const fish = Bun.which("fish");

	it("starts a posix script with status 0", () => {
		const run = runWhereScoreIsUnwritable("/bin/sh", "posix", "echo status=$?");
		expect(run).toEqual({ stdout: "status=0\n", exitCode: 0 });
	});

	it.skipIf(!fish)("starts a fish script with status 0", () => {
		const run = runWhereScoreIsUnwritable(fish ?? "fish", "fish", "and echo ran; echo status=$status");
		expect(run).toEqual({ stdout: "ran\nstatus=0\n", exitCode: 0 });
	});
});
