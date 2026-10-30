/**
 * Shell filesystem backed by the internal URL router.
 *
 * The embedded shell (redirections, globs, `cd`, builtins, and the in-process
 * coreutils) routes every `scheme://…` path here at operation time; host paths
 * never leave the native filesystem. File-backed schemes locate their backing
 * entry per operation and hand it back as a native redirect, so handle I/O,
 * links, and metadata are the host filesystem's own. Other schemes are
 * read-only files holding their rendered resource bytes (or directories, for
 * enumerable containers). Writes reach only mutable file-written schemes
 * (`local://`), within the tier the command was approved at, and reply schemes
 * (`out://`), whose write-only handles hand their text to the run's reply sink
 * on close; other handler-owned writes (messages, process stdin, devices) stay
 * with the `write` tool.
 *
 * Node types never depend on the operation: a bare `skill://<name>` is the
 * skill directory everywhere (its instructions are `skill://<name>/SKILL.md`),
 * and a symlink whose target is a URL is followed through this filesystem
 * while `readlink` keeps its literal spelling.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import {
	type ShellFilesystem,
	ShellFsFileType,
	type ShellFsMetadata,
	ShellFsMissing,
	ShellFsOp,
	type ShellFsRequest,
	ShellFsResolve,
	type ShellFsResponse,
} from "@oh-my-pi/pi-natives";
import { isFsError } from "@oh-my-pi/pi-utils";
import { TIER_RANK } from "../tools/approval";
import { UrlContainmentError } from "./filesystem-resource";
import { parseInternalUrl } from "./parse";
import { InternalUrlRouter } from "./router";
import type { InternalResource, ProtocolHandler, ResolveContext, SchemeSpec } from "./types";

const URL_PATH_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;
/** Symlink hops before ELOOP (Linux MAXSYMLINKS). */
const MAX_SYMLINK_HOPS = 40;
const VIRTUAL_FILE_MODE = 0o444;
const VIRTUAL_DIR_MODE = 0o555;
const REPLY_FILE_MODE = 0o222;
const ERRNO_CODE_RE = /^E[A-Z0-9]+$/;
const DENIED_MESSAGE_RE = /\b(?:not allowed|escapes|outside)\b/i;
const INVALID_MESSAGE_RE = /\b(?:requires? an?|invalid|malformed)\b/i;
const MISSING_MESSAGE_RE = /\b(?:not found|unknown|does not exist|no such|unavailable)\b/i;

/** Whether `input` is spelled `scheme://…`: the only form the shell filesystem hands to URL handlers. */
export function isUrlPath(input: string): boolean {
	return URL_PATH_RE.test(input);
}

