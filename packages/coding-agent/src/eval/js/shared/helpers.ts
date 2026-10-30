import { constants as nodeFsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { JsStatusEvent } from "./types";

/** What the host says `artifact://<id>` is, so the reader can check what it opens. */
export interface SettledArtifactAnswer {
	path: string;
	device: string;
	inode: string;
	/** The handle the host kept on this very file, for a reader that has to come back for the bytes. */
	file?: string;
	/** The hold this answer was read through, for a cell that was given none; its first read binds it. */
	root?: string;
	/** The bytes, when the host had to read them from the file it still holds open. */
	text?: string;
}

export interface HelperOptions {
	limit?: number;
	offset?: number;
}

/**
 * Inputs the helper factory needs from its host runtime. `cwd` is a getter so the runtime
 * can update it between cells (e.g. when the agent's session cwd changes) without
 * recreating helpers.
 */
export interface HelperContext {
	cwd(): string;
	env: Map<string, string>;
	/**
	 * On-disk roots for internal-URL schemes the helpers accept, keyed by scheme
	 * (see `buildEvalUrlRoots`). A path like `<scheme>://x.md` is rewritten to
	 * `<root>/x.md` before any filesystem op; unknown schemes are rejected.
	 */
	localRoots(): Record<string, string>;
	emitStatus(event: JsStatusEvent): void;
	/**
	 * Resolve `artifact://<id>` to its file through the host, once the copies
	 * filling this session's artifacts directory have finished — the waiting
	 * and the listing in one answer, because a copy can be announced between
	 * two of them.
	 *
	 * Its absence is a declaration, not a fallback: an embedder that leaves it
	 * out is saying no copy can be running here. One that has it and cannot
	 * answer fails the read rather than letting it see a directory nobody has
	 * vouched for.
	 */
	resolveArtifact?(
		id: string,
		root: string,
		token?: string,
		text?: boolean,
		file?: string,
		release?: string,
	): Promise<SettledArtifactAnswer | null>;
}

/**
 * The set of functions exposed to user code via `globalThis.__omp_helpers__`. The JS
 * prelude reads from this bag and attaches short aliases (`read`, `write`, `env`, ...)
 * onto the global scope.
 */
export interface HelperBundle {
	/** Resolves to `undefined` when `artifact://<id>` is not in this session's artifacts dir; the prelude then asks the read tool. */
	read(rawPath: string, options?: HelperOptions): Promise<string | undefined>;
	writeFile(rawPath: string, data: unknown): Promise<string>;
	env(key?: string, value?: string): string | Record<string, string> | undefined;
	/** Whether `rawPath` is an internal URL whose scheme has an injected root (served by these helpers, not delegated to the read tool). */
	hasRoot(rawPath: string): boolean;
	/**
	 * `artifact://<id><selector>` with the id already resolved to its file, so
	 * the read tool is handed a path rather than an id it would resolve
	 * against whatever directory the session reads by then. Anything else is
	 * returned unchanged.
	 */
	pinArtifact(rawPath: string): Promise<string>;
}

const utf8Encoder = new TextEncoder();

export function createHelpers(ctx: HelperContext): HelperBundle {
	return {
		read: async (rawPath, options = {}) => {
			const settled = await settledArtifactFor(ctx, rawPath);
			if (settled) {
				const id = ARTIFACT_URL_RE.exec(rawPath)?.[1] ?? "";
				let text = await readSettledArtifact(ctx, id, ctx.localRoots().artifact ?? "", settled);
				text = selectedLines(text, options);
				ctx.emitStatus({ op: "read", path: settled.path, bytes: text.length, chars: text.length });
				return text;
			}
			const resolved = await resolveRegularFile(ctx, rawPath);
			if (!resolved) return undefined;
			const { filePath, file, size } = resolved;
			let text = await file.text();
			text = selectedLines(text, options);
			ctx.emitStatus({ op: "read", path: filePath, bytes: size, chars: text.length });
			return text;
		},
		writeFile: async (rawPath, data) => {
			if (!isWriteData(data)) {
				throw new ToolError("write() expects string, Blob, ArrayBuffer, or TypedArray data");
			}
			const filePath = resolveHelperPath(ctx, rawPath, "write");
			if (typeof data === "string" || data instanceof Blob || data instanceof ArrayBuffer) {
				await Bun.write(filePath, data);
			} else {
				await Bun.write(filePath, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
			}
			ctx.emitStatus({ op: "write", path: filePath, bytes: getDataSize(data) });
			return filePath;
		},
		env: (key, value) => {
			if (!key) {
				const merged = Object.fromEntries(Object.entries(getMergedEnv(ctx)).sort(([a], [b]) => a.localeCompare(b)));
				ctx.emitStatus({ op: "env", count: Object.keys(merged).length, keys: Object.keys(merged).slice(0, 20) });
				return merged;
			}
			if (value !== undefined) {
				ctx.env.set(key, value);
				ctx.emitStatus({ op: "env", key, value, action: "set" });
				return value;
			}
			const result = ctx.env.get(key) ?? Bun.env[key];
			ctx.emitStatus({ op: "env", key, value: result, action: "get" });
			return result;
		},
		pinArtifact: async rawPath => {
			const match = INTERNAL_URL_RE.exec(rawPath);
			if (match === null || match[1].toLowerCase() !== "artifact") return rawPath;
			const selector = ARTIFACT_SELECTOR_RE.exec(match[2]);
			const root = ctx.localRoots().artifact;
			if (selector === null || !root) return rawPath;
			const resolved = await resolveArtifactPath(ctx, root, selector[1]!);
			return resolved === undefined ? rawPath : `${resolved}${selector[2]}`;
		},
		hasRoot: rawPath => {
			const match = INTERNAL_URL_RE.exec(rawPath);
			if (match === null) return false;
			const scheme = match[1].toLowerCase();
			if (!Object.hasOwn(ctx.localRoots(), scheme)) return false;
			// `artifact://<id>` reads its file here; selector forms (`artifact://3:raw:5-9`) stay with the read tool.
			return scheme !== "artifact" || ARTIFACT_ID_RE.test(match[2]);
		},
	};
}

function getMergedEnv(ctx: HelperContext): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (typeof value === "string") merged[key] = value;
	}
	for (const [key, value] of ctx.env) merged[key] = value;
	return merged;
}

