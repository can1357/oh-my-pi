// Integration test: the helper must stop real descendants. Fake timers cannot
// advance subprocess execution, signal delivery, or process-table changes.
import { describe, expect, it } from "bun:test";
import { killTree } from "@oh-my-pi/pi-coding-agent/autoresearch/helpers";
import { isEnoent } from "@oh-my-pi/pi-utils";

/** A killed orphan can wait as a zombie until init reaps it, so a zombie counts as stopped. */
async function isRunning(pid: number): Promise<boolean> {
	if (process.platform === "linux") {
		try {
			const stat = await Bun.file(`/proc/${pid}/stat`).text();
			return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
		} catch (error) {
			if (isEnoent(error)) return false;
			throw error;
		}
	}
	const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
		.stdout.toString()
		.trim();
	return state !== "" && !state.startsWith("Z");
}

async function stoppedWithin(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (await isRunning(pid)) {
		if (Date.now() >= deadline) return false;
		await Bun.sleep(25);
	}
	return true;
}

describe("autoresearch killTree", () => {
	it.skipIf(process.platform === "win32")(
		"stops descendants of a child that does not lead its process group",
		async () => {
			const child = Bun.spawn(["/bin/sh", "-c", 'sleep 60 & echo "$!"; wait'], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			let descendant: number | undefined;
			try {
				const reader = child.stdout.getReader();
				const first = await reader.read();
				reader.releaseLock();
				descendant = Number(new TextDecoder().decode(first.value).trim());
				expect(await isRunning(descendant)).toBe(true);

				killTree(child.pid, "SIGKILL");
				await child.exited;

				expect(await stoppedWithin(descendant, 5_000)).toBe(true);
			} finally {
				if (descendant !== undefined && (await isRunning(descendant))) process.kill(descendant, "SIGKILL");
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await child.exited;
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"stops members of a detached group after its leader exits",
		async () => {
			const child = Bun.spawn(["/bin/sh", "-c", 'sleep 60 >/dev/null 2>&1 & echo "$!"'], {
				detached: true,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			let descendant: number | undefined;
			try {
				descendant = Number((await new Response(child.stdout).text()).trim());
				await child.exited;
				expect(await isRunning(descendant)).toBe(true);

				killTree(child.pid, "SIGKILL");

				expect(await stoppedWithin(descendant, 5_000)).toBe(true);
			} finally {
				if (descendant !== undefined && (await isRunning(descendant))) process.kill(descendant, "SIGKILL");
			}
		},
		20_000,
	);
});
