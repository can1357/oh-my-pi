/**
 * Started as a Worker by test-preload.fixture.ts. A Worker has a JavaScript realm of its own,
 * which the preload's changes to the test's realm never reach. It reports the marker that a
 * child receives when the Worker spawns it with Bun's default environment.
 */
const cmd = [process.execPath, "-e", "process.stdout.write(process.env.PI_TEST_RUNTIME ?? 'unset')"];

postMessage({
	workerBunSpawn: await new Response(Bun.spawn(cmd, { stdout: "pipe" }).stdout).text(),
	workerBunSpawnSync: Bun.spawnSync(cmd).stdout.toString(),
});
