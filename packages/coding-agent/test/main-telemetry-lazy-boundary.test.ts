import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const recorderPath = path.join(import.meta.dir, "fixtures", "boot-module-load-recorder.ts");
const childPath = path.join(import.meta.dir, "fixtures", "telemetry-boot-graph-child.ts");
const packagesRoot = path.join(repoRoot, "packages", "coding-agent", "src");
const mainModulePath = path.join(packagesRoot, "main.ts");
const telemetryBootstrapPath = path.join(packagesRoot, "telemetry-export.ts");
const otlpExporterPath = path.join(packagesRoot, "telemetry-export-otlp.ts");
const extensionLoaderPath = path.join(packagesRoot, "extensibility", "extensions", "loader.ts");

interface BootModuleReport {
	entry: string | undefined;
	repoModulesLoaded: number;
	entryEvaluatedMs: number;
	modules: string[];
}

function toPosix(value: string): string {
	return value.replaceAll("\\", "/");
}

/**
 * The `OTEL_*` variables that decide whether a launch registers an OTLP
 * exporter. A host that sets any of them legitimately loads the exporter, so
 * the disabled-startup probe must not inherit them.
 */
const OTEL_ENDPOINT_VARS = [
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	"OTEL_TRACES_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_METRICS_EXPORTER",
] as const;

/**
 * The child's environment, with every OTLP endpoint removed.
 *
 * The probe observes the *endpoint-disabled* startup path, so the child must
 * not inherit a developer's `OTEL_EXPORTER_OTLP_ENDPOINT` (or a signal-specific
 * endpoint): with one set, the launch legitimately loads the OTLP exporter and
 * the assertion fails although the product behaves correctly. The kill switch
 * is cleared as well, so the endpoint check — not the switch — is what keeps
 * the exporter out of the graph.
 */
function disabledTelemetryEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if ((OTEL_ENDPOINT_VARS as readonly string[]).includes(key)) continue;
		if (key === "OTEL_SDK_DISABLED") continue;
		env[key] = value;
	}
	return env;
}

/**
 * Run the real launch in a fresh process and report every repository source
 * file it pulled in.
 *
 * The recorder is a `--preload`, so the observation is installed before the
 * entry module's first statement runs. The entry is the boot-graph child, not
 * `main.ts` itself: `main.ts` only exports `main()`/`runRootCommand()` and has
 * no top-level invocation, so importing it evaluates the module graph without
 * running the launch. The child calls the exported entry point with print-mode
 * arguments and stops at the session-creation boundary — which sits after the
 * telemetry initialization — so the recorded graph is the graph a real launch
 * builds.
 */
async function evaluateLaunchModuleGraph(): Promise<string[]> {
	const proc = Bun.spawn([process.execPath, "--preload", recorderPath, childPath], {
		cwd: repoRoot,
		env: disabledTelemetryEnv(),
		stdin: "ignore",
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
	const modules = report.modules.map(module => toPosix(module));
	// Positive controls: the child really was the process entry, the recorder
	// observed a non-empty graph, and that graph covers the launch path (the
	// extension loader is only imported from inside `runRootCommand`). Without
	// them a recorder that observed nothing — or a child that never launched —
	// would pass this test.
	expect(report.entry ? toPosix(report.entry) : undefined).toBe(toPosix(childPath));
	expect(report.repoModulesLoaded).toBeGreaterThan(0);
	expect(modules).toContain(toPosix(mainModulePath));
	expect(modules).toContain(toPosix(extensionLoaderPath));
	return modules;
}

describe("launch module graph telemetry boundary", () => {
	test("keeps the OTLP exporter out of the launch command's module graph", async () => {
		const modules = await evaluateLaunchModuleGraph();

		// The bootstrap module is evaluated at boot (its OTEL env contract decides
		// whether export is on), so the recorder provably sees the telemetry edge.
		expect(modules).toContain(toPosix(telemetryBootstrapPath));
		// ...but the OpenTelemetry SDK + OTLP exporter graph stays behind
		// `initTelemetryExport`'s endpoint checks.
		expect(modules).not.toContain(toPosix(otlpExporterPath));
	}, 60_000);
});
