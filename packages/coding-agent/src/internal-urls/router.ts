/**
 * Internal URL router: built-in scheme handlers plus a session's own schemes.
 *
 * Two layers. {@link InternalUrlRouter.builtins} is the process-wide router: it
 * holds only OMP's built-in schemes and never changes at runtime. A session's
 * router (`new InternalUrlRouter(sources)`, reached through `session.urlRouter`
 * or `ResolveContext.router`) checks the session's own {@link UrlSchemeSource}s
 * first, in order, and then the built-ins. Code with no session gets the
 * built-ins only. Handlers are stateless: per-session state arrives through the
 * caller's {@link ResolveContext}/{@link WriteContext}. Tools consult the
 * router's {@link SchemeSpec}-driven API (`target`, `locate`, `writeTier`,
 * `readTier`, ...) instead of branching on scheme names, and the system prompt
 * lists schemes via {@link InternalUrlRouter.describe}. Every method accepts a
 * scheme's single-slash alias (`local:/x`) and normalizes it through
 * {@link InternalUrlRouter.normalize}.
 */
import * as path from "node:path";
import type { ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import { splitUrlScheme } from "./url-scheme";
import { ToolError } from "../tools/tool-errors";
import type { ToolSession } from "../tools";
import { TIER_RANK } from "../tools/approval";
import { AgentProtocolHandler } from "./agent-protocol";
import { AttachmentProtocolHandler } from "./attachment-protocol";
import { CfgProtocolHandler } from "./cfg-protocol";
import { ConflictProtocolHandler } from "./conflict-protocol";
import { HelpProtocolHandler } from "./help-protocol";
import { HistoryProtocolHandler } from "./history-protocol";
import { IssueProtocolHandler, PrProtocolHandler } from "./issue-pr-protocol";
import { LocalProtocolHandler } from "./local-protocol";
import { McpProtocolHandler } from "./mcp-protocol";
import { MemoryProtocolHandler } from "./memory-protocol";
import { MrProtocolHandler } from "./mr-protocol";
import { OmpProtocolHandler } from "./omp-protocol";
import { OutProtocolHandler } from "./out-protocol";
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
import { splitInternalUrlSel } from "../tools/details/read";

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
// `/home/me/repo/local://x.md` (or `C:\repo\local://x.md`): a filesystem path
// glued in front of a URL. Each match is a separator followed by `scheme://`
// and then a non-slash or the end (the bare `local://` root). Only `://`
// counts, since `dir/local:/x` (single slash) can be a real `local:` directory.
const PREFIXED_URL_SEGMENT_RE = /[\\/]([a-z][a-z0-9+.-]*):\/\/(?=[^/]|$)/gi;
// A prefix that is itself a URL (`https://h/local://x`) is not a filesystem
// path; a Windows drive letter (`C:`) is.
const URL_PREFIX_RE = /^(?![a-z]:[\\/])[a-z][a-z0-9+.-]*:/i;
const GLOB_CHARS_RE = /[*?[{]/;
// A `?` opening `key=value` pairs starts a URL query (`?op=search`, `?state=closed`); any other `?` is a glob.
const QUERY_START_RE = /\?[\w.-]*=/;
// Selectors a mutating tool accepts: whole-file display modes that do not change which bytes are addressed.
const WHOLE_FILE_SELECTOR_RE = /^(?:raw|conflicts)$/i;

/**
 * Schemes a session owns, checked before the built-ins: RPC host URIs, then
 * extension schemes. Keys are lowercase; a source never holds a built-in scheme.
 */
export interface UrlSchemeSource {
	/** Handler for a lowercase `scheme`, if this source owns it. */
	get(scheme: string): ProtocolHandler | undefined;
	/** Every handler this source owns, in registration order. */
	handlers(): Iterable<ProtocolHandler>;
}

const registrationIds = new WeakMap<ProtocolHandler, string>();

/**
 * Identity of one handler registration. Two sessions may register the same scheme with different
 * handlers, so state keyed by URL alone would mix their resources; keying by this identity does not.
 * Random, so it never repeats across registrations or processes.
 */
export function registrationId(handler: ProtocolHandler): string {
	let id = registrationIds.get(handler);
	if (id === undefined) {
		id = crypto.randomUUID();
		registrationIds.set(handler, id);
	}
	return id;
}

/**
 * Throw when `handler`'s spec write policy disagrees with the handler: `write()` exists exactly for
 * `write.via: "handler"`; `write.via: "file"` needs a mutable file-backed spec with `locate()`; a
 * `sandbox` scope needs a linkable `locateSync()` so {@link InternalUrlRouter.sandboxRoots} can locate its root.
 */
export function assertProtocolHandlerSpec(handler: ProtocolHandler): void {
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
}

/** OMP's built-in handlers, keyed by lowercase scheme; registration order is system-prompt order (see describe()). */
function createBuiltinHandlers(resourceFallback: McpProtocolHandler): Map<string, ProtocolHandler> {
	const handlers = new Map<string, ProtocolHandler>();
	for (const handler of [
		new SkillProtocolHandler(),
		new RuleProtocolHandler(),
		new MemoryProtocolHandler(),
		new OutProtocolHandler(),
		new AgentProtocolHandler(),
		new HistoryProtocolHandler(),
		new LocalProtocolHandler(),
		new ProcProtocolHandler(),
		new CfgProtocolHandler(),
		new SshProtocolHandler(),
		// Reserved OMP-owned security-analysis namespace; vendor adapters normalize into its store.
		new SecurityProtocolHandler(),
		new VaultProtocolHandler(),
		new IssueProtocolHandler(),
		new PrProtocolHandler(),
		new MrProtocolHandler(),
		resourceFallback,
		new OmpProtocolHandler(),
		new HelpProtocolHandler(),
		new AttachmentProtocolHandler(),
		new ConflictProtocolHandler(),
	] satisfies ProtocolHandler[]) {
		assertProtocolHandlerSpec(handler);
		handlers.set(handler.scheme.toLowerCase(), handler);
	}
	return handlers;
}

/** Built-in handlers shared by every router in the process; created on first use, never changed after. */
interface BuiltinTable {
	handlers: ReadonlyMap<string, ProtocolHandler>;
	/** Scheme whose handler resolves resources of unregistered custom schemes (MCP resource URIs). */
	resourceFallbackScheme: string;
}

/** Scheme registry for one caller: a session's own schemes, then the built-ins; tools route internal URLs through its spec-driven API. */
export class InternalUrlRouter {
	static #builtinTable: BuiltinTable | undefined;
	static #builtins: InternalUrlRouter | undefined;

	readonly #builtinHandlers: ReadonlyMap<string, ProtocolHandler>;
	readonly #resourceFallbackScheme: string;
	readonly #sources: readonly UrlSchemeSource[];

	/** A router over `sources` (checked in order), then the built-ins. No sources: the built-ins alone. */
	constructor(sources: readonly UrlSchemeSource[] = []) {
		InternalUrlRouter.#builtinTable ??= (() => {
			const resourceFallback = new McpProtocolHandler();
			return {
				handlers: createBuiltinHandlers(resourceFallback),
				resourceFallbackScheme: resourceFallback.scheme.toLowerCase(),
			};
		})();
		this.#builtinHandlers = InternalUrlRouter.#builtinTable.handlers;
		this.#resourceFallbackScheme = InternalUrlRouter.#builtinTable.resourceFallbackScheme;
		this.#sources = sources;
	}

	/** The process-wide router: OMP's built-in schemes only. For code with no session. */
	static builtins(): InternalUrlRouter {
		InternalUrlRouter.#builtins ??= new InternalUrlRouter();
		return InternalUrlRouter.#builtins;
	}

	/** Whether `scheme` (case-insensitive) is one of OMP's built-in schemes, which no session source may own. */
	static isBuiltin(scheme: string): boolean {
		return InternalUrlRouter.builtins().#builtinHandlers.has(scheme.toLowerCase());
	}

	/** Drop the built-in handlers (and their cached state) in tests; the next router recreates them. */
	static resetForTests(): void {
		InternalUrlRouter.#builtinTable = undefined;
		InternalUrlRouter.#builtins = undefined;
	}

	/** Registered handler for `scheme` (case-insensitive): the session's sources first, then the built-ins. */
	getHandler(scheme: string): ProtocolHandler | undefined {
		return this.#handler(scheme.toLowerCase());
	}

	/** Declared spec of a registered scheme (case-insensitive). */
	spec(scheme: string): SchemeSpec | undefined {
		return this.#handler(scheme.toLowerCase())?.spec;
	}

	/** Spec of every registered scheme, as {@link spec} reports it: built-ins in registration order, then the session's own. */
	specs(): ReadonlyMap<string, SchemeSpec> {
		const specs = new Map<string, SchemeSpec>();
		for (const [scheme, handler] of this.#entries()) specs.set(scheme, handler.spec);
		return specs;
	}

	/**
	 * Rewrite mistyped spellings of a scheme that declares
	 * {@link SchemeSpec.singleSlashAlias} to `scheme://x`: the single-slash alias
	 * (`local:/x`) and a filesystem path prefixed onto the URL
	 * (`/home/me/repo/local://x`). Other inputs pass through.
	 */
	normalize(input: string): string {
		if (!URL_PREFIX_RE.test(input)) {
			// The first eligible scheme wins: later `local://` text belongs to the URL's own path.
			for (const segment of input.matchAll(PREFIXED_URL_SEGMENT_RE)) {
				if (this.#handler(segment[1].toLowerCase())?.spec.singleSlashAlias) {
					return input.slice(segment.index + 1);
				}
			}
		}
		const match = SINGLE_SLASH_ALIAS_RE.exec(input);
		if (!match || !this.#handler(match[1].toLowerCase())?.spec.singleSlashAlias) return input;
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
		if (this.#handler(scheme)) return this.canHandle(normalized);
		return this.#isResourceFallbackScheme(scheme);
	}

	/** Schemes whose handler supports host/path autocomplete. */
	completionSchemes(): string[] {
		const schemes: string[] = [];
		for (const [scheme, handler] of this.#entries()) {
			if (handler.complete) schemes.push(scheme);
		}
		return schemes;
	}

	/**
	 * Candidate completions for the host/path portion of `scheme://<query>`.
	 * Returns `null` when the scheme is unknown or does not support completion.
	 */
	async complete(scheme: string, query: string, context?: ResolveContext): Promise<UrlCompletion[] | null> {
		const handler = this.#handler(scheme.toLowerCase());
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
	 * dropping the selector would mutate a file the caller never named. Device-backed schemes
	 * (proc://, out://) refuse every selector: write approval judges the unpeeled URL, so
	 * peeling one would act on a handle the gate never judged. Non-URLs pass through.
	 */
	peelWriteSelector(input: string, tool: string): string {
		const { path, sel } = this.split(input);
		if (sel === undefined) return path;
		if (this.#registered(path)?.handler.spec.backing === "device") {
			throw new ToolError(`${tool} does not accept the trailing selector ":${sel}" on a device URL. Remove it.`);
		}
		if (WHOLE_FILE_SELECTOR_RE.test(sel)) return path;
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
		const registered = this.#handler(scheme);
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
	 * stores, so its resolve error diagnoses the miss (`Cannot find agent://x: Not found: x`);
	 * otherwise `Cannot ${action} ${scheme}:// URL: no local file backs ${input}`
	 * (+ a `read` hint for remote/virtual schemes).
	 */
	async requireLocal(
		input: string,
		action: string,
		context?: ResolveContext,
		options?: LocateOptions,
	): Promise<string> {
		const located = await this.locate(input, context, { ...options, localOnly: true });
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
	 * for `context` through {@link locateSync}; {@link assertProtocolHandlerSpec} requires such schemes to be linkable.
	 */
	sandboxRoots(context?: ResolveContext): string[] {
		const roots: string[] = [];
		for (const [scheme, handler] of this.#entries()) {
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
		for (const [scheme, handler] of this.#entries()) {
			const schemeTier = handler.spec.readTier ?? "read";
			if (TIER_RANK[schemeTier] <= TIER_RANK[tier]) continue;
			if (lower.includes(`${scheme}://`)) tier = schemeTier;
		}
		return tier;
	}

	/** Rendered promptDoc lines, registration order, for schemes available under `host`. */
	describe(host: SchemeHost): string[] {
		const lines: string[] = [];
		for (const [, handler] of this.#entries()) {
			const line = handler.promptDoc?.(host);
			if (line !== undefined) lines.push(line);
		}
		return lines;
	}

	/** Rendered promptReference entries, registration order: the body of `help://read/urls`. */
	reference(): string[] {
		const lines: string[] = [];
		for (const [, handler] of this.#entries()) {
			const line = handler.promptReference?.();
			if (line !== undefined) lines.push(line);
		}
		return lines;
	}

	/** Handler for a lowercase `scheme`: the first source that owns it, else the built-in. */
	#handler(scheme: string): ProtocolHandler | undefined {
		for (const source of this.#sources) {
			const handler = source.get(scheme);
			if (handler) return handler;
		}
		return this.#builtinHandlers.get(scheme);
	}

	/**
	 * Every scheme with the handler that serves it ({@link #handler}): built-ins in registration
	 * order, then the sources' own. A scheme several sources (or registrations of one source) name
	 * is listed once, with the handler that wins it, so metadata agrees with dispatch.
	 */
	*#entries(): Generator<[string, ProtocolHandler]> {
		for (const [scheme, handler] of this.#builtinHandlers) {
			if (this.#handler(scheme) === handler) yield [scheme, handler];
		}
		const listed = new Set<string>();
		for (const source of this.#sources) {
			for (const handler of source.handlers()) {
				const scheme = handler.scheme.toLowerCase();
				if (listed.has(scheme) || this.#handler(scheme) !== handler) continue;
				listed.add(scheme);
				yield [scheme, handler];
			}
		}
	}

	#isResourceFallbackScheme(scheme: string): boolean {
		return !["file", "http", "https"].includes(scheme) && this.#builtinHandlers.has(this.#resourceFallbackScheme);
	}

	#resourceFallbackHandler(scheme: string): ProtocolHandler | undefined {
		return this.#isResourceFallbackScheme(scheme)
			? this.#builtinHandlers.get(this.#resourceFallbackScheme)
			: undefined;
	}

	/** Normalized hierarchical URL of a registered scheme, with its handler; undefined otherwise. */
	#registered(input: string): RegisteredUrl | undefined {
		const url = this.normalize(input);
		const split = splitUrlScheme(url);
		const handler = split && this.#handler(split.scheme);
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
			this.#handler(scheme) ?? (allowResourceFallback ? this.#resourceFallbackHandler(scheme) : undefined);
		if (!handler) {
			const available = Array.from(this.#entries(), ([candidate]) => `${candidate}://`).join(", ");
			throw new Error(`Unknown protocol: ${scheme}://\nSupported: ${available || "none"}`);
		}
		return { parsed, handler };
	}

	/** Resolve an internal URL through its registered protocol handler. */
	async resolve(input: string, context?: ResolveContext): Promise<InternalResource<string | Buffer>> {
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
