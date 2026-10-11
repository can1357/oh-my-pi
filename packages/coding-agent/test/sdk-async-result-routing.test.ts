import { describe, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const probe = path.join(import.meta.dir, "fixtures/sdk-async-routing-probe.ts");

describe("SDK subagent IRC follow-up delivery", () => {
	for (const [mode, scenario] of [
		["single", "a single root"],
		["collision", "two live roots with default agent ids"],
		["reload", "an unrelated root reopened from disk"],
		["unique", "two roots with distinct agent ids"],
	]) {
		it(`persists the follow-up only in its owning session with ${scenario}`, () => {
			const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-async-routing-"));
			try {
				const result = Bun.spawnSync([process.execPath, probe, mode], {
					env: { ...process.env, HOME: home, OMP_PROFILE: "omp-desktop-test" },
					stdout: "pipe",
					stderr: "pipe",
					timeout: 45_000,
				});
				if (result.exitCode !== 0) {
					throw new Error(
						`IRC follow-up ${mode} failed (${result.exitCode}):\n${result.stdout.toString()}\n${result.stderr.toString()}`,
					);
				}
			} finally {
				fs.rmSync(home, { recursive: true, force: true });
			}
		}, 60_000);
	}
});
