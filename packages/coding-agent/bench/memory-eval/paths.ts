import * as os from "node:os";
import * as path from "node:path";
import { venvPython } from "../../src/eval/py/runtime";

/** Resolve the cache explicitly for isolated runs instead of relying on platform-specific home variables. */
export function resolveCacheRoot(root?: string): string {
	if (root === "") throw new Error("--cache-root must not be empty");
	return root === undefined ? path.join(os.homedir(), ".cache", "omp-memory-eval") : path.resolve(root);
}

/** Interpreter of the engine virtualenv under the cache root. */
export function enginePython(cacheRoot: string): string {
	return venvPython(path.join(cacheRoot, "venv-engine"));
}
