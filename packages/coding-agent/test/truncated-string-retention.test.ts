import { describe, expect, test } from "bun:test";
import * as path from "node:path";

interface ProbeResult {
	retainedBytes: number;
	retainedChars: number;
}

const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const probePath = path.resolve(import.meta.dir, "fixtures", "truncated-string-retention-probe.ts");

async function runProbe(mode: "raw-sse" | "tool-output"): Promise<ProbeResult> {
	const proc = Bun.spawn([process.execPath, "--smol", probePath, mode], {
		cwd: path.resolve(import.meta.dir, "../.."),
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const [retainedBytes, retainedChars] = stdout.trim().split("\n").map(Number);
	if (!Number.isFinite(retainedBytes) || !Number.isFinite(retainedChars)) {
		throw new Error(`invalid retention probe output: ${stdout}`);
	}
	return { retainedBytes, retainedChars };
}

describe("truncated string ownership", () => {
	test("raw SSE windows do not retain oversized event backing strings", async () => {
		const result = await runProbe("raw-sse");
		expect(result.retainedChars).toBeGreaterThan(0);
		expect(result.retainedBytes, JSON.stringify(result)).toBeLessThan(MAX_RETAINED_BYTES);
	});

	test("tool-output windows do not retain oversized result backing strings", async () => {
		const result = await runProbe("tool-output");
		expect(result.retainedChars).toBeGreaterThan(0);
		expect(result.retainedBytes, JSON.stringify(result)).toBeLessThan(MAX_RETAINED_BYTES);
	});
});
