import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Contract (issue #6815): `setProcessName` must make the kernel-visible process
 * name (`/proc/self/comm`) match the requested name on Linux — not leave it as
 * `bun` the way a bare `process.title` assignment does under Bun.
 *
 * Runs in a subprocess so the test suite's own `comm` is never mutated.
 */

const MODULE = path.resolve(import.meta.dir, "../src/process-name.ts");

describe("setProcessName", () => {
	it.skipIf(os.platform() !== "linux")("sets /proc/self/comm on Linux", async () => {
		const probe = [
			`import { setProcessName } from ${JSON.stringify(MODULE)};`,
			`import * as fs from "node:fs";`,
			`setProcessName("omp-probe");`,
			`const comm = fs.readFileSync("/proc/self/comm", "utf8").trim();`,
			`process.stdout.write(JSON.stringify({ comm, title: process.title }));`,
		].join("\n");

		const result = await Bun.$`bun -e ${probe}`.quiet();
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout.toString()) as { comm: string; title: string };
		// TASK_COMM_LEN caps comm at 15 chars; "omp-probe" fits whole.
		expect(report.comm).toBe("omp-probe");
		expect(report.title).toBe("omp-probe");
	});
});
