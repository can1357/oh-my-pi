/**
 * Internal URL router: one process-global registry of scheme handlers.
 *
 * Access via `InternalUrlRouter.instance()`. Handlers are stateless: per-session
 * state arrives through the caller's {@link ResolveContext}/{@link WriteContext}.
 * Tools consult the router's {@link SchemeSpec}-driven API (`target`, `locate`,
 * `writeTier`, `readTier`, ...) instead of branching on scheme names, and the
 * system prompt lists schemes via {@link InternalUrlRouter.describe}. Every
 * method accepts a scheme's single-slash alias (`local:/x`) and normalizes it
 * through {@link InternalUrlRouter.normalize}.
 */
import * as path from "node:path";
import type { ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import { setInternalUrlCompletionHost } from "@oh-my-pi/pi-tui/prompt/internal-url-autocomplete";
import { splitInternalUrlSel } from "@oh-my-pi/pi-tui/tools/read";
import { setInternalUrlSchemeHost, splitUrlScheme } from "@oh-my-pi/pi-tui/tools/url-scheme-host";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ToolSession } from "../tools";
import { TIER_RANK } from "../tools/approval";
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
import { extractUriScheme, parseInternalUrl } from "./parse";
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
	| { kind: "file"; url: InternalUrl; spec: SchemeSpec; path: string; sel?: string }
	| { kind: "resource"; url: InternalUrl; spec: SchemeSpec; sel?: string };

/** A registered hierarchical URL after single-slash alias normalization. */
interface RegisteredUrl {
	/** Normalized `scheme://…` input. */
	url: string;
	/** Lowercased scheme. */
	scheme: string;
	handler: ProtocolHandler;
}

