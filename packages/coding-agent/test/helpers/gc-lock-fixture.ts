import * as path from "node:path";

/**
 * Leave `<agentDir>/gc.lock` the way a gc run killed while it held the lock
 * leaves it: taken by a real process through `withGcLock`, random value and
 * all, and that process then killed with SIGKILL, so nothing of it releases
 * the lock. Taken by gc itself, not written by the test, so what the test
 * takes over is exactly what gc writes.
 */
export async function leaveDeadGcLock(agentDir: string): Promise<void> {
	const lockModule = path.join(import.meta.dir, "..", "..", "src", "session", "gc-lock.ts");
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const { withGcLock } = await import(${JSON.stringify(lockModule)});
await withGcLock(process.env.GC_LOCK_FIXTURE_DIR, async () => {
	process.kill(process.pid, "SIGKILL");
	await new Promise(() => {});
});`,
		],
		{ env: { ...process.env, GC_LOCK_FIXTURE_DIR: agentDir }, stdout: "ignore", stderr: "pipe" },
	);
	const exit = await child.exited;
	if (child.signalCode !== "SIGKILL") {
		throw new Error(`the lock holder was not killed (exit ${exit}): ${await new Response(child.stderr).text()}`);
	}
	if (!(await Bun.file(path.join(agentDir, "gc.lock")).exists())) throw new Error("the killed holder left no gc.lock");
}
