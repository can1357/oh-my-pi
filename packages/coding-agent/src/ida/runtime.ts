import { $env, logger } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { $ } from "bun";
import { Settings } from "../config/settings";
import { awaitBoundedProbe, probeBound } from "../eval/probe";
import {
	enumeratePythonRuntimes,
	filterEnv,
	type PythonRuntime,
	pythonReadRoots,
	resolveExplicitPythonRuntime,
} from "../eval/py/runtime";
import { containingSandbox } from "../sandbox/file-access";
import { containedEnv } from "../sandbox/env";
import type { SandboxRuntime } from "../sandbox/runtime";
import type { ToolSession } from "../tools";
import { cfgIdaInstall } from "./install";
import { cfgIdaPython } from "./settings";

/** Raised when no Python interpreter can load idalib (`ida_domain` + `idapro`). */
export class IdaUnavailableError extends ToolError {
	constructor(message: string) {
		super(message);
		this.name = "IdaUnavailableError";
	}
}

/** Interpreter and environment used to spawn IDA worker processes. */
export interface IdaRuntime {
	pythonPath: string;
	env: Record<string, string>;
}

const PROBE =
	"import importlib.util as u,sys;sys.exit(0 if u.find_spec('ida_domain') and u.find_spec('idapro') else 3)";

const runtimes = new Map<string, Promise<IdaRuntime>>();

/**
 * Resolve the Python interpreter that can import `ida_domain` and `idapro`, memoized per
 * (`ida.python`, install dir, cwd, contained). While the OS sandbox is active the candidates are
 * probed inside it, so a workspace-controlled interpreter never runs on the host. Throws
 * {@link IdaUnavailableError} when IDA is disabled, no install is found, or no interpreter qualifies.
 */
export async function resolveIdaRuntime(session: ToolSession): Promise<IdaRuntime> {
	const installDir = cfgIdaInstall.get(session.settings);
	if (!installDir) {
		throw new IdaUnavailableError("IDA unavailable: disabled (ida.enabled) or no IDA install with idalib found.");
	}
	const python = cfgIdaPython.get(session.settings)?.trim() || undefined;
	const sandbox = await containingSandbox(session.cwd);
	const key = `${python ?? ""}\0${installDir}\0${session.cwd}\0${sandbox ? "contained" : ""}`;
	const cached = runtimes.get(key);
	if (cached) return cached;
	const promise = probeIdaRuntime(python, installDir, session.cwd, sandbox);
	runtimes.set(key, promise);
	promise.catch(() => {
		if (runtimes.get(key) === promise) runtimes.delete(key);
	});
	return promise;
}

async function probeIdaRuntime(
	python: string | undefined,
	installDir: string,
	cwd: string,
	sandbox: SandboxRuntime | undefined,
): Promise<IdaRuntime> {
	const baseEnv = filterEnv((await Settings.init()).getShellConfig().env);
	const candidates: PythonRuntime[] = python
		? [resolveExplicitPythonRuntime(python, cwd, baseEnv)]
		: enumeratePythonRuntimes(cwd, baseEnv);

	for (const candidate of candidates) {
		if (await probeCandidate(candidate, cwd, sandbox)) return buildRuntime(candidate, installDir);
	}

	const paths = candidates.length > 0 ? candidates.map(c => c.pythonPath).join(", ") : "none";
	throw new IdaUnavailableError(
		`IDA unavailable: no Python interpreter can import ida_domain and idapro (tried: ${paths}). Install ida-domain into the Python targeted by IDA's idapyswitch, or set ida.python.`,
	);
}

async function probeCandidate(
	candidate: PythonRuntime,
	cwd: string,
	sandbox: SandboxRuntime | undefined,
): Promise<boolean> {
	try {
		if (sandbox) return await probeContained(candidate, cwd, sandbox);
		const result = await $`${candidate.pythonPath} -c ${PROBE}`.env(candidate.env).quiet().nothrow();
		return result.exitCode === 0;
	} catch (error) {
		logger.debug("IDA python probe failed", { pythonPath: candidate.pythonPath, error });
		return false;
	}
}

/** The probe inside the container: no network, bounded, interpreter roots readable. */
async function probeContained(candidate: PythonRuntime, cwd: string, sandbox: SandboxRuntime): Promise<boolean> {
	const env = containedEnv(candidate.env);
	const child = await sandbox.spawn({
		argv: [candidate.pythonPath, "-c", PROBE],
		cwd,
		env,
		extraRead: await pythonReadRoots(candidate),
		network: "deny",
	});
	child.stdin.end();
	void new Response(child.stdout).arrayBuffer().catch(() => undefined);
	void new Response(child.stderr).arrayBuffer().catch(() => undefined);
	const result = await awaitBoundedProbe(child.exited, () => child.kill(), probeBound(undefined));
	return result.exitCode === 0;
}

function buildRuntime(candidate: PythonRuntime, installDir: string): IdaRuntime {
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
