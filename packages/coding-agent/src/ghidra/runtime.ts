import * as path from "node:path";
import { Settings } from "../config/settings";
import { DisasmUnavailableError, type WorkerRuntime } from "../disasm/backend";
import { memoizeWorkerRuntime } from "../disasm/python-runtime";
import { filterEnv, probeInterpreter, resolveExplicitPythonRuntime } from "../eval/py/runtime";
import { containingSandbox } from "../sandbox/file-access";
import type { SandboxRuntime } from "../sandbox/runtime";
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

let installation: PendingInstallation | undefined;

/**
 * Resolve the Ghidra worker interpreter and environment, memoized per Python/install setting, cwd and
 * containment. While the OS sandbox is active an explicit `ghidra.python` is probed inside it, so a
 * workspace-controlled interpreter never runs on the host.
 * First-use installation is shared and uncancellable; failed resolutions are evicted for a later retry.
 * Explicit install and interpreter settings are authoritative and never fall back to managed alternatives.
 */
export async function resolveGhidraRuntime(session: ToolSession): Promise<WorkerRuntime> {
	const python = cfgGhidraPython.get(session.settings)?.trim() || undefined;
	const configured = cfgGhidraInstallDir.get(session.settings)?.trim() || undefined;
	const sandbox = await containingSandbox(session.cwd);
	return memoizeWorkerRuntime("ghidra", [python, configured, session.cwd, sandbox ? "contained" : ""], () =>
		resolveRuntime(python, configured, session.cwd, sandbox),
	);
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
	sandbox: SandboxRuntime | undefined,
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
				if (!(await probeInterpreter(sandbox, cwd, candidate, "import pyghidra", env, cwd)))
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
