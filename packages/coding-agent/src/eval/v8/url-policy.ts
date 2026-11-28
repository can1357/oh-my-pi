import { extractUriScheme, InternalUrlRouter } from "../../internal-urls";
import type { SchemeWriteScope } from "../../internal-urls/url-scheme";
import type { ToolSession } from "../../tools";

/** Schemes whose reads always delegate through `tool.read` for user-visible policy/approval. */
const DIRECT_READ_BLOCKED_SCHEMES: Readonly<Record<string, true>> = {
	cfg: true,
	vault: true,
};

const DIRECT_WRITE_SCOPES: Readonly<Partial<Record<SchemeWriteScope, true>>> = {
	sandbox: true,
	coordination: true,
	reply: true,
};
export type DirectReadPolicy = { allowed: true; normalized: string } | { allowed: false };

export type DirectWritePolicy =
	| {
			allowed: true;
			normalized: string;
			peeled: string;
			scope: SchemeWriteScope;
			via: "file" | "handler";
			maxBytes?: number;
	  }
	| { allowed: false };

export function isDirectReadableV8Url(rawPath: string): DirectReadPolicy {
	const router = InternalUrlRouter.instance();
	const normalized = router.normalize(rawPath);
	if (!router.canHandle(normalized)) return { allowed: false };
	const scheme = extractUriScheme(normalized);
	if (!scheme || DIRECT_READ_BLOCKED_SCHEMES[scheme]) return { allowed: false };
	const spec = router.spec(scheme);
	if (!spec || spec.backing === "remote") return { allowed: false };
	if (router.readTier(normalized) !== "read") return { allowed: false };
	return { allowed: true, normalized };
}

export function isDirectWritableV8Url(
	rawPath: string,
	content: string | undefined,
	session: ToolSession,
): DirectWritePolicy {
	const router = InternalUrlRouter.instance();
	const normalized = router.normalize(rawPath);
	const target = router.writeTarget(normalized);
	if (!target) return { allowed: false };
	const { url, spec } = target;
	if (!spec.write || spec.immutable) return { allowed: false };
	if (!DIRECT_WRITE_SCOPES[spec.write.scope]) return { allowed: false };
	const decision = spec.write.tier(url, content, session);
	if (decision !== "read") return { allowed: false };
	const peeled = router.peelWriteSelector(normalized, "write");
	return {
		allowed: true,
		normalized,
		peeled,
		scope: spec.write.scope,
		via: spec.write.via,
		maxBytes: spec.write.maxBytes,
	};
}