const INTERNAL_URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;
const ARTIFACT_ID_RE = /^\d+$/;
/** An artifact id and whatever selector follows it (`:raw`, `:5-9`, `:raw:5-9`). */
const ARTIFACT_SELECTOR_RE = /^(\d+)(:.*)$/;

function resolvePath(ctx: HelperContext, value: string): string {
	if (path.isAbsolute(value)) return path.normalize(value);
	return path.resolve(ctx.cwd(), value);
}

/**
 * Map a raw helper path to an absolute filesystem path. Plain paths resolve
 * against the cwd; an internal-URL whose scheme has an injected root is
 * rewritten under that root; any other `scheme://` is rejected
 * so we never silently create a literal `scheme:/` directory.
 */
function resolveHelperPath(ctx: HelperContext, rawPath: string, op: "read" | "write"): string {
	const match = INTERNAL_URL_RE.exec(rawPath);
	if (!match) return resolvePath(ctx, rawPath);
	const scheme = match[1].toLowerCase();
	const root = ctx.localRoots()[scheme];
	// Artifacts are immutable, and their root is a lookup dir rather than a path prefix.
	if (!root || scheme === "artifact") {
		throw new ToolError(`Protocol paths are not supported by ${op}(): ${rawPath}`);
	}
	return resolveUnderRoot(scheme, root, match[2], rawPath);
}

/**
 * The file backing `artifact://<id>` in the artifacts dir `root` (`<id>.<tool>.log`), or `undefined` when absent.
 * Mirrors `ArtifactManager.getPath`, which lives on the host (the worker cannot import it without loading the
 * native addon), as `resolveUnderRoot` mirrors the local:// handler. A miss, including a dir still being seeded,
 * falls back to the read tool, which resolves through the manager.
 */
