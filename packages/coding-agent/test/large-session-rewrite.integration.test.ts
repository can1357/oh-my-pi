import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";

interface ProbeResult {
	sourceBytes: number;
	rewrittenBytes: number;
	peakBytes: number;
	retainedBytes: number;
}

const SHOULD_RUN = Bun.env.PI_SESSION_2GIB_INTEGRATION === "1";
const MAX_PEAK_BYTES = 5 * 1024 ** 3;
const MAX_RETAINED_BYTES = 512 * 1024 ** 2;
const probePath = path.resolve(import.meta.dir, "fixtures", "large-session-rewrite-probe.ts");
/** The largest session seen to stop saving. */
const SESSION_BYTES = 2_570_000_000;

function parseProbeResult(stdout: string): ProbeResult {
	const parsed: unknown = JSON.parse(stdout);
	if (!isRecord(parsed)) throw new Error(`invalid large-rewrite probe output: ${stdout}`);
	const { sourceBytes, rewrittenBytes, peakBytes, retainedBytes } = parsed;
	if (
		typeof sourceBytes !== "number" ||
		!Number.isFinite(sourceBytes) ||
		typeof rewrittenBytes !== "number" ||
		!Number.isFinite(rewrittenBytes) ||
		typeof peakBytes !== "number" ||
		!Number.isFinite(peakBytes) ||
		typeof retainedBytes !== "number" ||
		!Number.isFinite(retainedBytes)
	) {
		throw new Error(`invalid large-rewrite probe output: ${stdout}`);
	}
	return { sourceBytes, rewrittenBytes, peakBytes, retainedBytes };
}

async function runProbe(mode: "plain" | "fail-closed"): Promise<ProbeResult> {
	const proc = Bun.spawn(
		[
			"systemd-run",
			"--user",
			"--scope",
			"-q",
			"-p",
			"MemoryMax=8G",
			"-p",
			"MemorySwapMax=0",
			process.execPath,
			probePath,
			mode,
			String(SESSION_BYTES),
		],
		{ cwd: path.resolve(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return parseProbeResult(stdout);
}

describe.skipIf(!SHOULD_RUN)("multi-gibabyte session rewrite", () => {
	test.each([
		{ mode: "plain" as const, open: "a plain open" },
		{ mode: "fail-closed" as const, open: "a fail-closed open that checks the content digest" },
	])(
		"rewrites a synthetic session beyond the string limit within the memory cap after $open",
		async ({ mode }) => {
			const result = await runProbe(mode);

			expect(result.sourceBytes).toBeGreaterThan(2 ** 31);
			expect(result.rewrittenBytes).toBeGreaterThan(2 ** 31);
			expect(result.peakBytes, JSON.stringify(result)).toBeLessThan(MAX_PEAK_BYTES);
			expect(result.retainedBytes, JSON.stringify(result)).toBeLessThan(MAX_RETAINED_BYTES);
		},
		15 * 60_000,
	);
});