/** A filesystem failure carrying the errno name the shell reports. */
export class UrlFsError extends Error {
	override name = "UrlFsError";

	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** A URL split at its mount root; remote paths keep their server-side path semantics. */
interface UrlPath {
	scheme: string;
	/** `scheme://` when the authority is a path segment (local://), else `scheme://<authority>`. */
	root: string;
	/** Raw (percent-encoded) segments below the root. */
	segments: string[];
}

function parseUrlPath(input: string, spec: SchemeSpec): UrlPath {
	const match = URL_PATH_RE.exec(input);
	if (!match) throw new UrlFsError("EINVAL", `Not a URL path: ${input}`);
	const scheme = match[1].toLowerCase();
	if (spec.backing === "remote" && !spec.pathAuthority) {
		// Remote .. may cross a symlink or the /~/ account-home boundary. It
		// cannot be collapsed locally, and must never pop the URL authority.
		const [authority, ...segments] = match[2].split("/");
		return { scheme, root: `${scheme}://${authority}`, segments };
	}
	// The authority takes part in `..` resolution: `skill://a/..` is `skill://`.
	const segments: string[] = [];
	for (const part of match[2].split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") segments.pop();
		else segments.push(part);
	}
	if (spec.pathAuthority) return { scheme, root: `${scheme}://`, segments };
	return { scheme, root: `${scheme}://${segments[0] ?? ""}`, segments: segments.slice(1) };
}

/** `url` followed by `segments`, without doubling the slash after a bare `scheme://`. */
function appendSegments(url: string, segments: readonly string[]): string {
	if (segments.length === 0) return url;
	const trimmed = url.replace(/\/+$/, "");
	// Trimming `scheme://` leaves `scheme:`; its segments follow the `//` directly.
	return trimmed.endsWith(":") ? `${trimmed}//${segments.join("/")}` : `${trimmed}/${segments.join("/")}`;
}

function formatUrlPath(target: UrlPath): string {
	return appendSegments(target.root, target.segments);
}

/** Entry name a raw segment addresses, decoded the way the scheme handlers decode it. */
function decodeSegment(segment: string): string {
	let name: string;
	try {
		name = decodeURIComponent(segment);
	} catch {
		throw new UrlFsError("EINVAL", `Malformed percent-encoding in path segment: ${segment}`);
	}
	if (name.includes("/") || name === "." || name === "..") {
		throw new UrlFsError("EINVAL", `Path segment does not name a single entry: ${segment}`);
	}
	return name;
}

/**
 * Characters a raw entry name must percent-encode inside a URL segment: WHATWG
 * `new URL` strips tabs/newlines and splits on `?`/`#`, and local:// / vault://
 * read a raw `\` as `/`. Mirrors the kernel's child-URL encoder.
 */
const SEGMENT_ENCODE_RE = /[\x00-\x20\x7f"#%<>?[\\\]^`{|}]/g;

/** Raw segment for an entry name; {@link decodeSegment} recovers it exactly. */
function encodeSegment(name: string): string {
	return name.replace(SEGMENT_ENCODE_RE, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * `base` URL followed by a `/`-separated path of raw entry names (a native
 * walk's root-relative result), each name percent-encoded as `pi_vfs::child_path` does.
 */
export function joinUrlPath(base: string, relative: string): string {
	return appendSegments(
		base,
		relative
			.split("/")
			.filter(name => name.length > 0)
			.map(encodeSegment),
	);
}

function schemeOf(url: string): string {
	return URL_PATH_RE.exec(url)?.[1].toLowerCase() ?? url;
}

/** Host path outside every URL namespace (two-path ops may pair one with a URL). */
interface NativeNode {
	kind: "native";
	path: string;
}

/** File-backed URL entry the native filesystem serves at `path`; it may not exist yet (creation). */
interface HostNode {
	kind: "host";
	url: string;
	spec: SchemeSpec;
	path: string;
}

/** Rendered resource: read-only file bytes, or a directory. */
interface VirtualNode {
	kind: "virtual";
	url: string;
	spec: SchemeSpec;
	directory: boolean;
	bytes: Uint8Array;
	/** Children of an enumerable container. */
	entries?: ReadonlyMap<string, ShellFsFileType>;
	/** Host directory a directory resource lists. */
	sourcePath?: string;
}

type FsNode = NativeNode | HostNode | VirtualNode;

/** Write-only handle on a reply URL (`out://`): bytes buffer until close, then reach the run's reply sink. */
interface ReplySink {
	kind: "reply";
	url: string;
	chunks: Uint8Array[];
	size: number;
	/** The scheme's `write.maxBytes`; writes past it fail with EFBIG and discard the reply. */
	maxBytes: number;
	overflowed: boolean;
}

/** Handler and spec serving a URL's scheme (the MCP resource fallback has no handler of its own). */
interface Route {
	handler: ProtocolHandler | undefined;
	spec: SchemeSpec;
}

type OpenRequest = NonNullable<ShellFsRequest["open"]>;
type AccessRequest = NonNullable<ShellFsRequest["access"]>;

/** Provider-owned metadata of a rendered resource: its byte size and declared read-only mode; no host identity or times. */
function virtualMetadata(node: VirtualNode): ShellFsMetadata {
	return node.directory
		? { fileType: ShellFsFileType.Dir, size: 0, mode: VIRTUAL_DIR_MODE }
		: { fileType: ShellFsFileType.File, size: node.bytes.length, mode: VIRTUAL_FILE_MODE };
}

/** Immediate children of `url` among enumerated leaf URLs: leaves are files, deeper prefixes directories. */
function childEntries(leaves: Iterable<string>, url: string): Map<string, ShellFsFileType> {
	const prefix = url.endsWith("://") ? url : `${url}/`;
	const entries = new Map<string, ShellFsFileType>();
	for (const leaf of leaves) {
		if (!leaf.startsWith(prefix)) continue;
		const rest = leaf.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash === -1) {
			if (rest) entries.set(decodeSegment(rest), ShellFsFileType.File);
		} else {
			entries.set(decodeSegment(rest.slice(0, slash)), ShellFsFileType.Dir);
		}
	}
	return entries;
}

async function isHostDirectory(hostPath: string): Promise<boolean> {
	try {
		return (await fs.stat(hostPath)).isDirectory();
	} catch {
		return false;
	}
}

function requireField<T>(value: T | undefined | null, field: string, op: ShellFsOp): T {
	if (value === undefined || value === null) throw new UrlFsError("EINVAL", `${op} request is missing ${field}`);
	return value;
}

/** What {@link InternalUrlFilesystem.stat} reports about an entry. */
export interface UrlFileStat {
	type: "directory" | "file" | "other";
	/** Bytes of a file; 0 for directories. */
	size: number;
	/** Host modification time; 0 for rendered resources, which have none. */
	mtimeMs: number;
}

export interface InternalUrlFilesystemOptions {
	/** Calling session's resolve context; its signal cancels in-flight operations. */
	context: ResolveContext;
	/** Approval tier the shell command ran under; schemes whose read or write tier exceeds it are refused. */
	tier: ToolTier;
	/**
	 * Receives the text a command wrote to a reply URL (`out://`) once its handle closes, after
	 * the scheme's handler accepted it. Absent: reply URLs refuse writes (EROFS).
	 */
	onReply?: (text: string) => void;
}

/**
 * Session-bound filesystem for URL paths in one embedded-shell run. Construct one
 * per run with that run's own abort signal; handles opened through it live until
 * the shell closes them.
 */
export class InternalUrlFilesystem {
	readonly #router: InternalUrlRouter;
	readonly #context: ResolveContext;
	readonly #tier: ToolTier;
	readonly #onReply: ((text: string) => void) | undefined;
	readonly #handles = new Map<number, VirtualNode | ReplySink>();
	#nextHandle = 1;
	/** Sandbox schemes whose session root this run has already created. */
	readonly #sandboxRoots = new Set<string>();
	/** Enumerated leaf URLs → content, per enumerable scheme. */
	readonly #leaves = new Map<string, Promise<Map<string, string>>>();
	/** Same session and policy without the run's signal, for cleanup the shell performs after a cancel. */
	#cleanupFs: InternalUrlFilesystem | undefined;

	constructor(options: InternalUrlFilesystemOptions) {
		this.#router = InternalUrlRouter.instance();
		// Directory nodes never serve their rendered listing, so handlers skip building it.
		this.#context = { ...options.context, skipDirectoryListing: true };
		this.#tier = options.tier;
		this.#onReply = options.onReply;
	}

	/** Native shell binding: URL paths reach {@link handle}; host paths stay on the native filesystem. */
	shellFilesystem(): ShellFilesystem {
		return {
			handler: (error, request) =>
				error ? Promise.resolve({ error: { code: "EIO", message: error.message } }) : this.handle(request),
			nativeLocalPaths: true,
		};
	}

	/** Serve one shell filesystem request; failures come back as errno data. */
	async handle(request: ShellFsRequest): Promise<ShellFsResponse> {
		// Cleanup of the shell's own temporaries must finish even after the run is cancelled.
		// Every request of the cleanup view carries the flag (closes of its handles included),
		// so its handles live and die in the cleanup instance.
		if (request.cleanup === true && this.#context.signal) {
			this.#cleanupFs ??= new InternalUrlFilesystem({
				context: { ...this.#context, signal: undefined },
				tier: this.#tier,
			});
			return this.#cleanupFs.handle(request);
		}
		try {
			return await this.#dispatch(request);
		} catch (error) {
			return { error: this.#errno(error) };
		}
	}

	/** The entry `input` (a URL or host path) names, following symlinks; throws {@link UrlFsError}. */
	async stat(input: string): Promise<UrlFileStat> {
		try {
			const node = await this.#node(input, true, false);
			if (node.kind === "virtual") {
				return node.directory
					? { type: "directory", size: 0, mtimeMs: 0 }
					: { type: "file", size: node.bytes.length, mtimeMs: 0 };
			}
			const stats = await fs.stat(node.path);
			return {
				type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
				size: stats.size,
				mtimeMs: stats.mtimeMs,
			};
		} catch (error) {
			const { code, message } = this.#errno(error);
			throw new UrlFsError(code, message);
		}
	}

	/** First `maxBytes` bytes of the file `input` (a URL or host path) names, following symlinks; throws {@link UrlFsError}. */
	async readPrefix(input: string, maxBytes: number): Promise<Uint8Array> {
		try {
			const node = await this.#node(input, true, false);
			if (node.kind !== "virtual") return await Bun.file(node.path).slice(0, maxBytes).bytes();
			if (node.directory) throw new UrlFsError("EISDIR", `Is a directory: ${node.url}`);
			return node.bytes.subarray(0, maxBytes);
		} catch (error) {
			const { code, message } = this.#errno(error);
			throw new UrlFsError(code, message);
		}
	}

	async #dispatch(request: ShellFsRequest): Promise<ShellFsResponse> {
		const { op } = request;
		// Handles are released even after the run is cancelled.
		if (op === ShellFsOp.Close) {
			const handle = requireField(request.handle, "handle", op);
			const file = this.#handles.get(handle);
			if (!file) throw new UrlFsError("EBADF", `Bad file handle: ${handle}`);
			this.#handles.delete(handle);
			if (file.kind === "reply") await this.#deliverReply(file);
			return {};
		}
		this.#throwIfAborted();
		switch (op) {
			case ShellFsOp.Metadata:
			case ShellFsOp.SymlinkMetadata: {
				const node = await this.#node(requireField(request.path, "path", op), op === ShellFsOp.Metadata, false);
				return node.kind === "virtual" ? { metadata: virtualMetadata(node) } : { local: node.path };
			}
			case ShellFsOp.ReadDir:
				return this.#readDir(requireField(request.path, "path", op));
			case ShellFsOp.Canonicalize:
				return {
					path: await this.#canonicalize(
						requireField(request.path, "path", op),
						request.missing ?? ShellFsMissing.Existing,
						request.resolve ?? ShellFsResolve.Physical,
					),
				};
			case ShellFsOp.BackingPath: {
				const backing = await this.#backingPath(requireField(request.path, "path", op));
				return backing === undefined ? {} : { path: backing };
			}
			case ShellFsOp.ReadLink: {
				const node = await this.#node(requireField(request.path, "path", op), false, false);
				if (node.kind !== "virtual") return { local: node.path };
				throw new UrlFsError("EINVAL", `Not a symbolic link: ${node.url}`);
			}
			case ShellFsOp.Access:
				return this.#access(requireField(request.path, "path", op), requireField(request.access, "access", op));
			case ShellFsOp.Open:
				return this.#open(requireField(request.path, "path", op), requireField(request.open, "open", op));
			case ShellFsOp.Read: {
				const file = this.#handle(request.handle);
				if (file.kind === "reply") throw new UrlFsError("EBADF", `File is not open for reading: ${file.url}`);
				const start = Number(requireField(request.offset, "offset", op));
				const end = Math.min(file.bytes.length, start + requireField(request.length, "length", op));
				return { data: start >= end ? new Uint8Array() : file.bytes.subarray(start, end) };
			}
			case ShellFsOp.Write: {
				const file = this.#handle(request.handle);
				if (file.kind !== "reply") throw new UrlFsError("EBADF", "File is not open for writing");
				const data = requireField(request.data, "data", op);
				if (file.overflowed || file.size + data.length > file.maxBytes) {
					// A truncated reply would read as complete; nothing of it reaches the user.
					file.overflowed = true;
					file.chunks = [];
					throw new UrlFsError("EFBIG", `${schemeOf(file.url)}:// replies are capped at ${file.maxBytes} bytes`);
				}
				// The native side may reuse its buffer once the write is acknowledged.
				file.chunks.push(Uint8Array.from(data));
				file.size += data.length;
				return { written: data.length, offset: file.size };
			}
			case ShellFsOp.Flush:
			case ShellFsOp.Sync:
				this.#handle(request.handle);
				return {};
			case ShellFsOp.FileMetadata: {
				const file = this.#handle(request.handle);
				if (file.kind === "reply") {
					return { metadata: { fileType: ShellFsFileType.File, size: file.size, mode: REPLY_FILE_MODE } };
				}
				return { metadata: virtualMetadata(file) };
			}
			case ShellFsOp.IsLocked:
				this.#handle(request.handle);
				throw new UrlFsError("ENOTSUP", "Rendered resources do not expose advisory locks");
			case ShellFsOp.SetLen:
			case ShellFsOp.FileSetTimes:
			case ShellFsOp.FileSetPermissions: {
				const file = this.#handle(request.handle);
				if (file.kind === "reply") throw new UrlFsError("EINVAL", `Reply handles only append: ${file.url}`);
				throw this.#readOnly(file);
			}
			case ShellFsOp.CreateDir: {
				// mkdir never follows its final component; `-p` creates missing parents inside the root.
				const node = await this.#node(requireField(request.path, "path", op), request.recursive === true, true);
				return { local: this.#writablePath(node) };
			}
			case ShellFsOp.RemoveFile:
			case ShellFsOp.RemoveDir:
			case ShellFsOp.RemoveDirAll:
			case ShellFsOp.Symlink:
			case ShellFsOp.Mknod: {
				const create = op === ShellFsOp.Symlink || op === ShellFsOp.Mknod;
				const node = await this.#node(requireField(request.path, "path", op), false, create);
				return { local: this.#writablePath(node) };
			}
			case ShellFsOp.Rename:
			case ShellFsOp.HardLink: {
				const from = await this.#node(requireField(request.path, "path", op), false, false);
				const to = await this.#node(requireField(request.target, "target", op), false, true);
				if (op === ShellFsOp.Rename) this.#writablePath(from);
				const localTarget = this.#writablePath(to);
				// Each scheme is its own filesystem: links and renames never cross into or out of it.
				const fromMount = from.kind === "native" ? "" : schemeOf(from.url);
				if (fromMount !== (to.kind === "native" ? "" : schemeOf(to.url))) {
					throw new UrlFsError("EXDEV", `Cannot ${op === ShellFsOp.Rename ? "move" : "link"} across filesystems`);
				}
				if (from.kind === "virtual") throw this.#readOnly(from);
				return { local: from.path, localTarget };
			}
			case ShellFsOp.SetPermissions:
			case ShellFsOp.SetTimes:
			case ShellFsOp.Chown:
			case ShellFsOp.SetXattr:
			case ShellFsOp.RemoveXattr: {
				const follow = op === ShellFsOp.SetPermissions || request.follow !== false;
				const node = await this.#node(requireField(request.path, "path", op), follow, false);
				return { local: this.#writablePath(node) };
			}
			case ShellFsOp.StatFs:
			case ShellFsOp.GetXattr:
			case ShellFsOp.ListXattr: {
				const follow = op === ShellFsOp.StatFs || request.follow !== false;
				const node = await this.#node(requireField(request.path, "path", op), follow, false);
				if (node.kind !== "virtual") return { local: node.path };
				throw new UrlFsError("ENOTSUP", `${schemeOf(node.url)}:// resources have no ${op} data: ${node.url}`);
			}
			default:
				throw new UrlFsError("ENOSYS", `Unsupported filesystem operation: ${String(op)}`);
		}
	}

	async #readDir(input: string): Promise<ShellFsResponse> {
		const node = await this.#node(input, true, false);
		if (node.kind !== "virtual") return { local: node.path };
		if (!node.directory) throw new UrlFsError("ENOTDIR", `Not a directory: ${node.url}`);
		if (node.entries) return { entries: Array.from(node.entries, ([name, fileType]) => ({ name, fileType })) };
		if (node.sourcePath) return { local: node.sourcePath };
		const handler = this.#router.getHandler(schemeOf(node.url));
		if (handler?.readDirectory) {
			return { entries: await handler.readDirectory(parseInternalUrl(node.url), this.#context) };
		}
		throw new UrlFsError("ENOTSUP", `${node.url} lists only through the read tool`);
	}

	async #access(input: string, access: AccessRequest): Promise<ShellFsResponse> {
		const node = await this.#node(input, true, false);
		if (access.write === true) this.#writablePath(node);
		if (node.kind !== "virtual") return { local: node.path };
		if (access.execute === true && !node.directory) throw new UrlFsError("EACCES", `Not executable: ${node.url}`);
		return {};
	}

	async #open(input: string, open: OpenRequest): Promise<ShellFsResponse> {
		if (isUrlPath(input)) {
			const { spec } = this.#route(input);
			if (spec.write?.scope === "reply") return this.#openReply(input, spec, open);
		}
		const create = open.create === true || open.createNew === true;
		// O_EXCL never follows a final symlink; every other open does.
		const node = await this.#node(input, open.createNew !== true, create);
		if (open.write === true || open.append === true || open.truncate === true || create) {
			return { local: this.#writablePath(node) };
		}
		if (node.kind !== "virtual") {
			// The native handle of a read-only scheme's backing file refuses fd-level mutation too.
			return this.#writeRefusal(node) ? { local: node.path, readonly: true } : { local: node.path };
		}
		if (node.directory) throw new UrlFsError("EISDIR", `Is a directory: ${node.url}`);
		const handle = this.#nextHandle++;
		this.#handles.set(handle, node);
		return { handle };
	}

	/** Write-only sink for a reply URL; refused without a reply sink, for reads, and where the gate denies the write. */
	#openReply(url: string, spec: SchemeSpec, open: OpenRequest): ShellFsResponse {
		const scheme = schemeOf(url);
		if (open.read === true) throw new UrlFsError("EACCES", `${scheme}:// is write-only: ${url}`);
		if (!this.#onReply) {
			throw new UrlFsError("EROFS", `${scheme}:// replies reach the user only from a foreground command: ${url}`);
		}
		const refusal = this.#tierRefusal(url);
		if (refusal) throw refusal;
		const handle = this.#nextHandle++;
		this.#handles.set(handle, {
			kind: "reply",
			url,
			chunks: [],
			size: 0,
			maxBytes: spec.write?.maxBytes ?? Number.POSITIVE_INFINITY,
			overflowed: false,
		});
		return { handle };
	}

	/** Hand a closed reply handle's text to its scheme's handler, then to the run's reply sink. Blank or overflowed text is dropped. */
	async #deliverReply(sink: ReplySink): Promise<void> {
		if (sink.overflowed || this.#context.signal?.aborted) return;
		const text = Buffer.concat(sink.chunks).toString("utf8");
		if (text.trim().length === 0) return;
		await this.#router.write(sink.url, text, { cwd: this.#context.cwd, session: this.#context.session });
		this.#onReply?.(text);
	}

	/**
	 * Host path backing `input` (URL symlinks followed), for `realpath`/`readlink -f`
	 * to canonicalize natively and for external programs to receive; undefined for
	 * rendered resources and for URLs no file-backed handler serves (`https://`,
	 * MCP resources), which alias nothing. A missing entry backs onto its parent's
	 * backing path plus its name, so missing-path modes work without creating
	 * anything; one with no backed parent (an unknown skill) is the caller's error.
	 */
	async #backingPath(input: string): Promise<string | undefined> {
		if (isUrlPath(input) && this.#router.getHandler(schemeOf(input))?.spec.backing !== "file") return undefined;
		let node: FsNode;
		try {
			node = await this.#node(input, true, false);
		} catch (error) {
			if (this.#errno(error).code !== "ENOENT") throw error;
			const target = parseUrlPath(input, this.#route(input).spec);
			if (target.segments.length === 0) throw error;
			const parent = await this.#backingPath(formatUrlPath({ ...target, segments: target.segments.slice(0, -1) }));
			if (parent === undefined) throw error;
			return path.join(parent, decodeSegment(target.segments[target.segments.length - 1]));
		}
		return node.kind === "virtual" ? undefined : node.path;
	}

	/**
	 * Canonical spelling: symlinks resolved at the deepest existing prefix the
	 * `missing` mode allows, the missing tail appended. Entries stay URLs while
	 * they resolve inside their mount; a host symlink leaving it yields the host path.
	 */
	async #canonicalize(input: string, missing: ShellFsMissing, resolve: ShellFsResolve): Promise<string> {
		if (!isUrlPath(input)) return input;
		const target = parseUrlPath(input, this.#route(input).spec);
		const lexical = formatUrlPath(target);
		const allowedMissing =
			missing === ShellFsMissing.Missing ? Number.POSITIVE_INFINITY : missing === ShellFsMissing.Normal ? 1 : 0;
		if (resolve === ShellFsResolve.None) {
			if (allowedMissing === 0) await this.#node(lexical, false, false);
			else if (allowedMissing === 1 && target.segments.length > 0) {
				await this.#node(formatUrlPath({ ...target, segments: target.segments.slice(0, -1) }), true, false);
			}
			return lexical;
		}
		for (let kept = target.segments.length; kept >= 0; kept--) {
			let node: FsNode;
			try {
				node = await this.#node(
					formatUrlPath({ ...target, segments: target.segments.slice(0, kept) }),
					true,
					false,
				);
			} catch (error) {
				const absent = target.segments.length - kept + 1;
				if (kept > 0 && absent <= allowedMissing && this.#errno(error).code === "ENOENT") continue;
				throw error;
			}
			return appendSegments(await this.#canonicalUrl(node), target.segments.slice(kept));
		}
		return lexical;
	}

	async #canonicalUrl(node: FsNode): Promise<string> {
		if (node.kind === "native") return fs.realpath(node.path);
		if (node.kind === "virtual") return node.url;
		const target = parseUrlPath(node.url, node.spec);
		const real = await fs.realpath(node.path);
		const rootPath =
			target.segments.length === 0 ? node.path : await this.#locate(this.#route(node.url), target.root, false);
		if (rootPath === null) return node.url;
		const relative = path.relative(await fs.realpath(rootPath), real);
		if (relative === "") return target.root;
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return real;
		return appendSegments(target.root, relative.split(path.sep).map(encodeSegment));
	}

	/**
	 * Resolve `input` to the node it names. `follow: false` stops at a final
	 * symlink (lstat/readlink/unlink/rename); `create` addresses a write target
	 * that may not exist yet, which only mutable file-written schemes locate.
	 */
	async #node(input: string, follow: boolean, create: boolean, hops = 0): Promise<FsNode> {
		this.#throwIfAborted();
		if (!isUrlPath(input)) return { kind: "native", path: input };
		if (hops > MAX_SYMLINK_HOPS) throw new UrlFsError("ELOOP", `Too many levels of symbolic links: ${input}`);
		const route = this.#route(input);
		const { handler, spec } = route;
		const target = parseUrlPath(input, spec);
		const url = formatUrlPath(target);
		if (!handler?.locate || spec.backing !== "file") {
			if (create) throw this.#readOnly({ url, spec });
			return this.#virtualNode(route, target, url);
		}
		const writable = spec.write?.via === "file" && !spec.immutable;
		if (writable && spec.write?.scope === "sandbox") await this.#ensureSandboxRoot(route, target.scheme);

		if (!follow && target.segments.length > 0) {
			// The final entry itself, inside its (followed) parent directory.
			const parent = await this.#node(
				formatUrlPath({ ...target, segments: target.segments.slice(0, -1) }),
				true,
				false,
				hops,
			);
			if (parent.kind === "host" && (await isHostDirectory(parent.path))) {
				const segment = target.segments[target.segments.length - 1];
				return {
					kind: "host",
					url: appendSegments(parent.url, [segment]),
					spec: parent.spec,
					path: path.join(parent.path, decodeSegment(segment)),
				};
			}
		}

		let located: string | null;
		try {
			located = await this.#locate(route, url, create && writable);
		} catch (error) {
			// A symlink holding a URL looks dangling to the host; follow it through this filesystem.
			if (!(error instanceof UrlContainmentError)) throw error;
			if (this.#context.containSkillPaths && schemeOf(url) === "skill") throw error;
			const redirected = await this.#urlSymlinkTarget(route, target);
			if (redirected === undefined) throw error;
			return this.#node(redirected, follow, create, hops + 1);
		}
		if (located !== null) return { kind: "host", url, spec, path: located };
		const redirected = await this.#urlSymlinkTarget(route, target);
		if (redirected !== undefined) {
			if (this.#context.containSkillPaths && schemeOf(url) === "skill") {
				throw new UrlContainmentError(`Skill link resolves outside its filesystem root: ${url}`);
			}
			return this.#node(redirected, follow, create, hops + 1);
		}
		if (create) throw this.#readOnly({ url, spec });
		// No backing file (agent://<id>/<json-path>) or a missing entry: the handler renders it or reports why not.
		return this.#virtualNode(route, target, url);
	}

	/**
	 * The URL a path reaches through a symlink whose literal target is a URL:
	 * the first such link along `target`, with the remaining segments appended.
	 * Undefined when no prefix is such a link (host symlinks are the handler's business).
	 */
	async #urlSymlinkTarget(route: Route, target: UrlPath): Promise<string | undefined> {
		for (let index = 0; index < target.segments.length; index++) {
			let parent: string | null;
			try {
				parent = await this.#locate(
					route,
					formatUrlPath({ ...target, segments: target.segments.slice(0, index) }),
					false,
				);
			} catch {
				return undefined;
			}
			if (parent === null) return undefined;
			let link: string;
			try {
				link = await fs.readlink(path.join(parent, decodeSegment(target.segments[index])));
			} catch (error) {
				if (isFsError(error) && error.code === "EINVAL") continue;
				return undefined;
			}
			if (isUrlPath(link)) return appendSegments(link, target.segments.slice(index + 1));
		}
		return undefined;
	}

	async #virtualNode(route: Route, target: UrlPath, url: string): Promise<VirtualNode> {
		const { handler, spec } = route;
		if (handler?.enumerate) {
			const leaves = await this.#enumerated(target.scheme);
			const content = leaves.get(url);
			if (content !== undefined) {
				return { kind: "virtual", url, spec, directory: false, bytes: Buffer.from(content, "utf-8") };
			}
			const entries = childEntries(leaves.keys(), url);
			if (entries.size > 0 || url === `${target.scheme}://`) {
				return { kind: "virtual", url, spec, directory: true, bytes: new Uint8Array(), entries };
			}
		}
		let resource: InternalResource;
		try {
			resource = await this.#router.resolve(url, this.#context);
		} catch (error) {
			if (handler || this.#context.signal?.aborted) throw error;
			// Unregistered schemes only exist as MCP resources: no server offering one means no such file.
			const message = error instanceof Error ? error.message : String(error);
			throw new UrlFsError(message.startsWith("MCP resource read error") ? "EIO" : "ENOENT", message);
		}
		if (resource.isDirectory) {
			return {
				kind: "virtual",
				url,
				spec,
				directory: true,
				bytes: new Uint8Array(),
				sourcePath: resource.sourcePath,
			};
		}
		return { kind: "virtual", url, spec, directory: false, bytes: Buffer.from(resource.content, "utf-8") };
	}

	#enumerated(scheme: string): Promise<Map<string, string>> {
		let leaves = this.#leaves.get(scheme);
		if (!leaves) {
			leaves = this.#router
				.enumerate(`${scheme}://`, this.#context)
				.then(docs => new Map((docs ?? []).map(doc => [doc.url, doc.content])));
			this.#leaves.set(scheme, leaves);
		}
		return leaves;
	}

	#locate(route: Route, url: string, create: boolean): Promise<string | null> {
		const locate = route.handler?.locate;
		if (!locate) return Promise.resolve(null);
		// Nodes keep one type: a bare `skill://<name>` / `memory://root` is always its directory.
		return locate.call(route.handler, parseInternalUrl(url), this.#context, { directory: true, create });
	}

	/** The session scratch root always exists, like a mount point. */
	async #ensureSandboxRoot(route: Route, scheme: string): Promise<void> {
		if (this.#sandboxRoots.has(scheme)) return;
		const root = await this.#locate(route, `${scheme}://`, true);
		if (root !== null) await fs.mkdir(root, { recursive: true });
		this.#sandboxRoots.add(scheme);
	}

	#route(input: string): Route {
		const scheme = schemeOf(input);
		const registered = this.#router.getHandler(scheme);
		const spec = registered?.spec ?? (this.#router.canResolve(input) ? this.#router.spec("mcp") : undefined);
		if (!spec) throw new UrlFsError("ENOENT", `No handler for ${scheme}:// URLs: ${input}`);
		const readTier = spec.readTier ?? "read";
		if (TIER_RANK[readTier] > TIER_RANK[this.#tier]) {
			throw new UrlFsError(
				"EACCES",
				`${scheme}:// access needs ${readTier} approval; this command was approved at ${this.#tier}`,
			);
		}
		return { handler: registered, spec };
	}

	/** Host path a mutation may touch; throws unless the node's scheme is file-written, mutable, and within tier. */
	#writablePath(node: FsNode): string {
		if (node.kind === "virtual") throw this.#readOnly(node);
		const refusal = this.#writeRefusal(node);
		if (refusal) throw refusal;
		return node.path;
	}

	/** Why `node` must not be mutated through the shell, or undefined when it may be. */
	#writeRefusal(node: FsNode): UrlFsError | undefined {
		if (node.kind === "native") return undefined;
		if (node.kind === "virtual" || node.spec.write?.via !== "file" || node.spec.immutable)
			return this.#readOnly(node);
		return this.#tierRefusal(node.url);
	}

