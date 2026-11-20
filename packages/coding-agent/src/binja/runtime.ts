import * as path from "node:path";
import { $env, logger } from "@oh-my-pi/pi-utils";
import { DisasmUnavailableError, type WorkerRuntime } from "../disasm/backend";
import { findWorkerRuntime, memoizeWorkerRuntime } from "../disasm/python-runtime";
import type { ToolSession } from "../tools";
import { binjaPythonDir, cfgBinjaInstall } from "./install";
import { cfgBinjaPython } from "./settings";

/** Imports the API and initialises the core, which is where the licence is checked. */
export const BINJA_PROBE = "import binaryninja as b; b.BinaryView.new(b'\\x00')";

/** How long one interpreter gets to start the core; a licence server that never answers must not hang analysis. */
export const BINJA_PROBE_TIMEOUT_MS = 30_000;

/** What the core reports when it starts without a usable licence. */
const LICENSE_REFUSAL = "License is not valid";

/** `license`: the core refused its licence. `unusable`: any other failure, a probe that ran out of time included. */
export type BinjaProbeResult = "ok" | "license" | "unusable";

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
	const pythonDir = binjaPythonDir(installDir);
	return memoizeWorkerRuntime("binja", [python, installDir, session.cwd], () =>
		findWorkerRuntime(
			python,
			session.cwd,
			async candidate => {
				const runtime: WorkerRuntime = {
					pythonPath: candidate.pythonPath,
					env: buildBinjaEnv(candidate.env, pythonDir),
				};
				const result = await probeBinjaRuntime(runtime);
				if (result === "license") {
					// The licence belongs to the install and user folder, not the interpreter: no other candidate can pass.
					throw new DisasmUnavailableError(
						`Binary Ninja unavailable: the install at ${installDir} refused its license (${runtime.pythonPath}). Headless use needs a license that permits it, in license.dat in the Binary Ninja user folder ($BN_USER_DIRECTORY when set).`,
					);
				}
				return result === "ok" ? runtime : undefined;
			},
			tried =>
				new DisasmUnavailableError(
					`Binary Ninja unavailable: no Python interpreter can import binaryninja from ${pythonDir} (tried: ${tried}). Set binja.python to a Python 3 interpreter supported by this Binary Ninja release.`,
				),
		),
	);
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

/** Whether the interpreter and environment of `runtime` start Binary Ninja headless. */
export async function probeBinjaRuntime(
	runtime: WorkerRuntime,
	timeoutMs = BINJA_PROBE_TIMEOUT_MS,
): Promise<BinjaProbeResult> {
	try {
		const probe = Bun.spawn([runtime.pythonPath, "-c", BINJA_PROBE], {
			env: runtime.env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		const [exitCode, stderr] = await Promise.all([
			probe.exited,
			new Response(probe.stderr as ReadableStream<Uint8Array>).text(),
		]);
		if (exitCode === 0) return "ok";
		logger.debug("Binary Ninja python probe rejected", { pythonPath: runtime.pythonPath, exitCode, stderr });
		return stderr.includes(LICENSE_REFUSAL) ? "license" : "unusable";
	} catch (error) {
		logger.debug("Binary Ninja python probe failed", { pythonPath: runtime.pythonPath, error });
		return "unusable";
	}
}
