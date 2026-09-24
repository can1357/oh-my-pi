/**
 * Internal URL router: one process-global registry of scheme handlers.
 *
 * Access via `InternalUrlRouter.instance()`. Handlers are stateless; per-session
 * and shared state lives in `./state.ts`. Tools consult the router's
 * {@link SchemeSpec}-driven API (`target`, `locate`, `writeTier`, `readTier`, ...)
 * instead of branching on scheme names, and the system prompt lists schemes
 * via {@link InternalUrlRouter.describe}.
 */
import * as path from "node:path";
import type { ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import { setInternalUrlCompletionHost } from "@oh-my-pi/pi-tui/prompt/internal-url-autocomplete";
import { splitInternalUrlSel } from "@oh-my-pi/pi-tui/tools/read";
import { setInternalUrlSchemeHost } from "@oh-my-pi/pi-tui/tools/url-scheme-host";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ToolSession } from "../tools";
import { AgentProtocolHandler } from "./agent-protocol";
import { ArtifactProtocolHandler } from "./artifact-protocol";
import { AttachmentProtocolHandler } from "./attachment-protocol";
import { CfgProtocolHandler } from "./cfg-protocol";
import { ConflictProtocolHandler } from "./conflict-protocol";
import { HistoryProtocolHandler } from "./history-protocol";
import { IssueProtocolHandler, PrProtocolHandler } from "./issue-pr-protocol";
import { LocalProtocolHandler } from "./local-protocol";
import { McpProtocolHandler } from "./mcp-protocol";
import { MemoryProtocolHandler } from "./memory-protocol";
import { OmpProtocolHandler } from "./omp-protocol";
import { extractUriScheme, normalizeLocalScheme, parseInternalUrl } from "./parse";
import { ProcProtocolHandler } from "./proc-protocol";
import { RuleProtocolHandler } from "./rule-protocol";
import { SecurityProtocolHandler } from "./security-protocol";
import { SkillProtocolHandler } from "./skill-protocol";
import { SshProtocolHandler } from "./ssh-protocol";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	LocateOptions,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	SchemeSpec,
	UrlCompletion,
	WriteContext,
} from "./types";
import { VaultProtocolHandler } from "./vault-protocol";
import { XdProtocolHandler } from "./xd-protocol";

setInternalUrlCompletionHost({
	completionSchemes: () => InternalUrlRouter.instance().completionSchemes(),
	resolveCompletions: (scheme, query, context) => InternalUrlRouter.instance().complete(scheme, query, context),
});

setInternalUrlSchemeHost({ spec: scheme => InternalUrlRouter.instance().spec(scheme) });

/**
 * Routed read/search target.
 * - `file`: a file-backed scheme whose URL located a local path; read it through the filesystem pipeline.
 * - `resource`: anything else; resolve it with {@link InternalUrlRouter.resolve} on `url.href`.
 */
export type UrlTarget =
	| { kind: "file"; url: InternalUrl; scheme: string; spec: SchemeSpec; path: string; sel?: string }
	| { kind: "resource"; url: InternalUrl; scheme: string; spec: SchemeSpec; sel?: string };

