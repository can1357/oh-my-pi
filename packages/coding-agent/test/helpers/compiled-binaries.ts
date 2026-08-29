import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Bun 1.4.0 on this host SIGKILLs every `bun build --compile` binary, including
 * `console.log("hi")`. Compile-backed tests should skip rather than fail.
 */
export function compiledBinariesWork(): boolean {
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

export const COMPILED_BINARIES_WORK = compiledBinariesWork();
