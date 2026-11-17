import { Settings } from "../config/settings";
import { DisasmUnavailableError, type WorkerRuntime } from "../disasm/backend";
import { filterEnv, resolveExplicitPythonRuntime } from "../eval/py/runtime";
import type { ToolSession } from "../tools";
import { ensureR2PipeVenv, resolveRadare2Binary } from "./install";
import { cfgRadare2Python, cfgRadare2R2Path } from "./settings";

const runtimes = new Map<string, Promise<WorkerRuntime>>();

/** Resolve the r2pipe interpreter and environment, memoized per interpreter/binary/cwd. */
export function resolveRadare2Runtime(session: ToolSession): Promise<WorkerRuntime> {
	const python = cfgRadare2Python.get(session.settings)?.trim() || undefined;
	const configured = cfgRadare2R2Path.get(session.settings)?.trim() || undefined;
	const key = `${python ?? ""}\0${configured ?? ""}\0${session.cwd}`;
	const cached = runtimes.get(key);
	if (cached) return cached;
	const promise = resolveRuntime(python, configured, session.cwd);
	runtimes.set(key, promise);
	promise.catch(() => {
		if (runtimes.get(key) === promise) runtimes.delete(key);
	});
	return promise;
}

async function resolveRuntime(
	python: string | undefined,
	configured: string | undefined,
	cwd: string,
): Promise<WorkerRuntime> {
	try {
		const binary = resolveRadare2Binary(configured);
		if (!binary) {
			throw new DisasmUnavailableError("radare2 unavailable: no radare2 binary on PATH (set radare2.r2Path).");
		}
		const interpreter = python ?? (await ensureR2PipeVenv());
		const baseEnv = filterEnv((await Settings.init()).getShellConfig().env);
		const candidate = resolveExplicitPythonRuntime(interpreter, cwd, baseEnv);
		const env: Record<string, string> = {};
		for (const key in candidate.env) {
			const value = candidate.env[key];
			if (typeof value === "string") env[key] = value;
		}
		env.PYTHONUNBUFFERED = "1";
		env.PYTHONIOENCODING = "utf-8";
		env.RADARE2_BIN = binary;
		return { pythonPath: candidate.pythonPath, env };
	} catch (error) {
		if (error instanceof DisasmUnavailableError) throw error;
		throw new DisasmUnavailableError(
			`radare2 unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
