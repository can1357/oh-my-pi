import { $env, logger } from "@oh-my-pi/pi-utils";
import { DisasmUnavailableError, type WorkerRuntime } from "../disasm/backend";
import { $ } from "bun";
import { Settings } from "../config/settings";
import {
	enumeratePythonRuntimes,
	filterEnv,
	type PythonRuntime,
	resolveExplicitPythonRuntime,
} from "../eval/py/runtime";
import type { ToolSession } from "../tools";
import { cfgIdaInstall } from "./install";
import { cfgIdaPython } from "./settings";

const PROBE =
	"import importlib.util as u,sys;sys.exit(0 if u.find_spec('ida_domain') and u.find_spec('idapro') else 3)";

const runtimes = new Map<string, Promise<WorkerRuntime>>();

/**
 * Resolve the Python interpreter that can import `ida_domain` and `idapro`, memoized per
 * (`ida.python`, install dir, cwd). Throws {@link DisasmUnavailableError} when no install
 * is found or no interpreter qualifies.
 */
export function resolveIdaRuntime(session: ToolSession): Promise<WorkerRuntime> {
	const installDir = cfgIdaInstall.get(session.settings);
	if (!installDir) {
		return Promise.reject(
			new DisasmUnavailableError(
				"IDA unavailable: no IDA install with idalib found (ida.installDir, $IDADIR, ida-config.json, standard paths).",
			),
		);
	}
	const python = cfgIdaPython.get(session.settings)?.trim() || undefined;
	const key = `${python ?? ""}\0${installDir}\0${session.cwd}`;
	const cached = runtimes.get(key);
	if (cached) return cached;
	const promise = probeIdaRuntime(python, installDir, session.cwd);
	runtimes.set(key, promise);
	promise.catch(() => {
		if (runtimes.get(key) === promise) runtimes.delete(key);
	});
	return promise;
}

async function probeIdaRuntime(python: string | undefined, installDir: string, cwd: string): Promise<WorkerRuntime> {
	const baseEnv = filterEnv((await Settings.init()).getShellConfig().env);
	const candidates: PythonRuntime[] = python
		? [resolveExplicitPythonRuntime(python, cwd, baseEnv)]
		: enumeratePythonRuntimes(cwd, baseEnv);

	for (const candidate of candidates) {
		if (await probeCandidate(candidate)) return buildRuntime(candidate, installDir);
	}

	const paths = candidates.length > 0 ? candidates.map(c => c.pythonPath).join(", ") : "none";
	throw new DisasmUnavailableError(
		`IDA unavailable: no Python interpreter can import ida_domain and idapro (tried: ${paths}). Install ida-domain into the Python targeted by IDA's idapyswitch, or set ida.python.`,
	);
}

async function probeCandidate(candidate: PythonRuntime): Promise<boolean> {
	try {
		const result = await $`${candidate.pythonPath} -c ${PROBE}`.env(candidate.env).quiet().nothrow();
		return result.exitCode === 0;
	} catch (error) {
		logger.debug("IDA python probe failed", { pythonPath: candidate.pythonPath, error });
		return false;
	}
}

function buildRuntime(candidate: PythonRuntime, installDir: string): WorkerRuntime {
	const env: Record<string, string> = {};
	for (const key in candidate.env) {
		const value = candidate.env[key];
		if (typeof value === "string") env[key] = value;
	}
	env.PYTHONUNBUFFERED = "1";
	env.PYTHONIOENCODING = "utf-8";
	env.IDADIR = installDir;
	const idaUsr = $env.IDAUSR;
	if (idaUsr) env.IDAUSR = idaUsr;
	return { pythonPath: candidate.pythonPath, env };
}
