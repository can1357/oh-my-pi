#!/usr/bin/env bun
/**
 * Boot-time regression guard (Phase A1 of the boot/TUI perf work).
 *
 * Re-runs the `PI_TIMING=x` cold-boot benchmark under hyperfine and fails when
 * the median regresses past `baseline * THRESHOLD`. `PI_TIMING=x` runs the full
 * pre-paint chain in `runRootCommand` and then `process.exit(0)`, so the
 * never-exiting interactive launch becomes a terminating, benchmarkable boot.
 *
 * Boot wall-clock is MACHINE-RELATIVE: a baseline captured on one machine is
 * meaningless on another (and on CI). This is a LOCAL guard — regenerate the
 * baseline on the machine you measure on, then compare on that same machine.
 * It is intentionally NOT wired into CI for that reason.
 *
 *   bun scripts/bench-guard.ts --update   # capture/refresh the baseline
 *   bun scripts/bench-guard.ts            # measure + compare; exit 1 on regression
 *
 * Requires `hyperfine` on PATH.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const THRESHOLD = 1.05; // 5% regression budget
const BASELINE_PATH = path.join(import.meta.dir, "..", "bench", "boot-baseline.json");
const BENCH_COMMAND = "PI_TIMING=x PI_STRICT_EDIT_MODE=1 bun src/cli.ts";
const cwd = path.join(import.meta.dir, "..");

function medianOf(hyperfineJson: string): number {
	const parsed = JSON.parse(hyperfineJson) as { results: Array<{ mean: number; median?: number }> };
	const result = parsed.results[0];
	if (!result) throw new Error("hyperfine produced no result");
	return result.median ?? result.mean;
}

async function measure(): Promise<{ seconds: number; raw: string }> {
	const tmp = path.join(import.meta.dir, "..", "bench", `.boot-run-${Date.now()}.json`);
	const proc = Bun.spawn(["hyperfine", "--warmup", "3", "--min-runs", "10", "--export-json", tmp, BENCH_COMMAND], {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await proc.exited;
	if (code !== 0) throw new Error(`hyperfine exited ${code}`);
	const raw = await Bun.file(tmp).text();
	fs.rmSync(tmp, { force: true });
	return { seconds: medianOf(raw), raw };
}

const update = process.argv.includes("--update");
const { seconds, raw } = await measure();

if (update) {
	fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
	await Bun.write(BASELINE_PATH, raw);
	console.log(`Baseline updated: ${(seconds * 1000).toFixed(0)}ms median -> ${BASELINE_PATH}`);
	process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
	console.error("No baseline found. Run `bun scripts/bench-guard.ts --update` on this machine first.");
	process.exit(2);
}

const baseline = medianOf(await Bun.file(BASELINE_PATH).text());
const ratio = seconds / baseline;
const verdict = ratio > THRESHOLD ? "REGRESSION" : "ok";
console.log(
	`boot median: ${(seconds * 1000).toFixed(0)}ms vs baseline ${(baseline * 1000).toFixed(0)}ms ` +
		`(${((ratio - 1) * 100).toFixed(1)}%, budget ${((THRESHOLD - 1) * 100).toFixed(0)}%) -> ${verdict}`,
);
process.exit(ratio > THRESHOLD ? 1 : 0);