async function resolveArtifactPath(ctx: HelperContext, root: string, id: string): Promise<string | undefined> {
	// Asked of the host, here, where the artifact is read: a reader can be a
	// tool retained across cells or work a cell left running, and neither is
	// covered by anything decided when a cell was admitted. The host answers
	// with the file, not with a verdict this side would then act on — between
	// a verdict and a listing a copy can be announced, and the listing would
	// be of a directory half an inheritance had reached.
	if (ctx.resolveArtifact) {
		const answer = await ctx.resolveArtifact(id, root, rootToken(ctx, root), false, undefined, takeSpentAnswer(ctx));
		bindRoot(ctx, answer);
		rememberSpentAnswer(ctx, answer);
		return answer?.path;
	}
	let files: string[];
	try {
		files = await fs.readdir(root);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return undefined;
	}
	const name = files.find(file => file.startsWith(`${id}.`));
	return name === undefined ? undefined : path.join(root, name);
}

/** The 1-indexed line window `options` asks for, or the whole text. */
function selectedLines(text: string, options: HelperOptions): string {
	const offset = typeof options.offset === "number" ? options.offset : 1;
	const limit = typeof options.limit === "number" ? options.limit : undefined;
	if (offset <= 1 && limit === undefined) return text;
	const lines = text.split(/\r?\n/);
	const start = Math.max(0, offset - 1);
	const end = limit !== undefined ? start + limit : lines.length;
	return lines.slice(start, end).join("\n");
}

/**
 * What the host says `artifact://<id>` is for this cell, or `undefined` when
 * the path is not a bare artifact id or no host can be asked.
 */
async function settledArtifactFor(ctx: HelperContext, rawPath: string): Promise<SettledArtifactAnswer | undefined> {
	if (!ctx.resolveArtifact) return undefined;
	const match = INTERNAL_URL_RE.exec(rawPath);
	if (match === null || match[1].toLowerCase() !== "artifact" || !ARTIFACT_ID_RE.test(match[2])) return undefined;
	const root = ctx.localRoots().artifact;
	if (!root) return undefined;
	const answer = await ctx.resolveArtifact(
		match[2],
		root,
		rootToken(ctx, root),
		false,
		undefined,
		takeSpentAnswer(ctx),
	);
	bindRoot(ctx, answer);
	rememberSpentAnswer(ctx, answer);
	return answer ?? undefined;
}

/** A bare `artifact://<id>`, with the id. */
const ARTIFACT_URL_RE = /^artifact:\/\/(\d+)$/i;

/**
 * Remember the hold a cell's first read bound, on that cell's own roots.
 *
 * A cell started before its artifacts directory existed carries no token. Its
 * first read takes a hold, and that hold is what every read after it uses:
 * without this the next read resolves the pathname again, and a directory
 * replaced between two reads of one cell is read as the cell's own. It is
 * written on the roots object this run was given, so it binds this cell and
 * not the next one, which is assigned the directory as it is then.
 */
function bindRoot(ctx: HelperContext, answer: SettledArtifactAnswer | null | undefined): void {
	if (answer?.root) ctx.localRoots()[ARTIFACT_ROOT_TOKEN] ??= answer.root;
}

/**
 * The answer this cell has finished with, carried to the host with its next
 * question so the slot it holds goes back at consumption rather than at a
 * timeout. The last read of a cell leaves one, which its lease covers.
 */
function takeSpentAnswer(ctx: HelperContext): string | undefined {
	const roots = ctx.localRoots();
	const spent = roots[SPENT_ANSWER];
	if (spent) delete roots[SPENT_ANSWER];
	return spent;
}

function rememberSpentAnswer(ctx: HelperContext, answer: SettledArtifactAnswer | null | undefined): void {
	if (answer?.file) ctx.localRoots()[SPENT_ANSWER] = answer.file;
}

/** Where a cell keeps the answer it has consumed until its next question. */
const SPENT_ANSWER = "__artifactSpent";

/** The hold this cell reads through: the one it was given, or the one its first read bound. */
function rootToken(ctx: HelperContext, _root: string): string | undefined {
	return ctx.localRoots()[ARTIFACT_ROOT_TOKEN];
}

/** The key the cell's roots carry the host's hold on the artifacts directory under. */
const ARTIFACT_ROOT_TOKEN = "__artifactRoot";