const SINGLE_SLASH_ALIAS_RE = /^([a-z][a-z0-9+.-]*):\/(?!\/)/i;
const GLOB_CHARS_RE = /[*?[{]/;
// A `?` opening `key=value` pairs starts a URL query (`?op=search`, `?state=closed`); any other `?` is a glob.
const QUERY_START_RE = /\?[\w.-]*=/;
// Selectors a mutating tool accepts: whole-file display modes that do not change which bytes are addressed.
const WHOLE_FILE_SELECTOR_RE = /^(?:raw|conflicts)$/i;

/** Process-global scheme registry; tools route internal URLs through its spec-driven API. */
export class InternalUrlRouter {
	static #instance: InternalUrlRouter | undefined;

	#handlers = new Map<string, ProtocolHandler>();
	/** Scheme whose handler resolves resources of unregistered custom schemes (MCP resource URIs). */
	readonly #resourceFallbackScheme: string;
	/** Schemes the constructor registers: OMP-owned, never replaced by hosts. */
	readonly #builtinSchemes: ReadonlySet<string>;

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
		this.#builtinSchemes = new Set(this.#handlers.keys());
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

	/**
	 * Install (or replace) the handler for `handler.scheme`. Throws when the spec's write
	 * policy disagrees with the handler: `write()` exists exactly for `write.via: "handler"`;
	 * `write.via: "file"` needs a mutable file-backed spec with `locate()`; a `sandbox` scope
	 * needs a linkable `locateSync()` so {@link sandboxRoots} can locate its root.
	 */
	register(handler: ProtocolHandler): void {
		const { scheme, spec } = handler;
		const via = spec.write?.via;
		if (via === "handler" && !handler.write) {
			throw new Error(`${scheme}:// spec.write.via is "handler" but the handler lacks write()`);
		}
		if (via !== "handler" && handler.write) {
			throw new Error(
				`${scheme}:// handler has write() but spec.write.via is ${via === undefined ? "absent" : `"${via}"`}`,
			);
		}
		if (via === "file") {
			if (spec.backing !== "file") {
				throw new Error(`${scheme}:// spec.write.via "file" requires backing "file", not "${spec.backing}"`);
			}
			if (!handler.locate) throw new Error(`${scheme}:// spec.write.via "file" requires a locate() hook`);
			if (spec.immutable) throw new Error(`${scheme}:// spec.write.via "file" contradicts spec.immutable`);
		}
		if (spec.write?.scope === "sandbox" && (!spec.linkable || !handler.locateSync)) {
			throw new Error(`${scheme}:// spec.write.scope "sandbox" requires spec.linkable and a locateSync() hook`);
		}
		this.#handlers.set(scheme.toLowerCase(), handler);
	}

	/** Whether the router constructor registered `scheme` (case-insensitive): an OMP-owned scheme hosts may not replace. */
	isBuiltin(scheme: string): boolean {
		return this.#builtinSchemes.has(scheme.toLowerCase());
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

	/** Rewrite a registered scheme's single-slash alias (`local:/x`, {@link SchemeSpec.singleSlashAlias}) to `scheme://x`; other inputs pass through. */
	normalize(input: string): string {
		const match = SINGLE_SLASH_ALIAS_RE.exec(input);
		if (!match || !this.#handlers.get(match[1].toLowerCase())?.spec.singleSlashAlias) return input;
		return `${match[1]}://${input.slice(match[0].length)}`;
	}

	/** Whether `input` (after {@link normalize}) is a hierarchical `scheme://` URL of a registered scheme. */
	canHandle(input: string): boolean {
		return this.#registered(input) !== undefined;
	}

	/**
	 * Whether read can resolve this URL through either a native handler or the
	 * MCP resource fallback. MCP resources may use arbitrary custom schemes and
	 * may be opaque (`urn:example:document`) rather than hierarchical.
	 */
	canResolve(input: string): boolean {
		const normalized = this.normalize(input);
		const scheme = extractUriScheme(normalized);
		if (!scheme) return false;
		// Registered handlers only accept the hierarchical `scheme://` form;
		// opaque inputs reach the MCP resource fallback alone.
		if (this.#handlers.has(scheme)) return this.canHandle(normalized);
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

	/**
	 * {@link normalize} `input`, then peel a trailing read selector per spec.selectors (+portAuthority).
	 * Non-URLs and unknown schemes pass through unchanged.
	 */
	split(input: string): { path: string; sel?: string } {
		return splitInternalUrlSel(this.normalize(input), scheme => this.spec(scheme));
	}

	/**
	 * A mutating tool's URL target ({@link normalize}d) with a whole-file display selector
	 * (`:raw`/`:conflicts`) peeled, so it names the file `read` does. Any other selector — a line
	 * range, `raw:1-20`, a malformed `:-10` — throws ToolError: the tool addresses a whole file, and
	 * dropping the selector would mutate a file the caller never named. Non-URLs pass through.
	 */
	peelWriteSelector(input: string, tool: string): string {
		const { path, sel } = this.split(input);
		if (sel === undefined || WHOLE_FILE_SELECTOR_RE.test(sel)) return path;
		throw new ToolError(
			`${tool} does not accept the trailing selector ":${sel}" — it addresses a whole file. ` +
				`Remove ":${sel}", or if the filename truly ends with it, percent-encode the ":" as %3A.`,
		);
	}

	/** Route a read/search target. null when input is not a router URL (after MCP fallback). */
	async target(input: string, context?: ResolveContext): Promise<UrlTarget | null> {
		const { path: bare, sel } = this.split(input);
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
			const located = await handler.locate(url, context);
			if (located !== null) return { kind: "file", url, spec, path: located, sel };
		}
		return { kind: "resource", url, spec, sel };
	}

	/** handler.locate on the URL with its read selector peeled; null when the scheme has no locate or the URL has no local backing. */
	async locate(input: string, context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		const registered = this.#registered(input);
		if (!registered?.handler.locate) return null;
		return registered.handler.locate(parseInternalUrl(this.split(registered.url).path), context, options);
	}

	/**
	 * locate or throw ToolError. A locatable, immutable, non-remote scheme resolves from session-local
	 * stores, so its resolve error diagnoses the miss (`Cannot find artifact://9: Artifact 9 not found.
	 * Available: …`); otherwise `Cannot ${action} ${scheme}:// URL: no local file backs ${input}`
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
		const registered = this.#registered(input);
		const spec = registered?.handler.spec;
		if (registered?.handler.locate && spec?.immutable && spec.backing !== "remote") {
			try {
				await registered.handler.resolve(parseInternalUrl(this.split(registered.url).path), context);
			} catch (error) {
				if (context?.signal?.aborted) throw error;
				throw new ToolError(`Cannot ${action} ${input}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const scheme = extractUriScheme(this.normalize(input));
		const message = `Cannot ${action} ${scheme ?? input}:// URL: no local file backs ${input}`;
		if (spec?.backing === "remote" || spec?.backing === "virtual") {
			throw new ToolError(`${message}. Use \`read ${input}\` to inspect it.`);
		}
		throw new ToolError(message);
	}

	/**
	 * Whether `input` is a registered URL with a glob segment. The authority counts as the first
	 * segment unless it is a host ({@link SchemeSpec.portAuthority}). The query (`?key=…`) and
	 * fragment never glob, so `issue://?search=fix*` is no glob while `memory://root/?.md` is.
	 */
	isGlob(input: string): boolean {
		const glob = this.#globSegments(input);
		return glob !== undefined && glob.firstGlob !== -1;
	}

	/** Sync locate for renderers; only schemes with spec.linkable. Never throws. */
	locateSync(input: string, context?: ResolveContext): string | undefined {
		const registered = this.#registered(input);
		if (!registered?.handler.spec.linkable || !registered.handler.locateSync) return undefined;
		let parsed: InternalUrl;
		try {
			parsed = parseInternalUrl(this.split(registered.url).path);
		} catch {
			return undefined;
		}
		return registered.handler.locateSync(parsed, context);
	}

	/**
	 * Absolute roots of every `sandbox`-scope writable scheme (plan mode keeps them writable), located
	 * for `context` through {@link locateSync}; {@link register} requires such schemes to be linkable.
	 */
	sandboxRoots(context?: ResolveContext): string[] {
		const roots: string[] = [];
		for (const [scheme, handler] of this.#handlers) {
			if (handler.spec.write?.scope !== "sandbox") continue;
			const root = this.locateSync(`${scheme}://`, context);
			if (root !== undefined) roots.push(path.resolve(root));
		}
		return roots;
	}

	/** Searchable leaf documents behind `input` ({@link ProtocolHandler.enumerate}); null when its scheme cannot enumerate. */
	async enumerate(input: string, context?: ResolveContext): Promise<Array<{ url: string; content: string }> | null> {
		const registered = this.#registered(input);
		if (!registered?.handler.enumerate) return null;
		return registered.handler.enumerate(parseInternalUrl(registered.url), context);
	}

	/** Parsed URL and scheme spec of a registered `input`, for the `write` tool's routing and gates; undefined for non-URLs. */
	writeTarget(input: string): { url: InternalUrl; spec: SchemeSpec } | undefined {
		const registered = this.#registered(input);
		return registered && { url: parseInternalUrl(registered.url), spec: registered.handler.spec };
	}

	/**
	 * Whether file-editing tools (`edit`, `ast_edit`) may write the file `input` locates: its
	 * scheme is mutable and tools own its writes (`spec.write.via === "file"`).
	 */
	fileWritable(input: string): boolean {
		const spec = this.#registered(input)?.handler.spec;
		return spec?.write?.via === "file" && !spec.immutable;
	}

	/**
	 * Approval decision for writing `input`: its scheme's `spec.write.tier`. Non-URLs are "write";
	 * a registered scheme without `spec.write` is denied at the gate as read-only, never prompted.
	 */
	writeTier(input: string, content: string | undefined, session: ToolSession | undefined): ToolApprovalDecision {
		const registered = this.#registered(input);
		if (!registered) return "write";
		const policy = registered.handler.spec.write;
		if (!policy) return { tier: "write", policy: "deny", reason: `${registered.scheme}:// URLs are read-only` };
		return policy.tier(parseInternalUrl(registered.url), content, session);
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

	/** Normalized hierarchical URL of a registered scheme, with its handler; undefined otherwise. */
	#registered(input: string): RegisteredUrl | undefined {
		const url = this.normalize(input);
		const split = splitUrlScheme(url);
		const handler = split && this.#handlers.get(split.scheme);
		return handler && split ? { url, scheme: split.scheme, handler } : undefined;
	}

	/**
	 * Authority + path segments of a registered URL, query and fragment cut ({@link isGlob}),
	 * and the index of the first glob segment (-1: none).
	 */
	#globSegments(input: string): (RegisteredUrl & { segments: string[]; firstGlob: number }) | undefined {
		const registered = this.#registered(input);
		if (!registered) return undefined;
		const rest = registered.url.slice(registered.scheme.length + 3);
		const fragment = rest.indexOf("#");
		const beforeFragment = fragment === -1 ? rest : rest.slice(0, fragment);
		const query = beforeFragment.search(QUERY_START_RE);
		const segments = (query === -1 ? beforeFragment : beforeFragment.slice(0, query)).split("/");
		const firstGlob = segments.findIndex(
			(segment, index) => (index > 0 || !registered.handler.spec.portAuthority) && GLOB_CHARS_RE.test(segment),
		);
		return { ...registered, segments, firstGlob };
	}

	#route(input: string, allowResourceFallback = false): { parsed: InternalUrl; handler: ProtocolHandler } {
		const parsed = parseInternalUrl(this.normalize(input));
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
