import { resolveV8EvalBinary } from "@oh-my-pi/pi-natives";
import type { ToolSession } from ".";

import { getCachedPythonKernelAvailability } from "../eval/py/kernel";
import { cfgEvalJs, cfgEvalPy, cfgEvalV8, cfgPythonInterpreter } from "../eval/settings";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
	v8: boolean;
}

/** Active eval backend allowance (`eval.py` / `eval.js` / `eval.v8`; `PI_PY` / `PI_JS` / `PI_V8` override). */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	return {
		python: cfgEvalPy.get(session.settings),
		js: cfgEvalJs.get(session.settings),
		v8: cfgEvalV8.get(session.settings),
	};
}

/** Advertise settings-allowed runtimes unless a definitive probe/binary check found one unavailable. */
export function resolveAdvertisedEvalBackends(session: ToolSession): EvalBackendsAllowance {
	const allowed = resolveEvalBackends(session);
	const v8 = allowed.v8 && resolveV8EvalBinary() !== null;
	if (!allowed.python) return { python: false, js: allowed.js, v8 };
	const availability = getCachedPythonKernelAvailability(
		session.cwd,
		cfgPythonInterpreter.get(session.settings)?.trim() || undefined,
	);
	return { python: availability?.ok !== false, js: allowed.js, v8 };
}
