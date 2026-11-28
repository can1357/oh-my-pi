import * as path from "node:path";
import { detectHostMusl } from "./host-detect";
import pins from "./linked-natives/kits.json" with { type: "json" };

/** A shipping CLI and the Bun compile target of its linked runtime. */
export interface LinkedRuntimeTarget {
	readonly id: string;
	readonly platform: "darwin" | "linux" | "win32";
	readonly arch: "arm64" | "x64";
	readonly target: Bun.Build.CompileTarget;
}

/** Release target IDs are stable artifact names; Bun's target spelling is not the same on Windows. */
export const linkedRuntimeTargets: readonly LinkedRuntimeTarget[] = [
	{ id: "darwin-arm64", platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" },
	{ id: "darwin-x64", platform: "darwin", arch: "x64", target: "bun-darwin-x64" },
	{ id: "linux-arm64", platform: "linux", arch: "arm64", target: "bun-linux-arm64" },
	{ id: "linux-x64", platform: "linux", arch: "x64", target: "bun-linux-x64-baseline" },
	{ id: "linux-musl-arm64", platform: "linux", arch: "arm64", target: "bun-linux-arm64-musl" },
	{ id: "linux-musl-x64", platform: "linux", arch: "x64", target: "bun-linux-x64-baseline-musl" },
	{ id: "win32-arm64", platform: "win32", arch: "arm64", target: "bun-windows-arm64" },
	{ id: "win32-x64", platform: "win32", arch: "x64", target: "bun-windows-x64-baseline" },
];

/** Select a supported runtime, accepting the Windows spelling used by local CROSS_TARGET builds. */
export function resolveLinkedRuntimeTarget(id: string): LinkedRuntimeTarget {
	const canonical = id.replace(/^windows-/, "win32-");
	const target = linkedRuntimeTargets.find(target => target.id === canonical);
	if (!target) throw new Error(`Unsupported standalone runtime target: ${id}`);
	return target;
}

/** Match the running Bun's libc, not the presence of Alpine or glibc files in its filesystem. */
export function hostLinkedRuntimeTarget(): LinkedRuntimeTarget {
	return resolveLinkedRuntimeTarget(`${process.platform}${detectHostMusl() ? "-musl" : ""}-${process.arch}`);
}

/**
 * Link this checkout's pi-natives into the pinned Bun kit (`scripts/linked-natives/build.py`) and
 * return the runtime template for `compile.executablePath`. Its bytecode must match this Bun.
 */
export async function buildLinkedRuntime(id: string): Promise<string> {
	if (Bun.version !== pins.bunVersion || Bun.revision !== pins.bunRevision) {
		throw new Error(`Standalone builds require Bun ${pins.bunVersion} (${pins.bunRevision}) for matching bytecode`);
	}
	const python = process.platform === "win32" ? "python" : "python3";
	const child = Bun.spawn([python, path.join(import.meta.dir, "linked-natives", "build.py"), id], {
		stdout: "pipe",
		stderr: "inherit",
	});
	const [executable, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`Linking the ${id} runtime failed with exit code ${exitCode}`);
	return executable.trim();
}
