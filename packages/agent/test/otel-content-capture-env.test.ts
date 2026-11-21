import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT set in OMP's own agent
 * `.env` is read lazily on the first agent loop. The loader keeps it out of
 * `process.env`, so the read must go through `$otelEnv`. A fresh process is
 * needed because the loader runs at module load and the toggle is cached.
 */
const tempDirs: string[] = [];

// Every variable `dirs.ts` consults to pick the profile, agent dir or config/state roots. A probe child
// must not inherit any of them from the developer's shell (e.g. OMP_PROFILE beats PI_PROFILE, and a
// named profile ignores PI_CODING_AGENT_DIR), or it would read a different agent dir than its fixture.
const DIR_RESOLUTION_ENV_RESET = {
	OMP_PROFILE: undefined,
	PI_PROFILE: undefined,
	PI_CONFIG_DIR: undefined,
	XDG_DATA_HOME: undefined,
	XDG_STATE_HOME: undefined,
	XDG_CACHE_HOME: undefined,
};

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
}, 30_000);

async function probeContentCapture(agentEnv: string, shellEnv: Record<string, string> = {}) {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-otel-capture-"));
	tempDirs.push(home);
	const agentDir = path.join(home, "agent");
	await Bun.write(path.join(agentDir, ".env"), agentEnv);
	const telemetryPath = path.join(import.meta.dir, "..", "src", "telemetry.ts");
	const script = [
		`import { resolveTelemetry } from ${JSON.stringify(telemetryPath)};`,
		"const telemetry = resolveTelemetry({}, undefined);",
		"process.stdout.write(JSON.stringify({",
		"  contentCapture: telemetry?.contentCapture,",
		"  processEnv: process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ?? null,",
		"}));",
	].join("\n");
	const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
		cwd: home,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: agentDir,
			...DIR_RESOLUTION_ENV_RESET,
			OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: undefined,
			...shellEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as { contentCapture: string; processEnv: string | null };
}

describe("content capture from OMP's own .env", () => {
	it.skipIf(process.platform === "win32")(
		"applies an agent .env value without placing it in process.env",
		async () => {
			const result = await probeContentCapture("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=full\n");
			expect(result).toEqual({ contentCapture: "full", processEnv: null });
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")(
		"lets a shell-exported value win over the agent .env",
		async () => {
			const result = await probeContentCapture("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=full\n", {
				OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "summary",
			});
			expect(result).toEqual({ contentCapture: "summary", processEnv: "summary" });
		},
		30_000,
	);
});
