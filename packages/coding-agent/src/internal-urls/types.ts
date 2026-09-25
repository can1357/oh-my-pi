/**
 * Types for the internal URL routing system.
 *
 * Every scheme is a {@link ProtocolHandler} registered with the router. Its
 * {@link SchemeSpec} declares how tools may consume it (backing, selectors,
 * write policy), so tools consult the router instead of branching on scheme
 * names, and the system prompt lists schemes from {@link ProtocolHandler.promptDoc}.
 */

import type {
	AgentToolContext,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import type { Rule } from "../capability/rule";
import type { Skill } from "../extensibility/skills";
import type { AgentRegistry } from "../registry/agent-registry";
import type { LocalProtocolOptions } from "./local-protocol";
import type { SessionEntry } from "../session/session-entries";
import type { ToolSession } from "../tools";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import type { ProcReadDetails, ProcWriteDetails } from "@oh-my-pi/pi-tui/tools/proc-render";
import type { CfgReadDetails, CfgWriteDetails } from "@oh-my-pi/pi-tui/tools/cfg-render";
import type { XdevRenderDispatch } from "@oh-my-pi/pi-tui/tools/xdev";

/** Transcript-only render state a handler write attaches to the `write` tool result. */
export interface InternalWriteDetails {
	message?: CoordinationDetails;
	proc?: ProcWriteDetails;
	cfg?: CfgWriteDetails;
	xdev?: XdevRenderDispatch;
	/** Absolute file the write landed in, for the transcript card's file link (conflict://). */
	resolvedPath?: string;
}

/**
 * Model-facing result of a handler-owned write. Replaces the `write` tool's
 * default "Successfully wrote N bytes" result verbatim.
 */
export interface InternalWriteResult {
	content: Array<TextContent | ImageContent>;
	details?: InternalWriteDetails;
	isError?: boolean;
	useless?: boolean;
}

/**
 * How a scheme's resources exist.
 * - `file`: resolved content is the byte-identical content of the file {@link ProtocolHandler.locate}
 *   returns; `read` routes located URLs through its filesystem pipeline (paging, images, sqlite, archives).
 * - `virtual`: content is rendered by the handler (it may still `locate` a backing file for search/bash).
 * - `remote`: content lives on another host or service; never locatable.
 * - `device`: session-bound control surface (processes, tool devices).
 */
export type SchemeBacking = "file" | "virtual" | "remote" | "device";

/**
 * Read-selector grammar after the URL.
 * - `lines`: any trailing `:<selector>` chain is a read selector (`artifact://3:raw:1-50`).
 * - `none`: never peel; the URL is passed through as written.
 * - `opaque`: server-defined URIs that may legitimately end in selector-shaped tails (mcp://).
 */
export type SchemeSelectors = "lines" | "none" | "opaque";

/**
 * Mutation class of a writable scheme; drives plan-mode and device-only `write` gates.
 * - `workspace`: mutates user/external state; blocked in plan mode and device-only sessions.
 * - `sandbox`: session scratch space (local://); allowed in plan mode, and in device-only sessions while plan mode is active.
 * - `coordination`: peer messaging (agent://); always allowed.
 * - `device`: tool-device dispatch (xd://); always allowed, the device enforces its own policy.
 */
export type SchemeWriteScope = "workspace" | "sandbox" | "coordination" | "device";

/** Write policy for a writable scheme. Absent on read-only schemes. */
export interface SchemeWritePolicy {
	/**
	 * Who performs the write.
	 * - `file`: tools (`write`, `edit`, `ast_edit`) write the file {@link ProtocolHandler.locate}
	 *   returns with `{ create: true }`; the handler has no `write` hook.
	 * - `handler`: {@link ProtocolHandler.write} performs it (messages, stdin, settings, remote
	 *   hosts, devices); file-editing tools refuse the URL even when it locates a backing file.
	 */
	via: "file" | "handler";
	/**
	 * `text`: model-authored text; `write` strips copied hashline display prefixes and, unless the
	 * scheme is a `device`, rejects content that ends with a read-truncation notice.
	 * `verbatim`: raw payload (messages, stdin, setting values); neither transform applies.
	 */
	payload: "text" | "verbatim";
	scope: SchemeWriteScope;
	/** Approval tier for `write`/`edit`/`ast_edit` targeting this URL. `session` is absent when approval is evaluated outside a tool session. */
	tier(url: InternalUrl, content: string | undefined, session: ToolSession | undefined): ToolApprovalDecision;
	/** True when `write` may omit `content` for this URL (`proc://<id>/kill`). */
	contentOptional?(url: InternalUrl): boolean;
}

/**
 * Declared facts about a scheme. Consumed by tools (routing, approval, gates),
 * the TUI (selector peeling, transcript cards), and renderers (hyperlinks).
 */
export interface SchemeSpec {
	backing: SchemeBacking;
	selectors: SchemeSelectors;
	/** A trailing `:N` with no path after the authority is a port, not a selector (ssh://host:2222). */
	portAuthority?: boolean;
	/** The authority is the first path segment under one root (local://a/b), so a glob may start there; other schemes' authority is an id. */
	pathAuthority?: true;
	/** Default immutability of resolved resources; a resource may override it per URL. */
	immutable: boolean;
	/** Resources are session artifact storage (artifact://); located read pages skip the artifact spill. */
	artifactStore?: true;
	/** Approval tier for reading/searching this scheme. Default `read`; ssh:// is `exec`. */
	readTier?: ToolTier;
	/** Read output bypasses result truncation limits (skill:// instructions). */
	unbounded?: boolean;
	/** Renderers may call `locate` to hyperlink these URLs: locate is local, cheap, never spawns or fetches. */
	linkable?: boolean;
	/** Transcript read cards collapse like plain files instead of expanding (xd://). */
	compactTranscript?: boolean;
	/** `read` peels a trailing `?q=<question>` as an image question (local://, attachment://); other schemes own their query. */
	imageQuestion?: true;
	/** `bash` expands unquoted/quoted URLs of this scheme to their located file paths. */
	shellOperand?: true;
	/** The single-slash `scheme:/x` spelling is an alias of `scheme://x` (local:/). */
	singleSlashAlias?: true;
	write?: SchemeWritePolicy;
}

/** Options for {@link ProtocolHandler.locate}. */
export interface LocateOptions {
	/** Locate the containing directory form where a scheme distinguishes it (skill://<name> → skill base dir, not SKILL.md). */
	directory?: boolean;
	/** Return the path even when the entry does not exist yet (write/bash targets). Never creates anything. */
	create?: boolean;
}

/**
 * Session facts that decide which schemes the system prompt advertises.
 * Built once per prompt build; handlers read only these fields plus cheap
 * process facts (binary presence) in {@link ProtocolHandler.promptDoc}.
 */
export interface SchemeHost {
	/** Loaded skills are readable through an active tool. */
	skillUriAccess: boolean;
	/** Number of rulebook rules addressable through rule://. */
	ruleCount: number;
	/** Active `memory.backend` id; undefined when memory is off. */
	memoryBackend?: string;
	securityEnabled: boolean;
	/** The user approves `cfg://` writes for this session (top-level TUI session). */
	settingsApproval: boolean;
}

/**
 * Raw resource payload returned by protocol handlers. The router defaults
 * `immutable` from {@link SchemeSpec.immutable}, so handlers set it only to
 * override the scheme default for a specific URL.
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
	/** Structured snapshots used only for transcript rendering. */
	details?: {
		proc?: ProcReadDetails;
		cfg?: CfgReadDetails;
		/** Prefix-free text + gutter start for the TUI read card when `content` carries hashline/line prefixes (conflict://). */
		display?: { text: string; startLine: number; lineNumbers?: Array<number | null> };
	};
	/**
	 * `value` marks a discrete extracted value (agent://<id>/<json-path>) that
	 * `read` returns as-is: no line selectors, no paging.
	 * Default `document`.
	 */
	shape?: "document" | "value";
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
	/**
	 * Exact input string this URL was parsed from, before any normalization.
	 * Set by `parseInternalUrl`; used where byte-exact URI matching matters
	 * (e.g. MCP resource URIs compared by string equality).
	 */
	rawHref?: string;
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
	/**
	 * Calling session's session file. Handlers that resolve agent ids which may
	 * be parked (`history://<id>`, `agent://<id>`) refresh the caller's
	 * persisted roster against this root before registry lookup, so a
	 * same-named id restored by another root's scan never shadows this
	 * caller's own transcript or output. Absent when the caller has no session
	 * file: those handlers keep their existing in-memory behavior.
	 */
	sessionFile?: string;
	/**
	 * Calling session's stable session-manager id. Sessions that have no
	 * session file yet (SDK, embedded, `-p`) are only addressable by this id,
	 * so handlers that must bind a URL to its caller (`memory://`) accept it
	 * as a second exact identity alongside {@link sessionFile}.
	 */
	sessionId?: string;
	/** Registry that owns the calling session; defaults to the process-wide registry. */
	agentRegistry?: AgentRegistry;
	/** Settings of the calling session (used by `issue://`/`pr://` for cache TTLs). */
	settings?: Settings;
	/** Caller's abort signal. */
	signal?: AbortSignal;
	/**
	 * Whether experimental context-management resources are enabled for this
	 * caller. This is passed explicitly so resource resolution cannot infer a
	 * feature gate from process-global settings.
	 */
	experimentalContextManagement?: boolean;
	/**
	 * Current live branch owned by the caller's session. `history://current/full`
	 * uses only this callback; it never falls back to a registry entry, session
	 * file, or on-disk transcript.
	 */
	getSessionBranch?: () => readonly SessionEntry[];
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
	 * Calling session's agent-scoped applicable rule set (rulebook + always-apply
	 * + triggered TTSR rules, already bucketed by `agents` frontmatter). Prefer
	 * this over the process-global snapshot — the global one reflects only the
	 * top-level session, so a subagent-only rule is unresolvable through it
	 * even though the subagent's own system prompt tells it to read
	 * `rule://<name>`.
	 */
	rules?: readonly Rule[];
	/**
	 * Calling tool session. Session-bound schemes (`proc://`, `xd://`) require it
	 * and throw when it is absent.
	 */
	session?: ToolSession;
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
	/**
	 * Calling tool session. Session-bound writes (`agent://` messages,
	 * `proc://` stdin/stop/mode, `xd://` devices) require it and throw when it is absent.
	 */
	session?: ToolSession;
	/** The `write` tool call dispatching this write; device dispatch (`xd://`) forwards it to the wrapped tool. */
	toolCall?: {
		id: string;
		onUpdate?: AgentToolUpdateCallback;
		context?: AgentToolContext;
	};
}

