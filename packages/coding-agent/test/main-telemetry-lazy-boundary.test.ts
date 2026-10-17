import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const recorderPath = path.join(import.meta.dir, "fixtures", "boot-module-load-recorder.ts");
const packagesRoot = path.join(repoRoot, "packages", "coding-agent", "src");
const mainModulePath = path.join(packagesRoot, "main.ts");
const telemetryBootstrapPath = path.join(packagesRoot, "telemetry-export.ts");
const otlpExporterPath = path.join(packagesRoot, "telemetry-export-otlp.ts");

interface BootModuleReport {
	entry: string | undefined;
	repoModulesLoaded: number;
	entryEvaluatedMs: number;
	modules: string[];
}

/**
 * Evaluate the real launch-command module graph in a fresh process and report
 * every repository source file it pulled in.
 *
 * The recorder is a `--preload`, so the observation is installed before the
 * entry module's first statement runs — a module loaded while the entry is being
 * evaluated cannot escape the report the way it escaped the previous in-process
 * `process.moduleLoadList` baseline, which this test now also guards by requiring
 * the entry itself to appear in the report.
 */
async function evaluateLaunchModuleGraph(): Promise<string[]> {
	const proc = Bun.spawn([process.execPath, "--preload", recorderPath, mainModulePath], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const line = stdout.split("\n").find(entry => entry.startsWith("BOOT_MODULES "));
	expect(line, `no boot module report on stdout:\n${stdout}`).toBeDefined();
	const report = JSON.parse(line!.slice("BOOT_MODULES ".length)) as BootModuleReport;
	const modules = report.modules.map(module => module.replaceAll("\\", "/"));
	// Positive controls: the entry really was the process entry, and its module
	// graph is observable. Without them a recorder that observed nothing would
	// pass this test.
	expect(report.entry?.replaceAll("\\", "/")).toBe(mainModulePath.replaceAll("\\", "/"));
	expect(modules).toContain(mainModulePath.replaceAll("\\", "/"));
	return modules;
}

describe("launch module graph telemetry boundary", () => {
	test("keeps the OTLP exporter out of the launch command's module graph", async () => {
		const modules = await evaluateLaunchModuleGraph();

		// The bootstrap module is evaluated at boot (its OTEL env contract decides
		// whether export is on), so the recorder provably sees the telemetry edge.
		expect(modules).toContain(telemetryBootstrapPath.replaceAll("\\", "/"));
		// ...but the OpenTelemetry SDK + OTLP exporter graph stays behind
		// `initTelemetryExport`'s endpoint checks.
		expect(modules).not.toContain(otlpExporterPath.replaceAll("\\", "/"));
	}, 60_000);
});
