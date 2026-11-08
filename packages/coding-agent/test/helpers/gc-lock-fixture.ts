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

/**
 * Run `omp gc` with `flags` in a real process and kill it with SIGKILL the
 * moment it unlinks `target`: just before the `unlink` reaches the kernel,
 * or just after it returns. Nothing of the killed run cleans up, as with a
 * kill from outside. Returns how the process ended, for the caller to check
 * that the kill landed.
 */
export async function runGcKilledAtUnlink(
	flags: Record<string, unknown>,
	target: string,
	when: "before" | "after",
): Promise<{ signal: string | null; exit: number; stderr: string }> {
	const cliModule = path.join(import.meta.dir, "..", "..", "src", "cli", "gc-cli.ts");
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const { spyOn } = await import("bun:test");
const fs = await import("node:fs/promises");
const { runGcCommand } = await import(${JSON.stringify(cliModule)});
const target = process.env.GC_KILL_AT;
const before = process.env.GC_KILL_WHEN === "before";
const unlink = fs.unlink;
spyOn(fs, "unlink").mockImplementation(async file => {
	const hit = String(file) === target;
	if (hit && before) process.kill(process.pid, "SIGKILL");
	await unlink(file);
	if (hit) process.kill(process.pid, "SIGKILL");
});
await runGcCommand({ flags: JSON.parse(process.env.GC_FLAGS) });`,
		],
		{
			env: { ...process.env, GC_KILL_AT: target, GC_KILL_WHEN: when, GC_FLAGS: JSON.stringify(flags) },
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	const exit = await child.exited;
	return { signal: child.signalCode, exit, stderr: await new Response(child.stderr).text() };
}
