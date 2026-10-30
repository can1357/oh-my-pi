import * as os from "node:os";
import * as path from "node:path";

/** Resolve the cache explicitly for isolated runs instead of relying on platform-specific home variables. */
export function resolveCacheRoot(root?: string): string {
	if (root === "") throw new Error("--cache-root must not be empty");
	return root === undefined ? path.join(os.homedir(), ".cache", "omp-memory-eval") : path.resolve(root);
}

/** `uv venv` uses Scripts/python.exe on native Windows, bin/python on POSIX. */
export function enginePython(cacheRoot: string): string {
	return process.platform === "win32"
		? path.join(cacheRoot, "venv-engine", "Scripts", "python.exe")
		: path.join(cacheRoot, "venv-engine", "bin", "python");
}
