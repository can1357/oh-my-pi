/**
 * Run by test-preload.test.ts as `bun test` in each test root, started without the
 * test-runtime marker, the way a developer's direct `bun test` starts. It spawns a child
 * each way a test does and prints, as one line, the marker each child received.
 */
import { expect, it } from "bun:test";
import { spawnSync as nodeSpawnSync } from "node:child_process";

const READ_MARKER = ["-e", "process.stdout.write(process.env.PI_TEST_RUNTIME ?? 'unset')"];

it("reports the test-runtime marker each kind of child receives", async () => {
	const cmd = [process.execPath, ...READ_MARKER];
	const received = {
		bunSpawn: await new Response(Bun.spawn(cmd, { stdout: "pipe" }).stdout).text(),
		bunSpawnCmd: await new Response(Bun.spawn({ cmd, stdout: "pipe" }).stdout).text(),
		bunSpawnSync: Bun.spawnSync(cmd).stdout.toString(),
		bunSpawnSyncCmd: Bun.spawnSync({ cmd }).stdout.toString(),
		processEnv: Bun.spawnSync(cmd, { env: { ...process.env } }).stdout.toString(),
		nodeChildProcess: nodeSpawnSync(process.execPath, READ_MARKER, { encoding: "utf8" }).stdout,
		bunShell: await Bun.$`${process.execPath} ${READ_MARKER}`.text(),
		removedByCaller: Bun.spawnSync(cmd, { env: { ...process.env, PI_TEST_RUNTIME: undefined } }).stdout.toString(),
	};
	console.log(`CHILD_MARKERS ${JSON.stringify(received)}`);
	expect(Object.values(received).every(value => value === "1" || value === "unset")).toBe(true);
});
