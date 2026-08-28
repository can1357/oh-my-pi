/**
 * Put an `omp` executable where Tauri's `externalBin` expects it.
 *
 * Tauri requires the target triple as a filename suffix — `omp-aarch64-apple-darwin`
 * — and resolves it flat next to the app executable. `bundle.externalBin` says
 * "binaries/omp" but the Rust `sidecar()` call takes the bare basename; that
 * mismatch is a runtime ENOENT, not a build error, so this script exists to make
 * the layout explicit and checkable.
 *
 * Three sources, in order of preference:
 *   1. `--from <path>`         — an explicit compiled binary
 *   2. a repo build            — packages/coding-agent/dist/omp, if present
 *   3. a dev shim              — a shell script that execs the installed omp
 *
 * The shim exists because building omp from source needs the pi-natives addon,
 * which needs nightly Rust. For driving the UI in development, exec'ing the
 * globally installed omp is equivalent and costs nothing.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const HERE = path.dirname(path.dirname(Bun.fileURLToPath(import.meta.url)));
const BIN_DIR = path.join(HERE, "src-tauri", "binaries");

/** The triple Tauri appends, as reported by rustc itself. */
async function targetTriple(): Promise<string> {
	const out = await $`rustc -vV`.text().catch(() => "");
	const match = out.match(/^host:\s*(\S+)$/m);
	if (match) return match[1];

	// rustc missing: fall back to the platform we are running on.
	const arch = os.arch() === "arm64" ? "aarch64" : "x86_64";
	if (process.platform === "darwin") return `${arch}-apple-darwin`;
	if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
	return `${arch}-unknown-linux-gnu`;
}

async function exists(file: string): Promise<boolean> {
	return await fs
		.access(file)
		.then(() => true)
		.catch(() => false);
}

async function resolveSource(explicit?: string): Promise<{ kind: "binary" | "shim"; path?: string }> {
	if (explicit) {
		if (!(await exists(explicit))) throw new Error(`--from path does not exist: ${explicit}`);
		return { kind: "binary", path: explicit };
	}

	const built = path.join(HERE, "..", "coding-agent", "dist", "omp");
	if (await exists(built)) return { kind: "binary", path: built };

	return { kind: "shim" };
}

async function installedOmp(): Promise<string> {
	const which = await $`which omp`.text().catch(() => "");
	const resolved = which.trim();
	if (!resolved) {
		throw new Error(
			"No compiled omp found and no `omp` on PATH.\n" +
				"Install it (bun install -g @oh-my-pi/pi-coding-agent) or pass --from <path>.",
		);
	}
	return resolved;
}

const explicit = process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from") + 1] : undefined;

const triple = await targetTriple();
const suffix = process.platform === "win32" ? ".exe" : "";
const dest = path.join(BIN_DIR, `omp-${triple}${suffix}`);

await fs.mkdir(BIN_DIR, { recursive: true });

const source = await resolveSource(explicit);

if (source.kind === "binary") {
	await fs.copyFile(source.path!, dest);
	await fs.chmod(dest, 0o755);
	const { size } = await fs.stat(dest);
	console.log(`✓ copied ${source.path} → ${path.relative(HERE, dest)} (${(size / 1e6).toFixed(1)} MB)`);
} else {
	const target = await installedOmp();
	// A shebang script is a perfectly good sidecar: Tauri only needs something
	// the OS can execute. `exec` keeps the pid stable so kill() still works.
	await Bun.write(dest, `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`);
	await fs.chmod(dest, 0o755);
	console.log(`✓ dev shim → ${path.relative(HERE, dest)}  (execs ${target})`);
	console.log("  This is a development stand-in. Ship a compiled binary: --from <path>");
}
