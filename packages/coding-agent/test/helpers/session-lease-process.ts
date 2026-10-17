/**
 * Session ownership leases held or probed from a second process. Claims inside one process are reference-counted and
 * never conflict, so "another process owns this session" can only be exercised from a real child.
 *
 * The child must lease in the SAME namespace as the test process. Leases are keyed by session id under one directory
 * (`PI_TEST_SESSION_OWNERS_DIR`, exported by the session storage module when the test runtime loads it). `Bun.spawn`'s
 * default environment is a snapshot taken at startup, which does not contain that runtime-exported variable: a child
 * spawned without an explicit `env` falls back to the real state directory and conflicts with nothing. The children
 * here therefore get the live `process.env`, and {@link holdLeaseInAnotherProcess} verifies the shared namespace.
 */
import type { Subprocess } from "bun";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const children: Subprocess[] = [];

/** Runs `body` in a child process (`FileSessionStorage` is imported) and resolves with the first chunk it prints. */
async function runInChild(body: string, options: { keepAlive: boolean }): Promise<string> {
	const hold = `const done = Promise.withResolvers();
process.stdin.once("end", () => done.resolve());
await done.promise;`;
	const script = `import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
${body}
${options.keepAlive ? hold : ""}`;
	const child = Bun.spawn([process.execPath, "-e", script], {
		cwd: import.meta.dir,
		env: { ...process.env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	children.push(child);
	const reader = child.stdout.getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	if (!options.keepAlive) await child.exited;
	return new TextDecoder().decode(value);
}

/**
 * Whether another process could take the ownership lease of session `id` (stored in `file`). A held lease is held by
 * this process or a process spawned from it; a free one is released again before this resolves.
 */
export async function leaseFreeInAnotherProcess(file: string, id: string): Promise<boolean> {
	const verdict = await runInChild(
		`process.stdout.write(new FileSessionStorage().claimSession(${JSON.stringify(id)}, ${JSON.stringify(file)}) ? "free" : "held");`,
		{ keepAlive: false },
	);
	if (verdict !== "free" && verdict !== "held") throw new Error(`lease probe printed ${JSON.stringify(verdict)}`);
	return verdict === "free";
}

/** Another process that holds the ownership lease of session `id` (stored in `file`) until {@link killLeaseProcesses}. */
export async function holdLeaseInAnotherProcess(file: string, id: string): Promise<void> {
	const verdict = await runInChild(
		`const release = new FileSessionStorage().claimSession(${JSON.stringify(id)}, ${JSON.stringify(file)});
process.stdout.write(release ? "held\\n" : "busy\\n");`,
		{ keepAlive: true },
	);
	if (verdict !== "held\n") throw new Error(`lease holder printed ${JSON.stringify(verdict)}`);
	// A holder in another namespace would leave every "refused" assertion to pass or fail by accident: fail here.
	const probe = tryAcquireSessionLease(id);
	if (probe !== null) {
		probe.release();
		throw new Error("the lease holder does not share this process's session lease namespace");
	}
}

/** Stops every child a test started, releasing the leases they hold. */
export function killLeaseProcesses(): void {
	for (const child of children.splice(0)) child.kill();
}
