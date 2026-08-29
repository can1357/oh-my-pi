import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Opt out of compile-backed tests on hosts that cannot launch `bun build --compile`
 * binaries. Set this explicitly — do not rely on a silent probe in CI.
 */
const EXPLICIT_UNSUPPORTED =
	process.env.OMP_SKIP_COMPILED_BINARY_TESTS === "1" || process.env.OMP_SKIP_COMPILED_BINARY_TESTS === "true";

function inContinuousIntegration(): boolean {
	return process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
}

/**
 * Probe whether a minimal `bun build --compile` binary can launch.
 * Used only outside CI so a broken local Bun (e.g. SIGKILL on compile) can skip
 * without failing the whole suite. In CI, compile/launch failure must fail tests.
 */
function probeCompiledBinaries(): boolean {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-compile-probe-"));
	try {
		const entry = path.join(dir, "hi.ts");
		const outfile = path.join(dir, "hi");
		fs.writeFileSync(entry, 'console.log("hi");\n');
		const compile = Bun.spawnSync([process.execPath, "build", "--compile", `--outfile=${outfile}`, entry], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (compile.exitCode !== 0 || !fs.existsSync(outfile)) return false;
		const run = Bun.spawnSync([outfile], { stdout: "pipe", stderr: "pipe" });
		return run.exitCode === 0;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Whether compile-backed tests should run.
 *
 * - Explicit unsupported env (`OMP_SKIP_COMPILED_BINARY_TESTS`) → skip
 * - CI → always run (a failed compile/launch fails the suite)
 * - Local → probe, skip only when the host cannot launch compiled binaries
 */
export function compiledBinariesWork(): boolean {
	if (EXPLICIT_UNSUPPORTED) return false;
	if (inContinuousIntegration()) return true;
	return probeCompiledBinaries();
}

export const COMPILED_BINARIES_WORK = compiledBinariesWork();
