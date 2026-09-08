import { describe, expect, it, spyOn } from "bun:test";
import { Process } from "@oh-my-pi/pi-natives";
import { spawn } from "@oh-my-pi/pi-utils/ptree";

describe("ptree.ChildProcess.killAndWait()", () => {
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
