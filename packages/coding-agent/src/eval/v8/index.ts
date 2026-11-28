import { resolveV8EvalBinary } from "@oh-my-pi/pi-natives";
import type { ToolSession } from "../../tools";
import type {
	BackendAvailability,
	ExecutorBackend,
	ExecutorBackendExecOptions,
	ExecutorBackendResult,
} from "../backend";
import type { BackendProbeOptions } from "../probe";
import { namespaceSessionId as sharedNamespace, toExecutorBackendResult } from "../backend-helpers";
import { defaultEvalSessionId } from "../session-id";
import { executeV8 } from "./executor";

const V8_SESSION_PREFIX = "v8:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, V8_SESSION_PREFIX);
}

/** Resolve the retained V8 isolate kernel identity owned by a tool session. */
export function resolveV8KernelIdentity(session: ToolSession): {
	sessionKey: string;
	ownerId: string | undefined;
} {
	return {
		sessionKey: namespaceSessionId(session.getEvalSessionId?.() ?? defaultEvalSessionId(session)),
		ownerId: session.getEvalKernelOwnerId?.() ?? undefined,
	};
}

export default {
	id: "v8",
	label: "V8 Sandbox",
	highlightLang: "javascript",

	async checkAvailability(_session: ToolSession, _opts?: BackendProbeOptions): Promise<BackendAvailability> {
		if (resolveV8EvalBinary() !== null) return { ok: true };
		return {
			ok: false,
			reason:
				"Sandboxed V8 eval binary (omp_v8_eval) is unavailable on this platform. Build it with `bun run build:v8` or reinstall @oh-my-pi/pi-natives.",
		};
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const identity = resolveV8KernelIdentity(opts.session);
		const result = await executeV8(code, {
			cwd: opts.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: identity.sessionKey,
			kernelOwnerId: identity.ownerId,
			filename: opts.filename,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStatus: opts.onStatus,
			onReply: opts.onReply,
			parentToolCallId: opts.parentToolCallId,
			session: opts.session,
		});
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
