import { describe, expect, test } from "bun:test";
import * as path from "node:path";

interface CacheProbeResult {
	modules: number;
	bytes: number;
	paths: string[];
}

const probePath = path.resolve(import.meta.dir, "fixtures", "legacy-pi-babel-cache-probe.ts");
const positiveControlPath = path.resolve(import.meta.dir, "fixtures", "legacy-pi-babel-cache-positive-control.ts");

async function runProbe(childPath: string): Promise<CacheProbeResult> {
	const proc = Bun.spawn([process.execPath, childPath], {
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
	return JSON.parse(stdout) as CacheProbeResult;
}

describe("legacy Pi Babel startup closure", () => {
	test("detector observes a substantial traverse/types positive-control closure", async () => {
		const result = await runProbe(positiveControlPath);
		// Babel 8 ships each package as one bundled `lib/index.js`.
		expect(result.paths, JSON.stringify(result)).toEqual([
			expect.stringMatching(/[\\/]node_modules[\\/]@babel[\\/]traverse[\\/]/),
			expect.stringMatching(/[\\/]node_modules[\\/]@babel[\\/]types[\\/]/),
		]);
		expect(result.bytes, JSON.stringify(result)).toBeGreaterThanOrEqual(400_000);
	}, 30_000);

	test("static legacy compatibility import evaluates no traverse/types modules", async () => {
		const result = await runProbe(probePath);
		expect({ modules: result.modules, bytes: result.bytes }, JSON.stringify(result)).toEqual({
			modules: 0,
			bytes: 0,
		});
	}, 30_000);
});