/**
 * Handler for a specific internal URL scheme (e.g., agent://, memory://, skill://, xd://).
 */
export interface ProtocolHandler {
	/** The scheme this handler processes (without trailing ://) */
	readonly scheme: string;
	/** Declared consumption contract; see {@link SchemeSpec}. */
	readonly spec: SchemeSpec;
	/**
	 * Resolve an internal URL to its content. The router defaults
	 * {@link InternalResource.immutable} from {@link SchemeSpec.immutable}.
	 *
	 * @param url Parsed URL object
	 * @param context Optional caller context. Handlers that depend on caller
	 *   identity (working directory, settings) **MUST** consume this in
	 *   preference to global state.
	 * @throws Error with user-friendly message if resolution fails
	 */
	resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource>;
	/**
	 * Handler-owned write hook: present exactly when `spec.write.via` is
	 * `"handler"` (the router enforces this at registration). The write tool
	 * dispatches `write(url, content)` here instead of writing a filesystem
	 * path; the handler owns persistence and validation.
	 *
	 * A returned result replaces the write tool's default "Successfully wrote
	 * N bytes" result and may carry transcript-only display details.
	 */
	write?(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult | void>;
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
	/**
	 * Absolute path of the local file or directory backing `url`, without
	 * materializing content. Returns `null` when the URL has no local backing
	 * (virtual/remote target, extraction URL, or a missing entry without
	 * {@link LocateOptions.create}). Throws on malformed URLs and containment
	 * violations with the same messages `resolve` uses. Never touches the
	 * network; may run a local discovery CLI once (vault:// root lookup), so
	 * renderers only locate {@link SchemeSpec.linkable} schemes.
	 */
	locate?(url: InternalUrl, context?: ResolveContext, options?: LocateOptions): Promise<string | null>;
	/**
	 * Synchronous {@link locate} for renderers that cannot await (OSC 8 links
	 * while a tool call streams). Returns `undefined` when not resolvable
	 * synchronously; never throws.
	 */
	locateSync?(url: InternalUrl, context?: ResolveContext): string | undefined;
	/**
	 * Expand a virtual container URL (e.g. `omp://`) into its searchable
	 * leaf documents for `grep`/`find`. Leaf `url`s must round-trip through `resolve`.
	 */
	enumerate?(url: InternalUrl, context?: ResolveContext): Promise<Array<{ url: string; content: string }>>;
	/**
	 * One-line system-prompt entry (rendered from `prompts/internal-urls/<scheme>.md`)
	 * when the scheme is usable in the session described by `host`; `undefined`
	 * omits the scheme. Schemes documented only by the tool that emits their URLs
	 * (conflict://, attachment://) omit this method.
	 */
	promptDoc?(host: SchemeHost): string | undefined;
}
