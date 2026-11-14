import { expect, test } from "bun:test";
import * as path from "node:path";

const fixture = path.join(import.meta.dir, "fixtures/power-assertion-pause.ts");

test("keeps sleep prevention released through a paused setting change, then holds the new mode for resumed work", async () => {
	// A child process exercises AgentSession's real assertion path; bun test itself deliberately disables it.
	const child = Bun.spawn([process.execPath, fixture], {
		env: { ...process.env, BUN_ENV: "production", NODE_ENV: "production", PI_TEST_RUNTIME: "0" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual([
			["acquire", "idle"],
			["request-pause", "idle"],
			["release", "idle"],
			["parked", null],
			["changed-setting", null],
			["acquire", "display"],
			["tool", "display"],
			["release", "display"],
			["settled", null],
		]);
	} finally {
		child.kill();
		await child.exited;
	}
}, 15_000);