/**
 * The text of the artifact the host answered with, read from the object the
 * host saw rather than from whatever the pathname reaches now.
 *
 * The file is opened and the opened object is checked, not checked and then
 * opened: a directory replaced between the host's answer and this read gives a
 * different file, and that is a refusal rather than another conversation's
 * artifact under this session's number.
 */
async function readSettledArtifact(
	ctx: HelperContext,
	id: string,
	root: string,
	answer: SettledArtifactAnswer,
): Promise<string> {
	if (answer.text !== undefined) return answer.text;
	// Non-blocking, because an ordinary open of a FIFO waits for a writer
	// before any check can run: a name that stopped meaning its file can have
	// become something that does not answer an open at all, and a reader that
	// hangs there never gets to refuse.
	// A name that stopped meaning its file may not open at all — it was
	// removed, or what is there now refuses this open — and that is the same
	// answer as opening something else: ask the host, which still holds the
	// file this answer was about.
	const handle = await fs
		.open(answer.path, nodeFsConstants.O_RDONLY | nodeFsConstants.O_NONBLOCK)
		.catch(() => undefined);
	if (handle) {
		try {
			const stat = await handle.stat({ bigint: true });
			if (stat.isFile() && String(stat.dev) === answer.device && String(stat.ino) === answer.inode) {
				return await handle.readFile("utf8");
			}
		} finally {
			await handle.close();
		}
	}
	// The pathname reaches something else now — its directory was replaced
	// between the answer and this read. The host still holds that directory
	// open, so it can read the file this answer is about; what it cannot do is
	// hand over a name that still means it.
	const again = await ctx.resolveArtifact?.(id, root, rootToken(ctx, root), true, answer.file);
	if (again?.text !== undefined) return again.text;
	throw new ToolError(`${answer.path} is no longer the artifact this session was told to read`);
}

/** Resolve an internal-URL relative path under its root, mirroring the host
 *  protocol handler: decode, reject absolute/traversal, confine to root. */
function resolveUnderRoot(scheme: string, root: string, rawRelative: string, rawPath: string): string {
	let relative: string;
	try {
		relative = decodeURIComponent(rawRelative.replaceAll("\\", "/"));
	} catch {
		throw new ToolError(`Invalid URL encoding in ${scheme}:// path: ${rawPath}`);
	}
	const rootPath = path.resolve(root);
	if (relative === "") return rootPath;
	if (path.isAbsolute(relative)) {
		throw new ToolError(`Absolute paths are not allowed in ${scheme}:// URLs: ${rawPath}`);
	}
	const normalized = path.normalize(relative);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new ToolError(`Path traversal (..) is not allowed in ${scheme}:// URLs: ${rawPath}`);
	}
	const resolved = path.resolve(rootPath, normalized);
	if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
		throw new ToolError(`${scheme}:// path escapes its root: ${rawPath}`);
	}
	return resolved;
}

async function resolveRegularFile(
	ctx: HelperContext,
	rawPath: string,
): Promise<{ filePath: string; file: Bun.BunFile; size: number } | undefined> {
	const match = INTERNAL_URL_RE.exec(rawPath);
	const artifactRoot = match?.[1].toLowerCase() === "artifact" ? ctx.localRoots().artifact : undefined;
	const filePath =
		artifactRoot && match && ARTIFACT_ID_RE.test(match[2])
			? await resolveArtifactPath(ctx, artifactRoot, match[2])
			: resolveHelperPath(ctx, rawPath, "read");
	if (filePath === undefined) return undefined;
	const file = Bun.file(filePath);
	const stat = await file.stat();
	if (stat.isDirectory()) {
		throw new ToolError(`Directory paths are not supported by read(): ${filePath}`);
	}
	return { filePath, file, size: stat.size };
}

function getDataSize(data: string | Blob | ArrayBuffer | ArrayBufferView): number {
	if (typeof data === "string") return utf8Encoder.encode(data).byteLength;
	if (data instanceof Blob) return data.size;
	if (data instanceof ArrayBuffer) return data.byteLength;
	return data.byteLength;
}

function isWriteData(value: unknown): value is string | Blob | ArrayBuffer | ArrayBufferView {
	return (
		typeof value === "string" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
	);
}