const SCHEME_PREFIX_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
// Authority matches up to the first `/` (not `?`/`#`): in a glob URL those are glob syntax.
const GLOB_URL_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i;
const GLOB_CHARS_RE = /[*?[{]/;
const TIER_RANK: Record<ToolTier, number> = { read: 0, write: 1, exec: 2 };

/** Bracket-escape glob metacharacters so a literal path survives glob expansion. */
function escapeGlob(literal: string): string {
	return literal.replace(/[*?[{]/g, "[$&]");
}

/**
 * Decode percent-escapes in one raw glob-tail segment, bracket-escaping any
 * metacharacter that was percent-encoded so it stays a literal filename character.
 */
function decodeGlobSegment(rawSegment: string, input: string): string {
	try {
		// Escape runs are decoded together so multi-byte UTF-8 sequences survive.
		return rawSegment.replace(/(?:%[0-9a-f]{2})+/gi, run => escapeGlob(decodeURIComponent(run)));
	} catch {
		throw new ToolError(`Invalid URL encoding in glob pattern: ${input}`);
	}
}

/** Process-global scheme registry; tools route internal URLs through its spec-driven API. */
export class InternalUrlRouter {
	static #instance: InternalUrlRouter | undefined;

	#handlers = new Map<string, ProtocolHandler>();
	/** Scheme whose handler resolves resources of unregistered custom schemes (MCP resource URIs). */
	readonly #resourceFallbackScheme: string;

	constructor() {
		const resourceFallback = new McpProtocolHandler();
		this.#resourceFallbackScheme = resourceFallback.scheme.toLowerCase();
		// Registration order is system-prompt order (see describe()).
		this.register(new SkillProtocolHandler());
		this.register(new RuleProtocolHandler());
		this.register(new MemoryProtocolHandler());
		this.register(new AgentProtocolHandler());
		this.register(new HistoryProtocolHandler());
		this.register(new ArtifactProtocolHandler());
		this.register(new LocalProtocolHandler());
		this.register(new ProcProtocolHandler());
		this.register(new CfgProtocolHandler());
		this.register(new SshProtocolHandler());
		// Reserved OMP-owned security-analysis namespace; vendor adapters normalize into its store.
		this.register(new SecurityProtocolHandler());
		this.register(new VaultProtocolHandler());
		this.register(new IssueProtocolHandler());
		this.register(new PrProtocolHandler());
		this.register(resourceFallback);
		this.register(new OmpProtocolHandler());
		this.register(new XdProtocolHandler());
		this.register(new AttachmentProtocolHandler());
		this.register(new ConflictProtocolHandler());
	}

	/** Process-global router instance. */
	static instance(): InternalUrlRouter {
		InternalUrlRouter.#instance ??= new InternalUrlRouter();
		return InternalUrlRouter.#instance;
	}

	/** Reset the global instance in tests. */
	static resetForTests(): void {
		InternalUrlRouter.#instance = undefined;
	}

	/** Install (or replace) the handler for `handler.scheme`. */
	register(handler: ProtocolHandler): void {
		this.#handlers.set(handler.scheme.toLowerCase(), handler);
	}

	/** Remove a scheme's handler; true when one was registered. */
	unregister(scheme: string): boolean {
		return this.#handlers.delete(scheme.toLowerCase());
	}

	/** Registered handler for `scheme` (case-insensitive). */
	getHandler(scheme: string): ProtocolHandler | undefined {
		return this.#handlers.get(scheme.toLowerCase());
	}

	/** Declared spec of a registered scheme (case-insensitive). */
	spec(scheme: string): SchemeSpec | undefined {
		return this.#handlers.get(scheme.toLowerCase())?.spec;
	}

	/** Specs of every registered scheme, in registration order. */
	specs(): ReadonlyMap<string, SchemeSpec> {
		const specs = new Map<string, SchemeSpec>();
		for (const [scheme, handler] of this.#handlers) specs.set(scheme, handler.spec);
		return specs;
	}

	/** Whether `input` is a hierarchical `scheme://` URL of a registered scheme. */
	canHandle(input: string): boolean {
		const match = input.match(SCHEME_PREFIX_RE);
		if (!match) return false;
		return this.#handlers.has(match[1].toLowerCase());
	}

	/**
	 * Whether read can resolve this URL through either a native handler or the
	 * MCP resource fallback. MCP resources may use arbitrary custom schemes and
	 * may be opaque (`urn:example:document`) rather than hierarchical.
	 */
	canResolve(input: string): boolean {
		const scheme = extractUriScheme(input);
		if (!scheme) return false;
		// Registered handlers only accept the hierarchical `scheme://` form;
		// opaque inputs reach the MCP resource fallback alone.
		if (this.#handlers.has(scheme)) return this.canHandle(input);
		return this.#isResourceFallbackScheme(scheme);
	}

	/** Schemes whose handler supports host/path autocomplete. */
	completionSchemes(): string[] {
		const schemes: string[] = [];
		for (const [scheme, handler] of this.#handlers) {
			if (handler.complete) schemes.push(scheme);
		}
		return schemes;
	}

	/**
	 * Candidate completions for the host/path portion of `scheme://<query>`.
	 * Returns `null` when the scheme is unknown or does not support completion.
	 */
	async complete(scheme: string, query: string, context?: ResolveContext): Promise<UrlCompletion[] | null> {
		const handler = this.#handlers.get(scheme.toLowerCase());
		if (!handler?.complete) return null;
		return handler.complete(query, context);
	}

	/** Peel a trailing read selector per spec.selectors (+portAuthority). Non-URLs / unknown schemes pass through unchanged. */
	split(input: string): { path: string; sel?: string } {
		return splitInternalUrlSel(input, scheme => this.spec(scheme));
	}

	/** Route a read/search target. null when input is not a router URL (after MCP fallback). */
	async target(input: string, context?: ResolveContext, options?: LocateOptions): Promise<UrlTarget | null> {
		const { path: bare, sel } = this.split(normalizeLocalScheme(input));
		const scheme = extractUriScheme(bare);
		if (!scheme) return null;
		// Registered handlers only accept the hierarchical `scheme://` form.
		const registered = this.#handlers.get(scheme);
		const handler = registered
			? this.canHandle(bare)
				? registered
				: undefined
			: this.#resourceFallbackHandler(scheme);
		if (!handler) return null;
		const url = parseInternalUrl(bare);
		const spec = handler.spec;
		if (spec.backing === "file" && handler.locate) {
			const located = await handler.locate(url, context, options);
			if (located !== null) return { kind: "file", url, scheme, spec, path: located, sel };
		}
		return { kind: "resource", url, scheme, spec, sel };
	}

	/** handler.locate; null when the scheme has no locate or the URL has no local backing. */
	async locate(input: string, context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		const normalized = normalizeLocalScheme(input);
		if (!this.canHandle(normalized)) return null;
		const { parsed, handler } = this.#route(normalized);
		if (!handler.locate) return null;
		return handler.locate(parsed, context, options);
	}

	/**
	 * locate or throw ToolError `Cannot ${action} ${scheme}:// URL: no local file backs ${input}`
	 * (+ a `read` hint for remote/virtual schemes).
	 */
	async requireLocal(
		input: string,
		action: string,
		context?: ResolveContext,
		options?: LocateOptions,
	): Promise<string> {
		const located = await this.locate(input, context, options);
		if (located !== null) return located;
		const scheme = extractUriScheme(normalizeLocalScheme(input));
		const message = `Cannot ${action} ${scheme ?? input}:// URL: no local file backs ${input}`;
		const backing = scheme ? this.spec(scheme)?.backing : undefined;
		if (backing === "remote" || backing === "virtual") {
			throw new ToolError(`${message}. Use \`read ${input}\` to inspect it.`);
		}
		throw new ToolError(message);
	}

	/**
	 * Glob over a locatable directory: splits `scheme://base/**\/*.md` at the first glob
	 * segment, locates the base as a directory, returns `<abs-base>/<glob-tail>` with the
	 * base glob-escaped. null when not locatable.
	 */
	async locateGlob(input: string, context?: ResolveContext): Promise<string | null> {
		const normalized = normalizeLocalScheme(input);
		const match = normalized.match(GLOB_URL_RE);
		if (!match) return null;
		const [, rawScheme, authority, rawPath] = match;
		const scheme = rawScheme.toLowerCase();
		const handler = this.#handlers.get(scheme);
		if (!handler?.locate) return null;

		const pathSegments = rawPath ? rawPath.slice(1).split("/") : [];
		const segments = [authority, ...pathSegments];
		const firstGlob = segments.findIndex(segment => GLOB_CHARS_RE.test(segment));
		if (firstGlob === -1) {
			const located = await handler.locate(parseInternalUrl(normalized), context, { directory: true });
			return located === null ? null : escapeGlob(located);
		}

		const rawTail = segments.slice(firstGlob);
		if (rawTail.some(segment => /%(?:2f|5c)/i.test(segment))) {
			throw new ToolError(`Encoded path separators are not allowed in ${scheme}:// glob patterns: ${input}`);
		}
		const tail = rawTail.map(segment => decodeGlobSegment(segment, input));
		if (tail.includes("..")) {
			throw new ToolError(`Glob pattern traversal above the ${scheme}:// base is not allowed: ${input}`);
		}

		// An empty base path keeps the explicit `/.` so the base names the authority's directory itself.
		const baseUrl =
			firstGlob === 0
				? `${rawScheme}://`
				: `${rawScheme}://${authority}/${pathSegments.slice(0, firstGlob - 1).join("/") || "."}`;
		const base = await handler.locate(parseInternalUrl(baseUrl), context, { directory: true });
		if (base === null) return null;
		return path.join(escapeGlob(base), tail.join("/"));
	}

	/** Sync locate for renderers; only schemes with spec.linkable. Never throws. */
	locateSync(input: string, context?: ResolveContext): string | undefined {
		const normalized = normalizeLocalScheme(input);
		const match = normalized.match(SCHEME_PREFIX_RE);
		if (!match) return undefined;
		const handler = this.#handlers.get(match[1].toLowerCase());
		if (!handler?.spec.linkable || !handler.locateSync) return undefined;
		let parsed: InternalUrl;
		try {
			parsed = parseInternalUrl(this.split(normalized).path);
		} catch {
			return undefined;
		}
		return handler.locateSync(parsed, context);
	}

	/** Approval tier for writing `input`. Non-URL → "write". Scheme without spec.write → "read" (the write then fails as read-only). */
	writeTier(input: string, content: string | undefined, session: ToolSession | undefined): ToolApprovalDecision {
		const normalized = normalizeLocalScheme(input);
		if (!this.canHandle(normalized)) return "write";
		const { parsed, handler } = this.#route(normalized);
		const policy = handler.spec.write;
		if (!policy) return "read";
		return policy.tier(parsed, content, session);
	}

	/** Max spec.readTier over every registered `scheme://` occurring ANYWHERE in `text` (substring, fail-closed for delimited paths). Default "read". */
	readTier(text: string): ToolTier {
		const lower = text.toLowerCase();
		let tier: ToolTier = "read";
		for (const [scheme, handler] of this.#handlers) {
			const schemeTier = handler.spec.readTier ?? "read";
			if (TIER_RANK[schemeTier] <= TIER_RANK[tier]) continue;
			if (lower.includes(`${scheme}://`)) tier = schemeTier;
		}
		return tier;
	}

	/** Rendered promptDoc lines, registration order, for schemes available under `host`. */
	describe(host: SchemeHost): string[] {
		const lines: string[] = [];
		for (const handler of this.#handlers.values()) {
			const line = handler.promptDoc?.(host);
			if (line !== undefined) lines.push(line);
		}
		return lines;
	}

	#isResourceFallbackScheme(scheme: string): boolean {
		return !["file", "http", "https"].includes(scheme) && this.#handlers.has(this.#resourceFallbackScheme);
	}

	#resourceFallbackHandler(scheme: string): ProtocolHandler | undefined {
		return this.#isResourceFallbackScheme(scheme) ? this.#handlers.get(this.#resourceFallbackScheme) : undefined;
	}

	#route(input: string, allowResourceFallback = false): { parsed: InternalUrl; handler: ProtocolHandler } {
		const parsed = parseInternalUrl(normalizeLocalScheme(input));
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		const handler =
			this.#handlers.get(scheme) ?? (allowResourceFallback ? this.#resourceFallbackHandler(scheme) : undefined);
		if (!handler) {
			const available = Array.from(this.#handlers.keys())
				.map(candidate => `${candidate}://`)
				.join(", ");
			throw new Error(`Unknown protocol: ${scheme}://\nSupported: ${available || "none"}`);
		}
		return { parsed, handler };
	}

	/** Resolve an internal URL through its registered protocol handler. */
	async resolve(input: string, context?: ResolveContext): Promise<InternalResource> {
		const { parsed, handler } = this.#route(input, true);
		const resource = await handler.resolve(parsed, context);
		return { ...resource, immutable: resource.immutable ?? handler.spec.immutable };
	}

	/**
	 * Write an internal URL through its registered protocol handler. Returns the
	 * handler's model-facing result, if it produced one.
	 */
	async write(input: string, content: string, context?: WriteContext): Promise<InternalWriteResult | void> {
		const { parsed, handler } = this.#route(input);
		if (!handler.write) {
			const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
			throw new Error(`${scheme}:// URLs are read-only for write; use the protocol-specific tool for mutations.`);
		}
		return await handler.write(parsed, content, context);
	}
}
