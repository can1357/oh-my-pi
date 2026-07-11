import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import { namespaceSessionId as sharedNamespace, toExecutorBackendResult } from "../backend-helpers";
import { executeJs } from "./executor";

const JS_SESSION_PREFIX = "js:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, JS_SESSION_PREFIX);
}
export default {
	id: "js",
	label: "JavaScript",
	highlightLang: "javascript",

	async isAvailable(_session: ToolSession): Promise<boolean> {
		return true;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const result = await executeJs(code, {
			cwd: opts.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: namespaceSessionId(opts.sessionId),
			sessionFile: opts.sessionFile,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStatus: opts.onStatus,
			session: opts.session,
			localRoots: resolveEvalUrlRoots(opts.session),
		});
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
