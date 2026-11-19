import * as path from "node:path";
import { $env, logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { Settings } from "../config/settings";
import { DisasmUnavailableError, type WorkerRuntime } from "../disasm/backend";
import {
	enumeratePythonRuntimes,
	filterEnv,
	type PythonRuntime,
	resolveExplicitPythonRuntime,
} from "../eval/py/runtime";
import type { ToolSession } from "../tools";
import { binjaPythonDir, cfgBinjaInstall } from "./install";
import { cfgBinjaPython } from "./settings";

/** Imports the API and initialises the core, which is where the licence is checked. */
const PROBE = "import binaryninja as b; b.BinaryView.new(b'\\x00')";

/** What the core reports when it starts without a usable licence. */
const LICENSE_REFUSAL = "License is not valid";

type ProbeResult = "ok" | "license" | "unusable";

const runtimes = new Map<string, Promise<WorkerRuntime>>();

/**
 * Resolve the Python interpreter and environment that run the Binary Ninja worker, memoized per
 * (`binja.python`, install dir, cwd). Throws {@link DisasmUnavailableError} when no install is
 * found, no interpreter can import `binaryninja`, or the licence is refused.
 */
export function resolveBinjaRuntime(session: ToolSession): Promise<WorkerRuntime> {
	const installDir = cfgBinjaInstall.get(session.settings);
	if (!installDir) {
		return Promise.reject(
			new DisasmUnavailableError(
				"Binary Ninja unavailable: no install with the core library found (binja.installDir, $BN_INSTALL_DIR, lastrun, default install locations).",
			),
		);
	}
	const python = cfgBinjaPython.get(session.settings)?.trim() || undefined;
	const key = `${python ?? ""}\0${installDir}\0${session.cwd}`;
	const cached = runtimes.get(key);
	if (cached) return cached;
	const promise = probeBinjaRuntime(python, installDir, session.cwd);
	runtimes.set(key, promise);
	promise.catch(() => {
		if (runtimes.get(key) === promise) runtimes.delete(key);
	});
	return promise;
}

/**
 * Worker environment for an interpreter whose own environment is `candidateEnv`.
 *
 * `BN_LICENSE` holds the full licence text and this environment is persisted in daemon state,
 * so it is never carried over, whichever environment it shows up in; the worker takes its
 * licence from `license.dat` in the user folder. `BN_USER_DIRECTORY` relocates that folder and
 * is copied from `parentEnv`.
 */
export function buildBinjaEnv(
	candidateEnv: Record<string, string | undefined>,
	pythonDir: string,
	parentEnv: Record<string, string | undefined> = $env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key in candidateEnv) {
		const value = candidateEnv[key];
		if (typeof value === "string" && key.toUpperCase() !== "BN_LICENSE") env[key] = value;
	}
	env.PYTHONUNBUFFERED = "1";
	env.PYTHONIOENCODING = "utf-8";
	env.PYTHONPATH = env.PYTHONPATH ? `${pythonDir}${path.delimiter}${env.PYTHONPATH}` : pythonDir;
	env.BN_DISABLE_USER_PLUGINS = "1";
	env.BN_DISABLE_REPOSITORY_PLUGINS = "1";
	const userDir = parentEnv.BN_USER_DIRECTORY;
	if (userDir) env.BN_USER_DIRECTORY = userDir;
	return env;
}

async function probeBinjaRuntime(python: string | undefined, installDir: string, cwd: string): Promise<WorkerRuntime> {
	const baseEnv = filterEnv((await Settings.init()).getShellConfig().env);
	const candidates: PythonRuntime[] = python
		? [resolveExplicitPythonRuntime(python, cwd, baseEnv)]
		: enumeratePythonRuntimes(cwd, baseEnv);
	const pythonDir = binjaPythonDir(installDir);

	for (const candidate of candidates) {
		const runtime: WorkerRuntime = {
			pythonPath: candidate.pythonPath,
			env: buildBinjaEnv(candidate.env, pythonDir),
		};
		const result = await probeCandidate(runtime);
		if (result === "ok") return runtime;
		if (result === "license") {
			// The licence belongs to the install and user folder, not the interpreter: no other candidate can pass.
			throw new DisasmUnavailableError(
				`Binary Ninja unavailable: the install at ${installDir} refused its license (${runtime.pythonPath}). Headless use needs a license that permits it, in license.dat in the Binary Ninja user folder ($BN_USER_DIRECTORY when set).`,
			);
		}
	}

	const paths = candidates.length > 0 ? candidates.map(c => c.pythonPath).join(", ") : "none";
	throw new DisasmUnavailableError(
		`Binary Ninja unavailable: no Python interpreter can import binaryninja from ${pythonDir} (tried: ${paths}). Set binja.python to a Python 3 interpreter supported by this Binary Ninja release.`,
	);
}

async function probeCandidate(runtime: WorkerRuntime): Promise<ProbeResult> {
	try {
		const result = await $`${runtime.pythonPath} -c ${PROBE}`.env(runtime.env).quiet().nothrow();
		if (result.exitCode === 0) return "ok";
		const stderr = result.stderr.toString();
		logger.debug("Binary Ninja python probe rejected", { pythonPath: runtime.pythonPath, stderr });
		return stderr.includes(LICENSE_REFUSAL) ? "license" : "unusable";
	} catch (error) {
		logger.debug("Binary Ninja python probe failed", { pythonPath: runtime.pythonPath, error });
		return "unusable";
	}
}
