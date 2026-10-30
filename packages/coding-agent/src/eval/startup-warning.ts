import { sanitizeDisplayWarnings } from "@oh-my-pi/pi-tui/render/render-utils";
import type { Args } from "../cli/args";
import type { Settings } from "../config/settings";
import { checkPythonKernelAvailability } from "./py/kernel";
import { cfgEvalJs, cfgEvalPy, cfgPythonInterpreter } from "./settings";

const PYTHON_FIX_HINT = "Install Python 3.8+ or set python.interpreter, then verify with `omp setup python --check`.";

/**
 * Warning for an enabled Python eval backend with no working interpreter.
 * Disabled backends (`eval.py` / `eval.js`, `PI_PY` / `PI_JS`) are intentional and never reported,
 * and neither is a probe cancelled through `signal`.
 */
export async function resolvePythonEvalWarning({
	cwd,
	settings,
	signal,
}: {
	cwd: string;
	settings: Settings;
	signal?: AbortSignal;
}): Promise<string | undefined> {
	if (!cfgEvalPy.get(settings)) return undefined;
	const interpreter = cfgPythonInterpreter.get(settings)?.trim() || undefined;
	const availability = await checkPythonKernelAvailability(cwd, interpreter, { signal });
	if (availability.ok || signal?.aborted) return undefined;
	// The reason embeds interpreter paths and spawn errors: shorten home, strip controls, bound length.
	const [reason] = sanitizeDisplayWarnings([availability.reason ?? "no working Python interpreter"]);
	return cfgEvalJs.get(settings)
		? `Python eval unavailable (${reason}); eval will run JavaScript only. ${PYTHON_FIX_HINT}`
		: `Eval tool unavailable: ${reason}, and JavaScript eval is disabled. ${PYTHON_FIX_HINT}`;
}

/**
 * {@link resolvePythonEvalWarning}, gated to a fresh install's first launch.
 *
 * `lastChangelogVersion` is the marker as read before this launch's changelog step. That step
 * writes it, except for `--continue`, `--resume`, and foreign session imports; those launches are
 * skipped so they cannot repeat the warning on every resumed start.
 */
export async function resolveFirstLaunchPythonEvalWarning({
	args,
	lastChangelogVersion,
	cwd,
	settings,
	signal,
}: {
	args: Pick<Args, "continue" | "resume" | "fromClaude" | "fromCodex" | "tools" | "noTools">;
	lastChangelogVersion: string | undefined;
	cwd: string;
	settings: Settings;
	signal?: AbortSignal;
}): Promise<string | undefined> {
	if (lastChangelogVersion !== undefined) return undefined;
	if (args.continue || args.resume || args.fromClaude || args.fromCodex) return undefined;
	// An explicit --tools list wins over --no-tools, matching session tool selection.
	const evalExposed = args.tools ? args.tools.includes("eval") : !args.noTools;
	if (!evalExposed) return undefined;
	return resolvePythonEvalWarning({ cwd, settings, signal });
}
