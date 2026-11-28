import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
const PROBE_PATH = path.join(FIXTURES_DIR, "abort-signal-wrap-probe.ts");

// Calibrated on Bun 1.4.5 Linux x64 (W = 2,000, N = 10,000):
// red growth across 10 runs was 2,186.6–2,294.9 KiB; green growth was 5.9–15.4 KiB.
// 256 KiB sits > 16x above max green and > 8x below min red.
const T1_WARMUP = 2_000;
const T1_COUNT = 10_000;
const T1_MAX_GROWTH_BYTES = 256 * 1024;
const T1_TIMEOUT_MS = 60_000;

// Unit forms mimalloc prints in the `current` column (`B` for values under
// 1 KiB, `KiB`, `MiB`, plus bare `0` with no unit). Any other unit throws so a
// changed Bun dump format fails the test rather than silently passing.
const MIMALLOC_UNIT_MULTIPLIERS: Record<string, number> = {
	B: 1,
	KiB: 1024,
	MiB: 1024 * 1024,
};

interface MimallocSmallBins {
	bins: Map<number, number>;
	totalBytes: number;
}

const BIN_S_LINE_RE = /^\s*bin\s+S\s+(\d+)\s*:\s*(.*)$/;
const SIZE_TOKEN_RE = /^(0(?![.\d])(?:\s+[A-Za-z]+)?|\d+(?:\.\d+)?(?:\s+[A-Za-z]+)?)/;

function consumeSizeToken(rest: string, line: string): [token: string, remaining: string] {
	const trimmed = rest.trimStart();
	const match = SIZE_TOKEN_RE.exec(trimmed);
	if (!match) {
		throw new Error(`malformed mimalloc bin S line: ${line}`);
	}
	return [match[1], trimmed.slice(match[0].length)];
}

function parseCurrentBytes(token: string, line: string): number {
	if (token === "0") {
		return 0;
	}
	const match = /^(\d+(?:\.\d+)?)\s+([A-Za-z]+)$/.exec(token);
	if (!match) {
		throw new Error(`unsupported mimalloc current value "${token}" in line: ${line}`);
	}
	const multiplier = MIMALLOC_UNIT_MULTIPLIERS[match[2]];
	if (multiplier === undefined) {
		throw new Error(`unsupported mimalloc unit "${match[2]}" in line: ${line}`);
	}
	return Math.round(Number(match[1]) * multiplier);
}

function parseMimallocSmallBins(dump: string): MimallocSmallBins {
	const bins = new Map<number, number>();
	let totalBytes = 0;

	for (const line of dump.split(/\r?\n/)) {
		const match = BIN_S_LINE_RE.exec(line);
		if (!match) continue;
		const binIndex = Number(match[1]);
		const [, afterPeak] = consumeSizeToken(match[2], line);
		const [, afterTotal] = consumeSizeToken(afterPeak, line);
		const [currentToken] = consumeSizeToken(afterTotal, line);
		const currentBytes = parseCurrentBytes(currentToken, line);
		bins.set(binIndex, currentBytes);
		totalBytes += currentBytes;
	}

	if (bins.size === 0) {
		throw new Error("mimalloc dump contained no bin S lines");
	}
	return { bins, totalBytes };
}

function extractMarkedBlocks(stderr: string, beginMarker: string, endMarker: string): string[] {
	const blocks: string[] = [];
	const escapedBegin = RegExp.escape(beginMarker);
	const escapedEnd = RegExp.escape(endMarker);
	const re = new RegExp(`^${escapedBegin}\\r?\\n([\\s\\S]*?)^${escapedEnd}$`, "gm");
	for (const match of stderr.matchAll(re)) {
		blocks.push(match[1]);
	}
	return blocks;
}

function formatBinsDiff(before: MimallocSmallBins, after: MimallocSmallBins): string {
	const indices = Array.from(new Set([...before.bins.keys(), ...after.bins.keys()])).sort((a, b) => a - b);
	const rows = indices.map(idx => {
		const b = before.bins.get(idx) ?? 0;
		const a = after.bins.get(idx) ?? 0;
		return `  bin S ${String(idx).padStart(2)}: before=${b} B, after=${a} B, delta=${a - b >= 0 ? "+" : ""}${a - b} B`;
	});
	return [
		`total: before=${before.totalBytes} B, after=${after.totalBytes} B, growth=${after.totalBytes - before.totalBytes} B`,
		...rows,
	].join("\n");
}

const CLEANUP_TIMEOUT_MS = 10_000;
const liveChildren = new Set<Bun.Subprocess>();

async function terminateChild(child: Bun.Subprocess): Promise<void> {
	try {
		child.kill("SIGKILL");
	} catch {
		// Child already exited before kill.
	}
	await child.exited;
}

async function runProbe(warmup: number, count: number): Promise<string> {
	const child = Bun.spawn([process.execPath, PROBE_PATH], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PROBE_WARMUP: String(warmup),
			PROBE_COUNT: String(count),
		},
	});
	liveChildren.add(child);
	let exited = false;
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		exited = true;
		liveChildren.delete(child);
		if (exitCode !== 0) {
			throw new Error(`probe exited with ${String(exitCode)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
		}
		return stderr;
	} finally {
		if (!exited) {
			try {
				await terminateChild(child);
			} finally {
				liveChildren.delete(child);
			}
		}
	}
}

describe.skipIf(process.platform !== "linux")("AbortSignal napi_wrap native memory", () => {
	afterEach(async () => {
		const remaining = Array.from(liveChildren);
		liveChildren.clear();
		await Promise.allSettled(remaining.map(child => terminateChild(child)));
	}, CLEANUP_TIMEOUT_MS);

	// Needs this PR's rust; PR CI loads main's newest or the published natives build.
	test.skipIf(process.env.GITHUB_EVENT_NAME === "pull_request")(
		"frees the native memory that a native call keeps for each new AbortSignal once the signal is collected",
		async () => {
			const stderr = await runProbe(T1_WARMUP, T1_COUNT);
			const dumps = extractMarkedBlocks(stderr, "MIDUMP-BEGIN", "MIDUMP-END");
			expect(dumps.length).toBe(2);

			const before = parseMimallocSmallBins(dumps[0]);
			const after = parseMimallocSmallBins(dumps[1]);
			const growth = after.totalBytes - before.totalBytes;

			if (growth >= T1_MAX_GROWTH_BYTES) {
				throw new Error(
					`mimalloc small-bin live bytes grew by ${growth} B (limit < ${T1_MAX_GROWTH_BYTES} B) across ${T1_COUNT} fresh AbortSignal calls:\n${formatBinsDiff(before, after)}`,
				);
			}
		},
		T1_TIMEOUT_MS,
	);
});
