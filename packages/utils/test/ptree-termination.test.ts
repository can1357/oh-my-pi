import { describe, expect, it, spyOn } from "bun:test";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { spawn } from "@oh-my-pi/pi-utils/ptree";

describe("ptree.ChildProcess.killAndWait()", () => {
	it("waits for a pipe-holding descendant after its root exits", async () => {
		const command =
			process.platform === "win32"
				? [process.execPath, `${import.meta.dir}/fixtures/ptree-dead-root-probe.ts`]
				: ["/bin/sh", "-c", "sleep 30 & echo $!"];
		const child = spawn(command, { detached: true });
		const reader = child.stdout.getReader();
		let descendant: Process | null = null;
		try {
			const output = await reader.read();
			const pid = Number.parseInt(new TextDecoder().decode(output.value), 10);
			descendant = Process.fromPid(pid);
			if (!descendant) throw new Error("Descendant exited before termination");
			await child.proc.exited;
			expect(descendant.status()).toBe(ProcessStatus.Running);
			await child.killAndWait(undefined, -1);
			expect(descendant.status()).toBe(ProcessStatus.Exited);
		} finally {
			descendant?.killTree(9);
			child.kill(undefined, -1);
			await reader.cancel();
		}
	});

	it.skipIf(process.platform === "win32")(
		"reports synchronous group-termination errors without interrupting kill",
		async () => {
			const child = spawn(["/bin/sh", "-c", "sleep 30 & echo $!"], { detached: true });
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			const killGroupAndWait = Process.killGroupAndWait;
			const spy = spyOn(Process, "killGroupAndWait").mockImplementation((pgid, options) => {
				if (pgid === child.pid) throw new Error("Cannot observe process group");
				return killGroupAndWait(pgid, options);
			});
			try {
				const output = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				await child.proc.exited;
				child.kill(undefined, -1);
				await expect(child.killAndWait(undefined, -1)).rejects.toThrow("Cannot observe process group");
			} finally {
				spy.mockRestore();
				descendant?.killTree(9);
				await child.killAndWait(undefined, -1);
				await reader.cancel();
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"waits for subreaper descendants during immediate hard termination",
		async () => {
			const child = spawn(["/bin/sh", "-c", "sleep 30 & echo $!; wait"], { subreaper: true });
			const root = Process.fromPid(child.pid);
			if (!root) throw new Error("Subreaper exited before termination");
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			try {
				const output = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				expect(descendant.status()).toBe(ProcessStatus.Running);
				await child.killAndWait(undefined, -1);
				expect(descendant.status()).toBe(ProcessStatus.Exited);
				expect(root.status()).toBe(ProcessStatus.Exited);
			} finally {
				descendant?.killTree(9);
				child.kill(undefined, -1);
				await child.proc.exited;
				await reader.cancel();
			}
		},
	);

	for (const failure of ["timeout", "error"] as const) {
		it(`surfaces native termination ${failure} even after the root exits`, async () => {
			const child = spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
			const terminate = Process.prototype.terminate;
			const spy = spyOn(Process.prototype, "terminate").mockImplementation(async function (this: Process, options) {
				const result = await terminate.call(this, options);
				if (this.pid !== child.pid) return result;
				if (failure === "error") throw new Error("Native termination failed");
				return false;
			});
			try {
				await expect(child.killAndWait(undefined, -1)).rejects.toThrow(
					failure === "timeout" ? "Process tree termination timed out" : "Native termination failed",
				);
			} finally {
				spy.mockRestore();
				child.kill(undefined, -1);
				await child.proc.exited;
			}
		});
	}
});
