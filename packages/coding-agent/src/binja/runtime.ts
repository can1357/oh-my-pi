import * as os from "node:os";
import * as path from "node:path";
import { $env, filterChildShellEnv, logger, settleWithin } from "@oh-my-pi/pi-utils";
import { DisasmUnavailableError, type WorkerRuntime } from "../disasm/backend";
import { installReadRoots, OUTPUT_DRAIN_MS } from "../disasm/contained";
import { findWorkerRuntime, memoizeWorkerRuntime } from "../disasm/python-runtime";
import { awaitBoundedProbe } from "../eval/probe";
import { drainBounded, pythonReadRoots } from "../eval/py/runtime";
import { containedEnv } from "../sandbox/env";
import { containingSandbox } from "../sandbox/file-access";
import type { SandboxRuntime } from "../sandbox/runtime";
import type { ToolSession } from "../tools";
import { binjaPythonDir, binjaUserDir, cfgBinjaInstall } from "./install";
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
export async function resolveBinjaRuntime(session: ToolSession): Promise<WorkerRuntime> {
	const installDir = cfgBinjaInstall.get(session.settings);
	if (!installDir) {
		throw new DisasmUnavailableError(
			"Binary Ninja unavailable: no install with the core library found (binja.installDir, $BN_INSTALL_DIR, lastrun, default install locations).",
		);
	}
	const python = cfgBinjaPython.get(session.settings)?.trim() || undefined;
	const pythonDir = binjaPythonDir(installDir);
	// Launch environment only: the project `.env` must not choose a folder the contained worker may read.
	const launchEnv = filterChildShellEnv($env, session.cwd);
	// Always named, so the contained worker can read the licence in the default folder too.
	const userDir = binjaUserDir({ platform: process.platform, env: launchEnv, home: os.homedir() });
	const sandbox = await containingSandbox(session.cwd);
	const containment = sandbox ? { sandbox, cwd: session.cwd } : undefined;
	return memoizeWorkerRuntime("binja", [python, installDir, session.cwd, sandbox ? "contained" : ""], () =>
		findWorkerRuntime(
			python,
			session.cwd,
			async candidate => {
				const runtime: WorkerRuntime = {
					pythonPath: candidate.pythonPath,
					// BN_INSTALL_DIR and BN_USER_DIRECTORY name what the contained worker may read (`installReadRoots`).
					env: {
						...buildBinjaEnv(candidate.env, pythonDir, launchEnv),
						BN_INSTALL_DIR: installDir,
						BN_USER_DIRECTORY: userDir,
					},
				};
				const result = await probeBinjaRuntime(runtime, BINJA_PROBE_TIMEOUT_MS, containment);
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
 * is copied from `parentEnv`, by default the launch environment without the project's `.env` values.
 */
export function buildBinjaEnv(
	candidateEnv: Record<string, string | undefined>,
	pythonDir: string,
	parentEnv: Record<string, string | undefined> = filterChildShellEnv($env),
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

/** Where `probeBinjaRuntime` runs when the OS sandbox is active: inside `sandbox`, in `cwd`, never on the host. */
export interface BinjaProbeContainment {
	sandbox: SandboxRuntime;
	cwd: string;
}

interface ProbeOutcome {
	/** `null`: killed by the timeout. */
	exitCode: number | null;
	stderr: string;
}

async function probeOnHost(runtime: WorkerRuntime, timeoutMs: number): Promise<ProbeOutcome> {
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
	return { exitCode, stderr };
}

/**
 * The probe inside the container: no network, the interpreter's roots and Binary Ninja's install and
 * user folder readable, the same grants the contained worker gets. At most 64 KiB of each pipe is
 * kept; stderr is decoded so a licence refusal stays detectable, waiting at most
 * {@link OUTPUT_DRAIN_MS} after the exit for a pipe a surviving grandchild may hold open.
 */
async function probeContained(
	{ sandbox, cwd }: BinjaProbeContainment,
	runtime: WorkerRuntime,
	timeoutMs: number,
): Promise<ProbeOutcome> {
	const extraRead = await pythonReadRoots(
		{ ...runtime, venvPath: runtime.env.VIRTUAL_ENV },
		undefined,
		sandbox.workspace,
	);
	extraRead.push(...(await installReadRoots(runtime.env)));
	const child = await sandbox.spawn({
		argv: [runtime.pythonPath, "-c", BINJA_PROBE],
		cwd,
		env: containedEnv(runtime.env),
		extraRead,
		network: "deny",
	});
	child.stdin.end();
	drainBounded(child.stdout);
	const stderr = drainBounded(child.stderr);
	const { exitCode } = await awaitBoundedProbe(child.exited, () => child.kill(), timeoutMs);
	// A killed probe's pipe may stay open until the tree is reaped; its output no longer matters.
	if (exitCode === null) return { exitCode, stderr: "" };
	await settleWithin(stderr.done, OUTPUT_DRAIN_MS);
	return { exitCode, stderr: new TextDecoder().decode(stderr.bytes()) };
}

/**
 * Whether the interpreter and environment of `runtime` start Binary Ninja headless. With
 * `containment` the probe runs in the OS sandbox, so a workspace-controlled interpreter never
 * executes on the host.
 */
export async function probeBinjaRuntime(
	runtime: WorkerRuntime,
	timeoutMs = BINJA_PROBE_TIMEOUT_MS,
	containment?: BinjaProbeContainment,
): Promise<BinjaProbeResult> {
	try {
		const { exitCode, stderr } = containment
			? await probeContained(containment, runtime, timeoutMs)
			: await probeOnHost(runtime, timeoutMs);
		if (exitCode === 0) return "ok";
		logger.debug("Binary Ninja python probe rejected", { pythonPath: runtime.pythonPath, exitCode, stderr });
		return stderr.includes(LICENSE_REFUSAL) ? "license" : "unusable";
	} catch (error) {
		logger.debug("Binary Ninja python probe failed", { pythonPath: runtime.pythonPath, error });
		return "unusable";
	}
}
