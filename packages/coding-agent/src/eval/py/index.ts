import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import { namespaceSessionId as sharedNamespace, toExecutorBackendResult } from "../backend-helpers";
import type { BackendProbeOptions } from "../probe";
import { defaultEvalSessionId } from "../session-id";
import { executePython, type PythonExecutorOptions } from "./executor";
import { checkPythonKernelAvailability } from "./kernel";
import { cfgPythonInterpreter, cfgPythonKernelMode } from "../settings";

const PYTHON_SESSION_PREFIX = "python:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, PYTHON_SESSION_PREFIX);
}

function readInterpreterSetting(session: ToolSession): string | undefined {
	return cfgPythonInterpreter.get(session)?.trim() || undefined;
}

/** Resolve the retained Python kernel identity owned by a tool session. */
export function resolvePythonKernelIdentity(session: ToolSession): {
	cwd: string;
	sessionId: string;
	interpreter: string | undefined;
	kernelOwnerId: string | undefined;
} {
	return {
		cwd: session.cwd,
		sessionId: namespaceSessionId(session.getEvalSessionId?.() ?? defaultEvalSessionId(session)),
		interpreter: readInterpreterSetting(session),
		kernelOwnerId: session.getEvalKernelOwnerId?.() ?? undefined,
	};
}

export default {
	id: "python",
	label: "Python",
	highlightLang: "python",

	async isAvailable(session: ToolSession, opts?: BackendProbeOptions): Promise<boolean> {
		const availability = await checkPythonKernelAvailability(session.cwd, readInterpreterSetting(session), opts);
		return availability.ok;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const kernelMode = cfgPythonKernelMode.get(opts.session);
		const identity = resolvePythonKernelIdentity(opts.session);
		const executorOptions: PythonExecutorOptions = {
			cwd: identity.cwd,
			filename: opts.filename,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: identity.sessionId,
			kernelMode,
			interpreter: identity.interpreter,
			sessionFile: opts.sessionFile,
			artifactsDir: opts.session.getArtifactsDir?.() ?? undefined,
			localRoots: resolveEvalUrlRoots(opts.session),
			kernelOwnerId: identity.kernelOwnerId,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStatus: opts.onStatus,
			toolSession: opts.session,
		};
		const result = await executePython(code, executorOptions);
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
