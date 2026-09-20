/**
 * Protocol handler for `rlm://` spilled evidence handles.
 *
 * URL form:
 * - `rlm://h/<id>` — session-owned spilled record body
 *
 * Authority: resource identity ≠ grant authority.
 * Knowing/guessing a handle id does **not** unlock another session's store.
 * Resolution binds only to the calling session's live {@link RlmStore}.
 *
 * Pagination / line selectors are applied by the read tool after resolve.
 * Grep treats the body as a virtual in-memory resource (no sourcePath).
 */
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { formatHandle, normalizeHandle, type RlmStore } from "../rlm/store";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

const MAX_INLINE_RLM_CHARS = 8 * 1024 * 1024;

function parseHandleId(url: InternalUrl): string {
	const host = (url.rawHost || url.hostname || "").toLowerCase();
	if (host !== "h") {
		throw new Error(
			`rlm:// URL must be rlm://h/<id> (spilled handle). Got host '${url.rawHost || url.hostname || ""}'.`,
		);
	}
	const path = (url.rawPathname ?? url.pathname ?? "").replace(/^\//, "");
	const id = path.split("/")[0]?.trim() ?? "";
	if (!id || id.includes("..") || id.includes("\\")) {
		throw new Error(`rlm:// URL requires a handle id: rlm://h/<id>`);
	}
	return normalizeHandle(id);
}

/**
 * Live session that issued the URL. Exact sessionFile / sessionId win;
 * cwd binds only when exactly one live session sits there.
 */
function findCallerSession(context: ResolveContext | undefined): AgentSession | undefined {
	if (!context) return undefined;
	const refs = (context.agentRegistry ?? AgentRegistry.global()).list();
	if (context.sessionFile !== undefined) {
		const byFile = refs.find(ref => ref.session?.sessionFile === context.sessionFile)?.session;
		if (byFile) return byFile;
	}
	if (context.sessionId !== undefined) {
		const byId = refs.find(ref => ref.session?.sessionManager.getSessionId() === context.sessionId)?.session;
		if (byId) return byId;
	}
	if (context.sessionFile !== undefined || context.sessionId !== undefined) return undefined;
	if (context.cwd === undefined) return undefined;
	const sameCwd = refs.filter(ref => ref.session?.sessionManager.getCwd() === context.cwd);
	return sameCwd.length === 1 ? (sameCwd[0]?.session ?? undefined) : undefined;
}

/** Resolve the caller's RLM store without creating a new one. */
export function resolveCallerRlmStore(context?: ResolveContext): RlmStore | undefined {
	if (context?.getRlmStore) {
		const injected = context.getRlmStore();
		if (injected && !injected.disposed) return injected;
		// Explicit miss: do not fall through to peer sessions.
		if (context.sessionFile !== undefined || context.sessionId !== undefined || context.getRlmStore) {
			return injected && !injected.disposed ? injected : undefined;
		}
	}
	const session = findCallerSession(context);
	const store = session?.rlmStore;
	if (store && !store.disposed) return store;
	return undefined;
}

export class RlmProtocolHandler implements ProtocolHandler {
	readonly scheme = "rlm";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const id = parseHandleId(url);
		const canonical = formatHandle(id);
		const store = resolveCallerRlmStore(context);
		if (!store) {
			throw new Error(
				`rlm:// requires the calling session's RLM store (enable RLM and spill first). No store bound for this caller.`,
			);
		}
		const record = store.get(id);
		if (!record) {
			// Do not reveal whether the id exists in another session.
			throw new Error(`unknown rlm handle: ${canonical}`);
		}

		store.metrics.resourceResolves += 1;

		if (context?.pathOnly) {
			return {
				url: canonical,
				content: "",
				contentType: "text/plain",
				size: record.bytes,
				notes: [`rlm handle ${canonical}`, `sha256=${record.sha256}`, record.source ? `source=${record.source}` : ""]
					.filter(Boolean),
				immutable: true,
			};
		}

		let text = record.text;
		if (text.length > MAX_INLINE_RLM_CHARS) {
			text = text.slice(0, MAX_INLINE_RLM_CHARS);
			store.note("rlm-protocol", `truncated ${canonical} to ${MAX_INLINE_RLM_CHARS} chars for read`);
		}

		// Reintroduction via ordinary read — count once per full resolve.
		store.metrics.bytesReintroduced += Buffer.byteLength(text, "utf8");
		store.metrics.peeks += 1;
		store.note("rlm-protocol", `read ${canonical} bytes=${Buffer.byteLength(text, "utf8")}`);

		return {
			url: canonical,
			content: text,
			contentType: "text/plain",
			size: record.bytes,
			notes: [
				`rlm spilled handle ${canonical}`,
				`sha256=${record.sha256}`,
				record.source ? `source=${record.source}` : "",
				"cite byte/char offsets when quoting",
			].filter(Boolean),
			immutable: true,
		};
	}

	async complete(query: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const store = resolveCallerRlmStore(context);
		if (!store) return [];
		const q = query.replace(/^h\/?/i, "").toLowerCase();
		const out: UrlCompletion[] = [];
		for (const id of store.records.keys()) {
			if (q && !id.toLowerCase().includes(q) && !`h/${id}`.includes(q)) continue;
			out.push({
				value: `h/${id}`,
				label: `h/${id}`,
				description: `${store.records.get(id)!.bytes} bytes`,
			});
		}
		return out;
	}
}
