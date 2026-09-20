import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { EvalPreludeDefinition } from "../eval/preludes";
import type { ToolSession } from "../tools";
import { toolResult } from "../tools/tool-result";
import { createRlmKernelBind } from "./kernel-bind";
import { getRlmStore, rlmEnabled, rlmKernelBindEnabled } from "./session";

const JS_SOURCE = `
{
	const call = async (op, args = {}) => {
		const response = await globalThis.__omp_prelude__("rlm", { op, ...args });
		const details = response && typeof response.details === "object" && response.details !== null ? response.details : {};
		if (details.error) throw new Error(String(details.error));
		return details;
	};
	const rlm = {
		async handles() {
			const d = await call("handles");
			return d.handles ?? [];
		},
		async peek(handle, start = 0, end = undefined) {
			return await call("peek", { handle, start, end });
		},
		async search(handle, pattern, limit = 8) {
			const d = await call("search", { handle, pattern, limit });
			return d.hits ?? [];
		},
		async status() {
			const d = await call("status");
			return d.status ?? "";
		},
		toString() {
			return "[RLM bind]";
		},
	};
	Object.defineProperty(rlm, Symbol.for("nodejs.util.inspect.custom"), {
		value: () => "[RLM bind]",
	});
	globalThis.rlm = rlm;
}
`;

const PY_SOURCE = `
def _make_rlm():
    async def _call(op, **kwargs):
        response = await _omp_prelude(
            "rlm",
            {"op": op, **{k: v for k, v in kwargs.items() if v is not None}},
        )
        details = response.get("details") if isinstance(response, dict) else None
        if not isinstance(details, dict):
            details = {}
        if details.get("error"):
            raise RuntimeError(str(details["error"]))
        return details

    class RlmBind:
        async def handles(self):
            d = await _call("handles")
            return list(d.get("handles") or [])

        async def peek(self, handle, start=0, end=None):
            return await _call("peek", handle=handle, start=start, end=end)

        async def search(self, handle, pattern, limit=8):
            d = await _call("search", handle=handle, pattern=pattern, limit=limit)
            return list(d.get("hits") or [])

        async def status(self):
            d = await _call("status")
            return str(d.get("status") or "")

        def __repr__(self):
            return "<rlm bind>"

    return RlmBind()

rlm = _make_rlm()
`;

const DOCS = `## rlm (kernel bind)

Read-only access to spilled RLM handles from eval. Full bodies are never in \`repr\`.

\`\`\`js
const meta = await rlm.handles();
const slice = await rlm.peek(meta[0].handle, 0, 200);
const hits = await rlm.search(meta[0].handle, "NEEDLE_", 5);
console.log(await rlm.status());
\`\`\`

Requires \`rlm.enabled\` and \`rlm.kernelBind\`. Fail-open errors if the store is down.
`;

/**
 * Eval prelude for RFC v2 kernel bind. Enabled only when RLM + kernelBind are on.
 * Host calls stay read-only (peek/search/meta/status); never dump full records into details by default.
 */
export function createRlmPrelude(session: ToolSession): EvalPreludeDefinition {
	return {
		name: "rlm",
		documentation: DOCS,
		javascript: JS_SOURCE,
		python: PY_SOURCE,
		exports: ["rlm"],
		codeModeDeclarations: "declare const rlm: { handles(): Promise<unknown[]>; peek(handle: string, start?: number, end?: number): Promise<{ citation: string; text: string; start: number; end: number }>; search(handle: string, pattern: string, limit?: number): Promise<unknown[]>; status(): Promise<string>; };",
		approval: "read",
		enabled: () => rlmEnabled(session) && rlmKernelBindEnabled(session),
		invoke: async (parameters): Promise<AgentToolResult<{ op: string; error?: string; handles?: unknown; hits?: unknown; status?: string; citation?: string; text?: string; start?: number; end?: number }>> => {
			try {
				if (!rlmEnabled(session) || !rlmKernelBindEnabled(session)) {
					return toolResult({ op: "denied", error: "rlm kernel bind disabled" })
						.error()
						.text("rlm kernel bind disabled")
						.done();
				}
				const store = getRlmStore(session);
				const api = createRlmKernelBind(store);
				const params = (parameters && typeof parameters === "object" ? parameters : {}) as {
					op?: string;
					handle?: string;
					start?: number;
					end?: number;
					pattern?: string;
					limit?: number;
				};
				const op = params.op ?? "status";
				if (op === "handles") {
					return toolResult({ op, handles: api.handles() }).text("ok").done();
				}
				if (op === "status") {
					return toolResult({ op, status: api.status() }).text(api.status()).done();
				}
				if (op === "peek") {
					if (!params.handle) {
						return toolResult({ op, error: "handle required" }).error().text("handle required").done();
					}
					const peek = api.peek(params.handle, params.start ?? 0, params.end);
					// Cap text returned through the bridge (defense in depth).
					const text = peek.text.length > 8192 ? peek.text.slice(0, 8192) : peek.text;
					return toolResult({
						op,
						citation: peek.citation,
						text,
						start: peek.start,
						end: peek.end,
					})
						.text(`${peek.citation}\n${text}`)
						.done();
				}
				if (op === "search") {
					if (!params.handle || !params.pattern) {
						return toolResult({ op, error: "handle and pattern required" })
							.error()
							.text("handle and pattern required")
							.done();
					}
					const hits = api.search(params.handle, params.pattern, params.limit ?? 8);
					return toolResult({ op, hits }).text(hits.length ? "hits" : "no matches").done();
				}
				return toolResult({ op, error: `unknown op ${op}` }).error().text(`unknown op ${op}`).done();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				// Fail-open: never throw into the eval loop for bind misses.
				return toolResult({ op: "error", error: msg }).error().text(`${msg} (fail-open)`).done();
			}
		},
		status: parameters => {
			const op =
				parameters && typeof parameters === "object" && "op" in parameters
					? String((parameters as { op?: string }).op)
					: "rlm";
			return `rlm.${op}`;
		},
	};
}
