import type { RlmStore } from "./store";
import { formatHandle, normalizeHandle } from "./store";

/**
 * Optional EvalRunner bind surface (RFC v2 workstream B).
 *
 * Pure TS helpers the host can inject into a Python/JS kernel prelude.
 * Does **not** start a kernel. Bodies are never placed in `repr` strings —
 * only metadata + capped peeks.
 */
export interface RlmKernelBindApi {
	handles(): Array<{ id: string; handle: string; bytes: number; source?: string }>;
	peek(handle: string, start?: number, end?: number): { citation: string; text: string; start: number; end: number };
	search(
		handle: string,
		pattern: string,
		limit?: number,
	): Array<{ index: number; text: string; citation: string }>;
	status(): string;
}

/** Build a read-only bind API over an existing store. */
export function createRlmKernelBind(store: RlmStore): RlmKernelBindApi {
	return {
		handles() {
			return [...store.records.values()].map(r => ({
				id: r.id,
				handle: formatHandle(r.id),
				bytes: r.bytes,
				source: r.source,
			}));
		},
		peek(handle, start = 0, end) {
			const p = store.peek(handle, start, end);
			return { citation: p.citation, text: p.text, start: p.start, end: p.end };
		},
		search(handle, pattern, limit = 8) {
			return store.search(handle, pattern, limit).map(h => ({
				index: h.index,
				text: h.text,
				citation: h.citation,
			}));
		},
		status() {
			return store.status();
		},
	};
}

/**
 * Python prelude snippet: defines a tiny `rlm` module-like dict **without**
 * dumping full bodies. Host eval injects concrete call results via RPC; this
 * string is documentation + a safe placeholder when bind is off.
 */
export function rlmKernelPrelude(enabled: boolean): string {
	if (!enabled) {
		return "# rlm.kernelBind=false — no RLM handle bind in this kernel\n";
	}
	return [
		"# RLM kernel bind (read-only). Full spilled bodies are not printed by default.",
		"# Host injects rlm_handles / rlm_peek / rlm_search callables when available.",
		"class _RlmBind:",
		"    def handles(self):",
		"        return list(globals().get('_rlm_handle_meta', []))",
		"    def peek(self, handle, start=0, end=None):",
		"        fn = globals().get('_rlm_peek')",
		"        if fn is None: raise RuntimeError('rlm peek not bound')",
		"        return fn(handle, start, end)",
		"    def search(self, handle, pattern, limit=8):",
		"        fn = globals().get('_rlm_search')",
		"        if fn is None: raise RuntimeError('rlm search not bound')",
		"        return fn(handle, pattern, limit)",
		"    def __repr__(self):",
		"        meta = globals().get('_rlm_handle_meta', [])",
		"        return f'<rlm handles={len(meta)}>'",
		"rlm = _RlmBind()",
		"",
	].join("\n");
}

/** JSON-serializable handle metadata for kernel injection (no text bodies). */
export function rlmHandleMeta(store: RlmStore): Array<{ id: string; handle: string; bytes: number; source?: string }> {
	return createRlmKernelBind(store).handles();
}

export { normalizeHandle };
