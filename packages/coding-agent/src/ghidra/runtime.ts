import * as path from "node:path";
import { $ } from "bun";
import { Settings } from "../config/settings";
import { DisasmUnavailableError, type WorkerRuntime } from "../disasm/backend";
import { filterEnv, resolveExplicitPythonRuntime } from "../eval/py/runtime";
import type { ToolSession } from "../tools";
import { ensureGhidraInstall, ensureJdk, ensurePyGhidraVenv } from "./install";
import { cfgGhidraInstallDir, cfgGhidraPython } from "./settings";

interface GhidraInstallation {
	javaHome: string;
	installDir: string;
	pythonPath?: string;
}

interface PendingInstallation {
	key: string;
	promise: Promise<GhidraInstallation>;
}

const runtimes = new Map<string, Promise<WorkerRuntime>>();
let installation: PendingInstallation | undefined;

/**
 * Resolve the Ghidra worker interpreter and environment, memoized per Python/install setting and cwd.
 * First-use installation is shared and uncancellable; failed resolutions are evicted for a later retry.
 * Explicit install and interpreter settings are authoritative and never fall back to managed alternatives.
 */
export function resolveGhidraRuntime(session: ToolSession): Promise<WorkerRuntime> {
	const python = cfgGhidraPython.get(session.settings)?.trim() || undefined;
	const configured = cfgGhidraInstallDir.get(session.settings)?.trim() || undefined;
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

/** Share identical installation requests, but serialize different overrides without reusing their results. */
function resolveInstallation(configured: string | undefined, managedPython: boolean): Promise<GhidraInstallation> {
	const key = `${configured ?? ""}\0${managedPython}`;
	const pending = installation;
	if (pending) {
		if (pending.key === key) return pending.promise;
		// Another configuration's failure must not prevent this configuration from trying its own install.
		return pending.promise.catch(() => undefined).then(() => resolveInstallation(configured, managedPython));
	}
	const promise = provisionInstallation(configured, managedPython);
	installation = { key, promise };
	const clear = () => {
		if (installation?.promise === promise) installation = undefined;
	};
	promise.then(clear, clear);
	return promise;
}

async function provisionInstallation(
	configured: string | undefined,
	managedPython: boolean,
): Promise<GhidraInstallation> {
	const javaHome = await ensureJdk();
	const installDir = await ensureGhidraInstall(configured, javaHome);
	const pythonPath = managedPython ? await ensurePyGhidraVenv(installDir) : undefined;
	return { javaHome, installDir, pythonPath };
}

async function resolveRuntime(
	python: string | undefined,
	configured: string | undefined,
	cwd: string,
): Promise<WorkerRuntime> {
	try {
		const baseEnv = filterEnv((await Settings.init()).getShellConfig().env);
		const installed = await resolveInstallation(
			configured ? path.resolve(cwd, configured) : undefined,
			python === undefined,
		);
		const interpreter = python ?? installed.pythonPath;
		if (!interpreter) throw new DisasmUnavailableError("Ghidra unavailable: no PyGhidra interpreter was installed");
		const candidate = resolveExplicitPythonRuntime(interpreter, cwd, baseEnv);
		const env: Record<string, string> = {};
		for (const key in candidate.env) {
			const value = candidate.env[key];
			if (typeof value === "string") env[key] = value;
		}
		env.PYTHONUNBUFFERED = "1";
		env.PYTHONIOENCODING = "utf-8";
		env.GHIDRA_INSTALL_DIR = installed.installDir;
		env.JAVA_HOME = installed.javaHome;
		env.JAVA_HOME_OVERRIDE = installed.javaHome;
		if (python) {
			try {
				const result = await $`${candidate.pythonPath} -c ${"import pyghidra"}`.cwd(cwd).env(env).quiet().nothrow();
				if (result.exitCode !== 0)
					throw new DisasmUnavailableError(`ghidra.python cannot import pyghidra: ${candidate.pythonPath}`);
			} catch {
				throw new DisasmUnavailableError(`ghidra.python cannot import pyghidra: ${candidate.pythonPath}`);
			}
		}
		return { pythonPath: candidate.pythonPath, env };
	} catch (error) {
		if (error instanceof DisasmUnavailableError) throw error;
		throw new DisasmUnavailableError(`Ghidra unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
}
