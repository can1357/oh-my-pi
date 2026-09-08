import { $flag } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
}

/** Read per-backend allowance from settings (py/js default on). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
	};
}

/**
 * Materialize the active eval backend allowance: PI_PY / PI_JS
 * env flags override the per-key settings; otherwise settings win (py/js default on).
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	const settings = readEvalBackendsAllowance(session);
	return {
		python: $flag("PI_PY", settings.python),
		js: $flag("PI_JS", settings.js),
	};
}