	/** Why the write gate refuses `url` (a denying scheme, or a tier above this command's), or undefined when it allows it. */
	#tierRefusal(url: string): UrlFsError | undefined {
		const decision = this.#router.writeTier(url, undefined, this.#context.session);
		const scheme = schemeOf(url);
		if (typeof decision !== "string" && decision.policy === "deny") {
			return new UrlFsError("EROFS", decision.reason ?? `${scheme}:// is read-only: ${url}`);
		}
		const tier = typeof decision === "string" ? decision : decision.tier;
		if (TIER_RANK[tier] > TIER_RANK[this.#tier]) {
			return new UrlFsError(
				"EACCES",
				`${scheme}:// writes need ${tier} approval; this command was approved at ${this.#tier}`,
			);
		}
		return undefined;
	}

	#readOnly(node: { url: string; spec: SchemeSpec }): UrlFsError {
		const scheme = schemeOf(node.url);
		return new UrlFsError(
			"EROFS",
			node.spec.write?.via === "handler"
				? `${scheme}:// is written through the write tool, not the shell: ${node.url}`
				: `${scheme}:// is read-only: ${node.url}`,
		);
	}

	#handle(handle: number | undefined): VirtualNode | ReplySink {
		const file = handle === undefined ? undefined : this.#handles.get(handle);
		if (!file) throw new UrlFsError("EBADF", `Bad file handle: ${handle}`);
		return file;
	}

	#throwIfAborted(): void {
		if (this.#context.signal?.aborted) throw new UrlFsError("ECANCELED", "Operation cancelled");
	}

	#errno(error: unknown): { code: string; message: string } {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof UrlFsError) return { code: error.code, message };
		if (this.#context.signal?.aborted) return { code: "ECANCELED", message };
		if (error instanceof UrlContainmentError) return { code: "EACCES", message };
		if (isFsError(error) && ERRNO_CODE_RE.test(error.code)) return { code: error.code, message };
		// Handlers report misses and refusals as plain errors; classify them by what they say.
		if (DENIED_MESSAGE_RE.test(message)) return { code: "EACCES", message };
		if (MISSING_MESSAGE_RE.test(message)) return { code: "ENOENT", message };
		if (INVALID_MESSAGE_RE.test(message)) return { code: "EINVAL", message };
		return { code: "EIO", message };
	}
}
