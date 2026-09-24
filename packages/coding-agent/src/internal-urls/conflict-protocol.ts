/**
 * Protocol handler for `conflict://` URLs: git merge-conflict blocks that
 * `read` registered in the calling session.
 *
 * - `conflict://<N>` / `conflict://<N>/<ours|theirs|base>`: read the block (or one side)
 * - `write conflict://<N>` / `write conflict://*`: splice replacement content over registered blocks
 */
import type { ToolSession } from "../tools";
import { readConflictUri, writeConflictUri } from "../tools/conflict-uri";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	WriteContext,
} from "./types";

function callerSession(context: ResolveContext | WriteContext | undefined): ToolSession {
	const session = context?.session;
	if (!session) throw new Error("conflict:// requires a calling session.");
	return session;
}

/** Session-scoped merge-conflict blocks registered by `read`; writable to resolve them. */
export class ConflictProtocolHandler implements ProtocolHandler {
	readonly scheme = "conflict";
	readonly spec: SchemeSpec = {
		backing: "virtual",
		selectors: "none",
		immutable: false,
		// Verbatim: `conflict://*` per-id directives must be parsed before hashline
		// stripping, so the handler strips copied prefixes itself.
		write: { via: "handler", payload: "verbatim", scope: "workspace", tier: () => "write" },
	};

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const region = readConflictUri(callerSession(context), url.rawHref ?? url.href);
		return {
			url: url.href,
			content: region.text,
			contentType: "text/plain",
			size: Buffer.byteLength(region.text, "utf-8"),
			sourcePath: region.absolutePath,
			shape: "value",
			details: { display: { text: region.rawText, startLine: region.startLine } },
		};
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		return writeConflictUri(callerSession(context), url.rawHref ?? url.href, content, context?.signal);
	}
}
