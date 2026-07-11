/**
 * Types for the internal URL routing system.
 *
 * Internal URLs (`agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `omp://`, `pr://`, `rule://`, `skill://`, `ssh://`, and `vault://`) are resolved by tools like read,
 * providing access to agent outputs and server resources without exposing filesystem paths.
 */

import type { Skill } from "../extensibility/skills";
import type { LocalProtocolOptions } from "./local-protocol";

/**
 * Raw resource payload returned by protocol handlers. The `immutable` flag is
 * applied by the router from {@link ProtocolHandler.immutable}, so handlers do
 * not need to set it themselves.
 */
export interface InternalResource {
	/** Canonical URL that was resolved */
	url: string;
	/** Resolved text content */
	content: string;
	/** MIME type: text/markdown, application/json, or text/plain */
	contentType: "text/markdown" | "application/json" | "text/plain";
	/** Content size in bytes */
	size?: number;
	/** Underlying filesystem path (for debugging, not exposed to agent) */
	sourcePath?: string;
	/** Additional notes about resolution */
	notes?: string[];
	/**
	 * True when the resolved content cannot be edited by the agent (e.g. sealed
	 * artifacts, harness docs, machine-generated memory summaries). Hashline
	 * anchors and similar edit affordances are suppressed for immutable
	 * resources. Mutable resources (e.g. local://) behave like editable files.
	 */
	immutable?: boolean;
	/**
	 * True when the resource is a directory listing rather than file content.
	 * `search` refuses to grep such a resource when it has no `sourcePath` — a
	 * remote `ssh://` listing has no local path to recurse, so its listing text
	 * must never be mistaken for the directory's contents.
	 */
	isDirectory?: boolean;
}

/**
 * A single autocomplete candidate for the host/path portion of a `scheme://`
 * URL, produced by {@link ProtocolHandler.complete}.
 */
export interface UrlCompletion {
	/**
	 * The text that follows `scheme://` for this candidate (e.g. `humanizer`,
	 * `subdir/data.json`, `root`). The caller renders it as `scheme://<value>`.
	 */
	value: string;
	/** Human-facing label for the dropdown. Defaults to {@link value}. */
	label?: string;
	/** Optional one-line description shown beside the candidate. */
	description?: string;
}

/**
 * Parsed internal URL with preserved host casing.
 */
export interface InternalUrl extends URL {
	/**
	 * Raw host segment extracted from input, preserving case.
	 */
	rawHost: string;
	/**
	 * Raw pathname extracted from input, preserving traversal markers before URL normalization.
	 */
	rawPathname?: string;
}

/**
 * Caller-supplied context that the router threads into protocol handlers.
 *
 * Read tool calls `InternalUrlRouter.resolve(url, { cwd, settings, signal })`
 * so handlers can resolve relative defaults (e.g. `issue://N` → which repo?)
 * against the actual session that initiated the read, not whichever session
 * happens to be registered first in the global `AgentRegistry`.
 */
export interface ResolveContext {
	/** Working directory of the calling session. */
	cwd?: string;
	/** Settings of the calling session (used by `issue://`/`pr://` for cache TTLs). */
	settings?: unknown;
	/** Caller's abort signal. */
	signal?: AbortSignal;
	/**
	 * Calling session's `local://` root mapping. When present, the local-protocol
	 * handler resolves the URL against THIS session's artifacts dir instead of
	 * picking the first `main`-kind session from the global `AgentRegistry`.
	 *
	 * Required for correctness in multi-session hosts (cmux/ACP, embedded SDK
	 * consumers) where multiple sessions are registered as `main` and the
	 * "first one wins" lookup picks the wrong artifacts directory — see
	 * [#1608](https://github.com/can1357/oh-my-pi/issues/1608).
	 */
	localProtocolOptions?: LocalProtocolOptions;
	/** Calling session's loaded skills. Prefer this over process-global skill state. */
	skills?: readonly Skill[];
	/**
	 * When set, handlers that would otherwise materialize an expensive directory
	 * listing (e.g. the ssh:// handler draining a full remote `ls`) instead return
	 * the directory shape (`isDirectory: true`) with empty content. `search`/`find`
	 * reject directory resources, so they never need the listing.
	 */
	skipDirectoryListing?: boolean;
}

/**
 * Caller context for write operations dispatched to host-owned URI handlers.
 * Mirrors {@link ResolveContext} so handlers that share read/write state can
 * accept the same shape.
 */
export interface WriteContext {
	/** Working directory of the calling session. */
	cwd?: string;
	/** Caller's abort signal. */
	signal?: AbortSignal;
	/** Calling session's `local://` root mapping — see {@link ResolveContext.localProtocolOptions}. */
	localProtocolOptions?: LocalProtocolOptions;
}

/**
 * Handler for a specific internal URL scheme (e.g., agent://, memory://, skill://, mcp://).
 */
export interface ProtocolHandler {
	/** The scheme this handler processes (without trailing ://) */
	readonly scheme: string;
	/**
	 * Whether resources produced by this handler are immutable (cannot be
	 * edited by the agent). When true, callers suppress hashline anchors and
	 * other edit affordances. When false, resources behave like editable files.
	 */
	readonly immutable: boolean;
	/**
	 * Resolve an internal URL to its content. The router stamps the
	 * {@link InternalResource.immutable} flag from {@link ProtocolHandler.immutable}.
	 *
	 * @param url Parsed URL object
	 * @param context Optional caller context. Handlers that depend on caller
	 *   identity (working directory, settings) **MUST** consume this in
	 *   preference to global state.
	 * @throws Error with user-friendly message if resolution fails
	 */
	resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource>;
	/**
	 * Optional write hook. When present, the write tool dispatches
	 * `write(url, content)` to this handler instead of writing to a filesystem
	 * path. The handler is responsible for any persistence and validation.
	 *
	 * Handlers that omit this method are treated as read-only; the write tool
	 * surfaces a clear "not writable" error when invoked against them.
	 */
	write?(url: InternalUrl, content: string, context?: WriteContext): Promise<void>;
	/**
	 * Optional autocomplete hook. Returns candidate completions for the
	 * host/path portion of a `scheme://` URL while the user composes a prompt.
	 *
	 * Implementations **MUST** be fast and local — this runs on every keystroke.
	 * Schemes backed by network or external CLIs (issue://, pr://, vault://,
	 * mcp://) omit it. The caller fuzzy-filters the returned set against the
	 * partially typed `query`, so handlers return their full (bounded) candidate
	 * list; `query` is provided only so handlers can scope expensive enumeration.
	 * `context.cwd`/`context.localProtocolOptions` carry the caller's working dir
	 * and session, for handlers whose candidates are project- or session-scoped
	 * (e.g. ssh:// hosts from a project `ssh.json`, local:// roots per session).
	 */
	complete?(query?: string, context?: ResolveContext): Promise<UrlCompletion[]>;
}
