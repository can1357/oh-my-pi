import { $env, logger } from "@oh-my-pi/pi-utils";
import { DisasmUnavailableError, type WorkerRuntime } from "../disasm/backend";
import { findWorkerRuntime, memoizeWorkerRuntime } from "../disasm/python-runtime";
import { type PythonRuntime, probeInterpreter } from "../eval/py/runtime";
import { containingSandbox } from "../sandbox/file-access";
import type { SandboxRuntime } from "../sandbox/runtime";
import type { ToolSession } from "../tools";
import { cfgIdaInstall } from "./install";
import { cfgIdaPython } from "./settings";

const PROBE =
	"import importlib.util as u,sys;sys.exit(0 if u.find_spec('ida_domain') and u.find_spec('idapro') else 3)";

/**
 * Resolve the Python interpreter that can import `ida_domain` and `idapro`, memoized per
 * (`ida.python`, install dir, cwd, contained). While the OS sandbox is active the candidates are
 * probed inside it, so a workspace-controlled interpreter never runs on the host. Throws
 * {@link DisasmUnavailableError} when no install is found or no interpreter qualifies.
 */
export async function resolveIdaRuntime(session: ToolSession): Promise<WorkerRuntime> {
	const installDir = cfgIdaInstall.get(session.settings);
	if (!installDir) {
		throw new DisasmUnavailableError(
			"IDA unavailable: no IDA install with idalib found (ida.installDir, $IDADIR, ida-config.json, standard paths).",
		);
	}
	const python = cfgIdaPython.get(session.settings)?.trim() || undefined;
	const sandbox = await containingSandbox(session.cwd);
	return memoizeWorkerRuntime("ida", [python, installDir, session.cwd, sandbox ? "contained" : ""], () =>
		findWorkerRuntime(
			python,
			session.cwd,
			async candidate =>
				(await probeCandidate(candidate, session.cwd, sandbox)) ? buildRuntime(candidate, installDir) : undefined,
			tried =>
				new DisasmUnavailableError(
					`IDA unavailable: no Python interpreter can import ida_domain and idapro (tried: ${tried}). Install ida-domain into the Python targeted by IDA's idapyswitch, or set ida.python.`,
				),
		),
	);
}

async function probeCandidate(
	candidate: PythonRuntime,
	cwd: string,
	sandbox: SandboxRuntime | undefined,
): Promise<boolean> {
	try {
		return await probeInterpreter(sandbox, cwd, candidate, PROBE, candidate.env);
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
