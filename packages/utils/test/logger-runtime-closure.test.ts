import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoggerCacheSnapshot } from "./fixtures/logger-cache-snapshot";

const fixtureDir = path.join(import.meta.dir, "fixtures");
const probePath = path.join(fixtureDir, "logger-cache-probe.ts");
const positiveControlPath = path.join(fixtureDir, "logger-cache-positive-control.ts");
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function makeRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function runProbe(scenario: "import" | "console" | "file"): Promise<LoggerCacheSnapshot> {
	const root = await makeRoot("omp-logger-cache-");
	const outputPath = path.join(root, "result.json");
	const logsDir = path.join(root, "logs");
	await fs.mkdir(logsDir);
	const proc = Bun.spawn([process.execPath, probePath, scenario, outputPath, logsDir], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: { ...process.env, TZ: "Etc/GMT+5" },
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(await fs.readFile(outputPath, "utf8")) as LoggerCacheSnapshot;
}

async function runPositiveControl(): Promise<LoggerCacheSnapshot> {
	const root = await makeRoot("omp-logger-cache-control-");
	const outputPath = path.join(root, "result.json");
	const proc = Bun.spawn([process.execPath, positiveControlPath, outputPath], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(proc.stderr).text();
	expect(await proc.exited, await stderr).toBe(0);
	return JSON.parse(await fs.readFile(outputPath, "utf8")) as LoggerCacheSnapshot;
}

describe("central logger runtime closure", () => {
	test("detector observes the direct rotating-file positive control", async () => {
		const { rotatingFile } = await runPositiveControl();
		expect(rotatingFile.modules, JSON.stringify(rotatingFile)).toBeGreaterThan(0);
		expect(rotatingFile.bytes, JSON.stringify(rotatingFile)).toBeGreaterThan(0);
	}, 30_000);

	for (const scenario of ["import", "console", "file"] as const) {
		test(`${scenario} evaluates zero external logger runtime modules`, async () => {
			const snapshot = await runProbe(scenario);
			expect(
				{
					logger: snapshot.externalLogger.modules,
					rotator: snapshot.externalRotator.modules,
				},
				JSON.stringify(snapshot),
			).toEqual({ logger: 0, rotator: 0 });
		}, 30_000);
	}
});
