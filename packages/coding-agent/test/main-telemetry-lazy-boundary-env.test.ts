import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const boundarySuite = path.join(import.meta.dir, "main-telemetry-lazy-boundary.test.ts");

/**
 * Run the boundary suite in a child process whose environment configures an
 * OTLP endpoint, and report the child's exit code and output.
 *
 * The boundary suite observes the *endpoint-disabled* startup path, so it must
 * not inherit a host that configures an endpoint: with one set, the launch
 * legitimately loads the OTLP exporter and the assertion fails although the
 * product behaves correctly. The kill switch is explicitly released, so the
 * endpoint check — not the switch — is what has to keep the exporter out.
 */
async function runBoundarySuiteWithEndpoint(): Promise<{ exitCode: number; output: string }> {
	const proc = Bun.spawn([process.execPath, "test", boundarySuite], {
		cwd: repoRoot,
		env: {
			...process.env,
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
			OTEL_SDK_DISABLED: "false",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, output: `${stdout}${stderr}` };
}

describe("launch module graph telemetry boundary under a configured endpoint", () => {
	// The disabled-startup probe must be deterministic on a host that has an
	// OTLP endpoint configured: the child gets a sanitized environment, so the
	// launch it observes is the endpoint-disabled one the probe asserts about.
	test("keeps the OTLP exporter out of the graph on a host that configures an endpoint", async () => {
		const outcome = await runBoundarySuiteWithEndpoint();
		expect(outcome.exitCode, outcome.output).toBe(0);
	}, 120_000);
});
