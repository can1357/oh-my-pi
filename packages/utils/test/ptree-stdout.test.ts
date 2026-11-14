import { describe, expect, it } from "bun:test";
import { heapStats } from "bun:jsc";
import { exec } from "@oh-my-pi/pi-utils/ptree";

const LARGE_STDOUT_SIZE = 4 * 1024 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;

function stdoutFixture(size: number): string[] {
	return ["bun", "-e", `await Bun.stdout.write("x".repeat(${size}));`];
}

describe("ptree stdout capture", () => {
	it("drains the pipe without retaining anything when stdout is ignored", async () => {
		const result = await exec(stdoutFixture(LARGE_STDOUT_SIZE), { stdout: "ignore" });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});

	it("retains at most the cap when the capture is bounded", async () => {
		const result = await exec(stdoutFixture(LARGE_STDOUT_SIZE), {
			stdout: "capture",
			maxStdoutBytes: MAX_STDOUT_BYTES,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout.length).toBeLessThanOrEqual(MAX_STDOUT_BYTES);
	});

	it("captures a short answer whole", async () => {
		const result = await exec(["bun", "-e", `await Bun.stdout.write("host-home");`], {
			stdout: "capture",
			maxStdoutBytes: MAX_STDOUT_BYTES,
		});

		expect(result.stdout).toBe("host-home");
	});

	it("does not retain the ignored output while the process handle is alive", async () => {
		const size = 32 * 1024 * 1024;
		Bun.gc(true);
		const before = heapStats().heapSize;
		const result = await exec(stdoutFixture(size), { stdout: "ignore" });
		Bun.gc(true);
		const growth = heapStats().heapSize - before;

		expect(result.stdout).toBe("");
		expect(growth).toBeLessThan(16 * 1024 * 1024);
	});
});
